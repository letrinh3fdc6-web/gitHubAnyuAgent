'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { Readable, PassThrough } = require('node:stream')
const { ImagePreviews, readModelInput, MAX_PREVIEW_BYTES } = require('../codex-input.cjs')
const { CodexTools } = require('../codex-tools.cjs')

function png() {
  const requirePi = createRequire(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/package.json'))
  const { PhotonImage } = requirePi('@silvia-odwyer/photon-node')
  const image = new PhotonImage(crypto.randomBytes(768 * 768 * 4), 768, 768)
  try { return Buffer.from(image.get_bytes()) } finally { image.free() }
}
const stream = value => Readable.from([Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))])

test('streamed JSON preserves text, tool arguments, key semantics and non-image data', async () => {
  const body = JSON.parse('{"model":"test","__proto__":{"polluted":true},"input":[{"role":"user","content":"\u4e2d\u6587\\n\\t\\\""},{"type":"function_call","arguments":"{\\\"image_url\\\":\\\"data:image/png;base64,example\\\"}"}],"metadata":{"image_url":"data:image/png;base64,example","numbers":[1,-1.2,null,false,true,1e5]}}')
  const previews = { url: () => { throw new Error('Must not inspect ordinary data') } }
  const result = await readModelInput(stream(body), previews)
  assert.deepEqual(result, body)
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal({}.polluted, undefined)
  const bytes = Buffer.from(JSON.stringify(body))
  const fragments = Readable.from((function* () { for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3) })())
  assert.deepEqual(await readModelInput(fragments, previews), body)
})

test('real image previews are bounded, cached and leave originals intact', async () => {
  const original = png(), hash = crypto.createHash('sha256').update(original).digest('hex')
  const url = `data:image/png;base64,${original.toString('base64')}`
  const previews = new ImagePreviews()
  const result = await previews.url(url)
  assert.ok(result.url.length < MAX_PREVIEW_BYTES)
  const calls = previews.resize
  previews.resize = () => { throw new Error('Repeated image must use the bounded cache') }
  assert.deepEqual(await previews.url(url), result)
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), hash)
  assert.equal(await previews.url('https://example.test/image.png').then(x => x.url), 'https://example.test/image.png')
  assert.ok(previews.cacheBytes <= 16 * 1024 * 1024)
  previews.clear()
  assert.equal(previews.cacheBytes, 0)
  assert.equal(previews.cache.size, 0)
  previews.resize = calls
})

test('only Responses image content is resized, independent of property order', async () => {
  let count = 0
  const previews = { url: async url => { count++; return { url: 'data:image/jpeg;base64,small', note: 'preview dimensions' } } }
  const image = { image_url: 'data:image/png;base64,original', detail: 'high', type: 'input_image' }
  const body = { model: 'test', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'reference' }, image] },
    { call_id: 'one', output: [image, { type: 'input_text', text: 'stored on disk' }], type: 'function_call_output' },
    { type: 'function_call', arguments: JSON.stringify(image), name: 'write' },
  ], metadata: { content: [image] } }
  const result = await readModelInput(stream(body), previews)
  assert.equal(count, 2)
  assert.equal(result.input[0].content[2].detail, 'high')
  assert.equal(result.input[1].output[1].image_url, 'data:image/jpeg;base64,small')
  assert.equal(result.input[1].output[2].text, 'stored on disk')
  assert.equal(result.input[2].arguments, body.input[2].arguments)
  assert.deepEqual(result.metadata, body.metadata)
  assert.equal(body.input[0].content[1].image_url, image.image_url)
})

test('text, raw transport, escaped strings and uncompressible images retain hard limits', async () => {
  const previews = new ImagePreviews({ resize: async () => null })
  await assert.rejects(readModelInput(stream({ input: 'x'.repeat(4096) }), previews, undefined, { maxModelBytes: 2048 }), { status: 413, code: 'MODEL_INPUT_TOO_LARGE' })
  await assert.rejects(readModelInput(stream({ input: 'x'.repeat(4096) }), previews, undefined, { maxHistoryBytes: 2048 }), { status: 413 })
  await assert.rejects(readModelInput(stream({ input: '\u0000'.repeat(100) }), previews, undefined, { maxModelBytes: 512 }), { status: 413 })
  await assert.rejects(previews.url('data:image/png;base64,' + 'a'.repeat(MAX_PREVIEW_BYTES)), { status: 413, code: 'MODEL_IMAGE_PREVIEW_FAILED' })
  await assert.rejects(readModelInput(stream({ input: [{ content: [{ type: 'input_text', image_url: 'x'.repeat(4096), text: 'do not bypass limit' }] }] }), previews, undefined, { maxModelBytes: 2048 }), { status: 413 })
})

test('invalid JSON fails with 400, abort releases the parser, and a subsequent request works', async () => {
  const previews = new ImagePreviews()
  for (const value of ['{', '{"input":', 'null', '[]', '{"x":1}{"y":2}']) await assert.rejects(readModelInput(stream(value), previews), { status: 400 })
  const controller = new AbortController(), request = new PassThrough()
  const reading = readModelInput(request, previews, controller.signal)
  request.write('{"input":"partial')
  controller.abort()
  await assert.rejects(reading, { name: 'AbortError' })
  request.destroy()
  assert.deepEqual(await readModelInput(stream({ model: 'ok' }), previews), { model: 'ok' })
})

test('preview cache evicts by size and never caches failures', async () => {
  let count = 0
  const previews = new ImagePreviews({ cacheBytes: 150, resize: async () => { count++; return { data: 'x'.repeat(64), mimeType: 'image/png' } } })
  const first = 'data:image/png;base64,' + 'a'.repeat(MAX_PREVIEW_BYTES)
  const second = 'data:image/png;base64,' + 'b'.repeat(MAX_PREVIEW_BYTES)
  await previews.url(first); await previews.url(second); await previews.url(first)
  assert.equal(count, 3)
  assert.ok(previews.cacheBytes <= 150)
  assert.equal(previews.cache.size, 1)
  previews.resize = async () => null
  await assert.rejects(previews.url(second))
  assert.equal(previews.cache.size, 1)
})

test('tool image boundary keeps original UI result and does not repeat a completed tool', async () => {
  const result = { content: [{ type: 'text', text: 'Created: project/frame.png' }, { type: 'image', data: 'a'.repeat(MAX_PREVIEW_BYTES), mimeType: 'image/png' }] }
  let calls = 0
  const events = []
  const previews = new ImagePreviews({ resize: async () => ({ data: 'small', mimeType: 'image/jpeg' }) })
  const tools = new CodexTools({ cwd: process.cwd(), emit: event => events.push(event), imagePreviews: previews })
  tools.validate = (_tool, call) => call.arguments
  tools.tools.set('create', { execute: async () => { calls++; return result } })
  const value = await tools.execute({ tool: 'create', callId: 'one', arguments: {} })
  assert.equal(calls, 1)
  assert.equal(value.success, true)
  assert.equal(value.contentItems[1].imageUrl, 'data:image/jpeg;base64,small')
  assert.equal(events.at(-1).result, result)
  assert.equal(result.content[1].data.length, MAX_PREVIEW_BYTES)
  previews.clear(); previews.resize = async () => null
  const failed = await tools.execute({ tool: 'create', callId: 'two', arguments: {} })
  assert.equal(calls, 2)
  assert.equal(failed.success, false)
  assert.match(failed.contentItems.at(-1).text, /already finished.*Do not repeat/)
  assert.equal(failed.contentItems[0].text, 'Created: project/frame.png')
})

