'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { AgentSessionService } = require('../agent-session.cjs')

async function createSession(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-session-retry-'))
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }))
  const events = []
  const service = new AgentSessionService({
    userDataDir,
    startRuntime: async () => ({ sessionPath: 'session.jsonl' }),
    resolveRuntime: () => ({}),
    sendCommand: async () => {},
    broadcast: (_channel, payload) => events.push(payload.event),
  })
  await service.start({ sessionId: 'retry-test', model: 'test-model' })
  await service.prompt({ sessionId: 'retry-test', message: 'hello' })
  const ingest = (event) => service.ingest('session.jsonl', event)
  const start = () => ingest({ type: 'message_start', message: { role: 'assistant' } })
  const end = (content = '', errorMessage = '', stopReason = errorMessage ? 'error' : 'stop') => ingest({
    type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: content }], errorMessage, stopReason },
  })
  return { service, events, ingest, start, end }
}

test('auto permissions do not restart a runtime that resolves to confirm', async t => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-session-permission-'))
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }))
  const starts = []
  const service = new AgentSessionService({ userDataDir, startRuntime: async options => {
    starts.push(options)
    return { sessionPath: 'permission.jsonl', permissionMode: options.permissionMode === 'auto' ? 'confirm' : options.permissionMode }
  } })
  await service.start({ sessionId: 'permission-test', permissionMode: 'auto' })
  await service.start({ sessionId: 'permission-test', permissionMode: 'auto' })
  assert.equal(starts[1].force, false)
  assert.equal(service.sessions.get('permission-test').permissionMode, 'confirm')
  await service.start({ sessionId: 'permission-test', permissionMode: 'full' })
  assert.equal(starts[2].force, true)
})

test('a stale full session record cannot auto-approve a controlled runtime', async t => {
  const { service, events, ingest } = await createSession(t)
  t.after(() => service.stopAll())
  const record = service.findByPath('session.jsonl')
  record.permissionMode = 'full'
  service.resolveRuntime = () => ({ permissionMode: 'confirm' })
  let autoApproved = false
  service.respondUi = async () => { autoApproved = true }
  ingest({ type: 'extension_ui_request', id: 'approval-one', method: 'confirm', title: 'Write file?' })
  assert.equal(autoApproved, false)
  assert.equal(events.at(-1).type, 'approval.requested')
  await service.approve({ sessionId: record.sessionId, requestId: 'approval-one', decision: 'deny' })
})

test('full permission is determined by the running process and idle metadata follows a restart', async t => {
  const { service, events, ingest } = await createSession(t)
  t.after(() => service.stopAll())
  const record = service.findByPath('session.jsonl')
  record.permissionMode = 'confirm'
  service.resolveRuntime = () => ({ permissionMode: 'full' })
  const answers = []
  service.respondUi = async response => { answers.push(response) }
  ingest({ type: 'extension_ui_request', id: 'approval-full', method: 'confirm', title: 'Write file?' })
  assert.equal(answers[0].confirmed, true)
  assert.equal(events.at(-1).type, 'approval.auto')
  service.runtimePermissionChanged('session.jsonl', 'full')
  assert.equal(record.permissionMode, 'confirm', 'Running turn keeps its snapshot')
  ingest({ type: 'agent_settled' })
  service.runtimePermissionChanged('session.jsonl', 'full')
  assert.equal(record.permissionMode, 'full')
})

test('a successful retry clears the previous 502 in live events and replay', async (t) => {
  const { service, events, ingest, start, end } = await createSession(t)
  start()
  end('', '502 upstream TLS handshake timeout')
  assert.equal(events.at(-1).content, '')
  ingest({ type: 'agent_end', willRetry: true })
  ingest({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3 })
  start()
  ingest({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'OK' } })
  end('OK')
  ingest({ type: 'agent_end' })
  ingest({ type: 'auto_retry_end', success: true })
  ingest({ type: 'agent_settled' })
  assert.equal(events.at(-1).type, 'run.finished')
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(events.at(-1).error, '')
  assert.equal(events.at(-1).text, 'OK')
  assert.equal(service.list()[0].running, false)
  const assistant = service.snapshot({ sessionId: 'retry-test' }).messages.at(-1)
  assert.equal(assistant.content, 'OK')
  assert.equal(assistant.isError, false)
  assert.equal(assistant.isStreaming, false)
})

test('progress prose and tools remain in chronological order during execution and replay', async (t) => {
  const { service, events, ingest, start, end } = await createSession(t)
  start()
  ingest({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Checking files.' } })
  ingest({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1 } })
  assert.equal(events.at(-1).type, 'tool.preparing')
  ingest({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{"path":"README.md"}' } })
  end('Checking files.', '', 'toolUse')
  ingest({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'README.md' } })
  ingest({ type: 'tool_execution_update', toolCallId: 'read-1', partialResult: { content: [{ type: 'text', text: 'working' }] } })
  assert.equal(service.snapshot({ sessionId: 'retry-test' }).messages.at(-1).activities[0].output, 'working')
  ingest({ type: 'tool_execution_end', toolCallId: 'read-1', result: { content: [{ type: 'text', text: 'done' }] } })
  start()
  ingest({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Finished.' } })
  const live = service.snapshot({ sessionId: 'retry-test' }).messages.at(-1)
  assert.equal(live.isStreaming, true)
  assert.deepEqual(live.parts.map(part => part.kind === 'text' ? part.content : part.id), ['Checking files.', 'read-1', 'Finished.'])
  end('Finished.')
  ingest({ type: 'agent_settled' })
  const replay = service.snapshot({ sessionId: 'retry-test' }).messages.at(-1)
  assert.deepEqual(replay.parts, live.parts)
  assert.equal(replay.isStreaming, false)
  assert.equal(replay.content, 'Finished.')
  assert.equal(replay.activities[0].output, 'done')
})

test('retry exhaustion remains failed with a readable error in the snapshot', async (t) => {
  const { service, events, ingest, start, end } = await createSession(t)
  for (let attempt = 0; attempt < 3; attempt++) {
    start()
    end('', '503 model_unavailable')
    ingest({ type: 'agent_end', willRetry: attempt < 2 })
    if (attempt < 2) ingest({ type: 'auto_retry_start', attempt: attempt + 1 })
  }
  ingest({ type: 'auto_retry_end', success: false, finalError: '503 model_unavailable' })
  ingest({ type: 'agent_settled' })
  assert.equal(events.at(-1).status, 'failed')
  assert.equal(events.at(-1).error, '503 model_unavailable')
  assert.equal(events.at(-1).text, '')
  const assistant = service.snapshot({ sessionId: 'retry-test' }).messages.at(-1)
  assert.equal(assistant.isError, true)
  assert.equal(assistant.content, '503 model_unavailable')
})

test('snapshot resets the previous attempt before the new response has finished', async (t) => {
  const { service, ingest, start, end } = await createSession(t)
  start()
  end('discarded partial output', 'stream closed')
  ingest({ type: 'auto_retry_start', attempt: 1 })
  start()
  ingest({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'new output' } })
  const assistant = service.snapshot({ sessionId: 'retry-test' }).messages.at(-1)
  assert.equal(assistant.content, 'new output')
  assert.equal(assistant.isStreaming, true)
  assert.equal(assistant.isError, false)
})

test('a terminal stream error preserves genuine partial output', async (t) => {
  const { events, ingest, start, end } = await createSession(t)
  start()
  ingest({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' } })
  end('', 'stream disconnected')
  ingest({ type: 'agent_end' })
  ingest({ type: 'agent_settled' })
  assert.equal(events.at(-1).status, 'failed')
  assert.equal(events.at(-1).text, 'partial answer')
})

test('an explicit error stop without an error string cannot become success', async (t) => {
  const { events, ingest, start, end } = await createSession(t)
  start()
  end('', '', 'error')
  ingest({ type: 'agent_settled' })
  assert.equal(events.at(-1).status, 'failed')
  assert.ok(events.at(-1).error)
})

test('a runtime terminal error overrides an earlier successful assistant message', async (t) => {
  const { events, ingest, start, end } = await createSession(t)
  start()
  end('tool plan')
  ingest({ type: 'agent_settled', error: 'runtime stopped unexpectedly' })
  assert.equal(events.at(-1).status, 'failed')
  assert.equal(events.at(-1).error, 'runtime stopped unexpectedly')
})

test('abort waits for the settled event and releases the session before the next prompt', async (t) => {
  const { service, events, ingest } = await createSession(t)
  let stopCalls = 0
  service.sendCommand = async command => { if (command.type === 'abort') stopCalls++ }
  let finished = false
  const stopping = service.abort({ sessionId: 'retry-test' }).then(() => { finished = true })
  const stoppingAgain = service.abort({ sessionId: 'retry-test' })
  await Promise.resolve()
  assert.equal(finished, false)
  assert.equal(stopCalls, 1)
  await assert.rejects(service.prompt({ sessionId: 'retry-test', message: 'too early' }), /仍在运行/)
  ingest({ type: 'agent_settled' })
  await Promise.all([stopping, stoppingAgain])
  assert.equal(finished, true)
  assert.equal(events.at(-1).status, 'cancelled')
  assert.ok(events.at(-1).runId)
  await service.prompt({ sessionId: 'retry-test', message: 'replacement' })
  assert.equal(service.list()[0].running, true)
})

test('a failed abort stops only the affected session runtime before accepting a new prompt', async (t) => {
  const { service, events } = await createSession(t)
  const runtime = { key: 'first-runtime' }
  service.resolveRuntime = () => runtime
  service.sendCommand = async command => { if (command.type === 'abort') throw new Error('runtime unresponsive') }
  const stopped = []
  service.stopRuntime = async target => { stopped.push(target) }
  await service.abort({ sessionId: 'retry-test' })
  assert.deepEqual(stopped, [runtime])
  assert.equal(events.at(-1).status, 'cancelled')
  assert.equal(service.list()[0].running, false)
  await service.prompt({ sessionId: 'retry-test', message: 'replacement' })
})

test('a runtime exit during an intentional stop remains cancelled', async (t) => {
  const { service, events } = await createSession(t)
  const stopping = service.abort({ sessionId: 'retry-test' })
  service.runtimeExited('session.jsonl', 0)
  await stopping
  const finished = events.findLast(event => event.type === 'run.finished')
  assert.equal(finished.status, 'cancelled')
  assert.equal(finished.error, '')
})

test('thinking is configured before prompt and cannot race a second prompt', async (t) => {
  const { service, ingest } = await createSession(t)
  ingest({ type: 'agent_settled' })
  const calls = []
  let release
  service.configureThinking = async (_runtime, level) => {
    calls.push(level)
    await new Promise(resolve => { release = resolve })
  }
  service.sendCommand = async command => { calls.push(command.type) }
  const prompt = service.prompt({ sessionId: 'retry-test', message: 'next', thinkingLevel: 'low' })
  await assert.rejects(service.prompt({ sessionId: 'retry-test', message: 'racing', thinkingLevel: 'max' }), /仍在运行/)
  assert.deepEqual(calls, ['low'])
  release()
  await prompt
  assert.deepEqual(calls, ['low', 'prompt'])
})

test('a failed thinking configuration never starts a model request', async (t) => {
  const { service, events, ingest } = await createSession(t)
  ingest({ type: 'agent_settled' })
  service.configureThinking = () => { throw new Error('invalid thinking level') }
  let sent = false
  service.sendCommand = async () => { sent = true }
  await assert.rejects(service.prompt({ sessionId: 'retry-test', message: 'next', thinkingLevel: 'invalid' }), /invalid thinking/)
  assert.equal(sent, false)
  assert.equal(events.at(-1).status, 'failed')
})
