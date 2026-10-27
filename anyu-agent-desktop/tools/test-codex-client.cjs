'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { CodexClient } = require('../codex-client.cjs')

function respond(res, model, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  let sequence = 0
  const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`)
  const response = { id: 'resp_test', object: 'response', created_at: 1, model, status: 'in_progress', output: [] }
  const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
  send({ type: 'response.created', response })
  send({ type: 'response.output_item.added', output_index: 0, item })
  send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
  send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text })
  const done = { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  send({ type: 'response.output_item.done', output_index: 0, item: done })
  send({ type: 'response.completed', response: { ...response, status: 'completed', output: [done], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  res.end()
}

test('official App Server initializes, streams and resumes its isolated thread', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-codex-client-'))
  const bodies = [], events = []
  const server = http.createServer(async (req, res) => {
    if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks)); bodies.push(body)
    respond(res, body.model, 'APP_SERVER_OK')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let client
  t.after(async () => { await client?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }) })
  const config = {
    model: 'anyu-test', model_provider: 'anyu',
    'model_providers.anyu': { name: 'Anyu', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', env_key: 'ANYU_CODEX_TEST_KEY', request_max_retries: 0, stream_max_retries: 0 },
    'features.shell_tool': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
    'features.apply_patch_freeform': false, 'features.js_repl': false,
    'features.view_image': false, 'features.goals': false,
    web_search: 'disabled', approval_policy: 'on-request', sandbox_mode: 'read-only',
  }
  client = new CodexClient({ home: path.join(directory, 'home'), cwd: directory, config, env: { ANYU_CODEX_TEST_KEY: 'test' } })
  client.on('notification', event => events.push(event))
  client.on('diagnostic', text => { if (process.env.ANYU_CODEX_DEBUG) process.stderr.write(text) })
  await client.initialize()
  const started = await client.request('thread/start', { model: 'anyu-test', modelProvider: 'anyu', cwd: directory, sandbox: 'read-only', approvalPolicy: 'on-request', dynamicTools: [{ type: 'function', name: 'anyu_test', description: 'Test tool', inputSchema: { type: 'object', properties: {} } }] })
  const complete = new Promise(resolve => client.on('notification', e => { if (e.method === 'turn/completed') resolve(e) }))
  await client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'hello', text_elements: [] }] })
  const ended = await complete
  assert.equal(ended.params.turn.status, 'completed', JSON.stringify(ended))
  assert.ok(events.some(e => e.method === 'item/agentMessage/delta' && e.params.delta === 'APP_SERVER_OK'))
  assert.ok(bodies[0].tools.some(tool => tool.name === 'anyu_test'))
  console.log('native tool inventory:', bodies[0].tools.map(tool => tool.name || tool.type))
  await client.close()
  client = new CodexClient({ home: path.join(directory, 'home'), cwd: directory, config, env: { ANYU_CODEX_TEST_KEY: 'test' } })
  await client.initialize()
  const resumed = await client.request('thread/resume', { threadId: started.thread.id })
  assert.equal(resumed.thread.id, started.thread.id)
  assert.ok(resumed.thread.turns.length > 0)
})

module.exports = { respond }
