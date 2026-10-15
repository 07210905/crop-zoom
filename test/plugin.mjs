// Verifies the dsh plugin contract without a running harness.
//
//   node test/plugin.mjs
//
// apply() must register exactly one well-formed tool on ctx.tools, that tool must
// actually run, and a broken registry must never throw out of apply() - a plugin
// that stops the harness from booting is worse than a plugin that does nothing.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

import { apply, inject, name } from '../dsh/index.js'

const dir = await mkdtemp(join(tmpdir(), 'crop-zoom-plugin-'))
const source = join(dir, 'source.png')
await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })
  .png()
  .toFile(source)

assert.equal(name, 'crop-zoom')
assert.deepEqual(inject, ['tools'])

const registered = []
apply({ tools: { register: (tool) => registered.push(tool) } }, {})

assert.equal(registered.length, 1, 'apply() must register exactly one tool')
const tool = registered[0]

assert.equal(tool.name, 'crop_zoom')
assert.equal(typeof tool.description, 'string')
assert.ok(tool.description.length > 100, 'the description is the only thing that makes the model reach for it')
assert.deepEqual(tool.parameters.required, ['path', 'regions'])
assert.equal(tool.parameters.additionalProperties, false)
assert.equal(tool.parameters.properties.regions.maxItems, 8)
assert.equal(typeof tool.output.schema, 'object')
assert.equal(typeof tool.output.render, 'function')
assert.equal(typeof tool.execute, 'function')
assert.equal(typeof tool.presentCall, 'function')
assert.equal(tool.isConcurrencySafe(), true)
assert.ok(tool.timeoutMs > 0)

const call = tool.presentCall({ path: source, regions: [{ x: 0, y: 0, width: 10, height: 10 }] })
assert.equal(call.kind, 'read')
assert.equal(call.title, 'crop_zoom')
assert.deepEqual(call.locations, [{ path: source }])
assert.equal(tool.presentCall({}).locations, undefined, 'no path, no location to report')

const value = await tool.execute({ path: source, regions: [{ x: 0, y: 0, width: 100, height: 50 }], scale: 2 })
assert.equal(value.sheetWidth, 240)
assert.equal(value.sheetHeight, 20 + 34 + 100 + 20)
assert.equal(value.regions[0].outWidth, 200)

const rendered = tool.output.render(null, value)
assert.equal(rendered.length, 1)
assert.equal(rendered[0].type, 'text')
assert.match(rendered[0].text, /read_image/)

await assert.rejects(
  () => tool.execute({ path: source, regions: [{ x: 999, y: 0, width: 10, height: 10 }] }),
  (error) => {
    assert.equal(error.name, 'Error', 'failures must be plain Errors, not a private class')
    assert.match(error.message, /crop_zoom: region #1/)
    return true
  },
)

const custom = []
apply({ tools: { register: (t) => custom.push(t) } }, { toolName: '  magnify_region  ' })
assert.equal(custom[0].name, 'magnify_region')

const originalError = console.error
console.error = () => {}
try {
  apply(
    {
      tools: {
        register: () => {
          throw new Error('registry offline')
        },
      },
    },
    {},
  )
} finally {
  console.error = originalError
}

await rm(dir, { recursive: true, force: true })
process.stdout.write('plugin contract: ok\n')
