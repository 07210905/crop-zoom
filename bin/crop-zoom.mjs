#!/usr/bin/env node
// Standalone CLI over the same core the dsh tool uses.
//
//   crop-zoom -i shot.png -r 1048,523,57,21 -s 16 -o out.png
//   crop-zoom -i shot.png -r 80,430,540,300 -r 875,155,450,660 -t 2400
//
// -r may be repeated. Coordinates are [x, y, width, height] in source pixels.

import { resolve } from 'node:path'
import { CropZoomError, DEFAULT_TARGET, MAX_REGIONS, MAX_SCALE, cropZoom, formatResult } from '../lib/crop.js'

const USAGE = `crop-zoom - crop and magnify image regions

Usage:
  crop-zoom -i <image> -r <x,y,w,h> [-r <x,y,w,h> ...] [options]

Required:
  -i, --image <path>        Source image (PNG, JPEG, WebP, AVIF, TIFF or GIF)
  -r, --region <x,y,w,h>    Region to magnify; repeat up to ${MAX_REGIONS} times

Options:
  -s, --scale <n>           Integer magnification, 1..${MAX_SCALE}
  -t, --target <px>         With no --scale, magnify until the region's longer edge
                            reaches this many pixels (default ${DEFAULT_TARGET})
  -m, --mode <kernel>       bicubic (default) | nearest | lanczos | mitchell
  -o, --out <file.png>      Output path, or path stem when writing one file per region
      --preview-width <px>  Coordinates were measured on a downscaled preview of this
                            pixel width; rescale them to the source automatically
      --no-sheet            Write one file per region instead of one stacked sheet
      --json                Also print the raw result object
  -h, --help                Show this message

Writes PNG file(s) and prints their paths.`

const FLAGS = {
  '-i': 'path',
  '--image': 'path',
  '--path': 'path',
  '-r': 'regions',
  '--region': 'regions',
  '-s': 'scale',
  '--scale': 'scale',
  '-t': 'target',
  '--target': 'target',
  '-m': 'mode',
  '--mode': 'mode',
  '-o': 'outPath',
  '--out': 'outPath',
  '--out-path': 'outPath',
  '--preview-width': 'previewWidth',
  '--no-sheet': 'noSheet',
  '--json': 'json',
  '-h': 'help',
  '--help': 'help',
}

function parse(argv) {
  const parsed = { regions: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const key = FLAGS[token]
    if (!key) {
      throw new CropZoomError(`unknown option "${token}" (try --help)`)
    }
    if (key === 'noSheet' || key === 'json' || key === 'help') {
      parsed[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || FLAGS[value]) {
      throw new CropZoomError(`option "${token}" needs a value`)
    }
    index += 1
    if (key === 'regions') parsed.regions.push(value)
    else parsed[key] = value
  }
  return parsed
}

async function main() {
  let parsed
  try {
    parsed = parse(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
    return
  }

  if (parsed.help || process.argv.length <= 2) {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  if (!parsed.path) {
    process.stderr.write('error: --image is required\n')
    process.exitCode = 2
    return
  }
  if (parsed.regions.length === 0) {
    process.stderr.write('error: at least one --region is required\n')
    process.exitCode = 2
    return
  }

  try {
    // The core insists on an absolute path so that a tool call can never be
    // ambiguous about which file it meant. A human typing at a shell expects
    // the opposite. The CLI is where those two conventions meet.
    const result = await cropZoom({
      path: resolve(parsed.path),
      regions: parsed.regions,
      scale: parsed.scale,
      target: parsed.target,
      mode: parsed.mode,
      outPath: parsed.outPath,
      previewWidth: parsed.previewWidth,
      sheet: parsed.noSheet ? false : true,
    })
    process.stdout.write(`${formatResult(result)}\n`)
    if (parsed.json) process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`)
    process.exitCode = 1
  }
}

await main()
