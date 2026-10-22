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
