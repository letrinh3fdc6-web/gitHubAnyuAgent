'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { CodexProviderBridge, HISTORY_PREFIX } = require('../codex-provider.cjs')

async function fixture(t, handler, model = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = { url: req.url, body: JSON.parse(Buffer.concat(chunks)), headers: req.headers, port: req.socket.remotePort }
    requests.push(request)
    handler(request, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const bridge = await new CodexProviderBridge({
    model: { id: 'gpt-5.6-sol', api: 'openai-completions', provider: 'anyu-test', preferNativeResponses: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, input: ['text'], reasoning: false, ...model },
    credential: 'test-credential',
  }).start()
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const request = body => fetch(`${bridge.origin}/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json', 'x-session-id': 'session-test' },
    body: JSON.stringify({ model: bridge.model.id, stream: true, input: [{ role: 'user', content: 'hello' }], ...body }),
    signal: AbortSignal.timeout(5000),
  })
  return { bridge, requests, request }
}

test('native preference preserves Responses and streams before upstream completion', async t => {
  let finish
  const ending = new Promise(resolve => { finish = resolve })
  t.after(() => finish())
  const f = await fixture(t, async (_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"FIRST"}\n\n')
    await ending
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n')
  })
  const response = await f.request({ tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], reasoning: { effort: 'high' }, input: [{ type: 'reasoning', encrypted_content: HISTORY_PREFIX + 'old' }, { role: 'user', content: 'hello' }] })
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /FIRST/)
  assert.equal(f.requests[0].url, '/v1/responses')
  assert.equal(f.requests[0].body.reasoning.effort, 'high')
  assert.equal(f.requests[0].body.tools[0].name, 'read')
  assert.deepEqual(f.requests[0].body.input, [{ role: 'user', content: 'hello' }])
  assert.equal(f.requests[0].headers['x-session-id'], 'session-test')
  finish()
  let end = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; end += new TextDecoder().decode(chunk.value) }
  assert.match(end, /response.completed/)
  assert.equal(f.requests.length, 1)
})

test('only explicit managed protocol rejection falls back, then remembers Chat', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url.endsWith('/responses')) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 'ANYU_AGENT_PROTOCOL_MISMATCH', message: 'Protocol disabled' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: req.body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: req.body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  for (let i = 0; i < 2; i++) {
    const response = await f.request()
    assert.equal(response.status, 200)
    assert.match(await response.text(), /response.completed/)
  }
  assert.deepEqual(f.requests.map(r => r.url), ['/v1/responses', '/v1/chat/completions', '/v1/chat/completions'])
  assert.equal(f.bridge.preferNativeResponses, false)
})

for (const status of [400, 401, 403, 429, 502]) test(`native HTTP ${status} does not replay as Chat`, async t => {
  const body = JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: 'upstream rejected request' } })
  const f = await fixture(t, (_, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body) })
  const response = await f.request()
  assert.equal(response.status, status)
  assert.equal(await response.text(), body)
  assert.equal(f.requests.length, 1)
})

test('explicit Responses catalog never falls back even on protocol mismatch', async t => {
  const f = await fixture(t, (_, res) => { res.writeHead(403); res.end('{"code":"ANYU_AGENT_PROTOCOL_MISMATCH"}') }, { api: 'openai-responses' })
  assert.equal((await f.request()).status, 403)
  assert.equal(f.requests.length, 1)
})

test('native requests reuse their upstream connection', async t => {
  const f = await fixture(t, (_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: [DONE]\n\n') })
  for (let i = 0; i < 2; i++) await (await f.request()).text()
  assert.equal(f.requests[0].port, f.requests[1].port)
})
