'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHarness, models } = require('./pet-test-harness.cjs')
const { CHARACTERS } = require('../pet-catalog.cjs')
const { CodexTools } = require('../codex-tools.cjs')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(10) } assert.fail('State transition timed out') }
async function setup(t, options) {
  const h = createHarness(options); t.after(h.cleanup)
  h.manager.links.pauseMs = 20
  await h.enable('mint', models[0]); await h.enable('snow', models[2])
  return h
}
function finish(h, text = 'A warm reply', error = '') {
  const link = h.manager.links.active('mint')
  const record = h.sessions.sessions.get(link.sessionIds[link.speaker])
  h.sessions.ingest(record.piSessionPath, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: error ? 'error' : 'stop', errorMessage: error } })
  h.sessions.ingest(record.piSessionPath, { type: 'agent_settled' })
}

test('each character has a distinct default prefix; upgrading preserves custom preferences', async t => {
  const h = await setup(t)
  assert.equal(new Set(CHARACTERS.map(pet => pet.defaultPrefix)).size, 5)
  for (const character of CHARACTERS) assert.equal(h.manager.config(character.id).prefix, character.defaultPrefix)
  assert.match(CHARACTERS.find(pet => pet.id === 'snow').persona, /女友/)
  h.manager.settings.characters.snow.prefix = ''
  assert.equal(h.manager.config('snow').prefix, CHARACTERS[1].defaultPrefix)
  await h.manager.save('mint', { prefix: 'Call me Lin and speak English.' })
  assert.equal(h.manager.config('mint').prefix, 'Call me Lin and speak English.')
})

test('two models alternate in isolated sessions and either participant can stop them', async t => {
  const h = await setup(t)
  await h.manager.prompt('mint', { message: 'PRIVATE_PERSONAL_HISTORY' }); h.finish('mint')
  const original = h.manager.config('mint').sessionId
  await h.manager.links.connect('mint', 'snow', 'A quiet weekend')
  await until(() => h.commands.filter(command => command.type === 'prompt').length === 2)
  assert.equal(h.starts.at(-1).model, models[0].id)
  assert.equal(h.starts.at(-1).conversationOnly, true)
  assert.ok(!h.commands.at(-1).message.includes('PRIVATE_PERSONAL_HISTORY'))
  assert.notEqual(h.starts.at(-1).agentSessionId, original)
  assert.equal(h.manager.isBusy('snow'), true)
  await assert.rejects(h.manager.prompt('snow', { message: 'another task' }), /正在回复/)
  finish(h, 'Let us share a cup of tea.')
  await until(() => h.commands.filter(command => command.type === 'prompt').length === 3)
  assert.equal(h.starts.at(-1).model, models[2].id)
  assert.match(h.commands.at(-1).message, /Let us share a cup of tea/)
  await h.manager.links.disconnect('snow')
  const count = h.commands.filter(command => command.type === 'prompt').length
  await wait(50)
  assert.equal(h.commands.filter(command => command.type === 'prompt').length, count)
  assert.equal(h.sessions.runs.size, 0)
  assert.equal(h.manager.links.view('mint').status, 'closed')
  assert.equal(h.manager.config('mint').sessionId, original)
  assert.equal(h.manager.isBusy('mint'), false)
})

test('disconnecting during runtime startup never submits a late model request', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = await setup(t, { beforeStart: () => gate })
  await h.manager.links.connect('mint', 'snow', 'Hello')
  await until(() => h.starts.length === 1)
  await h.manager.links.disconnect('mint')
  release(); await wait(50)
  assert.equal(h.commands.filter(command => command.type === 'prompt').length, 0)
})

test('pair reservations prevent cross-links and account changes clear links and transcripts', async t => {
  const h = await setup(t)
  await h.enable('orbit')
  await h.manager.links.connect('mint', 'snow', 'Hello')
  await assert.rejects(h.manager.links.connect('orbit', 'snow', 'Race'), /正在执行任务或连线/)
  await assert.rejects(h.manager.links.connect('mint', 'mint'), /另一位/)
  h.setOwner('other-user'); h.manager.refreshOwner()
  assert.equal(h.manager.links.list().length, 0)
  assert.equal(h.manager.links.view('mint'), null)
  await wait(50)
  assert.equal(h.commands.filter(command => command.type === 'prompt').length, 0)
})

test('voice completion controls turn-taking; late acknowledgements cannot restart a link', async t => {
  const h = await setup(t, { voice: { speak: async text => ({ mode: 'natural', text, audio: 'data:audio/mpeg;base64,AAAA' }) } })
  await h.manager.links.connect('mint', 'snow', 'Hello')
  await until(() => h.sessions.runs.size === 1)
  finish(h)
  await until(() => h.events.some(event => event.speechId))
  const speech = h.events.find(event => event.speechId)
  assert.equal(h.manager.links.view('mint').status, 'speaking')
  await wait(50)
  assert.equal(h.commands.filter(command => command.type === 'prompt').length, 1)
  h.manager.links.speechEnded('snow', speech.linkId, speech.speechId)
  assert.equal(h.manager.links.view('mint').status, 'speaking')
  h.manager.links.speechEnded('mint', speech.linkId, speech.speechId)
  await until(() => h.commands.filter(command => command.type === 'prompt').length === 2)
  await h.manager.links.disconnect('mint')
  h.manager.links.speechEnded('mint', speech.linkId, speech.speechId)
  await wait(50)
  assert.equal(h.commands.filter(command => command.type === 'prompt').length, 2)
})

test('model errors and disabling a participant stop the link without an automatic retry loop', async t => {
  const h = await setup(t)
  await h.manager.links.connect('mint', 'snow', 'Hello')
  await until(() => h.sessions.runs.size === 1)
  finish(h, '', 'Upstream unavailable')
  await until(() => !h.manager.links.active('mint'))
  assert.match(h.manager.links.view('mint').error, /Upstream unavailable/)
  await h.manager.links.connect('mint', 'snow', 'Try again')
  await h.manager.save('snow', { enabled: false })
  assert.equal(h.manager.links.active('mint'), undefined)
})

test('conversation-only mode offers no tools and rejects fabricated tool calls', async () => {
  const tools = await new CodexTools({ conversationOnly: true, emit() {} }).initialize()
  assert.deepEqual(tools.specs(), [])
  const result = await tools.execute({ tool: 'powershell', callId: 'blocked', arguments: {} })
  assert.equal(result.success, false)
  assert.match(result.contentItems[0].text, /unavailable/)
})

test('returning to personal chat dismisses only that participant history view', async t => {
  const h = await setup(t)
  await h.manager.links.connect('mint', 'snow', 'Hello')
  assert.throws(() => h.manager.links.dismiss('mint'), /先断开/)
  await h.manager.links.disconnect('snow')
  h.manager.links.dismiss('mint')
  assert.equal(h.manager.links.view('mint'), null)
  assert.equal(h.manager.links.view('snow').status, 'closed')
  h.manager.newChat('snow')
  assert.equal(h.manager.links.view('snow'), null)
})

test('disconnect while fetching models releases reservations and never starts a turn', async t => {
  const h = await setup(t)
  let release
  h.manager.getCatalog = () => new Promise(resolve => { release = resolve })
  const pending = h.manager.links.connect('mint', 'snow', 'Hello')
  const rejected = assert.rejects(pending, /连线已断开/)
  await until(() => Boolean(release))
  await h.manager.links.disconnect('snow')
  release({ models })
  await rejected
  assert.equal(h.manager.links.list().length, 0)
  assert.equal(h.starts.length, 0)
})

test('delayed voice cannot stall the pair or play after disconnect', async t => {
  let release
  const h = await setup(t, { voice: { speak: () => new Promise(resolve => { release = resolve }) } })
  h.manager.links.voiceTimeoutMs = 20
  h.manager.links.pauseMs = 200
  await h.manager.links.connect('mint', 'snow', 'Hello')
  await until(() => h.sessions.runs.size === 1)
  finish(h)
  await until(() => h.manager.links.view('mint').status === 'waiting')
  assert.equal(h.events.filter(event => event.speechId).length, 0)
  await h.manager.links.disconnect('snow')
  release({ mode: 'natural', text: 'Late audio', audio: 'data:audio/mpeg;base64,AAAA' })
  await wait(50)
  assert.equal(h.events.filter(event => event.speechId).length, 0)
  assert.equal(h.manager.links.active('mint'), undefined)
  assert.equal(h.commands.filter(command => command.type === 'prompt').length, 1)
})

test('disconnect cancels a pending voice wait without waiting for the service', async t => {
  const h = await setup(t, { voice: { speak: () => new Promise(() => {}) } })
  await h.manager.links.connect('mint', 'snow', 'Hello')
  await until(() => h.sessions.runs.size === 1)
  finish(h)
  const link = h.manager.links.active('mint')
  await until(() => Boolean(link.cancelVoice))
  await h.manager.links.disconnect('mint')
  await until(() => !link.cancelVoice)
  assert.equal(h.events.filter(event => event.speechId).length, 0)
})
