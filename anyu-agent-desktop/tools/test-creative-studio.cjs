const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { CreativeStudio } = require('../creative-studio.cjs')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMSEAAAAASUVORK5CYII=', 'base64')
const draft = (count = 2) => ({ objective: '验证商品视觉工作流', styleLock: '保留原商品结构，白底柔光', items: Array.from({ length: count }, (_, i) => ({ id: `item-${i + 1}`, kind: 'product', title: `商品图 ${i + 1}`, prompt: `同一商品的第 ${i + 1} 个视角` })) })
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(test) { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw new Error('Test condition timed out'); await tick() } }

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-creative-test-'))
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd)
  let owner = '42', creates = 0, statuses = 0
  const records = new Map()
  const task = { owner, cwd, sessionId: 'session-one', settings: { policy: { network: true, workspaceOnly: false, blockedTools: [] } } }
  const options = {
    userData: path.join(root, 'profile'), getOwner: () => owner, pollInterval: 5, pollTimeout: 100,
    catalog: async () => [{ id: 3, name: 'Images', platform: 'openai', status: 'active', allow_image_generation: true, models: [{ name: 'gpt-image-1', capability: 'image' }] }],
    create: async fields => { const id = `remote-${++creates}`; const record = { id, ...fields, status: 'completed', image_count: 1 }; records.set(id, record); return record },
    status: async id => { statuses++; return records.get(id) },
    download: async () => PNG,
  }
  const studio = new CreativeStudio(options)
  const create = async (input = {}) => studio.dispatch(task, { action: 'create', kind: 'ecommerce', name: '测试商品', ...input })
  const save = async (project, plan = draft()) => studio.dispatch(task, { action: 'save', projectId: project.projectId, revision: project.revision, plan })
  const generate = (project, extra = {}) => studio.dispatch(task, { action: 'generate', projectId: project.projectId, revision: project.revision, groupId: 3, model: 'gpt-image-1', ...extra })
  const wait = async id => { await studio.jobs.get(id)?.promise; return studio.dispatch(task, { action: 'inspect', projectId: id }) }
  try { await run({ root, cwd, task, options, studio, create, save, generate, wait, records, setOwner: value => { owner = value }, creates: () => creates, statuses: () => statuses }) }
  finally { await studio.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
}

test('create, persist, generate anchor before dependent shots, export real local files and do not rebill completed work', async () => fixture(async f => {
  await fs.writeFile(path.join(f.cwd, 'reference.png'), PNG)
  let project = await f.create({ files: [path.join(f.cwd, 'reference.png')] })
  const plan = draft()
  plan.items[0].referenceIds = ['ref-001']; plan.items[1].dependsOn = ['item-1']
  project = await f.save(project, plan)
  const sentFiles = [], original = f.options.create
  f.options.create = async (fields, files) => { sentFiles.push(files); return original(fields) }
  await Promise.all([f.generate(project), f.generate(project)])
  const result = await f.wait(project.projectId)
  assert.equal(f.creates(), 2)
  assert.equal(sentFiles[0].length, 1); assert.equal(sentFiles[1].length, 1)
  assert.ok(result.items.every(item => item.status === 'completed'))
  assert.ok((await fs.readFile(path.join(project.directory, result.items[0].file))).equals(PNG))
  assert.ok((await fs.readFile(path.join(project.directory, 'index.html'), 'utf8')).includes('<img'))
  await f.generate(project); await f.wait(project.projectId)
  assert.equal(f.creates(), 2)
}))

test('project placement retains the creating run through later edits, progress and restoration', async () => fixture(async f => {
  const events = []
  f.options.changed = progress => events.push(progress)
  f.task.id = 'native-origin'
  const project = await f.create()
  assert.equal(project.originRunId, 'native-origin')
  assert.ok(Number.isFinite(Date.parse(project.createdAt)))
  f.task.id = 'native-later'
  const saved = await f.save(project, draft(1))
  await f.generate(saved); await f.wait(saved.projectId)
  assert.ok(events.length > 1)
  assert.ok(events.every(event => event.originRunId === 'native-origin' && event.createdAt === project.createdAt))
  const restored = new CreativeStudio(f.options)
  try {
    const listed = await restored.dispatch(f.task, { action: 'list' })
    assert.equal(listed.projects[0].originRunId, 'native-origin')
    assert.equal(listed.projects[0].createdAt, project.createdAt)
    const file = path.join(project.directory, 'project.json')
    const legacy = JSON.parse(await fs.readFile(file, 'utf8'))
    delete legacy.originRunId
    await fs.writeFile(file, JSON.stringify(legacy))
    const old = await restored.dispatch(f.task, { action: 'inspect', projectId: project.projectId })
    assert.equal(old.originRunId, '')
    assert.equal(old.createdAt, project.createdAt)
  } finally { await restored.close() }
}))

test('failed anchor blocks dependent images; explicit retry preserves successful outputs', async () => fixture(async f => {
  let fail = true
  const original = f.options.create
  f.options.create = async fields => { const result = await original(fields); if (fail && result.id === 'remote-1') result.status = 'failed'; return result }
  const plan = draft(3); plan.items[1].dependsOn = ['item-1']
  const project = await f.save(await f.create(), plan)
  await f.generate(project); let result = await f.wait(project.projectId)
  assert.equal(f.creates(), 2)
  assert.deepEqual(result.items.map(item => item.status), ['failed', 'blocked', 'completed'])
  await assert.rejects(f.generate(project), /retryFailed/)
  fail = false
  await f.generate(project, { retryFailed: true }); result = await f.wait(project.projectId)
  assert.equal(f.creates(), 4)
  assert.ok(result.items.every(item => item.status === 'completed'))
}))

test('campaign planning reaches real submission and local edits preserve unrelated completed images', async () => fixture(async f => {
  await fs.writeFile(path.join(f.cwd, 'product.png'), PNG)
  const plan = draft(3)
  plan.productLock = 'Keep the actual product outline and logo'
  plan.audience = 'Home cooks'; plan.platform = 'Taobao'
  const purposes = ['Identify this product', 'Inspect the actual joint', 'Understand the included parts']
  const cameras = ['Full product on white', 'Macro joint close-up', 'Overhead parts layout']
  for (const [index, item] of plan.items.entries()) {
    Object.assign(item, { purpose: purposes[index], camera: cameras[index], referenceIds: ['ref-001'] })
  }
  plan.items[1].dependsOn = ['item-1']
  let project = await f.create({ files: ['product.png'] })
  const invalid = structuredClone(plan); invalid.items[1].purpose = invalid.items[0].purpose
  await assert.rejects(f.save(project, invalid), /用途重复/)
  assert.equal(f.creates(), 0)
  project = await f.save(project, plan)
  const sent = [], original = f.options.create
  f.options.create = async (fields, files) => { sent.push({ fields, files }); return original(fields) }
  await f.generate(project)
  const completed = await f.wait(project.projectId)
  assert.equal(f.creates(), 3)
  const detail = sent.find(({ fields }) => fields.prompt.includes(purposes[1]))
  assert.ok(detail.fields.prompt.includes(cameras[1]))
  assert.ok(detail.fields.prompt.includes(plan.audience))
  assert.equal(detail.files.length, 2)
  assert.equal(detail.files[0].name, 'ref-001.png')
  assert.equal(detail.files[1].name, 'item-1-1.png')
  assert.match(detail.fields.prompt, /参考图2（item-1）：已生成的参考图/)
  assert.ok(sent.every(({ fields }) => [...fields.prompt].length <= 6000))
  assert.ok((await fs.readFile(path.join(project.directory, 'storyboard.csv'), 'utf8')).includes(purposes[1]))
  const edit = structuredClone(project.plan); edit.items[1].camera += ', tighter crop'
  const updated = await f.save(project, edit)
  assert.deepEqual(updated.items.map(item => item.status), ['completed', 'planned', 'completed'])
  await f.generate(updated)
  const result = await f.wait(project.projectId)
  assert.equal(f.creates(), 4)
  assert.equal(result.items[0].file, completed.items[0].file)
  assert.equal(result.items[2].file, completed.items[2].file)
  assert.equal(result.items[1].file, 'images/item-2-2.png')
  await f.generate(updated); await f.wait(project.projectId)
  assert.equal(f.creates(), 4)
}))

test('scoped campaign facts and reference roles reach submission and survive project restoration', async () => fixture(async f => {
  await fs.writeFile(path.join(f.cwd, 'product.png'), PNG)
  await fs.writeFile(path.join(f.cwd, 'style.png'), PNG)
  const plan = draft(2)
  plan.productLock = 'Current blue SKU only'
  plan.claims = [
    { id: 'outer', text: 'Visible blue shell', evidence: 'Product photo', status: 'verified' },
    { id: 'bundle', text: 'One included cable', evidence: 'Packing list', status: 'verified' },
    { id: 'pending', text: 'Unconfirmed battery life', status: 'pending' },
  ]
  for (const [index, item] of plan.items.entries()) Object.assign(item, {
    purpose: index ? 'Inspect the visible surface' : 'Identify the current SKU',
    camera: index ? 'Macro surface view' : 'Whole product on white',
    referenceIds: ['ref-001', 'ref-002'], claimIds: index ? [] : ['outer'],
    referenceRoles: [{ id: 'ref-001', role: 'product', instruction: 'Only the blue SKU' }, { id: 'ref-002', role: 'style', instruction: 'Only the white space and type hierarchy' }],
  })
  const project = await f.save(await f.create({ files: ['product.png', 'style.png'] }), plan)
  const sent = [], original = f.options.create
  f.options.create = async (fields, files) => { sent.push({ fields, files }); return original(fields) }
  await f.generate(project); await f.wait(project.projectId)
  assert.equal(f.creates(), 2)
  const hero = sent.find(entry => entry.fields.prompt.includes(plan.items[0].purpose))
  assert.ok(hero.fields.prompt.includes('Visible blue shell'))
  assert.ok(sent.every(entry => !entry.fields.prompt.includes('One included cable') && !entry.fields.prompt.includes('Unconfirmed battery life')))
  assert.ok(sent.every(entry => entry.files.length === 2 && entry.fields.prompt.includes('参考图2（ref-002）：仅学习色彩')))
  const restored = new CreativeStudio(f.options)
  try {
    const inspected = await restored.dispatch(f.task, { action: 'inspect', projectId: project.projectId })
    assert.deepEqual(inspected.plan.items[0].claimIds, ['outer'])
    assert.deepEqual(inspected.plan.items[1].claimIds, [])
    assert.equal(inspected.plan.items[0].referenceRoles[1].role, 'style')
    await restored.dispatch(f.task, { action: 'generate', projectId: project.projectId, revision: project.revision, groupId: 3, model: 'gpt-image-1' })
    await restored.jobs.get(project.projectId)?.promise
    assert.equal(f.creates(), 2, 'restoration must not regenerate completed scoped plans')
  } finally { await restored.close() }
}))

test('ambiguous submission is never automatically retried and can bind a matching existing remote task', async () => fixture(async f => {
  const original = f.options.create
  f.options.create = async fields => { await original(fields); throw new Error('Connection closed after submission') }
  const project = await f.save(await f.create(), draft(1))
  await f.generate(project); let result = await f.wait(project.projectId)
  assert.equal(result.items[0].status, 'uncertain'); assert.equal(f.creates(), 1)
  await assert.rejects(f.generate(project), /提交结果不明/)
  await f.studio.dispatch(f.task, { action: 'reconcile', projectId: project.projectId, revision: 1, itemId: 'item-1', remoteTaskId: 'remote-1' })
  await f.generate(project); result = await f.wait(project.projectId)
  assert.equal(result.items[0].status, 'completed'); assert.equal(f.creates(), 1)
}))

test('cancellation stops scheduling and restart resumes remote status without a second submission', async () => fixture(async f => {
  const original = f.options.create
  f.options.create = async fields => { const remote = await original(fields); remote.status = 'running'; return remote }
  const project = await f.save(await f.create(), draft(1))
  await f.generate(project)
  await until(() => f.statuses() > 0)
  const cancelled = await f.studio.dispatch(f.task, { action: 'cancel', projectId: project.projectId })
  assert.match(cancelled.message, /上游任务可能仍在处理/)
  assert.equal(f.creates(), 1)
  await f.studio.close()
  f.records.get('remote-1').status = 'completed'
  const restarted = new CreativeStudio(f.options)
  try {
    await restarted.dispatch(f.task, { action: 'generate', projectId: project.projectId, revision: 1, groupId: 3, model: 'gpt-image-1' })
    await restarted.jobs.get(project.projectId)?.promise
    const result = await restarted.dispatch(f.task, { action: 'status', projectId: project.projectId })
    assert.equal(result.items[0].status, 'completed'); assert.equal(f.creates(), 1)
  } finally { await restarted.close() }
}))

test('plan revisions invalidate anchors and dependents, reject stale edits and archive previous results', async () => fixture(async f => {
  const plan = draft(); plan.items[1].dependsOn = ['item-1']
  const project = await f.save(await f.create(), plan)
  await f.generate(project); await f.wait(project.projectId)
  const edited = structuredClone(project.plan); edited.items[0].prompt = '改变母版视角'
  const updated = await f.save(project, edited)
  assert.ok(updated.items.every(item => item.status === 'planned'))
  assert.equal(updated.revision, 2)
  await assert.rejects(f.save(project, plan), /已被修改/)
  const stored = JSON.parse(await fs.readFile(path.join(project.directory, 'project.json')))
  assert.equal(stored.history.length, 2)
  assert.equal(JSON.parse(await fs.readFile(path.join(project.directory, 'revisions/plan-1.json'))).items[0].prompt, plan.items[0].prompt)
  await f.generate(updated); const result = await f.wait(updated.projectId)
  assert.ok(result.items.every(item => item.status === 'completed'))
  assert.equal(result.items[0].attempt, 2)
  assert.equal(result.items[0].file, 'images/item-1-2.png')
  assert.ok((await fs.readFile(path.join(project.directory, 'images/item-1-1.png'))).equals(PNG))
}))

test('explicit redo preserves old files, reuses unrelated anchors and invalidates only dependents', async () => fixture(async f => {
  const plan = draft(3); plan.items[1].dependsOn = ['item-1']
  const project = await f.save(await f.create(), plan)
  await f.generate(project); await f.wait(project.projectId)
  await assert.rejects(f.generate(project, { redoCompleted: true }), /明确指定/)
  await f.generate(project, { itemIds: ['item-1'], redoCompleted: true })
  let result = await f.wait(project.projectId)
  assert.equal(f.creates(), 4)
  assert.deepEqual(result.items.map(item => item.status), ['completed', 'planned', 'completed'])
  assert.equal(result.items[0].file, 'images/item-1-2.png')
  assert.equal(result.items[2].file, 'images/item-3-1.png')
  await f.generate(project); result = await f.wait(project.projectId)
  assert.equal(f.creates(), 5); assert.equal(result.items[1].file, 'images/item-2-2.png')
}))

test('project lists survive restart, remain session-scoped and allow viewing after skill removal', async () => fixture(async f => {
  const project = await f.save(await f.create(), draft(1))
  assert.equal((await f.studio.list(f.task)).projects[0].projectId, project.projectId)
  assert.equal((await f.studio.list({ ...f.task, sessionId: 'another-session' })).projects.length, 0)
  const restarted = new CreativeStudio({ ...f.options, installed: () => false })
  try {
    const list = await restarted.dispatch(f.task, { action: 'list' })
    assert.equal(list.projects[0].projectId, project.projectId)
    await restarted.dispatch(f.task, { action: 'export', projectId: project.projectId })
    await assert.rejects(restarted.dispatch(f.task, { action: 'create', kind: 'ecommerce', name: 'Another' }), /先从技能商店/)
  } finally { await restarted.close() }
}))

test('account, workspace, policy, model and reference-integrity checks apply before image submission', async () => fixture(async f => {
  await fs.writeFile(path.join(f.cwd, 'reference.png'), PNG)
  const plan = draft(1); plan.items[0].referenceIds = ['ref-001']
  const project = await f.save(await f.create({ files: ['reference.png'] }), plan)
  f.setOwner('99')
  await assert.rejects(f.generate(project), /账号已变化/)
  f.setOwner('42')
  await assert.rejects(f.studio.dispatch({ ...f.task, owner: '99' }, { action: 'status', projectId: project.projectId }), /账号已变化/)
  const another = path.join(f.root, 'another'); await fs.mkdir(another)
  await assert.rejects(f.studio.dispatch({ ...f.task, cwd: another }, { action: 'status', projectId: project.projectId }), /不属于/)
  f.task.settings.policy.network = false
  await assert.rejects(f.generate(project), /禁用联网/)
  f.task.settings.policy.network = true
  await assert.rejects(f.generate(project, { model: 'unknown' }), /生图目录/)
  await fs.writeFile(path.join(project.directory, 'references/ref-001.png'), Buffer.concat([PNG, Buffer.from('changed')]))
  await f.generate(project); const result = await f.wait(project.projectId)
  assert.equal(result.items[0].status, 'failed'); assert.match(result.items[0].error, /本机已被修改/)
  assert.equal(f.creates(), 0)
}))

test('symlinked output paths and restricted external inputs cannot leave the workspace', async () => fixture(async f => {
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'external.png'), PNG)
  f.task.settings.policy.workspaceOnly = true
  await assert.rejects(f.create({ files: [path.join(outside, 'external.png')] }), /只允许工作目录/)
  await fs.symlink(outside, path.join(f.cwd, 'anyu-creative'), process.platform === 'win32' ? 'junction' : 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  await assert.rejects(f.create(), /Symbolic links|junctions/)
}))

test('global remote generation concurrency remains bounded across simultaneous conversations', async () => fixture(async f => {
  let active = 0, peak = 0
  const original = f.options.create
  f.options.create = async fields => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 20)); const value = await original(fields); active--; return value }
  const projects = await Promise.all(Array.from({ length: 4 }, async () => f.save(await f.create(), draft(3))))
  await Promise.all(projects.map(project => f.generate(project)))
  await Promise.all(projects.map(project => f.wait(project.projectId)))
  assert.ok(peak <= 4); assert.equal(f.creates(), 12)
}))

test('account changes stop new work but retain a busy job until every submitted task is recorded', async () => fixture(async f => {
  let releaseSecond
  const second = new Promise(resolve => { releaseSecond = resolve })
  const original = f.options.create
  let started = 0
  f.options.create = async fields => {
    const number = ++started
    if (number === 2) await second
    const result = await original(fields)
    if (number === 1) f.setOwner('different-account')
    return result
  }
  const project = await f.save(await f.create(), draft(3))
  await f.generate(project)
  await until(() => started === 2)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(f.studio.jobs.has(project.projectId), 'unfinished submissions must still block updates and plan edits')
  releaseSecond()
  await f.studio.jobs.get(project.projectId)?.promise
  assert.equal(started, 2)
  assert.equal(f.creates(), 2)
  f.setOwner('42')
  const result = await f.studio.dispatch(f.task, { action: 'status', projectId: project.projectId })
  assert.ok(result.items.slice(0, 2).every(item => item.remoteTaskId))
  assert.equal(result.items[2].status, 'planned')
  assert.match(result.lastError, /账号已变化/)
  const restored = await f.studio.dispatch(f.task, { action: 'list' })
  assert.match(restored.projects[0].lastError, /账号已变化/)
}))
