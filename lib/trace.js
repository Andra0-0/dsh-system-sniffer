/**
 * TraceStore — one app group (or one process) on a slow clock.
 *
 * The panel's normal read is a 60 s window per machine-wide section. A trace is
 * the opposite shape: one target, hours, and six numbers per second. It is kept
 * out of `Store` on purpose — `Store` is keyed by section and a section has one
 * value per tick, while a trace has a target, members that come and go, and a
 * lifecycle nobody's lease owns.
 *
 * One ring, three modes. The ring is always the same 8 h / 1 s column store; a
 * mode only decides *who keeps it alive and what happens when the last viewer
 * leaves*:
 *
 * - `preview`   — entered by picking a target. Samples 1 Hz while somebody
 *                 watches; the caller drops it after a few seconds of silence.
 * - `recording` — started by the user. Samples until the user stops it, whether
 *                 or not a page is open.
 * - `stopped`   — frozen ring, kept for reading. No sampler, no lease.
 * - `null`      — nothing: no target, no ring.
 *
 * Two things make this cheap enough to run for a workday:
 *
 * 1. The native child already enumerates every process at 1 Hz. A tick reads the
 *    latest snapshot and filters it — no extra syscall, no extra child. The only
 *    cost of keeping it alive while the panel is closed is that enumeration
 *    (1–3 ms/s), which is why the caller holds a `processes` lease for the
 *    lifetime of the trace.
 * 2. The ring is columnar (`Float64Array`-sized arrays of numbers, not objects):
 *    8 h at 1 Hz × 6 series is ~1.4 MB. Members keep running stats, not series,
 *    so an `svchost` group with 88 members does not multiply that by 88.
 *
 * Time is kept honest by storing the real timestamp of every point (`times`,
 * parallel to the series) and by never inventing one: a second without a sample
 * is a missing point, not a copy of the previous value and not a zero. The
 * chart maps x through `times`, so a gap reads as a gap in the right place
 * instead of compressing everything after it (`PITFALLS.md` §27 / §28).
 *
 * Downsampling only ever happens on the read path, and only when it is the only
 * way to fit: `read` answers the newest slice a chart can draw, `range` answers
 * a chosen window with the samples themselves while they fit (real `times`, so
 * a dense ring is never chopped by the read path) and buckets it min/max only
 * past that. The ring itself is never resampled.
 */

/** Columnar series a trace keeps. `cpu` is a 0–1 fraction (like `items[].cpu`). */
const SERIES = ['cpu', 'memory', 'handleCount', 'threadCount', 'ioReadPerSec', 'ioWritePerSec']

/** The four a chart draws; `range` carries only these, to keep the payload small. */
const CHART_SERIES = ['cpu', 'memory', 'ioReadPerSec', 'ioWritePerSec']

/** Cap on points in one read; a chart cannot use more and the payload would be MBs. */
const MAX_POINTS = 1200

/**
 * A trace that has received nothing for this long is stopped, not frozen.
 *
 * "Nothing arrives" is not a gap to be drawn around: the header keeps counting
 * while the ring stands still, which reads as a broken panel rather than as a
 * dead collector. Thirty seconds is longer than any single missed beat and
 * shorter than a user's patience.
 */
const STALL_MS = 30_000

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** First index whose time is >= `value`; `times.length` when there is none. */
function lowerBound(times, value) {
  let low = 0
  let high = times.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (times[mid] < value) low = mid + 1
    else high = mid
  }
  return low
}

/** First index whose time is > `value`. */
function upperBound(times, value) {
  let low = 0
  let high = times.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (times[mid] <= value) low = mid + 1
    else high = mid
  }
  return low
}

function normalizeTarget(input) {
  return {
    appId: typeof input?.appId === 'string' ? input.appId : '',
    pid: Number.isInteger(input?.pid) ? input.pid : null,
    kind: input?.kind === 'process' ? 'process' : 'group',
    label: typeof input?.label === 'string' ? input.label.slice(0, 120) : '',
  }
}

function sameTarget(left, right) {
  if (!left || !right) return false
  return left.kind === right.kind && left.appId === right.appId && left.pid === right.pid
}

function emptySeries() {
  return Object.fromEntries(SERIES.map((key) => [key, []]))
}

export class TraceStore {
  /** The lease keepalive; declared so `#reset` can clear it before `start`. */
  #timer = null
  /** Detaches from the section's writes when the trace is replaced or disposed. */
  #unsubscribe = null

  /**
   * @param {{
   *   store?: import('./store.js').Store,
   *   intervalMs?: number,
   *   windowMs?: number,
   *   liveLimit?: number,
   *   exitedLimit?: number,
   *   exitedKeep?: number,
   *   now?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.store = options.store ?? null
    this.intervalMs = Math.max(250, Number(options.intervalMs) || 1000)
    this.windowMs = Math.max(this.intervalMs, Number(options.windowMs) || 8 * 3600_000)
    this.capacity = Math.max(2, Math.ceil(this.windowMs / this.intervalMs))
    /**
     * How many *live* members one answer carries. Live members get this budget
     * to themselves (see `#membersView`), so it is deliberately wider than the
     * old 32: a Chrome-shaped group is ~60 processes, and a process you can
     * still look at must not be pushed into the "N more" row by one that is
     * already gone.
     */
    this.liveLimit = Math.max(1, Number(options.liveLimit ?? options.memberLimit) || 128)
    /** How many frozen rows are sent along; the page shows at most this many. */
    this.exitedLimit = Math.max(0, Number(options.exitedLimit) || 20)
    /** How many frozen rows are *kept*; older ones are dropped (see `#pruneExited`). */
    this.exitedKeep = Math.max(this.exitedLimit, Number(options.exitedKeep) || 200)
    this.leaseId = typeof options.leaseId === 'string' ? options.leaseId : 'trace'
    this.now = options.now ?? (() => Date.now())
    // A point is a real sample, so the section's writes are the clock. Owning a
    // second 1 Hz timer here is what forced the old code to paper over the seam
    // between two clocks by copying the previous point (`PITFALLS.md` §28).
    this.#unsubscribe = typeof this.store?.onWrite === 'function'
      ? this.store.onWrite((id) => {
        if (id === 'processes') this.tick()
      })
      : null
    this.#reset()
  }

  /** The sampler runs: preview and recording. `stopped` is a frozen ring. */
  get sampling() {
    return this.mode === 'preview' || this.mode === 'recording'
  }

  get recording() {
    return this.mode === 'recording'
  }

  /** When the last viewer asked for data; `sweepPreview` measures the silence. */
  get viewerIdleMs() {
    return this.viewerAt === 0 ? Number.POSITIVE_INFINITY : this.now() - this.viewerAt
  }

  /** Drop the ring (points, members, I/O baselines) and leave the state alone. */
  #resetRing() {
    this.#clearTimer()
    this.startedAt = 0
    /** When the user pressed record; 0 while only previewing. */
    this.recordedAt = 0
    this.endedAt = 0
    this.endedReason = null
    this.viewerAt = 0
    this.seq = 0
    this.lastAt = 0
    this.lastSampleAt = 0
    this.lastPoint = null
    this.series = emptySeries()
    /** Wall-clock time of each point, parallel to `series`. See `#coverage()`. */
    this.times = []
    this.members = new Map()
    /** pid → { read, write, at } for the I/O counter differences. */
    this.prevIo = new Map()
    this.#timer = null
  }

  #reset() {
    this.#resetRing()
    this.mode = null
    this.target = null
  }

  #clearTimer() {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Housekeeping beat: keep the section's lease alive and notice a dead sampler.
   *
   * It does not produce points — those come from the section's writes (see the
   * constructor). What it is needed for is keeping the section leased while a
   * recording runs and the panel is closed (the Host sweeps a lease that stops
   * talking, and a swept lease retires the section this trace feeds on), and
   * for stopping the trace once the sampler has clearly died.
   */
  #arm() {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      if (!this.sampling) return
      this.store?.touch?.(this.leaseId)
      this.sweepStall()
    }, 1000)
    // A trace must not be the reason the Host process cannot exit.
    if (typeof this.#timer?.unref === 'function') this.#timer.unref()
  }

  /**
   * Stop a trace that has stopped receiving samples. Public so a test can call
   * it with a hand-driven clock instead of waiting 30 s.
   *
   * @returns {boolean} whether it stopped something.
   */
  sweepStall(now = this.now()) {
    if (!this.sampling) return false
    const anchor = this.lastAt || this.recordedAt || this.startedAt
    if (!anchor || now - anchor <= STALL_MS) return false
    this.stop('stalled')
    // Letting the lease go is what retires the section 30 s later; the section
    // cannot recover a sampler that is not answering anyway.
    this.store?.detach?.(this.leaseId)
    return true
  }

  /**
   * Preview a target: sample immediately, keep nothing after the last viewer
   * leaves. A recording outranks a preview — picking another group in a second
   * window must not silently kill the recording happening in the first.
   */
  preview(input) {
    if (this.mode === 'recording') return this.status()
    const target = normalizeTarget(input)
    if (this.mode === 'preview' && sameTarget(this.target, target)) {
      this.viewerAt = this.now()
      return this.status()
    }
    // A preview of a different target, or a preview after a frozen recording:
    // the old ring has nothing to do with the new target.
    this.#reset()
    this.mode = 'preview'
    this.target = target
    this.startedAt = this.now()
    this.viewerAt = this.startedAt
    this.#arm()
    return this.status()
  }

  /**
   * Start recording. A preview of the same target continues its ring in place,
   * so the curve has no seam at the moment the user pressed record; anything
   * else (a different target, or a frozen recording) starts a clean ring —
   * otherwise two unrelated stretches would share one duration.
   */
  start(input) {
    const target = normalizeTarget(input)
    if (this.mode === 'recording' && sameTarget(this.target, target)) return this.status()
    const keepRing = this.mode === 'preview' && sameTarget(this.target, target)
    if (!keepRing) {
      this.#reset()
      this.target = target
      this.startedAt = this.now()
    }
    this.mode = 'recording'
    this.recordedAt = this.now()
    this.endedAt = 0
    this.endedReason = null
    this.viewerAt = this.recordedAt
    this.#arm()
    return this.status()
  }

  /** Stop sampling and keep the ring: the page still has something to show. */
  stop(reason = 'user') {
    if (!this.sampling) return this.status()
    this.#clearTimer()
    this.mode = 'stopped'
    this.endedAt = this.now()
    this.endedReason = String(reason)
    return this.status()
  }

  /** Drop the ring and the target. A recording has to be stopped first. */
  clear() {
    if (this.mode === 'recording') return this.status()
    this.#reset()
    return this.status()
  }

  /** Every read path calls this: a viewer asking for data is a viewer present. */
  touchViewer() {
    if (this.target !== null) this.viewerAt = this.now()
    return this.viewerAt
  }

  /**
   * A preview nobody looks at is garbage. Returns true when it was dropped, so
   * the caller can release the `processes` lease in the same breath.
   *
   * The target survives: the page remembers what it was showing, so coming back
   * to the tab re-opens the same preview instead of making the user find the
   * group again. That is also why the ring is dropped rather than frozen — a
   * peek must never look like a recording.
   */
  sweepPreview(ttlMs) {
    if (this.mode !== 'preview') return false
    if (this.viewerIdleMs <= ttlMs) return false
    const target = this.target
    this.#resetRing()
    this.mode = null
    this.target = target
    return true
  }

  /** One 1 Hz point. Public so a test can drive it without timers. */
  tick(now = this.now()) {
    if (!this.sampling) return null
    // The Host sweeps leases that stopped talking; a trace is not a page, so it
    // has to keep its own `processes` lease alive for as long as it records.
    this.store?.touch?.(this.leaseId)
    const snapshot = this.store?.current?.('processes') ?? null
    const sampledAt = Number.isFinite(snapshot?.at) ? snapshot.at : 0
    // A point is a sample, so there is nothing to push when the sample is not
    // new. The old code pushed a copy of the last point here — which put last
    // second's numbers on this second's timeline. Missing data is missing: a
    // gap in `times` is what the chart draws, and it is what happened.
    const fresh = sampledAt > this.lastSampleAt
      && now - sampledAt <= this.intervalMs * 5
    if (!fresh) return null
    this.lastSampleAt = sampledAt
    const all = Array.isArray(snapshot?.value?.items) ? snapshot.value.items : []
    const items = this.target.kind === 'process'
      ? all.filter((item) => item.pid === this.target.pid)
      : all.filter((item) => item.appId === this.target.appId)

    const seen = new Set()
    let cpu = 0
    let cpuSeen = false
    let memory = 0
    let memorySeen = false
    let handles = 0
    let threads = 0
    let ioRead = 0
    let ioWrite = 0

    for (const item of items) {
      const pid = item.pid
      if (!seen.has(pid)) {
        seen.add(pid)
        let member = this.members.get(pid)
        // A pid that comes back after its row was frozen is a new instance; a
        // pid reused by an unrelated process is indistinguishable without
        // `createTime`, which the item list deliberately does not carry.
        if (!member || member.exitedAt !== 0) member = this.#member(pid, item, now)
        this.#update(member, item, sampledAt, now)
        if (member.current.cpu !== null) {
          cpu += member.current.cpu
          cpuSeen = true
        }
        if (member.current.memory !== null) {
          memory += member.current.memory
          memorySeen = true
        }
        handles += member.current.handleCount ?? 0
        threads += member.current.threadCount ?? 0
        ioRead += member.current.ioReadPerSec ?? 0
        ioWrite += member.current.ioWritePerSec ?? 0
      }
    }

    for (const [pid, member] of this.members) {
      if (!seen.has(pid) && member.exitedAt === 0) member.exitedAt = now
    }
    this.#pruneExited()

    // The point is stamped with the sample's own time, not with the moment this
    // handler ran: a write that arrives late (the Host was busy) must not move
    // the sample on the axis.
    this.#push({
      cpu: cpuSeen ? cpu : null,
      memory: memorySeen ? memory : null,
      handleCount: items.length > 0 ? handles : null,
      threadCount: items.length > 0 ? threads : null,
      ioReadPerSec: items.length > 0 ? ioRead : null,
      ioWritePerSec: items.length > 0 ? ioWrite : null,
    }, sampledAt || now)

    // A trace ends only when the user stops it (or replaces it). A target that
    // disappears is not an end condition: the members freeze, the aggregate goes
    // null, and the user decides whether the recording is still worth keeping.
    return this.lastPoint
  }

  /**
   * Feed a snapshot instead of reading the Store — the test path, and the shape
   * is exactly what `store.current('processes')` returns: `{ at, value }`.
   */
  tickWith(snapshot, at = this.now()) {
    const saved = this.store
    this.store = { current: () => snapshot }
    try {
      return this.tick(at)
    } finally {
      this.store = saved
    }
  }

  #member(pid, item, now) {
    const member = {
      pid,
      name: typeof item.displayName === 'string' && item.displayName.length > 0
        ? item.displayName
        : String(item.name ?? `pid-${pid}`),
      image: String(item.name ?? ''),
      firstAt: now,
      lastAt: now,
      exitedAt: 0,
      current: {
        cpu: null, memory: null, handleCount: null,
        threadCount: null, ioReadPerSec: null, ioWritePerSec: null,
      },
      sum: { cpu: 0, cpuCount: 0, memory: 0, memoryCount: 0 },
      peak: { cpu: null, memory: null, handleCount: null, threadCount: null },
    }
    this.members.set(pid, member)
    return member
  }

  #update(member, item, sampledAt, now) {
    const io = this.#ioRate(item, sampledAt)
    const current = {
      cpu: numberOrNull(item.cpu),
      // The leak metric is private commit; the working set is the fallback for a
      // child that predates protocol 3.
      memory: numberOrNull(item.privateBytes) ?? numberOrNull(item.workingSetBytes),
      handleCount: numberOrNull(item.handleCount),
      threadCount: numberOrNull(item.threadCount),
      ioReadPerSec: io.read,
      ioWritePerSec: io.write,
    }
    member.current = current
    member.lastAt = now
    if (current.cpu !== null) {
      member.sum.cpu += current.cpu
      member.sum.cpuCount += 1
      member.peak.cpu = member.peak.cpu === null ? current.cpu : Math.max(member.peak.cpu, current.cpu)
    }
    if (current.memory !== null) {
      member.sum.memory += current.memory
      member.sum.memoryCount += 1
      member.peak.memory = member.peak.memory === null ? current.memory : Math.max(member.peak.memory, current.memory)
    }
    if (current.handleCount !== null) {
      member.peak.handleCount = member.peak.handleCount === null
        ? current.handleCount
        : Math.max(member.peak.handleCount, current.handleCount)
    }
    if (current.threadCount !== null) {
      member.peak.threadCount = member.peak.threadCount === null
        ? current.threadCount
        : Math.max(member.peak.threadCount, current.threadCount)
    }
  }

  /** Bytes/sec from the cumulative counters; 0 on the first snapshot of a pid. */
  #ioRate(item, sampledAt) {
    const read = numberOrNull(item.ioReadBytes)
    const write = numberOrNull(item.ioWriteBytes)
    const rate = { read: 0, write: 0 }
    if (read === null || write === null) return rate
    const before = this.prevIo.get(item.pid)
    if (before) {
      const elapsed = sampledAt - before.at
      if (elapsed > 0) {
        const deltaRead = read - before.read
        const deltaWrite = write - before.write
        // A counter that went backwards is a new process on a reused pid, not an
        // enormous negative rate.
        if (deltaRead >= 0) rate.read = (deltaRead / elapsed) * 1000
        if (deltaWrite >= 0) rate.write = (deltaWrite / elapsed) * 1000
      }
    }
    this.prevIo.set(item.pid, { read, write, at: sampledAt })
    return rate
  }

  #push(point, now) {
    this.seq += 1
    this.lastAt = now
    this.lastPoint = point
    this.times.push(now)
    for (const key of SERIES) {
      const series = this.series[key]
      series.push(point[key])
      if (series.length > this.capacity) series.shift()
    }
    while (this.times.length > this.capacity) this.times.shift()
  }

  /**
   * Where the ring actually starts and ends, in real time. Derived from the
   * points themselves: `lastAt - (count - 1) × interval` assumed a spacing the
   * sampler never promised, and one skipped sample bent every earlier label.
   */
  #coverage() {
    const count = this.times.length
    if (count === 0) return { from: 0, to: 0 }
    return { from: this.times[0], to: this.times[count - 1] }
  }

  /**
   * The time the header counts from: a recording counts from the moment the user
   * pressed record, a preview from the moment it was opened, a stopped trace
   * from the same anchor frozen at `endedAt`.
   */
  #elapsedMs() {
    if (this.mode === null) return 0
    if (this.mode === 'preview') return Math.max(0, this.now() - this.startedAt)
    const anchor = this.recordedAt || this.startedAt
    if (anchor === 0) return 0
    const end = this.endedAt === 0 ? this.now() : this.endedAt
    return Math.max(0, end - anchor)
  }

  status() {
    const coverage = this.#coverage()
    return {
      mode: this.mode,
      target: this.target,
      recording: this.recording,
      startedAt: this.startedAt,
      recordedAt: this.recordedAt,
      endedAt: this.endedAt,
      endedReason: this.endedReason,
      elapsedMs: this.#elapsedMs(),
      seq: this.seq,
      points: this.series.cpu.length,
      memberCount: this.members.size,
      aggregate: this.lastPoint,
      windowMs: this.windowMs,
      coverage,
    }
  }

  /**
   * The live tail: everything after `since`, capped at what a chart can draw.
   *
   * A cursor past the ring is what a client holds after a clear or a replaced
   * trace (the sequence restarted at 1), so it reads cold instead of answering
   * nothing. A cursor behind the ring gets the newest `MAX_POINTS`; the client's
   * sequence check then replaces its buffer rather than appending a gap.
   */
  read(since) {
    const status = this.status()
    const total = this.seq
    const length = this.times.length
    if (length === 0) {
      return {
        ...status,
        t0: 0, dt: this.intervalMs, times: [],
        series: emptySeries(),
        members: this.#membersView(),
      }
    }
    const ringStart = total - length + 1
    let cursor = Number.isFinite(since) ? Math.floor(since) : 0
    if (cursor < 0 || cursor > total) cursor = 0
    let begin = Math.max(ringStart, cursor + 1)
    if (total - begin + 1 > MAX_POINTS) begin = total - MAX_POINTS + 1
    const count = total - begin + 1
    const firstIndex = begin - ringStart
    const series = {}
    for (const key of SERIES) {
      series[key] = this.series[key].slice(firstIndex, firstIndex + count)
    }
    const times = this.times.slice(firstIndex, firstIndex + count)
    return {
      ...status,
      // `t0` / `dt` remain for a client that only knows the uniform grid; `times`
      // is the truth (points are as far apart as the samples really were).
      t0: times[0] ?? 0,
      dt: this.intervalMs,
      times,
      series,
      members: this.#membersView(),
    }
  }

  /**
   * Read for a zoomed or panned chart.
   *
   * Two shapes, decided by one question: does this window hold fewer samples
   * than a chart can draw?
   *
   * - Yes (any window up to `MAX_POINTS` seconds, i.e. 20 minutes at 1 Hz) →
   *   the samples themselves, with their real `times`, exactly like `read`.
   *   *Not* a 1 s bucket grid: that grid is anchored to the window, while the
   *   sample clock is anchored to the child's beat, so a dense ring drifted by
   *   a few ms per sample lands two samples in one bucket and leaves the next
   *   empty. The empty bucket is a null slot, the null breaks the pen, and a
   *   perfectly dense recording is drawn as five segments with 2 s holes —
   *   which is what "the curve is chopped wherever I pan" was.
   * - No (a window wider than that) → buckets, min and max per bucket in time
   *   order, so a spike survives and the payload stays ~1200 points. Empty
   *   buckets keep their slots as nulls: the chart maps time to x uniformly,
   *   so skipping them would shift everything after the hole. The bucket is
   *   forced to at least two sampling intervals, which is what makes an empty
   *   bucket mean "no sample was taken here" instead of "the grid and the
   *   clock disagreed by a millisecond": with a bucket wider than any real
   *   sample spacing, the bucket index of consecutive samples can only move
   *   forward by zero or one, so it can never skip one.
   *
   * @param {{from?: number, to?: number, spanMs?: number, buckets?: number}} [query]
   */
  range(query = {}) {
    const status = this.status()
    const coverage = status.coverage
    const buckets = Math.max(2, Math.min(MAX_POINTS, Math.floor(Number(query?.buckets) || MAX_POINTS / 2)))
    const length = this.times.length
    if (length === 0) {
      return {
        ...status,
        from: 0, to: 0, bucketMs: this.intervalMs, t0: 0, dt: this.intervalMs,
        series: Object.fromEntries(CHART_SERIES.map((key) => [key, []])),
        members: this.#membersView(),
      }
    }
    // With no window the caller follows the tail: the newest `spanMs`.
    const span = Number.isFinite(query?.spanMs) && query.spanMs > 0 ? query.spanMs : 0
    let to = Number.isFinite(query?.to) ? query.to : coverage.to
    let from = Number.isFinite(query?.from) ? query.from : to - (span || this.windowMs)
    if (!(to > from)) {
      from = coverage.from
      to = coverage.to
    }
    // Index range comes from the real timestamps: a gap in the samples shifts
    // every index after it, and `(from - ringFrom) / interval` assumed there
    // was never a gap.
    const windowStart = Math.max(0, lowerBound(this.times, from))
    const windowEnd = Math.min(length, upperBound(this.times, to))
    // The whole window fits in one answer: send it as it was sampled. Below
    // `MAX_POINTS` the grid would be one slot per sample anyway, which is the
    // one case where it lies.
    if (windowEnd > windowStart && (to - from) / this.intervalMs + 1 <= MAX_POINTS) {
      const first = Math.max(windowStart, windowEnd - MAX_POINTS)
      const series = {}
      for (const key of CHART_SERIES) series[key] = this.series[key].slice(first, windowEnd)
      const times = this.times.slice(first, windowEnd)
      return {
        ...status,
        from,
        to,
        bucketMs: this.intervalMs,
        // `times` is the time base; `t0` / `dt` stay for a client that only
        // knows the uniform grid (and for the one point out of a thousand that
        // is not finite).
        t0: times[0],
        dt: this.intervalMs,
        times,
        series,
        members: this.#membersView(),
      }
    }
    const bucketMs = Math.max(
      // Twice the interval, for the reason in the header: a bucket as wide as
      // one sample can be skipped by a clock that drifts (`PITFALLS.md` §32).
      this.intervalMs * 2,
      Math.ceil((to - from) / buckets / this.intervalMs) * this.intervalMs,
    )
    // With the floor above this is always 2; it stays computed so a caller that
    // ever asks for a grid at the sampling interval gets the single-slot shape
    // instead of a silently duplicated one.
    const stride = bucketMs <= this.intervalMs ? 1 : 2
    const dt = bucketMs / stride
    // `buckets` is an upper bound: a short window at 2 s buckets needs fewer
    // slots than asked for, and padding them would draw past the window.
    const count = Math.max(1, Math.min(buckets, Math.ceil((to - from) / bucketMs)))
    const first = windowStart
    const last = Math.min(length - 1, windowEnd - 1)
    const series = {}
    for (const key of CHART_SERIES) {
      const values = this.series[key]
      const slots = new Array(count * stride).fill(null)
      if (last >= first) {
        const lows = new Array(count).fill(null)
        const highs = new Array(count).fill(null)
        const lowAt = new Array(count).fill(-1)
        const highAt = new Array(count).fill(-1)
        for (let index = first; index <= last; index += 1) {
          const value = values[index]
          if (!Number.isFinite(value)) continue
          const at = this.times[index]
          const bucket = Math.min(count - 1, Math.max(0, Math.floor((at - from) / bucketMs)))
          if (lows[bucket] === null || value < lows[bucket]) {
            lows[bucket] = value
            lowAt[bucket] = index
          }
          if (highs[bucket] === null || value > highs[bucket]) {
            highs[bucket] = value
            highAt[bucket] = index
          }
        }
        for (let bucket = 0; bucket < count; bucket += 1) {
          if (lows[bucket] === null) continue
          if (stride === 1) {
            slots[bucket] = highs[bucket]
            continue
          }
          // Emit the two extremes in the order they happened, so a burst reads
          // as a spike rather than as a min-then-max staircase.
          const lowFirst = lowAt[bucket] <= highAt[bucket]
          slots[bucket * 2] = lowFirst ? lows[bucket] : highs[bucket]
          slots[bucket * 2 + 1] = lowFirst ? highs[bucket] : lows[bucket]
        }
      }
      series[key] = slots
    }
    return {
      ...status,
      from,
      to,
      bucketMs,
      t0: from,
      dt,
      series,
      members: this.#membersView(),
    }
  }

  /**
   * Bound the frozen rows.
   *
   * A recording of an app that spawns a helper per action collects a pid every
   * few seconds: over an eight-hour trace the map grows without limit, every
   * read sorts the whole thing, and the "who left recently" question is buried
   * under a day of ghosts. The newest `exitedKeep` are plenty to answer it.
   */
  #pruneExited() {
    const size = this.members.size
    if (size <= this.liveLimit + this.exitedKeep) return
    const frozen = []
    for (const member of this.members.values()) {
      if (member.exitedAt > 0) frozen.push(member)
    }
    if (frozen.length <= this.exitedKeep) return
    frozen.sort((a, b) => a.exitedAt - b.exitedAt)
    for (let index = 0; index < frozen.length - this.exitedKeep; index += 1) {
      this.members.delete(frozen[index].pid)
    }
  }

  /**
   * The member list as the page sees it.
   *
   * Live members come first and get the whole `liveLimit` to themselves. That
   * split is the fix for a real report: after hours of recording, an app that
   * keeps spawning and killing helpers has dozens of frozen rows, they keep
   * their last memory (so they sort high), and one shared 32-slot list filled up
   * with them — the live processes fell into `others`, where the page could only
   * draw a dead "N more processes" row. A process you can still look at must
   * never be crowded out by one that is already gone.
   *
   * The frozen rows follow, newest exit first and capped small: they are a
   * debugging aid ("who was here a minute ago"), not a roster. Both counts are
   * reported so the page can say "7 members · 32 exited" instead of inventing a
   * number that grows for eight hours.
   */
  #membersView() {
    const live = []
    const exited = []
    for (const member of this.members.values()) {
      if (member.exitedAt > 0) exited.push(member)
      else live.push(member)
    }
    // Biggest first: the list answers "who is using this group", and the process
    // page sorts by memory for the same reason.
    live.sort((a, b) => (b.current.memory ?? -1) - (a.current.memory ?? -1) || a.pid - b.pid)
    exited.sort((a, b) => b.exitedAt - a.exitedAt || a.pid - b.pid)
    const shownLive = live.slice(0, this.liveLimit)
    const rest = live.slice(this.liveLimit)
    const shownExited = exited.slice(0, this.exitedLimit)
    let othersMemory = 0
    let othersCpu = 0
    for (const member of rest) {
      othersMemory += member.current.memory ?? 0
      othersCpu += member.current.cpu ?? 0
    }
    const view = (member) => ({
      pid: member.pid,
      name: member.name,
      image: member.image,
      firstAt: member.firstAt,
      lastAt: member.lastAt,
      exitedAt: member.exitedAt,
      current: member.current,
      average: {
        cpu: member.sum.cpuCount > 0 ? member.sum.cpu / member.sum.cpuCount : null,
        memory: member.sum.memoryCount > 0 ? member.sum.memory / member.sum.memoryCount : null,
      },
      peak: member.peak,
    })
    return {
      items: shownLive.concat(shownExited).map(view),
      others: rest.length > 0
        ? { count: rest.length, memory: othersMemory, cpu: othersCpu }
        : null,
      total: live.length + exited.length,
      live: live.length,
      exited: exited.length,
    }
  }

  dispose() {
    this.#clearTimer()
    if (typeof this.#unsubscribe === 'function') this.#unsubscribe()
    this.#unsubscribe = null
  }
}
