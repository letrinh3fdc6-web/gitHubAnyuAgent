'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const { TaskStorage, digest, clone, diagnosticTask } = require('./task-storage.cjs')
const { WorkspaceCheckpoints, safePath, inside } = require('./workspace-checkpoints.cjs')
const { validateChecks, verify } = require('./agent-verification.cjs')
const { AgentConnectors } = require('./agent-connectors.cjs')

const now = () => new Date().toISOString()
const bounded = (value, max) => String(value || '').slice(0, max)
const READ = new Set(['read', 'grep', 'find', 'ls', 'runtime_probe', 'project_memory_search'])
const ACTIVE = new Set(['preparing', 'running', 'finishing'])

// @project-doc docs/interfaces/anyuagent_workbench.md#task_lifecycle
class AgentWorkbench {
  constructor(options) {
    this.options = options
    this.store = new TaskStorage(path.join(options.directory, 'task-workbench'))
    this.snapshots = new WorkspaceCheckpoints(path.join(this.store.directory, 'blobs'))
    this.connectors = new AgentConnectors({ store: this.store, encrypt: options.encrypt, decrypt: options.decrypt })
    this.contexts = new Map()
    this.operations = new Map()
    this.pending = new Map()
    this.requestLocks = new Map()
    this.getOwner = options.getOwner || (() => 'local')
  }

  async init() {
    await this.store.load()
    for (const task of Object.values(this.store.state.tasks)) {
      if (ACTIVE.has(task.status)) { task.status = 'interrupted'; task.interruptedAt = now() }
    }
    for (const flow of Object.values(this.store.state.workflows)) {
      if (flow.status === 'running') { flow.status = 'review'; flow.enabled = false }
    }
    await this.store.save()
    this.server = http.createServer((req, res) => { void this.handle(req, res) })
    this.server.requestTimeout = 15000
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    this.port = this.server.address().port
    this.timer = setInterval(() => { void this.tick().catch(error => this.options.log?.(error.message)) }, 15000)
    this.timer.unref()
  }

  context(sessionId) {
    for (const [token, id] of this.contexts) if (id === sessionId) return { port: this.port, token }
    const token = crypto.randomBytes(32).toString('hex')
    this.contexts.set(token, sessionId)
    return { port: this.port, token }
  }

  task(id) {
    const task = this.store.state.tasks[id]
    if (!task || task.owner !== String(this.getOwner())) throw new Error('Task not found for current account')
    return task
  }
  active(sessionId) { return Object.values(this.store.state.tasks).find(task => task.sessionId === sessionId && ACTIVE.has(task.status) && task.owner === String(this.getOwner())) }
  async project(cwd) {
    const canonical = await fs.realpath(cwd)
    const id = digest(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    return this.store.state.projects[id] ||= { id, cwd: canonical, memory: [], settings: { budget: 0, maxRequests: 100, checks: [], policy: { shell: 'inherit', workspaceOnly: false, network: true, blockedTools: [] } } }
  }

  async begin(record, run, payload) {
    for (const previous of Object.values(this.store.state.tasks)) if (previous.sessionId === record.sessionId) await this.settled(previous.id)
    const project = await this.project(record.cwd)
    const parent = record.parentSessionId ? this.active(record.parentSessionId) : null
    const task = {
      id: run.runId, sessionId: record.sessionId, parentId: parent?.id || '', rootId: parent?.rootId || parent?.id || run.runId,
      owner: String(this.getOwner()), projectId: project.id, cwd: record.cwd, model: record.model,
      modelSpec: (record.models || []).find(model => model.id === record.model) || {},
      permissionMode: record.permissionMode, team: record.team || null,
      input: run.input, status: 'preparing', startedAt: now(), recoveryOf: payload.recoveryOf || '',
      settings: clone(parent?.settings || project.settings), events: [], requests: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      verification: [], checkpoints: [],
    }
    this.store.state.tasks[task.id] = task
    await this.store.save()
    try {
      task.before = await this.snapshots.persist(`${task.id}-before`, await this.snapshots.capture(task.cwd))
      task.status = 'running'
      await this.store.save()
      this.changed(task, 'started')
      return task
    } catch (error) { task.status = 'failed'; task.error = error.message; await this.store.save(); throw error }
  }

  changed(task, kind = 'updated') { this.options.changed?.({ sessionId: task?.sessionId || '', taskId: task?.id || '', kind }) }
  event(event) {
    const task = this.store.state.tasks[event.runId] || this.active(event.sessionId)
    if (!task) return
    if (['message.completed', 'context.compacted'].includes(event.type) && event.usage) {
      for (const key of Object.keys(task.tokens)) task.tokens[key] += Math.max(0, Number(event.usage[key]) || 0)
    } else if (['tool.started', 'tool.completed', 'approval.resolved', 'approval.auto', 'run.retrying'].includes(event.type)) {
      task.events.push({ at: event.at, type: event.type, toolName: event.toolName || '', toolCallId: event.toolCallId || '', ok: !event.isError, decision: event.decision })
      if (task.events.length > 1000) task.events.splice(0, task.events.length - 1000)
    } else if (event.type === 'run.finished') {
      task.status = 'finishing'
      task.result = bounded(event.text, 16000)
      task.error = bounded(event.error, 2000)
      task.finishedAt = now()
      const pending = this.finish(task, event.status).catch(error => { task.status = 'failed'; task.error = error.message; return this.store.save() }).finally(() => { this.pending.delete(task.id); this.changed(task, 'finished') })
      this.pending.set(task.id, pending)
      return
    } else return
    void this.store.save().then(() => this.changed(task)).catch(error => this.options.log?.(error.message))
  }

  async finish(task, status) {
    const after = await this.snapshots.capture(task.cwd)
    task.after = await this.snapshots.persist(`${task.id}-after`, after)
    task.changes = this.snapshots.changes(await this.snapshots.load(task.before), after)
    if (status === 'completed' && !task.parentId && task.settings.checks.length) {
      task.verification = await verify(task.cwd, task.settings.checks, this.options.environment?.() || process.env)
      task.acceptance = task.verification.every(check => check.ok) ? 'passed' : 'failed'
      task.verifiedAt = now()
    }
    task.status = status
    await this.syncBilling(task.rootId).catch(() => {})
    await this.store.save()
    if (!task.parentId) this.options.notify?.(status === 'completed' && task.acceptance !== 'failed' ? 'AnyuAgent 任务完成' : 'AnyuAgent 任务需要处理', bounded(task.input, 80))
  }

  async settled(id) { await this.pending.get(id) }
  async exclusive(id, operation) {
    if (this.operations.has(id)) throw new Error('An operation is already in progress')
    this.operations.set(id, true)
    try { return await operation() } finally { this.operations.delete(id) }
  }

  async checkpoint(sessionId, summary) {
    const task = this.active(sessionId)
    if (!task) throw new Error('No active task')
    task.checkpoints.push({ at: now(), summary: bounded(summary, 4000), eventIndex: task.events.length })
    if (task.checkpoints.length > 100) task.checkpoints.shift()
    await this.store.save()
    return { id: task.id, checkpoints: task.checkpoints.length }
  }

  async recovery(id) {
    const task = this.task(id)
    if (ACTIVE.has(task.status) || this.active(task.sessionId)) throw new Error('Stop the active task first')
    if (task.parentId) throw new Error('Retry child tasks from their parent')
    return this.exclusive(task.sessionId, () => this.options.resume(task, [
      'Continue the interrupted task after inspecting the existing files and prior conversation. Do not blindly repeat completed external actions.',
      `Original request: ${task.input}`,
      `Latest checkpoint: ${task.checkpoints.at(-1)?.summary || 'No explicit checkpoint; inspect prior tool results.'}`,
      `Last tool states: ${JSON.stringify(task.events.slice(-8))}`,
    ].join('\n')))
  }

  async reconcile(id) {
    const task = this.task(id)
    if (ACTIVE.has(task.status)) throw new Error('Task is still active')
    await this.settled(id)
    if (!task.after) {
      const after = await this.snapshots.capture(task.cwd)
      task.after = await this.snapshots.persist(`${task.id}-after`, after)
      task.changes = this.snapshots.changes(await this.snapshots.load(task.before), after)
      task.recoveredSnapshot = true
      await this.store.save()
    }
    return task
  }

  async verifyTask(id) {
    return this.exclusive(id, async () => {
      const task = await this.reconcile(id)
      if (this.active(task.sessionId)) throw new Error('Stop the active task before acceptance checks')
      task.verification = await verify(task.cwd, task.settings.checks, this.options.environment?.() || process.env)
      task.acceptance = task.verification.length ? task.verification.every(check => check.ok) ? 'passed' : 'failed' : 'not_configured'
      task.verifiedAt = now()
      await this.store.save(); this.changed(task)
      return task.verification
    })
  }

  async review(id, action) {
    return this.exclusive(id, async () => {
      const task = await this.reconcile(id)
      if (this.active(task.sessionId)) throw new Error('Stop the active task before reviewing changes')
      if (task.review) throw new Error('This change set has already been reviewed')
      if (action === 'rollback') {
        if (task.recoveredSnapshot) throw new Error('After a crash, file ownership is uncertain. Review the diff and restore individual files manually.')
        await this.snapshots.apply(task.cwd, task.changes, true)
      } else if (action !== 'accept') throw new Error('Invalid review action')
      task.review = action; task.reviewedAt = now()
      await this.store.save(); this.changed(task)
      return { ok: true }
    })
  }

  async settings(cwd, input) {
    const project = await this.project(cwd)
    const budget = Number(input.budget), maxRequests = Number(input.maxRequests)
    if (!Number.isFinite(budget) || budget < 0 || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw new Error('Invalid budget or request limit')
    const policy = input.policy || {}
    if (!['inherit', 'confirm', 'deny'].includes(policy.shell)) throw new Error('Invalid command policy')
    if (policy.blockedTools && (!Array.isArray(policy.blockedTools) || policy.blockedTools.length > 100)) throw new Error('Invalid tool policy')
    project.settings = { budget, maxRequests, checks: validateChecks(input.checks || []), policy: { shell: policy.shell, workspaceOnly: Boolean(policy.workspaceOnly), network: policy.network !== false, blockedTools: (policy.blockedTools || []).map(name => bounded(name, 100)) } }
    await this.store.save()
    return clone(project.settings)
  }

  async memory(cwd, action, payload) {
    const project = await this.project(cwd)
    if (action === 'search') {
      const words = bounded(payload.query, 500).toLowerCase().split(/\s+/).filter(Boolean)
      return project.memory.map(item => ({ ...item, score: words.reduce((n, word) => n + (item.text.toLowerCase().includes(word) ? 1 : 0), 0) })).filter(item => !words.length || item.score).sort((a, b) => b.score - a.score).slice(0, 12)
    }
    if (action === 'delete') project.memory = project.memory.filter(item => item.id !== payload.id)
    else if (action === 'save') {
      const text = bounded(payload.text, 12000).trim()
      if (!text) throw new Error('Memory text is required')
      const item = { id: payload.id || crypto.randomUUID(), text, source: bounded(payload.source || 'user', 1000), updatedAt: now() }
      const index = project.memory.findIndex(old => old.id === item.id)
      if (index >= 0) project.memory[index] = item
      else { if (project.memory.length >= 200) throw new Error('Project memory limit reached'); project.memory.push(item) }
    } else throw new Error('Unknown memory action')
    await this.store.save()
    return project.memory
  }

  async authorize(sessionId, name, input) {
    const task = this.active(sessionId)
    if (!task) throw new Error('No active task context')
    const policy = task.settings.policy
    let decision = 'allow', reason = ''
    if (policy.blockedTools.includes(name)) { decision = 'deny'; reason = 'Tool disabled by project policy' }
    if (policy.workspaceOnly && ['read', 'write', 'edit', 'ls', 'grep', 'find'].includes(name)) {
      const target = path.resolve(task.cwd, input.path || input.file_path || '.')
      if (!inside(task.cwd, target)) { decision = 'deny'; reason = 'Path outside project policy' }
      else if (target !== task.cwd) {
        try { await safePath(task.cwd, path.relative(task.cwd, target)) } catch (error) { decision = 'deny'; reason = error.message }
      }
    }
    if (!policy.network && (name.startsWith('browser_') || name === 'mcp_call')) { decision = 'deny'; reason = 'Network tools disabled by project policy' }
    if (name === 'bash' && decision !== 'deny') {
      if (policy.shell === 'deny') { decision = 'deny'; reason = 'Commands disabled by project policy' }
      // Shell is not an OS sandbox. A restricted project must explicitly review
      // arbitrary commands, which could access paths or networks indirectly.
      else if (policy.shell === 'confirm' || policy.workspaceOnly || !policy.network) decision = 'confirm'
    }
    if (!READ.has(name) && !['write', 'edit', 'bash', 'task_checkpoint', 'delegate_tasks'].includes(name) && (policy.workspaceOnly || !policy.network) && decision === 'allow') decision = 'confirm'
    task.events.push({ at: now(), type: 'policy.decision', toolName: name, decision, ok: decision !== 'deny' })
    await this.store.save()
    return { decision, reason }
  }

  async syncBilling(rootId) {
    const tasks = Object.values(this.store.state.tasks).filter(task => task.rootId === rootId && task.owner === String(this.getOwner()))
    const unsettled = tasks.flatMap(task => task.requests).filter(request => request.cost === undefined && request.serverRequestId)
    for (let offset = 0; offset < unsettled.length; offset += 50) {
      const batch = unsettled.slice(offset, offset + 50)
      const records = await this.options.billing(batch.map(item => `client:${item.serverRequestId}`))
      for (const request of batch) {
        const matching = records.filter(item => item.request_id === `client:${request.serverRequestId}`)
        if (matching.length) { request.cost = matching.reduce((sum, item) => sum + Number(item.actual_cost || 0), 0); request.settledAt = now() }
      }
    }
    await this.store.save()
    return this.cost(rootId)
  }
  cost(rootId) {
    const requests = Object.values(this.store.state.tasks).filter(task => task.rootId === rootId && task.owner === String(this.getOwner())).flatMap(task => task.requests)
    return { actual: requests.reduce((sum, item) => sum + (item.cost || 0), 0), pending: requests.filter(item => item.cost === undefined).length, requests: requests.length }
  }

  async response(requestId, serverRequestId, status) {
    if (typeof serverRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(serverRequestId)) return
    const request = Object.values(this.store.state.tasks).flatMap(task => task.requests).find(item => item.id === requestId)
    if (!request) return
    request.serverRequestId = serverRequestId
    request.httpStatus = Number(status)
    await this.store.save()
  }

  async request(sessionId, requestId, model) {
    const task = this.active(sessionId)
    if (!task) throw new Error('No active task for model request')
    const previous = this.requestLocks.get(task.rootId) || Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const root = this.store.state.tasks[task.rootId] || task
      if (root.settings.budget > 0) await this.syncBilling(root.id)
      const cost = this.cost(root.id)
      if (cost.requests >= root.settings.maxRequests) throw new Error('Task request limit reached')
      if (root.settings.budget > 0 && cost.actual >= root.settings.budget) throw new Error('Task spending threshold reached')
      // With a spend threshold, do not admit another call until the previous
      // one is settled. A single in-flight call can still exceed the threshold.
      if (root.settings.budget > 0 && cost.pending) throw new Error('Prior request billing is pending; refresh costs before continuing')
      task.requests.push({ id: requestId, model, at: now() })
      await this.store.save()
    })
    this.requestLocks.set(task.rootId, operation)
    try { await operation } finally { if (this.requestLocks.get(task.rootId) === operation) this.requestLocks.delete(task.rootId) }
  }

  async inspectEnvironment(cwd, dependencies, repair = false) {
    const project = await this.project(cwd)
    if (!dependencies || typeof dependencies !== 'object') throw new Error('Dependencies required')
    const result = repair ? await this.options.repair(dependencies) : await this.options.inspect(dependencies)
    const file = path.join(project.cwd, `.anyu-write-probe-${crypto.randomUUID()}`)
    let writable = false, writeError = ''
    try { await fs.writeFile(file, 'probe', { flag: 'wx' }); await fs.unlink(file); writable = true } catch (error) { writeError = error.code || error.message }
    project.environment = { at: now(), ...result, writable, writeError }
    await this.store.save()
    return project.environment
  }

  async saveWorkflow(cwd, payload) {
    const source = this.task(payload.taskId)
    if (source.cwd !== cwd || source.parentId) throw new Error('Select a root task from this project')
    const minutes = Number(payload.intervalMinutes || 0)
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 43200 || (minutes > 0 && minutes < 5)) throw new Error('Schedule interval must be at least 5 minutes')
    const flow = { id: crypto.randomUUID(), owner: source.owner, projectId: source.projectId, taskId: source.id, name: bounded(payload.name || source.input, 80), prompt: bounded(payload.prompt || source.input, 32000), intervalMinutes: minutes, enabled: Boolean(payload.enabled), nextAt: new Date(Date.now() + Math.max(5, minutes) * 60000).toISOString(), status: 'idle', retries: 0, maxRetries: Math.min(3, Math.max(0, Number(payload.maxRetries) || 0)), retrySafe: payload.retrySafe === true }
    this.store.state.workflows[flow.id] = flow
    await this.store.save()
    return flow
  }

  async runWorkflow(id) {
    const flow = this.store.state.workflows[id]
    if (!flow || flow.owner !== String(this.getOwner())) throw new Error('Workflow not found')
    if (flow.status === 'running') throw new Error('Workflow is already running')
    flow.status = 'running'; flow.startedAt = now()
    await this.store.save()
    try {
      const result = await this.options.workflow(this.task(flow.taskId), flow.prompt)
      flow.runId = result.runId
      await this.store.save()
      return result
    } catch (error) {
      flow.status = 'failed'; flow.error = bounded(error.message, 2000); flow.enabled = false
      await this.store.save(); throw error
    }
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const flow of Object.values(this.store.state.workflows)) {
        if (flow.owner !== String(this.getOwner())) continue
        if (flow.status === 'running') {
          const task = this.store.state.tasks[flow.runId]
          if (!task || ACTIVE.has(task.status)) continue
          flow.status = task.acceptance === 'failed' ? 'failed' : task.status
          flow.finishedAt = now()
          const retry = flow.status === 'failed' && flow.retrySafe && flow.retries < flow.maxRetries
          flow.retries = retry ? flow.retries + 1 : 0
          if (retry) flow.enabled = true
          flow.nextAt = new Date(Date.now() + (retry ? 60000 * flow.retries : flow.intervalMinutes * 60000)).toISOString()
          if (!retry && !flow.intervalMinutes) flow.enabled = false
          await this.store.save()
        }
        if (flow.enabled && flow.status !== 'running' && Date.parse(flow.nextAt) <= Date.now()) {
          if (Object.values(this.store.state.tasks).some(task => ACTIVE.has(task.status))) continue
          await this.runWorkflow(flow.id)
          break
        }
      }
    } finally { this.ticking = false }
  }

  async state(cwd, sessionId) {
    const project = await this.project(cwd)
    const tasks = Object.values(this.store.state.tasks).filter(task => task.owner === String(this.getOwner()) && (task.projectId === project.id || task.sessionId === sessionId)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100).map(task => {
      const { before, after, ...rest } = task
      return { ...rest, coverage: { complete: before?.complete && after?.complete, skipped: [...new Set([...(before?.skipped || []), ...(after?.skipped || [])])].slice(0, 30) }, cost: this.cost(task.rootId) }
    })
    return { tasks, project: clone(project), connectors: this.connectors.list(), workflows: Object.values(this.store.state.workflows).filter(flow => flow.projectId === project.id && flow.owner === String(this.getOwner())) }
  }

  async dispatch(action, payload = {}) {
    const cwd = payload.cwd
    switch (action) {
      case 'state': return this.state(cwd, payload.sessionId)
      case 'settings': return this.settings(cwd, payload.settings)
      case 'resume': return this.recovery(payload.id)
      case 'review': return this.review(payload.id, payload.action)
      case 'verify': return this.verifyTask(payload.id)
      case 'diff': { const task = await this.reconcile(payload.id); const change = task.changes.find(item => item.path === payload.path); if (!change) throw new Error('Change not found'); return this.snapshots.preview(change) }
      case 'billing': return this.syncBilling(this.task(payload.id).rootId)
      case 'memory': return this.memory(cwd, payload.action, payload)
      case 'environment': return this.inspectEnvironment(cwd, payload.dependencies, payload.repair === true)
      case 'connector.save': return this.connectors.save(payload)
      case 'connector.health': return this.connectors.health(payload.id)
      case 'connector.allow': return this.connectors.allow(payload.id, payload.tools)
      case 'connector.delete': return this.connectors.remove(payload.id)
      case 'workflow.save': return this.saveWorkflow(cwd, payload)
      case 'workflow.run': return this.runWorkflow(payload.id)
      case 'workflow.toggle': { const flow = this.store.state.workflows[payload.id]; if (!flow || flow.owner !== String(this.getOwner())) throw new Error('Workflow not found'); flow.enabled = Boolean(payload.enabled); await this.store.save(); return flow }
      case 'workflow.delete': { const flow = this.store.state.workflows[payload.id]; if (!flow || flow.owner !== String(this.getOwner()) || flow.status === 'running') throw new Error('Cannot delete this workflow'); delete this.store.state.workflows[payload.id]; await this.store.save(); return { ok: true } }
      case 'diagnostics': return { version: 1, exportedAt: now(), platform: process.platform, task: diagnosticTask(this.task(payload.id)) }
      default: throw new Error('Unknown task operation')
    }
  }

  async handle(req, res) {
    const send = (code, data) => { if (!res.destroyed) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) } }
    const sessionId = this.contexts.get(String(req.headers['x-anyu-task-token'] || ''))
    if (req.method !== 'POST' || !sessionId) return send(403, { error: 'Invalid task context' })
    try {
      const parts = []; let bytes = 0
      for await (const part of req) { bytes += part.length; if (bytes > 128000) throw new Error('Request too large'); parts.push(part) }
      const data = JSON.parse(Buffer.concat(parts).toString('utf8'))
      const task = this.active(sessionId)
      if (!task) throw new Error('Task is no longer active')
      let result
      switch (req.url) {
        case '/policy': result = await this.authorize(sessionId, data.name, data.input || {}); break
        case '/checkpoint': result = await this.checkpoint(sessionId, data.summary); break
        case '/memory': result = await this.memory(task.cwd, 'search', data); break
        case '/connectors': result = this.connectors.list().map(item => ({ id: item.id, name: item.name, tools: item.tools.filter(tool => item.allowedTools.includes(tool.name)) })); break
        case '/mcp': if (!task.settings.policy.network) throw new Error('Network tools disabled'); result = await this.connectors.call(data.id, data.name, data.arguments); break
        default: throw new Error('Unknown task endpoint')
      }
      send(200, result)
    } catch (error) { send(400, { error: error.message }) }
  }

  async close() {
    clearInterval(this.timer)
    await Promise.allSettled([...this.pending.values()])
    await this.store.queue
    await this.connectors.close()
    this.server?.closeAllConnections()
    if (this.server) await new Promise(resolve => this.server.close(resolve))
  }
}

module.exports = { AgentWorkbench }
