'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AgentEventLog } = require('../agent-event-log.cjs')
const { AgentSessionService } = require('../agent-session.cjs')

test('event batches preserve ordering, include events appended while writing, and drain on flush', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-event-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let writes = 0
  const log = new AgentEventLog({ delay: 10000, open: async (...args) => {
    writes++
    return fs.promises.open(...args)
  } })
  const file = path.join(dir, 'log.jsonl')
  for (let seq = 1; seq <= 500; seq++) log.append(file, { seq, content: 'delta' })
  assert.equal(writes, 0)
  const pending = log.flush()
  for (let seq = 501; seq <= 700; seq++) log.append(file, { seq, content: 'later' })
  await pending
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.map(item => item.seq), Array.from({ length: 700 }, (_, i) => i + 1))
  assert.ok(writes <= 3, `too many writes: ${writes}`)
  assert.equal(log.pending(file).length, 0)
})

test('partial write failures remain readable and retry without duplicate bytes', async () => {
  let fail = true, data = ''
  const log = new AgentEventLog({ delay: 10000, open: async () => ({
    async write(buffer, offset, length) {
      if (offset && fail) { fail = false; throw new Error('disk unavailable') }
      const size = offset ? length : 7
      data += buffer.subarray(offset, offset + size).toString()
      return { bytesWritten: size }
    }, async close() {},
  }) })
  log.append('test', { seq: 1, text: 'first' })
  await assert.rejects(log.flush(), /disk unavailable/)
  assert.equal(log.pending('test')[0].text, 'first')
  log.append('test', { seq: 2, text: 'second' })
  await log.flush()
  assert.deepEqual(data.trim().split('\n').map(JSON.parse).map(item => item.seq), [1, 2])
})

test('snapshots merge pending and persisted events once, and survive a fresh session service', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-event-replay-'))
  const service = new AgentSessionService({ userDataDir: dir })
  t.after(async () => { await service.flushLogs(); fs.rmSync(dir, { recursive: true, force: true }) })
  service.emit('test', { type: 'run.started', runId: 'run', input: 'hello' })
  service.emit('test', { type: 'message.started', runId: 'run' })
  service.emit('test', { type: 'message.delta', runId: 'run', delta: 'first' })
  assert.equal(service.snapshot({ sessionId: 'test' }).messages.at(-1).content, 'first')
  const pending = service.eventLog.pending(service.logFile('test'))
  // A filesystem write can finish before its Promise callback acknowledges it.
  fs.writeFileSync(service.logFile('test'), pending.map(record => JSON.stringify(record)).join('\n') + '\n')
  assert.equal(service.snapshot({ sessionId: 'test' }).messages.at(-1).content, 'first')
  assert.equal(service.history({ sessionId: 'test' }).events.length, 3)
  fs.unlinkSync(service.logFile('test'))
  await service.flushLogs()
  const restored = new AgentSessionService({ userDataDir: dir })
  assert.equal(restored.snapshot({ sessionId: 'test' }).messages.at(-1).content, 'first')
  const lastSeq = service.history({ sessionId: 'test' }).nextSeq
  assert.equal(service.history({ sessionId: 'test', afterSeq: lastSeq }).events.length, 0)
})
