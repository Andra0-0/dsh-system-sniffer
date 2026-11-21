'use strict'

/**
 * Localized display names, the way Task Manager gets them.
 *
 * Windows stores a `FileDescription` string in each executable's version
 * resource, already localized (on a zh-CN system `svchost.exe` is
 * "Windows 服务主进程", `notepad.exe` is "记事本"). Task Manager shows that
 * string, which is why its process names are Chinese while the image names are
 * not.
 *
 * This module only reads the version resource: no process handle, no COM, no
 * shell. Results are cached by path because an executable's description never
 * changes while it runs.
 */

const koffi = require('koffi')

const version = koffi.load('version.dll')

const GetFileVersionInfoSizeW = version.func('uint32 GetFileVersionInfoSizeW(str16, _Out_ uint32 *handle)')
const GetFileVersionInfoW = version.func('bool GetFileVersionInfoW(str16, uint32, uint32, _Out_ uint8 *data)')
const VerQueryValueW = version.func('bool VerQueryValueW(void *block, str16, _Out_ void **value, _Out_ uint32 *length)')

const cache = new Map()

function query(buffer, sub) {
  const value = [null]
  const length = [0]
  if (!VerQueryValueW(buffer, sub, value, length)) return null
  const pointer = value[0]
  if (!pointer || length[0] === 0) return null
  const offset = Number(koffi.address(pointer)) - Number(koffi.address(buffer))
  if (offset < 0 || offset >= buffer.length) return null
  return { offset, bytes: length[0] }
}

function translations(buffer) {
  const found = query(buffer, '\\VarFileInfo\\Translation')
  if (!found) return []
  const pairs = []
  for (let index = 0; index + 4 <= found.bytes; index += 4) {
    const at = found.offset + index
    const language = buffer.readUInt16LE(at)
    const codepage = buffer.readUInt16LE(at + 2)
    if (language !== 0) pairs.push({ language, codepage })
  }
  return pairs
}

function hex4(value) {
  return value.toString(16).padStart(4, '0')
}

/**
 * @param {string} path absolute path of an executable
 * @returns {string|null} localized FileDescription, or null when the file has
 *   no version resource (or Windows cannot read it)
 */
function fileDescription(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  if (cache.has(path)) return cache.get(path)

  let description = null
  try {
    const handle = [0]
    const size = GetFileVersionInfoSizeW(path, handle)
    if (size > 0) {
      const buffer = Buffer.alloc(size)
      if (GetFileVersionInfoW(path, 0, size, buffer)) {
        const pairs = translations(buffer)
        // The first translation is the file's own language; fall back to the
        // neutral one, which is what English-only binaries carry.
        const candidates = pairs.length > 0
          ? pairs
          : [{ language: 0x0409, codepage: 0x04b0 }]
        for (const pair of candidates) {
          const sub = `\\StringFileInfo\\${hex4(pair.language)}${hex4(pair.codepage)}\\FileDescription`
          const found = query(buffer, sub)
          if (!found) continue
          // For string values `VerQueryValue` reports the length in *characters*
          // (including the null), not bytes; the translation block reports bytes.
          const end = Math.min(buffer.length, found.offset + found.bytes * 2)
          const text = buffer.toString('utf16le', found.offset, end).replace(/\0+$/, '').trim()
          if (text.length > 0) {
            description = text
            break
          }
        }
      }
    }
  } catch {
    description = null
  }

  cache.set(path, description)
  return description
}

module.exports = { fileDescription }
