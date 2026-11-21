/**
 * `Store` window semantics: times, gaps, and what a poll carries.
 *
 * The window used to describe itself as "n points a second apart", which was a
 * promise the sampler never made: after a stall the whole window slid and every
 * label was a few seconds off (`PITFALLS.md` §29). Now the first point's real
 * time is `t0`, and `times` rides along only when the spacing is not uniform —
 * that is what keeps the payload small in the normal case.
 *
 * Run with `node test/test-store.mjs`.
 */
import assert from 'node:assert/strict'
import { Store } from '../lib/store.js'

function section(overrides = {}) {
  return {
    id: 'cpu',
    kind: 'stream',
    intervalMs: 1000,
    historyMs: 6000,
    pick: (value) => value?.usage ?? null,
    ...overrides,
  }
}

function makeStore(overrides = {}, now = 0) {
  return new Store([section(overrides)], { now: () => now })
}

const usage = (value) => ({ usage: value })

// ── an even window carries no times, and t0 is the first sample ────────────
{
  const store = makeStore()
  store.write('cpu', usage(0.1), 1000)
  store.write('cpu', usage(0.2), 2000)
  store.write('cpu', usage(0.3), 3000)
  const read = store.read({ include: ['cpu'], since: { cpu: 0 } })
  const window = read.sections.cpu
  assert.deepEqual(window.v, [0.1, 0.2, 0.3])
  assert.equal(window.t0, 1000, 't0 comes from the points, not from at - (n-1) * dt')
  assert.equal(window.dt, 1000)
  assert.equal(window.times, undefined, 'an evenly spaced window pays nothing for times')
}

// ── a stall shows up as a gap, and every point keeps its own time ──────────
{
  const store = makeStore()
  store.write('cpu', usage(0.1), 1000)
  store.write('cpu', usage(0.2), 2000)
  // 3000–5000 missing: the collector was dead for three seconds.
  store.write('cpu', usage(0.4), 6000)
  const window = store.read({ include: ['cpu'], since: { cpu: 0 } }).sections.cpu
  assert.deepEqual(window.v, [0.1, 0.2, 0.4])
  assert.deepEqual(window.times, [1000, 2000, 6000], 'real times, gap included')
  assert.equal(window.t0, 1000, 'and the window start did not slide')
}

// ── an invalid sample is still a sample: it keeps its slot and its time ────
// A null here means "this yes-second had no valid rate" (PDH's first collect
// after a restart). Dropping it would shift the points after it.
{
  const store = makeStore()
  store.write('cpu', usage(0.1), 1000)
  store.write('cpu', usage(null), 2000)
  store.write('cpu', usage(0.3), 3000)
  const window = store.read({ include: ['cpu'], since: { cpu: 0 } }).sections.cpu
  assert.deepEqual(window.v, [0.1, null, 0.3], 'the null keeps its slot')
  assert.equal(window.times, undefined, 'the spacing is still even, so no times payload')
  assert.equal(window.t0, 1000)
}

// ── the ring rolls: capacity is history / interval, oldest goes first ──────
{
  const store = makeStore({ historyMs: 3000 })
  for (let index = 1; index <= 5; index += 1) store.write('cpu', usage(index / 10), index * 1000)
  const window = store.read({ include: ['cpu'], since: { cpu: 0 } }).sections.cpu
  assert.deepEqual(window.v, [0.3, 0.4, 0.5])
  assert.equal(window.t0, 3000)
}

// ── a section with no history only ever carries the newest value ───────────
{
  const store = makeStore({ id: 'processes', historyMs: 0, pick: undefined })
  store.write('processes', { items: [1] }, 1000)
  store.write('processes', { items: [2] }, 2000)
  const read = store.read({ include: ['processes'], since: { processes: 0 } })
  assert.equal(read.sections.processes, undefined, 'no window is sent at all')
  assert.deepEqual(read.values.processes, { items: [2] })
}

// ── a cursor already caught up gets `unchanged`, not the window again ──────
{
  const store = makeStore()
  store.write('cpu', usage(0.1), 1000)
  store.write('cpu', usage(0.2), 2000)
  const read = store.read({ include: ['cpu'], since: { cpu: 2 } })
  assert.deepEqual(read.unchanged, ['cpu'])
  assert.equal(read.sections.cpu, undefined)
}

console.log('test-store: 6 groups, ok')
