/**
 * 回到追踪页之后，折线不该"翻过来"。
 *
 * 现象（2026-11-21 真机）：预览 60 秒以上 → 切回会话待 5 秒以上（预览被 TTL 清掉、环被丢）
 * → 再回追踪页（页子自己重开预览），折线变成从左往右长：从左边起满宽，而不是像每次新预览
 * 那样贴着右边缘往里走。
 *
 * 原因：视口（缩放 / 平移 / 「全部」）在运行期里活着（这是有意的：切页签不能把你设的缩放
 * 悄悄清掉），但**环被换掉之后它还被继承**。"全部"是说"整个环"，旧环已经没了；一条刚开了
 * 3 个点的新环按「全部」展开，就是满宽 + 从左往右长。
 *
 * 这条测试用真运行期 + 一个假 Host（只实现预览 / 录制 / 停止 / 清空的环状态机），断言
 * 「环换了 → 视口回到跟随」以及「同一个环继续（预览转录制）→ 视口不动」。
 *
 * Run with `node test/test-trace-reentry.mjs`.
 */
import assert from 'node:assert/strict'

let captured = null
globalThis.window = {
  __ModuleLoader__: { load({ factory }) { captured = { factory } } },
}
const seam = {}
globalThis.__DSH_SNIFFER_TEST__ = seam

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

await import(new URL('../client.js?reentry', import.meta.url).href)
assert.ok(captured, 'client.js must register a module factory')

const registrations = []
const ctx = {
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  slots: {
    inject(_owner, callback) { callback(); return () => {} },
    register(options, component) {
      registrations.push({ owner: options?.name ?? null, render: component, options })
      return () => {}
    },
  },
  layout: {
    // Not the active panel: the sample loop stays parked, which is what keeps
    // this test from needing a `/samples` stub (and from arming timers).
    panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} },
    selectPanel() {},
  },
  locale: { register() {}, bind: () => (key) => key },
}

const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
plugin.apply(ctx)
const main = registrations.find((entry) => entry.owner === 'main')
const runtime = main.options.inject().runtime
assert.ok(runtime, 'main panel must receive a runtime')
const view = () => runtime.traceView.getSnapshot()

// ── a fake Host with the same ring lifecycle as `TraceStore` ───────────────
const TARGET = { appId: 'g1', pid: null, kind: 'group', label: 'Group' }
const host = { ringStart: 0, mode: null, target: null }
const sameTarget = (left, right) => !!left && !!right
  && (left.pid ?? null) === (right.pid ?? null) && (left.appId ?? '') === (right.appId ?? '')

/** Each replacement gets a distinct start; all of them are a second old. */
let ringSeq = 0
function newRing() {
  ringSeq += 1
  return Date.now() - 1000 + ringSeq * 5
}

function hostStatus() {
  return {
    mode: host.mode,
    target: host.target,
    recording: host.mode === 'recording',
    startedAt: host.ringStart,
    recordedAt: host.mode === 'recording' ? host.ringStart : 0,
    endedAt: 0,
    endedReason: null,
    elapsedMs: 1000,
    seq: 1,
    points: 1,
    memberCount: 1,
    aggregate: null,
    windowMs: 8 * 3600_000,
    coverage: { from: host.ringStart, to: host.ringStart + 1000 },
  }
}

function hostAction(body) {
  const target = {
    appId: typeof body?.appId === 'string' ? body.appId : '',
    pid: Number.isInteger(body?.pid) ? body.pid : null,
    kind: body?.kind === 'process' ? 'process' : 'group',
    label: typeof body?.label === 'string' ? body.label : '',
  }
  const continues = host.mode === 'preview' && sameTarget(host.target, target)
  if (body?.action === 'preview') {
    // A recording outranks a preview, exactly like `TraceStore.preview`.
    if (host.mode === 'recording') return hostStatus()
    if (!continues) host.ringStart = newRing()
    host.mode = 'preview'
    host.target = target
  } else if (body?.action === 'start') {
    // 预览转录制：环接着用，`startedAt` 不变（`TraceStore.start` 的 keepRing）。
    if (!continues) host.ringStart = newRing()
    host.mode = 'recording'
    host.target = target
  } else if (body?.action === 'stop') {
    host.mode = 'stopped'
  } else if (body?.action === 'clear') {
    host.mode = null
    host.ringStart = 0
    host.target = null
  }
  return hostStatus()
}

const calls = []
globalThis.fetch = async (url, init) => {
  const path = String(url)
  const body = init?.body ? JSON.parse(String(init.body)) : {}
  calls.push({ path, action: body.action ?? null })
  if (!path.endsWith('/api/system-sniffer/trace')) throw new Error(`unexpected fetch ${path}`)
  return { ok: true, json: async () => ({ trace: hostAction(body) }) }
}

const settle = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const { traceBounds, TraceChart } = seam

/** Where a chart would draw this payload in this window, as `x` percent. */
function drawSpan(payload, window) {
  const tree = TraceChart({
    values: payload.cpu,
    max: 1,
    color: '#00f',
    label: 'CPU',
    readout: '',
    t0: payload.t0,
    dt: payload.dt,
    times: payload.times,
    from: window.from,
    to: window.to,
  })
  const d = tree.children.find((child) => child?.type === 'svg')
    .children.find((child) => child?.type === 'path').props.d
  const xs = [...d.matchAll(/[ML]([-\d.]+),/g)].map((match) => Number(match[1]))
  return { min: Math.min(...xs), max: Math.max(...xs), segments: (d.match(/M/g) ?? []).length }
}

/** One dense ring of `count` seconds ending `ageMs` before now. */
function ringPayload(count, ageMs) {
  const to = Date.now() - ageMs
  const times = Array.from({ length: count }, (_, index) => to - (count - 1 - index) * 1000)
  return { t0: times[0], dt: 1000, times, cpu: times.map(() => 0.3) }
}

// ── 1. 用户离开时的那张图：一个 60 秒的环、视口是「全部」 ─────────────────
const oldRing = ringPayload(61, 5000)
const oldCoverage = { from: oldRing.times[0], to: oldRing.times.at(-1) }
const oldSpan = drawSpan(oldRing, traceBounds({ spanMs: null, endAt: null }, oldCoverage, true))
assert.equal(oldSpan.min, 0, 'all mode starts at the ring start')
assert.equal(oldSpan.max, 100, 'and ends at the newest point: one full-width curve')
assert.equal(oldSpan.segments, 1)
// 这就是离开时的视口状态；环本身在 Host 里。
runtime.traceView.set({ spanMs: null, endAt: null })
host.mode = 'preview'
host.ringStart = newRing()
host.target = TARGET
await runtime.selectTraceTarget(TARGET)
await settle()
assert.equal(view().spanMs, null, 'the first ring of a session keeps the viewport it was given')

// ── 2. 离开 5 秒以上：Host 的预览 TTL 把环丢掉；回来时页子自己重开预览 ────
const firstStart = host.ringStart
host.mode = null
host.ringStart = 0
await runtime.selectTraceTarget(TARGET)
await settle()
assert.equal(host.ringStart > 0, true, 'returning re-opened the preview')
assert.notEqual(host.ringStart, firstStart, 'and it is a new ring')
const freshStart = host.ringStart

// ── 3. 换了环，视口不该继承旧环的「全部」 ─────────────────────────────────
assert.deepEqual(view(), { spanMs: 60_000, endAt: null },
  'a replaced ring goes back to following instead of inheriting the old ring\'s "all"')

// 一条刚开 3 个点的新环：跟随模式贴在右边缘（左边是窗口，不是数据）。
const fresh = {
  t0: freshStart + 6000,
  dt: 1000,
  times: [freshStart + 6000, freshStart + 7000, freshStart + 8000],
  cpu: [0.1, 0.2, 0.3],
}
const freshCoverage = { from: fresh.times[0], to: fresh.times.at(-1) }
const followed = traceBounds(view(), freshCoverage, true)
const freshSpan = drawSpan(fresh, followed)
assert.equal(followed.to - followed.from, 60_000, 'the window is still one span wide')
assert.equal(freshSpan.min > 90, true,
  `a fresh ring hugs the right edge, got ${freshSpan.min.toFixed(1)}%`)
assert.equal(freshSpan.max <= 100, true, 'and never draws past the window')

// 同一条新环若按「全部」展开，才会出现用户看到的样子：满宽、从左往右长。
const allSpan = drawSpan(fresh, traceBounds({ spanMs: null, endAt: null }, freshCoverage, true))
assert.equal(allSpan.min, 0, 'all mode on a fresh ring starts at the very left')
assert.equal(allSpan.max, 100, 'and reaches the right edge: the "flipped" curve')

// ── 4. 同一个环继续（预览转录制）：视口不动 ───────────────────────────────
// 缩放是偏好，环没换就不该被清掉——`resetTraceView` 只挂在 `startedAt` 变化上。
const zoomed = { spanMs: 300_000, endAt: freshStart + 8000 }
runtime.traceView.set(zoomed)
await runtime.startTrace()
await settle()
assert.equal(host.mode, 'recording', 'the preview continued into a recording')
assert.equal(host.ringStart, freshStart, 'and the ring is the same one')
assert.deepEqual(view(), zoomed, 'a continued ring keeps the window the user set')

// ── 5. 清空之后再开预览：环又换了一次 ────────────────────────────────────
runtime.traceView.set({ spanMs: null, endAt: null })
await runtime.stopTrace()
await settle()
await runtime.clearTrace()
await settle()
assert.equal(host.ringStart, 0, 'clear drops the ring')
await runtime.selectTraceTarget(TARGET)
await settle()
assert.deepEqual(view(), { spanMs: 60_000, endAt: null }, 'a preview after a clear follows again')

assert.equal(calls.some((call) => call.path === '/api/system-sniffer/samples'), false,
  'the parked loop must not poll the sample route')
delete globalThis.__DSH_SNIFFER_TEST__
console.log('test-trace-reentry: all checks passed')
