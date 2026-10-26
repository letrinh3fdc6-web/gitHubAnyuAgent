'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { AgentWorkbench } = require('../agent-workbench.cjs')
const { WorkspaceCheckpoints, safePath } = require('../workspace-checkpoints.cjs')
const { verify } = require('../agent-verification.cjs')

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-workbench-test-'))
  const cwd = path.join(directory, 'project')
  await fs.mkdir(cwd)
  const wb = new AgentWorkbench({ directory, encrypt: text => `encrypted:${text}`, decrypt: text => text.slice(10), getOwner: () => '1', billing: async () => [], resume: async () => ({ ok: true }), inspect: async () => ({ ready: true }), repair: async () => ({ ready: true }), ...options })
  await wb.init()
  t.after(async () => { await wb.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const begin = async (sessionId = 'session', parentSessionId = '') => wb.begin({ cwd, sessionId, parentSessionId, model: 'test', models: [], permissionMode: 'confirm' }, { runId: crypto.randomUUID(), input: 'Test task' }, {})
  const finish = async task => { wb.event({ sessionId: task.sessionId, runId: task.id, type: 'run.finished', status: 'completed', text: 'Done' }); await wb.settled(task.id) }
  return { wb, directory, cwd, begin, finish }
}

test('durable checkpoints survive a main-process restart and never replay automatically', async t => {
  let resumed = 0
  const h = await fixture(t, { resume: async () => { resumed++; return { ok: true } } })
  const task = await h.begin()
  await h.wb.checkpoint('session', 'One artifact complete, next validate it')
  const second = new AgentWorkbench({ ...h.wb.options })
  await second.init()
  t.after(() => second.close())
  assert.equal(second.task(task.id).status, 'interrupted')
  assert.equal(resumed, 0)
  await second.recovery(task.id)
  assert.equal(resumed, 1)
  assert.match(second.task(task.id).checkpoints[0].summary, /artifact/)
})

test('rollback restores modified/deleted files and removes only task-created files', async t => {
  const h = await fixture(t)
  await fs.writeFile(path.join(h.cwd, 'old.txt'), 'before')
  await fs.writeFile(path.join(h.cwd, 'deleted.txt'), 'keep')
  const task = await h.begin()
  await fs.writeFile(path.join(h.cwd, 'old.txt'), 'after')
  await fs.unlink(path.join(h.cwd, 'deleted.txt'))
  await fs.writeFile(path.join(h.cwd, 'new.txt'), 'created')
  await h.finish(task)
  assert.equal(task.changes.length, 3)
  await h.wb.review(task.id, 'rollback')
  assert.equal(await fs.readFile(path.join(h.cwd, 'old.txt'), 'utf8'), 'before')
  assert.equal(await fs.readFile(path.join(h.cwd, 'deleted.txt'), 'utf8'), 'keep')
  await assert.rejects(fs.stat(path.join(h.cwd, 'new.txt')), { code: 'ENOENT' })
})

test('rollback accepts a workspace reached through a directory alias', async t => {
  const h = await fixture(t)
  const alias = path.join(h.directory, 'project-alias')
  await fs.symlink(h.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(path.join(h.cwd, 'old.txt'), 'before')
  const before = await h.wb.snapshots.capture(alias)
  await fs.writeFile(path.join(h.cwd, 'old.txt'), 'after')
  await fs.writeFile(path.join(h.cwd, 'new.txt'), 'created')
  const after = await h.wb.snapshots.capture(alias)
  await h.wb.snapshots.apply(alias, h.wb.snapshots.changes(before, after), true)
  assert.equal(await fs.readFile(path.join(h.cwd, 'old.txt'), 'utf8'), 'before')
  await assert.rejects(fs.stat(path.join(h.cwd, 'new.txt')), { code: 'ENOENT' })
})

test('rollback rejects the entire change set if the user edited one file afterward', async t => {
  const h = await fixture(t)
  await fs.writeFile(path.join(h.cwd, 'a.txt'), 'old')
  const task = await h.begin()
  await fs.writeFile(path.join(h.cwd, 'a.txt'), 'agent')
  await fs.writeFile(path.join(h.cwd, 'b.txt'), 'agent')
  await h.finish(task)
  await fs.writeFile(path.join(h.cwd, 'b.txt'), 'user')
  await assert.rejects(h.wb.review(task.id, 'rollback'), /changed since checkpoint/)
  assert.equal(await fs.readFile(path.join(h.cwd, 'a.txt'), 'utf8'), 'agent')
  assert.equal(await fs.readFile(path.join(h.cwd, 'b.txt'), 'utf8'), 'user')
})

test('path traversal, symlinks and credentials are excluded from restores', async t => {
  const h = await fixture(t)
  await fs.writeFile(path.join(h.cwd, '.env'), 'SECRET_TOKEN=private')
  await fs.mkdir(path.join(h.cwd, 'node_modules'))
  await fs.writeFile(path.join(h.cwd, 'node_modules', 'ignored'), 'dependency')
  const snapshot = await h.wb.snapshots.capture(h.cwd)
  assert.equal(snapshot.files['.env'], undefined)
  assert.ok(snapshot.skipped.includes('.env'))
  assert.equal(Object.keys(snapshot.files).length, 0)
  await assert.rejects(safePath(h.cwd, '../state.json'), /leaves workspace/)
  const outside = path.join(h.directory, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(h.cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(safePath(h.cwd, 'link/data.txt'), /links|junctions/)
})

test('bounded snapshots report incomplete coverage instead of pretending full recovery', async t => {
  const h = await fixture(t)
  await fs.writeFile(path.join(h.cwd, 'large.txt'), '123456789')
  const snapshots = new WorkspaceCheckpoints(path.join(h.directory, 'limited'), { maxFileBytes: 3 })
  const result = await snapshots.capture(h.cwd)
  assert.equal(result.complete, false)
  await assert.rejects(snapshots.isolate(h.cwd, path.join(h.directory, 'copy')), /limits/)
})

test('acceptance uses file evidence, JSON validation and real command exit codes', async t => {
  const h = await fixture(t)
  await fs.writeFile(path.join(h.cwd, 'result.json'), '{"ok":true}')
  const results = await verify(h.cwd, [
    { kind: 'json', path: 'result.json', requiredKeys: ['ok'] },
    { kind: 'json', path: 'result.json', requiredKeys: ['missing'] },
    { kind: 'command', command: process.execPath, args: ['-e', 'process.exit(7)'] },
    { kind: 'command', command: process.execPath, args: ['-e', 'console.log("verified")'] },
  ])
  assert.deepEqual(results.map(item => item.ok), [true, false, false, true])
  assert.equal(results[2].code, 7)
  assert.match(results[3].evidence, /verified/)
})

test('parent and child calls share a serialized request cap', async t => {
  const h = await fixture(t)
  const project = await h.wb.project(h.cwd)
  project.settings.maxRequests = 1
  const parent = await h.begin()
  await h.begin('child', 'session')
  const results = await Promise.allSettled([h.wb.request('session', 'a', 'one'), h.wb.request('child', 'b', 'two')])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(h.wb.cost(parent.id).requests, 1)
})

test('explicit zero disables only the request cap and still records parent and child requests', async t => {
  const h = await fixture(t)
  const project = await h.wb.project(h.cwd)
  await h.wb.settings(h.cwd, { ...project.settings, maxRequests: 0 })
  const root = await h.begin()
  await h.begin('child', 'session')
  await Promise.all(Array.from({ length: 105 }, (_, index) => h.wb.request(index % 2 ? 'child' : 'session', `request-${index}`, 'model')))
  assert.equal(h.wb.cost(root.id).requests, 105)
  project.settings.maxRequests = 1
  const next = await h.begin('other', '')
  await h.wb.request('other', 'first', 'model')
  await assert.rejects(h.wb.request('other', 'second', 'model'), error => error.code === 'TASK_REQUEST_LIMIT' && /0 为不限/.test(error.message))
  assert.equal(h.wb.cost(next.id).requests, 1)
})

test('actual backend billing is deduplicated; pending billing and spend threshold stop new calls', async t => {
  let records = []
  const h = await fixture(t, { billing: async () => records })
  const project = await h.wb.project(h.cwd)
  project.settings.budget = 1
  const task = await h.begin()
  await h.wb.request('session', 'one', 'model')
  await h.wb.response('one', 'server-one', 200)
  await assert.rejects(h.wb.request('session', 'two', 'model'), /pending/)
  records = [{ request_id: 'client:server-one', actual_cost: 1.25 }]
  await h.wb.syncBilling(task.id)
  await h.wb.syncBilling(task.id)
  assert.equal(h.wb.cost(task.id).actual, 1.25)
  await assert.rejects(h.wb.request('session', 'three', 'model'), /threshold/)
})

test('project memory has editable provenance and is separated by project', async t => {
  const h = await fixture(t)
  await h.wb.memory(h.cwd, 'save', { text: 'Use TypeScript strict mode', source: 'docs/style.md' })
  const [item] = await h.wb.memory(h.cwd, 'search', { query: 'typescript' })
  assert.equal(item.source, 'docs/style.md')
  await h.wb.memory(h.cwd, 'save', { id: item.id, text: 'Use Go', source: 'user' })
  assert.equal((await h.wb.memory(h.cwd, 'search', { query: 'typescript' })).length, 0)
  await h.wb.memory(h.cwd, 'delete', { id: item.id })
  assert.equal((await h.wb.project(h.cwd)).memory.length, 0)
})

test('full permission does not bypass explicit project policies', async t => {
  const h = await fixture(t)
  const project = await h.wb.project(h.cwd)
  project.settings.policy = { shell: 'deny', workspaceOnly: true, network: false, blockedTools: ['plugin_danger'] }
  await h.begin()
  assert.equal((await h.wb.authorize('session', 'bash', { command: 'echo hello' })).decision, 'deny')
  assert.equal((await h.wb.authorize('session', 'write', { path: '../outside.txt' })).decision, 'deny')
  assert.equal((await h.wb.authorize('session', 'mcp_call', {})).decision, 'deny')
  assert.equal((await h.wb.authorize('session', 'read', { path: 'file.txt' })).decision, 'allow')
  assert.equal((await h.wb.authorize('session', 'plugin_danger', {})).decision, 'deny')
})

test('diagnostics omit prompts, tool arguments, outputs and filesystem content', async t => {
  const h = await fixture(t)
  const task = await h.begin()
  task.input = 'token=super-secret'; task.result = 'private code'; task.error = 'Bearer abc'
  const report = JSON.stringify(await h.wb.dispatch('diagnostics', { id: task.id }))
  assert.ok(!/super-secret|private code|Bearer/.test(report))
  assert.ok(report.includes(task.id))
})

test('connector credentials are encrypted and tool use requires an explicit allowlist', async t => {
  const h = await fixture(t)
  const list = await h.wb.connectors.save({ name: 'test', transport: 'http', url: 'https://example.com/mcp', token: 'private' })
  assert.equal(list[0].secret, undefined)
  assert.equal(list[0].authenticated, true)
  assert.equal(h.wb.store.state.connectors[list[0].id].secret, 'encrypted:private')
  await assert.rejects(h.wb.connectors.call(list[0].id, 'write', {}), /not been enabled/)
  await assert.rejects(h.wb.connectors.save({ name: 'bad', transport: 'http', url: 'http://example.com/mcp' }), /HTTPS/)
})

test('environment validation writes a real probe and retains the original task', async t => {
  const h = await fixture(t)
  const task = await h.begin()
  await h.finish(task)
  const result = await h.wb.inspectEnvironment(h.cwd, { commands: ['git'] }, true)
  assert.equal(result.writable, true)
  assert.equal(h.wb.task(task.id).input, 'Test task')
  assert.equal((await fs.readdir(h.cwd)).length, 0)
})

test('workflows do not overlap or replay after restart', async t => {
  let calls = 0
  const h = await fixture(t, { workflow: async () => { calls++; return { runId: 'scheduled-run' } } })
  const task = await h.begin(); await h.finish(task)
  const flow = await h.wb.saveWorkflow(h.cwd, { taskId: task.id, name: 'daily', intervalMinutes: 5, enabled: true })
  flow.nextAt = new Date(0).toISOString()
  await Promise.all([h.wb.tick(), h.wb.tick()])
  assert.equal(calls, 1)
  await assert.rejects(h.wb.runWorkflow(flow.id), /already running/)
  const second = new AgentWorkbench({ ...h.wb.options })
  await second.init(); t.after(() => second.close())
  assert.equal(second.store.state.workflows[flow.id].enabled, false)
  assert.equal(second.store.state.workflows[flow.id].status, 'review')
})

test('local runtime endpoints require the task token and reject inactive sessions', async t => {
  const h = await fixture(t)
  const origin = `http://127.0.0.1:${h.wb.port}`
  const token = h.wb.context('session').token
  assert.equal((await fetch(`${origin}/memory`, { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await fetch(`${origin}/memory`, { method: 'POST', headers: { 'X-AnYu-Task-Token': token }, body: '{}' })).status, 400)
  await h.begin()
  assert.equal((await fetch(`${origin}/memory`, { method: 'POST', headers: { 'X-AnYu-Task-Token': token }, body: '{}' })).status, 200)
})
