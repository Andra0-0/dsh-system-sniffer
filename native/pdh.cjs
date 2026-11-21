'use strict'

/**
 * PDH, sampled in-process instead of through `typeperf`.
 *
 * Why this exists (`docs/ARCHITECTURE.md` §4.2, migration P1.6): a `typeperf`
 * child pays ~1.4 s of PDH start-up before its first row, prints CSV that has to
 * be decoded (console code page!), re-prints its header whenever the instance
 * set churns, and takes `-si` only in whole seconds. Calling PDH directly
 * removes that whole layer: one query, one collect per tick, values already
 * formatted, and `PdhAddEnglishCounterW` makes the counter names independent of
 * the system language (requirement R18).
 *
 * What it deliberately keeps: the *row shape*. `sample()` returns
 * `{ at, atMs, groups: [{ id, at, atMs, entries }], problems }`, and every
 * group's `entries` is the same `[{ object, instance, counter, value }]` list the
 * CSV fold layer produced, so `extractCpu` / `extractMemory` / `extractNetwork`
 * / `extractGpu` / `extractDiskIo` are reused untouched — the migration changes
 * where a row comes from, not what a row means. One query holds all three groups
 * because `PdhCollectQueryData` collects everything it holds at once; grouping is
 * only about which extractor reads what.
 *
 * Two PDH details this has to get right, both measured in
 * `.data/tasks/261117_SystemSnifferPDH搬原生/`:
 *
 * 1. A wildcard counter (`\Object(*)`) must be read with
 *    `PdhGetFormattedCounterArrayW`; `PdhGetFormattedCounterValue` returns
 *    `PDH_INVALID_DATA` for it. The array form wants a NULL buffer to report the
 *    required size, but koffi refuses `null` for a `void *` parameter
 *    ("Cannot pass ambiguous value"), so capacity is pre-allocated and grown on
 *    `PDH_MORE_DATA`. That reported size is in **bytes and includes the
 *    instance-name strings** (334 GPU engines ≈ 52 KB, not 334 × 24), so growth
 *    is computed from the size, in whole items.
 * 2. The instance list is re-read on every collect: PDH re-enumerates a wildcard
 *    counter's instances on each `PdhCollectQueryData` (measured — `\Process(*)`
 *    goes 23 → 24 → 23 as a process starts and stops). `typeperf` freezes the
 *    list because it expands `(*)` into concrete paths at start-up, and GPU
 *    Engine instances belong to *processes*, so a frozen list silently
 *    undercounts every app started after the query opened.
 *
 * The first sample of a rate counter has no baseline; PDH says so itself
 * (`CStatus = PDH_CSTATUS_INVALID_DATA`), so any status other than
 * `VALID_DATA` / `NEW_DATA` becomes `null` here — the same "gap, not a fake
 * zero" the CSV layer produced for row 1, without needing its counter-name
 * table.
 *
 * Counter lists live here rather than in `lib/groups.js` because this file is
 * CommonJS (the child cannot import the Host's ESM). `test-native-pdh.mjs` pins
 * the two tables together so they cannot drift.
 */

/** `PDH_FMT_DOUBLE`; typeperf formats with the same flag, which keeps a comparison honest. */
const DOUBLE = 0x00000200
/** `PDH_CSTATUS_VALID_DATA` / `PDH_CSTATUS_NEW_DATA`: the only two that carry a number. */
const VALID_DATA = 0x00000000
const NEW_DATA = 0x00000001
/**
 * `PDH_CSTATUS_INVALID_DATA`: the counter has no usable sample in this collect.
 * On the first collect that is every rate counter (no baseline yet), which is
 * the warm-up the CSV layer handled by dropping row 1 by counter name. PDH
 * tells us directly, so no name table is needed — but it is *not* a problem and
 * must not be reported as one.
 */
const INVALID_DATA = 0xc0000bba
/** `PDH_MORE_DATA`: the buffer was too small; PDH filled in the size it needs. */
const MORE_DATA = 0x800007d2
/** One growth per attempt is enough for a stable instance set; three covers a burst. */
const MAX_ATTEMPTS = 3
/** First allocation for a wildcard counter, in items; grown on demand. */
const INITIAL_ITEMS = 64

/** @typedef {{ id: string, counters: string[] }} PdhGroup */

/**
 * The three PDH groups that stay on PDH now that `processes` reads the native
 * process list. Instances: processors and physical disks are fixed hardware,
 * network adapters change rarely, GPU engines change constantly (see above).
 * @type {PdhGroup[]}
 */
const GROUPS = [
  {
    id: 'core',
    counters: [
      '\\Processor Information(_Total)\\% Processor Time',
      '\\Processor Information(*)\\% Processor Time',
      '\\Memory\\Committed Bytes',
      '\\Memory\\Commit Limit',
      '\\Memory\\Available Bytes',
      '\\Network Interface(*)\\Bytes Received/sec',
      '\\Network Interface(*)\\Bytes Sent/sec',
    ],
  },
  {
    id: 'gpu',
    counters: [
      '\\GPU Engine(*)\\Utilization Percentage',
      '\\GPU Adapter Memory(*)\\Dedicated Usage',
    ],
  },
  {
    id: 'disk',
    counters: [
      '\\PhysicalDisk(*)\\Disk Read Bytes/sec',
      '\\PhysicalDisk(*)\\Disk Write Bytes/sec',
      '\\PhysicalDisk(*)\\% Idle Time',
    ],
  },
]

/**
 * `\Object(instance)\Counter` or `\Object\Counter` → parts.
 *
 * Mirrors `parseCounterPath` in `lib/csv.js` (drift is pinned by a test). It is
 * duplicated rather than imported because the child is CommonJS and that module
 * is ESM; a `require(esm)` would tie this to a Node version Electron does not
 * necessarily ship.
 */
function parseCounterPath(raw) {
  const body = String(raw).replace(/^\\\\[^\\]+\\/, '').replace(/^\\/, '')
  const withInstance = /^(.+?)\((.*)\)\\(.+)$/.exec(body)
  if (withInstance) {
    return { object: withInstance[1], instance: withInstance[2], counter: withInstance[3] }
  }
  const cut = body.indexOf('\\')
  if (cut < 0) return { object: body, instance: null, counter: '' }
  return { object: body.slice(0, cut), instance: null, counter: body.slice(cut + 1) }
}

/** Status codes are unsigned; print them the way a native debugger does. */
function hex(status) {
  return `0x${(status >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * The koffi side of the world, loaded once per process.
 *
 * `koffi.struct` registers a type by name, so a second query in the same process
 * would collide with the first; one memo keeps that from happening. Requiring
 * koffi here (not at module load) also means `require('./pdh.cjs')` works on a
 * machine where the binary is missing, which is what the fallback path needs:
 * the failure has to be a *value*, not an import-time crash.
 */
let library = null

function loadLibrary() {
  if (library) return library
  let koffi
  try {
    koffi = require('koffi')
  } catch (error) {
    throw new Error(`koffi is not loadable (${String(error?.message ?? error)}); see docs/PITFALLS.md §7`)
  }
  let pdh
  try {
    pdh = koffi.load('pdh.dll')
  } catch (error) {
    throw new Error(`pdh.dll is not loadable (${String(error?.message ?? error)})`)
  }
  // Layer for `PDH_FMT_COUNTERVALUE`: `CStatus` then a union whose first member
  // is the double we ask for. koffi aligns the double to 8, which is the layout
  // the C header has on x64 — the probe confirms `sizeof` 16 / 24.
  const VALUE = koffi.struct('PDH_FMT_COUNTERVALUE', { CStatus: 'uint32', doubleValue: 'double' })
  const ITEM = koffi.struct('PDH_FMT_COUNTERVALUE_ITEM_W', { szName: 'str16', FmtValue: VALUE })
  library = {
    koffi,
    VALUE,
    ITEM,
    /** Size of one array item, so a byte budget can be turned into a count. */
    stride: koffi.sizeof(ITEM),
    openQuery: pdh.func('long PdhOpenQueryW(str16, size_t, _Out_ void **)'),
    addCounter: pdh.func('long PdhAddEnglishCounterW(void *, str16, size_t, _Out_ void **)'),
    collect: pdh.func('long PdhCollectQueryData(void *)'),
    // Every pointer parameter is typed, and no `void *` ever receives `null`:
    // koffi rejects that as ambiguous. Out structs are handed over as
    // `koffi.alloc` memory and read back with `koffi.decode`, because koffi
    // passes struct *values* by copy and `_Out_` does not change that
    // (docs/PITFALLS.md §3).
    formattedValue: pdh.func(
      'long PdhGetFormattedCounterValue(void *, uint32, _Out_ uint32 *, PDH_FMT_COUNTERVALUE *)',
    ),
    formattedArray: pdh.func(
      'long PdhGetFormattedCounterArrayW(void *, uint32, _Inout_ uint32 *, _Inout_ uint32 *, PDH_FMT_COUNTERVALUE_ITEM_W *)',
    ),
    closeQuery: pdh.func('long PdhCloseQuery(void *)'),
  }
  return library
}

/** Accept either the shipped table or a `resolveGroups`-shaped override. */
function normalizeGroups(groups) {
  const list = Array.isArray(groups) && groups.length > 0 ? groups : GROUPS
  const out = []
  for (const group of list) {
    if (!group || typeof group.id !== 'string') continue
    const counters = (Array.isArray(group.counters) ? group.counters : [])
      .filter((path) => typeof path === 'string' && path.length > 0)
    if (counters.length === 0) continue
    out.push({ id: group.id, counters })
  }
  // A table that yields nothing usable is a typo, not an instruction to sample
  // nothing: fall back to the shipped counters, the same way `resolveGroups`
  // treats an unusable override.
  if (out.length === 0 && list !== GROUPS) return normalizeGroups(GROUPS)
  return out
}

/**
 * Create one query holding every counter of every group.
 *
 * One query rather than one per group: `PdhCollectQueryData` is the unit of cost
 * (~0.3 ms here) and it collects everything the query holds, so three queries
 * would pay three times for the same tick. Failure isolation does not need
 * separate queries — a counter that cannot be added is recorded per counter, and
 * a group left with no counters is reported as `unavailable` so the Host can
 * fall back to `typeperf` for that group alone.
 *
 * @param {{ groups?: PdhGroup[] }} [options]
 */
function createPdh(options = {}) {
  const specs = normalizeGroups(options.groups)

  /** @type {{ group: string, path: string, object: string, instance: string|null, counter: string, wildcard: boolean, handle: unknown, reason?: string }[]} */
  const counters = []
  for (const spec of specs) {
    for (const path of spec.counters) {
      const parts = parseCounterPath(path)
      counters.push({
        group: spec.id,
        path,
        object: parts.object,
        // `instance` stays as written (`*` or null); a wildcard's real instance
        // comes from PDH on every collect, an instance-less counter has none.
        instance: parts.instance,
        counter: parts.counter,
        wildcard: parts.instance === '*',
        handle: null,
      })
    }
  }

  let query = null
  let valueBuffer = null
  let typeBuffer = null
  /** Samples taken so far; the baseline tick is excluded from "no rows" reports. */
  let samples = 0
  /** Array buffer + its capacity in items; grown on `PDH_MORE_DATA`. */
  let arrayBuffer = { pointer: null, items: 0 }

  function open() {
    if (query !== null) return
    const lib = loadLibrary()
    const handle = [null]
    const opened = lib.openQuery(null, 0, handle)
    if (opened !== 0 || !handle[0]) {
      throw new Error(`PdhOpenQueryW failed ${hex(opened)}`)
    }
    query = handle[0]
    valueBuffer = lib.koffi.alloc(lib.VALUE, 1)
    // The optional `lpdwType` out-parameter: allocated and ignored rather than
    // passed as `null`, which koffi would have to guess a type for.
    typeBuffer = lib.koffi.alloc('uint32', 1)
    for (const counter of counters) {
      const out = [null]
      const added = lib.addCounter(query, counter.path, 0, out)
      if (added !== 0 || !out[0]) {
        counter.handle = null
        counter.reason = `PdhAddEnglishCounterW ${hex(added)}`
        continue
      }
      counter.handle = out[0]
      counter.reason = undefined
    }
  }

  /**
   * What `hello` and the footer need: which groups actually got their counters.
   *
   * Opens the query if it is not open yet, because "no handles" and "cannot add
   * counters" are the same state otherwise, and a caller asking for status is
   * asking exactly the question that requires them to be distinguishable.
   */
  function status() {
    open()
    const groups = []
    for (const spec of specs) {
      const own = counters.filter((counter) => counter.group === spec.id)
      const live = own.filter((counter) => counter.handle !== null)
      groups.push({
        id: spec.id,
        counters: own.length,
        live: live.length,
        // A group with no live counter is absent on this machine (no GPU
        // counters before Win10 1709, no such objects on a VM).
        state: live.length === 0 ? 'unavailable' : live.length < own.length ? 'partial' : 'ok',
        reason: live.length === 0 ? (own.find((counter) => counter.reason)?.reason ?? 'no counters') : undefined,
      })
    }
    const live = counters.filter((counter) => counter.handle !== null).length
    return {
      state: live === 0 ? 'unavailable' : 'ok',
      counters: { total: counters.length, live },
      groups,
    }
  }

  function ensureArrayCapacity(items) {
    const lib = loadLibrary()
    if (arrayBuffer.pointer !== null && arrayBuffer.items >= items) return
    const wanted = Math.max(items, INITIAL_ITEMS, arrayBuffer.items)
    arrayBuffer = { pointer: lib.koffi.alloc(lib.ITEM, wanted), items: wanted }
  }

  /** A single (non-wildcard) counter: one value, or `null` when PDH has no number. */
  function readValue(counter) {
    const lib = loadLibrary()
    const read = lib.formattedValue(counter.handle, DOUBLE, typeBuffer, valueBuffer)
    if (read !== 0) return null
    const value = lib.koffi.decode(valueBuffer, lib.VALUE)
    const code = value.CStatus >>> 0
    if (code !== VALID_DATA && code !== NEW_DATA) return null
    return Number.isFinite(value.doubleValue) ? value.doubleValue : null
  }

  /**
   * A wildcard counter: one row per instance PDH currently knows.
   *
   * `rows: null` means the array could not be read at all, which the caller
   * reports as a gap with a reason rather than publishing a silently empty
   * table (an empty instance list and a broken read look identical otherwise).
   */
  function readArray(counter) {
    const lib = loadLibrary()
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const size = [arrayBuffer.items * lib.stride]
      const count = [0]
      const read = lib.formattedArray(counter.handle, DOUBLE, size, count, arrayBuffer.pointer)
      if (read === 0) {
        const rows = []
        for (let index = 0; index < count[0]; index++) {
          const item = lib.koffi.decode(arrayBuffer.pointer, index * lib.stride, lib.ITEM)
          const code = item.FmtValue.CStatus >>> 0
          rows.push({
            instance: item.szName ?? null,
            value: code === VALID_DATA || code === NEW_DATA
              ? (Number.isFinite(item.FmtValue.doubleValue) ? item.FmtValue.doubleValue : null)
              : null,
          })
        }
        return { rows }
      }
      if ((read >>> 0) === INVALID_DATA) {
        // No usable sample for this counter yet (the collect right after open is
        // exactly this for every rate counter). An empty table is the honest
        // answer, not a gap to report.
        return { rows: [] }
      }
      if ((read >>> 0) !== MORE_DATA) {
        return { rows: null, reason: `PdhGetFormattedCounterArrayW ${hex(read)}` }
      }
      // Not enough room: PDH reports the byte size it needs, which covers the
      // instance-name strings as well as the items. Round up in whole items and
      // leave headroom, because more instances can appear between the size
      // report and the next call (GPU engines do exactly that).
      const needed = Math.max(count[0], Math.ceil(size[0] / lib.stride), 1)
      ensureArrayCapacity(needed * 2)
    }
    return { rows: null, reason: `PdhGetFormattedCounterArrayW ${hex(MORE_DATA)} after ${MAX_ATTEMPTS} attempts` }
  }

  /**
   * Collect once and return one row set per group.
   *
   * The timestamp is taken before the collect: it answers "when does this row
   * describe", and the collect itself is sub-millisecond.
   */
  function sample() {
    open()
    const lib = loadLibrary()
    const atMs = Date.now()
    const at = new Date(atMs).toISOString()
    const collected = lib.collect(query)
    if (collected !== 0) throw new Error(`PdhCollectQueryData failed ${hex(collected)}`)

    /** @type {Map<string, object[]>} */
    const rowsByGroup = new Map(specs.map((spec) => [spec.id, []]))
    const problems = []
    for (const counter of counters) {
      if (counter.handle === null) continue
      if (!counter.wildcard) {
        rowsByGroup.get(counter.group).push({
          object: counter.object,
          instance: counter.instance,
          counter: counter.counter,
          value: readValue(counter),
        })
        continue
      }
      const read = readArray(counter)
      if (read.rows === null) {
        // A counter that cannot be read is a gap for this tick, not a reason to
        // drop the whole tick: the other counters are already collected.
        problems.push({ group: counter.group, counter: counter.counter, reason: read.reason })
        continue
      }
      for (const row of read.rows) {
        rowsByGroup.get(counter.group).push({
          object: counter.object,
          instance: row.instance,
          counter: counter.counter,
          value: row.value,
        })
      }
    }

    const groups = []
    for (const spec of specs) {
      const entries = rowsByGroup.get(spec.id) ?? []
      // A group whose counters never landed here is reported by `status()`, not
      // as an empty sample, so the Host cannot mistake it for "idle machine".
      if (entries.length === 0) {
        // The silent case: every counter was added (`handle !== null`) and PDH
        // still had nothing to say. That is invisible to `status()` and looks
        // exactly like an idle machine, so it is reported — once the warm-up tick
        // is out of the way, since the baseline has no rows for rate counters by
        // design (`docs/PITFALLS.md` §18).
        const live = counters.filter((counter) => counter.group === spec.id && counter.handle !== null)
        if (live.length > 0 && samples > 0) {
          problems.push({ group: spec.id, counter: '(group)', reason: 'no rows in this sample' })
        }
        continue
      }
      groups.push({ id: spec.id, at, atMs, entries })
    }
    samples += 1
    return { at, atMs, groups, problems }
  }

  function close() {
    if (query !== null) {
      try {
        library?.closeQuery(query)
      } catch {
        // Already gone; nothing on this side can be recovered from it.
      }
    }
    query = null
    valueBuffer = null
    typeBuffer = null
    arrayBuffer = { pointer: null, items: 0 }
    for (const counter of counters) counter.handle = null
  }

  return {
    /** Marked on first use; `sample()` calls it, `hello` wants it earlier. */
    open,
    status,
    sample,
    close,
    get counters() {
      return counters.map((counter) => ({
        group: counter.group,
        object: counter.object,
        instance: counter.instance,
        counter: counter.counter,
        wildcard: counter.wildcard,
        live: counter.handle !== null,
      }))
    },
  }
}

module.exports = {
  GROUPS,
  createPdh,
  parseCounterPath,
}
