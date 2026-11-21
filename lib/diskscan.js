/**
 * Disk scan: one job at a time, walked directory by directory, published while
 * it runs.
 *
 * Why a job and not a section: a scan is an event, not a sample. It has a
 * beginning, a progress number and an end, and nothing about it belongs in the
 * 1 s sampling loop. The panel polls `status` and `level`; the model gets a
 * summary only when the user allowed it (`diskTool` policy).
 *
 * Memory is bounded by *directories*, not entries: file sizes are folded into
 * their parent as they are found, and only the directory tree is kept. A level
 * view adds the files of that one directory, read on demand and cached until
 * the directory's bytes change — that is the one place this module does I/O on
 * a read, and it is one `readdir` plus one stat per file of a single folder.
 *
 * Progress is visible on purpose: totals are accumulated into every ancestor as
 * files are found, so the root's number grows while the walk runs, and each
 * top-level subtree is complete (and `done`) as soon as its own walk finishes.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename } from 'node:path'

/** Directory entries are read in chunks so a 20 k-file folder cannot open 20 k handles. */
const STAT_CHUNK = 64
/** A path longer than this is not a scan we can finish; real trees stop far earlier. */
const MAX_DEPTH = 64
/** Children returned by `level`; the rest fold into one「其他」bucket in the client. */
const TOP_N = 120
/** Files of one directory read for the level view; beyond this the level says so. */
const FILE_LIMIT = 5000

export const POLICY_LEVELS = ['off', 'numbers', 'names']

/**
 * @typedef {Object} DirNode
 * @property {string} id
 * @property {string} name
 * @property {number} bytes  files directly inside plus every subtree
 * @property {DirNode[]} children  directories only; files are not nodes
 * @property {DirNode|null} parent
 * @property {boolean} scanned  `readdir` for this node has finished
 * @property {boolean} denied   `readdir` failed (permission, deleted, too long)
 * @property {number} depth
 * @property {number} files   direct file count
 * @property {number} dirs    direct directory count
 */

export function createDiskScan(options = {}) {
  const concurrency = clamp(options.concurrency ?? 8, 1, 32)
  const topN = clamp(options.topN ?? TOP_N, 1, 500)
  const now = options.now ?? Date.now

  /** Policy is the ceiling for what the model may see; 'off' by default. */
  let policy = POLICY_LEVELS.includes(options.policy) ? options.policy : 'off'

  let job = null
  let seq = 0
  const levelCache = new Map()

  function clamp(value, min, max) {
    const number = Number(value)
    if (!Number.isFinite(number)) return min
    return Math.min(max, Math.max(min, Math.round(number)))
  }

  function emptyStatus() {
    return {
      state: 'idle',
      root: null,
      files: 0,
      dirs: 0,
      bytes: 0,
      denied: 0,
      startedAt: null,
      elapsedMs: 0,
      partial: false,
      policy,
    }
  }

  function status() {
    if (!job) return emptyStatus()
    return {
      state: job.state,
      root: job.rootLabel,
      files: job.files,
      dirs: job.dirs,
      bytes: job.bytes,
      denied: job.denied,
      startedAt: new Date(job.startedAt).toISOString(),
      elapsedMs: Math.max(0, now() - job.startedAt),
      partial: job.state === 'scanning',
      policy,
      top: job.state === 'ready' || job.state === 'scanning' ? topDirs(job, 10) : [],
    }
  }

  /** @param {string} root  a drive (`C:`, `D:\`) or any absolute directory */
  function start(root) {
    if (job && job.state === 'scanning') {
      return { error: { code: 'sniffer/diskscan-busy', message: 'a scan is already running' } }
    }
    const parsed = normaliseRoot(root)
    if (!parsed) {
      return { error: { code: 'sniffer/diskscan-root', message: 'a scan needs a drive or an absolute directory' } }
    }

    /** @type {DirNode} */
    const rootNode = {
      id: '0',
      name: parsed.label,
      bytes: 0,
      children: [],
      parent: null,
      scanned: false,
      denied: false,
      depth: 0,
      files: 0,
      dirs: 0,
      pending: 0,
      done: false,
    }

    const id = ++seq
    job = {
      id,
      root: parsed.path,
      rootLabel: parsed.label,
      rootNode,
      nodes: new Map([[rootNode.id, rootNode]]),
      /** Host-side only: id → absolute path. Never crosses the wire. */
      paths: new Map([[rootNode.id, parsed.path]]),
      state: 'scanning',
      files: 0,
      dirs: 0,
      bytes: 0,
      denied: 0,
      startedAt: now(),
      finishedAt: null,
      cancelled: false,
      outstanding: 1,
      queue: [{ node: rootNode, path: parsed.path }],
      wake: [],
    }
    levelCache.clear()

    job.done = run(job).catch((error) => {
      if (job && job.id === id) {
        job.state = 'failed'
        job.error = String(error?.message ?? error)
        job.finishedAt = now()
      }
    })

    return { jobId: id, root: parsed.label, state: 'scanning' }
  }

  function cancel() {
    if (!job) return { state: 'idle' }
    if (job.state === 'scanning') {
      job.cancelled = true
      job.queue.length = 0
      job.state = 'cancelled'
      job.finishedAt = now()
      wakeAll(job)
    }
    return { jobId: job.id, state: job.state }
  }

  function wakeAll(target) {
    const waiters = target.wake.splice(0)
    for (const resolve of waiters) resolve()
  }

  async function run(target) {
    await Promise.all(Array.from({ length: concurrency }, () => drain(target)))
    if (target.cancelled) return
    target.state = 'ready'
    target.finishedAt = now()
    wakeAll(target)
  }

  async function drain(target) {
    for (;;) {
      if (target.cancelled) return
      const task = target.queue.pop()
      if (task) {
        await scanDir(target, task.node, task.path)
        continue
      }
      if (target.outstanding === 0) return
      await new Promise((resolve) => target.wake.push(resolve))
    }
  }

  async function scanDir(target, node, path) {
    let entries = null
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      node.denied = true
      target.denied += 1
    }

    if (entries) {
      const files = []
      for (const entry of entries) {
        // Junctions and symlinks are reported as links, not directories, so a
        // tree that links back to itself cannot trap the walk.
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          const child = {
            id: String(target.nodes.size),
            name: entry.name,
            bytes: 0,
            children: [],
            parent: node,
            scanned: false,
            denied: false,
            depth: node.depth + 1,
            files: 0,
            dirs: 0,
            pending: 0,
            done: false,
          }
          target.nodes.set(child.id, child)
          target.paths.set(child.id, joinPath(path, entry.name))
          node.children.push(child)
          node.dirs += 1
          target.dirs += 1
          if (child.depth <= MAX_DEPTH) {
            node.pending += 1
            target.outstanding += 1
            target.queue.push({ node: child, path: target.paths.get(child.id) })
          } else {
            // Deeper than the cap: counted as a directory, never walked.
            child.scanned = true
            child.done = true
          }
        } else if (entry.isFile()) {
          files.push({ name: entry.name, path: joinPath(path, entry.name) })
        }
      }

      // Sizes come from one stat per file: Windows has no "directory size", so
      // every scanner walks, and this is the walk's bill.
      for (let index = 0; index < files.length; index += STAT_CHUNK) {
        const chunk = files.slice(index, index + STAT_CHUNK)
        const sizes = await Promise.all(chunk.map(async (file) => {
          try {
            return (await stat(file.path)).size
          } catch {
            target.denied += 1
            return 0
          }
        }))
        for (let i = 0; i < sizes.length; i++) {
          const size = sizes[i]
          node.files += 1
          target.files += 1
          addBytes(node, size)
          target.bytes += size
        }
      }
    }

    node.scanned = true
    target.outstanding -= 1
    levelCache.delete(node.id)
    finish(node)
    if (target.outstanding === 0) {
      target.state = target.cancelled ? 'cancelled' : 'ready'
      target.finishedAt = now()
      wakeAll(target)
    } else {
      wakeAll(target)
    }
  }

  /**
   * Done = read, and every child directory done. Walking that up is what lets a
   * level say「统计中」about itself instead of about the whole scan.
   */
  function finish(node) {
    node.done = node.scanned && node.pending === 0
    let cursor = node
    while (cursor.parent) {
      cursor.parent.pending -= 1
      if (cursor.parent.pending === 0 && cursor.parent.scanned) {
        cursor.parent.done = true
        cursor = cursor.parent
      } else {
        break
      }
    }
  }

  /** Files count for every ancestor, so a parent's number moves while the walk runs. */
  function addBytes(node, size) {
    let cursor = node
    while (cursor) {
      cursor.bytes += size
      cursor = cursor.parent
    }
  }

  function joinPath(dir, name) {
    return dir.endsWith('\\') ? dir + name : dir + '\\' + name
  }

  function normaliseRoot(root) {
    if (typeof root !== 'string') return null
    const trimmed = root.trim()
    const drive = /^([A-Za-z]):(\\|\/)?$/.exec(trimmed)
    if (drive) {
      const letter = drive[1].toUpperCase()
      return { path: letter + ':\\', label: letter + ':' }
    }
    if (!/^[A-Za-z]:[\\/]/.test(trimmed)) return null
    const path = trimmed.replace(/\//g, '\\').replace(/\\+$/, '')
    const label = basename(path) || path
    return { path, label }
  }

  function rate(bytes, total) {
    if (!total) return 0
    return Math.round((bytes / total) * 1000) / 1000
  }

  function topDirs(target, limit) {
    const children = [...target.rootNode.children].sort((a, b) => b.bytes - a.bytes)
    return children.slice(0, limit).map((child) => ({
      name: child.name,
      bytes: child.bytes,
      share: rate(child.bytes, target.rootNode.bytes),
    }))
  }

  /**
   * One level of the tree: the directories we already know plus this directory's
   * files, top-N by size with the tail folded into one bucket.
   *
   * The file read is the module's single exception to "reads touch only memory":
   * it is one directory, chunked stats, and the answer is cached until the
   * directory's bytes change.
   */
  async function level(id) {
    if (!job) return { error: { code: 'sniffer/diskscan-idle', message: 'no scan has run' } }
    const key = typeof id === 'string' && id.length > 0 ? id : '0'
    const node = job.nodes.get(key)
    if (!node) return { error: { code: 'sniffer/diskscan-level', message: 'no such level' } }

    const cached = levelCache.get(key)
    if (cached && cached.bytes === node.bytes && cached.scanned === node.scanned) return cached.payload

    const entries = node.children.map((child) => ({
      id: child.id,
      name: child.name,
      bytes: child.bytes,
      dir: true,
      children: child.children.length,
      denied: child.denied,
    }))

    // Files of this directory: the scan folded their bytes in, so they are
    // re-read here only to draw them as rectangles.
    const path = job.paths.get(key)
    let truncatedFiles = 0
    if (path && node.scanned && !node.denied) {
      try {
        const listed = await readdir(path, { withFileTypes: true })
        const allFiles = listed.filter((entry) => entry.isFile())
        const files = allFiles.slice(0, FILE_LIMIT)
        truncatedFiles = Math.max(0, allFiles.length - files.length)
        for (let index = 0; index < files.length; index += STAT_CHUNK) {
          const chunk = files.slice(index, index + STAT_CHUNK)
          const sizes = await Promise.all(chunk.map(async (file) => {
            try {
              return (await stat(joinPath(path, file.name))).size
            } catch {
              return 0
            }
          }))
          for (let i = 0; i < sizes.length; i++) {
            entries.push({ id: null, name: chunk[i].name, bytes: sizes[i], dir: false, children: 0 })
          }
        }
      } catch {
        // A directory that vanished between the scan and the click simply has no
        // file rectangles; the directories above it are still correct.
      }
    }

    entries.sort((a, b) => b.bytes - a.bytes)
    const head = entries.slice(0, topN)
    const tail = entries.slice(topN)
    const payload = {
      id: key,
      name: node.name,
      total: node.bytes,
      partial: !node.done,
      denied: node.denied,
      bytes: node.bytes,
      files: node.files,
      dirs: node.dirs,
      truncatedFiles,
      children: head,
      other: tail.length > 0
        ? { count: tail.length, bytes: tail.reduce((sum, entry) => sum + entry.bytes, 0) }
        : null,
      parent: node.parent ? node.parent.id : null,
      path: pathLabel(job, node),
    }
    levelCache.set(key, { bytes: node.bytes, scanned: node.scanned, payload })
    return payload
  }

  /** Breadcrumb labels: names only, never an absolute path. */
  function pathLabel(target, node) {
    const trail = []
    let cursor = node
    while (cursor) {
      trail.push({ id: cursor.id, name: cursor.name })
      cursor = cursor.parent
    }
    trail.reverse()
    return trail
  }

  // ── model face ─────────────────────────────────────────────────────────────

  function policyState() {
    return { level: policy }
  }

  function setPolicy(next) {
    if (!POLICY_LEVELS.includes(next)) {
      return { error: { code: 'sniffer/diskscan-policy', message: 'policy must be off, numbers or names' } }
    }
    policy = next
    return { level: policy }
  }

  /**
   * What the model may see. `off` still answers, with a reason: a missing field
   * reads as "this machine has no disks", which is a worse lie than "disabled".
   */
  function toolView() {
    if (policy === 'off') {
      return { available: false, reason: 'disk-detail-disabled' }
    }
    if (!job || job.state === 'idle') {
      return { available: false, reason: 'no-scan' }
    }
    const view = {
      available: true,
      root: job.rootLabel,
      bytes: job.rootNode.bytes,
      files: job.files,
      dirs: job.dirs,
      state: job.state,
      partial: job.state === 'scanning',
    }
    if (policy === 'names') {
      view.top = topDirs(job, 10)
      view.note = 'directory names only; no file names, no paths'
    }
    return view
  }

  function dispose() {
    if (job && job.state === 'scanning') {
      job.cancelled = true
      job.state = 'cancelled'
      wakeAll(job)
    }
    job = null
    levelCache.clear()
  }

  return {
    start,
    status,
    level,
    cancel,
    policy: policyState,
    setPolicy,
    toolView,
    dispose,
    get running() {
      return Boolean(job && job.state === 'scanning')
    },
  }
}

