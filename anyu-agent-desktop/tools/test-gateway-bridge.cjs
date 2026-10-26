const assert = require('assert')
const http = require('http')
const { ANYU_AGENT_GATEWAY_PATH, LocalGatewayBridge, allowedGatewayPath, managedBaseUrl, managedProviderName, normalizeManagedRequestBody, parseManagedRoute } = require('../gateway-bridge.cjs')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

async function main() {
  const requests = []
  let rejectFirst = true
  const claudeStream = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
  const geminiStream = 'data: {"candidates":[{"content":{"parts":[{"text":"OK","thoughtSignature":"opaque-response-signature"}],"role":"model"},"finishReason":"STOP"}]}\n\n'
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, group: req.headers['x-anyu-group-id'], model: req.headers['x-anyu-model'], headers: req.headers, body: Buffer.concat(chunks).toString() })
      if (rejectFirst) { rejectFirst = false; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"message":"expired"}'); return }
      if (req.headers['x-anyu-model'] === 'auth-stream-failure') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.write('{"message":')
        setTimeout(() => res.destroy(), 20)
        return
      }
      if (req.headers['x-anyu-model'] === 'unavailable') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end('{"error":{"type":"overloaded_error","message":"model unavailable"}}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (req.headers['x-anyu-model'] === 'stream-failure') {
        res.write('data: partial\n\n')
        setTimeout(() => res.destroy(), 20)
        return
      }
      if (req.url.includes('/v1/messages')) { res.end(claudeStream); return }
      if (req.url.includes('/v1beta/models/')) { res.end(geminiStream); return }
      res.write('data: first\n\n')
      setImmediate(() => res.end('data: done\n\n'))
    })
  })
  const upstreamPort = await listen(upstream)
  let accessToken = 'old-jwt'
  let refreshes = 0
  const bridge = new LocalGatewayBridge({
    gatewayBase: `http://127.0.0.1:${upstreamPort}`,
    getAccessToken: () => accessToken,
    refreshAccessToken: async () => { refreshes++; accessToken = 'new-jwt'; return accessToken }
  })
  const local = await bridge.start()
  const baseUrl = managedBaseUrl(local.origin, 'openai-responses', 17)
  assert.strictEqual(managedProviderName('openai-responses', 17), 'anyu-gateway-openai-g17')
  assert.deepStrictEqual(parseManagedRoute(new URL(baseUrl).pathname + '/responses'), { groupId: 17, upstreamPath: '/v1/responses' })
  assert.strictEqual(allowedGatewayPath('/v1/responses/compact'), true)
  assert.strictEqual(allowedGatewayPath('/v1/responses/arbitrary'), false)
  assert.strictEqual(allowedGatewayPath('/responses'), false)
  assert.deepStrictEqual(parseManagedRoute('/anyu/23/v1/messages'), { groupId: 23, upstreamPath: '/v1/messages' })
  assert.deepStrictEqual(parseManagedRoute('/anyu/29/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'), { groupId: 29, upstreamPath: '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse' })

  const offBody = Buffer.from('{"model":"qwen3.8-max","input":"hello","reasoning":{"effort":"off"}}')
  const responsesRoute = { upstreamPath: '/v1/responses' }
  assert.strictEqual(JSON.parse(normalizeManagedRequestBody(responsesRoute, offBody)).reasoning.effort, 'none')
  assert.strictEqual(normalizeManagedRequestBody(responsesRoute, Buffer.from('{"reasoning":{"effort":"medium"}}')).toString(), '{"reasoning":{"effort":"medium"}}')
  const chatBody = Buffer.from('{"model":"qwen3.8-max","reasoning_effort":"off"}')
  assert.strictEqual(JSON.parse(normalizeManagedRequestBody({ upstreamPath: '/v1/chat/completions' }, chatBody)).reasoning_effort, 'none')
  assert.strictEqual(normalizeManagedRequestBody({ upstreamPath: '/v1/messages' }, offBody), offBody)
  assert.strictEqual(normalizeManagedRequestBody(responsesRoute, Buffer.from('invalid')).toString(), 'invalid')

  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6', input: 'hello' })
  })
  assert.strictEqual(response.status, 200)
  assert.strictEqual(await response.text(), 'data: first\n\ndata: done\n\n')
  assert.strictEqual(refreshes, 1)
  assert.strictEqual(requests.length, 2)
  assert.strictEqual(requests[0].url, `${ANYU_AGENT_GATEWAY_PATH}/v1/responses`)
  assert.strictEqual(requests[1].url, `${ANYU_AGENT_GATEWAY_PATH}/v1/responses`)
  assert.strictEqual(requests[0].authorization, 'Bearer old-jwt')
  assert.strictEqual(requests[1].authorization, 'Bearer new-jwt')
  assert.strictEqual(requests[1].group, '17')
  assert.strictEqual(requests[1].model, 'gpt-5.6')

  const normalized = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
    body: offBody
  })
  assert.strictEqual(normalized.status, 200)
  assert.strictEqual(JSON.parse(requests[2].body).reasoning.effort, 'none')
  assert.strictEqual(requests[2].model, 'qwen3.8-max')

  const normalizedChat = await fetch(`${managedBaseUrl(local.origin, 'openai-completions', 17)}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
    body: chatBody
  })
  assert.strictEqual(normalizedChat.status, 200)
  assert.strictEqual(JSON.parse(requests[3].body).reasoning_effort, 'none')

  const claudeBody = JSON.stringify({
    model: 'claude-test', stream: true, max_tokens: 2048,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { value: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: 'opaque-thinking-signature' }, { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { value: 'test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }] },
    ],
  })
  const claude = await fetch(`${managedBaseUrl(local.origin, 'anthropic-messages', 34)}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'x-api-key': local.token, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
    body: claudeBody,
  })
  assert.strictEqual(claude.status, 200)
  assert.strictEqual(await claude.text(), claudeStream)
  assert.strictEqual(requests.at(-1).body, claudeBody)
  assert.strictEqual(requests.at(-1).url, `${ANYU_AGENT_GATEWAY_PATH}/v1/messages?beta=true`)
  assert.strictEqual(requests.at(-1).headers['anthropic-version'], '2023-06-01')
  assert.strictEqual(requests.at(-1).headers['anthropic-beta'], 'interleaved-thinking-2025-05-14')
  assert.strictEqual(requests.at(-1).headers['x-api-key'], undefined)
  assert.strictEqual(requests.at(-1).group, '34')

  const geminiBody = JSON.stringify({
    contents: [{ role: 'model', parts: [{ functionCall: { name: 'lookup', args: { value: 'test' } }, thoughtSignature: 'opaque-tool-signature' }] }, { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { result: 'ok' } } }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } },
  })
  const gemini = await fetch(`${managedBaseUrl(local.origin, 'google-generative-ai', 29)}/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
    method: 'POST', headers: { 'x-goog-api-key': local.token, 'Content-Type': 'application/json' }, body: geminiBody,
  })
  assert.strictEqual(gemini.status, 200)
  assert.strictEqual(await gemini.text(), geminiStream)
  assert.strictEqual(requests.at(-1).body, geminiBody)
  assert.strictEqual(requests.at(-1).url, `${ANYU_AGENT_GATEWAY_PATH}/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse`)
  assert.strictEqual(requests.at(-1).model, 'gemini-2.5-pro')
  assert.strictEqual(requests.at(-1).group, '29')
  assert.strictEqual(requests.at(-1).headers['x-goog-api-key'], undefined)

  const unavailable = await fetch(`${baseUrl}/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' }, body: '{"model":"unavailable"}',
  })
  assert.strictEqual(unavailable.status, 503)
  assert.deepStrictEqual(await unavailable.json(), { error: { type: 'overloaded_error', message: 'model unavailable' } })

  const interruptedAuth = await fetch(`${baseUrl}/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' }, body: '{"model":"auth-stream-failure"}', signal: AbortSignal.timeout(3000),
  })
  assert.strictEqual(interruptedAuth.status, 502)
  await interruptedAuth.text()
  assert.strictEqual(refreshes, 1, 'incomplete authentication errors must not trigger a token refresh')

  const requestCount = requests.length
  const interrupted = await fetch(`${baseUrl}/responses`, {
    method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' }, body: '{"model":"stream-failure"}', signal: AbortSignal.timeout(3000),
  })
  assert.strictEqual(interrupted.status, 200)
  await assert.rejects(() => interrupted.text(), { name: 'TypeError' })
  assert.strictEqual(requests.length, requestCount + 1, 'interrupted output must not be replayed')

  const rejected = await fetch(`${baseUrl}/responses`, { method: 'POST', headers: { Authorization: 'Bearer invalid' }, body: '{}' })
  assert.strictEqual(rejected.status, 401)
  const rejectedMethod = await fetch(`${baseUrl}/responses`, { method: 'GET', headers: { Authorization: `Bearer ${local.token}` } })
  assert.strictEqual(rejectedMethod.status, 405)

  bridge.setThinkingLevel('session-a', 'low')
  bridge.setThinkingLevel('session-b', 'max')
  const sessionRequest = (key) => fetch(`${managedBaseUrl(local.origin, 'openai-completions', 17, key)}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json', 'X-AnYu-Thinking-Level': 'high' }, body: '{"model":"gpt-6.1-sol"}',
  })
  const sessionResponses = await Promise.all([sessionRequest('session-a'), sessionRequest('session-b')])
  for (const response of sessionResponses) { assert.equal(response.status, 200); await response.text() }
  assert.deepEqual(new Set(requests.slice(-2).map(r => r.headers['x-anyu-thinking-level'])), new Set(['low', 'max']))
  bridge.setThinkingLevel('session-a', 'between_tools')
  const changed = await sessionRequest('session-a')
  await changed.text()
  assert.equal(requests.at(-1).headers['x-anyu-thinking-level'], 'between_tools')
  bridge.removeThinkingContext('session-a')
  const countBeforeStale = requests.length
  const stale = await sessionRequest('session-a')
  assert.equal(stale.status, 400)
  await stale.text()
  assert.equal(requests.length, countBeforeStale)
  await bridge.stop()
  assert.equal(bridge.thinkingContexts.size, 0)
  await close(upstream)
  console.log('gateway bridge tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
