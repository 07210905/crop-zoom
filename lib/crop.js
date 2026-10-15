// Crop-and-zoom core: read one image, magnify N regions, stack them into a
// single labelled sheet.
//
// Why this exists. A 1920x1080 screenshot reaches a model downscaled, so glyphs
// 10-11px tall arrive with merged strokes: 0 and D share one left stem, a "1"
// welds itself onto the B before it, "1000" and "100D" become the same shape,
// and a 金 bottom collapses into something that reads as 皿. No amount of
// re-asking fixes that, because the pixels are already gone. Cropping the
// suspect region and upscaling it before the model looks is the only reliable
// order of operations, and it is far cheaper than re-sending a full screenshot.
//
// The single runtime dependency is sharp (libvips), which decodes PNG/JPEG/
// WebP/AVIF/TIFF/GIF and resamples with a selectable kernel.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

// sharp is resolved on first use rather than at module load. This module is
// imported by the plugin entry point, and a harness must still start when a
// native dependency is missing or built for another platform: a broken sharp
// should cost one failed tool call, not an application that will not boot.
let sharpPromise
function loadSharp() {
  sharpPromise ??= import('sharp').then((module) => module.default ?? module)
  return sharpPromise
}

export const MAX_REGIONS = 8
export const MIN_SIDE = 4
export const MAX_SCALE = 16
export const DEFAULT_TARGET = 1600

const PAD = 20
const CAPTION_H = 34
const SHEET_BG = { r: 16, g: 20, b: 24, alpha: 1 }
const CAPTION_BG = '#0b0f14'
const CAPTION_FG = '#7fd4ff'

const KERNELS = {
  nearest: 'nearest',
  bicubic: 'cubic',
  cubic: 'cubic',
  lanczos: 'lanczos3',
  mitchell: 'mitchell',
}

export class CropZoomError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CropZoomError'
  }
}

function fail(message) {
  throw new CropZoomError(message)
}

/** Accepts a number or a numeric string; rejects fractions and non-numbers by name. */
function toInt(value, key, at) {
  const n = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value
  if (!Number.isFinite(n)) fail(`${at}: ${key} is missing or not a number`)
  if (!Number.isInteger(n)) fail(`${at}: ${key} must be an integer pixel value (got ${value})`)
  return n
}

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '&':
        return '&amp;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

/** Where output lands when the caller does not name a path. */
export function defaultOutDir() {
  return join(tmpdir(), 'crop-zoom')
}

/**
 * One region, as either "x,y,w,h" or {x,y,width,height,label}.
 * Returns pixel integers; throws CropZoomError with the region number named.
 */
export function parseRegion(input, index) {
  const at = `region #${index + 1}`
  let x
  let y
  let width
  let height
  let label

  if (typeof input === 'string') {
    const parts = input
      .split(/[\s,]+/)
      .filter((part) => part.length > 0)
      .map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      fail(`${at}: "${input}" is not "x,y,width,height"`)
    }
    ;[x, y, width, height] = parts
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    x = input.x
    y = input.y
    width = input.width ?? input.w
    height = input.height ?? input.h
    if (typeof input.label === 'string' && input.label.trim().length > 0) label = input.label.trim()
  } else {
    fail(`${at}: expected "x,y,width,height" or {x,y,width,height} (got ${JSON.stringify(input)})`)
  }

  x = toInt(x, 'x', at)
  y = toInt(y, 'y', at)
  width = toInt(width, 'width', at)
  height = toInt(height, 'height', at)
  if (x < 0 || y < 0) fail(`${at}: x and y must be >= 0 (got ${x},${y})`)
  if (width < MIN_SIDE || height < MIN_SIDE) {
    fail(`${at}: ${width}x${height} is too small to magnify; both sides must be at least ${MIN_SIDE}px`)
  }

  return label ? { x, y, width, height, label } : { x, y, width, height }
}

/** Validate and canonicalise one tool call. */
export function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('arguments must be an object')

  const source = typeof raw.path === 'string' ? raw.path.trim() : ''
  if (source.length === 0) fail('"path" must be a non-empty string')
  if (!isAbsolute(source)) fail(`"path" must be an absolute path (got "${source}")`)
  if (!existsSync(source)) fail(`no such file: ${source}`)

  const list = Array.isArray(raw.regions)
    ? raw.regions
    : raw.regions === undefined && raw.region !== undefined
      ? [raw.region]
      : null
  if (!list || list.length === 0) fail('"regions" must be a non-empty array')
  if (list.length > MAX_REGIONS) fail(`at most ${MAX_REGIONS} regions per call (got ${list.length})`)

  const mode = raw.mode === undefined || raw.mode === null ? 'bicubic' : String(raw.mode).toLowerCase()
  if (!Object.hasOwn(KERNELS, mode)) {
    fail(`"mode" must be one of ${Object.keys(KERNELS).join(', ')} (got "${raw.mode}")`)
  }

  let scale
  if (raw.scale !== undefined && raw.scale !== null) {
    const n = Number(raw.scale)
    if (!Number.isFinite(n) || n < 1) fail(`"scale" must be a number >= 1 (got ${JSON.stringify(raw.scale)})`)
    scale = Math.min(MAX_SCALE, Math.max(1, Math.round(n)))
  }

  let target = DEFAULT_TARGET
  if (raw.target !== undefined && raw.target !== null) {
    const n = Number(raw.target)
    if (!Number.isFinite(n) || n < 16) fail(`"target" must be a number >= 16 (got ${JSON.stringify(raw.target)})`)
    target = Math.min(16000, Math.round(n))
  }

  let previewWidth
  if (raw.previewWidth !== undefined && raw.previewWidth !== null) {
    const n = Number(raw.previewWidth)
    if (!Number.isFinite(n) || n <= 0) fail(`"previewWidth" must be a positive number (got ${JSON.stringify(raw.previewWidth)})`)
    previewWidth = Math.round(n)
  }

  let outPath
  if (typeof raw.outPath === 'string' && raw.outPath.trim().length > 0) {
    outPath = resolve(raw.outPath.trim())
    if (extname(outPath).toLowerCase() !== '.png') fail('"outPath" must end in .png')
  }

  return {
    source: resolve(source),
    regions: list.map((region, index) => parseRegion(region, index)),
    scale,
    target,
    mode,
    sheet: raw.sheet === undefined ? true : raw.sheet !== false,
    outPath,
    previewWidth,
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function stemOf(source) {
  const raw = basename(source, extname(source))
  const safe = raw.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')
  return (safe.length > 0 ? safe : 'image').slice(0, 40)
}

function captionSvg(text, width) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CAPTION_H}">` +
      `<rect width="100%" height="100%" fill="${CAPTION_BG}"/>` +
      `<text x="4" y="${CAPTION_H - 11}" font-family="Consolas,Menlo,DejaVu Sans Mono,Liberation Mono,monospace" font-size="16" fill="${CAPTION_FG}">${escapeXml(text)}</text>` +
      `</svg>`,
  )
}

function captionFor(region) {
  const label = region.label ? ` ${region.label}` : ''
  return `#${region.index}${label}  x=${region.x} y=${region.y} ${region.width}x${region.height}  x${region.scale}  -> ${region.outWidth}x${region.outHeight}`
}

/**
 * Crop and magnify every requested region.
 *
 * @param {object} raw Tool/CLI arguments (see normalizeRequest).
 * @returns {Promise<object>} a JSON-serialisable result describing what was written.
 */
export async function cropZoom(raw) {
  const request = normalizeRequest(raw)
  const sharp = await loadSharp()

  let input
  try {
    input = await readFile(request.source)
  } catch (error) {
    fail(`cannot read ${request.source}: ${error.message}`)
  }

  let meta
  try {
    meta = await sharp(input).metadata()
  } catch (error) {
    fail(`not a decodable image: ${request.source} (${error.message})`)
  }

  // An EXIF-rotated photo has two sizes: the stored pixels and the display size
  // every viewer shows. Regions are always measured on what the caller saw, so
  // the display size is the one that bounds them.
  const display = meta.autoOrient && meta.autoOrient.width ? meta.autoOrient : meta
  const sourceWidth = display.width
  const sourceHeight = display.height
  if (!sourceWidth || !sourceHeight) fail(`could not determine the pixel size of ${request.source}`)

  const ratio = request.previewWidth ? sourceWidth / request.previewWidth : 1

  const regions = request.regions.map((region, index) => {
    let { x, y, width, height } = region
    if (ratio !== 1) {
      x = Math.round(x * ratio)
      y = Math.round(y * ratio)
      width = Math.max(MIN_SIDE, Math.round(width * ratio))
      height = Math.max(MIN_SIDE, Math.round(height * ratio))
    }
    if (x + width > sourceWidth || y + height > sourceHeight) {
      fail(
        `region #${index + 1}: ${x},${y} ${width}x${height} falls outside the ${sourceWidth}x${sourceHeight} image` +
          (ratio !== 1 ? ` (after rescaling from a ${request.previewWidth}px preview)` : ''),
      )
    }
    const scale =
      request.scale ?? Math.min(MAX_SCALE, Math.max(1, Math.ceil(request.target / Math.max(width, height))))
    return {
      index: index + 1,
      label: region.label,
      x,
      y,
      width,
      height,
      scale,
      outWidth: width * scale,
      outHeight: height * scale,
    }
  })

  const kernel = KERNELS[request.mode]
  const pieces = []
  for (const region of regions) {
    let buffer
    try {
      buffer = await sharp(input)
        .rotate()
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .resize({ width: region.outWidth, height: region.outHeight, kernel, fit: 'fill' })
        .png()
        .toBuffer()
    } catch (error) {
      fail(`region #${region.index} could not be rendered: ${error.message}`)
    }
    pieces.push({ ...region, buffer })
  }

  const outDir = request.outPath ? dirname(request.outPath) : defaultOutDir()
  try {
    await mkdir(outDir, { recursive: true })
  } catch (error) {
    fail(`cannot create output directory ${outDir}: ${error.message}`)
  }
  const stem = stemOf(request.source)

  const written = []
  let sheetPath = null
  let sheetWidth = 0
  let sheetHeight = 0

  if (request.sheet) {
    sheetWidth = Math.max(...pieces.map((piece) => piece.outWidth)) + PAD * 2
    sheetHeight = PAD + pieces.reduce((sum, piece) => sum + CAPTION_H + piece.outHeight + PAD, 0)
    const layers = []
    let top = PAD
    for (const piece of pieces) {
      layers.push({ input: captionSvg(captionFor(piece), sheetWidth - PAD * 2), top, left: PAD })
      top += CAPTION_H
      layers.push({ input: piece.buffer, top, left: PAD })
      top += piece.outHeight + PAD
    }
    let sheet
    try {
      sheet = await sharp({
        create: { width: sheetWidth, height: sheetHeight, channels: 4, background: SHEET_BG },
      })
        .composite(layers)
        .png()
        .toBuffer()
    } catch (error) {
      fail(`could not build the sheet: ${error.message}`)
    }
    sheetPath = request.outPath ?? join(outDir, `${stem}-${stamp()}.png`)
    try {
      await writeFile(sheetPath, sheet)
    } catch (error) {
      fail(`cannot write ${sheetPath}: ${error.message}`)
    }
  } else {
    const at = stamp()
    for (const piece of pieces) {
      const target = request.outPath
        ? request.outPath.replace(/\.png$/i, `-r${piece.index}.png`)
        : join(outDir, `${stem}-${at}-r${piece.index}.png`)
      try {
        await writeFile(target, piece.buffer)
      } catch (error) {
        fail(`cannot write ${target}: ${error.message}`)
      }
      written.push(target)
      piece.outPath = target
    }
  }

  return {
    source: request.source,
    sourceWidth,
    sourceHeight,
    mode: request.mode,
    sheetPath: sheetPath ?? '',
    sheetWidth,
    sheetHeight,
    regions: pieces.map((piece) => ({
      index: piece.index,
      ...(piece.label === undefined ? {} : { label: piece.label }),
      x: piece.x,
      y: piece.y,
      width: piece.width,
      height: piece.height,
      scale: piece.scale,
      outWidth: piece.outWidth,
      outHeight: piece.outHeight,
      outPath: piece.outPath ?? sheetPath,
    })),
    files: sheetPath ? [sheetPath] : written,
  }
}

/** The human/agent-readable half of the tool result. */
export function formatResult(result) {
  const lines = []
  lines.push(
    `${result.files.length} file${result.files.length === 1 ? '' : 's'} written from ${result.source} (${result.sourceWidth}x${result.sourceHeight}), kernel ${result.mode}.`,
  )
  lines.push('')
  for (const region of result.regions) {
    const label = region.label ? ` "${region.label}"` : ''
    lines.push(
      `#${region.index}${label}  source ${region.x},${region.y} ${region.width}x${region.height}  x${region.scale}  -> ${region.outWidth}x${region.outHeight}`,
    )
  }
  lines.push('')
  if (result.sheetPath) {
    lines.push(`Sheet (regions stacked top to bottom, in the order above): ${result.sheetPath}`)
  } else {
    for (const file of result.files) lines.push(`File: ${file}`)
  }
  lines.push('')
  lines.push('Now read that file with read_image. Do not answer from this geometry summary alone.')
  return lines.join('\n')
}

export { KERNELS }
