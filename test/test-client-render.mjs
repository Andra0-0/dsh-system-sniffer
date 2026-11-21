/**
 * Render the panel with real React, in jsdom.
 *
 * `test-client-boot.mjs` walks the element tree with a fake React: every
 * component body runs once, but no effect, no state update and no event ever
 * happens. This file is the other half — a real renderer, a real DOM and real
 * clicks — so the paths that only exist after mount (effects, subscriptions,
 * tab switching, cleanup) are covered too.
 *
 * Run with `node test/test-client-render.mjs`.
 */
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom

globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Browser APIs jsdom does not implement but the page calls unconditionally.
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
window.URL.createObjectURL = () => 'blob:icon'
window.URL.revokeObjectURL = () => {}

let captured = null
window.__ModuleLoader__ = {
  load({ id, factory }) { captured = { id, factory } },
}

// The panel asks for data the moment it mounts; answer with an empty snapshot.
const requests = []
globalThis.fetch = (url, init = {}) => {
  requests.push({ url, init })
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

await import(new URL('../client.js?render', import.meta.url).href)
assert.ok(captured, 'client.js must register a module factory')

const registrations = []
const disposers = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  slots: {
    inject(_owner, callback) { callback(); return () => {} },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  layout: {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: 'system-sniffer' }),
      subscribe: () => () => {},
    },
    selectPanel() {},
  },
}

const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
plugin.apply(ctx)

const main = registrations.find((entry) => entry.options?.name === 'main')
assert.ok(main, 'the panel registers into the main slot')
const runtime = main.options.inject().runtime
assert.ok(runtime, 'the main slot receives the runtime')

const container = document.getElementById('root')
const root = createRoot(container)
await act(async () => {
  root.render(React.createElement(main.component, { runtime }))
})

const tabs = () => [...container.querySelectorAll('[role="tab"]')]
assert.equal(tabs().length, 4, 'four tabs render')
assert.equal(runtime.tabs.getSnapshot(), 'processes', 'the page opens on the process tab')
assert.ok(requests.some((entry) => entry.url === '/api/system-sniffer/samples'), 'mounting starts the poll loop')

// Switching tabs is a store write, so the page keeps the choice across unmount.
await act(async () => {
  tabs()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
assert.equal(runtime.tabs.getSnapshot(), 'performance', 'clicking a tab selects it')

await act(async () => {
  tabs()[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
})
assert.equal(runtime.tabs.getSnapshot(), 'disks', 'the disk tab opens too')

// Unmount must stop the loop, or a closed panel would keep asking forever.
await act(async () => { root.unmount() })
for (const dispose of disposers) {
  try { dispose() } catch {}
}
const afterUnmount = requests.length
await new Promise((resolve) => setTimeout(resolve, 1100))
assert.equal(requests.length, afterUnmount, 'an unmounted panel stops polling')

console.log('test-client-render: all checks passed')

