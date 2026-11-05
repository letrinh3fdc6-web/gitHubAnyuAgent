const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkedPlan, itemFingerprint, generationPrompt, projectExports } = require('../creative-project.cjs')

const product = () => ({ kind: 'ecommerce', references: [{ id: 'ref-001' }] })
const draft = () => ({ objective: 'A product campaign', styleLock: 'Keep the original product', items: [{ id: 'hero', kind: 'product', title: 'Hero image', prompt: 'One product on white', referenceIds: ['ref-001'] }, { id: 'detail', kind: 'detail', title: 'Details', prompt: 'Show its construction', dependsOn: ['hero'] }] })

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
