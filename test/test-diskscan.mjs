/**
 * Disk scan unit checks: a temp tree, no real drive, no timers beyond polling.
 *
 * Run with `node test/test-diskscan.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiskScan } from '../lib/diskscan.js'
import { createTool } from '../lib/tool.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function buildTree() {
  const root = await mkdtemp(join(tmpdir(), 'sniffer-diskscan-'))
  await mkdir(join(root, 'alpha'))
  await mkdir(join(root, 'beta'))
  await mkdir(join(root, 'beta', 'nested'))
  await mkdir(join(root, 'zz-empty-names-only-probe'))
  await writeFile(join(root, 'alpha', 'a1.bin'), Buffer.alloc(100))
  await writeFile(join(root, 'alpha', 'a2.bin'), Buffer.alloc(200))
  await writeFile(join(root, 'alpha', 'a3.bin'), Buffer.alloc(300))
  await writeFile(join(root, 'beta', 'b1.bin'), Buffer.alloc(1000))
  await writeFile(join(root, 'beta', 'nested', 'deep.bin'), Buffer.alloc(4000))
  await writeFile(join(root, 'loose.bin'), Buffer.alloc(500))
  return root
}

const tree = await buildTree()

try {
  const scan = createDiskScan({ concurrency: 4, topN: 3 })
  const started = scan.start(tree)
  assert.equal(started.state, 'scanning', 'start should report scanning')
  assert.ok(await waitFor(() => scan.status().state === 'ready'), 'scan should finish')

  const status = scan.status()
  await check('totals: files, dirs, bytes', () => {
    assert.equal(status.files, 6, `files ${status.files}`)
    assert.equal(status.dirs, 4, `dirs ${status.dirs}`)
    assert.equal(status.bytes, 6100, `bytes ${status.bytes}`)
    assert.equal(status.denied, 0)
    assert.equal(status.partial, false)
  })

  const rootLevel = await scan.level('0')
  await check('root level sorts by size, directories before nothing', () => {
    assert.equal(rootLevel.name, tree.split('\\').pop())
    assert.deepEqual(rootLevel.children.map((child) => child.name).slice(0, 2), ['beta', 'alpha'])
    assert.equal(rootLevel.children[0].bytes, 5000)
    assert.equal(rootLevel.total, 6100)
    assert.equal(rootLevel.partial, false)
  })

  await check('root level carries the loose file as a rectangle', () => {
    const loose = rootLevel.children.find((child) => child.name === 'loose.bin')
    assert.ok(loose, 'loose.bin should appear')
    assert.equal(loose.dir, false)
    assert.equal(loose.bytes, 500)
  })

  await check('top-N folds the tail into one bucket', () => {
    assert.equal(rootLevel.children.length, 3, 'topN was 3 in this scan')
    assert.ok(rootLevel.other, 'a tail should be reported')
    assert.equal(rootLevel.other.count, 1)
    assert.equal(rootLevel.other.bytes, 0, 'the empty directory is the folded one')
  })

  const beta = rootLevel.children[0]
  const betaLevel = await scan.level(beta.id)
  await check('a level lists its own files with sizes', () => {
    const names = betaLevel.children.map((child) => child.name)
    assert.ok(names.includes('b1.bin'), `expected b1.bin in ${names}`)
    const file = betaLevel.children.find((child) => child.name === 'b1.bin')
    assert.equal(file.bytes, 1000)
  })

  await check('breadcrumb is names only, no absolute path', () => {
    assert.deepEqual(betaLevel.path.map((step) => step.name), [tree.split('\\').pop(), 'beta'])
    const wire = JSON.stringify(betaLevel)
    assert.ok(!wire.includes(tree.replace(/\\/g, '\\\\')), 'payload must not carry the absolute path')
    assert.ok(!wire.includes(tree), 'payload must not carry the absolute path')
    assert.ok(!wire.includes(':\\'), 'payload must not carry a drive-qualified path')
  })

  await check('unknown level id is an error, not a crash', async () => {
    const missing = await scan.level('nope')
    assert.equal(missing.error.code, 'sniffer/diskscan-level')
  })

  await check('a second start while scanning is refused', async () => {
    const second = scan.start(tree)
    // The first scan is done by now, so this start is accepted; cancel and
    // re-check the busy path with a scan that is actually running.
    if (second.jobId) scan.cancel()
    const busyScan = createDiskScan({ concurrency: 1 })
    busyScan.start('C:\\')
    const refused = busyScan.start('C:\\')
    assert.ok(refused.error, 'a running scan should refuse a second start')
    assert.equal(refused.error.code, 'sniffer/diskscan-busy')
    busyScan.dispose()
  })

  await check('policy defaults to off and hides everything', () => {
    const fresh = createDiskScan()
    assert.equal(fresh.policy().level, 'off')
    const view = fresh.toolView()
    assert.equal(view.available, false)
    assert.equal(view.reason, 'disk-detail-disabled')
    assert.ok(!JSON.stringify(view).includes('alpha'), 'off must not leak names')
    fresh.dispose()
  })

  await check('policy numbers gives totals without names', async () => {
    const scan2 = createDiskScan()
    scan2.start(tree)
    await waitFor(() => scan2.status().state === 'ready')
    scan2.setPolicy('numbers')
    const view = scan2.toolView()
    assert.equal(view.available, true)
    assert.equal(view.bytes, 6100)
    assert.ok(!JSON.stringify(view).includes('zz-empty-names-only-probe'), 'numbers must not carry names')
    assert.ok(!JSON.stringify(view).includes('loose.bin'), 'numbers must not carry file names')
    scan2.dispose()
  })

  await check('policy names adds directory names, still no paths', async () => {
    const scan3 = createDiskScan()
    scan3.start(tree)
    await waitFor(() => scan3.status().state === 'ready')
    scan3.setPolicy('names')
    const view = scan3.toolView()
    const wire = JSON.stringify(view)
    assert.ok(wire.includes('zz-empty-names-only-probe'), 'names level should list directories')
    assert.ok(!wire.includes('loose.bin'), 'names level must not list files')
    assert.ok(!wire.includes(tree), 'names level must not carry paths')
    scan3.dispose()
  })

  await check('invalid policy is rejected', () => {
    const scan4 = createDiskScan()
    const result = scan4.setPolicy('everything')
    assert.equal(result.error.code, 'sniffer/diskscan-policy')
    scan4.dispose()
  })

  await check('an unreadable directory is counted, not fatal', async () => {
    const scan5 = createDiskScan()
    scan5.start(join(tree, 'does-not-exist'))
    // normaliseRoot accepts an absolute path; readdir then fails and the job
    // still reaches ready with denied = 1.
    assert.ok(await waitFor(() => ['ready', 'failed'].includes(scan5.status().state)))
    const status5 = scan5.status()
    assert.equal(status5.state, 'ready')
    assert.equal(status5.denied, 1)
    scan5.dispose()
  })

  await check('the tool carries the disk summary, including the off reason', async () => {
    const snapshot = {
      intervalMs: 1000,
      groups: [],
      sources: [],
      degraded: [],
      cpu: null,
      diskScan: { available: false, reason: 'disk-detail-disabled' },
    }
    const tool = createTool(async () => snapshot, ['cpu'])
    const parsed = JSON.parse(await tool.execute({}, {}))
    assert.equal(parsed.diskScan.reason, 'disk-detail-disabled')
    assert.equal(parsed.cpu, null)
    assert.equal(parsed.memory, undefined, 'sections outside the include list stay absent')
  })

  scan.dispose()
} finally {
  await rm(tree, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(failure.error)
  process.exitCode = 1
}
