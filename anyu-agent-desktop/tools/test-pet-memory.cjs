'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PetMemory } = require('../pet-memory.cjs')
const { PetManager } = require('../pet-manager.cjs')
const { CHARACTERS } = require('../pet-catalog.cjs')
const { createHarness, models } = require('./pet-test-harness.cjs')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await wait(10) } assert.fail('Timed out') }
function harness(t) { const h = createHarness(); t.after(h.cleanup); return h }

test('each character has a durable directory; old relevant memories survive recent-history limits', async t => {
  const h = harness(t), memory = await h.manager.readyMemory()
  for (const pet of CHARACTERS) assert.ok(fs.existsSync(path.join(memory.folder(pet.id), 'MEMORY.md')))
  const records = Array.from({ length: 180 }, (_, index) => ({ key: `test-${index}`, conversation: `link:archive-${index}`, kind: 'link', peer: 'snow', speaker: index % 2 ? 'snow' : 'mint',
    text: index === 0 ? '我们给周末计划起名叫星河计划，集合地点是青禾书店。' : `后来第 ${index} 次聊日常。`, topic: '周末计划', at: new Date(1700000000000 + index * 1000).toISOString() }))
  memory.append('mint', records)
  memory.append('mint', records)
  assert.equal(memory.history('mint').total, 180)
  let page = memory.history('mint'), count = page.messages.length
  while (page.next) { page = memory.history('mint', { before: page.next }); count += page.messages.length }
  assert.equal(count, 180)
  assert.equal(memory.history('snow').total, 0)
  const restored = new PetMemory(memory.directory, CHARACTERS)
  try {
    assert.match(restored.context('mint', { query: '星河计划的集合地点', peer: 'snow' }), /青禾书店/)
    assert.equal(restored.context('mint', { query: '星河计划', peer: 'orbit' }), '')
    assert.ok(restored.context('mint', { query: '周末计划', peer: 'snow' }).length < 13500)
    assert.equal(restored.history('mint', { query: '青禾书店' }).messages.length, 1)
    assert.throws(() => restored.folder('../snow'), /角色不存在/)
  } finally { restored.close() }
})

test('personal memory is recalled after new chat, notes use conflict checks, and accounts stay isolated', async t => {
  const h = harness(t)
  await h.enable('orbit')
  await h.manager.prompt('orbit', { message: '周末帮我记得给青禾书店带那本书。' }); h.finish('orbit', '记下了青禾书店的还书安排。')
  const memory = h.manager.memory, before = memory.notes('orbit')
  memory.saveNotes('orbit', '回复偏好：先给简短结论。', before.revision)
  assert.throws(() => memory.saveNotes('orbit', 'old edit', before.revision), /已被修改/)
  h.manager.newChat('orbit')
  await h.manager.prompt('orbit', { message: '青禾书店有什么安排？' })
  const sent = h.commands.filter(command => command.type === 'prompt').at(-1)
  assert.match(sent.message, /带那本书/); assert.match(sent.message, /先给简短结论/)
  assert.equal(h.manager.snapshot('orbit').messages[0].content, '青禾书店有什么安排？')
  h.finish('orbit')
  assert.equal(memory.history('orbit').total, 4)
  assert.equal(memory.history('mint').total, 0)
  assert.equal(memory.context('orbit', { peer: 'snow', query: '青禾书店' }).includes('带那本书'), false)
  const original = memory.directory
  h.setOwner('someone-else'); h.manager.refreshOwner(); await h.manager.readyMemory()
  assert.notEqual(h.manager.memory.directory, original)
  assert.equal(h.manager.memory.history('orbit').total, 0)
  assert.equal(h.manager.memory.notes('orbit').text, '')
  h.setOwner('test-user-a'); h.manager.refreshOwner(); await h.manager.readyMemory()
  assert.equal(h.manager.memory.history('orbit').total, 4)
})

test('recalling a long conversation selects the matching passage rather than dropping its tail', async t => {
  const h = harness(t), memory = await h.manager.readyMemory()
  const text = '先聊其他日常内容。'.repeat(300) + '约定的纪念品是月光徽章，交接地点是青禾书店。'
  memory.append('orbit', [{ key: 'long-reply', conversation: 'old-conversation', kind: 'personal', speaker: 'orbit', text, at: '2026-10-01T00:00:00.000Z' }])
  assert.match(memory.context('orbit', { query: '月光徽章交接地点' }), /交接地点是青禾书店/)
  assert.equal(memory.history('orbit').messages[0].text, text)
})

test('both link participants remember the complete conversation on reconnect and after restart', async t => {
  const h = harness(t)
  h.manager.links.pauseMs = 10000
  await h.enable('mint'); await h.enable('snow', models[2])
  await h.manager.prompt('mint', { message: 'PRIVATE_PERSONAL_NOTE' }); h.finish('mint')
  await h.manager.links.connect('mint', 'snow', '周末的星河计划')
  await until(() => h.sessions.runs.size === 1)
  const link = h.manager.links.active('mint'), session = h.sessions.sessions.get(link.sessionIds.mint)
  const text = '一起在青禾书店见面，然后给主人挑一本书。'
  h.sessions.ingest(session.piSessionPath, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } })
  h.sessions.ingest(session.piSessionPath, { type: 'agent_settled' })
  await until(() => link.messages.length === 1)
  await h.manager.links.disconnect('snow')
  for (const id of ['mint', 'snow']) assert.equal(h.manager.memory.history(id, { query: '青禾书店' }).messages.length, 1)
  await h.manager.links.connect('snow', 'mint', '上次星河计划的约定是什么？')
  await until(() => h.sessions.runs.size === 1)
  const prompt = h.commands.filter(command => command.type === 'prompt').at(-1).message
  assert.match(prompt, /青禾书店/); assert.ok(!prompt.includes('PRIVATE_PERSONAL_NOTE'))
  await h.manager.links.disconnect('mint')
  const restored = new PetManager(h.managerOptions)
  try {
    await restored.readyMemory()
    assert.equal(restored.links.list().length, 0, 'restart must not resume paid conversations automatically')
    assert.match(restored.memory.context('snow', { peer: 'mint', query: '星河计划' }), /青禾书店/)
    assert.equal(restored.memory.history('snow', { query: '青禾书店' }).messages.length, 1, 'legacy import must not duplicate live records')
  } finally { restored.close() }
})

test('existing link logs are backfilled for both participants without storing failed replies or model wrappers', async t => {
  const h = harness(t)
  await h.manager.readyMemory()
  const sessionId = 'pet:orbit:link:older-link'
  h.manager.settings.sessions[sessionId] = { id: 'orbit', systemPrompt: '当前是主人发起的双伙伴闲聊，对话伙伴是啵啵。' }; h.manager.persist()
  await h.sessions.start({ sessionId, model: models[0].id, models: [models[0]], cwd: h.directory, permissionMode: 'confirm' })
  await h.sessions.prompt({ sessionId, message: '主人给的话题：老朋友的纪念日\n请向啵啵自然开启这个话题。' })
  const file = h.sessions.sessions.get(sessionId).piSessionPath
  h.sessions.ingest(file, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '纪念日是六月三日，礼物叫小星星。' }], stopReason: 'stop' } })
  h.sessions.ingest(file, { type: 'agent_settled' })
  await h.sessions.prompt({ sessionId, message: '主人给的话题：老朋友的纪念日' })
  h.sessions.ingest(file, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'FAILED_RESPONSE_NOT_MEMORY' }], stopReason: 'error', errorMessage: 'Test failure' } })
  h.sessions.ingest(file, { type: 'agent_settled' })
  const restored = new PetManager(h.managerOptions)
  try {
    await restored.readyMemory()
    for (const id of ['orbit', 'jelly']) {
      const history = restored.memory.history(id)
      assert.equal(history.total, 1)
      assert.equal(history.messages[0].speaker, 'orbit')
      assert.match(history.messages[0].text, /六月三日/)
      assert.equal(history.messages[0].topic, '老朋友的纪念日')
    }
    assert.equal(restored.memory.history('mint').total, 0)
  } finally { restored.close() }
})
