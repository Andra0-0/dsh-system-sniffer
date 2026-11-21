/**
 * `NativeCollector` state machine, with a fake child process.
 *
 * This is the half of "does the native collector survive?" that does not need
 * Windows to answer: hello → streaming, a malformed snapshot is rejected whole,
 * a silent child is killed, and after `maxRestarts` failures the manager gives
 * up so the Host can fall back to `typeperf`. `options.spawn` is injectable
 * exactly for this (`PITFALLS.md` §8 — a spawned child with piped stdio cannot
 * run inside the tool sandbox, so the process boundary is faked).
 *
 * The real `fork` and the real koffi calls are *not* covered here; that is what
 * `node native/child.cjs --once` and a running Host are for.
 *
 * Run with `node test/test-native-manager.mjs`.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeCollector } from '../lib/native-collector.js'
import protocol from '../native/protocol.cjs'

const { MESSAGE, PROTOCOL_VERSION } = protocol

/**
 * A child-shaped EventEmitter. `kill()` reports an exit on the next turn, the
 * way a real process does, so the manager's restart path runs for real.
 */
function makeChild() {
  const child = new EventEmitter()
  child.sent = []
  child.connected = true
  child.pid = 4242
  child.killed = false
  child.stderr = new EventEmitter()
  child.send = (message) => {
    child.sent.push(message)
    // A well-behaved child exits on request; the manager waits for that.
    if (message?.type === MESSAGE.STOP) setImmediate(() => child.emit('exit', 0, null))
  }
  child.kill = () => {
    if (child.killed) return
    child.killed = true
    setImmediate(() => child.emit('exit', null, 'SIGTERM'))
  }
  return child
}

function makeSpawn() {
  const children = []
  const args = []
  const spawn = (script, argv) => {
    args.push(argv)
    const child = makeChild()
    children.push(child)
    return child
  }
  return { children, args, spawn }
}

const HELLO = {
  type: MESSAGE.HELLO,
  protocol: PROTOCOL_VERSION,
  pid: 4242,
  node: '24.0.0',
  koffi: '3.3.8',
  intervalMs: 250,
  pdhIntervalMs: 250,
  icons: true,
  processes: true,
  pdh: { state: 'ok', counters: { total: 0, live: 0 }, groups: [] },
}

const PROCESS = {
  pid: 1234,
  ppid: 1,
  name: 'notepad',
  displayName: 'Notepad',
  cpu: 0.1,
  workingSetBytes: 1_000_000,
  hasWindow: true,
  appId: '1:1700000000',
  appName: 'Notepad',
  exeKey: 'abc',
}

function snapshotMessage(at, overrides = {}) {
  return {
    type: MESSAGE.SNAPSHOT,
    at,
    seq: 1,
    items: [PROCESS],
    diagnostics: { processes: 1 },
    ...overrides,
  }
}

/** Poll instead of sleeping a fixed time: a slow machine must not fail the test. */
async function until(check, label, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${label}`)
}

function collector(spawn, extra = {}) {
  return new NativeCollector({
    spawn,
    intervalMs: 250,
    pdhIntervalMs: 250,
    startupTimeoutMs: 1000,
    backoffMs: [5, 5, 5],
    maxRestarts: 3,
    ...extra,
  })
}

// ── hello turns `starting` into `streaming`, and the watch goes out ────────
{
  const { children, spawn } = makeSpawn()
  const c = collector(spawn)
  const states = []
  c.on('state', (event) => states.push(event.state))
  c.start()
  assert.equal(c.state, 'starting', 'spawn puts the manager in starting')
  assert.equal(children.length, 1)

  children[0].emit('message', { ...HELLO })
  // With the process list on, `hello` is not proof of life — the first snapshot
  // is. Only a child whose list is off (PDH-only) moves on hello.
  assert.equal(c.state, 'starting', 'hello alone does not leave starting')
  assert.ok(
    children[0].sent.some((message) => message.type === MESSAGE.WATCH && message.processes === true),
    'the loop state is asserted right after hello',
  )

  children[0].emit('message', snapshotMessage(new Date().toISOString()))
  assert.equal(c.state, 'streaming', 'the first snapshot is what ends starting')
  assert.ok(states.includes('streaming'))
  const current = c.current()
  assert.equal(current.seq, 1)
  assert.equal(current.state, 'streaming')
  assert.equal(current.pdhStatus?.state, 'ok', 'hello is kept for the footer')
  await c.stop()
  assert.equal(c.state, 'stopped')
}

// A PDH-only child never sends a snapshot, so there `hello` is the only proof.
{
  const { children, spawn } = makeSpawn()
  const c = collector(spawn, { processes: false })
  c.start()
  assert.ok(children[0], 'spawned')
  children[0].emit('message', { ...HELLO, processes: false })
  assert.equal(c.state, 'streaming', 'a PDH-only child becomes streaming on hello')
  await c.stop()
}

// ── one bad row rejects the whole snapshot and restarts the child ──────────
// A poisoned row would be read by five extractors at once, so the message is
// dropped whole and the child is treated as broken.
{
  const { children, spawn } = makeSpawn()
  const c = collector(spawn)
  c.start()
  children[0].emit('message', { ...HELLO })
  children[0].emit('message', snapshotMessage(new Date().toISOString(), {
    items: [{ pid: 'not-a-number', name: 'x' }],
  }))
  assert.equal(children[0].killed, true, 'a malformed snapshot kills the child')
  await until(() => c.restarts === 1, 'the restart counter')
  await until(() => children.length === 2, 'a replacement child')
  assert.equal(c.state, 'starting', 'and the new child starts from scratch')
  assert.equal(c.current().seq, 0, 'no poisoned row was kept')
  await c.stop()
}

// ── a silent child is killed (the heartbeat is the newest snapshot) ────────
{
  const { children, spawn } = makeSpawn()
  const c = collector(spawn)
  c.start()
  children[0].emit('message', { ...HELLO })
  children[0].emit('message', snapshotMessage(new Date().toISOString()))
  // Threshold is intervalMs * 3 = 750 ms, checked on a 250 ms heartbeat.
  await until(() => children[0].killed, 'the stall kill', 4000)
  await c.stop()
}

// ── after maxRestarts the manager gives up so typeperf can take over ───────
{
  const children = []
  const spawn = () => {
    const child = makeChild()
    children.push(child)
    setImmediate(() => child.emit('exit', 1, null))
    return child
  }
  const c = new NativeCollector({ spawn, intervalMs: 250, backoffMs: [1, 1, 1], maxRestarts: 1 })
  let unavailable = null
  c.on('unavailable', (event) => { unavailable = event })
  c.start()
  await until(() => c.state === 'unavailable', 'the give-up state')
  assert.ok(unavailable, 'and it says why, so the Host can fall back')
  assert.ok(unavailable.restarts > 1)
  assert.equal(children.length, 2, 'maxRestarts 1 means exactly one retry')
}

// ── an exit after `stop()` is not a crash ─────────────────────────────────
// `stop()` detaches the child, waits for the handshake, then kills it; that
// second exit used to look like a crash and restarted the collector the user
// had just stopped (and left a heartbeat running for the life of the process).
{
  const { children, spawn } = makeSpawn()
  const c = collector(spawn)
  c.start()
  children[0].emit('message', { ...HELLO })
  children[0].emit('message', snapshotMessage(new Date().toISOString()))
  await c.stop()
  assert.equal(c.state, 'stopped')
  const before = children.length

  // What the trailing `child.kill()` produces.
  children[0].emit('exit', null, 'SIGTERM')
  await delay(30)
  assert.equal(c.state, 'stopped', 'a late exit must not revive a stopped collector')
  assert.equal(children.length, before, 'and must not spawn a replacement')
  assert.equal(c.restarts, 0, 'nor count itself as a restart')
}

// ── watch while stopped still lands as a spawn argument ────────────────────
// The process page is closed when the PDH groups wake the child, and the child
// must not start enumerating processes it was not asked for.
{
  const { children, args, spawn } = makeSpawn()
  const c = collector(spawn)
  c.start()
  children[0].emit('message', { ...HELLO })
  c.setWatch({ processes: false })
  assert.ok(
    children[0].sent.some((message) => message.type === MESSAGE.WATCH && message.processes === false),
    'the running child hears about it',
  )
  children[0].emit('message', snapshotMessage(new Date().toISOString(), { items: [{ pid: -1 }] }))
  await until(() => children.length === 2, 'the restart after the killed child')
  assert.ok(args[1].includes('--no-processes'), `the replacement child gets the flag, got ${args[1]}`)
  await c.stop()
}

console.log('test-native-manager: 6 groups, ok')
