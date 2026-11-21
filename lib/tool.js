/**
 * The tool shares the collection layer with the panel: one sampling path, two
 * faces. A hand-written ToolDefinition, because a profile-installed bundle
 * cannot import `@deepseek-ai/dsh-tools`.
 *
 * The model gets current values, never a window: it asks "what is the machine
 * doing", and a 60-second array would only cost tokens. The `include` enum is
 * derived from the section ids, so a new section is callable without touching
 * this file.
 */
export function createTool(read, ids) {
  const sections = Array.isArray(ids) && ids.length > 0
    ? ids
    : ['cpu', 'memory', 'gpu', 'volumes', 'processes', 'network']

  return {
    name: 'system_sniff',
    description:
      'Return current host metrics: CPU, memory, GPU, volume capacity, top processes and network rates. '
      + 'Each section carries its own sampledAt; a section that could not be read is null with a reason in degraded. '
      + '`diskScan` carries a summary of the last disk scan when the user enabled that in settings; '
      + 'when it is disabled it says so instead of hiding.',
    parameters: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          items: { type: 'string', enum: sections },
        },
        top: { type: 'integer', minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const snapshot = await read(args, exec)
      const include = Array.isArray(args?.include) && args.include.length > 0
        ? new Set(args.include)
        : null
      const top = Math.min(30, Math.max(1, Number(args?.top) || 8))

      const trimmed = { intervalMs: snapshot.intervalMs }
      for (const key of sections) {
        trimmed[key] = include === null || include.has(key) ? snapshot[key] ?? null : null
      }
      // The native collector emits the table in pid order; the model wants the
      // busiest rows, which is what `top` has always meant.
      if (trimmed.processes) {
        trimmed.processes.items = [...trimmed.processes.items]
          .sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1)
            || b.workingSetBytes - a.workingSetBytes
            || a.pid - b.pid)
          .slice(0, top)
      }
      trimmed.groups = snapshot.groups
      // The disk scan is a job, not a section, so it is not in `sections`: it is
      // already filtered by the user's policy in index.js. When the policy is
      // `off` it still arrives, carrying the reason, so the model can say why it
      // has no disk numbers instead of inventing them.
      if (snapshot.diskScan !== undefined) trimmed.diskScan = snapshot.diskScan
      // Which source each section is actually on, and why it may be missing: a
      // null above is either "no such counter" or "native group silent", and the
      // model cannot tell those apart without this.
      trimmed.sources = snapshot.sources
      trimmed.degraded = snapshot.degraded
      if (exec?.signal?.aborted) throw new Error('aborted')
      return JSON.stringify(trimmed, null, 2)
    },
  }
}
