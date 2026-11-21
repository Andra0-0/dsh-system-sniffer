'use strict'

/**
 * Icon extraction and PNG encoding.
 *
 * Windows hands out an HICON; a browser needs a PNG. There is no shell API that
 * returns PNG bytes for an icon, so the pipeline is:
 *
 *   SHGetFileInfoW (SHGFI_ICON) → HICON
 *   GetIconInfo                → colour bitmap + 1bpp mask
 *   GetDIBits (32bpp, top-down)→ BGRA pixels
 *   zlib + PNG chunks          → bytes for `<img>`
 *
 * Icons carry alpha in two ways: a real 32bpp alpha channel, or the legacy
 * 1bpp AND-mask (bit set = transparent). Old icons come with alpha = 0
 * everywhere, so an all-zero alpha is treated as "use the mask".
 */

const zlib = require('node:zlib')
const koffi = require('koffi')

const SHGFI_ICON = 0x00000100
const SHGFI_LARGEICON = 0x00000000
const DIB_RGB_COLORS = 0
const BI_RGB = 0

const shell32 = koffi.load('shell32.dll')
const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')

const SHFILEINFOW = koffi.struct('SS_SHFILEINFOW', {
  hIcon: 'void *',
  iIcon: 'int',
  dwAttributes: 'uint32',
  szDisplayName: 'uint16[260]',
  szTypeName: 'uint16[80]',
})

const ICONINFO = koffi.struct('SS_ICONINFO', {
  fIcon: 'int',
  xHotspot: 'uint32',
  yHotspot: 'uint32',
  hbmMask: 'void *',
  hbmColor: 'void *',
})

const BITMAPINFOHEADER = koffi.struct('SS_BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
})

const SHGetFileInfoW = shell32.func(
  'uintptr_t SHGetFileInfoW(str16, uint32, _Inout_ SS_SHFILEINFOW *, uint32, uint32)',
)
const GetIconInfo = user32.func('bool GetIconInfo(void *icon, _Out_ SS_ICONINFO *)')
const DestroyIcon = user32.func('bool DestroyIcon(void *)')
const CreateCompatibleDC = gdi32.func('void *CreateCompatibleDC(void *)')
const DeleteDC = gdi32.func('bool DeleteDC(void *)')
const SelectObject = gdi32.func('void *SelectObject(void *hdc, void *obj)')
const GetDIBits = gdi32.func(
  'int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, _Out_ uint8 *bits, void *bmi, uint32 usage)',
)
const GetObjectW = gdi32.func('int GetObjectW(void *obj, int size, _Out_ uint8 *buf)')
const DeleteObject = gdi32.func('bool DeleteObject(void *)')

// ── PNG ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** RGBA, 8 bit per channel, no interlace; one filter byte (0) per row. */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── icon → pixels ──────────────────────────────────────────────────────────

/**
 * BITMAPINFO must be passed as a real pointer: koffi copies a struct object and
 * does not copy back, so `GetDIBits` would read a zeroed header. Allocate and
 * encode instead.
 */
function makeBitmapInfo(width, height, bitCount) {
  // A trailing palette is reserved even for 32bpp: `GetDIBits` writes
  // `bmiColors` for bit depths below 24, and a 40-byte allocation makes it
  // write past the end of the block (observed as STATUS_HEAP_CORRUPTION at
  // exit, 0xC0000374).
  const ptr = koffi.alloc('uint8', koffi.sizeof(BITMAPINFOHEADER) + 1024)
  koffi.encode(ptr, BITMAPINFOHEADER, {
    biSize: koffi.sizeof(BITMAPINFOHEADER),
    biWidth: width,
    // Negative height = top-down rows, the order PNG wants.
    biHeight: -height,
    biPlanes: 1,
    biBitCount: bitCount,
    biCompression: BI_RGB,
    biSizeImage: 0,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0,
  })
  return ptr
}

/** BITMAP (32 bytes on x64) gives the DDB's real size and depth. */
function bitmapSize(hbm) {
  const buffer = Buffer.alloc(32)
  if (GetObjectW(hbm, buffer.length, buffer) < 20) return null
  const width = buffer.readInt32LE(4)
  const height = Math.abs(buffer.readInt32LE(8))
  const bitCount = buffer.readUInt16LE(18)
  if (width <= 0 || height <= 0 || width > 512 || height > 512) return null
  return { width, height, bitCount }
}

function readColourBits(hdc, hbm) {
  const size = bitmapSize(hbm)
  // `bitCount` is what the DDB uses; GetDIBits converts to 32bpp for us, so an
  // 8bpp icon is fine too.
  if (!size) return null
  const { width, height } = size
  const pixels = Buffer.alloc(width * height * 4)
  const info = makeBitmapInfo(width, height, 32)
  const lines = GetDIBits(hdc, hbm, 0, height, pixels, info, DIB_RGB_COLORS)
  if (lines !== height) return null
  return { width, height, pixels }
}

function readMaskBits(hdc, hbm, width, height) {
  const rowBytes = ((width + 31) >> 5) * 4
  const bits = Buffer.alloc(rowBytes * height)
  const info = makeBitmapInfo(width, height, 1)
  if (GetDIBits(hdc, hbm, 0, height, bits, info, DIB_RGB_COLORS) !== height) return null
  return { width, height, rowBytes, bits }
}

/** BGRA → RGBA, and (for legacy icons) alpha from the AND-mask. */
function compose(colour, mask) {
  const { width, height, pixels } = colour
  const rgba = Buffer.alloc(width * height * 4)
  let anyAlpha = false
  for (let i = 0; i < width * height; i += 1) {
    const b = pixels[i * 4]
    const g = pixels[i * 4 + 1]
    const r = pixels[i * 4 + 2]
    const a = pixels[i * 4 + 3]
    if (a !== 0) anyAlpha = true
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = a
  }
  if (!anyAlpha && mask) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = mask.bits[y * mask.rowBytes + (x >> 3)]
        const transparent = (byte >> (7 - (x & 7))) & 1
        rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255
      }
    }
  }
  return rgba
}

/**
 * @param {string} file absolute path of an executable
 * @returns {Buffer|null} PNG bytes, or null when Windows has no icon for it
 */
function iconPng(file) {
  if (typeof file !== 'string' || file.length === 0) return null
  const info = {
    hIcon: null,
    iIcon: 0,
    dwAttributes: 0,
    szDisplayName: new Uint16Array(260),
    szTypeName: new Uint16Array(80),
  }
  // A 16×16 icon scales badly; ask for the 32×32 large icon and let the browser
  // downscale — Task Manager's 16 px rows look blurry with SHGFI_SMALLICON.
  const ok = SHGetFileInfoW(file, 0, info, koffi.sizeof(SHFILEINFOW), SHGFI_ICON | SHGFI_LARGEICON)
  if (!ok || !info.hIcon) return null

  let hdc = null
  let icon = { fIcon: 0, xHotspot: 0, yHotspot: 0, hbmMask: null, hbmColor: null }
  try {
    if (!GetIconInfo(info.hIcon, icon)) return null
    hdc = CreateCompatibleDC(null)
    if (!hdc) return null
    let colour = icon.hbmColor ? readColourBits(hdc, icon.hbmColor) : null
    const maskSize = icon.hbmMask ? bitmapSize(icon.hbmMask) : null
    const mask = maskSize
      ? readMaskBits(hdc, icon.hbmMask, colour?.width ?? maskSize.width, colour?.height ?? maskSize.height)
      : null
    if (!colour && mask) {
      // Monochrome icon: paint it from the mask so the row is not empty.
      const width = mask.width
      const height = mask.height
      const pixels = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const byte = mask.bits[y * mask.rowBytes + (x >> 3)]
          const on = ((byte >> (7 - (x & 7))) & 1) === 0
          const value = on ? 0 : 255
          const index = (y * width + x) * 4
          pixels[index] = value
          pixels[index + 1] = value
          pixels[index + 2] = value
          pixels[index + 3] = 255
        }
      }
      colour = { width, height, pixels }
      return encodePng(width, height, pixels)
    }
    if (!colour) return null
    return encodePng(colour.width, colour.height, compose(colour, mask))
  } finally {
    if (hdc) DeleteDC(hdc)
    if (icon.hbmColor) DeleteObject(icon.hbmColor)
    if (icon.hbmMask) DeleteObject(icon.hbmMask)
    DestroyIcon(info.hIcon)
  }
}

module.exports = { iconPng, encodePng, crc32, PNG_SIGNATURE }
