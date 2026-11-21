/**
 * Sections: the one table that says what this plugin exposes.
 *
 * A section is the unit of everything below — sampling interval, history depth,
 * lifetime, whether it draws a line, and which extractor turns a PDH group row
 * into a value. The panel's tabs are just named groups of these ids, and
 * `system_sniff` derives its `include` enum from here too, so adding a data
 * source is a row in this table and nothing else.
 *
 * History is opt-in: `historyMs: 0` keeps only the newest value, which is what
 * a table or a card needs. Only sections that draw a sparkline carry a window.
 */
import {
  extractCpu,
  extractDiskIo,
  extractGpu,
  extractMemory,
  extractNetwork,
  extractProcesses,
  readVolumes,
} from './collector.js'

/** Total bytes/sec across interfaces, the number the network chart plots. */
function networkTotal(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  return items.reduce((sum, item) => sum + (item.rxBytesPerSec ?? 0) + (item.txBytesPerSec ?? 0), 0)
}

/**
 * @typedef {Object} SectionSpec
 * @property {string} id
 * @property {string} [group]   PDH group a section reads. For a `child` section
 *   this is the group the native child samples, and the group `typeperf` runs if
 *   that fails — the same id serves both, so a fallback cannot land on a
 *   different counter set.
 * @property {'pdh'|'timer'|'child'} [source] Collector shape; inferred from
 *   `group`/`read` when absent. `child` = the native collector process.
 * @property {string} [fallbackGroup] PDH group used when a `child` section has no
 *   `group` of its own (`processes` → `proc`).
 * @property {Function} [read]  Reader used instead of a PDH group.
 * @property {Function} extract Turns `{ at, entries }` into the value shape.
 * @property {Function} [pick]  Turns the value into the scalar a chart plots.
 * @property {number} intervalMs
 * @property {number} [historyMs]  0 or absent: newest value only.
 * @property {number} [lifeMs]     Infinity: stays up once woken.
 * @property {boolean} [chart]
 */

/** @type {SectionSpec[]} */
export const DEFAULT_SECTIONS = [
  {
    id: 'cpu',
    // P1.6: the native child owns the `core` group (koffi → pdh.dll). `group` is
    // still the id `typeperf` uses if the child turns out unavailable, so the
    // fallback reads exactly the same counters.
    source: 'child',
    group: 'core',
    intervalMs: 1000,
    historyMs: 60_000,
    lifeMs: Number.POSITIVE_INFINITY,
    chart: true,
    extract: extractCpu,
    pick: (value) => value?.usage ?? null,
  },
  {
    id: 'memory',
    source: 'child',
    group: 'core',
    intervalMs: 1000,
    historyMs: 60_000,
    lifeMs: Number.POSITIVE_INFINITY,
    chart: true,
    extract: extractMemory,
    pick: (value) => value?.committedBytes ?? null,
  },
  {
    id: 'network',
    source: 'child',
    group: 'core',
    intervalMs: 1000,
    historyMs: 60_000,
    lifeMs: Number.POSITIVE_INFINITY,
    chart: true,
    extract: extractNetwork,
    pick: networkTotal,
  },
  {
    id: 'gpu',
    source: 'child',
    group: 'gpu',
    intervalMs: 1000,
    historyMs: 60_000,
    lifeMs: Number.POSITIVE_INFINITY,
    chart: true,
    extract: extractGpu,
    pick: (value) => value?.utilization ?? null,
  },
  {
    id: 'diskio',
    source: 'child',
    group: 'disk',
    intervalMs: 1000,
    historyMs: 60_000,
    lifeMs: Number.POSITIVE_INFINITY,
    chart: true,
    extract: extractDiskIo,
    pick: (value) => value?.totalBytesPerSec ?? null,
  },
  {
    id: 'processes',
    // v3: the list comes from the native child (`ARCHITECTURE.md` §4.2). `group`
    // is absent on purpose — PDH freezes `\Process(*)` instances, so it can only
    // ever be the fallback; `fallbackGroup` is what index.js attaches if the
    // child proves unavailable.
    source: 'child',
    fallbackGroup: 'proc',
    // 1 s, same as the panel's poll: a 2 s sample meant every other tick redrew
    // the same numbers, and the CPU column of a busy machine looked stale. One
    // enumerate costs 1–3 ms, so the extra second is cheap; the *lifetime* is
    // where the saving is (below), not the cadence.
    intervalMs: 1000,
    // No sparkline, so no window: the panel sorts and groups the newest row.
    historyMs: 0,
    // 23 MB private + a 129 ms cold start: not worth paying while nobody looks.
    // The child outlives this (the PDH groups need it) but stops enumerating; see
    // `NativeCollector.setWatch`.
    lifeMs: 30_000,
    // Only used by the PDH fallback path.
    extract: extractProcesses,
  },
  {
    id: 'volumes',
    intervalMs: 5000,
    read: readVolumes,
    historyMs: 0,
    // Cheap but never charted: let it retire after a short absence and pay the
    // statfs again next time somebody looks.
    lifeMs: 30_000,
    extract: null,
  },
]

/**
 * Merge the shipped table with a config override, same contract as groups:
 * matching id replaces that section, `enabled: false` drops it, unknown ids are
 * appended. Extractors are not configurable — a section nobody can extract is
 * not a section.
 */
export function resolveSections(override, base = DEFAULT_SECTIONS) {
  if (!Array.isArray(override) || override.length === 0) return base
  const byId = new Map(base.map((section) => [section.id, section]))
  for (const entry of override) {
    if (!entry || typeof entry.id !== 'string') continue
    if (entry.enabled === false) {
      byId.delete(entry.id)
      continue
    }
    const current = byId.get(entry.id)
    if (!current) continue
    byId.set(entry.id, { ...current, ...entry, extract: current.extract, read: current.read })
  }
  return [...byId.values()]
}

/** Sections a tab asks for, as one place to look when a tab is added. */
export const TAB_SECTIONS = {
  performance: ['cpu', 'memory', 'network', 'gpu', 'diskio', 'volumes'],
  // The process tab also reads the four machine-wide sections: its header band
  // shows CPU / memory / disk / network totals (Task Manager's header boxes).
  // They are Infinity-life sections that run anyway, so this costs no sampler.
  processes: ['processes', 'cpu', 'memory', 'network', 'diskio'],
  disks: ['volumes'],
}

/**
 * PDH groups a set of sections needs from `typeperf`.
 *
 * A `child` section is served by the native collector, so it asks for no
 * `typeperf` child at all — unless it is listed in `options.fallback`, which is
 * the caller saying "the native source failed for this section, start the
 * replacement". The group id is the same either way, so the fallback cannot
 * silently read a different counter set.
 *
 * @param {SectionSpec[]} sections
 * @param {string[]} ids
 * @param {{ fallback?: Set<string> }} [options] section ids currently on fallback
 */
export function groupsFor(sections, ids, options = {}) {
  const wanted = new Set(ids)
  const fallback = options.fallback instanceof Set ? options.fallback : null
  const groups = new Set()
  for (const section of sections) {
    if (!wanted.has(section.id)) continue
    if (section.source === 'child' && !(fallback?.has(section.id) ?? false)) continue
    const group = section.group ?? section.fallbackGroup
    if (group) groups.add(group)
  }
  return [...groups]
}
