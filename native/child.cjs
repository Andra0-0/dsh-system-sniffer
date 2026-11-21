'use strict'

/**
 * Native collector child.
 *
 * Runs as its own process so a fault in the FFI layer (or a future WASAPI call)
 * cannot take the Host down: the Host sees an exit code, restarts, and falls
 * back to `typeperf`. It owns sampling *and* icon encoding, so the Host never
 * waits on a native call on its request path.
 *
 * Two loops, on purpose:
 * - PDH (`pdh.cjs`, 1 s): the performance sections. One query, one collect, rows
 *   in the same shape the CSV layer produced.
 * - process list (`collect.cjs`, 1 s): 252 processes cost 1–3 ms and ~30 KB.
 *
 * Neither loop runs for its own sake: the Host sends `watch` with the set it
 * currently has a lease on. That is what makes the process section's 30 s life
 * real — the child itself stays up for PDH, but a closed process page stops
 * enumerating within one message.
 *
 * Transport: the IPC channel Node gives us with `fork`. Without a parent
 * (`node child.cjs --once`) it prints NDJSON on stdout instead, which is how the
 * probes drive it.
 */

const os = require('node:os')
const { collect } = require('./collect.cjs')
const { createBeat } = require('./beat.cjs')
const { createPdh } = require('./pdh.cjs')
const { iconPng } = require('./icon.cjs')
const { MESSAGE, PROTOCOL_VERSION, normalizeKeys } = require('./protocol.cjs')

const CORES = Math.max(1, os.cpus().length)
const MAX_ICON_CACHE = 512

function parseArgs(argv) {
  const options = { interval: 1000, pdhInterval: 1000, once: false, icons: true, pdh: true, processes: true, verbose: false, maxBeats: 0 }
  for (const arg of argv) {
    if (arg === '--once') options.once = true
    else if (arg === '--no-icons') options.icons = false
    // ~10 s of wall time per line, plus the first beat. Off by default: a loop
    // that runs for the life of the Host does not get to be chatty.
    else if (arg === '--verbose') options.verbose = true
    // `--beats=N` runs N samples and exits: a smoke test that needs no killer
    // and cannot leave an orphan cheeping into a log file.
    else if (arg.startsWith('--beats=')) {
      const value = Number(arg.slice('--beats='.length))
      if (Number.isFinite(value) && value > 0) options.maxBeats = Math.floor(value)
    }
    // `typeperf` path: no native PDH at all, the Host falls back per group.
    else if (arg === '--no-pdh') options.pdh = false
    // Nothing is watching the process page: stay alive for PDH only, and wait for
    // a `watch` message before enumerating anything.
    else if (arg === '--no-processes') options.processes = false
    else if (arg.startsWith('--interval=')) {
      const value = Number(arg.slice('--interval='.length))
      if (Number.isFinite(value) && value > 0) options.interval = Math.max(250, value)
    } else if (arg.startsWith('--pdh-interval=')) {
      const value = Number(arg.slice('--pdh-interval='.length))
      // PDH itself is fine below 1 s, but a rate counter needs a measurable gap
      // between collects; 250 ms is the floor here, same as the CSV path's 1 s
      // was a floor for a different reason (`-si` only takes whole seconds).
      if (Number.isFinite(value) && value > 0) options.pdhInterval = Math.max(250, value)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const connected = typeof process.send === 'function'

function send(message) {
  try {
    if (connected) process.send(message)
    else process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch {
    // The Host is gone; the loop below notices through `disconnect`.
  }
}

/**
 * Debug output goes to stderr, which the Host keeps as a 2 KB tail
 * (`native.stderr`) and dumps when the child dies. Standalone runs
 * (`node native/child.cjs --verbose --no-pdh`) print it straight to the
 * terminal, which is how the cadence gets measured during development.
 */
const verbose = options.verbose || process.env.DSH_SNIFFER_DEBUG === '1'
function log(text) {
  if (!verbose) return
  try {
    process.stderr.write(`[sniffer] ${text}\n`)
  } catch {
    // The Host is gone; the loop notices through `disconnect`.
  }
}

/**
 * What "1 s" actually means: the grid, the wake-up error, and what was lost.
 * One line per ~10 s of wall time plus the very first beat — the first line is
 * what proves the wiring without waiting, and `lateMax` climbing with `beats`
 * is what a drifting schedule looks like.
 */
function logBeat(name, stats) {
  if (!verbose || stats.beats === 0) return
  const every = Math.max(1, Math.round(10_000 / Math.max(1, stats.intervalMs)))
  if (stats.beats !== 1 && stats.beats % every !== 0) return
  log(`${name} beat: interval=${stats.intervalMs} period=${stats.periodMs} late=${stats.lateMs} lateMax=${stats.lateMaxMs} skipped=${stats.skipped} beats=${stats.beats}`)
}

let paths = new Map()
const iconCache = new Map()
let stopped = false
/** Whether the Host still has the process page open; `watch` flips it. */
let wantProcesses = options.processes
/** The PDH sampler, or null when unavailable / disabled / closed after a fault. */
let pdh = null

/**
 * Two loops, two beats. The deadline grid lives in `beat.cjs`: the old
 * `setTimeout(tick, interval)` at the end of each tick added the collection time
 * to the period, so "1 s" was really 1.003 s and the error never stopped
 * growing (see `docs/PITFALLS.md` §27).
 */
const beat = createBeat({
  interval: options.interval,
  onBeat: runTick,
  onSkipped: (missed) => log(`process loop skipped ${missed} beat(s)`),
})
const pdhBeat = createBeat({
  interval: options.pdhInterval,
  onBeat: runPdhTick,
  onSkipped: (missed) => log(`pdh loop skipped ${missed} beat(s)`),
})

/**
 * Turn the process loop on or off. Off stops the beat, so the machine stops
 * paying for an enumerate the moment the page's lease ends; on samples
 * immediately (the caller just opened the page and has nothing to show) and
 * re-anchors the grid, so waking up does not replay the minutes nobody watched.
 */
function setProcesses(next) {
  const want = next !== false
  if (want === wantProcesses) return
  wantProcesses = want
  if (want) {
    runTick()
    beat.reset()
    return
  }
  beat.stop()
}

function runTick() {
  if (stopped || !wantProcesses) return
  try {
    const snapshot = collect({ cores: CORES })
    paths = snapshot.paths
    const stats = beat.stats()
    logBeat('process', stats)
    send({
      type: MESSAGE.SNAPSHOT,
      at: snapshot.at,
      seq: snapshot.seq,
      items: snapshot.items,
      // Additive: a Host that predates `beat` ignores it, and one that wants to
      // know why a 8 h curve looks a few seconds off has the number right here.
      diagnostics: { ...snapshot.diagnostics, beat: stats },
    })
    if (options.maxBeats > 0 && stats.beats >= options.maxBeats) shutdown(0)
  } catch (error) {
    send({ type: MESSAGE.ERROR, code: 'collect-failed', message: String(error?.message ?? error) })
  }
}

/**
 * The PDH half. Its own beat so a slow/failing query cannot delay the process
 * list, and so the Host sees the two cadences separately.
 */
function runPdhTick() {
  if (stopped || pdh === null) return
  try {
    const sample = pdh.sample()
    const stats = pdhBeat.stats()
    logBeat('pdh', stats)
    send({
      type: MESSAGE.PDH,
      at: sample.at,
      atMs: sample.atMs,
      groups: sample.groups,
      problems: sample.problems,
      beat: stats,
    })
  } catch (error) {
    // Repeated failures are the Host's cue to fall back to `typeperf` for these
    // sections; this loop stops rather than spamming one error per second.
    send({ type: MESSAGE.ERROR, code: 'pdh-failed', message: String(error?.message ?? error) })
    stopPdh()
  }
}

function stopPdh() {
  pdhBeat.stop()
  if (pdh) {
    try {
      pdh.close()
    } catch {
      // Already gone.
    }
  }
  pdh = null
}

/** Opened before `hello` so the Host learns per-group availability up front. */
function openPdh() {
  if (!options.pdh) return { state: 'unavailable', reason: 'disabled', groups: [] }
  try {
    pdh = createPdh()
    const status = pdh.status()
    return status
  } catch (error) {
    pdh = null
    return { state: 'unavailable', reason: String(error?.message ?? error), groups: [] }
  }
}

function rememberIcon(key, base64) {
  iconCache.set(key, base64)
  while (iconCache.size > MAX_ICON_CACHE) {
    const oldest = iconCache.keys().next().value
    iconCache.delete(oldest)
  }
}

function handleIcons(message) {
  if (!options.icons) {
    send({ type: MESSAGE.ICONS, id: message.id ?? null, pngs: {}, failed: normalizeKeys(message.keys) })
    return
  }
  const pngs = {}
  const failed = []
  for (const key of normalizeKeys(message.keys)) {
    const cached = iconCache.get(key)
    if (cached) {
      pngs[key] = cached
      continue
    }
    const path = paths.get(key)
    const png = path ? iconPng(path) : null
    if (!png) {
      failed.push(key)
      continue
    }
    const base64 = png.toString('base64')
    rememberIcon(key, base64)
    pngs[key] = base64
  }
  send({ type: MESSAGE.ICONS, id: message.id ?? null, pngs, failed })
}

function shutdown(code = 0) {
  if (stopped) return
  stopped = true
  beat.stop()
  pdhBeat.stop()
  if (pdh) {
    try {
      pdh.close()
    } catch {
      // Process is going away anyway.
    }
    pdh = null
  }
  process.exit(code)
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return
  switch (message.type) {
    case MESSAGE.ICONS:
      handleIcons(message)
      break
    case MESSAGE.PING:
      send({ type: MESSAGE.PONG, nonce: message.nonce ?? null })
      break
    case MESSAGE.WATCH:
      setProcesses(message.processes)
      break
    case MESSAGE.STOP:
      shutdown(0)
      break
    default:
      break
  }
}

if (connected) {
  process.on('message', handleMessage)
  process.on('disconnect', () => shutdown(0))
}

process.on('uncaughtException', (error) => {
  send({ type: MESSAGE.ERROR, code: 'uncaught', message: String(error?.stack ?? error) })
  shutdown(1)
})
process.on('unhandledRejection', (error) => {
  send({ type: MESSAGE.ERROR, code: 'unhandled', message: String(error?.stack ?? error) })
  shutdown(1)
})
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

if (options.once) {
  const snapshot = collect({ cores: CORES })
  const apps = new Map()
  for (const item of snapshot.items) apps.set(item.appId, (apps.get(item.appId) ?? 0) + 1)
  // Availability only: a single collect has no baseline, so every rate counter
  // would read null (docs/PITFALLS.md §18). `--once` is a smoke test, not a sample.
  const pdhOnce = openPdh()
  const summary = {
    at: snapshot.at,
    diagnostics: snapshot.diagnostics,
    pdh: pdhOnce,
    apps: [...apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    sample: snapshot.items.filter((item) => item.hasWindow).slice(0, 8),
    icons: [...snapshot.paths.keys()].length,
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exit(0)
}

const pdhStatus = openPdh()

send({
  type: MESSAGE.HELLO,
  protocol: PROTOCOL_VERSION,
  pid: process.pid,
  node: process.versions.node,
  koffi: require('koffi').version,
  intervalMs: options.interval,
  pdhIntervalMs: options.pdhInterval,
  icons: options.icons,
  // What this child will sample before the Host says otherwise; the Host's first
  // `watch` overrides it, and `--no-processes` means "PDH only".
  processes: wantProcesses,
  // Per-group availability: a machine without GPU counters must be able to keep
  // core/disk native and send only `gpu` back to `typeperf`.
  pdh: pdhStatus,
})

if (wantProcesses) {
  runTick()
  beat.start()
}
if (pdh) {
  // First collect happens now, not one interval from now: PDH fills gauges
  // (committed bytes, dedicated VRAM) on the very first collect, so the memory
  // card has a number at ~0.3 s. Rate counters stay null in this row and get
  // their baseline here, which is what makes the *second* row valid — the same
  // warm-up typeperf produced, minus its ~1.4 s start-up.
  runPdhTick()
  pdhBeat.start()
}
