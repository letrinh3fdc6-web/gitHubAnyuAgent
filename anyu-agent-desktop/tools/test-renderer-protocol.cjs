const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { createRendererHandler } = require('../renderer-protocol.cjs')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-renderer-protocol-'))
fs.mkdirSync(path.join(directory, 'assets'))
fs.writeFileSync(path.join(directory, 'index.html'), 'app shell')
fs.writeFileSync(path.join(directory, 'assets', 'workspace.css'), '.workspace { display: grid }')
after(() => fs.rmSync(directory, { recursive: true, force: true }))
const handler = fetchApi => createRendererHandler({
  rendererFile: path.join(directory, 'index.html'),
  apiBase: 'http://127.0.0.1:8080',
  readAsset: async url => new Response(fs.readFileSync(fileURLToPath(url))),
  fetchApi
})
const request = (route, options) => new Request(`anyu-app://desktop${route}`, options)

test('loads bundled CSS and reloads nested routes through the app shell', async () => {
  const serve = handler()
  assert.match(await (await serve(request('/assets/workspace.css'))).text(), /display: grid/)
  assert.equal(await (await serve(request('/login?redirect=/anyu-agent'))).text(), 'app shell')
  assert.equal((await serve(request('/assets/missing.css'))).status, 404)
})

test('forwards multipart bytes, bearer auth and query strings to the configured API', async () => {
  const form = new FormData()
  form.append('prompt', 'a blue sky')
  form.append('reference_images', new Blob(['image bytes'], { type: 'image/png' }), 'reference.png')
  const source = request('/api/v1/anyu-ai/tasks?timezone=Asia%2FShanghai', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', Origin: 'anyu-app://desktop' }, body: form
  })
  const bytes = new Uint8Array(await source.clone().arrayBuffer())
  const serve = handler(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8080/api/v1/anyu-ai/tasks?timezone=Asia%2FShanghai')
    assert.equal(options.headers.get('authorization'), 'Bearer test-token')
    assert.equal(options.headers.get('origin'), null)
    assert.match(options.headers.get('content-type'), /^multipart\/form-data; boundary=/)
    assert.deepEqual(options.body, bytes)
    assert.ok(options.signal)
    return Response.json({ code: 0, data: { task_id: 'test-task' } })
  })
  assert.equal((await (await serve(source)).json()).data.task_id, 'test-task')
})

test('preserves error status and binary bodies while removing stale compression headers', async () => {
  const unauthorized = handler(async () => Response.json({ code: 401, message: 'expired' }, { status: 401 }))
  const error = await unauthorized(request('/api/v1/auth/me'))
  assert.equal(error.status, 401)
  assert.equal((await error.json()).message, 'expired')
  const bytes = new Uint8Array([137, 80, 78, 71])
  const download = handler(async () => new Response(bytes, {
    headers: { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': '99' }
  }))
  const image = await download(request('/api/v1/anyu-ai/tasks/test/images/0'))
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(image.headers.get('content-encoding'), null)
  assert.equal(image.headers.get('content-length'), null)
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes)
})

test('rejects other hosts, encoded filesystem traversal and writes to static assets', async () => {
  const serve = handler()
  assert.equal((await serve(new Request('anyu-app://other/index.html'))).status, 403)
  assert.equal((await serve(request('/..%2Fprivate.txt'))).status, 403)
  assert.equal((await serve(request('/..%5Cprivate.txt'))).status, 403)
  assert.equal((await serve(request('/C%3A/Windows/win.ini'))).status, 403)
  assert.equal((await serve(request('/assets/workspace.css', { method: 'POST', body: 'replacement' }))).status, 405)
})
