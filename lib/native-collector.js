/**
 * Host-side owner of the native collector child.
 *
 * The child does the sampling and the icon encoding; this class only starts it,
 * watches it, and keeps the newest snapshot. Everything a fault can do is
 * handled here, because the child is a separate process on purpose: a native
 * access violation kills the child, not the Host, and this manager turns that
 * into "restart, and after three tries fall back to typeperf".
 *
 * The API is deliberately small — `start`, `stop`, `current`, `requestIcons` —
 * so the section layer can adopt it without learning the protocol.
 */

import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import protocol from '../native/protocol.cjs'

const { MESSAGE, PROTOCOL_VERSION, normalizeKeys, isHello, isSnapshot, isIconReply, isPdhSample } = protocol

const DEFAULTS = {
  intervalMs: 1000,
  /** PDH rows: the performance sections want 1 Hz, the process list does not. */
  pdhIntervalMs: 1000,
  /** false → the child skips its PDH query (`typeperf` owns those groups). */
  pdh: true,
  /** true → the child enumerates the process list; `setWatch` flips it at runtime. */
  processes: true,
  startupTimeoutMs: 5000,
  /** Consecutive failures before giving up and letting typeperf take over. */
  maxRestarts: 3,
  backoffMs: [1000, 2000, 4000],
  /** A child that streamed this long is considered healthy; its failures reset. */
  healthyAfterMs: 60_000,
  iconTimeoutMs: 2000,
  iconCacheSize: 256,
  stderrBytes: 2048,
}

const CHILD = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'child.cjs')

function defaultSpawn(script, args, options) {
  return fork(script, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
    ...options,
  })
}

export class NativeCollector extends EventEmitter {
  #options
  #spawn
  /** Host → child: which loops should run. Mirrors the children's own state. */
  #watch
  #state = 'idle'
  #reason = null
  #child = null
  #snapshot = null
  #pdh = null
  #hello = null
  #startedAt = 0
  #healthySince = 0
  #restarts = 0
  #timers = new Set()
  #stopping = false
  #iconWaiters = new Map()
  #iconCache = new Map()
  #nextIconId = 1
  #stderr = ''

  constructor(options = {}) {
    super()
    this.#options = { ...DEFAULTS, ...options }
    this.#watch = { processes: this.#options.processes !== false }
    this.#spawn = typeof options.spawn === 'function'
      ? options.spawn
      : (script, args) => defaultSpawn(script, args, options.forkOptions ?? {})
  }

  get state() {
    return this.#state
  }

  get restarts() {
    return this.#restarts
  }

  get stderr() {
    return this.#stderr
  }

  /** The newest snapshot plus the state a caller needs to render a footer. */
  current() {
    return {
      items: this.#snapshot?.items ?? [],
      at: this.#snapshot?.at ?? null,
      seq: this.#snapshot?.seq ?? 0,
      diagnostics: this.#snapshot?.diagnostics ?? null,
      // PDH rows and the process list have separate cadences, so they are
      // reported separately: a PDH stall must not look like a process stall.
      pdh: this.#pdh
        ? { at: this.#pdh.at, atMs: this.#pdh.atMs, groups: this.#pdh.groups, problems: this.#pdh.problems, receivedAt: this.#pdh.receivedAt }
        : null,
      pdhStatus: this.#hello?.pdh ?? null,
      state: this.#state,
      reason: this.#reason,
      restarts: this.#restarts,
    }
  }

  start() {
    if (this.#child !== null || this.#state === 'starting' || this.#stopping) return this.#state
    this.#stopping = false
    this.#stderr = ''
    this.#startedAt = Date.now()
    this.#healthySince = 0
    this.#setState('starting')
    let child
    try {
      const args = [
        `--interval=${this.#options.intervalMs}`,
        `--pdh-interval=${this.#options.pdhIntervalMs}`,
      ]
      if (this.#options.pdh === false) args.push('--no-pdh')
      if (!this.#watch.processes) args.push('--no-processes')
      child = this.#spawn(CHILD, args)
    } catch (error) {
      this.#fail(`spawn failed: ${String(error?.message ?? error)}`)
      return this.#state
    }
    this.#child = child
    child.on('message', (message) => this.#onMessage(message))
    child.on('exit', (code, signal) => this.#onExit(code, signal))
    child.on('error', (error) => this.#onChildError(error))
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-this.#options.stderrBytes)
      })
    }
    // A child that never says hello (koffi missing, wrong Node, early crash)
    // would otherwise sit in `starting` forever.
    this.#arm(() => {
      if (this.#state === 'starting' && this.#snapshot === null) {
        this.#killChild('startup-timeout')
      }
    }, this.#options.startupTimeoutMs)
    // Sample-based heartbeat: a stalled child produces no snapshots.
    const heartbeat = setInterval(() => this.#checkHeartbeat(), Math.max(250, this.#options.intervalMs))
    this.#timers.add(heartbeat)
    return this.#state
  }

  async stop() {
    this.#stopping = true
    this.#clearTimers()
    const child = this.#child
    this.#child = null
    // `hello` describes this child instance (including PDH availability), so it
    // must not outlive it; the newest rows stay as the last known values.
    this.#hello = null
    this.#resolveIconWaiters({})
    if (!child) {
      this.#stopping = false
      this.#setState('stopped')
      return
    }
    try {
      if (child.connected !== false) child.send({ type: MESSAGE.STOP })
    } catch {
      // The child is already gone; the kill below is a no-op.
    }
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      this.#arm(finish, 500)
      child.once('exit', finish)
    })
    try {
      child.kill()
    } catch {
      // Already dead.
    }
    this.#stopping = false
    this.#setState('stopped')
  }

  /**
   * Tell the child which loops to run. The process page is the only section with
   * a finite life that shares the child with the always-on PDH groups, so without
   * this message the child would keep enumerating every second for the life of
   * the Host and the section's 30 s life would never amount to anything.
   *
   * Safe to call while stopped: the state is remembered and re-applied on the
   * next spawn (`--no-processes`) and after `hello`.
   */
  setWatch(next) {
    const processes = next?.processes !== false
    if (processes === this.#watch.processes) return
    this.#watch = { processes }
    this.#sendWatch()
  }

  #sendWatch() {
    try {
      this.#child?.send({ type: MESSAGE.WATCH, processes: this.#watch.processes })
    } catch {
      // A dead child is restarted with the same watch state as spawn arguments.
    }
  }

  /**
   * Ask the child for icons it has not encoded yet; cached keys never cross the
   * boundary twice. Resolves with whatever is available when the timeout fires —
   * a missing icon must never hold a table render.
   */
  requestIcons(keys, timeoutMs = this.#options.iconTimeoutMs) {
    const wanted = normalizeKeys(keys).filter((key) => !this.#iconCache.has(key))
    const cached = {}
    for (const key of normalizeKeys(keys)) {
      if (this.#iconCache.has(key)) cached[key] = this.#iconCache.get(key)
    }
    if (wanted.length === 0) return Promise.resolve(cached)
    if (this.#state !== 'streaming' || !this.#child) {
      return Promise.reject(new Error(`native collector is ${this.#state}`))
    }
    const id = this.#nextIconId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#iconWaiters.delete(id)
        resolve(cached)
      }, timeoutMs)
      this.#iconWaiters.set(id, { resolve, timer, cached })
      try {
        this.#child.send({ type: MESSAGE.ICONS, id, keys: wanted })
      } catch {
        clearTimeout(timer)
        this.#iconWaiters.delete(id)
        resolve(cached)
      }
    })
  }

  // ── internals ────────────────────────────────────────────────────────────

  #setState(state, reason = null) {
    if (this.#state === state && this.#reason === reason) return
    this.#state = state
    this.#reason = reason
    this.emit('state', { state, reason, restarts: this.#restarts })
  }

  #arm(callback, ms, repeat = false) {
    const timer = setTimeout(() => {
      if (!repeat) this.#timers.delete(timer)
      callback()
    }, ms)
    this.#timers.add(timer)
    return timer
  }

  #clearTimers() {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
  }

  #killChild(reason) {
    const child = this.#child
    if (!child) return
    this.#reason = reason
    try {
      child.kill()
    } catch {
      // Already gone; the exit handler still runs.
    }
  }

  #checkHeartbeat() {
    if (this.#state !== 'streaming' || this.#child === null) return
    // Whichever loop is supposed to be running is the heartbeat: with the
    // process list off, silence there is the expected state, not a stall.
    const last = this.#watch.processes
      ? (this.#snapshot?.receivedAt ?? 0)
      : (this.#pdh?.receivedAt ?? 0)
    if (!this.#watch.processes && this.#options.pdh === false) return
    if (Date.now() - last > this.#options.intervalMs * 3) {
      this.#killChild('stalled')
    }
  }

  #onMessage(message) {
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case MESSAGE.HELLO: {
        if (!isHello(message) || message.protocol !== PROTOCOL_VERSION) {
          this.#killChild('protocol-mismatch')
          return
        }
        this.#hello = message
        this.emit('hello', message)
        // Per-group PDH availability is known here, before the first sample: a
        // machine without GPU counters should not wait for a timeout to fall back.
        if (message.pdh) this.emit('pdh-status', message.pdh)
        // A child whose process list is off never sends a snapshot, so `hello`
        // is the only proof of life it gives. Without this it would sit in
        // `starting` until the startup timeout killed it.
        if (!this.#watch.processes && this.#state === 'starting') {
          this.#healthySince = Date.now()
          this.#setState('streaming')
        }
        // Re-assert the loops this Host wants; `hello` is where the child starts
        // listening for messages, so this is the first safe moment to send one.
        this.#sendWatch()
        return
      }
      case MESSAGE.PDH: {
        if (!isPdhSample(message)) {
          this.#killChild('bad-pdh')
          return
        }
        const now = Date.now()
        this.#pdh = {
          at: message.at,
          atMs: message.atMs,
          groups: message.groups,
          problems: Array.isArray(message.problems) ? message.problems : [],
          receivedAt: now,
        }
        this.emit('pdh', this.#pdh)
        return
      }
      case MESSAGE.SNAPSHOT: {
        if (!isSnapshot(message)) {
          this.#killChild('bad-snapshot')
          return
        }
        const now = Date.now()
        this.#snapshot = {
          items: message.items,
          at: message.at,
          seq: message.seq,
          diagnostics: message.diagnostics ?? null,
          receivedAt: now,
        }
        if (this.#healthySince === 0) this.#healthySince = now
        this.#setState('streaming')
        this.emit('snapshot', this.#snapshot)
        return
      }
      case MESSAGE.ICONS: {
        if (!isIconReply(message)) return
        const waiter = this.#iconWaiters.get(message.id)
        if (!waiter) return
        this.#iconWaiters.delete(message.id)
        clearTimeout(waiter.timer)
        const out = { ...waiter.cached }
        for (const [key, base64] of Object.entries(message.pngs)) {
          this.#rememberIcon(key, base64)
          out[key] = base64
        }
        waiter.resolve(out)
        return
      }
      case MESSAGE.ERROR: {
        this.emit('child-error', message)
        return
      }
      case MESSAGE.PONG:
      default:
        return
    }
  }

  #rememberIcon(key, base64) {
    this.#iconCache.set(key, base64)
    while (this.#iconCache.size > this.#options.iconCacheSize) {
      const oldest = this.#iconCache.keys().next().value
      this.#iconCache.delete(oldest)
    }
  }

  #resolveIconWaiters(partial) {
    for (const [id, waiter] of this.#iconWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ...waiter.cached, ...partial })
      this.#iconWaiters.delete(id)
    }
  }

  #onChildError(error) {
    this.#stderr = `${this.#stderr}\n${String(error?.message ?? error)}`.slice(-this.#options.stderrBytes)
    this.emit('child-error', { code: 'child-error', message: String(error?.message ?? error) })
  }

  #onExit(code, signal) {
    // An exit nobody is waiting for. `stop()` detaches the child before the
    // handshake and kills it afterwards, so the kill's exit arrives with
    // `#child === null` — and treating that as a crash is how a stopped
    // collector came back to life (armed a heartbeat nobody owned, and the
    // listener process never went quiet again).
    if (this.#child === null) return
    this.#child = null
    this.#hello = null
    this.#resolveIconWaiters({})
    if (this.#stopping) {
      this.#setState('stopped')
      return
    }
    const healthy = this.#healthySince !== 0 && Date.now() - this.#healthySince > this.#options.healthyAfterMs
    if (healthy) {
      this.#restarts = 0
      this.#healthySince = 0
    }
    this.#fail(`exit ${code ?? 'null'}${signal ? ` (${signal})` : ''}`)
  }

  #fail(reason) {
    this.#clearTimers()
    this.#restarts += 1
    if (this.#restarts > this.#options.maxRestarts) {
      this.#setState('unavailable', reason)
      this.emit('unavailable', { reason, restarts: this.#restarts })
      return
    }
    this.#setState('crashed', reason)
    const delay = this.#options.backoffMs[Math.min(this.#restarts - 1, this.#options.backoffMs.length - 1)]
    this.#arm(() => {
      if (!this.#stopping) this.start()
    }, delay)
  }
}

export { CHILD }
