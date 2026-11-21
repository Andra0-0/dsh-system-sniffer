/**
 * typeperf CSV: decoding, splitting, and counter-path parsing.
 *
 * typeperf writes to a console pipe, so it uses the console code page. On a
 * zh-CN machine that is GBK; a Chinese process name decoded as UTF-8 becomes
 * replacement characters. We decode per line and fall back once.
 */

const GBK = new TextDecoder('gbk', { fatal: false })

/**
 * Decode one complete line. Never hand this a chunk: a multi-byte character
 * split across a chunk boundary decodes to U+FFFD, which both fakes a decoding
 * problem and latches the child to the wrong decoder for the rest of its life.
 * The caller buffers raw bytes and cuts on CRLF instead.
 * @param bytes - one line's raw bytes, terminator already removed.
 * @param state - `{ decoder: 'utf8' | 'gbk' }`, mutated once a line proves GBK.
 */
export function decodeLine(bytes, state) {
  if (state.decoder === 'gbk') return GBK.decode(bytes)
  const text = bytes.toString('utf8')
  if (text.includes('\uFFFD')) {
    state.decoder = 'gbk'
    return GBK.decode(bytes)
  }
  return text
}

/** Split one `"a","b","c"` line into fields without the surrounding quotes. */
export function splitCsv(line) {
  const inner = line.startsWith('"') ? line.slice(1) : line
  const trimmed = inner.endsWith('"') ? inner.slice(0, -1) : inner
  return trimmed.split('","')
}

/**
 * `\\HOST\Object(instance)\Counter` or `\\HOST\Object\Counter` → parts.
 * The raw header keeps the machine prefix, and instance-less counters have no
 * parentheses at all, so both shapes must be handled.
 */
export function parseCounterPath(raw) {
  // Accept both the header form (`\\HOST\Object(instance)\Counter`) and the
  // request form written in `groups.js` (`\Object(instance)\Counter`).
  const body = raw.replace(/^\\\\[^\\]+\\/, '').replace(/^\\/, '')
  const withInstance = /^(.+?)\((.*)\)\\(.+)$/.exec(body)
  if (withInstance) {
    return { object: withInstance[1], instance: withInstance[2], counter: withInstance[3] }
  }
  const cut = body.indexOf('\\')
  if (cut < 0) return { object: body, instance: null, counter: '' }
  return { object: body.slice(0, cut), instance: null, counter: body.slice(cut + 1) }
}

/**
 * Parse a typeperf value. Missing and placeholder values become null rather
 * than NaN, so the panel can render an honest gap.
 */
export function toNumber(cell) {
  if (cell === undefined || cell === null) return null
  const text = String(cell).trim()
  if (text === '' || text === '--') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** `chrome#3` → `chrome`; instance suffixes mark duplicate names, not identity. */
export function baseInstance(instance) {
  if (!instance) return instance
  const hash = instance.lastIndexOf('#')
  return hash > 0 ? instance.slice(0, hash) : instance
}

/**
 * `..._engtype_3D` → `3D`; the GPU engine type lives in the instance name.
 */
export function engineType(instance) {
  if (!instance) return null
  const match = /_engtype_(.+)$/.exec(instance)
  return match ? match[1] : null
}

/**
 * Incremental CRLF splitter over raw bytes.
 *
 * Splitting must happen on bytes, before decoding: a chunk boundary inside a
 * multi-byte character would otherwise decode to U+FFFD, which looks like a
 * code-page problem and latches the child to the wrong decoder for good.
 * @returns a push(chunk) → complete lines (Buffers, terminator removed).
 */
export function createLineSplitter() {
  let buffer = Buffer.alloc(0)
  return {
    /** @param chunk - raw stdout bytes. @returns every complete line now available. */
    push(chunk) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      const lines = []
      for (;;) {
        const cut = buffer.indexOf('\r\n')
        if (cut < 0) break
        lines.push(buffer.subarray(0, cut))
        buffer = buffer.subarray(cut + 2)
      }
      return lines
    },
    /** Bytes held back because no terminator arrived yet. */
    get pending() {
      return buffer.length
    },
  }
}

/**
 * A header line rather than a sample. typeperf prints one header when it
 * starts, then re-prints it whenever the instance set changes (`Network
 * Interface(*)` gains an adapter, `Process(*)` gains an instance). A re-printed
 * header is a new schema, not a data row: reading it as data leaves every later
 * row width-mismatched and the whole group silently dead.
 */
export function isHeaderLine(line) {
  return line.startsWith('"(PDH-CSV')
}

/** Counter columns of one header line, in column order. */
export function parseHeader(line) {
  return splitCsv(line).slice(1).map((raw, index) => ({ index, ...parseCounterPath(raw) }))
}

/**
 * Does a parsed header actually describe the counters that were requested?
 *
 * A mangled decode still splits into cells; it just loses or garbles one path,
 * so the header keeps looking plausible while every value after it is
 * misaligned. Comparing the header against the requested paths is the only
 * cheap sanity check that catches that before numbers reach the panel.
 *
 * @param columns - parsed header columns.
 * @param expected - requested counter paths (`parseCounterPath` results, instance may be `*`).
 * @returns true when every requested object/counter pair is present.
 */
export function headerCovers(columns, expected) {
  const present = new Set(columns.map((column) => `${column.object}\u0000${column.counter}`))
  return expected.every((want) => present.has(`${want.object}\u0000${want.counter}`))
}

/**
 * Fold one raw stdout line into a group's stream state.
 *
 * A header is a schema, and typeperf re-prints it whenever the instance set
 * changes, so a header can arrive mid-stream. Treating that as a sample would
 * leave the stale column count rejecting every later row — the group looks
 * dead while its child is still healthy.
 *
 * @param state - `{ columns, headerWidth, lastWidth, dropped, headers }`, mutated in place.
 * @param line - one `\r\n`-terminated line, without the terminator.
 * @returns `ignored` for non-CSV chatter, `header` for a schema (re)print,
 *   `dropped` for a width mismatch, `row` with the aligned cells otherwise.
 */
export function foldStreamLine(state, line) {
  if (!line.startsWith('"')) return { kind: 'ignored' }
  if (isHeaderLine(line) || (state.columns === null && state.headers === 0)) {
    state.columns = parseHeader(line)
    state.headerWidth = state.columns.length
    state.lastWidth = state.columns.length
    state.headers += 1
    return { kind: 'header' }
  }
  if (state.columns === null) return { kind: 'ignored' }
  const cells = splitCsv(line).slice(1)
  state.lastWidth = cells.length
  if (cells.length !== state.columns.length) {
    state.dropped += 1
    return { kind: 'dropped' }
  }
  return { kind: 'row', columns: state.columns, cells }
}
