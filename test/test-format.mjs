/**
 * The pure helpers behind the panel: formatters, grouping, sorting, the treemap
 * and the trace window.
 *
 * They live inside `client.js`'s closure with no DOM and no React, so this file
 * reaches them through the module's test seam rather than through a rendered
 * table: boundary values (1023 vs 1024 bytes, a missing CPU, a group whose lead
 * is not its busiest member) are the whole point, and a DOM assertion cannot
 * state them precisely.
 *
 * Run with `node test/test-format.mjs`.
 */
import assert from 'node:assert/strict'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      captured = { id, factory }
    },
  },
}

const seam = {}
globalThis.__DSH_SNIFFER_TEST__ = seam
await import(new URL('../client.js?format', import.meta.url).href)
assert.ok(captured, 'client.js must register a module factory')

// The factory asks for React before anything else; the helpers under test never
// touch it, so a bare object is enough.
captured.factory((specifier) => {
  if (specifier === 'react') return { createElement() {}, Fragment: Symbol('Fragment') }
  throw new Error(`unexpected require: ${specifier}`)
})
assert.ok(seam.fmtBytes, 'the factory publishes the helpers when the test global is set')

const { fmtPct, fmtBytes, fmtRate, fmtDuration, fmtClock, compareNumbers, groupProcesses, sortGroups, squarify, traceBounds } = seam

// ── percentages ────────────────────────────────────────────────────────────
assert.equal(fmtPct(0.1234), '12.3%')
assert.equal(fmtPct(0), '0.0%')
assert.equal(fmtPct(1), '100.0%')
// A PDH artifact is clamped, never shown as "-0.0%".
assert.equal(fmtPct(-0.2), '0.0%')
assert.equal(fmtPct(1.4), '100.0%')
for (const missing of [null, undefined, NaN, Infinity]) {
  assert.equal(fmtPct(missing), '—', `fmtPct(${String(missing)})`)
}

// ── bytes ──────────────────────────────────────────────────────────────────
assert.equal(fmtBytes(0), '0 KB')
assert.equal(fmtBytes(1023), '1 KB')
assert.equal(fmtBytes(1024 ** 2), '1 MB')
assert.equal(fmtBytes(1024 ** 3 - 1), '1024 MB')
assert.equal(fmtBytes(1024 ** 3), '1.0 GB')
assert.equal(fmtBytes(1.5 * 1024 ** 3), '1.5 GB')
assert.equal(fmtBytes(1024 ** 4), '1.00 TB')
for (const missing of [null, undefined, NaN, -1]) {
  assert.equal(fmtBytes(missing), '—', `fmtBytes(${String(missing)})`)
}

// ── rates ──────────────────────────────────────────────────────────────────
assert.equal(fmtRate(0), '0 B/s')
assert.equal(fmtRate(512), '512 B/s')
assert.equal(fmtRate(1024), '1 KB/s')
assert.equal(fmtRate(1024 ** 2), '1.0 MB/s')
// A negative rate is an artifact, not a direction.
assert.equal(fmtRate(-2048), '0 B/s')
assert.equal(fmtRate(NaN), '—')

// ── durations and clocks ───────────────────────────────────────────────────
assert.equal(fmtDuration(0), '0:00')
assert.equal(fmtDuration(1000), '0:01')
assert.equal(fmtDuration(61_000), '1:01')
assert.equal(fmtDuration(3_725_000), '1:02:05')
assert.equal(fmtDuration(-500), '0:00')
assert.equal(fmtDuration(NaN), '0:00')
assert.equal(fmtClock(0), '—')
assert.equal(fmtClock(NaN), '—')
assert.match(fmtClock(Date.now()), /^\d{2}:\d{2}:\d{2}$/)

// ── ordering ───────────────────────────────────────────────────────────────
assert.equal(compareNumbers(2, 1, 1), 1)
assert.equal(compareNumbers(2, 1, -1), -1)
assert.equal(compareNumbers(3, 3, 1), 0)
// A missing value sorts last in both directions, so an empty cell never jumps
// to the top when the column is reversed.
assert.equal(compareNumbers(null, 5, 1), 1)
assert.equal(compareNumbers(null, 5, -1), 1)
assert.equal(compareNumbers(5, null, -1), -1)

// ── process grouping ───────────────────────────────────────────────────────
const items = [
  { pid: 1, name: 'chrome', appId: 'chrome', cpu: 0.5, workingSetBytes: 100, hasWindow: false },
  { pid: 2, name: 'chrome', appId: 'chrome', cpu: 0.1, workingSetBytes: 300, hasWindow: true },
  { pid: 3, name: 'notepad', cpu: 1, workingSetBytes: 50 },
]
const groups = groupProcesses(items)
assert.equal(groups.length, 2)
const chrome = groups.find((group) => group.key === 'chrome')
assert.equal(chrome.count, 2)
assert.equal(chrome.group, true)
assert.equal(chrome.cpu, 0.6)
assert.equal(chrome.memory, 400)
// The member with a window leads, even when another member is busier.
assert.equal(chrome.lead.pid, 2)
assert.equal(chrome.pid, 2)
// Members stay in busiest-first order; the lead is a separate field, so the
// group row can name the windowed process without reordering the expansion.
assert.deepEqual(chrome.members.map((member) => member.pid), [1, 2])
const notepad = groups.find((group) => group.key === 'notepad')
assert.equal(notepad.group, false)
assert.equal(notepad.count, 1)
assert.deepEqual(groupProcesses([]), [])

const sorted = sortGroups(groups, 'cpu', 'desc')
assert.deepEqual(sorted.map((group) => group.key), ['notepad', 'chrome'])
const byName = sortGroups(groups, 'name', 'asc')
assert.deepEqual(byName.map((group) => group.name), ['chrome', 'notepad'])

// ── treemap ────────────────────────────────────────────────────────────────
const rects = squarify([{ bytes: 3 }, { bytes: 1 }], 100, 100)
assert.equal(rects.length, 2)
const area = rects.reduce((sum, rect) => sum + rect.w * rect.h, 0)
assert.ok(Math.abs(area - 10_000) < 1, `treemap covers its canvas (got ${area})`)
assert.ok(Math.abs(rects[0].w * rects[0].h - 7_500) < 1, 'the 3:1 split is 3:1 in area')
for (const rect of rects) {
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 100.001 && rect.y + rect.h <= 100.001)
}
assert.deepEqual(squarify([], 100, 100), [])
assert.deepEqual(squarify([{ bytes: 0 }], 100, 100), [])
assert.deepEqual(squarify([{ bytes: 1 }], 0, 100), [])

// ── trace window ───────────────────────────────────────────────────────────
assert.deepEqual(
  traceBounds({ spanMs: 60_000, endAt: null }, { from: 0, to: 500_000 }),
  { from: 440_000, to: 500_000 },
)
assert.deepEqual(
  traceBounds({ spanMs: 60_000, endAt: 300_000 }, { from: 0, to: 500_000 }),
  { from: 240_000, to: 300_000 },
)
// "All" is the ring itself.
assert.deepEqual(traceBounds({ spanMs: null, endAt: null }, { from: 1000, to: 9000 }), { from: 1000, to: 9000 })
// Nothing recorded yet: keep a minimum window instead of a zero-width axis.
const empty = traceBounds({ spanMs: null, endAt: null }, { from: 0, to: 0 })
assert.equal(empty.to - empty.from, 60_000)

delete globalThis.__DSH_SNIFFER_TEST__
console.log('test-format: all checks passed')
