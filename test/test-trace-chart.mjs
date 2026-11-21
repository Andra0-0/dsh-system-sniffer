/**
 * The trace chart's segment count.
 *
 * A trace curve is "one segment" unless the data really has a hole: the chart
 * breaks its pen on a non-finite value and nowhere else. This test states that
 * in three shapes — a dense 26 s recording, the same recording with one missing
 * second, and a bucketed 8 h window — so a future "the line looks chopped"
 * report can be answered by checking whether the dots were there, not by
 * guessing at the renderer.
 *
 * Run with `node test/test-trace-chart.mjs`.
 */
import assert from 'node:assert/strict'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) { captured = { factory } },
  },
}
const seam = {}
globalThis.__DSH_SNIFFER_TEST__ = seam
await import(new URL('../client.js?chart', import.meta.url).href)
assert.ok(captured, 'client.js must register a module factory')

const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
captured.factory((specifier) => {
  if (specifier === 'react') return { createElement: h, Fragment: Symbol('Fragment') }
  throw new Error(`unexpected require: ${specifier}`)
})

const { TraceChart, traceBounds, toTraceChart } = seam

/** The `d` an svg path would get for these props. */
function pathOf(props) {
  const tree = TraceChart(props)
  const svg = tree.children.find((child) => child?.type === 'svg')
  const path = svg.children.find((child) => child?.type === 'path')
  return path.props.d
}

const segments = (d) => (d.match(/M/g) ?? []).length

const t0 = 1_700_000_000_000
const times = Array.from({ length: 26 }, (_, index) => t0 + index * 1000)
const cpu = times.map((_, index) => 0.1 + (index % 5) * 0.01)
const chart = { t0, dt: 1000, times, cpu, coverage: { from: t0, to: t0 + 25_000 } }

// A dense ring draws one line, whatever the window is called.
const all = traceBounds({ spanMs: null, endAt: null }, chart.coverage)
assert.equal(segments(pathOf({ values: cpu, max: 1, color: '#00f', label: 'CPU', readout: '', t0, dt: 1000, times, from: all.from, to: all.to })), 1)
const wide = { from: t0 - 3600_000, to: t0 + 3600_000 }
assert.equal(segments(pathOf({ values: cpu, max: 1, color: '#00f', label: 'CPU', readout: '', t0, dt: 1000, times, from: wide.from, to: wide.to })), 1)

// One missing second is one hole. The pen breaks there and only there: this is
// what a chopped-looking curve means, and it is data, not drawing.
const holed = cpu.slice()
holed[12] = null
assert.equal(segments(pathOf({ values: holed, max: 1, color: '#00f', label: 'CPU', readout: '', t0, dt: 1000, times, from: all.from, to: all.to })), 2)

// A bucketed range answer has no `times`: every slot is one grid step, and the
// 1128 slots of an 8 h window must still be a single path.
const slots = Array.from({ length: 1128 }, (_, index) => (index % 7 === 3 ? null : 0.1 + (index % 3) * 0.01))
assert.equal(segments(pathOf({ values: slots, max: 1, color: '#00f', label: 'CPU', readout: '', t0, dt: 25_000, times: null, from: t0, to: t0 + 8 * 3600_000 })), 162)

// The shape the Host actually sends, through the client's own converter.
const payload = {
  t0,
  dt: 1000,
  times,
  series: { cpu, memory: cpu.map((value) => value * 1e9), ioReadPerSec: cpu, ioWritePerSec: cpu },
  coverage: chart.coverage,
}
const converted = toTraceChart(payload)
assert.equal(converted.cpu.length, 26)
assert.equal(converted.times.length, 26)
assert.equal(segments(pathOf({ values: converted.cpu, max: 1, color: '#00f', label: 'CPU', readout: '', t0: converted.t0, dt: converted.dt, times: converted.times, from: all.from, to: all.to })), 1)

// The gap readout: 0 on a dense ring, the real hole otherwise. This is the
// number the header shows when a curve looks chopped.
const { traceGapMs } = seam
assert.equal(traceGapMs(chart), 0, 'a 1 Hz ring has no gap')
const jumped = times.map((at, index) => at + (index > 12 ? 1000 : 0))
assert.equal(traceGapMs({ ...chart, times: jumped }), 2000, 'a skipped second is a 2 s gap')
const holes = { cpu: [0.1, 0.1, null, null, null, 0.1, 0.1], dt: 1000, times: null }
assert.equal(traceGapMs(holes), 3000, 'a bucketed hole is counted in slots')
assert.equal(traceGapMs({ cpu: [0.1, 0.1], dt: 1000, times: null }), 0)

delete globalThis.__DSH_SNIFFER_TEST__
console.log('test-trace-chart: all checks passed')
