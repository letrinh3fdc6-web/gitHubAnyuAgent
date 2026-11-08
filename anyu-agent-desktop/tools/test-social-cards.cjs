'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { checkedPlan, generationPrompt } = require('../creative-project.cjs')
const { CreativeStudio } = require('../creative-studio.cjs')
const { packageCreativeSkills } = require('./package-creative-skills.cjs')
const { decodePackage } = require('../skill-store.cjs')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMSEAAAAASUVORK5CYII=', 'base64')
let fixture
async function socialFixture() {
  if (!fixture) fixture = (async () => {
    const { packages } = await packageCreativeSkills()
    const skill = packages.find(item => item.id === 'anyu-social-cards')
    const entries = await decodePackage(skill.bytes)
    const files = new Map(entries.map(entry => [entry.name, entry.bytes]))
    const reference = files.get('references/social-prompts.md').toString('utf8')
    const example = JSON.parse(reference.match(/```json\s*([\s\S]*?)```/)[1])
    return { skill, files, example }
  })()
  return fixture
}

test('downloadable social package contains a runnable example and no private research photos', async () => {
  const { skill, files, example } = await socialFixture()
  assert.equal(skill.version, '1.0.5')
  assert.ok(files.has('references/social-editorial.md'))
  assert.ok(![...files.keys()].some(name => /\.(png|jpg|xlsx|exe|py)$/i.test(name)))
  const plan = checkedPlan(example, { kind: 'ecommerce', references: [{ id: 'ref-001' }] })
  assert.equal(plan.items.length, 3)
  assert.ok(plan.items.every(item => item.kind === 'card' && item.referenceIds.includes('ref-001') && item.dependsOn.length === 0))
  const prompts = plan.items.map(item => generationPrompt(plan, item))
  assert.ok(!prompts[0].includes('24×16cm'), 'cover must not inherit size facts assigned to a later page')
  assert.ok(prompts[2].includes('24×16cm'))
  assert.ok(prompts.every(prompt => !prompt.includes('防水性能') && [...prompt].length <= 6000))
})

test('explicit empty evidence and invalid evidence references retain their distinct meanings', async () => {
  const { example } = await socialFixture()
  const project = { kind: 'ecommerce', references: [{ id: 'ref-001' }] }
  const input = structuredClone(example)
  input.items[0].claimIds = []
  const plan = checkedPlan(input, project)
  assert.ok(!generationPrompt(plan, plan.items[0]).includes('已确认事实'))
  delete input.items[0].claimIds
  const legacy = checkedPlan(input, project)
  assert.ok(generationPrompt(legacy, legacy.items[0]).includes('24×16cm'), 'omission must retain existing execution semantics')
  for (const ids of [['missing'], ['waterproof'], ['outline', 'outline'], 'outline', null]) {
    input.items[0].claimIds = ids
    assert.throws(() => checkedPlan(input, project))
  }
})

test('style references cannot become a second product and must have an explicit role', async () => {
  const { example } = await socialFixture()
  const input = structuredClone(example)
  input.items[0].referenceIds.push('ref-002')
  const project = { kind: 'ecommerce', references: [{ id: 'ref-001' }, { id: 'ref-002' }] }
  assert.throws(() => checkedPlan(input, project), /参考用途/)
  input.items[0].referenceRoles.push({ id: 'ref-002', role: 'style', instruction: '只借鉴侧光与负空间' })
  const plan = checkedPlan(input, project)
  const prompt = generationPrompt(plan, plan.items[0])
  assert.match(prompt, /参考图2（ref-002）：仅学习/)
  assert.ok(!prompt.includes('严格保留所附参考图中的商品结构'), 'generic all-reference identity instruction must not contradict the selected roles')
})

test('social sequence survives save, submission, restart and single-page edits without an extra anchor', async () => {
  const { example } = await socialFixture()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-social-sequence-'))
  const cwd = path.join(root, 'workspace')
  await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, 'reference.png'), PNG)
  const task = { owner: 'social-test', cwd, sessionId: 'social-test-session', settings: { policy: { network: true, workspaceOnly: true, blockedTools: [] } } }
  const submitted = [], remote = new Map()
  const options = {
    userData: path.join(root, 'profile'), getOwner: () => task.owner, installed: () => true, pollInterval: 5, pollTimeout: 1000,
    catalog: async () => [{ id: 3, name: 'Test images', platform: 'openai', status: 'active', allow_image_generation: true, models: [{ name: 'gpt-image-2', capability: 'image' }] }],
    create: async (fields, files) => {
      const id = `social-${submitted.length + 1}`
      submitted.push({ fields, files })
      const result = { id, ...fields, status: 'completed', image_count: 1 }
      remote.set(id, result)
      return result
    },
    status: async id => remote.get(id), download: async () => PNG,
  }
  let studio = new CreativeStudio(options)
  try {
    const created = await studio.dispatch(task, { action: 'create', kind: 'ecommerce', name: 'Social sample', files: ['reference.png'] })
    const saved = await studio.dispatch(task, { action: 'save', projectId: created.projectId, revision: 0, plan: example })
    const generate = async project => {
      await studio.dispatch(task, { action: 'generate', projectId: project.projectId, revision: project.revision, groupId: 3, model: 'gpt-image-2' })
      await studio.jobs.get(project.projectId)?.promise
      return studio.dispatch(task, { action: 'inspect', projectId: project.projectId })
    }
    let result = await generate(saved)
    assert.equal(submitted.length, 3)
    assert.ok(submitted.every(item => item.files.length === 1), 'every page uses the original, not a generated cover')
    assert.ok(result.items.every(item => item.status === 'completed'))
    const cover = submitted.find(item => item.fields.prompt.includes(example.items[0].purpose))
    assert.ok(!cover.fields.prompt.includes('24×16cm'))
    const size = submitted.find(item => item.fields.prompt.includes(example.items[2].purpose))
    assert.ok(size.fields.prompt.includes('24×16cm'))
    await studio.close()
    studio = new CreativeStudio(options)
    result = await generate(result)
    assert.equal(submitted.length, 3, 'resuming completed work must not bill again')
    const edited = structuredClone(result.plan)
    edited.items[1].camera += '，手部从右上进入'
    const updated = await studio.dispatch(task, { action: 'save', projectId: result.projectId, revision: result.revision, plan: edited })
    assert.deepEqual(updated.items.map(item => item.status), ['completed', 'planned', 'completed'])
    result = await generate(updated)
    assert.equal(submitted.length, 4)
    const exported = JSON.parse(await fs.readFile(path.join(result.directory, 'creative-plan.json'), 'utf8'))
    assert.deepEqual(exported.plan.items.map(item => item.claimIds), [['outline'], ['outline'], ['dimensions']])
    assert.ok(!JSON.stringify(exported.references).includes('originalPath'))
  } finally {
    await studio.close()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
})
