/**
 * TraceStore unit checks, no timers and no native child.
 *
 * Run with `node test/test-trace.mjs`.
 */
import assert from 'node:assert/strict'
import { TraceStore } from '../lib/trace.js'

function snapshot(items, at) {
  return { at, value: { sampledAt: new Date(at).toISOString(), items } }
}

function item(pid, overrides = {}) {
  return {
    pid,
    name: `app${pid}`,
    displayName: `App ${pid}`,
    appId: 'group-1',
    appName: 'Group',
    cpu: 0.1,
    workingSetBytes: 1000,
    privateBytes: 2000,
    handleCount: 10,
    threadCount: 2,
    ioReadBytes: 100,
    ioWriteBytes: 200,
    ...overrides,
  }
}

/**
 * A store with the real timer disarmed and a hand-driven clock. The test drives
 * `tickWith` and `clock.at`, so nothing here waits in real time.
 */
function makeTrace(options = {}) {
  const clock = { at: 1000 }
  const t = new TraceStore({ windowMs: 8000, now: () => clock.at, ...options })
  t.dispose()
  const preview = (target = { appId: 'group-1', kind: 'group', label: 'Group' }) => {
    const status = t.preview(target)
    t.dispose()
    return status
  }
  const start = (target = { appId: 'group-1', kind: 'group', label: 'Group' }) => {
    const status = t.start(target)
    t.dispose()
    return status
  }
  return { t, clock, preview, start }
}

/** The old shape: a started trace with the timer disarmed. */
function trace(options = {}) {
  const made = makeTrace(options)
  made.start()
  return made.t
}

// ── group aggregation, members, exit marking ────────────────────────────────
{
  const t = trace()
  t.tickWith(snapshot([item(1), item(2, { cpu: 0.2, privateBytes: 3000 })], 1000), 1000)
  const point = t.tickWith(snapshot([item(1), item(2, { cpu: 0.2, privateBytes: 3000 })], 2000), 2000)
  assert.ok(Math.abs(point.cpu - 0.3) < 1e-9, `cpu sum, got ${point.cpu}`)
  assert.equal(point.memory, 5000)

  t.tickWith(snapshot([item(1)], 3000), 3000)
  const view = t.read(0)
  const member2 = view.members.items.find((member) => member.pid === 2)
  assert.ok(member2, 'exited member is still listed')
  assert.equal(member2.exitedAt, 3000)
  assert.equal(member2.current.memory, 3000, 'exited member keeps its last value')

  // The aggregate drops the exited member from this point on, but the earlier
  // points keep their value — that is the step the chart marks.
  assert.equal(t.read(0).series.memory.at(-1), 2000)
}

// ── I/O rate is a difference, not the cumulative counter ────────────────────
{
  const t = trace()
  t.tickWith(snapshot([item(1, { ioReadBytes: 1000, ioWriteBytes: 2000 })], 1000), 1000)
  const point = t.tickWith(snapshot([item(1, { ioReadBytes: 3000, ioWriteBytes: 2000 })], 2000), 2000)
  assert.equal(point.ioReadPerSec, 2000)
  assert.equal(point.ioWritePerSec, 0)
}

// ── nothing is invented: no new sample, no point ────────────────────────────
// A held value would put last second's numbers on this second's timeline, and a
// zero would look like an idle machine; both are worse than a hole.
{
  const t = trace()
  t.tickWith(snapshot([item(1)], 1000), 1000)
  const repeated = t.tickWith(snapshot([item(1)], 1000), 1001)
  assert.equal(repeated, null, 'the same snapshot twice is not a new point')
  assert.equal(t.status().points, 1, 'and the ring did not grow')
  assert.equal(t.status().aggregate.memory, 2000, 'the last real value is still there')

  const stale = t.tickWith(snapshot([item(1)], 1000), 9000)
  assert.equal(stale, null, 'a 8 s old snapshot is not stretched into a point')
  assert.equal(t.status().points, 1)
  assert.equal(t.read(0).times.length, 1, 'no fabricated slot was added')
}

// ── the timeline comes from the points, not from the beat ───────────────────
// This is the case the old grid got wrong: a missing second used to shift every
// earlier label back by 1 s, because the start was `lastAt - (n-1) * 1000`.
{
  const t = trace()
  t.tickWith(snapshot([item(1)], 1000), 1000)
  t.tickWith(snapshot([item(1)], 2000), 2000)
  // 3000 is missing: the child skipped a beat, so no sample exists.
  t.tickWith(snapshot([item(1)], 4000), 4000)
  t.tickWith(snapshot([item(1)], 6000), 6000)
  const status = t.status()
  assert.equal(status.points, 4)
  assert.deepEqual(status.coverage, { from: 1000, to: 6000 }, 'coverage spans the real points')
  const view = t.read(0)
  assert.deepEqual(view.times, [1000, 2000, 4000, 6000], 'every point carries its own time')
  assert.equal(view.t0, 1000, 't0 is the first point, not the last one minus a grid')
  // The window [1500, 4500] holds exactly the points at 2000 and 4000.
  const window = t.range({ from: 1500, to: 4500, buckets: 3 })
  assert.equal(window.bucketMs, 1000)
  assert.equal(window.series.cpu.filter((value) => value !== null).length, 2,
    'the range maps times to buckets, so the two real points land in the right ones')
}

// ── a point comes from a write, so there is no tick without data ────────────
// Two 1 Hz clocks drift against each other; subscribing to the section removes
// the second clock instead of papering over the seams between the two.
{
  let current = { at: 1000, value: { items: [item(1)] } }
  const handlers = new Set()
  const store = {
    onWrite(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    current: () => current,
    touch() {},
  }
  const t = new TraceStore({ store, windowMs: 8000, now: () => 5000 })
  t.preview({ appId: 'group-1', kind: 'group', label: 'Group' })
  const emit = (id) => { for (const handler of [...handlers]) handler(id, 1) }
  assert.equal(t.status().points, 0, 'nothing is drawn before a sample exists')
  current = { at: 2000, value: { items: [item(1, { privateBytes: 7000 })] } }
  emit('cpu')
  assert.equal(t.status().points, 0, 'another section does not feed the trace')
  emit('processes')
  assert.equal(t.status().points, 1, 'the process snapshot does')
  assert.equal(t.read(0).times[0], 2000, 'stamped with the sample time, not the write time')
  t.dispose()
  assert.equal(handlers.size, 0, 'disposing unsubscribes')
}

// ── ring rolls at capacity; reads are cursor-based ──────────────────────────
{
  const t = trace({ windowMs: 3000 })
  for (let index = 1; index <= 5; index += 1) {
    t.tickWith(snapshot([item(1)], index * 1000), index * 1000)
  }
  const all = t.read(0)
  assert.equal(all.seq, 5)
  assert.equal(all.series.memory.length, 3, 'capacity is window / interval')
  assert.equal(all.t0, 5000 - 2 * 1000)
  assert.equal(all.dt, 1000)

  assert.equal(t.read(5).series.memory.length, 0, 'up to date means no new points')
  const tail = t.read(3)
  assert.equal(tail.series.memory.length, 2)
  assert.equal(tail.seq, 5)
  assert.equal(tail.series.memory.at(-1), 2000)
}

// ── a cursor past the ring reads cold instead of returning nothing ──────────
{
  const t = trace({ windowMs: 3000 })
  for (let index = 1; index <= 3; index += 1) {
    t.tickWith(snapshot([item(1)], index * 1000), index * 1000)
  }
  // What a client holds after a clear: the new trace only has 3 points.
  const view = t.read(99)
  assert.equal(view.series.memory.length, 3, 'a stale cursor falls back to a cold read')
}

// ── a target that disappears keeps recording until the user stops ───────────
{
  const t = trace()
  t.tickWith(snapshot([item(1)], 1000), 1000)
  t.tickWith(snapshot([], 2000), 2000)
  t.tickWith(snapshot([], 4000), 4000)
  assert.equal(t.status().recording, true, 'no automatic stop on an empty target')
  assert.equal(t.read(0).series.memory.at(-1), null, 'the gap is a null point')
  t.stop('user')
  assert.equal(t.status().recording, false)
  assert.equal(t.status().endedReason, 'user')
  assert.ok(t.read(0), 'the ring survives the stop')
}

// ── a dead sampler stops the trace instead of freezing it ──────────────────
// The recording used to keep running with a frozen ring: the header counted on
// while nothing arrived, which reads as "the panel is broken" rather than as a
// dead collector. Thirty seconds is a failure, not a gap.
{
  const { t, clock, start } = makeTrace()
  start()
  t.tickWith(snapshot([item(1)], 1000), 1000)
  clock.at = 2000
  t.tickWith(snapshot([item(1)], 2000), 2000)
  clock.at = 30_000
  assert.equal(t.sweepStall(), false, '29 s of silence is a slow beat, not a death')
  clock.at = 32_001
  assert.equal(t.sweepStall(), true, 'more than 30 s without a point ends it')
  const status = t.status()
  assert.equal(status.mode, 'stopped')
  assert.equal(status.endedReason, 'stalled', 'and it says why')
  assert.equal(status.points, 2, 'the ring is kept: what did arrive is still readable')
  assert.equal(t.sweepStall(), false, 'a stopped trace is not stopped twice')
}

// The same rule for a preview whose sampler never answers: it is not "waiting".
{
  const { t, clock } = makeTrace()
  t.preview({ appId: 'group-1', kind: 'group', label: 'Group' })
  clock.at = 31_001
  assert.equal(t.sweepStall(), true, 'a preview with no first sample also ends')
  assert.equal(t.status().endedReason, 'stalled')
}

// ── preview survives the page, then turns into a recording without a seam ──
{
  const { t, clock, preview } = makeTrace()
  const opened = preview()
  assert.equal(opened.mode, 'preview')
  assert.equal(opened.recordedAt, 0)
  t.tickWith(snapshot([item(1)], 1000), 1000)
  clock.at = 2000
  t.tickWith(snapshot([item(1, { privateBytes: 4000 })], 2000), 2000)
  clock.at = 2000
  const recording = t.start({ appId: 'group-1', kind: 'group', label: 'Group' })
  t.dispose()
  assert.equal(recording.mode, 'recording')
  assert.equal(recording.recordedAt, 2000)
  assert.equal(recording.points, 2, 'the preview ring is kept, not restarted')
  assert.equal(recording.startedAt, 1000, 'the trace keeps its own start time')
  clock.at = 5000
  assert.equal(t.status().elapsedMs, 3000, 'recording counts from the record press')
}

// ── stopped freezes the ring; starting again throws it away ────────────────
{
  const { t, clock, start } = makeTrace()
  start()
  t.tickWith(snapshot([item(1)], 1000), 1000)
  clock.at = 2000
  t.tickWith(snapshot([item(1, { privateBytes: 5000 })], 2000), 2000)
  clock.at = 3000
  const stopped = t.stop('user')
  assert.equal(stopped.mode, 'stopped')
  assert.equal(stopped.points, 2)
  assert.equal(stopped.endedAt, 3000)
  clock.at = 60_000
  assert.equal(t.status().elapsedMs, 2000, 'a stopped trace stops counting')
  assert.equal(t.tick(), null, 'nothing samples after a stop')
  assert.equal(t.read(0).series.memory.length, 2, 'the frozen ring is still readable')

  // A stopped trace is a result; starting a new one must not mix the two.
  const restarted = t.start({ appId: 'group-1', kind: 'group', label: 'Group' })
  t.dispose()
  assert.equal(restarted.points, 0, 'starting from stopped clears the old ring')
  assert.equal(restarted.startedAt, 60_000)
}

// ── clear drops ring and target; a recording refuses to be cleared ──────────
{
  const { t, start } = makeTrace()
  start()
  t.tickWith(snapshot([item(1)], 1000), 1000)
  const busy = t.clear()
  assert.equal(busy.mode, 'recording', 'clear is refused while recording')
  assert.equal(busy.points, 1)
  t.stop('user')
  const empty = t.clear()
  assert.equal(empty.mode, null)
  assert.equal(empty.target, null)
  assert.equal(empty.points, 0)
  assert.deepEqual(empty.coverage, { from: 0, to: 0 })
  assert.equal(t.read(0).series.cpu.length, 0)
}

// ── a preview nobody watches is dropped; a recording is not ────────────────
{
  const previewed = makeTrace()
  previewed.preview()
  previewed.t.tickWith(snapshot([item(1)], 1000), 1000)
  previewed.clock.at = 4000
  assert.equal(previewed.t.sweepPreview(5000), false, 'inside the TTL')
  previewed.clock.at = 7000
  assert.equal(previewed.t.sweepPreview(5000), true, 'a silent preview is dropped')
  const after = previewed.t.status()
  assert.equal(after.mode, null)
  assert.equal(after.points, 0, 'the peek ring is thrown away, never frozen')
  assert.deepEqual(after.coverage, { from: 0, to: 0 })
  assert.equal(after.target?.appId, 'group-1', 'the target stays, so the page can re-open it')

  const recorded = makeTrace()
  recorded.start()
  recorded.t.tickWith(snapshot([item(1)], 1000), 1000)
  recorded.clock.at = 60_000
  assert.equal(recorded.t.sweepPreview(5000), false, 'a recording ignores the viewer TTL')
  assert.equal(recorded.t.read(0).series.memory.length, 1)
}

// ── preview does not steal a recording from another window ─────────────────
{
  const { t, start } = makeTrace()
  start()
  const after = t.preview({ appId: 'other', kind: 'group', label: 'Other' })
  assert.equal(after.mode, 'recording')
  assert.equal(after.target.appId, 'group-1')
}

// ── process targets filter by pid, groups by appId ─────────────────────────
{
  const t = trace()
  t.start({ appId: '', pid: 2, kind: 'process', label: 'App 2' })
  t.dispose()
  t.tickWith(snapshot([item(1), item(2), item(3, { appId: 'other' })], 1000), 1000)
  const view = t.read(0)
  assert.equal(view.members.total, 1)
  assert.equal(view.members.items[0].pid, 2)
  assert.equal(view.series.memory[0], 2000)
}

// ── members beyond the live limit fold into `others` ───────────────────────
{
  const t = trace({ liveLimit: 2 })
  t.tickWith(snapshot([item(1), item(2), item(3)], 1000), 1000)
  const view = t.read(0)
  assert.equal(view.members.items.length, 2)
  assert.equal(view.members.others.count, 1)
  assert.equal(view.members.total, 3)
  assert.equal(view.members.live, 3, 'the header counts live members')
  assert.equal(view.members.exited, 0)
}

// ── frozen rows never crowd live members out of the payload ────────────────
// The reported bug: an app that restarts helpers for a few hours leaves dozens
// of frozen rows, they keep their last (large) memory, and one shared sorted
// list filled up with them — the seven live processes fell into `others`, where
// the page could only draw a dead "N more" row. Live members own the budget.
{
  const t = trace({ liveLimit: 4, exitedLimit: 2 })
  // 30 helpers, all with a big working set; ten of them leave at 2000 and the
  // rest at 3000.
  const helpers = Array.from({ length: 30 }, (_, index) => item(100 + index, { privateBytes: 9e8 }))
  t.tickWith(snapshot(helpers, 1000), 1000)
  t.tickWith(snapshot(helpers.slice(0, 20), 2000), 2000)
  t.tickWith(snapshot([], 3000), 3000)
  // The group's real, live members: small, and they must still be listed.
  const live = [item(1, { privateBytes: 3e6 }), item(2, { privateBytes: 2e6 }), item(3, { privateBytes: 1e6 })]
  t.tickWith(snapshot(live, 4000), 4000)

  const view = t.read(0)
  const pids = view.members.items.map((member) => member.pid)
  assert.deepEqual(pids.slice(0, 3), [1, 2, 3], 'live members come first, biggest first')
  assert.equal(view.members.live, 3)
  assert.equal(view.members.exited, 30, 'the exited count is reported, not mixed into the list')
  assert.equal(view.members.others, null, 'nothing live was pushed out')
  const frozen = view.members.items.filter((member) => member.exitedAt > 0)
  assert.equal(frozen.length, 2, 'only the newest exits ride along')
  assert.equal(frozen[0].exitedAt, 3000, 'and the newest is first')
  assert.ok(frozen.every((member) => member.pid >= 100))
  assert.equal(view.members.total, 33, 'the total still knows about everybody')
}

// ── frozen rows are capped, not accumulated for eight hours ────────────────
{
  const t = trace({ liveLimit: 4, exitedLimit: 2, exitedKeep: 8 })
  for (let round = 0; round < 20; round += 1) {
    t.tickWith(snapshot([item(round + 1)], (round * 2 + 1) * 1000), (round * 2 + 1) * 1000)
    t.tickWith(snapshot([], (round * 2 + 2) * 1000), (round * 2 + 2) * 1000)
  }
  const view = t.read(0)
  // The bound is `liveLimit + exitedKeep`: the sweep only runs once the map is
  // over it, so a trace can sit anywhere between the two.
  assert.ok(view.members.exited <= 12, `frozen rows stay bounded, got ${view.members.exited}`)
  assert.ok(view.members.exited >= 8, 'and the sweep keeps the keep-count, not nothing')
  assert.equal(view.members.live, 0)
  assert.deepEqual(view.members.items.map((member) => member.pid), [20, 19],
    'the newest exits are the two that are sent, newest first')
}

// ── a long absence is capped at what a chart can draw ─────────────────────
{
  const t = trace({ windowMs: 2_000_000 })
  for (let index = 1; index <= 2000; index += 1) {
    t.tickWith(snapshot([item(1)], index * 1000), index * 1000)
  }
  const view = t.read(0)
  assert.equal(view.series.cpu.length, 1200, 'the tail is capped at 1200 points')
  assert.equal(view.t0, 2_000_000 - 1199 * 1000, 'the cap keeps the newest points')
  assert.equal(view.dt, 1000, 'the cap does not stretch time')
}

// ── a window that fits is answered with the samples, not with a grid ───────
// The bug this pins: a 1 Hz ring whose samples drift a few ms per second against
// a 1 s bucket grid puts two samples in one bucket and leaves the next empty —
// a null slot, a broken pen, and "the curve is chopped into segments wherever I
// pan" on a perfectly dense recording. A window that holds no more samples than
// a chart can draw must therefore carry the real `times`.
{
  const t = trace({ windowMs: 600_000 })
  const times = []
  let at = 1000
  for (let index = 1; index <= 600; index += 1) {
    // Deliberately not multiples of 1000: the child's beat is anchored to its own
    // start plus enumeration time, so its samples are ~990..1015 ms apart.
    at += 1000 + ((index * 7) % 21) - 10
    times.push(at)
    const memory = index === 300 ? 900_000 : 1000
    t.tickWith(snapshot([item(1, { privateBytes: memory })], at), at)
  }
  const whole = t.range({ spanMs: 600_000, buckets: 60 })
  assert.equal(whole.bucketMs, 1000, 'no grid: the answer is the samples themselves')
  assert.equal(whole.series.memory.length, 600, 'every sample is in the answer')
  assert.deepEqual(whole.times, times, 'the real time base travels with them')
  assert.equal(whole.series.memory.includes(null), false,
    'a dense ring has no hole for the chart to break on')
  assert.equal(Math.max(...whole.series.memory), 900_000, 'the spike is still there')
  assert.equal(whole.t0, times[0], 't0 is the first sample, not the window edge')

  // Panning back: the window comes from the caller, not from the tail.
  const panned = t.range({ from: 100_000, to: 160_000, buckets: 120 })
  assert.equal(panned.from, 100_000)
  assert.equal(panned.to, 160_000)
  assert.equal(panned.series.cpu.length, panned.times.length, 'one slot per real sample')
  assert.equal(panned.times.length >= 59, true, 'a 60 s window holds about 60 samples')
  assert.equal(panned.times[0] >= 100_000, true)
  assert.equal(panned.times.at(-1) <= 160_000, true)

  // A window with no sample in it still answers with the grid, so the page keeps
  // its axes and its range bar instead of falling back to "no data".
  const before = t.range({ from: 1, to: 500, buckets: 60 })
  assert.equal(before.series.cpu.length > 0, true, 'an empty window keeps its slots')
  assert.equal(before.series.cpu.every((value) => value === null), true)
  assert.equal(before.times, undefined, 'a grid answer has no times')
}

// ── a real hole is a time jump, and a wide window still buckets ─────────────
{
  const t = trace({ windowMs: 2_400_000 })
  for (let index = 1; index <= 2400; index += 1) {
    // 2000 是缺的那一秒：贝特被跳过，环里就没有点。
    if (index === 2000) continue
    t.tickWith(snapshot([item(1)], index * 1000), index * 1000)
  }
  // 20 分钟以内：还是原始采样，缺的那秒是 times 上的 2 s 跳跃，不是 null。
  const fits = t.range({ spanMs: 600_000, buckets: 600 })
  assert.equal(fits.series.cpu.includes(null), false,
    'a scanned window costs no null: the hole is in `times`, where it happened')
  const jump = fits.times.findIndex((at, index) => index > 0 && at - fits.times[index - 1] > 1500)
  assert.equal(jump > 0, true, 'the missing second shows as a 2 s step in times')

  // 8 小时：桶宽 48 s，比任何一次真实采样间隔都大，所以空桶只可能是真的没采。
  const wide = t.range({ spanMs: 8 * 3600_000, buckets: 600 })
  assert.equal(wide.bucketMs >= 2000, true, 'a bucketed window never uses a 1 s bucket')
  assert.equal(wide.series.cpu.length, 1200, 'two slots per bucket')
  assert.equal(wide.times, undefined)
}

console.log('test-trace: all checks passed')
