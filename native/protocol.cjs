'use strict'

/**
 * Wire protocol between the Host and the native collector child.
 *
 * The child is a separate process on purpose: a native AV kills only the child,
 * and the Host keeps the last snapshot. Everything here is plain JSON — the
 * payload is small enough (252 processes ≈ 30 KB) that compression would only
 * add a failure mode.
 *
 * Messages are versioned by `PROTOCOL_VERSION`; the Host refuses a child whose
 * `hello` disagrees, because a mixed pair would mis-read fields silently.
 */

const PROTOCOL_VERSION = 3

const MESSAGE = {
  HELLO: 'hello',
  SNAPSHOT: 'snapshot',
  // PDH rows used to arrive as `typeperf` CSV; now they come from the child's own
  // query. A separate message (not a field on `snapshot`) because the two have
  // different cadences and different lifetimes: `pdh` runs while any section is
  // leased, the process list only while the process page is open.
  PDH: 'pdh',
  ICONS: 'icons',
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',
  STOP: 'stop',
  /**
   * Host → child: which of the two loops should run. The process list is the
   * expensive half (a full enumerate every second), and its section owns a 30 s
   * life, so "the panel was closed" has to reach the loop — otherwise the child
   * would keep sampling for the life of the Host just because the PDH groups
   * need the same process.
   */
  WATCH: 'watch',
}

/** Icon requests are bounded so one client cannot ask for the whole disk. */
const MAX_ICON_KEYS = 256

/** Numeric process fields added for the tracer (protocol 3). */
const TRACE_NUMBER_FIELDS = ['privateBytes', 'handleCount', 'threadCount', 'ioReadBytes', 'ioWriteBytes']

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deduplicate, drop non-strings, and bound the list. */
function normalizeKeys(keys) {
  if (!Array.isArray(keys)) return []
  const out = []
  const seen = new Set()
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_ICON_KEYS) break
  }
  return out
}

/** A process row as the Host stores it: no paths, no window titles. */
function isProcessItem(item) {
  if (!isObject(item)) return false
  if (!Number.isInteger(item.pid) || item.pid < 0) return false
  if (typeof item.name !== 'string') return false
  if (typeof item.appId !== 'string' || item.appId.length === 0) return false
  if (typeof item.appName !== 'string' || item.appName.length === 0) return false
  if (typeof item.hasWindow !== 'boolean') return false
  if (item.cpu !== null && (typeof item.cpu !== 'number' || !Number.isFinite(item.cpu))) return false
  if (typeof item.workingSetBytes !== 'number' || !Number.isFinite(item.workingSetBytes)) return false
  if (item.exeKey !== null && typeof item.exeKey !== 'string') return false
  // Optional: the executable's localized FileDescription, which is what the
  // expanded child rows show instead of repeating `chrome` ten times. `null`
  // when the file had no version resource (or the path was unreachable).
  if (item.displayName !== undefined && item.displayName !== null && typeof item.displayName !== 'string') return false
  // Trace fields (protocol 3). Optional so a Host that predates them still reads
  // a newer child, but a present value must be a sane non-negative number: the
  // tracer differences `ioReadBytes` / `ioWriteBytes`, and one NaN would poison
  // an hour-long series.
  for (const key of TRACE_NUMBER_FIELDS) {
    const value = item[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false
  }
  return true
}

/**
 * The Host trusts nothing from a separate process: one malformed row would
 * poison the whole table, so a snapshot with any bad row is rejected whole and
 * the manager treats it as a stalled child.
 */
function isSnapshot(message) {
  if (!isObject(message) || message.type !== MESSAGE.SNAPSHOT) return false
  if (typeof message.at !== 'string' || !Array.isArray(message.items)) return false
  if (!Number.isInteger(message.seq) || message.seq < 0) return false
  for (const item of message.items) if (!isProcessItem(item)) return false
  return true
}

function isHello(message) {
  return isObject(message)
    && message.type === MESSAGE.HELLO
    && message.protocol === PROTOCOL_VERSION
    && typeof message.pid === 'number'
    && typeof message.koffi === 'string'
}

/**
 * One PDH row set, shaped exactly like a CSV row set so the Host's `extract*`
 * functions do not know where a row came from:
 * `{ group: [{ id, at, atMs, entries: [{ object, instance, counter, value }] }] }`.
 *
 * The host trusts nothing from a separate process, and a poisoned row would be
 * read by five extractors at once, so one bad entry rejects the whole message.
 */
function isPdhEntry(entry) {
  if (!isObject(entry)) return false
  if (typeof entry.object !== 'string' || entry.object.length === 0) return false
  if (entry.instance !== null && typeof entry.instance !== 'string') return false
  if (typeof entry.counter !== 'string' || entry.counter.length === 0) return false
  if (entry.value !== null && (typeof entry.value !== 'number' || !Number.isFinite(entry.value))) return false
  return true
}

function isPdhSample(message) {
  if (!isObject(message) || message.type !== MESSAGE.PDH) return false
  if (typeof message.at !== 'string' || !Number.isFinite(message.atMs)) return false
  if (!Array.isArray(message.groups)) return false
  if (message.problems !== undefined && !Array.isArray(message.problems)) return false
  for (const group of message.groups) {
    if (!isObject(group) || typeof group.id !== 'string' || group.id.length === 0) return false
    if (typeof group.at !== 'string' || !Number.isFinite(group.atMs)) return false
    if (!Array.isArray(group.entries)) return false
    for (const entry of group.entries) if (!isPdhEntry(entry)) return false
  }
  return true
}

function isIconReply(message) {
  if (!isObject(message) || message.type !== MESSAGE.ICONS) return false
  if (!isObject(message.pngs)) return false
  for (const [key, value] of Object.entries(message.pngs)) {
    if (typeof key !== 'string' || typeof value !== 'string') return false
  }
  return true
}

module.exports = {
  PROTOCOL_VERSION,
  MESSAGE,
  MAX_ICON_KEYS,
  normalizeKeys,
  isProcessItem,
  isSnapshot,
  isHello,
  isIconReply,
  isPdhEntry,
  isPdhSample,
}
