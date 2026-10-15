// Self-contained test suite: no fixtures on disk, no network, no OCR.
//
//   node test/run.mjs
//
// Builds a synthetic 1920x1080 image in the temp directory, exercises the core,
// and cleans up after itself. Exits non-zero on the first failing suite summary.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

import { CropZoomError, cropZoom, normalizeRequest } from '../lib/crop.js'

const failures = []
let passed = 0

async function suite(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok    ${name}\n`)
  } catch (error) {
    failures.push(`${name}\n        ${error.message.split('\n').join('\n        ')}`)
    process.stdout.write(`  FAIL  ${name}\n`)
  }
}

/** A 1px-on/1px-off stripe block: the pattern that separates nearest from bicubic. */
function stripes(width, height) {
  const bars = Array.from({ length: Math.ceil(width / 2) }, (_, i) => `<rect x="${i * 2}" y="0" width="1" height="${height}"/>`)
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" fill="#101010"/>` +
      `<g fill="#f0f0f0">${bars.join('')}</g></svg>`,
  )
}

async function raw(file) {
  return sharp(file).raw().toBuffer()
}

const dir = await mkdtemp(join(tmpdir(), 'crop-zoom-test-'))
const source = join(dir, 'source.png')

await sharp({
  create: { width: 1920, height: 1080, channels: 4, background: { r: 30, g: 40, b: 50, alpha: 1 } },
})
  .composite([
    { input: stripes(200, 60), top: 100, left: 100 },
    { input: stripes(100, 40), top: 300, left: 400 },
  ])
  .png()
  .toFile(source)

process.stdout.write(`crop-zoom tests\n  source: ${source}\n`)

await suite('single region, auto scale from target', async () => {
  const result = await cropZoom({ path: source, regions: [{ x: 100, y: 100, width: 200, height: 60 }] })
  assert.equal(result.sourceWidth, 1920)
  assert.equal(result.sourceHeight, 1080)
  assert.equal(result.regions.length, 1)
  assert.deepEqual(
    { scale: result.regions[0].scale, w: result.regions[0].outWidth, h: result.regions[0].outHeight },
    { scale: 8, w: 1600, h: 480 },
  )
  assert.equal(result.sheetWidth, 1640)
  assert.equal(result.sheetHeight, 20 + 34 + 480 + 20)
  assert.ok(result.files.length === 1)
})

await suite('two regions stack into one sheet', async () => {
  const result = await cropZoom({
    path: source,
    regions: [
      { x: 100, y: 100, width: 200, height: 60, label: 'first' },
      { x: 400, y: 300, width: 100, height: 40, label: 'second' },
    ],
  })
  assert.equal(result.regions[0].scale, 8)
  assert.equal(result.regions[1].scale, 16)
  assert.equal(result.regions[1].outWidth, 1600)
  assert.equal(result.regions[1].outHeight, 640)
  assert.equal(result.sheetWidth, 1640)
  assert.equal(result.sheetHeight, 20 + (34 + 480 + 20) + (34 + 640 + 20))
  const meta = await sharp(result.sheetPath).metadata()
  assert.equal(meta.width, result.sheetWidth)
  assert.equal(meta.height, result.sheetHeight)
})

await suite('explicit scale is honoured and clamped', async () => {
  const result = await cropZoom({ path: source, regions: [{ x: 100, y: 100, width: 20, height: 20 }], scale: 3 })
  assert.equal(result.regions[0].scale, 3)
  assert.equal(result.regions[0].outWidth, 60)
  const clamped = normalizeRequest({ path: source, regions: [{ x: 0, y: 0, width: 20, height: 20 }], scale: 99 })
  assert.equal(clamped.scale, 16)
})

await suite('previewWidth rescales coordinates to the source', async () => {
  const direct = await cropZoom({
    path: source,
    regions: [{ x: 100, y: 100, width: 200, height: 60 }],
    scale: 4,
    outPath: join(dir, 'direct.png'),
  })
  const preview = await cropZoom({
    path: source,
    regions: [{ x: 50, y: 50, width: 100, height: 30 }],
    scale: 4,
    previewWidth: 960,
    outPath: join(dir, 'preview.png'),
  })
  assert.deepEqual(
    { x: preview.regions[0].x, y: preview.regions[0].y, w: preview.regions[0].width, h: preview.regions[0].height },
    { x: direct.regions[0].x, y: direct.regions[0].y, w: direct.regions[0].width, h: direct.regions[0].height },
  )
  assert.ok((await raw(direct.sheetPath)).equals(await raw(preview.sheetPath)))
})

await suite('nearest and bicubic really differ on a 1px pattern', async () => {
  const common = { path: source, regions: [{ x: 100, y: 100, width: 200, height: 60 }], scale: 4 }
  const nearest = await cropZoom({ ...common, mode: 'nearest', outPath: join(dir, 'nearest.png') })
  const bicubic = await cropZoom({ ...common, mode: 'bicubic', outPath: join(dir, 'bicubic.png') })
  assert.equal(nearest.regions[0].outWidth, bicubic.regions[0].outWidth)
  assert.ok(!(await raw(nearest.sheetPath)).equals(await raw(bicubic.sheetPath)))
})

await suite('sheet=false writes one file per region', async () => {
  const result = await cropZoom({
    path: source,
    regions: [
      { x: 100, y: 100, width: 40, height: 40 },
      { x: 400, y: 300, width: 40, height: 40 },
    ],
    scale: 2,
    sheet: false,
  })
  assert.equal(result.sheetPath, '')
  assert.equal(result.files.length, 2)
  assert.notEqual(result.files[0], result.files[1])
  for (const file of result.files) {
    const meta = await sharp(file).metadata()
    assert.equal(meta.width, 80)
    assert.equal(meta.height, 80)
  }
})

await suite('rejects bad input with a useful message', async () => {
  const cases = [
    [{ path: source, regions: [{ x: 1900, y: 1000, width: 200, height: 200 }] }, /falls outside/],
    [{ path: source, regions: [{ x: 0, y: 0, width: 2, height: 2 }] }, /too small/],
    [{ path: source, regions: [{ x: 0, y: 0, width: 10, height: 10 }], mode: 'lanczos9' }, /"mode" must be one of/],
    [{ path: 'relative.png', regions: [{ x: 0, y: 0, width: 10, height: 10 }] }, /absolute path/],
    [{ path: source, regions: [] }, /non-empty array/],
    [{ path: source, regions: Array.from({ length: 9 }, () => ({ x: 0, y: 0, width: 10, height: 10 })) }, /at most 8/],
    [{ path: join(dir, 'missing.png'), regions: [{ x: 0, y: 0, width: 10, height: 10 }] }, /no such file/],
    [{ path: source, regions: [{ x: 0, y: 0, width: 10.5, height: 10 }] }, /must be an integer/],
  ]
  for (const [args, pattern] of cases) {
    await assert.rejects(() => cropZoom(args), (error) => {
      assert.ok(error instanceof CropZoomError, `expected CropZoomError, got ${error.constructor.name}`)
      assert.match(error.message, pattern)
      return true
    })
  }
})

await suite('accepts the CLI string form "x,y,w,h"', async () => {
  const result = await cropZoom({ path: source, regions: ['100,100,200,60'], scale: 2 })
  assert.deepEqual(
    { x: result.regions[0].x, y: result.regions[0].y, w: result.regions[0].width, h: result.regions[0].height },
    { x: 100, y: 100, w: 200, h: 60 },
  )
})

await rm(dir, { recursive: true, force: true })

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`)
  process.exitCode = 1
}
