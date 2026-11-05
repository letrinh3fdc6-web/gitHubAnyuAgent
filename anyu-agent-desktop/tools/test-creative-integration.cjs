const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { AgentWorkbench } = require('../agent-workbench.cjs')
const { CreativeStudio } = require('../creative-studio.cjs')
const { CodexTools } = require('../codex-tools.cjs')

test('Pi and App Server share revisioned creative projects, account and project policies', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-creative-adapters-'))
  const cwd = path.join(directory, 'workspace')
  await fs.mkdir(cwd)
  let owner = '42', installed = true, creates = 0
  const studio = new CreativeStudio({ userData: directory, getOwner: () => owner, installed: () => installed, catalog: async () => [], create: async () => { creates++; throw new Error('Unexpected image submission') } })
  const workbench = new AgentWorkbench({ directory, getOwner: () => owner, encrypt: text => text, decrypt: text => text, creative: (task, input) => studio.dispatch(task, input) })
  await workbench.init()
  const task = await workbench.begin({ sessionId: 'creative-adapter-session', cwd, model: 'user-selected-model', permissionMode: 'full' }, { runId: 'creative-adapter-run', input: 'Prepare a product brief' }, { lazyCheckpoint: true })
  const context = workbench.context(task.sessionId)
  const names = ['ANYU_TASK_PORT', 'ANYU_TASK_TOKEN', 'ANYU_PERMISSION_MODE']
  const saved = new Map(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, { ANYU_TASK_PORT: String(context.port), ANYU_TASK_TOKEN: context.token, ANYU_PERMISSION_MODE: 'full' })
  t.after(async () => {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await studio.close(); await workbench.close()
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  })
  const extension = await import(pathToFileURL(path.resolve(__dirname, '../pi-workbench-extension.mjs')).href)
  const registered = new Map()
  extension.default({ registerTool: tool => registered.set(tool.name, tool), on() {} })
  const pi = registered.get('creative_studio')
  assert.ok(pi)
  const created = (await pi.execute('pi-create', { action: 'create', kind: 'ecommerce', name: '同一杯子两种场景' })).details
  assert.equal(created.sessionId, task.sessionId)
  const native = await new CodexTools({ cwd, agentDir: path.join(directory, 'agent'), ask: async () => true, emit() {}, model: { id: 'test' } }).initialize()
  assert.ok(native.specs().some(tool => tool.name === 'creative_studio'))
  const call = arguments_ => native.perform({ tool: 'creative_studio', callId: 'native-creative', arguments: arguments_ })
  const savedPlan = await call({ action: 'save', projectId: created.projectId, revision: 0, plan: { objective: '商品主图', styleLock: '保留原杯子外观', items: [{ id: 'hero', kind: 'product', title: '主图', prompt: '单个杯子，白底自然光' }] } })
  assert.equal(savedPlan.success, true, JSON.stringify(savedPlan))
  const inspected = (await pi.execute('pi-inspect', { action: 'inspect', projectId: created.projectId })).details
  assert.equal(inspected.revision, 1)
  assert.equal(inspected.plan.items[0].id, 'hero')
  assert.ok((await fs.stat(path.join(created.directory, 'index.html'))).size > 100)
  const stale = await call({ action: 'save', projectId: created.projectId, revision: 0, plan: inspected.plan })
  assert.equal(stale.success, false)
  assert.match(stale.contentItems[0].text, /已被修改/)
  task.settings.policy.network = false
  const denied = await call({ action: 'generate', projectId: created.projectId, revision: 1, groupId: 3, model: 'image-model' })
  assert.equal(denied.success, false)
  assert.match(denied.contentItems[0].text, /Network tools disabled/)
  assert.equal(creates, 0)
  task.settings.policy.network = true
  installed = false
  await assert.rejects(pi.execute('pi-create-uninstalled', { action: 'create', kind: 'ecommerce', name: 'Not installed' }), /先从技能商店/)
  assert.equal((await pi.execute('pi-existing', { action: 'inspect', projectId: created.projectId })).details.projectId, created.projectId)
  const readOnly = await new CodexTools({ cwd, readOnly: true, agentDir: path.join(directory, 'readonly'), ask: async () => true, emit() {}, model: { id: 'test' } }).initialize()
  assert.ok(!readOnly.specs().some(tool => tool.name === 'creative_studio'))
  const unauthenticated = await fetch(`http://127.0.0.1:${context.port}/creative`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'inspect', projectId: created.projectId }) })
  assert.equal(unauthenticated.status, 403)
  owner = 'another-user'
  await assert.rejects(pi.execute('pi-old-account', { action: 'inspect', projectId: created.projectId }), /no longer active/)
})
