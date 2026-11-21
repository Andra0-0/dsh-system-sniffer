/**
 * System sniffer — Host half.
 *
 * One collection layer feeding two faces: the panel's windowed read and the
 * model's tool. Sampling belongs to the Host now — sections are written by the
 * samplers at their own cadence, a read only copies what is already in memory,
 * and a client's lease decides how long a finite-lived section keeps sampling
 * after the panel closes.
 *
 * Why the read owns a window instead of a single value: a page that was away
 * for a minute must come back to a continuous chart, and the only place that
 * can remember the minute is here. `historyMs: 0` sections still answer with
 * their newest value, so a table costs no window at all.
 */
import { Collector } from './lib/collector.js'
import { createDiskScan } from './lib/diskscan.js'
import { NativeCollector } from './lib/native-collector.js'
import { createTool } from './lib/tool.js'
import { groupsFor, resolveSections } from './lib/sections.js'
import { Store } from './lib/store.js'
import { TraceStore } from './lib/trace.js'

export const name = 'system-sniffer'
// `connection` provides the exact Fetch route registry; `tools` the tool table.
export const inject = ['tools', 'connection']

/** A closed tab cannot send `detach`; its lease expires on its own. */
const CLIENT_TTL_MS = 120_000
const SWEEP_MS = 30_000
/** How long a preview survives after the last window stops asking for it. */
const PREVIEW_TTL_MS = 5000
/** How long a tool call waits for a cold section before reporting what it has. */
const TOOL_WAIT_MS = 2500

export async function apply(ctx, config) {
  const resolved = resolveSections(config?.sections)
  // Two switches restore the v2 path, one per source: `procCollector` for the
  // process list, `pdhSource` for the three PDH groups. They are separate because
  // they fail for unrelated reasons (koffi vs `pdh.dll`), and a machine without
  // GPU counters should not lose the other two groups.
  const useTypeperfForProcesses = config?.procCollector === 'typeperf'
  const useTypeperfForPdh = config?.pdhSource === 'typeperf'
  const sections = resolved.map((section) => {
    if (section.source !== 'child') return section
    const backToTypeperf = section.id === 'processes' ? useTypeperfForProcesses : useTypeperfForPdh
    if (!backToTypeperf) return section
    // Back to the v2 shape: a `group` and a typeperf child of its own. `processes`
    // also goes back to staying up, because a typeperf group costs nothing while
    // it runs (the native child costs 23 MB private).
    return {
      ...section,
      source: 'pdh',
      group: section.group ?? section.fallbackGroup,
      lifeMs: section.id === 'processes' ? Number.POSITIVE_INFINITY : section.lifeMs,
    }
  })
  const processSection = sections.find((section) => section.id === 'processes') ?? null
  /** Sections the native child samples directly: the process list and the PDH groups. */
  const nativeSectionIds = new Set(
    sections.filter((section) => section.source === 'child').map((section) => section.id),
  )
  /** PDH group → sections the child feeds; also the index for per-group fallback. */
  const byNativeGroup = new Map()
  const store = new Store(sections)
  /**
   * The trace outlives the panel, so it owns a lease of its own on `processes`.
   * A preview keeps that lease only while somebody watches it — the viewer TTL
   * below drops the whole thing after 5 s of silence — while a recording keeps
   * it until the user stops.
   */
  const trace = new TraceStore({ store })
  ctx.effect(() => () => trace.dispose(), 'system-sniffer: trace')

  /**
   * Disk scan: a job, not a section. One at a time, started from the panel,
   * published while it runs. `policy` is the ceiling for the model face —
   * `off` unless the profile's config already says otherwise.
   */
  const diskScan = createDiskScan({ policy: config?.diskTool })
  ctx.effect(() => () => diskScan.dispose(), 'system-sniffer: diskscan')

  /**
   * Typeperf group → sections it feeds. A `child` section is listed here too: if
   * the child cannot serve it, its group id is exactly what `typeperf` runs, and
   * the rows must land on the same section. One section, two possible sources,
   * never both at once — that is what `fallenBack` decides.
   */
  const byGroup = new Map()
  for (const section of sections) {
    const group = section.group ?? section.fallbackGroup
    if (!group) continue
    if (section.source === 'child' && section.group) {
      const list = byNativeGroup.get(section.group) ?? []
      list.push(section)
      byNativeGroup.set(section.group, list)
    }
    const list = byGroup.get(group) ?? []
    list.push(section)
    byGroup.set(group, list)
  }
  /** Sections whose native source failed; `typeperf` serves them until restart. */
  const fallenBack = new Set()
  /** Native PDH groups that arrived but map to no section — a table bug, surfaced. */
  const unmappedGroups = new Set()
  /** When the native child first reported `streaming`; 0 while it is not. */
  let nativeHealthySince = 0

  /** Sections a native PDH group feeds, read from the table rather than from a Map. */
  const sectionsOfGroup = (group) => sections.filter((section) => section.source === 'child' && section.group === group)

  /** One group row feeds every section that names it. */
  const collector = new Collector(ctx, {
    groups: config?.groups,
    idleStopMs: config?.idleStopMs,
    keepWarm: config?.keepWarm,
    onGroup(groupId, sample) {
      for (const section of byGroup.get(groupId) ?? []) {
        // A section the child is serving must not also be written by typeperf:
        // two samplers on one section would double its `seq` and mix two clocks.
        if (section.source === 'child' && !fallenBack.has(section.id)) continue
        if (typeof section.extract !== 'function') continue
        try {
          store.write(section.id, section.extract(sample), sample.atMs)
        } catch (error) {
          store.setState(section.id, 'failed', String(error?.message ?? error))
        }
      }
    },
  })
  ctx.effect(() => () => collector.dispose(), 'system-sniffer: collector')

  // Sections without a PDH group own a timer; the same lease transitions start
  // and stop it, so `volumes` costs nothing while nobody looks at it.
  const readers = new Map()
  for (const section of sections) {
    if (section.group || typeof section.read !== 'function') continue
    let timer = null
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        store.write(section.id, await section.read(), Date.now())
      } catch (error) {
        store.setState(section.id, 'failed', String(error?.message ?? error))
      } finally {
        busy = false
      }
    }
    readers.set(section.id, {
      start() {
        if (timer !== null) return
        void tick()
        timer = setInterval(() => { void tick() }, section.intervalMs)
      },
      stop() {
        clearInterval(timer)
        timer = null
      },
    })
  }

  // Sections whose sampler should be running. A finite-lived section leaves
  // this set when its lease runs out; an `Infinity` one never leaves, which is
  // what "性能段常驻" means in practice.
  const running = new Set()
  let activeGroups = new Set()
  // Created below, once `sync` exists: the collector's state transitions feed
  // back into `sync`, and the native fallback path hands sections to `typeperf`.
  let native = null

  const sync = () => {
    // A section on a native source does not ask for a typeperf child; the ones
    // in `fallenBack` do, and they ask for exactly the group they normally use.
    const wanted = new Set(groupsFor(sections, [...running], { fallback: fallenBack }))
    for (const id of wanted) {
      if (activeGroups.has(id)) continue
      activeGroups.add(id)
      collector.retainGroups([id])
    }
    for (const id of [...activeGroups]) {
      if (wanted.has(id)) continue
      activeGroups.delete(id)
      collector.releaseGroups([id])
    }
    for (const [id, reader] of readers) {
      if (running.has(id)) reader.start()
      else reader.stop()
    }
    if (native) {
      // The process list's loop follows its section's lease, not the child's
      // lifetime. One child serves the process list and the PDH groups, and the
      // PDH groups never retire, so without this the child kept enumerating every
      // second for the life of the Host and `processes`' 30 s life was a number
      // in a table. A section on `typeperf` fallback already stops by itself.
      native.setWatch({ processes: running.has('processes') && !fallenBack.has('processes') })
      // One child serves both the process list and the PDH groups, so it runs
      // while any of them is being watched and none of them has fallen back.
      const needNative = [...running].some((id) => nativeSectionIds.has(id) && !fallenBack.has(id))
      if (needNative) native.start()
      else if (native.state === 'streaming' || native.state === 'starting') void native.stop()
    }
  }

  const wake = (ids) => {
    for (const id of ids) {
      if (!store.spec(id)) continue
      running.add(id)
      // `failed` is a diagnosis, not a state to overwrite: waking a section must
      // not hide why it failed (`degraded` only reports `failed`).
      if ((store.getState(id)?.seq ?? 0) === 0 && store.getState(id)?.state !== 'failed') {
        store.setState(id, 'starting')
      }
    }
    sync()
  }

  /**
   * The trace samples from the process snapshots, and it survives the panel, so
   * it holds a `processes` lease of its own. Preview and recording both need it;
   * a frozen trace does not, and releasing it is what lets the process section
   * retire 30 s later.
   */
  const syncTraceLease = () => {
    if (!trace.sampling) {
      store.detach('trace')
      return
    }
    const before = new Set(store.leased())
    store.attach('trace', ['processes'])
    if (!before.has('processes')) wake(['processes'])
  }

  // A preview nobody watches is dropped: that is the whole difference between
  // "I picked a group and looked" and "I am recording it".
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (trace.sweepPreview(PREVIEW_TTL_MS)) syncTraceLease()
    }, 1000)
    return () => clearInterval(timer)
  }, 'system-sniffer: trace preview ttl')

  /**
   * The native child cannot serve these sections: hand each to its typeperf
   * group so the page keeps updating, and let `sources` say why the numbers look
   * different. Sticky on purpose — flapping between two sources would make the
   * chart jump between two clocks.
   */
  const fallBack = (ids, reason) => {
    const changed = []
    for (const id of ids) {
      if (!store.spec(id) || fallenBack.has(id)) continue
      fallenBack.add(id)
      changed.push(id)
      // `starting`, not `failed`: a replacement source is on its way.
      store.setState(id, 'starting', `native-unavailable: ${reason ?? 'unknown'}`)
    }
    if (changed.length > 0) sync()
  }

  const fallBackGroup = (group, reason) => {
    fallBack(sectionsOfGroup(group).map((section) => section.id), reason)
  }

  if (nativeSectionIds.size > 0) {
    const pdhSection = sections.find((section) => section.source === 'child' && section.group) ?? null
    native = new NativeCollector({
      intervalMs: Number(processSection?.intervalMs) || 1000,
      pdhIntervalMs: Number(pdhSection?.intervalMs) || 1000,
      // `typeperf` owns PDH in that mode; the child then only does the process
      // list, and there is no point paying for a query nobody reads.
      pdh: !useTypeperfForPdh,
    })
    native.on('snapshot', (snapshot) => {
      if (fallenBack.has('processes')) return
      const at = Date.parse(snapshot.at) || Date.now()
      store.write('processes', { sampledAt: snapshot.at, items: snapshot.items }, at)
    })
    // PDH rows: route each group to the sections that read it. This is the whole
    // point of keeping the CSV shape — `extract*` runs unchanged.
    native.on('pdh', (sample) => {
      for (const group of sample.groups) {
        const targets = byNativeGroup.get(group.id) ?? []
        // An arriving group with no section is a bug in the table, not a quiet
        // machine; surface it in `sources` instead of dropping the rows.
        if (targets.length === 0) unmappedGroups.add(group.id)
        for (const section of targets) {
          if (fallenBack.has(section.id) || typeof section.extract !== 'function') continue
          try {
            store.write(section.id, section.extract(group), group.atMs)
          } catch (error) {
            store.setState(section.id, 'failed', String(error?.message ?? error))
          }
        }
      }
    })
    // Per-group availability is known before the first sample, so a machine
    // without GPU counters hands only `gpu` back to typeperf, immediately.
    native.on('pdh-status', (status) => {
      if (status?.state === 'unavailable') {
        fallBack([...byNativeGroup.values()].flat().map((section) => section.id), status.reason ?? 'pdh-unavailable')
        return
      }
      for (const group of Array.isArray(status?.groups) ? status.groups : []) {
        if (group.state !== 'unavailable') continue
        fallBackGroup(group.id, group.reason ?? 'no counters')
      }
    })
    native.on('state', ({ state, reason }) => {
      if (state === 'streaming') {
        // When the child first proves healthy; the watchdog below counts its
        // grace period from here, not from `start()`, so a slow cold start does
        // not look like a silent group.
        if (nativeHealthySince === 0) nativeHealthySince = Date.now()
      } else if (state === 'stopped' || state === 'unavailable' || state === 'crashed') {
        nativeHealthySince = 0
      }
      if (state === 'streaming' || state === 'stopped') return
      if (state === 'starting') {
        for (const id of nativeSectionIds) {
          if ((store.getState(id)?.seq ?? 0) === 0) store.setState(id, 'starting')
        }
        return
      }
      if (state === 'unavailable') {
        fallBack([...nativeSectionIds], reason)
        return
      }
      // crashed / stalled: the manager is already restarting, say why meanwhile.
      for (const id of nativeSectionIds) {
        if (!fallenBack.has(id)) store.setState(id, 'starting', reason ?? state)
      }
    })
    // The child gave up on PDH itself (a collect that keeps failing). Its
    // process list may still be healthy, so only the PDH sections fall back.
    native.on('child-error', (message) => {
      if (!String(message?.code ?? '').startsWith('pdh')) return
      fallBack([...byNativeGroup.values()].flat().map((section) => section.id), message.message)
    })
    ctx.effect(() => () => { void native.stop() }, 'system-sniffer: native collector')

    // A group whose counters add fine but whose rows never arrive looks exactly
    // like an idle machine: `hello` says ok, `problems` is empty, and the section
    // stays blank forever — first-paint on the disk card would say "waiting" for
    // the life of the process. Nothing upstream can tell that apart from "no
    // activity", so the only place to notice is here, on the store: after a grace
    // period a native-backed section with no fresh sample is handed to `typeperf`.
    const NATIVE_GRACE_MS = 6000
    const NATIVE_STALE_INTERVALS = 5
    const watchdog = setInterval(() => {
      if (!native || native.state !== 'streaming') return
      if (nativeHealthySince === 0 || Date.now() - nativeHealthySince < NATIVE_GRACE_MS) return
      const now = Date.now()
      // Read the table, not the Map: the Map is only a projection of it, and a
      // wrong projection must not be able to disable the rescue path too.
      for (const section of sections) {
        if (section.source !== 'child' || !section.group) continue
        if (fallenBack.has(section.id) || !running.has(section.id)) continue
        const state = store.getState(section.id)
        const interval = Number(section.intervalMs) || 1000
        const silent = (state?.seq ?? 0) === 0 || now - (state?.at ?? 0) > interval * NATIVE_STALE_INTERVALS
        if (silent) fallBackGroup(section.group, 'native-no-rows')
      }
    }, 3000)
    ctx.effect(() => () => clearInterval(watchdog), 'system-sniffer: native watchdog')
  }

  // A finite-lived section retired: stop its sampler. Its state is already
  // `idle`, which the panel shows as "quiet", not as a failure.
  store.setLifeEndHandler((ids) => {
    for (const id of ids) running.delete(id)
    sync()
  })
  ctx.effect(() => {
    const timer = setInterval(() => store.sweep(CLIENT_TTL_MS), SWEEP_MS)
    return () => {
      clearInterval(timer)
      store.dispose()
    }
  }, 'system-sniffer: lease sweep')

  // ── payloads ─────────────────────────────────────────────────────────────

  /**
   * Sections that cannot produce a value say why. `starting` and `idle` are
   * policies, not failures, so they never reach the footer.
   */
  const degraded = () => {
    const groups = new Map(collector.groups.map((entry) => [entry.id, entry]))
    const nativeGroups = new Map(
      (native?.current().pdhStatus?.groups ?? []).map((entry) => [entry.id, entry]),
    )
    const list = []
    for (const section of sections) {
      const group = section.group ? groups.get(section.group) : null
      if (group && group.state === 'unavailable') {
        list.push({ field: section.id, reason: 'failed', detail: group.reason ?? null })
        continue
      }
      // Still on the child, but the child says this group has no counters here
      // (a VM without GPU objects). The fallback may not have fired yet.
      const nativeGroup = section.source === 'child' && section.group ? nativeGroups.get(section.group) : null
      if (nativeGroup?.state === 'unavailable' && !fallenBack.has(section.id)) {
        list.push({ field: section.id, reason: 'native-unavailable', detail: nativeGroup.reason ?? null })
        continue
      }
      const state = store.getState(section.id)
      if (state?.state === 'failed') list.push({ field: section.id, reason: state.reason ?? 'failed' })
    }
    return list
  }

  /**
   * Where each section's numbers come from. `groups` only ever describes
   * `typeperf` children, so the native side needs its own entry: the process list
   * one, and one for the PDH groups (per-group, because a machine can keep
   * core/disk native and send only `gpu` to typeperf).
   */
  const sources = () => {
    if (!native) return []
    const state = native.current()
    const list = [{
      id: 'processes',
      kind: fallenBack.has('processes') ? 'pdh' : 'child',
      state: fallenBack.has('processes') ? 'fallback' : state.state,
      intervalMs: Number(processSection?.intervalMs) || 1000,
      lastAt: state.at,
      restarts: state.restarts,
      reason: fallenBack.has('processes') ? (store.getState('processes')?.reason ?? null) : state.reason,
    }]
    if (byNativeGroup.size > 0) {
      const ids = [...byNativeGroup.values()].flat().map((section) => section.id)
      const allFallenBack = ids.length > 0 && ids.every((id) => fallenBack.has(id))
      const pdhInterval = [...byNativeGroup.values()].flat()[0]?.intervalMs ?? 1000
      // `state.state` is what decides: a stopped child must not look streaming
      // just because the last rows are still in memory.
      const pdhState = allFallenBack
        ? 'fallback'
        : (state.state === 'streaming' ? (state.pdh ? 'streaming' : 'starting') : state.state)
      list.push({
        id: 'pdh',
        kind: allFallenBack ? 'pdh' : 'child',
        state: pdhState,
        intervalMs: Number(pdhInterval) || 1000,
        lastAt: state.pdh?.at ?? null,
        receivedAt: state.pdh?.receivedAt ?? null,
        restarts: state.restarts,
        // Live per-group availability from `hello` …
        groups: state.pdhStatus?.groups ?? [],
        // … and how many rows the last sample actually carried per group. A group
        // that is `ok` here but absent from `rows` is the silent case: counters
        // added, no values — the reason the watchdog below exists.
        rows: Object.fromEntries((state.pdh?.groups ?? []).map((group) => [group.id, group.entries.length])),
        // Groups that arrived but feed no section (a table/projection bug).
        unmapped: [...unmappedGroups],
        fallenBack: [...fallenBack],
        problems: state.pdh?.problems ?? [],
      })
    }
    return list
  }

  /** The tool's contract, unchanged: current values only, never a window. */
  const current = () => {
    const values = store.currentAll()
    return {
      intervalMs: 1000,
      groups: collector.groups,
      sources: sources(),
      degraded: degraded(),
      cpu: values.cpu ?? null,
      memory: values.memory ?? null,
      network: values.network ?? null,
      gpu: values.gpu ?? null,
      processes: values.processes ?? null,
      volumes: values.volumes ?? null,
      // Not a section: the disk scan is a job, and this is its policy-filtered
      // summary. `off` answers with a reason instead of omitting the field.
      diskScan: diskScan.toolView(),
    }
  }

  /**
   * Persist the disk policy in the profile's config, best effort.
   *
   * The plugin ships no `Config` schema, so the editor cannot promise to keep a
   * volatile field live: an `edit` restarts the plugin for an ordinary field.
   * The panel therefore treats `persisted: false` as "this session only" and
   * says so, rather than pretending the choice will survive.
   */
  const persistDiskPolicy = async (level) => {
    try {
      const entry = ctx.fiber?.entry
      const editor = ctx.get?.('configEditor')
      if (!entry || !editor) return false
      await editor.edit(entry, (currentConfig) => ({ ...currentConfig, diskTool: level }))
      return true
    } catch {
      return false
    }
  }

  /**
  /**
   * A tool call is a reader too: it wakes what it needs, waits briefly for a
   * first sample, then lets the lease go. Otherwise a cold panel would answer
   * the model with nulls it cannot distinguish from "the machine is idle".
   *
   * Every call takes a lease of its own. One shared `tool` key meant two
   * concurrent calls overwrote each other's attach, and the first call to
   * finish detached the second one's lease; `finally` is what keeps a thrown
   * error from holding a lease until the 120 s TTL expires.
   */
  let toolLeases = 0
  const readForTool = async (args, exec) => {
    const lease = `tool-${++toolLeases}`
    const requested = Array.isArray(args?.include) && args.include.length > 0
      ? args.include.filter((id) => store.spec(id))
      : sections.map((section) => section.id)
    const ids = requested.length > 0 ? requested : sections.map((section) => section.id)
    store.attach(lease, ids)
    wake(ids)
    // Wait until every section has a *fresh* value, or has proved it cannot
    // produce one. A section whose collector retired (processes after 30 s)
    // still has an old value in the store; answering the model with that is
    // worse than waiting a beat for a new sample.
    const settled = (id) => {
      const state = store.getState(id)
      const spec = store.spec(id)
      const interval = Number(spec?.intervalMs) || 1000
      const fresh = (state?.seq ?? 0) > 0 && Date.now() - (state?.at ?? 0) <= interval * 3
      if (fresh) return true
      const group = spec?.group ? collector.groups.find((entry) => entry.id === spec.group) : null
      if (group) return group.state === 'unavailable'
      return state?.state === 'failed'
    }
    try {
      const deadline = Date.now() + TOOL_WAIT_MS
      while (Date.now() < deadline) {
        // A cancelled call must not keep sampling for the rest of the window.
        if (exec?.signal?.aborted) break
        if (ids.every(settled)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return current()
    } finally {
      store.detach(lease)
    }
  }

  // ── routes ───────────────────────────────────────────────────────────────

  /**
   * Trace control — the one place the state machine moves.
   *
   * `preview` is what picking a group does: sample now, keep nothing once the
   * last window stops reading. `start` is the user's promise to keep it. `stop`
   * freezes the ring, `clear` throws ring and target away, and `status` is what
   * the badge and the header poll. One trace per Host: every window sees the
   * same one, so these actions are global by construction.
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/system-sniffer/trace',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = null
      try {
        body = await request.json()
      } catch {
        body = null
      }
      try {
        const action = typeof body?.action === 'string' ? body.action : 'status'
        const kind = body?.kind === 'process' ? 'process' : 'group'
        const appId = typeof body?.appId === 'string' ? body.appId : ''
        const pid = Number.isInteger(body?.pid) ? body.pid : null
        const label = typeof body?.label === 'string' ? body.label : ''
        if (action === 'preview' || action === 'start') {
          // A target is an appId or a pid; the process list may not have it yet
          // (its section retires after 30 s), and a trace that starts on a
          // momentarily missing row is not an error — it simply records nulls.
          const target = kind === 'process' ? pid !== null : appId.length > 0
          if (!target) {
            return Response.json({
              error: { code: 'sniffer/trace-target-missing', message: 'a trace needs an appId or a pid' },
            }, { status: 200 })
          }
        }
        let status
        if (action === 'preview') {
          status = trace.preview({ appId, pid, kind, label: label || appId })
        } else if (action === 'start') {
          status = trace.start({ appId, pid, kind, label: label || appId })
        } else if (action === 'stop') {
          status = trace.stop('user')
        } else if (action === 'clear') {
          if (trace.recording) {
            return Response.json({
              error: {
                code: 'sniffer/trace-recording',
                message: 'a recording has to be stopped before it can be cleared',
              },
            }, { status: 200 })
          }
          status = trace.clear()
        } else {
          status = trace.status()
        }
        syncTraceLease()
        return Response.json({ trace: status })
      } catch (error) {
        return Response.json({
          error: { code: 'sniffer/trace-failed', message: String(error?.message ?? error) },
        }, { status: 200 })
      }
    },
  }), 'system-sniffer: trace route')

  /**
   * The panel's read. The selector lives in the body rather than the query
   * string: this registry matches exact paths, and whether it ignores a query
   * string is not something this plugin can verify from here.
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/system-sniffer/samples',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = null
      try {
        body = await request.json()
      } catch {
        body = null
      }
      const clientId = typeof body?.client === 'string' && body.client.length > 0 ? body.client : 'anonymous'
      try {
        // `trace` is not a section: it has one target and its own cursor. Strip
        // it before the section bookkeeping so `attach` cannot drop the lease
        // because it does not know the id.
        const include = Array.isArray(body?.include) ? body.include : undefined
        const wantsTrace = include ? include.includes('trace') : false
        const sectionInclude = include ? include.filter((id) => id !== 'trace') : undefined
        if (include) {
          const before = new Set(store.leased())
          store.attach(clientId, sectionInclude)
          wake(sectionInclude.filter((id) => !before.has(id)))
        } else {
          store.touch(clientId)
        }
        const read = store.read({ include: sectionInclude, since: body?.since })
        // `groups` is diagnostic, not data: the process tab reads the proc
        // group's startup state from it, and the footer lists what failed.
        const payload = {
          at: read.at,
          seq: read.seq,
          values: read.values,
          sections: read.sections,
          unchanged: read.unchanged,
          truncated: read.truncated,
          groups: collector.groups,
          sources: sources(),
          degraded: degraded(),
        }
        if (wantsTrace) {
          // Asking for trace data is what "a window is looking at it" means; the
          // preview TTL is measured from here, not from the browser's clock.
          trace.touchViewer()
          payload.trace = trace.read(body?.since?.trace)
          payload.seq.trace = trace.seq
        }
        return Response.json(payload)
      } catch (error) {
        return Response.json(
          { error: { code: 'sniffer/read-failed', message: String(error?.message ?? error) } },
          { status: 200 },
        )
      }
    },
  }), 'system-sniffer: samples route')

  /**
   * A zoomed or panned chart asks for a window instead of a tail.
   *
   * The answer keeps the payload bounded without ever inventing a hole: a window
   * that holds no more samples than a chart can draw comes back as the samples
   * themselves (real `times`), and only a wider one is bucketed min/max, at no
   * less than two sampling intervals per bucket. See `PITFALLS.md` §32 — a
   * bucket as wide as one sample turns a dense ring into five segments.
   *
   * `{spanMs}` alone means "follow the tail, this wide"; `{from, to}` pins the
   * window, which is what panning into the past sends.
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/system-sniffer/trace/range',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = null
      try {
        body = await request.json()
      } catch {
        body = null
      }
      try {
        trace.touchViewer()
        return Response.json(trace.range({
          from: Number.isFinite(body?.from) ? body.from : undefined,
          to: Number.isFinite(body?.to) ? body.to : undefined,
          spanMs: Number.isFinite(body?.spanMs) ? body.spanMs : undefined,
          buckets: Number.isFinite(body?.buckets) ? body.buckets : undefined,
        }))
      } catch (error) {
        return Response.json(
          { error: { code: 'sniffer/trace-range-failed', message: String(error?.message ?? error) } },
          { status: 200 },
        )
      }
    },
  }), 'system-sniffer: trace range route')

  // Icons are fetched per key, not per sample: PNG bytes do not belong in a 2 s
  // payload, and a slow icon must never delay a table render.
  if (native) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/system-sniffer/icons',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null
        try {
          body = await request.json()
        } catch {
          body = null
        }
        try {
          const pngs = await native.requestIcons(body?.keys ?? [])
          return Response.json({ pngs })
        } catch (error) {
          return Response.json({ pngs: {}, error: String(error?.message ?? error) })
        }
      },
    }), 'system-sniffer: icons route')
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/system-sniffer/snapshot',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return Response.json(await readForTool())
      } catch (error) {
        return Response.json(
          { error: { code: 'sniffer/read-failed', message: String(error?.message ?? error) } },
          { status: 200 },
        )
      }
    },
  }), 'system-sniffer: snapshot route')

  /**
   * Disk scan — one route with an action, because a scan is a job: start,
   * status, level, cancel, plus the policy switch that decides what the model
   * may see. Its own path so it can never be mistaken for a section read.
   */
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/system-sniffer/diskscan',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = null
      try {
        body = await request.json()
      } catch {
        body = null
      }
      const action = typeof body?.action === 'string' ? body.action : 'status'
      try {
        if (action === 'start') return Response.json(diskScan.start(body?.root))
        if (action === 'level') return Response.json(await diskScan.level(body?.id))
        if (action === 'cancel') return Response.json(diskScan.cancel())
        if (action === 'policy') {
          const result = diskScan.setPolicy(body?.level)
          if (result.error) return Response.json(result)
          const persisted = await persistDiskPolicy(result.level)
          return Response.json({ ...result, persisted })
        }
        return Response.json(diskScan.status())
      } catch (error) {
        return Response.json({
          error: { code: 'sniffer/diskscan-failed', message: String(error?.message ?? error) },
        }, { status: 200 })
      }
    },
  }), 'system-sniffer: diskscan route')

  ctx.tools.register(createTool(readForTool, sections.map((section) => section.id)))

  // Opening the panel is the common case. Before P1.6 this had to pre-start
  // three `typeperf` children because each paid ~1.4 s of PDH start-up; now it
  // just starts the native child, whose first PDH row lands ~0.3 s after spawn.
  // `processes` is deliberately left alone: the child costs 23 MB private and
  // starts in 129 ms, so it follows the lease instead. `volumes` likewise: its
  // 5 s `statfs` sweep is the one steady cost worth not paying while nobody looks.
  if (config?.warm !== false) {
    wake(['cpu', 'memory', 'network', 'gpu'].filter((id) => store.spec(id)))
  }
}
