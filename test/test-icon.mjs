/**
 * Icon encoding, checked without a browser.
 *
 * Two layers, on purpose:
 *
 * 1. `encodePng` is pure: a 4×3 RGBA buffer must come back byte for byte, with
 *    valid chunk CRCs and no channel swap. That is the half `PITFALLS.md` §5 is
 *    about — an icon that decodes fine but has its alpha dropped looks like a
 *    black square on a dark theme.
 * 2. `iconPng` is the Win32 pipeline (SHGetFileInfo → GetIconInfo → GetDIBits →
 *    zlib). It is checked against a real executable, because "it compiles" is
 *    not the same as "Windows hands out pixels".
 *
 * Run with `node test/test-icon.mjs`.
 */
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { join } from 'node:path'
import iconModule from '../native/icon.cjs'

const { iconPng, encodePng, crc32, PNG_SIGNATURE } = iconModule

/** Walk the chunk list, verifying each CRC as it goes. */
function readChunks(png) {
  assert.ok(Buffer.isBuffer(png), 'iconPng returns a Buffer')
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature')
  const list = []
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    const stored = png.readUInt32BE(offset + 8 + length)
    list.push({ type, data, crcOk: crc32(png.subarray(offset + 4, offset + 8 + length)) === stored })
    offset += 12 + length
  }
  assert.equal(offset, png.length, 'no trailing bytes after IEND')
  return list
}

/** Decode an RGBA PNG written by this encoder (filter 0 on every row). */
function decodeRgba(png) {
  const list = readChunks(png)
  const ihdr = list.find((entry) => entry.type === 'IHDR')?.data
  assert.ok(ihdr, 'IHDR present')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const raw = zlib.inflateSync(Buffer.concat(
    list.filter((entry) => entry.type === 'IDAT').map((entry) => entry.data),
  ))
  const stride = width * 4
  assert.equal(raw.length, (stride + 1) * height, 'one filter byte per row')
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, 'the encoder only emits filter 0')
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, pixels, list, ihdr }
}

// ── the encoder is lossless and does not swap channels ─────────────────────
{
  const width = 4
  const height = 3
  const rgba = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = index * 7
    rgba[index * 4 + 1] = 255 - index * 3
    rgba[index * 4 + 2] = index * 11
    // One fully transparent pixel, the rest opaque: this is what tells an
    // "alpha dropped" bug from a correct image.
    rgba[index * 4 + 3] = index === 0 ? 0 : 255
  }
  const png = encodePng(width, height, rgba)
  assert.deepEqual(readChunks(png).map((entry) => entry.type), ['IHDR', 'IDAT', 'IEND'])
  assert.ok(readChunks(png).every((entry) => entry.crcOk), 'every chunk CRC is valid')

  const decoded = decodeRgba(png)
  assert.equal(decoded.width, width)
  assert.equal(decoded.height, height)
  assert.equal(decoded.ihdr[8], 8, 'bit depth 8')
  assert.equal(decoded.ihdr[9], 6, 'colour type 6 = RGBA')
  assert.equal(decoded.ihdr[12], 0, 'not interlaced')
  assert.ok(decoded.pixels.equals(rgba), 'pixels come back byte for byte (no channel swap)')
  assert.equal(decoded.pixels[3], 0, 'the transparent pixel stays transparent')
}

// ── the Win32 pipeline produces a real RGBA icon ───────────────────────────
{
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')
  const png = iconPng(exe)
  assert.ok(png && png.length > 100, `${exe} must yield an icon`)
  const decoded = decodeRgba(png)
  assert.ok(decoded.width >= 16 && decoded.width <= 256, `plausible size, got ${decoded.width}`)
  assert.equal(decoded.width, decoded.height, 'icons are square')
  assert.equal(decoded.ihdr[9], 6, 'an alpha channel reaches the browser')

  let transparent = 0
  let opaque = 0
  for (let offset = 3; offset < decoded.pixels.length; offset += 4) {
    if (decoded.pixels[offset] === 0) transparent += 1
    else if (decoded.pixels[offset] === 255) opaque += 1
  }
  assert.ok(opaque > 0, 'not a fully transparent square')
  // Windows icons carry transparency either as a real alpha channel or as the
  // legacy AND-mask; `compose()` falls back to the mask when alpha is all zero.
  // No transparency at all means that fallback did not run (§5).
  assert.ok(transparent > 0, 'the icon keeps its transparent pixels')
}

// ── nothing to encode is not an error ──────────────────────────────────────
{
  assert.equal(iconPng(''), null, 'an empty path yields null, not a throw')
  assert.equal(iconPng(null), null)
}

console.log('test-icon: 3 groups, ok')
