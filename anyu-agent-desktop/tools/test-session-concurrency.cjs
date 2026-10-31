'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { AgentSessionService } = require('../agent-session.cjs')

const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8')
const evictionStart = source.indexOf('function evictIdlePiRuntimes(')
const startRuntimeStart = source.indexOf('async function startPiUnsafe(', evictionStart)
const startRuntimeEnd = source.indexOf('function isSessionStartConflict(', startRuntimeStart)
assert.ok(evictionStart >= 0 && startRuntimeStart > evictionStart && startRuntimeEnd > startRuntimeStart)

function runtime(key, overrides = {}) {
  return {
    key, child: { exitCode: null, signalCode: null }, pending: new Map(),
    inFlightPrompt: true, compacting: false, lastUsedAt: 0,
    contextSignature: JSON.stringify({ engine: 'pi' }), permissionMode: 'full', executionHost: 'standard',
    startOptions: { agentSessionId: key, agentRole: 'parent', orchestration: { token: key } },
    ...overrides,
  }
}

function host() {
  const stopped = [], events = []
  const context = {
    PI_MAX_RUNTIMES: 4, PI_IDLE_RUNTIME_CACHE_SIZE: 4,
    piRuntimes: new Map(), piActiveKey: '', agentSessionService: { runs: new Map() },
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, event) => events.push({ channel, event }) } },
    stopPiRuntime: async value => { stopped.push(value.key) },
    path, piSessionDir: () => path.resolve('test-sessions'), piExecutable: () => 'fake-pi',
    fs: { existsSync: value => value === 'fake-pi' }, isInside: () => true,
    app: { getPath: () => path.resolve('test-user-data') },
    AgentContextSettings: class {
      get() { return {} }
      policy() { return {} }
      model(value) { return value }
    },
    sessionWorkingDirectory: () => path.resolve('test-workspace'),
    resolvePermissionMode: () => 'full', runtimeExecutionHost: () => 'standard',
    startBrowserBridge: async () => {},
  }
  vm.runInNewContext(`${source.slice(evictionStart, startRuntimeEnd)}
    this.evict = evictIdlePiRuntimes; this.startRuntime = startPiUnsafe`, context)
  return { context, stopped, events }
}

test('32 active conversations do not block another runtime or evict a running task', () => {
  const h = host()
  for (let index = 0; index < 32; index++) h.context.piRuntimes.set(`active-${index}`, runtime(`active-${index}`))
  assert.doesNotThrow(() => h.context.evict('new-session'))
  assert.equal(h.context.piRuntimes.size, 32)
  assert.deepEqual(h.stopped, [])
  assert.deepEqual(h.events, [])
})

test('idle cache cleanup counts idle sessions independently of active conversations', () => {
  const h = host()
  for (let index = 0; index < 12; index++) h.context.piRuntimes.set(`active-${index}`, runtime(`active-${index}`))
  for (let index = 0; index < 8; index++) h.context.piRuntimes.set(`idle-${index}`, runtime(`idle-${index}`, { inFlightPrompt: false, lastUsedAt: index }))
  h.context.evict('new-session')
  assert.deepEqual(h.stopped, ['idle-0', 'idle-1', 'idle-2', 'idle-3'])
  assert.equal(h.context.piRuntimes.size, 16)
  assert.deepEqual(h.events.map(item => item.event.sessionKey), h.stopped)
  for (let index = 0; index < 12; index++) assert.ok(h.context.piRuntimes.has(`active-${index}`))
})

test('compaction, pending commands, prompt preparation and the foreground session are protected', () => {
  const h = host()
  const states = [
    ['foreground', {}], ['keep', {}], ['compacting', { compacting: true }],
    ['pending', { pending: new Map([['command', {}]]) }], ['preparing', {}],
  ]
  for (const [key, state] of states) h.context.piRuntimes.set(key, runtime(key, { inFlightPrompt: false, ...state }))
  h.context.piActiveKey = 'foreground'
  h.context.agentSessionService.runs.set('preparing', {})
  for (let index = 0; index < 6; index++) h.context.piRuntimes.set(`idle-${index}`, runtime(`idle-${index}`, { inFlightPrompt: false, lastUsedAt: index }))
  h.context.evict('keep')
  for (const [key] of states) assert.ok(h.context.piRuntimes.has(key), `${key} must remain available`)
  assert.deepEqual(h.stopped, ['idle-0', 'idle-1'])
})

test('multiple active teams do not block admission to another parent conversation', async () => {
  const h = host()
  const key = path.resolve('test-sessions', 'selected.jsonl')
  h.context.piRuntimes.set(key, runtime(key))
  for (let index = 0; index < 12; index++) h.context.piRuntimes.set(`team-${index}`, runtime(`team-${index}`))
  const result = await h.context.startRuntime({ sessionPath: key, accessMode: 'key', orchestration: { token: 'selected' } })
  assert.equal(result.reused, true)
  assert.equal(result.sessionPath, key)
  assert.deepEqual(h.stopped, [])
})

test('20 simultaneous session runs keep cancellation and replies isolated', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-concurrency-'))
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }))
  const h = host()
  const commands = []
  let sessions
  sessions = new AgentSessionService({
    userDataDir,
    startRuntime: async options => {
      const key = `${options.agentSessionId}.jsonl`
      h.context.evict(key)
      h.context.piRuntimes.set(key, runtime(key, { inFlightPrompt: false, startOptions: options }))
      return { sessionPath: key }
    },
    resolveRuntime: key => h.context.piRuntimes.get(key),
    sendCommand: async (command, owner) => {
      commands.push({ ...command, owner: owner.key })
      owner.inFlightPrompt = command.type === 'prompt'
      if (command.type === 'abort') sessions.ingest(owner.key, { type: 'agent_settled' })
    },
  })
  h.context.agentSessionService = sessions
  for (let index = 0; index < 20; index++) {
    const sessionId = `conversation-${index}`
    await sessions.start({ sessionId, model: `model-${index}` })
    await sessions.prompt({ sessionId, message: `request-${index}` })
  }
  assert.equal(sessions.runs.size, 20)
  assert.equal(h.context.piRuntimes.size, 20)
  await sessions.abort({ sessionId: 'conversation-7' })
  assert.equal(sessions.runs.size, 19)
  assert.deepEqual(commands.filter(command => command.type === 'abort').map(command => command.owner), ['conversation-7.jsonl'])
  for (let index = 19; index >= 0; index--) {
    if (index === 7) continue
    const key = `conversation-${index}.jsonl`
    sessions.ingest(key, { type: 'message_start', message: { role: 'assistant' } })
    sessions.ingest(key, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `reply-${index}` }], stopReason: 'stop' } })
    sessions.ingest(key, { type: 'agent_settled' })
    assert.equal(sessions.snapshot({ sessionId: `conversation-${index}` }).messages.at(-1).content, `reply-${index}`)
  }
  assert.equal(sessions.runs.size, 0)
  assert.deepEqual(h.stopped, [])
})
