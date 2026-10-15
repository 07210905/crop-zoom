// dsh plugin: registers the crop_zoom tool.
//
// The gap this fills is not "read an image", it is "read an image that arrived
// too small to read". A registered tool schema is re-sent with every request, so
// the model is reminded the escape hatch exists every time it touches a
// screenshot; a prompt-triggered skill depends on the model remembering to look
// for it. That difference is the whole reason this ships as a plugin.
//
// Deliberately standalone: only the package's own module entry and plain JSON
// Schema are used. Out-of-tree resolution of @deepseek-ai/dsh-tools is not
// reliable for third-party plugins, and the developer-preview registry accepts
// raw schemas.

import { CropZoomError, DEFAULT_TARGET, MAX_REGIONS, MAX_SCALE, cropZoom, formatResult } from '../lib/crop.js'

export const name = 'crop-zoom'
export const inject = ['tools']

const DESCRIPTION = [
  'Magnify one or more regions of an image so small text becomes legible.',
  '',
  'Call this BEFORE trusting any reading of small text: model numbers, serials, item names,',
  'table cells, status labels, or anything under roughly 14px tall in the source. A 1920x1080',
  'screenshot is delivered downscaled, so 10-11px glyphs arrive with merged strokes and',
  '0/D, 1/T, 1000/100D, 糸/田 and 金/皿 stop being distinguishable. Re-reading the same full',
  'screenshot cannot fix that - the pixels are already gone - but cropping the region out and',
  'upscaling it can.',
  '',
  'This writes PNG file(s) and returns their paths; read the output with read_image. In the',
  'default sheet mode every region is stacked into one labelled image, so several regions cost',
  'one follow-up read instead of several.',
  '',
  'mode "bicubic" (the default) keeps glyph outlines readable. mode "nearest" replicates whole',
  'pixels, which is better for separating two glyphs of equal width such as 0 and D. When a',
  'character is still ambiguous, look at it both ways.',
  '',
  'Local image processing only: no network, no model call, no OCR engine.',
].join('\n')

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      description: 'Absolute local path of the source image (PNG, JPEG, WebP, AVIF, TIFF or GIF).',
    },
    regions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_REGIONS,
      description: `Regions to magnify, in the order they should appear from top to bottom in the sheet. At most ${MAX_REGIONS}.`,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer', description: 'Left edge, in source pixels.' },
          y: { type: 'integer', description: 'Top edge, in source pixels.' },
          width: { type: 'integer', description: 'Region width in source pixels (at least 4).' },
          height: { type: 'integer', description: 'Region height in source pixels (at least 4).' },
          label: { type: 'string', description: 'Optional short label, echoed back and drawn on the sheet caption.' },
        },
        required: ['x', 'y', 'width', 'height'],
      },
    },
    scale: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SCALE,
      description: `Integer magnification, 1..${MAX_SCALE}. Omit to derive it from target instead.`,
    },
    target: {
      type: 'integer',
      minimum: 16,
      maximum: 16000,
      description: `When scale is omitted, magnify each region until its longer edge reaches this many pixels, capped at ${MAX_SCALE}x. Default ${DEFAULT_TARGET}.`,
    },
    mode: {
      type: 'string',
      enum: ['bicubic', 'nearest', 'lanczos', 'mitchell'],
      description: 'Resampling kernel. bicubic (default) preserves outlines; nearest replicates pixels.',
    },
    sheet: {
      type: 'boolean',
      description: 'Stack every region into one labelled PNG (default true). false writes one file per region.',
    },
    outPath: {
      type: 'string',
      description: 'Where to write, a .png path. Defaults to a crop-zoom folder inside the system temp directory.',
    },
    previewWidth: {
      type: 'integer',
      minimum: 1,
      description:
        'Only when the coordinates were measured on a downscaled preview: pass that preview\u2019s pixel width and every coordinate is rescaled to the full-size source automatically.',
    },
  },
  required: ['path', 'regions'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    sourceWidth: { type: 'integer' },
    sourceHeight: { type: 'integer' },
    mode: { type: 'string' },
    sheetPath: { type: 'string', description: 'Path of the stacked sheet, or an empty string when sheet was false.' },
    sheetWidth: { type: 'integer' },
    sheetHeight: { type: 'integer' },
    files: { type: 'array', items: { type: 'string' } },
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          label: { type: 'string' },
          x: { type: 'integer' },
          y: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          scale: { type: 'integer' },
          outWidth: { type: 'integer' },
          outHeight: { type: 'integer' },
          outPath: { type: 'string' },
        },
        required: ['index', 'x', 'y', 'width', 'height', 'scale', 'outWidth', 'outHeight', 'outPath'],
      },
    },
  },
  required: ['source', 'sourceWidth', 'sourceHeight', 'mode', 'sheetPath', 'files', 'regions'],
}

function createTool(toolName) {
  return {
    name: toolName,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : formatResult(value) },
      ],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName,
      kind: 'read',
      rawInput: args,
      ...(args && typeof args.path === 'string' ? { locations: [{ path: args.path }] } : {}),
    }),
    async execute(args) {
      try {
        return await cropZoom(args ?? {})
      } catch (error) {
        if (error instanceof CropZoomError) throw new Error(`${toolName}: ${error.message}`)
        throw error
      }
    },
  }
}

export function apply(ctx, config = {}) {
  const toolName =
    typeof config.toolName === 'string' && config.toolName.trim().length > 0 ? config.toolName.trim() : 'crop_zoom'
  try {
    ctx.tools.register(createTool(toolName))
  } catch (error) {
    // A broken tool must never stop the harness from booting.
    console.error(`[crop-zoom] ${toolName} registration skipped: ${error}`)
  }
}
