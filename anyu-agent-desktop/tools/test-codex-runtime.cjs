'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

const IMAGE = require('node:fs').readFileSync(path.join(__dirname, '../branding/logo.png')).toString('base64')
function sendResponse(res, api, model, tool, args, final = 'DONE', usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 4 } }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
  if (api === 'openai-responses') {
    let sequence = 0
    const event = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify({ ...data, sequence_number: sequence++ })}\n\n`)
    const response = { id: 'resp_test', object: 'response', model, status: 'in_progress', output: [] }
    const item = tool ? { id: 'fc_test', type: 'function_call', call_id: 'call_test', name: tool, arguments: JSON.stringify(args), status: 'completed' } : { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: final, annotations: [] }] }
    event({ type: 'response.created', response })
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(tool ? { arguments: '' } : { content: [] }) } })
    if (!tool) event({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: final })
    event({ type: 'response.output_item.done', output_index: 0, item })
    event({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage } })
  } else if (api === 'openai-completions') {
    const chunk = (delta, finish_reason = null) => send({ id: 'test', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })
    chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_test', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: final })
    chunk({}, tool ? 'tool_calls' : 'stop'); res.write('data: [DONE]\n\n')
  } else if (api === 'anthropic-messages') {
    const event = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
    event({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    event({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_test', name: tool, input: {} } : { type: 'text', text: '' } })
    event({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: final } })
    event({ type: 'content_block_stop', index: 0 })
    event({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
    event({ type: 'message_stop' })
  } else {
    send({ candidates: [{ index: 0, content: { role: 'model', parts: [tool ? { functionCall: { name: tool, args }, thoughtSignature: 'dGVzdC1zaWduYXR1cmU=' } : { text: final }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })
  }
  res.end()
}

async function fixture(t, { api = 'openai-responses', tool = 'read', mode = 'full', allow = true, readOnly = false, conversationOnly = false, handler, setup, contextPolicy, model = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-codex-runtime-'))
  await fs.writeFile(path.join(directory, 'input.txt'), 'FILE_CONTENT')
  const extra = await setup?.(directory) || {}
  const requests = [], events = [], pending = new Map()
  const args = tool === 'write' ? { path: 'output.txt', content: 'WRITE_OK' } : { path: 'input.txt' }
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); requests.push({ url: req.url, body })
    if (handler) return handler(req, res, body, requests.length)
    sendResponse(res, api, body.model, requests.length === 1 ? tool : null, args)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}${api === 'anthropic-messages' ? '' : api === 'google-generative-ai' ? '/v1beta' : '/v1'}`
  let child, counter = 0, buffer = '', stderr = ''
  const waiters = []
  const event = predicate => {
    const found = events.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Event timed out: ${stderr.slice(-1000)}; ${JSON.stringify(events.slice(-5))}`)), 20000)
      waiters.push(value => { if (predicate(value)) { clearTimeout(timer); resolve(value); return true } return false })
    })
  }
  function launch() {
    buffer = ''
    child = spawn(process.env.ANYU_CODEX_TEST_NODE || process.execPath, [process.env.ANYU_CODEX_TEST_WORKER || path.resolve(__dirname, '../codex-worker.cjs')], { cwd: directory, windowsHide: true, env: { ...process.env, ...(process.env.ANYU_CODEX_TEST_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ANYU_PERMISSION_MODE: mode, ANYU_AGENT_READ_ONLY: readOnly ? '1' : '', ANYU_TASK_PORT: '', ANYU_TASK_TOKEN: '', ANYU_AGENT_BRIDGE_PORT: '', ANYU_AGENT_BRIDGE_TOKEN: '', ...extra.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk; let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let value; try { value = JSON.parse(line) } catch { continue }
        events.push(value)
        if (value.type === 'response') { const request = pending.get(value.id); if (request) { pending.delete(value.id); value.success ? request.resolve(value.data) : request.reject(new Error(value.error)) } }
        if (value.type === 'extension_ui_request') child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: value.id, confirmed: allow }) + '\n')
        for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](value)) waiters.splice(i, 1)
      }
    })
  }
  async function stop() {
    if (!child || child.exitCode !== null) return
    const closed = once(child, 'close')
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 8000)
    await closed; clearTimeout(timer)
  }
  t.after(async () => { await stop(); await extra.cleanup?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const command = (type, rest = {}) => new Promise((resolve, reject) => {
    const id = String(++counter)
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out: ${stderr.slice(-1500)}`)) }, 20000)
    pending.set(id, { resolve: data => { clearTimeout(timer); resolve(data) }, reject: error => { clearTimeout(timer); reject(error) } })
    child.stdin.write(JSON.stringify({ type, id, ...rest }) + '\n')
  })
  const options = { cwd: directory, home: path.join(directory, 'codex'), agentDir: path.join(directory, 'pi'), sessionPath: path.join(directory, 'session.codex.jsonl'), credential: 'test', readOnly, model: { id: 'test', api, provider: 'anyu-test', baseUrl, contextWindow: 128000, input: ['text', 'image'], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...model }, contextPolicy: { contextWindow: 128000, triggerTokens: 110000, native: { enabled: true } } }
  if (contextPolicy) options.contextPolicy = contextPolicy
  if (conversationOnly) { options.conversationOnly = true; options.systemPrompt = 'You are Mint, a thoughtful desktop companion.' }
  launch(); await command('initialize_runtime', { options })
  return { directory, requests, events, command, event, options, restart: async () => { await stop(); launch(); await command('initialize_runtime', { options }) } }
}

test('conversation-only pet threads send no tools and preserve character instructions', async t => {
  const f = await fixture(t, { tool: null, conversationOnly: true })
  await f.command('prompt', { message: 'Say hello to Snow.' })
  assert.equal((await f.event(e => e.type === 'agent_settled')).error, '')
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].body.tools?.length || 0, 0)
  assert.match(JSON.stringify(f.requests[0].body), /thoughtful desktop companion/)
  assert.ok(!f.events.some(e => e.type === 'tool_execution_start'))
})

test('official engine uses native Responses for a preferred GPT Chat catalog entry', async t => {
  const f = await fixture(t, { api: 'openai-completions', model: { id: 'gpt-5.6-sol', preferNativeResponses: true }, handler: (_req, res, body, n) => sendResponse(res, 'openai-responses', body.model, n === 1 ? 'read' : null, { path: 'input.txt' }) })
  await f.command('prompt', { message: 'Read input.txt' })
  assert.equal((await f.event(e => e.type === 'agent_settled')).error, '')
  assert.deepEqual(f.requests.map(r => r.url), ['/v1/responses', '/v1/responses'])
  assert.ok(f.events.some(e => e.type === 'tool_execution_end'))
})

test('official engine forwards Claude summaries before the final reply', { timeout: 30000 }, async t => {
  let finish
  const ending = new Promise(resolve => { finish = resolve })
  t.after(() => finish())
  const f = await fixture(t, { api: 'anthropic-messages', model: { id: 'claude-opus-5-5', reasoning: true }, handler: async (_req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    send({ type: 'message_start', message: { id: 'msg_thinking', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } })
    send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Public summary.' } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } })
    send({ type: 'content_block_stop', index: 0 })
    await ending
    send({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
    send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'FINAL' } })
    send({ type: 'content_block_stop', index: 1 })
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
    send({ type: 'message_stop' }); res.end()
  } })
  await f.command('set_thinking_level', { level: 'xhigh' })
  await f.command('prompt', { message: 'Hello' })
  const thinking = await f.event(e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'thinking_delta')
  assert.equal(thinking.assistantMessageEvent.delta, 'Public summary.')
  assert.ok(!f.events.some(e => e.type === 'agent_settled'))
  assert.deepEqual(f.requests[0].body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(f.requests[0].body.output_config.effort, 'xhigh')
  finish()
  assert.equal((await f.event(e => e.type === 'agent_settled')).error, '')
  assert.ok(!JSON.stringify(f.events).includes('PRIVATE_SIGNATURE'))
  assert.equal(f.events.filter(e => e.type === 'message_end').at(-1).message.content[0].text, 'FINAL')
})

test('official engine exposes a Claude SSE failure instead of a generic disconnect', { timeout: 30000 }, async t => {
  const f = await fixture(t, { api: 'anthropic-messages', model: { id: 'claude-opus-5-5', reasoning: true }, handler: (_req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end([
      { type: 'message_start', message: { id: 'msg_failure', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Claude fixture overloaded' } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  } })
  await f.command('prompt', { message: 'Hello' })
  const done = await f.event(e => e.type === 'agent_settled')
  assert.match(done.error, /Claude fixture overloaded/)
  assert.ok(f.requests.length <= 3)
})

for (const api of ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai']) {
  test(`official engine: ${api} image + tool + next turn + resume`, { timeout: 50000 }, async t => {
    const f = await fixture(t, { api })
    await f.command('prompt', { message: 'Read the file and image', images: [{ mimeType: 'image/png', data: IMAGE }] })
    const done = await f.event(e => e.type === 'agent_settled')
    assert.equal(done.error, '', JSON.stringify(f.events.slice(-10)))
    assert.equal(f.requests.length, 2)
    assert.equal(f.events.filter(e => e.type === 'turn_start').length, 2, 'Each model round must reach the host turn limiter')
    if (api === 'openai-completions') { assert.equal(f.requests[0].body.max_tokens, undefined); assert.equal(f.requests[0].body.max_completion_tokens, undefined) }
    if (api === 'google-generative-ai') assert.equal(f.requests[0].body.generationConfig?.maxOutputTokens, undefined)
    if (api === 'anthropic-messages') assert.ok(f.requests[0].body.max_tokens > 0)
    assert.ok(f.events.some(e => e.type === 'tool_execution_end' && !e.isError && JSON.stringify(e.result).includes('FILE_CONTENT')))
    assert.ok(/input_image|image_url|"type":"image"|inlineData/.test(JSON.stringify(f.requests[0].body)), JSON.stringify((f.requests[0].body.input || f.requests[0].body.messages || f.requests[0].body.contents).filter(item => item.role === 'user')).slice(0, 2000))
    assert.ok(JSON.stringify(f.requests[1].body).includes('FILE_CONTENT'))
    if (api === 'google-generative-ai') assert.ok(JSON.stringify(f.requests[1].body).includes('dGVzdC1zaWduYXR1cmU='))
    assert.equal(f.events.filter(e => e.type === 'message_end').at(-1).message.content[0].text, 'DONE')
    assert.equal(f.events.filter(e => e.type === 'message_end' && e.message.content[0].text === 'DONE').length, 1, 'The final answer must not be emitted again at turn completion')
    if (api === 'openai-responses') assert.deepEqual(f.events.filter(e => e.type === 'message_end').at(-1).message.usage, { input: 12, output: 6, cacheRead: 8, cacheWrite: 0, totalTokens: 26 })
    await f.restart()
    const before = f.events.length
    await f.command('prompt', { message: 'Continue the same thread' })
    await f.event(e => e.type === 'agent_settled' && f.events.indexOf(e) >= before)
    assert.ok(JSON.stringify(f.requests.at(-1).body).includes('FILE_CONTENT'))
    if (api === 'openai-responses') assert.deepEqual(f.events.filter(e => e.type === 'message_end').at(-1).message.usage, { input: 6, output: 3, cacheRead: 4, cacheWrite: 0, totalTokens: 13 })
  })
}

test('switching a persisted converted thread to Responses removes only host-private reasoning', { timeout: 50000 }, async t => {
  const f = await fixture(t, { api: 'anthropic-messages', handler: (req, res, body, n) => {
    const api = req.url.endsWith('/responses') ? 'openai-responses' : 'anthropic-messages'
    sendResponse(res, api, body.model, n === 1 ? 'read' : null, { path: 'input.txt' })
  } })
  await f.command('prompt', { message: 'Read the file' })
  await f.event(e => e.type === 'agent_settled')
  f.options.model.api = 'openai-responses'
  await f.restart()
  const before = f.events.length
  await f.command('prompt', { message: 'Continue with the native protocol' })
  const done = await f.event(e => e.type === 'agent_settled' && f.events.indexOf(e) >= before)
  assert.equal(done.error, '')
  assert.ok(JSON.stringify(f.requests.at(-1).body).includes('FILE_CONTENT'))
  assert.ok(!JSON.stringify(f.requests.at(-1).body).includes('anyu_provider_v1:'))
})

for (const allow of [false, true]) {
  test(`official engine respects tool approval ${allow ? 'allow' : 'deny'}`, { timeout: 40000 }, async t => {
    const f = await fixture(t, { tool: 'write', mode: 'confirm', allow })
    await f.command('prompt', { message: 'Write the file' })
    await f.event(e => e.type === 'agent_settled')
    assert.equal(f.events.filter(e => e.type === 'extension_ui_request').length, 1)
    assert.equal(await fs.access(path.join(f.directory, 'output.txt')).then(() => true, () => false), allow)
    assert.equal(f.events.find(e => e.type === 'tool_execution_end').isError, !allow)
  })
}

test('official engine cancels a pending stream and accepts the next prompt', { timeout: 40000 }, async t => {
  const f = await fixture(t, { handler: (_req, res, body, n) => {
    if (n === 1) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n') }
    else sendResponse(res, 'openai-responses', body.model, null, null)
  } })
  await f.command('prompt', { message: 'Wait' })
  for (let tries = 0; f.requests.length === 0 && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(f.requests.length, 1)
  await f.command('abort')
  await f.event(e => e.type === 'agent_settled')
  const before = f.events.length
  await f.command('prompt', { message: 'Next' })
  const finished = await f.event(e => e.type === 'agent_settled' && f.events.indexOf(e) >= before)
  assert.equal(finished.error, '')
})

for (const api of ['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai']) {
  test(`official engine ${api}: local budget rejection is never retried`, { timeout: 40000 }, async t => {
    const f = await fixture(t, { api, handler: (_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'TASK_REQUEST_LIMIT', message: 'Task request limit reached' } }))
    } })
    await f.command('prompt', { message: 'Hello' })
    const done = await f.event(e => e.type === 'agent_settled')
    assert.ok(done.error)
    assert.equal(f.requests.length, 1)
  })
}

test('official engine retries a temporary upstream failure without repeating a completed tool', { timeout: 40000 }, async t => {
  const f = await fixture(t, { api: 'openai-completions', handler: (_req, res, body, n) => {
    if (n === 2) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Temporarily unavailable"}}') }
    else sendResponse(res, 'openai-completions', body.model, n === 1 ? 'write' : null, { path: 'retry.txt', content: 'ONCE' })
  } })
  await f.command('prompt', { message: 'Write once' })
  const done = await f.event(e => e.type === 'agent_settled')
  assert.equal(done.error, '')
  assert.equal(f.requests.length, 3)
  assert.equal(f.events.filter(e => e.type === 'tool_execution_start').length, 1)
})

test('official engine compacts using the selected provider and resumes the original history', { timeout: 50000 }, async t => {
  const f = await fixture(t, { tool: null })
  await f.command('prompt', { message: 'Remember COMPACTION_MARKER' })
  await f.event(e => e.type === 'agent_settled')
  const result = await f.command('compact')
  assert.ok(result)
  assert.ok(f.events.some(e => e.type === 'compaction_end' && e.result))
  const before = f.events.length
  await f.command('prompt', { message: 'Continue after compaction' })
  const done = await f.event(e => e.type === 'agent_settled' && f.events.indexOf(e) >= before)
  assert.equal(done.error, '')
})

test('official tools preserve project shell denial even in full mode', { timeout: 40000 }, async t => {
  const { AgentWorkbench } = require('../agent-workbench.cjs')
  const f = await fixture(t, {
    setup: async directory => {
      const workbench = new AgentWorkbench({ directory: path.join(directory, 'workbench'), encrypt: text => text, decrypt: text => text, billing: async () => [] })
      await workbench.init()
      const project = await workbench.project(directory)
      project.settings.policy.shell = 'deny'
      await workbench.begin({ sessionId: 'test', cwd: directory, model: 'test' }, { runId: 'run-test', input: 'Check policy' }, {})
      const context = workbench.context('test')
      return { env: { ANYU_TASK_PORT: String(context.port), ANYU_TASK_TOKEN: context.token }, cleanup: () => workbench.close() }
    },
    handler: (_req, res, body, n) => sendResponse(res, 'openai-responses', body.model, n === 1 ? 'powershell' : null, { command: 'Set-Content should-not-exist.txt unsafe' }),
  })
  await f.command('prompt', { message: 'Try the denied operation' })
  await f.event(e => e.type === 'agent_settled')
  assert.equal(f.events.find(e => e.type === 'tool_execution_end').isError, true)
  assert.match(JSON.stringify(f.events.find(e => e.type === 'tool_execution_end').result), /disabled by project policy/)
  assert.equal(await fs.access(path.join(f.directory, 'should-not-exist.txt')).then(() => true, () => false), false)
})

for (const enabled of [true, false]) test(`official automatic compaction observes the configured toggle: ${enabled}`, { timeout: 50000 }, async t => {
  const f = await fixture(t, { contextPolicy: { contextWindow: 128000, triggerTokens: 50000, native: { enabled } }, handler: (_req, res, body, n) => {
    sendResponse(res, 'openai-responses', body.model, null, null, n === 1 ? 'CONTEXT_MARKER' : 'SUMMARY_MARKER', n === 1 ? { input_tokens: 80000, output_tokens: 3, total_tokens: 80003 } : undefined)
  } })
  await f.command('prompt', { message: 'Remember the context' })
  await f.event(e => e.type === 'agent_settled')
  const before = f.events.length
  await f.command('prompt', { message: 'Continue' })
  await f.event(e => e.type === 'agent_settled' && f.events.indexOf(e) >= before)
  assert.equal(f.events.some(e => e.type === 'compaction_end' && e.result), enabled)
  assert.equal(f.events.filter(e => e.type === 'agent_settled').every(e => !e.error), true)
})

test('official fork preserves history but has an independent thread identity', { timeout: 50000 }, async t => {
  const f = await fixture(t, { tool: null })
  await f.command('prompt', { message: 'Remember FORK_ORIGIN' })
  await f.event(e => e.type === 'agent_settled')
  const original = JSON.parse(await fs.readFile(f.options.sessionPath, 'utf8'))
  const sourcePath = f.options.sessionPath
  f.options.sessionPath = path.join(f.directory, 'fork.codex.jsonl')
  await fs.writeFile(f.options.sessionPath, JSON.stringify({ ...original, threadId: undefined, forkThreadId: original.threadId }))
  await f.restart()
  const fork = JSON.parse(await fs.readFile(f.options.sessionPath, 'utf8'))
  assert.notEqual(fork.threadId, original.threadId)
  assert.deepEqual(JSON.parse(await fs.readFile(sourcePath, 'utf8')), original)
  const before = f.events.length
  await f.command('prompt', { message: 'Continue the fork' })
  await f.event(e => e.type === 'agent_settled' && f.events.indexOf(e) >= before)
  assert.ok(JSON.stringify(f.requests.at(-1).body).includes('FORK_ORIGIN'))
})

module.exports = { fixture, sendResponse }
