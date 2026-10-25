const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { AgentWorkbench } = require('../agent-workbench.cjs')
const { AgentSessionService } = require('../agent-session.cjs')
const { AgentOrchestrator } = require('../agent-orchestrator.cjs')

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-workbench-integration-'))
  const cwd = path.join(directory, 'source')
  await fs.mkdir(cwd)
  const wb = new AgentWorkbench({ directory, encrypt: text => text, decrypt: text => text, billing: async () => [], getOwner: () => 'local' })
  await wb.init()
  const starts = [], runtimes = new Map(), tasks = []
  const models = [{ id: 'planner', group_id: 1, api: 'openai-completions' }, { id: 'worker', group_id: 2, api: 'anthropic-messages' }]
  const sessions = new AgentSessionService({ userDataDir: directory,
    startRuntime: async options => { starts.push(options); const key = path.join(directory, `${options.agentSessionId}.jsonl`); runtimes.set(key, {}); return { sessionPath: key, cwd: options.cwd, permissionMode: options.permissionMode } },
    resolveRuntime: key => runtimes.get(key),
    beforePrompt: (record, run, payload) => wb.begin(record, run, payload),
    sendCommand: async command => {
      if (command.type === 'abort') { sessions.ingest(command.sessionKey, { type: 'agent_settled' }); return }
      if (command.type !== 'prompt') return
      const record = sessions.findByPath(command.sessionKey)
      if (!record.parentSessionId) return
      tasks.push(record)
      const name = command.message
      if (name === 'dependent') assert.equal(await fs.readFile(path.join(record.cwd, 'first.txt'), 'utf8'), 'first')
      await fs.writeFile(path.join(record.cwd, name === 'dependent' ? 'second.txt' : 'first.txt'), name === 'dependent' ? 'second' : 'first')
      sessions.ingest(command.sessionKey, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } })
      sessions.ingest(command.sessionKey, { type: 'agent_settled' })
    },
  })
  const host = new AgentOrchestrator({ sessions, workbench: wb, getCatalog: async () => ({ models }), retireRuntime: async key => { runtimes.delete(key) } })
  sessions.subscribe(event => wb.event(event))
  t.after(async () => { await host.close(); await wb.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const team = { enabled: true, maxParallel: 2, maxTasks: 8, timeoutMinutes: 1, workers: [{ id: 'w', selection: { model: 'worker', groupId: 2, api: 'anthropic-messages', thinkingLevel: 'auto' } }] }
  await host.start({ sessionId: 'parent', cwd, model: 'planner', models: [models[0]], team, permissionMode: 'full' })
  await host.prompt({ sessionId: 'parent', message: 'Build artifacts' })
  return { host, wb, sessions, cwd, starts, tasks, context: host.roots.get('parent').context }
}

test('dependent isolated workers merge prerequisites and retain reviewable final changes', async t => {
  const h = await harness(t)
  const result = await h.host.delegate(h.context, [
    { key: 'first', workerId: 'w', title: 'First', mode: 'execute', instructions: 'first' },
    { key: 'second', dependsOn: ['first'], workerId: 'w', title: 'Second', mode: 'execute', instructions: 'dependent' },
  ])
  assert.deepEqual(result.tasks.map(task => task.status), ['completed', 'completed'])
  assert.notEqual(h.tasks[0].cwd, h.cwd)
  assert.notEqual(h.tasks[0].cwd, h.tasks[1].cwd)
  assert.equal(await fs.readFile(path.join(h.cwd, 'first.txt'), 'utf8'), 'first')
  await assert.rejects(fs.stat(path.join(h.cwd, 'second.txt')), { code: 'ENOENT' })
  await h.host.mergeTask('parent', result.tasks[1].taskId)
  assert.equal(await fs.readFile(path.join(h.cwd, 'second.txt'), 'utf8'), 'second')
  const rootTask = Object.values(h.wb.store.state.tasks).find(task => task.sessionId === 'parent')
  assert.equal(rootTask.subtasks[result.tasks[1].taskId].mergePending, false)
})

test('isolated task merge preserves an intervening manual edit', async t => {
  const h = await harness(t)
  const result = await h.host.delegate(h.context, [{ workerId: 'w', title: 'First', mode: 'execute', instructions: 'first' }])
  await fs.writeFile(path.join(h.cwd, 'first.txt'), 'manual')
  await assert.rejects(h.host.mergeTask('parent', result.tasks[0].taskId), /changed since checkpoint/)
  assert.equal(await fs.readFile(path.join(h.cwd, 'first.txt'), 'utf8'), 'manual')
})

test('dependency cycles are rejected before starting any worker', async t => {
  const h = await harness(t)
  await assert.rejects(h.host.delegate(h.context, ['a', 'b'].map((key, index) => ({ key, dependsOn: [index ? 'a' : 'b'], workerId: 'w', title: key, mode: 'execute', instructions: key }))), /循环/)
  assert.equal(h.tasks.length, 0)
})

test('a project policy confirmation is never automatically accepted by full mode', async t => {
  const h = await harness(t)
  const record = h.sessions.sessions.get('parent')
  h.sessions.resolveRuntime = () => ({ permissionMode: 'full' })
  let answers = 0
  h.sessions.respondUi = async () => { answers++ }
  h.sessions.ingest(record.piSessionPath, { type: 'extension_ui_request', id: 'policy', method: 'confirm', title: '[Project policy] Review operation' })
  assert.equal(answers, 0)
  assert.ok(h.sessions.approvals.has('parent'))
  await h.sessions.approve({ sessionId: 'parent', requestId: 'policy', decision: 'deny' })
})
