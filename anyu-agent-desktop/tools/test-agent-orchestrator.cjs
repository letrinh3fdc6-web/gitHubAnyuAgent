'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AgentSessionService } = require('../agent-session.cjs')
const { AgentOrchestrator, ToolLeases, resolveConfig } = require('../agent-orchestrator.cjs')

const models = [
  { id: 'gpt-6-astra', group_id: 10, api: 'openai-responses', provider: 'oai' },
  { id: 'deepseek-v4', group_id: 20, api: 'openai-completions', provider: 'oai', thinking: { levels: ['high', 'max'] } },
  { id: 'claude-sonnet', group_id: 30, api: 'anthropic-messages', provider: 'anthropic' },
]
const team = { enabled: true, maxParallel: 2, maxTasks: 8, timeoutMinutes: 10, workers: models.slice(1).map((model, index) => ({ id: `worker${index}`, selection: { model: model.id, groupId: model.group_id, api: model.api, thinkingLevel: 'auto' } })) }
const plan = (workerId = 'worker0', mode = 'read') => ({ workerId, mode, title: 'Verify files', instructions: 'Inspect the assigned files and return evidence.' })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function waitFor(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick() } assert.ok(check(), 'condition was not met') }

async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-orchestrator-'))
  const starts = [], prompts = [], events = [], runtimes = new Map(), retired = []
  let counter = 0
  const sessions = new AgentSessionService({
    userDataDir: dir,
    startRuntime: async config => {
      starts.push(config)
      if (config.agentRole === 'child') await options.beforeChildStart?.()
      const sessionPath = config.sessionPath || path.join(dir, `${++counter}.jsonl`)
      runtimes.set(sessionPath, {})
      return { sessionPath, cwd: dir, permissionMode: config.permissionMode || 'confirm' }
    },
    resolveRuntime: key => runtimes.get(key),
    sendCommand: async command => {
      if (command.type === 'prompt') prompts.push(command)
      if (command.type === 'abort') sessions.ingest(command.sessionKey, { type: 'agent_settled' })
    },
    respondUi: async () => {},
    broadcast: (_, payload) => events.push(payload.event),
  })
  const host = new AgentOrchestrator({ sessions, getCatalog: async () => ({ models }), retireRuntime: async key => { retired.push(key); runtimes.delete(key) } })
  t.after(async () => {
    await host.close()
    // The directory is created uniquely by this test and contains no source.
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await host.start({ sessionId: 'parent', model: models[0].id, models: [models[0]], team, permissionMode: 'confirm' })
  await host.prompt({ sessionId: 'parent', message: 'Implement and verify' })
  const root = host.roots.get('parent')
  function finish(id, text = 'Verified result', error = '') {
    const key = sessions.sessions.get(id).piSessionPath
    sessions.ingest(key, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], errorMessage: error } })
    sessions.ingest(key, { type: 'agent_settled' })
  }
  return { host, sessions, root, starts, prompts, events, finish, retired, dir }
}

test('bindings require the exact group, protocol and thinking level', () => {
  assert.equal(resolveConfig(team, models).workers[0].catalogModel, models[1])
  assert.throws(() => resolveConfig({ ...team, workers: [{ ...team.workers[0], selection: { ...team.workers[0].selection, groupId: 99 } }] }, models), /不可用/)
  assert.throws(() => resolveConfig({ ...team, workers: [{ ...team.workers[0], selection: { ...team.workers[0].selection, thinkingLevel: 'invented' } }] }, models), /思考/)
  assert.throws(() => resolveConfig({ ...team, maxTasks: 9 }, models), /限制/)
})

test('two independent models run in isolated child sessions and do not finish their parent', async t => {
  const h = await harness(t)
  const promise = h.host.delegate(h.root.context, [plan(), plan('worker1')])
  await waitFor(() => h.prompts.length === 3)
  const children = [...h.host.children.keys()]
  assert.equal(children.length, 2)
  assert.deepEqual(h.starts.slice(1).map(item => item.model), [models[1].id, models[2].id])
  assert.ok(h.starts.slice(1).every(item => item.background && item.readOnly && item.models.length === 1))
  assert.notEqual(h.starts[1].orchestration.token, h.starts[2].orchestration.token)
  children.forEach(id => h.finish(id))
  const result = await promise
  assert.ok(result.tasks.every(item => item.status === 'completed'))
  assert.ok(h.sessions.runs.has('parent'))
  assert.equal(h.retired.length, 2)
  assert.deepEqual(h.sessions.list().map(item => item.sessionId), ['parent'])
  h.finish('parent', 'Final reviewed answer')
  await tick()
  const answer = h.sessions.snapshot({ sessionId: 'parent' }).messages.at(-1)
  assert.equal(answer.content, 'Final reviewed answer')
  assert.equal(answer.subagents.length, 2)
  assert.ok(answer.subagents.every(item => item.status === 'completed'))
})

test('parent cancellation stops running children and never starts queued work', async t => {
  const h = await harness(t)
  const outcome = h.host.delegate(h.root.context, [plan(), plan(), plan(), plan()]).catch(error => error)
  await waitFor(() => h.prompts.length === 3)
  await h.host.abort({ sessionId: 'parent' })
  assert.equal((await outcome).code, 'ERR_CANCELED')
  assert.equal(h.prompts.length, 3)
  assert.equal(h.sessions.runs.size, 0)
  assert.equal(h.host.children.size, 0)
  assert.equal(h.host.leases.active.size, 0)
  assert.equal(h.host.childSlots, 0)
  await h.host.start({ sessionId: 'parent', model: models[0].id, models: [models[0]] })
  await h.host.prompt({ sessionId: 'parent', message: 'Single agent again' })
  assert.ok(h.sessions.runs.has('parent'))
  assert.equal(h.host.roots.size, 0)
})

test('cancel during child startup retires the late process without submitting its prompt', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = await harness(t, { beforeChildStart: () => gate })
  const result = h.host.delegate(h.root.context, [plan()]).catch(error => error)
  await waitFor(() => h.starts.length === 2)
  const cancellation = h.host.abort({ sessionId: 'parent' })
  release()
  await cancellation
  assert.equal((await result).code, 'ERR_CANCELED')
  assert.equal(h.prompts.length, 1)
  assert.equal(h.retired.length, 1)
})

test('execution workers hold one lease across all steps; reads can run together', async t => {
  const h = await harness(t)
  const pending = h.host.delegate(h.root.context, [plan('worker0', 'execute'), plan('worker1', 'execute')])
  await waitFor(() => h.prompts.length === 2)
  assert.equal(h.starts.length, 2)
  const first = [...h.host.children.values()].find(child => child.task.startedAt)
  await h.host.leases.acquire(first.context, 'write-file', 'write', first.run.controller.signal)
  h.host.leases.release(first.context, 'write-file')
  h.finish(first.context.sessionId)
  await waitFor(() => h.prompts.length === 3)
  const second = [...h.host.children.values()].find(child => child.context.sessionId !== first.context.sessionId)
  h.finish(second.context.sessionId)
  await pending
  assert.equal(h.host.leases.active.size, 0)
})

test('child approvals are routed to the parent view with the actual child session', async t => {
  const h = await harness(t)
  const pending = h.host.delegate(h.root.context, [plan('worker0', 'execute')])
  await waitFor(() => h.prompts.length === 2)
  const child = [...h.host.children.values()][0]
  const record = h.sessions.sessions.get(child.context.sessionId)
  h.sessions.ingest(record.piSessionPath, { type: 'extension_ui_request', id: 'allow-write', method: 'confirm', title: 'Write file?' })
  const approval = h.events.find(event => event.sessionId === 'parent' && event.type === 'approval.requested')
  assert.equal(approval.request.sessionId, child.context.sessionId)
  assert.equal(h.host.snapshot({ sessionId: 'parent' }).approvals[0].sessionId, child.context.sessionId)
  await h.sessions.approve({ sessionId: approval.request.sessionId, requestId: approval.request.requestId, decision: 'deny' })
  h.finish(child.context.sessionId, '', 'Write denied')
  assert.equal((await pending).tasks[0].status, 'failed')
})

test('host enforces token context, readonly tools, depth and batch limits', async t => {
  const h = await harness(t)
  const url = `http://127.0.0.1:${h.host.port}`
  const denied = await fetch(`${url}/delegate`, { method: 'POST', body: '{}' })
  assert.equal(denied.status, 403)
  await assert.rejects(h.host.delegate(h.root.context, Array(5).fill(plan())), /限制/)
  const pending = h.host.delegate(h.root.context, [plan()])
  await waitFor(() => h.prompts.length === 2)
  const child = [...h.host.children.values()][0]
  const nested = await fetch(`${url}/delegate`, { method: 'POST', headers: { 'X-AnYu-Agent-Token': child.context.token }, body: JSON.stringify({ tasks: [plan()] }) })
  assert.equal(nested.status, 400)
  const write = await fetch(`${url}/acquire`, { method: 'POST', headers: { 'X-AnYu-Agent-Token': child.context.token }, body: JSON.stringify({ toolCallId: 'bad', toolName: 'bash' }) })
  assert.equal(write.status, 400)
  h.finish(child.context.sessionId)
  await pending
})

test('shared reads coexist and a cancelled writer cannot release an active lease early', async () => {
  const leases = new ToolLeases(), a = { token: 'a' }, b = { token: 'b' }, c = { token: 'c' }
  const signal = new AbortController()
  await leases.acquire(a, 'read-a', 'read', signal.signal)
  await leases.acquire(b, 'read-b', 'read', signal.signal)
  const pending = leases.acquire(c, 'write', 'bash', signal.signal).catch(error => error)
  signal.abort()
  assert.equal((await pending).code, 'ERR_CANCELED')
  assert.equal(leases.active.size, 2)
  leases.releaseContext(a)
  leases.releaseContext(b)
  assert.equal(leases.active.size, 0)
})

test('a repeated delegation request is joined, not executed again', async t => {
  const h = await harness(t)
  const request = () => fetch(`http://127.0.0.1:${h.host.port}/delegate`, { method: 'POST', headers: { 'X-AnYu-Agent-Token': h.root.context.token }, body: JSON.stringify({ requestId: 'same-call', tasks: [plan()] }) }).then(response => response.json())
  const first = request()
  await waitFor(() => h.prompts.length === 2)
  const second = request()
  const child = [...h.host.children.values()][0]
  h.finish(child.context.sessionId)
  assert.deepEqual(await first, await second)
  assert.equal(h.prompts.length, 2)
})

test('retiring a context removes its waiting tools before granting the next worker', async () => {
  const leases = new ToolLeases(), owner = { token: 'owner' }, retired = { token: 'retired' }, next = { token: 'next' }
  const signal = new AbortController().signal
  await leases.acquire(owner, 'write', 'write', signal)
  const stale = leases.acquire(retired, 'read', 'read', signal).catch(error => error)
  const waiting = leases.acquire(next, 'write', 'write', signal)
  leases.releaseContext(retired)
  assert.equal((await stale).code, 'ERR_CANCELED')
  leases.releaseContext(owner)
  await waiting
  assert.equal(leases.active.size, 1)
  assert.equal([...leases.active.values()][0].context, next)
  leases.releaseContext(next)
})
