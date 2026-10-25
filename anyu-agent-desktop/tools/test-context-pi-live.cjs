'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { AgentContextSettings } = require('../agent-context.cjs')

test('bundled Pi compacts at configured threshold, keeps history and continues with summary', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-compaction-live-'))
  const cwd = path.join(dir, 'workspace'), agentDir = path.join(dir, 'agent'), sessions = path.join(dir, 'sessions')
  await fs.mkdir(cwd); await fs.mkdir(sessions)
  const bodies = [], events = [], pending = new Map()
  let child, buffer = '', stderr = '', sequence = 0
  const upstream = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    bodies.push(body)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({ id: 'context-test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`)
    send({ role: 'assistant', content: bodies.length === 1 ? 'FIRST_REPLY' : 'COMPACT_MEMORY: original goal and next step preserved.' })
    send({}, 'stop', { prompt_tokens: bodies.length === 2 ? 29000 : 300, completion_tokens: 20, total_tokens: bodies.length === 2 ? 29020 : 320 })
    response.end('data: [DONE]\n\n')
  })
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const model = { id: 'context-test', api: 'openai-completions', name: 'Context test', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const settings = new AgentContextSettings(dir)
  settings.save({ enabled: true, mode: 'custom', triggerPercent: 75, keepRecentTokens: 1000 })
  settings.prepare(agentDir, dir, settings.policy(model, cwd))
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { test: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, api: model.api, apiKey: 'local-only', models: [model] } } }))
  const args = ['--mode', 'rpc', '--provider', 'test', '--model', model.id, '--session-dir', sessions, '--no-context-files', '--no-skills', '--no-extensions', '--offline', '--approve']
  child = spawn(path.resolve(__dirname, '../pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi'), args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', data => { stderr += data.toString() })
  child.stdout.on('data', data => {
    buffer += data.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      let event
      try { event = JSON.parse(line) } catch { continue }
      events.push(event)
      if (event.type === 'response' && pending.has(event.id)) {
        const request = pending.get(event.id); pending.delete(event.id)
        event.success === false ? request.reject(new Error(event.error)) : request.resolve(event)
      }
    }
  })
  child.once('exit', code => { for (const request of pending.values()) request.reject(new Error(`Pi exited ${code}: ${stderr}`)); pending.clear() })
  function command(type, fields = {}) {
    return new Promise((resolve, reject) => {
      const id = String(++sequence); pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n')
    })
  }
  async function waitUntil(check) {
    while (!check()) {
      t.signal.throwIfAborted()
      if (child.exitCode !== null) throw new Error(stderr)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  const original = 'ORIGINAL_HISTORY_MARKER ' + 'Keep the migration requirements and verification evidence. '.repeat(160)
  await command('prompt', { message: original })
  await waitUntil(() => events.some(event => event.type === 'agent_settled'))
  await command('prompt', { message: 'Continue the work with these current requirements. '.repeat(130) })
  await waitUntil(() => events.filter(event => event.type === 'agent_settled').length > 1)
  const compacted = events.find(event => event.type === 'compaction_end' && event.result)
  const state = await command('get_state')
  assert.ok(compacted, `No successful native compaction: ${JSON.stringify(events.filter(event => event.type !== 'message_update').map(event => ({ type: event.type, reason: event.reason, role: event.message?.role, usage: event.message?.usage, stop: event.message?.stopReason, error: event.message?.errorMessage || event.errorMessage })))}; state=${JSON.stringify(state.data)}; requests=${bodies.length}; ${stderr}`)
  assert.equal(compacted.reason, 'threshold')
  assert.ok(compacted.result.estimatedTokensAfter < compacted.result.tokensBefore)
  const originalHistory = await fs.readFile(state.data.sessionFile, 'utf8')
  assert.ok(originalHistory.includes('ORIGINAL_HISTORY_MARKER'))
  assert.ok(originalHistory.includes('"type":"compaction"'))
  const before = bodies.length, settled = events.filter(event => event.type === 'agent_settled').length
  await command('prompt', { message: 'Continue using the saved goal.' })
  await waitUntil(() => events.filter(event => event.type === 'agent_settled').length > settled)
  assert.ok(JSON.stringify(bodies[before].messages).includes('COMPACT_MEMORY'))
  assert.ok(!JSON.stringify(bodies[before].messages).includes(original))
  assert.ok((await command('get_session_stats')).data.contextUsage.contextWindow === 32000)
})
