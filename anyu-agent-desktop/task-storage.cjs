'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))

class TaskStorage {
  constructor(directory) {
    this.directory = directory
    this.file = path.join(directory, 'state.json')
    this.state = { version: 1, tasks: {}, projects: {}, connectors: {}, workflows: {} }
    this.queue = Promise.resolve()
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true })
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (data.version !== 1 || !data.tasks || !data.projects || !data.workflows || !data.connectors) throw new Error('Unsupported task store')
      this.state = data
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read task store: ${error.message}`)
    }
    return this.state
  }

  save() {
    const content = JSON.stringify(this.state)
    const operation = this.queue.then(async () => {
      const temp = `${this.file}.${crypto.randomUUID()}.tmp`
      const handle = await fs.open(temp, 'wx', 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await fs.rename(temp, this.file)
    })
    this.queue = operation.catch(() => {})
    return operation
  }
}

// Export only structured diagnostic metadata. Prompts, file content, credentials
// and tool output are intentionally absent from a diagnostic bundle.
function diagnosticTask(task) {
  return {
    id: task.id, sessionId: task.sessionId, parentId: task.parentId,
    status: task.status, model: task.model, startedAt: task.startedAt, finishedAt: task.finishedAt,
    recoveryOf: task.recoveryOf, tokens: task.tokens, requests: task.requests,
    events: (task.events || []).map(({ at, type, toolName, ok, requestId }) => ({ at, type, toolName, ok, requestId })),
    verification: (task.verification || []).map(({ kind, ok, code, durationMs }) => ({ kind, ok, code, durationMs })),
  }
}

module.exports = { TaskStorage, digest, clone, diagnosticTask }
