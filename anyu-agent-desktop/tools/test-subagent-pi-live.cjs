'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { AgentSessionService } = require('../agent-session.cjs')
const { AgentOrchestrator } = require('../agent-orchestrator.cjs')

test('bundled Pi delegates across models, executes read, and preserves DeepSeek reasoning through tool results', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-pi-subagent-'))
  const executable = path.resolve(__dirname, '../pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi')
  const runtimes = new Map(), requests = [], events = []
  const marker = 'PI_CHILD_READ_VERIFIED'
  fs.writeFileSync(path.join(directory, 'marker.txt'), marker)
  const errors = []
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(body)
      const isParent = body.model === 'gpt-6-astra'
      const hasToolResult = body.messages.some(message => message.role === 'tool')
      if (!isParent) {
        assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['find', 'grep', 'ls', 'read'])
        if (hasToolResult) {
          assert.ok(body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(marker)))
          const previous = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.length)
          assert.equal(previous.reasoning_content, 'Read the requested evidence.')
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      send({ role: 'assistant' })
      if (!hasToolResult) {
        const name = isParent ? 'delegate_tasks' : 'read'
        const args = isParent
          ? { tasks: [{ workerId: 'deepseek', title: 'Read marker', mode: 'read', instructions: 'Read marker.txt in the current workspace and return its first line. Do not change files.' }] }
          : { path: path.join(directory, 'marker.txt') }
        if (!isParent) send({ reasoning_content: 'Read the requested evidence.' })
        const encoded = JSON.stringify(args)
        send({ tool_calls: [{ index: 0, id: isParent ? 'delegate-1' : 'read-1', type: 'function', function: { name, arguments: encoded.slice(0, 20) } }] })
        send({ tool_calls: [{ index: 0, function: { arguments: encoded.slice(20) } }] })
        send({}, 'tool_calls')
      } else {
        send({ content: marker })
        send({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    } catch (error) {
      errors.push(error.message)
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`
  const models = ['gpt-6-astra', 'deepseek-v4-flash'].map((id, index) => ({ id, name: id, group_id: index + 1, api: 'openai-completions', provider: 'anyu-test' }))
  let seq = 0
  let sessions, host
  function send(runtime, command) {
    return new Promise((resolve, reject) => {
      const id = `request-${++seq}`
      const timer = setTimeout(() => { runtime.pending.delete(id); reject(new Error('RPC timeout')) }, 15000)
      runtime.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      runtime.child.stdin.write(JSON.stringify({ ...command, id }) + '\n')
    })
  }
  async function retire(key) {
    const runtime = runtimes.get(key)
    if (!runtime) return
    runtimes.delete(key)
    const closed = new Promise(resolve => runtime.child.once('exit', resolve))
    runtime.child.kill()
    await closed
  }
  sessions = new AgentSessionService({
    userDataDir: directory,
    startRuntime: async options => {
      const runtimeDir = path.join(directory, `config-${++seq}`)
      fs.mkdirSync(runtimeDir)
      const configModel = { id: options.model, name: options.model, api: 'openai-completions', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      fs.writeFileSync(path.join(runtimeDir, 'models.json'), JSON.stringify({ providers: { 'anyu-test': { baseUrl, api: 'openai-completions', apiKey: 'local-test-only', models: [configModel] } } }))
      const args = ['--mode', 'rpc', '--provider', 'anyu-test', '--model', options.model, '--session-dir', path.join(directory, 'sessions'), '--no-context-files', '--no-skills', '--no-extensions', '--extension', path.resolve(__dirname, '../pi-subagent-extension.mjs'), '--offline']
      if (options.readOnly) args.push('--tools', 'read,grep,find,ls')
      const runtime = { key: '', pending: new Map(), buffer: '' }
      runtime.child = spawn(executable, args, { cwd: directory, windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: runtimeDir, PI_SKIP_VERSION_CHECK: '1', ANYU_AGENT_BRIDGE_PORT: String(options.orchestration.port), ANYU_AGENT_BRIDGE_TOKEN: options.orchestration.token, ANYU_AGENT_ROLE: options.agentRole, ANYU_AGENT_READ_ONLY: options.readOnly ? '1' : '' }, stdio: ['pipe', 'pipe', 'pipe'] })
      runtime.child.stdout.on('data', chunk => {
        runtime.buffer += chunk.toString()
        let newline
        while ((newline = runtime.buffer.indexOf('\n')) >= 0) {
          const line = runtime.buffer.slice(0, newline)
          runtime.buffer = runtime.buffer.slice(newline + 1)
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (event.type === 'response' && runtime.pending.has(event.id)) {
            const pending = runtime.pending.get(event.id)
            runtime.pending.delete(event.id)
            event.success === false ? pending.reject(new Error(event.error)) : pending.resolve(event)
          } else if (runtime.key) sessions.ingest(runtime.key, event)
        }
      })
      runtime.child.stderr.on('data', chunk => { if (/Error|error/.test(chunk.toString())) errors.push(chunk.toString().slice(0, 300)) })
      runtime.child.once('exit', code => {
        sessions.runtimeExited(runtime.key, code)
        for (const pending of runtime.pending.values()) pending.reject(new Error(`Pi exited ${code}`))
      })
      const state = await send(runtime, { type: 'get_state' })
      runtime.key = state.data.sessionFile
      runtimes.set(runtime.key, runtime)
      return { sessionPath: runtime.key, cwd: directory, permissionMode: 'confirm' }
    },
    sendCommand: (command, runtime) => send(runtime, command),
    resolveRuntime: key => runtimes.get(key),
    stopRuntime: runtime => retire(runtime.key),
    broadcast: (_channel, payload) => events.push(payload.event),
  })
  host = new AgentOrchestrator({ sessions, getCatalog: async () => ({ models }), retireRuntime: retire })
  t.after(async () => {
    await host.close()
    await Promise.all([...runtimes.keys()].map(retire))
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const team = { enabled: true, maxParallel: 2, maxTasks: 2, timeoutMinutes: 1, workers: [{ id: 'deepseek', selection: { groupId: 2, model: models[1].id, api: models[1].api, thinkingLevel: 'auto' } }] }
  await host.start({ sessionId: 'live-parent', model: models[0].id, models: [models[0]], team, cwd: directory })
  const result = new Promise(resolve => { const off = sessions.subscribe(event => { if (event.sessionId === 'live-parent' && event.type === 'run.finished') { off(); resolve(event) } }) })
  await host.prompt({ sessionId: 'live-parent', message: 'Delegate the marker verification.' })
  const final = await result
  assert.deepEqual(errors, [])
  assert.equal(final.status, 'completed')
  assert.equal(final.text, marker)
  assert.equal(requests.length, 4)
  assert.ok(events.some(event => event.type === 'subagent.updated' && event.task.status === 'completed'))
  assert.equal(fs.readFileSync(path.join(directory, 'marker.txt'), 'utf8'), marker)
})
