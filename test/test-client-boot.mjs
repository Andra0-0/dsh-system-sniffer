/**
 * Boot the browser half outside the browser.
 *
 * `node --check` only proves the file parses; a stray backtick inside the CSS
 * template is still valid JavaScript and only throws when the factory runs —
 * which is how the rail entry disappeared once. This harness executes the
 * factory and `apply` with a fake client context, and then *renders* the panel
 * once with a fake trace snapshot, because a typo in the trace page only shows
 * when the component actually runs.
 *
 * Run with `node test/test-client-boot.mjs`.
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

const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
const React = {
  createElement: h,
  Fragment: Symbol('Fragment'),
  useEffect() {},
  useMemo(fn) { return fn() },
  useRef(value) { return { current: value } },
  useState(value) { return [typeof value === 'function' ? value() : value, () => {}] },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
}

/**
 * A minimal renderer: walk the element tree, call function components, ignore
 * hosts. Enough to make every `h(...)` body in the panel execute once. Chart
 * calls are collected so a test can assert the window they were given.
 */
const chartCalls = []
const classed = []
/**
 * SVG paths, so a test can check where a point was actually drawn. Each one is
 * tagged with the className of the element it sits in: the rail draws icons
 * before the charts do, so "the first path" is not a chart path any more.
 */
const paths = []
function render(node, context) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) render(child, context)
    return
  }
  const { type, props, children } = node
  // Children travel with the record, so a test can find a button by its label
  // (the locale here is key-only, so labels are keys). `parent` is the nearest
  // enclosing className, which is how a test asks "does the range bar live in
  // the chart column?".
  if (typeof props?.className === 'string') {
    classed.push({ className: props.className, props, children, parent: context })
  }
  const inner = typeof props?.className === 'string' ? props.className : context
  if (type === 'path' && typeof props?.d === 'string') paths.push({ d: props.d, context })
  if (typeof type === 'function') {
    const merged = { ...(props ?? {}) }
    if (children?.length === 1) merged.children = children[0]
    else if (children?.length > 1) merged.children = children
    if (type.name === 'TraceChart') chartCalls.push(merged)
    render(type(merged), inner)
    return
  }
  for (const child of children ?? []) render(child, inner)
}

await import(new URL('../client.js?boot', import.meta.url).href)
assert.ok(captured, 'client.js must register a module factory')
assert.equal(captured.id, '@local/dsh-system-sniffer')

const registrations = []
const disposers = []
const ctx = {
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  },
  slots: {
    inject(owner, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({
        owner: options?.name ?? null,
        id: options?.id ?? options?.key ?? null,
        component: component?.name ?? '?',
        render: component,
        options,
      })
      return () => {}
    },
  },
  layout: {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: null }),
      subscribe: () => () => {},
    },
    selectPanel() {},
  },
  locale: {
    register() {},
    bind: () => (key) => key,
  },
}

const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
assert.equal(typeof plugin.apply, 'function')

plugin.apply(ctx)
const owners = registrations.map((entry) => entry.owner)
assert.ok(owners.includes('main'), 'main panel must register')
assert.ok(owners.includes('sidebar.panellist'), 'rail entry must register')
assert.ok(owners.includes('shell.overlay'), 'recording badge must register')
assert.ok(registrations.every((entry) => entry.component !== '?'), 'every registration needs a component')

/** The `runtime` the main slot injects; the rail and badge read it too. */
const main = registrations.find((entry) => entry.owner === 'main')
const mainProps = main.options.inject ? main.options.inject() : {}
const runtime = mainProps.runtime
assert.ok(runtime, 'main panel must receive a runtime')

// ── render every tab once ──────────────────────────────────────────────────
for (const tab of ['processes', 'performance', 'disks', 'trace']) {
  runtime.tabs.set(tab)
  render(main.render(mainProps))
}

// ── render the trace page with data, recording, and a pending pick ─────────
const now = Date.now()
const point = (index) => Math.sin(index / 10) / 2 + 0.5
/**
 * The ring the bar maps onto. `coverage` is the ring's extent in every answer
 * the Host sends (the window is derived from it), so the thumb's place is a
 * statement about the ring — the old fake payload said 60 s here while its
 * overview said 10 min, which is a shape the Host never produces.
 */
const ring = { from: now - 600_000, to: now }
const traceMember = (pid, name, exitedAt = 0) => ({
  pid,
  name,
  image: 'chrome.exe',
  firstAt: now - 120_000,
  lastAt: now,
  exitedAt,
  current: { cpu: 0.3, memory: 2e8, handleCount: 420, threadCount: 33, ioReadPerSec: 1024, ioWritePerSec: 0 },
  average: { cpu: 0.2, memory: 2e8 },
  peak: { cpu: 0.5, memory: 2e8, handleCount: 430, threadCount: 35 },
})
const chart = {
  t0: now - 60_000,
  dt: 1000,
  cpu: Array.from({ length: 61 }, (_, index) => point(index)),
  memory: Array.from({ length: 61 }, (_, index) => 2e8 + index * 1e5),
  io: Array.from({ length: 61 }, (_, index) => (index % 7 === 0 ? null : index * 1024)),
  coverage: ring,
  members: {
    items: [
      traceMember(1, 'Renderer'),
      traceMember(2, 'GPU Process'),
      traceMember(9, 'Closed tab', now - 30_000),
    ],
    others: { count: 2, memory: 1e8, cpu: 0.1 },
    // The Host splits the counts: live members are what the header counts, the
    // frozen ones get their own block. `total` stays for an older Host.
    total: 3,
    live: 2,
    exited: 1,
  },
}
const status = {
  mode: 'recording',
  target: { appId: 'app-1', pid: null, kind: 'group', label: 'Chrome' },
  recording: true,
  startedAt: now - 120_000,
  recordedAt: now - 120_000,
  endedAt: 0,
  endedReason: null,
  elapsedMs: 120_000,
  seq: 61,
  points: 61,
  memberCount: 3,
  aggregate: { cpu: 0.4, memory: 2e8, handleCount: 420, threadCount: 33, ioReadPerSec: 1024, ioWritePerSec: 512 },
  windowMs: 8 * 3600_000,
  coverage: chart.coverage,
}

runtime.tabs.set('trace')
runtime.getTrace = () => status
runtime.getView = () => ({ snapshot: { traceChart: chart, trace: { coverage: chart.coverage } }, error: null })
render(main.render(mainProps))

// A stopped trace: the same page with the frozen-ring wording.
status.mode = 'stopped'
status.recording = false
status.endedAt = now
render(main.render(mainProps))

// A pick the Host has not accepted: the page must offer replace/cancel instead
// of drawing the new target over the old ring.
runtime.getPendingTrace = () => ({ appId: 'app-2', pid: null, kind: 'group', label: 'DingTalk' })
render(main.render(mainProps))

// The zoomed window: a pinned viewport and a wide span.
runtime.getPendingTrace = () => null
runtime.traceView.set({ spanMs: 3600_000, endAt: now - 60_000 })
render(main.render(mainProps))

// ── a record younger than the window sits at the right edge ───────────────
// Like the performance page: the newest point is on the right, the part of the
// window the record does not cover yet is simply empty.
chartCalls.length = 0
const youngFrom = now - 3000
const youngChart = {
  t0: youngFrom,
  dt: 1000,
  cpu: chart.cpu.slice(0, 3),
  memory: chart.memory.slice(0, 3),
  io: chart.io.slice(0, 3),
  coverage: { from: youngFrom, to: now },
  members: chart.members,
}
runtime.getView = () => ({ snapshot: { traceChart: youngChart }, error: null })
runtime.traceView.set({ spanMs: 60_000, endAt: null })
render(main.render(mainProps))
assert.equal(chartCalls.length, 3, 'all three charts render')
for (const call of chartCalls) {
  assert.equal(call.to, now, 'a young window still ends at the newest point')
  assert.equal(call.from, now - 60_000, 'and is exactly one span wide')
}

// ── the range bar maps the window onto the whole ring ─────────────────────
// A 10-minute ring with a 60 s window at the tail: the thumb must be the last
// tenth of the bar, not the whole of it.
classed.length = 0
runtime.getView = () => ({ snapshot: { traceChart: chart }, error: null })
runtime.traceView.set({ spanMs: 60_000, endAt: null })
render(main.render(mainProps))
let block = classed.find((entry) => entry.className === 'ss-trace-overview-block')
assert.ok(block, 'the bar renders over a long enough ring')
assert.equal(block.props.style.left, '90.000%', 'the thumb starts where the window starts')
assert.equal(block.props.style.width, '10.000%', 'and is as wide as the window')
assert.ok(classed.some((entry) => entry.className === 'ss-trace-overview-grip'), 'both grips render')
// The bar is a time bar: four clock labels, no line under the thumb.
assert.equal(
  classed.filter((entry) => entry.className === 'ss-trace-tick').length,
  4,
  'four evenly spaced clock labels',
)
assert.ok(
  !classed.some((entry) => entry.className === 'ss-trace-overview-svg'),
  'the CPU line under the thumb is gone',
)
// The bar is the chart's clock, so it belongs to the chart column: same parent
// as the plots, and the plots carry no axis row of their own any more.
const barEntry = classed.find((entry) => entry.className === 'ss-trace-range')
assert.equal(barEntry?.parent, 'ss-trace-stage', 'the bar sits inside the plot column')
const chartsEntry = classed.find((entry) => entry.className === 'ss-trace-charts')
assert.equal(chartsEntry?.parent, 'ss-trace-stage', 'and the plots are its sibling, not its child')
assert.ok(!classed.some((entry) => entry.className === 'ss-trace-axis'), 'the plots have no clock of their own')

// ── "all": the window is the ring, and it keeps being the ring ────────────
// Pulling the ends out sets `spanMs: null`, not a span equal to today's ring —
// otherwise the view would stop covering everything as the ring grows.
const longChart = {
  t0: now - 600_000,
  dt: 10_000,
  cpu: Array.from({ length: 61 }, () => 0.3),
  memory: Array.from({ length: 61 }, () => 2e8),
  io: Array.from({ length: 61 }, () => 1024),
  coverage: ring,
  members: chart.members,
}
classed.length = 0
chartCalls.length = 0
runtime.getView = () => ({ snapshot: { traceChart: longChart }, error: null })
runtime.traceView.set({ spanMs: null })
render(main.render(mainProps))
assert.equal(runtime.traceView.getSnapshot().spanMs, null, 'all is a mode, not a span')
for (const call of chartCalls) {
  assert.equal(call.from, now - 600_000, 'all starts at the ring start')
  assert.equal(call.to, now, 'and ends at the newest point')
}
block = classed.find((entry) => entry.className === 'ss-trace-overview-block')
assert.equal(block.props.style.left, '0.000%')
assert.equal(block.props.style.width, '100.000%', 'all fills the bar')
assert.ok(classed.some((entry) => entry.className === 'ss-trace-overview-grip'), 'grips stay usable in all mode')
const fitChip = classed.find((entry) => entry.className === 'ss-trace-chip' && 'data-fit' in entry.props)
assert.ok(fitChip, 'the info row names the state instead of a span')

// A ring no longer than the narrowest window: a full bar that cannot move —
// there is nothing to zoom into, so no grips.
classed.length = 0
runtime.traceView.set({ spanMs: 60_000, endAt: null })
runtime.getView = () => ({
  snapshot: { traceChart: { ...chart, coverage: { from: now - 40_000, to: now } } },
  error: null,
})
render(main.render(mainProps))
const lockedBar = classed.find((entry) => entry.className === 'ss-trace-overview')
assert.ok(lockedBar, 'the bar is always there, even when it cannot move')
assert.equal(lockedBar.props['data-static'], '', 'a bar over a tiny ring is marked static')
block = classed.find((entry) => entry.className === 'ss-trace-overview-block')
assert.equal(block.props.style.left, '0.000%')
assert.equal(block.props.style.width, '100.000%')
assert.ok(!classed.some((entry) => entry.className === 'ss-trace-overview-grip'), 'no grips on a bar with nothing to zoom into')

// No ring measured yet: the same full, static track instead of a missing bar.
classed.length = 0
runtime.getView = () => ({ snapshot: { traceChart: youngChart }, error: null })
render(main.render(mainProps))
assert.ok(classed.some((entry) => entry.className === 'ss-trace-overview'), 'the track exists before any ring is measured')

// ── a missing second is a hole where it happened, not a squeeze ────────────
// The Host sends `times`; the chart must place each point at its own time. With
// the uniform grid the third point would land at 50% instead of 75% — the hole
// would silently move every point after it to the left.
{
  const gapFrom = now - 60_000
  const gapChart = {
    t0: gapFrom,
    dt: 1000,
    // +0 s, +15 s, +45 s: the samples in between never arrived.
    times: [gapFrom, gapFrom + 15_000, gapFrom + 45_000],
    cpu: [0.2, 0.3, 0.4],
    memory: [1e8, 1e8, 1e8],
    io: [0, 0, 0],
    coverage: { from: gapFrom, to: gapFrom + 45_000 },
    members: chart.members,
  }
  paths.length = 0
  runtime.getView = () => ({ snapshot: { traceChart: gapChart }, error: null })
  runtime.traceView.set({ spanMs: 60_000, endAt: gapFrom + 60_000 })
  render(main.render(mainProps))
  const cpuPath = paths.find((entry) => entry.context === 'ss-trace-svg')?.d
  assert.ok(cpuPath, 'the cpu chart drew a path')
  assert.ok(cpuPath.startsWith('M0.00'), `the first point sits at the window start, got ${cpuPath}`)
  assert.ok(cpuPath.includes('L25.00'), `+15 s is a quarter in, got ${cpuPath}`)
  assert.ok(cpuPath.includes('L75.00'), `+45 s is three quarters in (a uniform 1 s grid would put it at 3%), got ${cpuPath}`)
}

// ── the member rail: group header, folded children, exited block ───────────
{
  classed.length = 0
  runtime.getView = () => ({ snapshot: { traceChart: chart }, error: null })
  runtime.traceView.set({ spanMs: 60_000, endAt: null })
  runtime.traceFocus.group()
  runtime.traceRail.resetDisclosure()
  runtime.traceRail.setCollapsed(false)
  render(main.render(mainProps))

  const header = classed.find((entry) => entry.className === 'ss-trace-row ss-trace-row-group')
  assert.ok(header, 'the rail leads with the group header')
  assert.ok(!classed.some((entry) => entry.className.includes('ss-trace-row-child')),
    'children stay folded on arrival — an 88-member group must not eat the page')
  // The header counts the members that are *running*: the number used to grow
  // for eight hours on a recording whose app kept restarting helpers.
  const countBadge = classed.find((entry) => entry.className === 'ss-trace-row-count')
  assert.equal(countBadge?.children?.[0], '(2)', 'the group header counts live members, not ghosts')

  // Opening the group is the disclosure's job, not the focus's.
  runtime.traceRail.toggleOpen()
  classed.length = 0
  render(main.render(mainProps))
  const children = classed.filter((entry) => entry.className.includes('ss-trace-row-child')
    && !entry.className.includes('exited'))
  assert.equal(children.length, 2, 'both live members are listed under the header')

  // Exited members get their own folded block with the exit time, not a child row.
  const exitedSection = classed.find((entry) => entry.className === 'ss-trace-exited')
  assert.ok(exitedSection, 'the exited block is there when somebody left')
  runtime.traceRail.toggleExited()
  classed.length = 0
  render(main.render(mainProps))
  const exitedRow = classed.find((entry) => entry.className.includes('ss-trace-row-exited'))
  assert.ok(exitedRow, 'the departed member is listed in that block')

  // Clicking a member only moves the lens: the detail table replaces the charts.
  runtime.traceFocus.process(2)
  classed.length = 0
  chartCalls.length = 0
  render(main.render(mainProps))
  assert.ok(classed.some((entry) => entry.className === 'ss-trace-detail'), 'the detail table opens')
  assert.equal(chartCalls.length, 0, 'and the curves give way to it')
  const focused = classed.find((entry) => entry.className.includes('ss-trace-row-child')
    && entry.props['data-focus'] === '')
  assert.ok(focused, 'the rail marks which row is focused')
  assert.ok(String(focused.props.title).includes('PID 2'), 'and it is the one that was clicked')
  // The way back is a stable hook, not the visible label: the panel's own locale
  // table renders the real text here, so a label would be a moving target.
  const back = classed.find((entry) => entry.className.includes('ss-trace-detail-back'))
  assert.ok(back, 'the detail offers a way back to the chart')
  back.props.onClick({})
  classed.length = 0
  chartCalls.length = 0
  render(main.render(mainProps))
  assert.equal(runtime.traceFocus.getSnapshot().kind, 'group', 'back returns to the group view')
  assert.equal(chartCalls.length, 3, 'and the curves are back')

  // Folding the rail: the tab is the way back, so there is never a dead end.
  runtime.traceRail.setCollapsed(true)
  classed.length = 0
  render(main.render(mainProps))
  assert.ok(classed.some((entry) => entry.className === 'ss-trace-rail-tab'), 'the folded rail is a clickable tab')
  assert.ok(!classed.some((entry) => entry.className === 'ss-trace-divider'), 'and has no divider to drag')
  runtime.traceRail.setCollapsed(false)

  // Width: the narrow floor is the store's job.
  runtime.traceRail.setWidth(10)
  assert.equal(runtime.traceRail.getSnapshot().width, 140, 'a drag cannot go below the narrowest rail')
  runtime.traceRail.setWidth(300)
  assert.equal(runtime.traceRail.getSnapshot().width, 300)
  runtime.traceRail.reset()
  assert.equal(runtime.traceRail.getSnapshot().width, 240, 'double-click restores the default box')
  runtime.traceRail.resetDisclosure()
}

// The recording badge reads the same status.
const overlay = registrations.find((entry) => entry.owner === 'shell.overlay')
render(overlay.render({ runtime }))
status.recording = true
status.mode = 'recording'
render(overlay.render({ runtime }))

// ── the poll loop ─────────────────────────────────────────────────────────
// The harness above renders once and never runs an effect, which is exactly why
// a hung request once pinned `inFlight` forever without any test noticing. This
// block boots a second instance against a fake `document` and `fetch` so the
// loop itself is exercised: one request at once, an abort signal on every
// request, an error surfaced and recovered from, and teardown that really stops
// the timer.
{
  const seen = []
  let failNext = false
  const fakeDocument = {
    visibilityState: 'visible',
    listeners: new Set(),
    addEventListener(type, handler) { if (type === 'visibilitychange') this.listeners.add(handler) },
    removeEventListener(type, handler) { this.listeners.delete(handler) },
  }
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  globalThis.document = fakeDocument
  globalThis.fetch = (url, init = {}) => {
    seen.push({ url, init })
    if (failNext) {
      failNext = false
      return Promise.reject(new Error('host went away'))
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({
        at: Date.now(),
        seq: 1,
        values: {},
        sections: {},
        unchanged: {},
        truncated: false,
        groups: [],
        sources: [],
        degraded: [],
      }),
    })
  }

  const paneDisposers = []
  const paneCtx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') paneDisposers.push(dispose)
      return () => {}
    },
    slots: ctx.slots,
    locale: ctx.locale,
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: 'system-sniffer' }),
        subscribe: () => () => {},
      },
      selectPanel() {},
    },
  }
  const pane = captured.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })
  pane.apply(paneCtx)

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const sampleCalls = () => seen.filter((entry) => entry.url === '/api/system-sniffer/samples')

  await wait(60)
  const first = sampleCalls()[0]
  assert.ok(first, 'an open panel asks for samples without waiting for a tick')
  assert.ok(first.init.signal instanceof AbortSignal, 'every request carries an abort signal (the timeout)')
  const body = JSON.parse(first.init.body)
  assert.ok(Array.isArray(body.include) && body.include.length > 0, 'the first request names the sections it wants')
  assert.equal(typeof body.client, 'string')

  // A failed request must surface an error and keep the loop alive.
  failNext = true
  const paneRegistration = registrations.filter((entry) => entry.owner === 'main').at(-1)
  const paneRuntime = paneRegistration.options.inject().runtime
  paneRuntime.retry()
  await wait(60)
  assert.ok(paneRuntime.getView().error, 'a failed request is reported to the page')
  const beforeRecovery = sampleCalls().length
  await wait(1200)
  assert.ok(sampleCalls().length > beforeRecovery, 'the loop retries by itself after an error')
  assert.equal(paneRuntime.getView().error, null, 'a later success clears the error')

  // Teardown: the disposer is the only thing that stops the timer.
  for (const dispose of paneDisposers) {
    try { dispose() } catch {}
  }
  const afterTeardown = sampleCalls().length
  await wait(1200)
  assert.equal(sampleCalls().length, afterTeardown, 'a disposed runtime stops asking')
  assert.equal(fakeDocument.listeners.size, 0, 'the visibility listener is removed on dispose')

  globalThis.document = previousDocument
  globalThis.fetch = previousFetch
}

for (const disposer of disposers) {
  try { disposer() } catch {}
}
console.log('test-client-boot: all checks passed')
// The fake React/`window` globals this file installs are not worth un-picking;
// a direct run ends here, and `run.mjs` — which imports the file — exits itself.
if (process.argv[1]?.endsWith('test-client-boot.mjs')) process.exit(0)

