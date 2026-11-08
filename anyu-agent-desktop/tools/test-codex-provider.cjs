'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { CodexProviderBridge, HISTORY_PREFIX } = require('../codex-provider.cjs')

async function fixture(t, handler, model = {}, options = {}) {
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
    ...options,
  }).start()
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const request = (body, timeout = 5000) => fetch(`${bridge.origin}/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json', 'x-session-id': 'session-test' },
    body: JSON.stringify({ model: bridge.model.id, stream: true, input: [{ role: 'user', content: 'hello' }], ...body }),
    signal: AbortSignal.timeout(timeout),
  })
  return { bridge, requests, request }
}

test('oversized storyboard history is resized before forwarding and a short follow-up succeeds', { timeout: 60000 }, async t => {
  const { createRequire } = require('node:module')
  const path = require('node:path')
  const requirePi = createRequire(path.resolve(__dirname, '../node_modules/@earendil-works/pi-coding-agent/package.json'))
  const { PhotonImage } = requirePi('@silvia-odwyer/photon-node')
  const image = new PhotonImage(require('node:crypto').randomBytes(768 * 768 * 4), 768, 768)
  let data
  try { data = Buffer.from(image.get_bytes()).toString('base64') } finally { image.free() }
  const count = Math.ceil(65 * 1024 * 1024 / data.length)
  const input = Array.from({ length: count }, (_, i) => [
    { type: 'function_call', call_id: `image_${i}`, name: 'read', arguments: JSON.stringify({ path: `story/frame_${i}.png` }) },
    { type: 'function_call_output', call_id: `image_${i}`, output: [{ type: 'input_text', text: `Frame ${i} ready on disk` }, { type: 'input_image', image_url: `data:image/png;base64,${data}` }] },
  ]).flat()
  const body = { input }
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 64 * 1024 * 1024)
  const sizes = []
  const f = await fixture(t, (request, res) => {
    sizes.push(Buffer.byteLength(JSON.stringify(request.body)))
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
  }, { api: 'openai-responses' })
  assert.equal((await f.request(body, 25000)).status, 200)
  input.push({ role: 'user', content: '1.' })
  assert.equal((await f.request(body, 25000)).status, 200)
  assert.equal(f.requests.length, 2)
  for (const size of sizes) assert.ok(size < 16 * 1024 * 1024)
  const results = f.requests.at(-1).body.input.filter(item => item.type === 'function_call_output')
  assert.equal(results.length, count)
  assert.ok(results.every(item => item.output.some(part => part.type === 'input_image')))
  assert.equal(f.requests.at(-1).body.input.at(-1).content, '1.')
  assert.equal(input[1].output[1].image_url, `data:image/png;base64,${data}`)
  t.diagnostic(`History ${Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 1024 / 1024)} MiB; forwarded ${Math.ceil(sizes[0] / 1024)} KiB; images ${count}`)
})

test('a preview failure returns an actionable 413 before calling upstream, without a socket reset', async t => {
  const { ImagePreviews, MAX_PREVIEW_BYTES } = require('../codex-input.cjs')
  const f = await fixture(t, () => assert.fail('Must not forward failed input'), {}, { imagePreviews: new ImagePreviews({ resize: async () => null }) })
  const response = await f.request({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'a'.repeat(MAX_PREVIEW_BYTES) }] }] })
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error.code, 'MODEL_IMAGE_PREVIEW_FAILED')
  assert.equal(f.requests.length, 0)
})

for (const api of ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai']) test(`conversation-only ${api} omits native and incremental tools`, async t => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'fixture completed', type: 'invalid_request_error' } }))
  }, { id: 'test', api, preferNativeResponses: false }, { conversationOnly: true })
  const tool = { type: 'function', name: 'write_file', parameters: { type: 'object', properties: {} } }
  const response = await f.request({ tools: [tool], tool_choice: 'required', input: [{ type: 'additional_tools', tools: [tool] }, { role: 'user', content: 'Say hello' }] })
  await response.text()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].body.tools?.length || 0, 0)
  assert.ok(!JSON.stringify(f.requests[0].body).includes('write_file'))
})

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

for (const api of ['openai-responses', 'openai-completions', 'google-generative-ai']) test(`${api} omits optional output limits even with a legacy catalog cap`, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"fixture completed"}}') }, { id: 'test-model', api, preferNativeResponses: false, maxTokens: 16384 })
  assert.equal((await f.request({ max_output_tokens: 1024, max_tokens: 2048, max_completion_tokens: 4096 })).status, 400)
  assert.equal(f.requests.length, 1)
  const body = f.requests[0].body
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.max_completion_tokens, undefined)
  assert.equal(body.max_output_tokens, undefined)
  assert.equal(body.generationConfig?.maxOutputTokens, undefined)
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

for (const [maxTokens, contextWindow, expected] of [[16384, 128000, 16384], [128000, 1000000, 128000], [128000, 8192, null]]) test(`Claude output metadata ${maxTokens}/${contextWindow} respects the selected cap and available context`, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(400); res.end('{"type":"error","error":{"type":"invalid_request_error","message":"fixture completed"}}') }, { id: 'claude-sonnet-5-5', api: 'anthropic-messages', preferNativeResponses: false, reasoning: true, maxTokens, contextWindow })
  f.bridge.getThinking = () => 'xhigh'
  assert.equal((await f.request()).status, 400)
  const body = f.requests[0].body
  if (expected) assert.equal(body.max_tokens, expected)
  else assert.ok(body.max_tokens > 0 && body.max_tokens < 4096)
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(body.output_config.effort, 'xhigh')
})

for (const partialTool of [false, true]) test(`Claude output limit is incomplete, retains history and never executes a truncated tool (${partialTool})`, async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'msg_limited', model: req.body.model, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Public summary.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'LIMIT_SIGNATURE' } },
      { type: 'content_block_stop', index: 0 },
      ...(partialTool ? [
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'truncated_call', name: 'write', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"unsafe.txt","content":"unfinished' } },
        { type: 'content_block_stop', index: 1 },
      ] : []),
      { type: 'content_block_start', index: partialTool ? 2 : 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: partialTool ? 2 : 1, delta: { type: 'text_delta', text: 'Partial answer.' } },
      { type: 'content_block_stop', index: partialTool ? 2 : 1 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 64 } },
      { type: 'message_stop' },
    ]
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  }, { id: 'claude-sonnet-5-5', api: 'anthropic-messages', preferNativeResponses: false, reasoning: true, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  const body = await (await f.request()).text()
  const events = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const result = events.find(event => event.type === 'response.incomplete')?.response
  assert.ok(result, body)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.incomplete_details.reason, 'max_output_tokens')
  assert.equal(result.usage.output_tokens, 64)
  assert.equal(result.output.find(item => item.type === 'message').content[0].text, 'Partial answer.')
  assert.equal(result.output.find(item => item.type === 'message').status, 'incomplete')
  assert.equal(result.output.filter(item => item.type === 'message').length, 1)
  assert.equal(events.filter(event => event.type === 'response.output_item.added' && event.item.type === 'message').length, 1)
  assert.ok(!events.some(event => event.item?.type === 'function_call'))
  assert.doesNotMatch(body, /response.failed|response.completed|function_call_arguments.done/)
  const history = JSON.parse(Buffer.from(result.output[0].encrypted_content.slice(HISTORY_PREFIX.length), 'base64').toString('utf8'))
  assert.equal(history.content.find(part => part.type === 'thinking').thinkingSignature, 'LIMIT_SIGNATURE')
  assert.ok(!history.content.some(part => part.type === 'toolCall'))
  assert.equal(history.stopReason, 'length')
})
