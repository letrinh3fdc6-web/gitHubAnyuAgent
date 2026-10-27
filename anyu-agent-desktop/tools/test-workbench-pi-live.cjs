const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { AgentWorkbench } = require('../agent-workbench.cjs')

for (const engine of ['pi', 'codex']) test(`${engine} persists checkpoints, reads project memory and enforces policy under full mode`, { timeout: 45000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-workbench-pi-'))
  const cwd = path.join(directory, 'workspace')
  await fs.mkdir(cwd)
  const wb = new AgentWorkbench({ directory, encrypt: text => text, decrypt: text => text, billing: async () => [] })
  await wb.init()
  const project = await wb.project(cwd)
  project.settings.policy.shell = 'deny'
  await wb.memory(cwd, 'save', { text: 'Project verification marker: MEMORY_OK', source: 'test' })
  const task = await wb.begin({ sessionId: 'live', cwd, model: 'test' }, { runId: 'test-live-run', input: 'Verify task controls' }, { lazyCheckpoint: true })
  assert.equal(task.before, undefined)
  const context = wb.context('live')
  const errors = []
  let requests = 0, child, stderr = ''
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests++
      const tools = body.tools.map(tool => tool.function.name)
      assert.ok(tools.includes('task_checkpoint'))
      assert.ok(tools.includes('project_memory_search'))
      const results = body.messages.filter(message => message.role === 'tool')
      const tool = [
        { name: 'task_checkpoint', args: { summary: 'Checkpoint saved with real Pi' } },
        { name: 'project_memory_search', args: { query: 'marker' } },
        { name: 'bash', args: { command: 'echo should-not-run' } },
        { name: 'write', args: { path: 'result.txt', content: 'LIVE_RESULT_OK' } },
      ][results.length]
      if (results.length > 0) assert.match(results[0].content, /checkpoints/)
      if (results.length > 1) assert.match(results[1].content, /MEMORY_OK/)
      if (results.length > 2) assert.match(results[2].content, /disabled by project policy/)
      if (results.length === 3) assert.equal(task.before, undefined, 'read-only and denied tools must not capture the project')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'wb-live', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      send({ role: 'assistant' })
      if (tool) { send({ tool_calls: [{ index: 0, id: `tool-${results.length}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }); send({}, 'tool_calls') }
      else { send({ content: 'Task controls verified' }); send({}, 'stop') }
      res.end('data: [DONE]\n\n')
    } catch (error) { errors.push(error.message); if (!res.headersSent) res.writeHead(400); res.end(error.message) }
  })
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.stdin.end(); await closed }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
    await wb.close(); await fs.rm(directory, { recursive: true, force: true })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const model = { id: 'test', name: 'test', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  await fs.writeFile(path.join(directory, 'models.json'), JSON.stringify({ providers: { 'local-test': { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [model] } } }))
  const executable = path.resolve(__dirname, '../pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi')
  const args = ['--mode', 'rpc', '--provider', 'local-test', '--model', 'test', '--no-session', '--no-context-files', '--no-skills', '--no-extensions', '--offline', '--approve', '--permission-profile', 'gptFullAccess', '--extension', path.resolve(__dirname, '../pi-workbench-extension.mjs'), '--extension', path.resolve(__dirname, '../pi-approval-gate.mjs')]
  child = spawn(engine === 'codex' ? process.execPath : executable, engine === 'codex' ? [path.resolve(__dirname, '../codex-worker.cjs')] : args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_SKIP_VERSION_CHECK: '1', ANYU_PERMISSION_MODE: 'full', ANYU_TASK_PORT: String(context.port), ANYU_TASK_TOKEN: context.token }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', data => { stderr += data.toString() })
  let buffer = ''
  await new Promise((resolve, reject) => {
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
        if (event.type === 'agent_settled') resolve()
        if (event.type === 'response' && event.success === false) reject(new Error(event.error))
        if (event.type === 'response' && event.id === 'initialize' && event.success) child.stdin.write(JSON.stringify({ id: 'prompt', type: 'prompt', message: 'Verify the task controls' }) + '\n')
      }
    })
    child.stdin.write(JSON.stringify(engine === 'codex' ? { id: 'initialize', type: 'initialize_runtime', options: {
      cwd, home: path.join(directory, 'codex'), agentDir: directory, sessionPath: path.join(directory, 'session.codex.jsonl'), credential: 'local-only',
      model: { ...model, provider: 'local-test', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` },
      contextPolicy: { contextWindow: 128000, triggerTokens: 110000, native: { enabled: true } },
    } } : { id: 'prompt', type: 'prompt', message: 'Verify the task controls' }) + '\n')
  })
  assert.deepEqual(errors, [])
  assert.equal(requests, 5)
  assert.equal(task.checkpoints[0].summary, 'Checkpoint saved with real Pi')
  assert.equal(await fs.readFile(path.join(cwd, 'result.txt'), 'utf8'), 'LIVE_RESULT_OK')
  assert.ok(task.before, 'a baseline must exist before the write is executed')
  assert.deepEqual(Object.keys((await wb.snapshots.load(task.before)).files), [])
  wb.event({ sessionId: 'live', runId: task.id, type: 'run.finished', status: 'completed', text: 'Done' })
  await wb.settled(task.id)
  assert.equal(task.changes[0].path, 'result.txt')
  await wb.review(task.id, 'rollback')
  await assert.rejects(fs.stat(path.join(cwd, 'result.txt')), { code: 'ENOENT' })
})
