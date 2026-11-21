/**
 * Counter groups as data, not code.
 *
 * Splitting or adding a group is an edit to this table (or to the plugin's
 * `config.groups`), never a change to the collector. Each group owns its own
 * typeperf process, so one group's counters being missing cannot take the
 * others down with it.
 */

/** @typedef {{ id: string, counters: string[], intervalMs: number, required?: boolean }} GroupSpec */

/** @type {GroupSpec[]} */
export const DEFAULT_GROUPS = [
  {
    id: 'core',
    intervalMs: 1000,
    required: true,
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
    intervalMs: 1000,
    counters: [
      '\\GPU Engine(*)\\Utilization Percentage',
      '\\GPU Adapter Memory(*)\\Dedicated Usage',
    ],
  },
  {
    id: 'disk',
    // Task Manager's 磁盘 card is disk *activity* (throughput / busy time), not
    // volume capacity: capacity lives on the disk tab. The instance name is
    // `0 C: D:` on a physical disk, which doubles as the display label.
    intervalMs: 1000,
    counters: [
      '\\PhysicalDisk(*)\\Disk Read Bytes/sec',
      '\\PhysicalDisk(*)\\Disk Write Bytes/sec',
      '\\PhysicalDisk(*)\\% Idle Time',
    ],
  },
  {
    id: 'proc',
    // Two seconds, not five: the first row only carries gauges (pid, working
    // set), so the real CPU column needs a second sample. At 5 s the process
    // table stayed empty for over ten seconds after the panel opened.
    intervalMs: 2000,
    counters: [
      '\\Process(*)\\ID Process',
      '\\Process(*)\\% Processor Time',
      '\\Process(*)\\Working Set',
    ],
  },
]

/**
 * A counter path, as `typeperf` takes it.
 *
 * Config-supplied groups are the only untrusted input on this path: typeperf
 * reads every argument as either a counter or a switch, so a value starting
 * with `-` (`-o out.csv`, `-sc 1`) would change what the child does instead of
 * naming a counter. A real counter path always starts with a single `\`.
 */
export function isCounterPath(value) {
  return typeof value === 'string'
    && value.startsWith('\\')
    && !value.startsWith('-')
    && !/[\r\n]/.test(value)
}

/**
 * Merge the shipped table with a config override.
 * A config entry with the same `id` replaces that group; `enabled: false`
 * drops it. Unknown ids are appended, which is how a future group lands
 * without touching the default table. Invalid counter paths are dropped here,
 * so a malformed config leaves a working group rather than a typeperf child
 * that exits on a switch it did not expect.
 */
export function resolveGroups(override) {
  if (!Array.isArray(override) || override.length === 0) return DEFAULT_GROUPS
  const byId = new Map(DEFAULT_GROUPS.map((group) => [group.id, group]))
  for (const entry of override) {
    if (!entry || typeof entry.id !== 'string') continue
    if (entry.enabled === false) {
      byId.delete(entry.id)
      continue
    }
    const base = byId.get(entry.id) ?? { id: entry.id, intervalMs: 1000, counters: [] }
    const counters = (Array.isArray(entry.counters) && entry.counters.length > 0 ? entry.counters : base.counters)
      .map((counter) => (typeof counter === 'string' ? counter.trim() : counter))
      .filter(isCounterPath)
    byId.set(entry.id, {
      ...base,
      ...entry,
      intervalMs: Number(entry.intervalMs ?? base.intervalMs) || base.intervalMs,
      counters,
    })
  }
  return [...byId.values()].filter((group) => Array.isArray(group.counters) && group.counters.length > 0)
}
