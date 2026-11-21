'use strict'

/**
 * One periodic beat, aligned to a deadline grid instead of to "sleep N ms".
 *
 * The naive loop is `work(); setTimeout(work, interval)`. Its period is
 * `interval + work`, so every beat adds its own duration to the schedule, the
 * error is linear, and nothing in the data says so: 3 ms of work is 10.8 s per
 * hour, 86 s over the 8 h trace ring. Worse, when the work gets slower (a big
 * process table, a 50 ms audio segment) the drift grows with it.
 *
 * Here the deadline comes from an anchor and a beat index, and the wait is
 * recomputed *after* the work, so a slow beat costs its own lateness and the
 * next beat is back on the grid. `performance.now()` (monotonic) is the clock:
 * a wall-clock step (NTP correction, manual change) must not bend a schedule.
 *
 * Missed beats are counted, not replayed. If the loop was blocked for 3.5
 * intervals, running the collector three times in a burst is exactly what the
 * machine cannot afford at that moment: one beat still runs (the data would
 * otherwise have a hole), the rest land in `skipped` — an unaccounted skip is
 * what makes a timeline silently wrong.
 *
 * `now` / `setTimeout` / `clearTimeout` are injectable so `test/test-beat.mjs`
 * can drive a fake clock instead of waiting in real time.
 *
 * @param {{
 *   interval: number,
 *   onBeat?: (at: number) => void,
 *   onSkipped?: (missed: number) => void,
 *   now?: () => number,
 *   setTimeout?: (fn: () => void, ms: number) => unknown,
 *   clearTimeout?: (id: unknown) => void,
 * }} options
 */
function createBeat(options = {}) {
  const interval = Math.max(1, Math.floor(Number(options.interval) || 1000))
  const now = typeof options.now === 'function' ? options.now : () => performance.now()
  const arm = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (fn, ms) => setTimeout(fn, ms)
  const disarm = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : (id) => clearTimeout(id)
  const onBeat = typeof options.onBeat === 'function' ? options.onBeat : null
  const onSkipped = typeof options.onSkipped === 'function' ? options.onSkipped : null

  /** `beat` is the index of the *next* beat to fire; deadline = anchor + n·interval. */
  let anchor = 0
  let beat = 1
  let timer = null
  let running = false

  let lastAt = 0
  let periodMs = 0
  let lateMs = 0
  /** Worst wake-up error since start. A grid that drifts makes this climb. */
  let lateMax = 0
  let skipped = 0
  let beats = 0

  const target = () => anchor + beat * interval

  const schedule = () => {
    if (!running) return
    let wait = target() - now()
    if (wait < -interval) {
      // Blocked for more than one whole interval: move the grid forward over
      // the missed slots instead of firing them back to back.
      const missed = Math.floor(-wait / interval)
      beat += missed
      skipped += missed
      if (onSkipped) onSkipped(missed)
      wait = target() - now()
    }
    // `ceil`: the timer API truncates to whole milliseconds, and truncating a
    // 249.4 ms wait fires the beat 0.6 ms *before* its deadline. Being late is
    // fine (it is measured); being early is a lie.
    timer = arm(fire, Math.max(0, Math.ceil(wait)))
  }

  const fire = () => {
    timer = null
    if (!running) return
    const at = now()
    lateMs = at - target()
    if (Math.abs(lateMs) > lateMax) lateMax = Math.abs(lateMs)
    periodMs = lastAt === 0 ? interval : at - lastAt
    lastAt = at
    beat += 1
    beats += 1
    // The beat after a throwing callback must still run: a broken collector is
    // one bad sample, not the end of the loop.
    try {
      if (onBeat) onBeat(at)
    } finally {
      schedule()
    }
  }

  return {
    get running() {
      return running
    },
    get intervalMs() {
      return interval
    },
    start() {
      if (running) return
      running = true
      anchor = now()
      // The first beat is one interval out, not "now": the caller has just
      // sampled (or wants a moment of quiet) and `reset()` must not fire a
      // burst of catch-up beats for the time nobody was watching.
      beat = 1
      lastAt = 0
      schedule()
    },
    stop() {
      running = false
      if (timer !== null) disarm(timer)
      timer = null
    },
    /**
     * Re-anchor the grid at "now". What a loop coming back from a pause wants:
     * keeping the old anchor would make it fire a burst to catch up on the
     * minutes nobody was looking.
     */
    reset() {
      this.stop()
      anchor = 0
      beat = 1
      lastAt = 0
      periodMs = 0
      lateMs = 0
      lateMax = 0
      skipped = 0
      beats = 0
      this.start()
    },
    /** `periodMs` / `lateMs` / `lateMax` / `skipped` are what a sampler must be able to show. */
    stats() {
      return {
        intervalMs: interval,
        periodMs: Math.round(periodMs * 10) / 10,
        lateMs: Math.round(lateMs * 10) / 10,
        lateMaxMs: Math.round(lateMax * 10) / 10,
        skipped,
        beats,
      }
    },
  }
}

module.exports = { createBeat }
