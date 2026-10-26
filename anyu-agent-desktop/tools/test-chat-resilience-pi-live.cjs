'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { LocalGatewayBridge, managedBaseUrl, managedProviderName } = require('../gateway-bridge.cjs')

const cases = ['openai-completions', 'openai-responses'].flatMap(api =>
  ['503', 'stream-drop', 'request-limit', 'default-retry'].map(scenario => ({ api, scenario })))
for (const { api, scenario } of cases) {
  test(`bundled Pi ${api} handles ${scenario} through the desktop gateway with image input`, { timeout: 45000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-chat-resilience-'))
    let child, stderr = '', buffer = '', calls = 0, admitted = 0
    const bodies = [], events = []
    const upstream = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      bodies.push(body)
      calls++
      if (calls === 1 && ['503', 'default-retry'].includes(scenario)) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Temporarily unavailable' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (api === 'openai-responses') {
        let sequence = 0
        const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`)
        const response = { id: 'resp_resilience', object: 'response', created_at: 1, model: body.model, status: 'in_progress', output: [] }
        const item = { id: 'msg_resilience', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
        const location = { item_id: item.id, output_index: 0, content_index: 0 }
        send({ type: 'response.created', response })
        send({ type: 'response.output_item.added', output_index: 0, item })
        send({ type: 'response.content_part.added', ...location, part: { type: 'output_text', text: '', annotations: [] } })
        const text = calls === 1 && scenario === 'stream-drop' ? 'PARTIAL_ATTEMPT' : 'RECOVERED'
        send({ type: 'response.output_text.delta', ...location, delta: text })
        if (calls === 1 && scenario === 'stream-drop') { setTimeout(() => res.destroy(), 30); return }
        const part = { type: 'output_text', text, annotations: [] }
        const completed = { ...item, status: 'completed', content: [part] }
        send({ type: 'response.output_text.done', ...location, text })
        send({ type: 'response.content_part.done', ...location, part })
        send({ type: 'response.output_item.done', output_index: 0, item: completed })
        send({ type: 'response.completed', response: { ...response, status: 'completed', output: [completed], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
        res.end()
        return
      }
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'resilience', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      if (calls === 1 && scenario === 'stream-drop') {
        send({ role: 'assistant', content: 'PARTIAL_ATTEMPT' })
        setTimeout(() => res.destroy(), 30)
        return
      }
      send({ role: 'assistant', content: 'RECOVERED' })
      send({}, 'stop')
      res.end('data: [DONE]\n\n')
    })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const bridge = new LocalGatewayBridge({ gatewayBase: `http://127.0.0.1:${upstream.address().port}`, getAccessToken: () => 'test', beforeRequest: () => {
      admitted++
      if (scenario === 'request-limit') throw Object.assign(new Error('Task request limit reached'), { code: 'TASK_REQUEST_LIMIT', statusCode: 409 })
    } })
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended }
      await bridge.stop()
      upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
      await fs.rm(directory, { recursive: true, force: true })
    })
    const local = await bridge.start()
    const provider = managedProviderName(api, 1)
    const model = { id: 'test', name: 'Test', input: ['text', 'image'], reasoning: false, contextWindow: 1000000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    await fs.writeFile(path.join(directory, 'models.json'), JSON.stringify({ providers: { [provider]: { api, baseUrl: managedBaseUrl(local.origin, api, 1), apiKey: local.token, models: [model] } } }))
    if (scenario !== 'default-retry') await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 10, provider: { maxRetries: 0 } } }))
    child = spawn(path.resolve(__dirname, '../pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi'), ['--mode', 'rpc', '--provider', provider, '--model', 'test', '--no-session', '--no-skills', '--no-extensions', '--no-context-files', '--offline'], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_SKIP_VERSION_CHECK: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.on('data', data => { stderr += data.toString() })
    const settled = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Pi exited ${code}: ${stderr}`)))
      t.signal.addEventListener('abort', () => reject(t.signal.reason), { once: true })
      child.stdout.on('data', data => {
        buffer += data.toString()
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          let event
          try { event = JSON.parse(line) } catch { continue }
          events.push(event)
          if (event.type === 'agent_settled') resolve()
          if (event.type === 'response' && event.success === false) reject(new Error(event.error))
        }
      })
    })
    child.stdin.write(JSON.stringify({ id: 'prompt', type: 'prompt', message: 'Describe the supplied image', images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' }] }) + '\n')
    await settled
    if (scenario === 'request-limit') {
      assert.equal(calls, 0)
      assert.equal(admitted, 1)
      assert.equal(events.filter(event => event.type === 'auto_retry_start').length, 0)
      return
    }
    assert.equal(calls, 2, JSON.stringify(events.filter(event => event.type === 'message_end')))
    if (scenario !== 'default-retry') assert.ok(events.some(event => event.type === 'auto_retry_start'))
    const last = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message
    assert.equal(last?.stopReason, 'stop')
    assert.equal(last.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'RECOVERED')
    assert.ok(bodies.every(body => (api === 'openai-responses' ? body.input : body.messages).some(message => Array.isArray(message.content) && message.content.some(part => part.type === (api === 'openai-responses' ? 'input_image' : 'image_url')))))
  })
}
