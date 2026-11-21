'use strict'

/**
 * App grouping: turn a process tree plus "who owns a visible window" into the
 * Task-Manager-shaped answer to "which processes are one application".
 *
 * The rule is deliberately narrow, because every other rule mis-groups real
 * machines:
 *
 *   root = a process with a visible top-level window
 *   attach = the nearest windowed ancestor (self first)
 *   rest = background, grouped by image name
 *
 * Why not "the topmost ancestor": explorer.exe owns windows and is the parent
 * of everything launched from it, so a root-ancestor rule merges half the
 * desktop into Explorer. Checking self first is what keeps a windowed child of
 * Explorer its own app.
 *
 * Why `createTime` in the id: Windows recycles PIDs. `appId` must stay stable
 * for the life of one app and must never merge a dead app with a new one.
 */

const MAX_DEPTH = 64

/** `C:\...\chrome.exe` → `chrome`; `System` stays `System`. */
function baseName(image) {
  if (typeof image !== 'string' || image.length === 0) return 'unknown'
  const leaf = image.split(/[\\/]/).pop() ?? image
  const trimmed = leaf.replace(/\.exe$/i, '')
  return trimmed.length > 0 ? trimmed : leaf
}

/**
 * @param {Array<{pid: number, ppid: number, name: string, createTime: string|number}>} processes
 * @param {Iterable<number>} windowPids
 * @returns {Map<number, {appId: string, appName: string, hasWindow: boolean, rootPid: number|null}>}
 */
function groupApps(processes, windowPids) {
  const byPid = new Map()
  for (const process of processes) byPid.set(process.pid, process)
  const windows = new Set()
  for (const pid of windowPids) windows.add(pid)

  const out = new Map()
  for (const process of processes) {
    const hasWindow = windows.has(process.pid)
    let root = null
    if (hasWindow) {
      root = process
    } else {
      let cursor = byPid.get(process.ppid)
      const seen = new Set([process.pid])
      for (let depth = 0; cursor && depth < MAX_DEPTH; depth += 1) {
        if (seen.has(cursor.pid)) break
        seen.add(cursor.pid)
        if (windows.has(cursor.pid)) {
          root = cursor
          break
        }
        cursor = byPid.get(cursor.ppid)
      }
    }

    const name = baseName(process.name)
    out.set(process.pid, {
      appId: root ? `${root.pid}:${root.createTime}` : `bg:${name}`,
      // Task Manager labels a row with the executable's localized
      // FileDescription; `displayName` is that string when the collector could
      // read it, and the image name otherwise.
      appName: root
        ? (root.displayName ?? baseName(root.name))
        : (process.displayName ?? name),
      hasWindow,
      rootPid: root ? root.pid : null,
    })
  }
  return out
}

module.exports = { groupApps, baseName, MAX_DEPTH }
