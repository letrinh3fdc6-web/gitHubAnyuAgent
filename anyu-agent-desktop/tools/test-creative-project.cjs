const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkedPlan, itemFingerprint, generationPrompt, projectExports } = require('../creative-project.cjs')

const product = () => ({ kind: 'ecommerce', references: [{ id: 'ref-001' }] })
const draft = () => ({ objective: 'A product campaign', styleLock: 'Keep the original product', items: [{ id: 'hero', kind: 'product', title: 'Hero image', prompt: 'One product on white', referenceIds: ['ref-001'] }, { id: 'detail', kind: 'detail', title: 'Details', prompt: 'Show its construction', dependsOn: ['hero'] }] })
const campaign = () => {
  const plan = draft()
  Object.assign(plan, { productLock: 'Keep the actual shape, logo and SKU', audience: 'Small kitchen owners', platform: 'Taobao' })
  Object.assign(plan.items[0], { purpose: 'Identify the product and variant', camera: 'Full product, uncluttered background' })
  Object.assign(plan.items[1], { purpose: 'Inspect the visible joint construction', camera: 'Macro view of the joint, annotation space' })
  return plan
}

test('campaign plans reject missing tasks and duplicate information, while allowing purposeful angle variants', () => {
  for (const change of [
    plan => { delete plan.items[0].purpose },
    plan => { delete plan.items[0].camera },
    plan => { plan.items[1].purpose = `  ${plan.items[0].purpose.toUpperCase()}! ` },
    plan => { plan.items[1].prompt = plan.items[0].prompt; plan.items[1].camera = plan.items[0].camera },
    plan => { plan.productLock = '' },
  ]) { const plan = campaign(); change(plan); assert.throws(() => checkedPlan(plan, product())) }
  const angles = campaign()
  angles.items[1].prompt = angles.items[0].prompt
  assert.equal(checkedPlan(angles, product()).items.length, 2, 'different composition and purpose are legitimate')
  assert.throws(() => checkedPlan(campaign(), { ...product(), kind: 'comic' }), /仅用于电商/)
})

test('actual campaign prompts carry decision, composition, reference roles and verified facts', () => {
  const input = campaign()
  input.claims = [{ text: 'One included tray', evidence: 'Packing list', status: 'verified' }, { text: 'Unverified load rating', status: 'pending' }]
  input.items[1].referenceIds = ['ref-001', 'ref-001']
  input.items[1].dependsOn = ['hero', 'hero']
  const plan = checkedPlan(input, product()), item = plan.items[1]
  const prompt = generationPrompt(plan, item)
  for (const value of [plan.objective, plan.audience, plan.platform, plan.productLock, item.purpose, item.camera, 'One included tray', 'Packing list']) assert.ok(prompt.includes(value), value)
  assert.ok(!prompt.includes('Unverified load rating'))
  assert.match(prompt, /参考图1（ref-001）：原始素材/)
  assert.match(prompt, /参考图2（hero）：已生成的参考图/)
  assert.ok(!prompt.includes('参考图3'))
  assert.ok(!generationPrompt(plan, plan.items[0]).includes(item.purpose), 'do not ask each image to render every task')
})

test('campaign size validation counts Unicode code points and never truncates identity requirements', () => {
  const input = campaign()
  input.items = [input.items[0]]
  const plan = checkedPlan(input, product())
  const prefixLength = [...generationPrompt(plan, plan.items[0])].length - [...plan.items[0].prompt].length
  input.items[0].prompt = '\u{1f9f4}'.repeat(6000 - prefixLength)
  assert.equal([...generationPrompt(checkedPlan(input, product()), checkedPlan(input, product()).items[0])].length, 6000)
  input.items[0].prompt += 'x'
  assert.throws(() => checkedPlan(input, product()), /超过 6000/)
})

test('per-image evidence selection survives saving and never injects unrelated or pending claims', () => {
  const input = campaign()
  input.items[1].dependsOn = []
  input.claims = [
    { id: 'appearance', text: 'A blue outer shell', evidence: 'Product photo', status: 'verified' },
    { id: 'included-tray', text: 'One included tray', evidence: 'Packing list', status: 'verified' },
    { id: 'load', text: 'Unverified load rating', status: 'pending' },
  ]
  input.items[0].claimIds = ['appearance']; input.items[1].claimIds = []
  const plan = checkedPlan(input, product())
  assert.deepEqual(checkedPlan(JSON.parse(JSON.stringify(plan)), product()), plan)
  const hero = generationPrompt(plan, plan.items[0]), detail = generationPrompt(plan, plan.items[1])
  assert.ok(hero.includes('A blue outer shell')); assert.ok(!hero.includes('One included tray'))
  for (const claim of input.claims) assert.ok(!detail.includes(claim.text))
  assert.ok(!hero.includes('Unverified load rating'))
  const revised = structuredClone(plan); revised.items[0].claimIds = ['included-tray']
  assert.notEqual(itemFingerprint(plan, plan.items[0]), itemFingerprint(revised, revised.items[0]))
  assert.equal(itemFingerprint(plan, plan.items[1]), itemFingerprint(revised, revised.items[1]))
  const otherFact = structuredClone(plan); otherFact.claims[1].text += ' revised'
  assert.equal(itemFingerprint(plan, plan.items[0]), itemFingerprint(otherFact, otherFact.items[0]), 'an unselected fact must not discard a completed image')
  const chosenFact = structuredClone(plan); chosenFact.claims[0].evidence += ' corrected'
  assert.notEqual(itemFingerprint(plan, plan.items[0]), itemFingerprint(chosenFact, chosenFact.items[0]))
  assert.equal(itemFingerprint(plan, plan.items[1]), itemFingerprint(chosenFact, chosenFact.items[1]))
})

test('reference roles follow upload order and distinguish style from actual product identity', () => {
  const input = campaign(); input.items[1].referenceIds = ['ref-001', 'ref-001', 'ref-002']
  input.items[1].referenceRoles = [
    { id: 'hero', role: 'style', instruction: 'Only reuse lighting' },
    { id: 'ref-002', role: 'style', instruction: 'Only reuse the type hierarchy' },
    { id: 'ref-001', role: 'detail', instruction: 'Use only the foreground gray variant' },
  ]
  const project = { ...product(), references: [{ id: 'ref-001' }, { id: 'ref-002' }] }
  const plan = checkedPlan(input, project), prompt = generationPrompt(plan, plan.items[1])
  assert.match(prompt, /参考图1（ref-001）：核对当前商品/)
  assert.match(prompt, /参考图2（ref-002）：仅学习色彩/)
  assert.match(prompt, /参考图3（hero）：仅学习色彩/)
  assert.ok(!prompt.includes('参考图4')); assert.ok(prompt.includes('Use only the foreground gray variant'))
  assert.ok(!prompt.includes('严格保留所附参考图中的商品结构'), 'style references must not override the product')
  const revised = structuredClone(plan); revised.items[1].referenceRoles[0].instruction += ' and colors'
  assert.notEqual(itemFingerprint(plan, plan.items[1]), itemFingerprint(revised, revised.items[1]))
})

test('new evidence and reference fields reject missing, duplicate, pending and out-of-scope inputs', () => {
  const valid = () => {
    const input = campaign()
    input.claims = [{ id: 'visible', text: 'Visible exterior', evidence: 'Photo', status: 'verified' }, { id: 'unknown', text: 'Unknown material', status: 'pending' }]
    input.items[0].claimIds = ['visible']
    input.items[0].referenceRoles = [{ id: 'ref-001', role: 'product', instruction: 'Current SKU' }]
    return input
  }
  for (const change of [
    plan => { plan.claims[1].id = 'visible' },
    plan => { plan.claims[0].id = ['visible'] },
    plan => { plan.items[0].claimIds = ['missing'] },
    plan => { plan.items[0].claimIds = ['unknown'] },
    plan => { plan.items[0].claimIds = ['visible', 'visible'] },
    plan => { plan.items[0].claimIds = null },
    plan => { plan.items[0].referenceRoles = [] },
    plan => { plan.items[0].referenceRoles.push(plan.items[0].referenceRoles[0]) },
    plan => { plan.items[0].referenceRoles[0].id = 'not-uploaded' },
    plan => { plan.items[0].referenceRoles[0].role = 'anything' },
    plan => { plan.items[0].referenceRoles[0].instruction = '' },
    plan => { delete plan.productLock },
  ]) { const plan = valid(); change(plan); assert.throws(() => checkedPlan(plan, product())) }
})

test('campaign identity and strategy edits invalidate outputs; independent task edits stay local', () => {
  const input = campaign(); input.items[1].dependsOn = []
  const before = checkedPlan(input, product())
  for (const field of ['productLock', 'objective', 'audience', 'platform']) {
    const after = structuredClone(before); after[field] += ' revised'
    assert.notEqual(itemFingerprint(before, before.items[0]), itemFingerprint(after, after.items[0]), field)
  }
  const after = structuredClone(before); after.items[1].purpose += ' with a closer view'
  assert.equal(itemFingerprint(before, before.items[0]), itemFingerprint(after, after.items[0]))
  assert.notEqual(itemFingerprint(before, before.items[1]), itemFingerprint(after, after.items[1]))
})

test('legacy prompts remain byte-compatible for previously submitted and uncertain tasks', () => {
  const plan = checkedPlan(draft(), product())
  assert.equal(Object.hasOwn(plan, 'productLock'), false)
  assert.equal(generationPrompt(plan, plan.items[0]), 'One product on white\n\n统一视觉约束：Keep the original product\n\n不要添加未要求的文字、Logo、水印或虚构认证。\n\n严格保留所附参考图中的商品结构、角色身份及对应的外观特征；不得混淆角色或改变商品。')
})

test('plans validate references and reject duplicate IDs, cycles, missing dependencies and unsupported sizes', () => {
  assert.equal(checkedPlan(draft(), product()).items.length, 2)
  for (const change of [
    plan => { plan.items[1].id = 'hero' },
    plan => { plan.items[0].dependsOn = ['detail'] },
    plan => { plan.items[0].dependsOn = ['missing'] },
    plan => { plan.items[0].referenceIds = ['outside'] },
    plan => { plan.items[0].id = '../escape' },
    plan => { plan.items[0].size = '<img>' },
    plan => { plan.claims = [{ text: 'Best in the world', status: 'verified' }] },
  ]) { const plan = draft(); change(plan); assert.throws(() => checkedPlan(plan, product())) }
})

test('comic shots retain source dialogue and distinguish creative additions', () => {
  const project = { kind: 'comic', script: '安安：我们出发吧。\n她推开门，看见黎明。', references: [] }
  const plan = { objective: '开场', styleLock: '水彩', items: [{ id: 'shot-001', kind: 'shot', title: '出发', prompt: '少女推开门', sourceExcerpt: '她推开门，看见黎明。', dialogue: [{ speaker: '安安', text: '我们出发吧。' }], duration: 4 }] }
  assert.equal(checkedPlan(plan, project).items[0].dialogue[0].text, '我们出发吧。')
  plan.items[0].dialogue[0].text = '我要征服世界！'
  assert.throws(() => checkedPlan(plan, project), /原台词/)
  plan.items[0].dialogue = []; plan.items[0].sourceExcerpt = '她突然飞起来。'
  assert.throws(() => checkedPlan(plan, project), /原文/)
  plan.items[0].creativeAddition = true
  assert.equal(checkedPlan(plan, project).items[0].creativeAddition, true)
})

test('changing an anchor invalidates dependent output fingerprints', () => {
  const first = checkedPlan(draft(), product())
  const second = structuredClone(first)
  second.items[0].prompt = 'The same product in a new view'
  assert.notEqual(itemFingerprint(first, first.items[1]), itemFingerprint(second, second.items[1]))
  assert.match(generationPrompt(first, first.items[1]), /统一视觉约束/)
})

test('dense storyboard dependencies fingerprint each shared anchor once', () => {
  const items = Array.from({ length: 80 }, (_, index) => ({ id: `shot-${index}`, kind: 'product', title: `${index}`, prompt: 'A coherent frame', dependsOn: Array.from({ length: Math.min(index, 8) }, (_, offset) => `shot-${index - offset - 1}`) }))
  const plan = checkedPlan({ objective: 'Large storyboard', styleLock: 'Consistent character', items }, product())
  const cache = new Map()
  assert.match(itemFingerprint(plan, plan.items.at(-1), cache), /^[a-f0-9]{64}$/)
  assert.equal(cache.size, items.length)
})

test('exports escape markup, prevent spreadsheet formula execution and never embed arbitrary image paths', () => {
  const plan = checkedPlan(draft(), product())
  plan.items[0].title = '<script>alert(1)</script>'
  plan.items[0].purpose = '=HYPERLINK("https://evil.invalid")'
  const project = { id: 'example', name: '<script>example</script>', kind: 'ecommerce', revision: 1, plan, references: [{ id: 'ref-001', originalPath: 'secret-original.png' }], outputs: { hero: { status: 'completed', file: 'https://evil.invalid/a.png' } }, updatedAt: '2026-11-05' }
  const result = projectExports(project)
  assert.ok(!result['index.html'].includes('<script>'))
  assert.ok(result['index.html'].includes('&lt;script&gt;'))
  assert.ok(!result['index.html'].includes('src="https://'))
  assert.ok(result['storyboard.csv'].includes("'=HYPERLINK"))
  assert.ok(!result['creative-plan.json'].includes('secret-original.png'))
  assert.equal(Object.keys(result).length, 4)
})
