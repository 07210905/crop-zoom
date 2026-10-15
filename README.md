# dsh-crop-zoom

**Magnify a region of an image so small text becomes readable.**

A [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh`) plugin that registers a
`crop_zoom` tool, plus the same engine as a standalone CLI.
[中文说明 →](README.zh-CN.md)

- Local image processing only — no network, no model call, no OCR engine.
- One dependency: `sharp` (libvips), loaded lazily so a missing native build can never stop the harness from booting.
- Node ≥ 22. MIT.

---

## The problem this solves

A 1920×1080 screenshot does not reach a model at 1920×1080. It is downscaled on the way
in, so a 10–11px item label arrives with its strokes already fused — and re-reading the
same screenshot cannot bring those pixels back.

Four readings off one status screen, every one of them wrong in the same way:

| Printed | Came back as | Why |
| --- | --- | --- |
| `03重型盔` | `D3重型盔` | at 11px the `0` and the `D` share one left stem |
| `BT6重型` | `B16重型` | the `T` welds itself onto the `B` before it |
| `1000戰地包` | `100D戰地包` | four digits merge into three plus a letter |
| `鎏影權鋒` | `盜影權杖` | the 金 under 鎏 collapses into something 皿-shaped |

Those characters are perfectly legible once the region is cropped out and upscaled.
Doing that *before* the text is read is the only reliable order of operations, and it
costs far less than pushing the whole screenshot through again.

## Install as a dsh plugin

```bash
dsh plugin --profile <profile> add dsh-crop-zoom     # from a registry
dsh plugin --profile <profile> add ./dsh-crop-zoom   # from a local checkout
```

Then restart the app. The model gains a `crop_zoom` tool, re-sent with every request.

## Install as a CLI

```bash
npm install -g dsh-crop-zoom
crop-zoom -i shot.png -r 1178,588,64,24 -s 16 -o label.png
```

## Using the tool

```jsonc
// One region, auto-magnified until its long edge reaches 1600px
{ "path": "C:\\shots\\raid.png", "regions": [{ "x": 1178, "y": 588, "width": 64, "height": 24 }] }

// Two regions, stacked into a single labelled sheet so one follow-up read covers both
{ "path": "C:\\shots\\raid.png",
  "regions": [{ "x": 80, "y": 430, "width": 540, "height": 300, "label": "rank board" },
              { "x": 875, "y": 155, "width": 450, "height": 660, "label": "gear" }],
  "target": 2400 }

// Still ambiguous? nearest replicates pixels, which separates equal-width glyphs
{ "path": "C:\\shots\\raid.png", "regions": [{ "x": 1444, "y": 373, "width": 96, "height": 42 }],
  "scale": 16, "mode": "nearest" }
```

The tool writes PNG file(s) and returns their paths; read the result with `read_image`.
The text it returns is geometry only — deliberately, so it cannot be mistaken for the
answer:

```
1 file written from C:\shots\raid.png (1920x1080), kernel bicubic.

#1  source 1178,588 64x24  x12  -> 768x288
#2  source 1444,373 96x42  x12  -> 1152x504

Sheet (regions stacked top to bottom, in the order above): C:\...\raid-20261014181815.png

Now read that file with read_image. Do not answer from this geometry summary alone.
```

### Parameters

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | string | — | Absolute path to the source image. Required. |
| `regions` | array | — | 1–8 regions, in sheet order. Required. Each is `{x, y, width, height, label?}` in **source** pixels. |
| `scale` | integer | — | Integer magnification, 1–16. Omit to derive it from `target`. |
| `target` | integer | `1600` | With no `scale`, magnify until the region's longer edge reaches this many pixels, capped at 16×. |
| `mode` | enum | `bicubic` | `bicubic` \| `nearest` \| `lanczos` \| `mitchell`. |
| `sheet` | boolean | `true` | Stack every region into one labelled PNG. `false` writes one file per region. |
| `outPath` | string | temp dir | Where to write; must end in `.png`. |
| `previewWidth` | integer | — | Set this when the coordinates were measured on a downscaled preview: pass that preview's pixel width and every coordinate is rescaled to the source automatically. |

`bicubic` preserves glyph outlines and is the right default. `nearest` replicates whole
pixels, which is what separates a `0` from a `D` — the two are complements, so when a
character still will not resolve, look at it both ways.

### CLI

```
crop-zoom -i <image> -r <x,y,w,h> [-r <x,y,w,h> ...] [options]

  -i, --image <path>        Source image (PNG, JPEG, WebP, AVIF, TIFF or GIF)
  -r, --region <x,y,w,h>    Region to magnify; repeat up to 8 times
  -s, --scale <n>           Integer magnification, 1..16
  -t, --target <px>         Auto-magnification target (default 1600)
  -m, --mode <kernel>       bicubic (default) | nearest | lanczos | mitchell
  -o, --out <file.png>      Output path, or path stem when writing one per region
      --preview-width <px>  Coordinates came from a preview of this pixel width
      --no-sheet            One file per region instead of one stacked sheet
      --json                Also print the raw result object
  -h, --help                Show this message
```

## How it works

1. Decode the source once into memory. Regions are bounded against the *display* size
   (after EXIF rotation), so an upright photo is cropped where it looks upright.
2. `extract` each region, then `resize` by an integer factor with the selected kernel —
   integer scaling avoids resampling artefacts on exactly the strokes you are trying to read.
3. Optionally composite the pieces into one sheet, captioned with the geometry of each
   region, so a multi-region check costs one follow-up read rather than several.

## Limits

- **Local files only.** Remote URLs are not fetched; that keeps the tool from becoming an
  outbound request channel on the model's behalf.
- Output is always PNG.
- 8 regions and 16× per call.
- Sheet captions are ASCII; non-Latin caption text depends on the fonts fontconfig
  exposes to librsvg, so put non-ASCII descriptions in the region `label` rather than
  expecting them on the image.

## Development

```bash
npm install
npm test        # core geometry suite + plugin contract suite
```

`test/run.mjs` builds its own synthetic image and asserts exact output geometry.
`test/plugin.mjs` exercises `apply()` against a stub `ctx` and checks that a throwing
registry cannot escape.

## License

MIT
