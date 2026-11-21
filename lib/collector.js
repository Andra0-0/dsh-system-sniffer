/**
 * Collector: one typeperf child per counter group, merged into one snapshot.
 *
 * No native code and no npm dependency: the child is the OS's own typeperf, and
 * everything here is string handling. If a child dies the Host only loses that
 * group.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import { join } from 'node:path'
import { baseInstance, createLineSplitter, decodeLine, engineType, foldStreamLine, headerCovers, parseCounterPath, toNumber } from './csv.js'
import { resolveGroups } from './groups.js'

/**
 * `typeperf` by absolute path.
 *
 * Spawning it by bare name makes Windows search the current directory before
 * System32, so any `typeperf.exe` dropped next to the plugin would run instead
 * of the system one. This collector only ever wants the system one, so it is
 * spelled out; the bare name stays as a fallback for a machine where
 * `SystemRoot` is somehow unset.
 */
const TYPERF = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'typeperf.exe')
  : 'typeperf'

const LOGICAL_CORES = Math.max(1, os.cpus().length)

/** Read once: the model only identifies the machine, it never changes. */
const CPU_MODEL = os.cpus()[0]?.model ?? null

/**
 * Counters whose first sample has no baseline and therefore returns an
 * accumulated total instead of a rate. Gauges (bytes in use, pid, working set)
 * are valid from the very first row, which is why the warm-up row is only
 * partly discarded.
 */
const RATE_COUNTERS = new Set([
  '% Processor Time',
  'Bytes Received/sec',
  'Bytes Sent/sec',
  'Utilization Percentage',
])

export class Collector {
  #ctx
  #specs
  #children = new Map()
  #refs = new Map()
  #idleTimers = new Map()
  #disposed = false
  #idleStopMs
  #keepWarm
  #onGroup

  constructor(ctx, options = {}) {
    this.#ctx = ctx
    this.#specs = resolveGroups(options.groups)
    this.#idleStopMs = Number(options.idleStopMs) > 0 ? Number(options.idleStopMs) : 5000
    this.#keepWarm = options.keepWarm === true
    this.#onGroup = typeof options.onGroup === 'function' ? options.onGroup : null
  }

  get groups() {
    return this.#specs.map((spec) => {
      const entry = this.#children.get(spec.id)
      return {
        id: spec.id,
        intervalMs: spec.intervalMs,
        counters: spec.counters.length,
        state: entry?.state ?? 'idle',
        reason: entry?.reason ?? null,
        failures: entry?.failures ?? 0,
        rows: entry?.rowCount ?? 0,
        dropped: entry?.dropped ?? 0,
        headers: entry?.headers ?? 0,
        lastWidth: entry?.lastWidth ?? null,
        headerWidth: entry?.headerWidth ?? null,
      }
    })
  }

  /** A reader arrived for these groups: sample them while it keeps reading. */
  retainGroups(ids) {
    if (this.#disposed) return
    for (const id of ids) {
      const spec = this.#specs.find((entry) => entry.id === id)
      if (!spec) continue
      this.#refs.set(id, (this.#refs.get(id) ?? 0) + 1)
      const pending = this.#idleTimers.get(id)
      if (pending !== undefined) {
        clearTimeout(pending)
        this.#idleTimers.delete(id)
      }
      if (!this.#children.has(id)) this.#startOne(spec)
    }
  }

  /** The last reader left: retire that group after the grace period. */
  releaseGroups(ids) {
    if (this.#disposed) return
    for (const id of ids) {
      const count = Math.max(0, (this.#refs.get(id) ?? 0) - 1)
      this.#refs.set(id, count)
      if (count > 0 || this.#keepWarm) continue
      const pending = this.#idleTimers.get(id)
      if (pending !== undefined) clearTimeout(pending)
      this.#idleTimers.set(id, setTimeout(() => {
        this.#idleTimers.delete(id)
        if ((this.#refs.get(id) ?? 0) > 0 || this.#keepWarm) return
        this.#stopOne(id)
      }, this.#idleStopMs))
    }
  }

  /** Both groups at once; kept for callers that do not care about lifetimes. */
  retain() {
    this.retainGroups(this.#specs.map((spec) => spec.id))
  }

  release() {
    this.releaseGroups(this.#specs.map((spec) => spec.id))
  }

  dispose() {
    this.#disposed = true
    for (const timer of this.#idleTimers.values()) clearTimeout(timer)
    this.#idleTimers.clear()
    this.#stopAll()
  }

  #startAll() {
    for (const spec of this.#specs) this.#startOne(spec)
  }

  #stopOne(id) {
    const entry = this.#children.get(id)
    if (!entry) return
    entry.stopping = true
    clearTimeout(entry.watchdog)
    try { entry.child?.kill() } catch { /* already gone */ }
    this.#children.delete(id)
  }

  #stopAll() {
    for (const id of [...this.#children.keys()]) this.#stopOne(id)
  }

  #startOne(spec, previous) {
    const entry = {
      spec,
      child: null,
      stopping: false,
      // Retry accounting survives a restart: a child that keeps dying must not
      // restart forever just because each attempt starts a fresh record.
      failures: previous?.failures ?? 0,
      state: 'starting',
      watchdog: null,
      // Watchdog kills are our doing, not a counter problem: the group is
      // allowed to retry even if it never produced a row.
      wedged: false,
      rowCount: 0,
      startedAt: Date.now(),
      // Stream state: the header is the schema, `dropped` counts width
      // mismatches, and `headers` counts schema changes (instance churn).
      columns: null,
      headerWidth: null,
      lastWidth: null,
      dropped: 0,
      headers: 0,
      // Consecutive width mismatches without a fresh header. typeperf usually
      // re-prints its header after an instance change, but a stream that only
      // changes row width can never be resynced in place: the schema lives in
      // the header, so the only recovery is a new child.
      mismatchStreak: 0,
    }
    this.#children.set(spec.id, entry)

    let child
    try {
      child = spawn(TYPERF, [...spec.counters, '-si', String(Math.max(1, Math.round(spec.intervalMs / 1000)))], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      entry.state = 'unavailable'
      entry.reason = String(error?.message ?? error)
      return
    }
    entry.child = child

    const decoderState = { decoder: 'utf8' }
    // Raw bytes, cut on CRLF before decoding; see createLineSplitter.
    const splitter = createLineSplitter()
    let stderr = ''
    const expected = spec.counters.map((raw) => parseCounterPath(raw))

    child.stdout.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) this.#onLine(entry, line, decoderState, expected)
    })

    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      entry.state = 'unavailable'
      entry.reason = String(error?.message ?? error)
    })
    child.on('exit', (code) => {
      clearTimeout(entry.watchdog)
      if (entry.stopping || this.#disposed) return
      const killedByUs = entry.wedged === true
      const desynced = entry.reason === 'desync'
      entry.failures += 1
      // A group that never streamed a row without us killing it is normally
      // just absent on this machine (GPU counters before Win10 1709). A kill of
      // our own says nothing about the counters, so that case still retries —
      // and a desynced stream retries more times, because a new child is
      // exactly what fixes it.
      const absent = entry.rowCount === 0 && !killedByUs
      const limit = desynced ? 8 : 3
      if (absent || entry.failures > limit) {
        entry.state = 'unavailable'
        entry.reason = stderr.trim().slice(0, 200)
          || (desynced ? 'stream-desync' : `typeperf exited with ${code}`)
        return
      }
      const delay = 1000 * 2 ** Math.min(3, entry.failures - 1)
      setTimeout(() => {
        if (!this.#disposed && !entry.stopping) this.#startOne(spec, entry)
      }, delay)
    })
  }

  #armWatchdog(entry) {
    clearTimeout(entry.watchdog)
    entry.watchdog = setTimeout(() => {
      // No row for three intervals: the process is wedged, replace it.
      entry.wedged = true
      try { entry.child?.kill() } catch { /* already gone */ }
    }, entry.spec.intervalMs * 3 + 2000)
  }

  /**
   * Fold one raw line into a group. Any header (the first one or one typeperf
   * re-prints after an instance change) replaces the schema instead of being
   * read as a sample; see `foldStreamLine`.
   *
   * A header is also checked against the requested counters: a mangled decode
   * keeps the right shape but loses a path, and trusting it misaligns every
   * value that follows. When the check fails the line is re-read as GBK once,
   * and a header that still fails is refused (the group then waits for the next
   * header or for the desync restart) rather than publishing shifted numbers.
   *
   * @param entry - group state.
   * @param bytes - the line's raw bytes.
   * @param decoderState - per-child decoder latch.
   * @param expected - requested counter paths.
   */
  #onLine(entry, bytes, decoderState, expected) {
    if (bytes.length === 0) return
    let text = decodeLine(bytes, decoderState)
    let outcome = foldStreamLine(entry, text)
    if (outcome.kind === 'header' && !headerCovers(entry.columns, expected)) {
      // One retry on the other code page: a console that is neither clean UTF-8
      // nor clean GBK is rare, but this is the cheapest place to notice it.
      const retry = decoderState.decoder === 'utf8' ? 'gbk' : 'utf8'
      const alt = retry === 'gbk'
        ? new TextDecoder('gbk', { fatal: false }).decode(bytes)
        : Buffer.from(bytes).toString('utf8')
      const altColumns = foldStreamLine({ columns: null, headerWidth: null, lastWidth: null, dropped: 0, headers: 0 }, alt)
      if (altColumns.kind === 'header' && headerCovers(altColumns.columns, expected)) {
        decoderState.decoder = retry
        text = alt
        outcome = foldStreamLine(entry, text)
      } else {
        // Refuse this header: `columns` stays null so the next header (typeperf
        // re-prints one after an instance change) is what gets tried next.
        entry.columns = null
        entry.rejectedHeaders = (entry.rejectedHeaders ?? 0) + 1
        entry.reason = 'header-unverified'
        if (entry.rejectedHeaders >= 3) {
          entry.wedged = true
          try { entry.child?.kill() } catch { /* already gone */ }
        }
        return
      }
    }
    if (outcome.kind === 'header') {
      entry.state = 'streaming'
      entry.reason = undefined
      entry.mismatchStreak = 0
      entry.rejectedHeaders = 0
      this.#armWatchdog(entry)
      return
    }
    if (outcome.kind === 'ignored') return
    if (outcome.kind === 'dropped') {
      entry.mismatchStreak = (entry.mismatchStreak ?? 0) + 1
      // Three rows in a row that cannot be aligned mean the header no longer
      // describes the stream; a new child is the only way to get a new header.
      if (entry.mismatchStreak >= 3) {
        entry.wedged = true
        entry.reason = 'desync'
        try { entry.child?.kill() } catch { /* already gone */ }
      }
      return
    }
    entry.mismatchStreak = 0
    entry.rowCount += 1
    entry.failures = 0
    entry.wedged = false
    this.#armWatchdog(entry)
    // The first row carries a baseline, so rate counters in it are the
    // accumulated total rather than a rate (a network adapter's "GB/s" spike).
    // Gauges in that same row are perfectly good, so only rates are dropped.
    const warmUp = entry.rowCount === 1
    const entries = []
    for (const column of outcome.columns) {
      entries.push({
        object: column.object,
        instance: column.instance,
        counter: column.counter,
        value: warmUp && RATE_COUNTERS.has(column.counter) ? null : toNumber(outcome.cells[column.index]),
      })
    }
    const at = Date.now()
    const sample = { at: new Date(at).toISOString(), atMs: at, entries }
    // One sample in, one section out: the Store owns the window and the
    // lifetime, so the collector only has to say what it just read.
    if (this.#onGroup) this.#onGroup(entry.spec.id, sample)
    entry.state = 'streaming'
  }

}

function pick(entries, object, counter, instance) {
  for (const entry of entries) {
    if (entry.object !== object) continue
    if (entry.counter !== counter) continue
    if (instance !== undefined && entry.instance !== instance) continue
    return entry.value
  }
  return null
}

/** Above any consumer link, so a value beyond it is a counter artifact, not traffic. */
const MAX_BYTES_PER_SEC = 5 * 1024 ** 3

/** PDH percentages live in 0–100; values outside are counter artifacts and are clamped in. */
const MAX_PERCENT = 100

/** Reject negative, non-finite and physically impossible values instead of shipping them. */
function plausible(value, max = Number.POSITIVE_INFINITY) {
  if (value === null || !Number.isFinite(value) || value < 0 || value > max) return null
  return value
}

/**
 * PDH percentages: a non-finite sample is a gap, but a negative or over-full
 * one is clamped rather than dropped. Negative durations mean "no measurable
 * activity" (the counter is a delta of accumulated engine time, so a hold or
 * release between two collections lands below zero), and a sum over several
 * processes can pass 100 for one engine; clamping keeps the line continuous
 * instead of flickering the card to "—" on every artifact.
 */
function percent(value) {
  if (value === null || !Number.isFinite(value)) return null
  return Math.min(MAX_PERCENT, Math.max(0, value))
}

export function extractCpu(group) {
  const total = percent(pick(group.entries, 'Processor Information', '% Processor Time', '_Total'))
  // Both `_Total` and `0,_Total` are aggregates, not cores.
  const perCore = group.entries
    .filter((entry) => entry.object === 'Processor Information'
      && entry.counter === '% Processor Time'
      && !/_Total$/.test(entry.instance ?? ''))
    .map((entry) => percent(entry.value))
    .filter((value) => value !== null)
    .map((value) => value / 100)
  return {
    sampledAt: group.at,
    model: CPU_MODEL,
    usage: total === null ? null : total / 100,
    perCore,
    logicalCores: LOGICAL_CORES,
    accounting: 'pdh-processor-time',
  }
}

export function extractMemory(group) {
  return {
    sampledAt: group.at,
    committedBytes: plausible(pick(group.entries, 'Memory', 'Committed Bytes')),
    commitLimitBytes: plausible(pick(group.entries, 'Memory', 'Commit Limit')),
    availableBytes: plausible(pick(group.entries, 'Memory', 'Available Bytes')),
    // Physical total comes from the OS, not from PDH: the panel needs it for a
    // "used / total" percentage, and `\Memory\Available Bytes` alone cannot say
    // what the denominator is.
    totalBytes: os.totalmem(),
    accounting: 'pdh-committed',
  }
}

export function extractNetwork(group) {
  const items = []
  for (const entry of group.entries) {
    if (entry.object !== 'Network Interface') continue
    const value = plausible(entry.value, MAX_BYTES_PER_SEC)
    if (value === null) continue
    const existing = items.find((item) => item.iface === entry.instance)
    const target = existing ?? { iface: entry.instance, rxBytesPerSec: 0, txBytesPerSec: 0 }
    if (entry.counter === 'Bytes Received/sec') target.rxBytesPerSec += value
    if (entry.counter === 'Bytes Sent/sec') target.txBytesPerSec += value
    if (!existing) items.push(target)
  }
  // Addresses come from the OS rather than PDH: on Windows the PDH instance
  // name is the adapter's display name, so the two join directly. A name that
  // does not match (or a platform where it does not) simply leaves the lists
  // empty, and the panel shows no address rows.
  let addresses = {}
  try {
    addresses = os.networkInterfaces()
  } catch {
    addresses = {}
  }
  for (const item of items) {
    const list = addresses[item.iface] ?? []
    item.ipv4 = list
      .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
      .map((entry) => entry.address)
    item.ipv6 = list
      .filter((entry) => (entry.family === 'IPv6' || entry.family === 6) && !entry.internal)
      .map((entry) => entry.address)
      // Link-local is better than nothing but worse than routable, and the
      // panel shows only the first address of each family.
      .sort((a, b) => Number(/^fe80:/i.test(a)) - Number(/^fe80:/i.test(b)))
  }
  return { sampledAt: group.at, items }
}

export function extractGpu(group) {
  const perEngine = new Map()
  let dedicatedBytes = 0
  for (const entry of group.entries) {
    if (entry.counter === 'Dedicated Usage') {
      // Bytes cannot be negative; a negative sample is a counter artifact.
      if (Number.isFinite(entry.value)) dedicatedBytes += Math.max(0, entry.value)
      continue
    }
    if (entry.counter !== 'Utilization Percentage') continue
    // GPU engine samples routinely land slightly below zero (and occasionally
    // far below) when a process holds or releases an engine between two PDH
    // collections; the counter is a delta of accumulated run time, so a reset
    // shows up as a negative rate. Summing those into an engine would make the
    // headline negative, so each sample is clamped before it is added.
    const value = percent(entry.value)
    if (value === null) continue
    const type = engineType(entry.instance) ?? 'other'
    perEngine.set(type, (perEngine.get(type) ?? 0) + value)
  }
  if (perEngine.size === 0 && dedicatedBytes === 0) return null
  const engines = {}
  for (const [type, value] of perEngine) {
    // Several processes add up per engine; cap at a full engine.
    engines[type] = Math.min(1, value / MAX_PERCENT)
  }
  // Task Manager's headline is the busiest engine, not the sum across engines.
  const utilization = perEngine.size === 0 ? null : Math.max(...Object.values(engines))
  return {
    sampledAt: group.at,
    utilization,
    dedicatedBytes: Math.max(0, dedicatedBytes),
    engines,
  }
}

/**
 * Disk activity, the way Task Manager shows it: bytes per second plus "busy
 * time" (100 − idle), for `_Total` and for each physical disk. The instance
 * name of a physical disk is `0 C: D:`, which is also its display label.
 */
export function extractDiskIo(group) {
  const byDisk = new Map()
  for (const entry of group.entries) {
    if (entry.object !== 'PhysicalDisk') continue
    if (entry.counter !== 'Disk Read Bytes/sec' && entry.counter !== 'Disk Write Bytes/sec') continue
    const value = plausible(entry.value, MAX_BYTES_PER_SEC)
    if (value === null) continue
    const target = byDisk.get(entry.instance) ?? { disk: entry.instance, readBytesPerSec: 0, writeBytesPerSec: 0 }
    if (entry.counter === 'Disk Read Bytes/sec') target.readBytesPerSec += value
    else target.writeBytesPerSec += value
    byDisk.set(entry.instance, target)
  }
  const total = byDisk.get('_Total') ?? null
  const idle = pick(group.entries, 'PhysicalDisk', '% Idle Time', '_Total')
  return {
    sampledAt: group.at,
    readBytesPerSec: total ? total.readBytesPerSec : null,
    writeBytesPerSec: total ? total.writeBytesPerSec : null,
    totalBytesPerSec: total ? total.readBytesPerSec + total.writeBytesPerSec : null,
    // The counter is idle percentage; busy time is its complement.
    activeRatio: idle === null
      ? null
      : Math.min(1, Math.max(0, 1 - Math.min(100, Math.max(0, idle)) / 100)),
    items: [...byDisk.values()].filter((item) => item.disk !== '_Total'),
  }
}

export function extractProcesses(group) {
  const byInstance = new Map()
  for (const entry of group.entries) {
    if (entry.object !== 'Process') continue
    const key = entry.instance
    const record = byInstance.get(key) ?? { pid: null, cpu: null, workingSetBytes: 0 }
    if (entry.counter === 'ID Process') record.pid = entry.value
    // A null rate means "not measured yet", not "idle": keep it null so the
    // panel can show a gap instead of a false 0.0%.
    if (entry.counter === '% Processor Time') {
      record.cpu = entry.value === null ? null : entry.value / LOGICAL_CORES
    }
    if (entry.counter === 'Working Set') record.workingSetBytes = entry.value ?? 0
    byInstance.set(key, record)
  }
  const items = []
  for (const [instance, record] of byInstance) {
    if (!record.pid) continue
    items.push({
      pid: record.pid,
      name: baseInstance(instance),
      // The raw PDH instance (`chrome#2`) is what tells two same-named
      // instances apart; `name` is the group key.
      instance,
      // The counter is relative to one core; a process cannot exceed the whole machine.
      cpu: record.cpu === null ? null : Math.min(1, Math.max(0, record.cpu / 100)),
      workingSetBytes: record.workingSetBytes,
    })
  }
  // No truncation here. The panel groups by name, and a group is only complete
  // when every instance of that name is present; it does its own Top-40 over
  // merged groups. The tool trims to its own `top`.
  items.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.workingSetBytes - a.workingSetBytes)
  return { sampledAt: group.at, items }
}

export async function readVolumes() {
  const { statfs } = await import('node:fs/promises')
  const items = []
  const letters = process.platform === 'win32' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ' : ''
  if (process.platform === 'win32') {
    for (const letter of letters) {
      const mount = `${letter}:\\`
      try {
        const stat = await statfs(mount)
        const totalBytes = stat.blocks * stat.bsize
        const freeBytes = stat.bavail * stat.bsize
        items.push({ mount, totalBytes, freeBytes, usedRatio: totalBytes ? 1 - freeBytes / totalBytes : 0 })
      } catch { /* no such volume */ }
    }
  } else {
    try {
      const stat = await statfs('/')
      const totalBytes = stat.blocks * stat.bsize
      const freeBytes = stat.bavail * stat.bsize
      items.push({ mount: '/', totalBytes, freeBytes, usedRatio: totalBytes ? 1 - freeBytes / totalBytes : 0 })
    } catch { /* not available */ }
  }
  return { sampledAt: new Date().toISOString(), source: 'statfs', items }
}
