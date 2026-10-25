'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AgentContextSettings, DEFAULT_CONTEXT_SETTINGS, contextPolicy, validateContextSettings } = require('../agent-context.cjs')
const { AgentSessionService } = require('../agent-session.cjs')

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-context-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('default compression targets one million tokens within each model window and leaves custom percentages intact', () => {
  const large = { context_window: 500000 }
  assert.equal(contextPolicy(DEFAULT_CONTEXT_SETTINGS, { contextWindow: 2000000 }).triggerTokens, 1000000)
  assert.equal(contextPolicy(DEFAULT_CONTEXT_SETTINGS, { contextWindow: 1048576 }).triggerTokens, 1000000)
  assert.equal(contextPolicy(DEFAULT_CONTEXT_SETTINGS, { contextWindow: 1000000 }).triggerTokens, 983616)
  assert.equal(contextPolicy(DEFAULT_CONTEXT_SETTINGS, large).triggerTokens, 483616)
  assert.equal(contextPolicy(DEFAULT_CONTEXT_SETTINGS, { contextWindow: 128000 }).triggerTokens, 111616)
  assert.deepEqual(large, { context_window: 500000 })
  const small = contextPolicy(DEFAULT_CONTEXT_SETTINGS, { context_window: 8192 })
  assert.equal(small.native.reserveTokens, 2048)
  assert.equal(small.native.keepRecentTokens, 4915)
  assert.equal(contextPolicy({ ...DEFAULT_CONTEXT_SETTINGS, mode: 'custom', triggerPercent: 60 }, large).triggerTokens, 300000)
})

test('invalid or corrupt settings do not silently become disabled or overwrite valid files', t => {
  const dir = temporary(t), settings = new AgentContextSettings(dir)
  assert.deepEqual(settings.get(), DEFAULT_CONTEXT_SETTINGS)
  settings.save({ ...DEFAULT_CONTEXT_SETTINGS, mode: 'custom', triggerPercent: 70 })
  assert.throws(() => settings.save({ ...DEFAULT_CONTEXT_SETTINGS, triggerPercent: 101 }), /threshold/)
  assert.equal(settings.get().triggerPercent, 70)
  assert.throws(() => validateContextSettings({ ...DEFAULT_CONTEXT_SETTINGS, keepRecentTokens: -1 }), /Recent/)
  assert.throws(() => validateContextSettings({ ...DEFAULT_CONTEXT_SETTINGS, keepRecentTokens: Number.MAX_SAFE_INTEGER + 1 }), /Recent/)
  fs.writeFileSync(settings.file, '{broken')
  assert.throws(() => settings.get())
})

test('retention accepts large preferences and adapts to the selected model without overwriting them', t => {
  const dir = temporary(t), settings = new AgentContextSettings(dir)
  settings.save({ ...DEFAULT_CONTEXT_SETTINGS, keepRecentTokens: 1000000 })
  const large = settings.policy({ contextWindow: 1048576 })
  const small = settings.policy({ contextWindow: 128000 })
  assert.equal(large.native.keepRecentTokens, 800000)
  assert.equal(large.retentionLimitTokens, 800000)
  assert.equal(large.retentionLimited, true)
  assert.equal(small.native.keepRecentTokens, 89292)
  assert.equal(settings.get().keepRecentTokens, 1000000)
  const preview = settings.policy({ contextWindow: 1048576 }, undefined, { ...DEFAULT_CONTEXT_SETTINGS, mode: 'custom', triggerPercent: 60, keepRecentTokens: 200000 })
  assert.equal(preview.native.keepRecentTokens, 200000)
  assert.equal(preview.retentionLimited, false)
  assert.equal(settings.get().mode, 'auto')
  const project = contextPolicy(settings.get(), { contextWindow: 1048576 }, { keepRecentTokens: 900000 })
  assert.equal(project.native.keepRecentTokens, 900000)
  assert.equal(project.source, 'project')
})

test('runtime settings are isolated and preserve existing global settings and project priority', t => {
  const dir = temporary(t), settings = new AgentContextSettings(dir)
  const base = path.join(dir, 'base'), a = path.join(dir, 'a'), b = path.join(dir, 'b')
  fs.mkdirSync(base)
  fs.writeFileSync(path.join(base, 'settings.json'), JSON.stringify({ retry: { maxRetries: 2 }, compaction: { enabled: false } }))
  settings.prepare(a, base, settings.policy({ contextWindow: 1048576 }))
  settings.prepare(b, base, settings.policy({ contextWindow: 128000 }))
  const read = directory => JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'))
  assert.equal(read(a).compaction.reserveTokens, 48576)
  assert.equal(read(b).compaction.reserveTokens, 16384)
  assert.equal(read(a).retry.maxRetries, 2)
  assert.equal(read(base).compaction.enabled, false)
  fs.mkdirSync(path.join(dir, '.pi'))
  fs.writeFileSync(path.join(dir, '.pi', 'settings.json'), JSON.stringify({ compaction: { enabled: false, reserveTokens: 5000 } }))
  assert.equal(settings.policy({ contextWindow: 128000 }, dir).source, 'project')
  assert.equal(settings.policy({ contextWindow: 128000 }, dir).native.enabled, false)
  assert.throws(() => contextPolicy(DEFAULT_CONTEXT_SETTINGS, { contextWindow: 8192 }, { reserveTokens: 10000 }), /reserveTokens/)
})

test('manual compaction excludes prompts and configuration changes and preserves history', async t => {
  const dir = temporary(t)
  let finish, called
  const runtime = { child: { stdin: { writable: true } }, contextPolicy: { contextWindow: 10000 }, inFlightPrompt: false }
  const service = new AgentSessionService({ userDataDir: dir, resolveRuntime: () => runtime, sendCommand: async command => {
    called = command.type
    if (command.type === 'compact') return new Promise(resolve => { finish = resolve })
    return { data: { contextUsage: { tokens: null, contextWindow: 10000, percent: null } } }
  } })
  service.sessions.set('session', { sessionId: 'session', piSessionPath: path.join(dir, 'session.jsonl'), cwd: dir })
  const pending = service.compact({ sessionId: 'session' })
  assert.equal(called, 'compact')
  await assert.rejects(service.start({ sessionId: 'session' }), /压缩/)
  await assert.rejects(service.prompt({ sessionId: 'session', message: 'do not send' }), /压缩/)
  await assert.rejects(service.compact({ sessionId: 'session' }), /执行/)
  finish({ data: { tokensBefore: 9000, estimatedTokensAfter: 1000 } })
  await pending
  assert.equal(service.maintenance.size, 0)
  assert.equal(runtime.compacting, false)
  assert.equal((await service.contextStatus({ sessionId: 'session' })).usage.tokens, null)
})

test('automatic overflow compaction clears stale failure only after successful recovery and emits usage', t => {
  const dir = temporary(t), service = new AgentSessionService({ userDataDir: dir })
  const key = path.join(dir, 'pi.jsonl'), events = []
  service.sessions.set('root', { sessionId: 'root', piSessionPath: key })
  service.runs.set('root', { runId: 'run', error: 'context exceeded' })
  service.subscribe(event => events.push(event))
  service.ingest(key, { type: 'compaction_start', reason: 'overflow' })
  assert.equal(service.sessions.get('root').context.status, 'compacting')
  service.ingest(key, { type: 'compaction_end', reason: 'overflow', result: null, errorMessage: 'provider failed' })
  assert.equal(service.runs.get('root').error, 'context exceeded')
  service.ingest(key, { type: 'compaction_end', reason: 'overflow', willRetry: true, result: { tokensBefore: 9000, estimatedTokensAfter: 1000, usage: { input: 8000, output: 500 } } })
  assert.equal(service.runs.get('root').error, '')
  assert.deepEqual(events.at(-1).usage, { input: 8000, output: 500 })
  assert.equal(new AgentSessionService({ userDataDir: dir }).sessions.get('root').context.status, 'completed')
})

test('interrupted compaction recovers on restart and live snapshots retain the compression state', async t => {
  const dir = temporary(t), runtime = { child: { stdin: { writable: true } }, compacting: false }
  const service = new AgentSessionService({ userDataDir: dir, resolveRuntime: () => runtime, sendCommand: async () => ({ data: {} }) })
  const key = path.join(dir, 'pi.jsonl')
  service.sessions.set('root', { sessionId: 'root', piSessionPath: key })
  service.emit('root', { type: 'run.started', runId: 'run', input: 'test' })
  service.runs.set('root', { runId: 'run' })
  service.emit('root', { type: 'message.delta', delta: 'progress' })
  service.ingest(key, { type: 'compaction_start', reason: 'threshold' })
  assert.equal(service.snapshot({ sessionId: 'root' }).messages.at(-1).streamStatus, 'compacting')
  const restarted = new AgentSessionService({ userDataDir: dir, resolveRuntime: () => runtime, sendCommand: async () => ({ data: {} }) })
  assert.equal(restarted.sessions.get('root').context.status, 'cancelled')
  assert.equal((await restarted.contextStatus({ sessionId: 'root' })).compacting, false)
  service.runs.delete('root')
  service.runtimeExited(key, 1)
  assert.equal(service.sessions.get('root').context.status, 'cancelled')
  assert.equal(service.snapshot({ sessionId: 'root' }).messages.at(-1).isStreaming, false)
})

test('manual cancellation stops only the selected runtime without reporting successful compression', async t => {
  const dir = temporary(t), runtime = { inFlightPrompt: false }
  let rejectCommand, stopped
  const service = new AgentSessionService({ userDataDir: dir, resolveRuntime: () => runtime,
    sendCommand: async () => new Promise((resolve, reject) => { rejectCommand = reject }),
    stopRuntime: async target => { stopped = target; rejectCommand(new Error('Pi process stopped')) },
  })
  service.sessions.set('root', { sessionId: 'root', piSessionPath: path.join(dir, 'pi.jsonl') })
  const compression = service.compact({ sessionId: 'root' })
  await service.abort({ sessionId: 'root' })
  assert.deepEqual(await compression, { ok: false, cancelled: true })
  assert.equal(stopped, runtime)
  assert.equal(service.maintenance.size, 0)
  assert.equal(service.sessions.get('root').context.status, 'cancelled')
})
