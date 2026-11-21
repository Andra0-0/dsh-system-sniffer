'use strict'

/**
 * Native process collection.
 *
 * One `NtQuerySystemInformation(SystemProcessInformation)` call returns every
 * process with pid, parent pid, image name, create time, and kernel+user time
 * (~0.6 ms for 38 processes, ~1–3 ms for a full desktop). Nothing here opens a
 * handle per process except for the two things the kernel does not hand out:
 * the image path (for icons and the FileDescription) and the working set is read
 * from the same buffer.
 *
 * Why not PDH: `\Process(*)` freezes its instance table when the query opens,
 * so a `typeperf` list silently becomes a snapshot of the moment the Host
 * started. This path re-enumerates on every call by construction.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const koffi = require('koffi')
const { groupApps } = require('./group.cjs')
const { fileDescription } = require('./version.cjs')

const ntdll = koffi.load('ntdll.dll')
const kernel32 = koffi.load('kernel32.dll')
const user32 = koffi.load('user32.dll')

const NtQuerySystemInformation = ntdll.func(
  'long NtQuerySystemInformation(uint32 cls, _Out_ uint8 *buf, uint32 len, _Out_ uint32 *returned)',
)
const OpenProcess = kernel32.func('void *OpenProcess(uint32 access, bool inherit, uint32 pid)')
const QueryFullProcessImageNameW = kernel32.func(
  'bool QueryFullProcessImageNameW(void *handle, uint32 flags, _Out_ uint16 *buffer, _Inout_ uint32 *size)',
)
const CloseHandle = kernel32.func('bool CloseHandle(void *handle)')

const SystemProcessInformation = 5
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

// Offsets into SYSTEM_PROCESS_INFORMATION (x64). Only fields this plugin needs
// are read; the struct is documented as variable-length and must not be copied.
const OFF = {
  next: 0x00,
  threads: 0x04,
  // `WorkingSetPrivateSize` (since Vista) is the *private* working set — the
  // number Task Manager's 内存 column shows. `WorkingSetSize` (0x90, the total
  // including shared DLL pages) is 2–4× larger on the same process, which is what
  // made this column disagree with Task Manager by a factor of three.
  privateWorkingSet: 0x08,
  createTime: 0x20,
  userTime: 0x28,
  kernelTime: 0x30,
  imageNameLength: 0x38,
  imageNameBuffer: 0x40,
  pid: 0x50,
  ppid: 0x58,
  handles: 0x60,
  workingSet: 0x90,
  // `PagefileUsage` is the process's private commit — the leak metric. The panel
  // keeps showing the private *working set* (Task Manager's 内存 column), but a
  // trace lasts hours and the working set can shrink under memory pressure
  // without anything being released, so the tracer reads this one instead.
  privateBytes: 0xb8,
  // Cumulative read/write byte counts (file + device I/O). A trace differences
  // them to get a per-process rate; the NIC is not part of this (R25 / §3).
  ioRead: 0xe8,
  ioWrite: 0xf0,
}

const SPECIAL_NAMES = new Map([
  [0, 'Idle'],
  [4, 'System'],
])

/**
 * Kernel pseudo-processes. Task Manager does not list them, and they only add
 * noise: pid 0's CPU time is the machine's *idle* time (so it always reads
 * ~100 %), and `Registry` / `Secure System` have no image and no window.
 */
const HIDDEN_PIDS = new Set([0])
const HIDDEN_NAMES = new Set(['Registry', 'Secure System'])

const EnumWindowsProc = koffi.proto('bool SS_EnumWindowsProc(void *hwnd, intptr_t lparam)')
const EnumWindows = user32.func('bool EnumWindows(SS_EnumWindowsProc *callback, intptr_t lparam)')
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hwnd)')
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)')
const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(void *hwnd)')

const WINDOW_BUFFER = Buffer.alloc(1024 * 1024)

function queryProcesses() {
  const returned = [0]
  const status = NtQuerySystemInformation(SystemProcessInformation, WINDOW_BUFFER, WINDOW_BUFFER.length, returned)
  if (status === 0) return returned[0]
  throw new Error(`NtQuerySystemInformation failed with 0x${(status >>> 0).toString(16)}`)
}

function readProcesses(total) {
  const base = Number(koffi.address(WINDOW_BUFFER))
  const list = []
  let offset = 0
  while (offset < total) {
    const next = WINDOW_BUFFER.readUInt32LE(offset + OFF.next)
    const pid = Number(WINDOW_BUFFER.readBigUInt64LE(offset + OFF.pid))
    const ppid = Number(WINDOW_BUFFER.readBigUInt64LE(offset + OFF.ppid))
    const createTime = WINDOW_BUFFER.readBigUInt64LE(offset + OFF.createTime)
    const kernel = WINDOW_BUFFER.readBigInt64LE(offset + OFF.kernelTime)
    const user = WINDOW_BUFFER.readBigInt64LE(offset + OFF.userTime)
    const workingSet = Number(WINDOW_BUFFER.readBigUInt64LE(offset + OFF.workingSet))
    const privateWorkingSet = Number(WINDOW_BUFFER.readBigInt64LE(offset + OFF.privateWorkingSet))
    const threads = WINDOW_BUFFER.readUInt32LE(offset + OFF.threads)
    const handles = WINDOW_BUFFER.readUInt32LE(offset + OFF.handles)
    const privateBytes = Number(WINDOW_BUFFER.readBigUInt64LE(offset + OFF.privateBytes))
    const ioRead = Number(WINDOW_BUFFER.readBigInt64LE(offset + OFF.ioRead))
    const ioWrite = Number(WINDOW_BUFFER.readBigInt64LE(offset + OFF.ioWrite))
    const nameLength = WINDOW_BUFFER.readUInt16LE(offset + OFF.imageNameLength)
    const namePointer = Number(WINDOW_BUFFER.readBigUInt64LE(offset + OFF.imageNameBuffer))
    let name = ''
    if (nameLength > 0 && nameLength < 1024 && namePointer > 0) {
      const nameOffset = namePointer - base
      if (nameOffset >= 0 && nameOffset + nameLength <= WINDOW_BUFFER.length) {
        name = WINDOW_BUFFER.toString('utf16le', nameOffset, nameOffset + nameLength)
      }
    }
    if (!name) name = SPECIAL_NAMES.get(pid) ?? `pid-${pid}`
    // The panel used to show `chrome`, not `chrome.exe` (PDH instance names drop
    // the extension); keep the same look without losing the image identity.
    const imageName = name.replace(/\.exe$/i, '')
    if (!HIDDEN_PIDS.has(pid) && !HIDDEN_NAMES.has(imageName)) {
      list.push({
        pid,
        ppid,
        name: imageName,
        createTime: createTime.toString(),
        cpu100ns: kernel + user,
        // Task Manager's 内存 column, not the total working set: the private part
        // is what a user can attribute to the app. Falls back to the total only if
        // the kernel ever reports zero for a live process.
        workingSetBytes: Math.max(0, privateWorkingSet || workingSet),
        // Trace fields. `privateBytes` is the commit the tracer plots; the panel
        // keeps using `workingSetBytes` so its column still matches Task Manager.
        privateBytes: Math.max(0, privateBytes || 0),
        handleCount: handles,
        threadCount: threads,
        ioReadBytes: Math.max(0, ioRead || 0),
        ioWriteBytes: Math.max(0, ioWrite || 0),
      })
    }
    // The record walk must advance for every entry, including the hidden ones.
    if (next === 0) break
    offset += next
  }
  return list
}

/** Pids that own at least one visible top-level window with a title. */
function windowPids() {
  const pids = new Set()
  EnumWindows((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true
    if (GetWindowTextLengthW(hwnd) === 0) return true
    const pid = [0]
    GetWindowThreadProcessId(hwnd, pid)
    if (pid[0] !== 0) pids.add(pid[0])
    return true
  }, 0)
  return pids
}

const pathCache = new Map()
const keyCache = new Map()
const descriptionCache = new Map()

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'

/**
 * Image path for a pid. Protected processes (services, `csrss`, …) refuse
 * `OpenProcess` even for QUERY_LIMITED, so fall back to the system directories
 * by image name — the same trick Task Manager uses to still show an icon and a
 * display name for them.
 */
function exePath(pid, name) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (handle) {
    try {
      const capacity = 1024
      const buffer = Buffer.alloc(capacity * 2)
      const size = [capacity]
      if (QueryFullProcessImageNameW(handle, 0, buffer, size)) {
        return buffer.toString('utf16le', 0, size[0] * 2)
      }
    } finally {
      CloseHandle(handle)
    }
  }
  if (typeof name === 'string' && name.length > 0 && !name.startsWith('pid-')) {
    for (const candidate of [
      path.join(SYSTEM_ROOT, 'System32', `${name}.exe`),
      path.join(SYSTEM_ROOT, `${name}.exe`),
      path.join(SYSTEM_ROOT, 'SysWOW64', `${name}.exe`),
    ]) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // Not there; keep trying the next directory.
      }
    }
  }
  return null
}

/** Localized FileDescription, cached by path; long ones are clipped. */
function describe(imagePath) {
  if (!imagePath) return null
  if (descriptionCache.has(imagePath)) return descriptionCache.get(imagePath)
  const text = fileDescription(imagePath)
  const label = typeof text === 'string' && text.length > 0 ? text.slice(0, 80) : null
  descriptionCache.set(imagePath, label)
  return label
}

/**
 * `exeKey` is what the client and the icon endpoint speak: a hash of the path
 * plus its mtime and size, so an app update invalidates the cached icon. The
 * path itself never leaves this process.
 */
function exeKeyFor(path) {
  const cached = keyCache.get(path)
  if (cached && Date.now() - cached.at < 60_000) return cached.key
  let stamp = ''
  try {
    const stat = fs.statSync(path)
    stamp = `${Math.round(stat.mtimeMs)}:${stat.size}`
  } catch {
    stamp = ''
  }
  const key = crypto.createHash('sha1').update(`${path.toLowerCase()}|${stamp}`).digest('hex').slice(0, 16)
  keyCache.set(path, { key, at: Date.now() })
  return key
}

let previous = new Map()
let cpuSnapshotAt = 0
let sequence = 0

/**
 * @param {{ cores?: number, now?: () => number }} [options]
 * @returns {{ at: string, seq: number, items: object[], diagnostics: object }}
 */
function collect(options = {}) {
  const cores = Math.max(1, options.cores ?? 1)
  const now = options.now ?? (() => Date.now())
  const startedAt = process.hrtime.bigint()

  const processes = readProcesses(queryProcesses())
  // Resolve the image and its localized description before grouping: the group
  // label is the root's description ("Windows 资源管理器"), not its image name.
  for (const process of processes) {
    const cached = pathCache.get(process.pid)
    const known = cached?.createTime === process.createTime ? cached.path : undefined
    const imagePath = known === undefined ? exePath(process.pid, process.name) : known
    if (known === undefined) pathCache.set(process.pid, { path: imagePath, createTime: process.createTime })
    process.path = imagePath
    process.displayName = describe(imagePath)
  }
  const windows = windowPids()
  const groups = groupApps(processes, windows)
  const at = now()
  const elapsedMs = cpuSnapshotAt === 0 ? 0 : at - cpuSnapshotAt

  const livePids = new Set()
  const items = []
  const paths = new Map()
  const next = new Map()

  for (const process of processes) {
    livePids.add(process.pid)

    let cpu = null
    const before = previous.get(process.pid)
    if (before && before.createTime === process.createTime && elapsedMs > 0) {
      const delta = Number(process.cpu100ns - before.cpu100ns)
      if (Number.isFinite(delta) && delta >= 0) {
        cpu = Math.min(1, Math.max(0, delta / 10_000 / elapsedMs / cores))
      }
    }
    next.set(process.pid, { cpu100ns: process.cpu100ns, createTime: process.createTime })

    const group = groups.get(process.pid)
    const key = process.path ? exeKeyFor(process.path) : null
    if (process.path && key) paths.set(key, process.path)
    items.push({
      pid: process.pid,
      ppid: process.ppid,
      name: process.name,
      // Task Manager's row text is the executable's FileDescription ("Google
      // Chrome"), not the image name. The group row already used it via
      // `appName`; the expanded child rows need it too, or ten `chrome` rows
      // carry no information at all.
      displayName: process.displayName ?? null,
      cpu,
      workingSetBytes: process.workingSetBytes,
      // Trace-only fields: visible to the Host (and the tracer), not used by the
      // process table. They cost one struct read per process, no extra syscall.
      privateBytes: process.privateBytes,
      handleCount: process.handleCount,
      threadCount: process.threadCount,
      ioReadBytes: process.ioReadBytes,
      ioWriteBytes: process.ioWriteBytes,
      hasWindow: group.hasWindow,
      appId: group.appId,
      appName: group.appName,
      exeKey: key,
    })
  }

  // A pid that came back with a different create time is a different process:
  // its cached path and CPU baseline belong to the dead one.
  for (const pid of pathCache.keys()) if (!livePids.has(pid)) pathCache.delete(pid)
  for (const pid of previous.keys()) if (!livePids.has(pid)) previous.delete(pid)

  previous = next
  cpuSnapshotAt = at
  sequence += 1

  return {
    at: new Date(at).toISOString(),
    seq: sequence,
    items,
    // key → absolute path, for the icon endpoint only; the child must not put
    // this on the wire (R25: no paths leave the Host).
    paths,
    diagnostics: {
      processes: items.length,
      windowed: windows.size,
      apps: new Set(items.map((item) => item.appId)).size,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    },
  }
}

module.exports = { collect, windowPids, exePath, exeKeyFor }
