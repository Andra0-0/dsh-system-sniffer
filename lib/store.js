/**
 * Store: the Host-side collection. Sections are written by the samplers at
 * their own cadence and read by whoever asks, with no work on the read path —
 * no spawn, no statfs, no sorting.
 *
 * Two things live here that the old request-driven design could not express:
 *
 * 1. A short window per section. A read returns "everything since your cursor",
 *    so a page that was away for a minute comes back to a continuous chart
 *    instead of a hole padded with nulls.
 * 2. Lifetime per section. A client attaches the sections it is showing; when
 *    the last lease on a section ends, its `lifeMs` decides how long the sampler
 *    keeps running. The lease is per client id, because two windows can be
 *    looking at different tabs.
 */

/** A section with `historyMs: 0` still gets a one-slot ring, so reads are uniform. */
const MIN_CAPACITY = 1

export class Store {
  #entries = new Map()
  #leases = new Map()
  #lifeTimers = new Map()
  #onLifeEnd = null
  #writeHandlers = new Set()
  #now

  /**
   * @param {import('./sections.js').SectionSpec[]} sections
   * @param {{ now?: () => number }} [options]
   */
  constructor(sections, options = {}) {
    this.#now = options.now ?? (() => Date.now())
    for (const spec of sections) {
      const interval = Math.max(1, Number(spec.intervalMs) || 1000)
      const capacity = spec.historyMs > 0
        ? Math.max(MIN_CAPACITY, Math.ceil(spec.historyMs / interval))
        : MIN_CAPACITY
      this.#entries.set(spec.id, {
        spec,
        capacity,
        seq: 0,
        values: [],
        /** Wall-clock time of each value, parallel to `values`. */
        times: [],
        t0: 0,
        last: null,
        at: 0,
        state: 'idle',
        reason: undefined,
      })
    }
  }

  get ids() {
    return [...this.#entries.keys()]
  }

  spec(id) {
    return this.#entries.get(id)?.spec ?? null
  }

  specs() {
    return [...this.#entries.values()].map((entry) => entry.spec)
  }

  /** Called with the section ids whose lease ended, so the caller can stop samplers. */
  setLifeEndHandler(handler) {
    this.#onLifeEnd = handler
  }

  /**
   * Called after every write, with the section id.
   *
   * This is how a consumer gets a *sample* timeline instead of owning a second
   * timer: the tracer turns each process snapshot into a point, so there is
   * never a tick without data and never a point without a sample. Returns the
   * unsubscribe, because a trace that was replaced or cleared must stop feeding.
   *
   * @param {(id: string, seq: number) => void} handler
   * @returns {() => void}
   */
  onWrite(handler) {
    if (typeof handler !== 'function') return () => {}
    this.#writeHandlers.add(handler)
    return () => {
      this.#writeHandlers.delete(handler)
    }
  }

  // ── writing ──────────────────────────────────────────────────────────────

  /**
   * Append one sample. The window keeps the section's *chart scalar*
   * (`spec.pick`), not the whole value: a chart plots numbers, and sending
   * `{ usage, perCore, model, … }` sixty times would both miss the point and
   * cost ten times the bytes. The newest value object is kept separately for
   * `values`.
   *
   * The window's `t0` is derived from the newest timestamp and the section's
   * interval, which is what lets the response stay columnar (no per-point
   * timestamps).
   *
   * @returns {number} the section's sample counter after this write.
   */
  write(id, value, at = this.#now()) {
    const entry = this.#entries.get(id)
    if (!entry) return 0
    entry.seq += 1
    entry.at = at
    entry.last = value
    const scalar = typeof entry.spec.pick === 'function' ? entry.spec.pick(value) : value
    if (entry.capacity === MIN_CAPACITY) {
      entry.values = [scalar]
      entry.times = [at]
      entry.t0 = at
    } else {
      entry.values.push(scalar)
      entry.times.push(at)
      if (entry.values.length > entry.capacity) entry.values.shift()
      if (entry.times.length > entry.capacity) entry.times.shift()
      // Derived from the points, not from the beat: a stall leaves a hole in the
      // window, and `at - (n-1) * interval` would silently squeeze it shut.
      entry.t0 = entry.times[0]
    }
    if (entry.state !== 'streaming') {
      entry.state = 'streaming'
      entry.reason = undefined
    }
    // After the entry is complete: a handler may read `current(id)` and must see
    // this sample, not the previous one. A throwing consumer cannot break the
    // sampler — one bad subscriber is not a reason to lose the section.
    for (const handler of this.#writeHandlers) {
      try {
        handler(id, entry.seq)
      } catch {
        // Ignored on purpose; the consumer's own state decides what to do.
      }
    }
    return entry.seq
  }

  /** Sampler status, surfaced in `degraded`. `starting` is not a failure. */
  setState(id, state, reason) {
    const entry = this.#entries.get(id)
    if (!entry) return
    entry.state = state
    entry.reason = reason
  }

  getState(id) {
    const entry = this.#entries.get(id)
    return entry ? { state: entry.state, reason: entry.reason, seq: entry.seq, at: entry.at } : null
  }

  /** Newest value only, no lease, no window: what the tool and a one-shot read want. */
  current(id) {
    const entry = this.#entries.get(id)
    return entry && entry.seq > 0 ? { value: entry.last, at: entry.at, seq: entry.seq } : null
  }

  currentAll(ids) {
    const wanted = Array.isArray(ids) && ids.length > 0 ? ids : this.ids
    const out = {}
    for (const id of wanted) out[id] = this.current(id)?.value ?? null
    return out
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /**
   * @param {{ include?: string[], since?: Record<string, number> }} [query]
   * @returns {{ at: string, seq: object, values: object, sections: object,
   *            unchanged: string[], truncated: string[], degraded: object[] }}
   */
  read(query = {}) {
    // An explicit empty list means "I am only here to release": answer with
    // nothing rather than everything.
    const include = Array.isArray(query.include)
      ? query.include.filter((id) => this.#entries.has(id))
      : this.ids
    const since = query.since && typeof query.since === 'object' ? query.since : {}
    const seq = {}
    const values = {}
    const sections = {}
    const unchanged = []
    const truncated = []
    const degraded = []

    for (const id of include) {
      const entry = this.#entries.get(id)
      seq[id] = entry.seq
      const cursor = Number.isFinite(since[id]) ? Number(since[id]) : null
      if (entry.seq === 0) {
        // Never sampled: say why, and do not invent a value.
        if (entry.state !== 'starting') {
          degraded.push({ id, reason: entry.reason ?? entry.state })
        }
        continue
      }
      if (cursor !== null && cursor >= entry.seq) {
        // The caller already has everything in the window; nothing to send.
        unchanged.push(id)
        continue
      }
      values[id] = entry.last
      if (entry.capacity > MIN_CAPACITY) {
        // A cursor older than the window cannot be served exactly; send the
        // whole window and let the client mark the earlier part unavailable.
        if (cursor !== null && cursor < entry.seq - entry.values.length) truncated.push(id)
        const dtx = Number(entry.spec.intervalMs) || 1000
        const times = entry.times.slice()
        // Only when the window is not evenly spaced: a thirty-number array per
        // section on every poll would buy nothing 99 % of the time, and this is
        // exactly the payload that must stay small.
        const gapped = times.some((time, index) => index > 0 && time - times[index - 1] > dtx * 1.5)
        sections[id] = {
          t0: times[0] ?? entry.t0,
          dt: dtx,
          v: entry.values.slice(),
          ...(gapped ? { times } : {}),
        }
      }
      if (entry.state === 'failed' || entry.state === 'unavailable') {
        degraded.push({ id, reason: entry.reason ?? entry.state })
      }
    }

    return {
      at: new Date(this.#now()).toISOString(),
      seq,
      values,
      sections,
      unchanged,
      truncated,
      degraded,
    }
  }

  // ── leases ───────────────────────────────────────────────────────────────

  /**
   * Register what a client is showing. Also cancels any pending retirement of
   * those sections, which is how a page that comes back inside `lifeMs` avoids
   * a cold start.
   *
   * @returns {string[]} sections now leased by somebody.
   */
  attach(clientId, ids) {
    const key = String(clientId)
    // Re-attaching replaces this client's lease: a section it stopped asking
    // for is retired exactly as if it had left.
    if (this.#leases.has(key)) this.detach(key)
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => this.#entries.has(id)))
    this.#leases.set(key, { ids: wanted, at: this.#now() })
    for (const id of wanted) this.#cancelLife(id)
    return this.leased()
  }

  /** @returns {string[]} sections still leased after this client left. */
  detach(clientId) {
    const key = String(clientId)
    const lease = this.#leases.get(key)
    if (!lease) return this.leased()
    this.#leases.delete(key)
    for (const id of lease.ids) {
      if (this.#leasedBy(id)) continue
      this.#armLife(id)
    }
    return this.leased()
  }

  /** Keep a client's lease alive; the TTL sweep otherwise retires a closed tab. */
  touch(clientId) {
    const lease = this.#leases.get(String(clientId))
    if (lease) lease.at = this.#now()
  }

  /** Drop leases that stopped talking (a closed tab cannot send `detach`). */
  sweep(ttlMs) {
    const now = this.#now()
    const stale = []
    for (const [key, lease] of this.#leases) {
      if (now - lease.at > ttlMs) stale.push(key)
    }
    for (const key of stale) this.detach(key)
    return stale.length
  }

  /** Sections somebody is currently showing. */
  leased() {
    const live = new Set()
    for (const lease of this.#leases.values()) {
      for (const id of lease.ids) live.add(id)
    }
    return [...live]
  }

  dispose() {
    for (const timer of this.#lifeTimers.values()) clearTimeout(timer)
    this.#lifeTimers.clear()
    this.#leases.clear()
  }

  #leasedBy(id) {
    for (const lease of this.#leases.values()) {
      if (lease.ids.has(id)) return true
    }
    return false
  }

  #cancelLife(id) {
    const timer = this.#lifeTimers.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#lifeTimers.delete(id)
  }

  #armLife(id) {
    const entry = this.#entries.get(id)
    if (!entry) return
    const life = Number(entry.spec.lifeMs)
    // Infinity means "once woken, stays up": the performance sections are the
    // reason this plugin has a steady 1 Hz cost at all, and they are cheap.
    if (life === Number.POSITIVE_INFINITY) return
    if (!Number.isFinite(life) || life <= 0) {
      this.#endLife([id])
      return
    }
    this.#cancelLife(id)
    this.#lifeTimers.set(id, setTimeout(() => {
      this.#lifeTimers.delete(id)
      if (this.#leasedBy(id)) return
      this.#endLife([id])
    }, life))
  }

  #endLife(ids) {
    for (const id of ids) this.setState(id, 'idle')
    this.#onLifeEnd?.(ids)
  }
}
