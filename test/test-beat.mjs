/**
 * `native/beat.cjs` checks, with a fake clock: nothing here waits in real time.
 *
 * The property under test is the one the old `setTimeout(interval)` chain broke:
 * **the deadline is absolute**. Work time must be absorbed by the next wait, not
 * added to the period, and a stall must be reported rather than swallowed.
 *
 * Run with `node test/test-beat.mjs`.
 */
import assert from 'node:assert/strict'
import beatModule from '../native/beat.cjs'

const { createBeat } = beatModule

/**
 * A clock that also runs timers: `advance` walks time forward and fires every
 * deadline it passes (timers armed inside a callback are picked up too).
 */
function fakeClock() {
  let t = 0
  const queue = []
  return {
    now: () => t,
    setTimeout(handler, ms) {
      const entry = { handler, at: t + Math.max(0, Math.floor(ms)) }
      queue.push(entry)
      return entry
    },
    clearTimeout(entry) {
      const index = queue.indexOf(entry)
      if (index >= 0) queue.splice(index, 1)
    },
    /** Time passes without the loop running — a GC pause, a synchronous scan. */
    block(ms) {
      t += ms
    },
    advance(ms) {
      const end = t + ms
      for (;;) {
        queue.sort((a, b) => a.at - b.at)
        const next = queue[0]
        if (!next || next.at > end) break
        queue.shift()
        t = next.at
        next.handler()
      }
      // A callback may have blocked for a while; time never runs backwards.
      t = Math.max(t, end)
    },
    get pending() {
      return queue.length
    },
  }
}

function makeBeat(clock, options = {}) {
  const fired = []
  const beat = createBeat({
    interval: 1000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onBeat: (at) => fired.push(at),
    ...options,
  })
  return { beat, fired }
}

// ── 1. work time is absorbed, not accumulated ───────────────────────────────
{
  const clock = fakeClock()
  const fired = []
  const beat = createBeat({
    interval: 1000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onBeat: (at) => {
      fired.push(at)
      clock.block(3) // the collector's 1–3 ms, the thing that used to drift
    },
  })
  beat.start()
  clock.advance(10_000)
  assert.equal(fired.length, 10, 'one beat per second, ten beats in ten seconds')
  assert.deepEqual(
    fired,
    [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000],
    'every beat lands on the grid: 3 ms of work must not push the next one',
  )
  // The naive chain would have reported ~1003 here and grown by 3 ms per beat.
  assert.equal(beat.stats().periodMs, 1000, 'measured period is the grid, not the work')
  assert.equal(beat.stats().skipped, 0)
  assert.equal(beat.stats().beats, 10)
  beat.stop()
}

// ── 2. a slow beat is late once, then the grid is back ──────────────────────
{
  const clock = fakeClock()
  const fired = []
  let late = null
  const beat = createBeat({
    interval: 1000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onBeat: (at) => {
      fired.push(at)
      if (fired.length === 4) clock.block(1600) // 1.6 s of work on one beat
      if (fired.length === 5) late = beat.stats()
    },
  })
  beat.start()
  clock.advance(7000)
  // Beat 4 ran at 4000 and its work ate 1.6 s, so beat 5 fires at 5600: the
  // 5000 deadline was already gone. One late beat, not a shifted schedule.
  assert.deepEqual(fired.slice(0, 4), [1000, 2000, 3000, 4000])
  assert.equal(fired[4], 5600, 'the overdue beat runs immediately')
  assert.equal(late.lateMs, 600, 'and it reports how late it was')
  assert.equal(fired[5], 6000, 'the next beat is back on the 1 s grid')
  assert.equal(beat.stats().skipped, 0, '600 ms late is not a skip')
  beat.stop()
}

// ── 3. a long stall is counted, not replayed in a burst ─────────────────────
{
  const clock = fakeClock()
  const fired = []
  const skips = []
  const beat = createBeat({
    interval: 1000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onBeat: (at) => {
      fired.push(at)
      if (fired.length === 4) clock.block(3600) // 3.6 s, e.g. a cold read of the ring
    },
    onSkipped: (missed) => skips.push(missed),
  })
  beat.start()
  clock.advance(12_000)
  assert.deepEqual(skips, [2], 'two whole intervals were missed')
  assert.equal(beat.stats().skipped, 2)
  // 3600 ms of stall from 4000 → 7600. The grid slot for 7000 is the one that
  // runs (600 ms late); 5000 and 6000 are dropped instead of fired back to back.
  assert.equal(fired[4], 7600)
  assert.equal(fired[5], 8000, 'and the grid is realigned, not dragged')
  assert.equal(fired[6], 9000)
  assert.equal(fired.length, 10, 'no burst: one beat per remaining second')
  beat.stop()
}

// ── 4. stop is final, reset re-anchors ──────────────────────────────────────
{
  const clock = fakeClock()
  const { beat, fired } = makeBeat(clock)
  beat.start()
  clock.advance(3000)
  assert.equal(fired.length, 3)
  beat.stop()
  clock.block(10_000) // the loop slept (nobody was watching the process page)
  clock.advance(5000)
  assert.equal(fired.length, 3, 'a stopped beat stays stopped')
  assert.equal(clock.pending, 0, 'and leaves no timer behind')

  // Waking up must not catch up on the 10 s nobody asked for.
  beat.reset()
  clock.advance(2000)
  assert.deepEqual(fired.slice(3), [19_000, 20_000], 're-anchored at the moment it restarted')
  assert.equal(beat.stats().skipped, 0, 'a pause is a pause, not a skip')
  beat.stop()
}

// ── 5. a throwing collector still re-arms the timer ─────────────────────────
{
  const clock = fakeClock()
  const fired = []
  const beat = createBeat({
    interval: 1000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onBeat: (at) => {
      fired.push(at)
      if (fired.length === 2) throw new Error('collector blew up')
    },
  })
  beat.start()
  let threw = null
  try {
    clock.advance(3000)
  } catch (error) {
    threw = error
  }
  // The error is not swallowed — a broken collector has to be visible — but the
  // schedule is armed before it propagates, so the loop survives one bad beat.
  assert.equal(threw?.message, 'collector blew up', 'the error still reaches the caller')
  assert.equal(fired.length, 2)
  assert.equal(clock.pending, 1, 'the next deadline was armed anyway')
  clock.advance(2000)
  assert.deepEqual(fired.slice(2), [3000, 4000], 'and the cadence carries on')
  beat.stop()
}

// ── 6. repeat calls to start/stop are harmless ──────────────────────────────
{
  const clock = fakeClock()
  const { beat, fired } = makeBeat(clock)
  beat.start()
  beat.start()
  clock.advance(2000)
  assert.equal(fired.length, 2, 'start twice must not double-arm the timer')
  beat.stop()
  beat.stop()
  assert.equal(clock.pending, 0)
}

console.log('test-beat: 6 groups, ok')
