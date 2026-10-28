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

test('Claude streams summaries immediately and preserves signatures through tool rounds', async t => {
  let finish
  const ending = new Promise(resolve => { finish = resolve })
  t.after(() => finish())
  let round = 0
  const f = await fixture(t, async (req, res) => {
    const first = ++round === 1
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    send({ type: 'message_start', message: { id: 'msg_test', model: req.body.model, usage: { input_tokens: 3, output_tokens: 0 } } })
    if (first) {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Public summary.' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'OPAQUE_SIGNATURE' } })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_one', name: 'read', input: {} } })
      await ending
      send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"input.txt"}' } })
      send({ type: 'content_block_stop', index: 1 })
    } else {
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } })
      send({ type: 'content_block_stop', index: 0 })
    }
    send({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
    send({ type: 'message_stop' }); res.end()
  }, { id: 'claude-opus-5-5', api: 'anthropic-messages', reasoning: true, preferNativeResponses: false, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  f.bridge.getThinking = () => 'xhigh'
  const activity = []; f.bridge.onProviderActivity = type => activity.push(type)
  const tools = [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
  const response = await f.request({ tools })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  let output = ''
  while (!output.includes('Public summary.')) { const chunk = await reader.read(); assert.equal(chunk.done, false); output += new TextDecoder().decode(chunk.value) }
  assert.match(output, /response.created/)
  assert.ok(!output.includes('response.completed'))
  assert.ok(!output.includes('function_call_arguments.done'))
  assert.deepEqual(f.requests[0].body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(f.requests[0].body.output_config.effort, 'xhigh')
  assert.equal(f.requests[0].body.fallbacks, undefined)
  finish()
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value) }
  assert.deepEqual(activity, ['thinking_start', 'toolcall_start'])
  const events = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const result = events.find(event => event.type === 'response.completed').response
  assert.deepEqual(result.output[0].summary, [{ type: 'summary_text', text: 'Public summary.' }])
  assert.ok(!JSON.stringify(events.filter(event => event.type.includes('summary'))).includes('OPAQUE_SIGNATURE'))
  const next = await f.request({ tools, input: [ ...result.output, { type: 'function_call_output', call_id: 'tool_one', output: 'FILE_CONTENT' } ] })
  assert.match(await next.text(), /Done\./)
  const history = f.requests[1].body.messages.find(message => message.role === 'assistant')
  assert.deepEqual(history.content.find(part => part.type === 'thinking'), { type: 'thinking', thinking: 'Public summary.', signature: 'OPAQUE_SIGNATURE' })
})

for (const [id, level, expectedThinking, effort] of [
  ['claude-opus-5-5', 'auto', { type: 'adaptive', display: 'summarized' }, undefined],
  ['claude-opus-5', 'xhigh', { type: 'adaptive', display: 'summarized' }, 'xhigh'],
  ['claude-opus-4-6', 'auto', undefined, undefined],
  ['claude-sonnet-5-5', 'between_tools', { type: 'between_tools', display: 'summarized' }, 'high'],
]) test(`Claude native configuration: ${id} ${level}`, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(400); res.end('{"type":"error","error":{"type":"invalid_request_error","message":"fixture completed"}}') }, { id, api: 'anthropic-messages', reasoning: true, preferNativeResponses: false })
  f.bridge.getThinking = () => level
  assert.equal((await f.request()).status, 400)
  assert.deepEqual(f.requests[0].body.thinking, expectedThinking)
  assert.equal(f.requests[0].body.output_config?.effort, effort)
  assert.equal(f.requests[0].body.fallbacks, undefined)
})

test('Claude native stream errors retain their diagnostic after response headers', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'msg_error', model: req.body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Claude fixture overloaded' } },
    ]
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  }, { id: 'claude-opus-5-5', api: 'anthropic-messages', preferNativeResponses: false, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  const response = await f.request()
  const body = await response.text()
  assert.match(body, /response.failed/)
  assert.match(body, /Claude fixture overloaded/)
  assert.doesNotMatch(body, /response.completed/)
})
