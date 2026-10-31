'use strict'

const http = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')

const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'runtime_probe'])
const PROTOCOLS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'google-vertex'])
const stopped = () => Object.assign(new Error('任务已停止'), { code: 'ERR_CANCELED' })
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max

function resolveConfig(team, models) {
  if (!team?.enabled) return null
  if (!Array.isArray(team.workers) || !integer(team.workers.length, 1, 4)) throw new Error('请选择 1-4 个执行子代理')
  if (!integer(team.maxParallel, 1, 2)) throw new Error('子代理并发限制为 1-2 个')
  if (!integer(team.maxTasks, 1, 64)) throw new Error('每轮子任务数量限制为 1-64 个')
  if (!integer(team.timeoutMinutes, 0, 1440)) throw new Error('多代理时限为 0-1440 分钟，0 表示不限时')
  const ids = new Set()
  const workers = team.workers.map(worker => {
    if (!worker || !/^[a-zA-Z0-9_-]{1,64}$/.test(worker.id) || ids.has(worker.id)) throw new Error('子代理标识无效')
    ids.add(worker.id)
    const selection = worker.selection || {}
    const model = models.find(item => item.id === selection.model && item.group_id === selection.groupId && item.api === selection.api)
    if (!model || !PROTOCOLS.has(model.api)) throw new Error(`子代理模型 ${selection.model || ''} 已不可用`)
    const thinkingLevel = selection.thinkingLevel || 'auto'
    if (thinkingLevel !== 'auto' && !model.thinking?.levels?.includes(thinkingLevel)) throw new Error('子代理思考档位不受支持')
    return { id: worker.id, selection: { groupId: model.group_id, model: model.id, api: model.api, thinkingLevel }, catalogModel: model }
  })
  return { enabled: true, workers, maxParallel: team.maxParallel, maxTasks: team.maxTasks, timeoutMinutes: team.timeoutMinutes }
}

// FIFO shared/exclusive leases cover actual tools, including shell and browser
// operations. Unknown tools are exclusive; read-only children use an allowlist.
class ToolLeases {
  constructor() { this.active = new Map(); this.queue = [] }
  acquire(context, toolCallId, name, signal) {
    if (signal.aborted) return Promise.reject(stopped())
    const key = `${context.token}:${toolCallId}`
    if (this.active.has(key) || this.queue.some(item => item.key === key)) return Promise.reject(new Error('重复工具调用'))
    const shared = READ_TOOLS.has(name)
    return new Promise((resolve, reject) => {
      const item = { key, context, shared, resolve, reject, signal }
      item.cancel = () => {
        this.queue = this.queue.filter(candidate => candidate !== item)
        // Active leases are released only after the owning process has stopped.
        if (!this.active.has(key)) reject(stopped())
        this.drain()
      }
      signal.addEventListener('abort', item.cancel, { once: true })
      this.queue.push(item)
      this.drain()
    })
  }
  drain() {
    while (this.queue.length) {
      const reentrant = this.queue.findIndex(item => [...this.active.values()].some(active => active.context === item.context && !active.shared))
      const index = reentrant < 0 ? 0 : reentrant
      const item = this.queue[index]
      if (item.signal.aborted) { this.queue.splice(index, 1); item.reject(stopped()); continue }
      if ([...this.active.values()].some(active => active.context !== item.context && (!active.shared || !item.shared))) break
      this.queue.splice(index, 1)
      this.active.set(item.key, item)
      item.resolve({ ok: true })
    }
  }
  release(context, toolCallId) {
    const key = `${context.token}:${toolCallId}`
    const item = this.active.get(key)
    if (item) { item.signal.removeEventListener('abort', item.cancel); this.active.delete(key) }
    this.drain()
    return { ok: true }
  }
  releaseContext(context) {
    const waiting = this.queue.filter(item => item.context === context)
    this.queue = this.queue.filter(item => item.context !== context)
    for (const item of waiting) { item.signal.removeEventListener('abort', item.cancel); item.reject(stopped()) }
    for (const [key, item] of this.active) {
      if (item.context !== context) continue
      item.signal.removeEventListener('abort', item.cancel)
      this.active.delete(key)
    }
    this.drain()
  }
}

class AgentOrchestrator {
  constructor({ sessions, getCatalog, retireRuntime, workbench }) {
    this.sessions = sessions
    this.getCatalog = getCatalog
    this.retireRuntime = retireRuntime
    this.workbench = workbench
    this.mergeQueue = Promise.resolve()
    this.roots = new Map()
    this.contexts = new Map()
    this.children = new Map()
    this.leases = new ToolLeases()
    this.childSlots = 0
    this.childQueue = []
    this.unsubscribe = sessions.subscribe(event => this.onEvent(event))
  }

  async listen() {
    if (this.server) return this.port
    if (this.listening) return this.listening
    this.listening = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { void this.handle(req, res) })
      server.on('error', reject)
      server.requestTimeout = 10000
      server.listen(0, '127.0.0.1', () => { this.server = server; this.port = server.address().port; resolve(this.port) })
    }).finally(() => { this.listening = null })
    return this.listening
  }

  async start(payload, { systemPrompt = '' } = {}) {
    const sessionId = String(payload.sessionId || '')
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)) throw new Error('会话标识无效')
    const previousRun = this.roots.get(sessionId)?.run
    if (previousRun?.cleanup) await previousRun.cleanup
    if (this.sessions.runs.has(sessionId) || this.roots.get(sessionId)?.run) throw new Error('当前会话仍在运行')
    const previous = this.roots.get(sessionId)
    if (!payload.team?.enabled) {
      const promptChanged = systemPrompt && this.sessions.sessions.get(sessionId)?.runtimeOptions?.systemPrompt !== systemPrompt
      const result = await this.sessions.start({ ...payload, force: Boolean(payload.force || previous || promptChanged), runtimeOptions: systemPrompt ? { systemPrompt } : {} })
      if (previous) this.contexts.delete(previous.context.token)
      this.roots.delete(sessionId)
      return result
    }
    const catalog = await this.getCatalog()
    const config = resolveConfig(payload.team, catalog.models || [])
    const model = (catalog.models || []).find(item => item.id === payload.model && payload.models?.some(candidate => candidate.id === item.id && candidate.group_id === item.group_id && candidate.api === item.api))
    if (!model || !PROTOCOLS.has(model.api)) throw new Error('主代理模型不在当前可用目录中')
    const port = await this.listen()
    const context = previous?.context || { token: crypto.randomBytes(32).toString('hex'), sessionId, role: 'parent' }
    const signature = JSON.stringify([config, systemPrompt])
    const root = { sessionId, config, context, run: null, signature }
    this.contexts.set(context.token, context)
    this.roots.set(sessionId, root)
    try {
      return await this.sessions.start({
        ...payload, models: [model], force: Boolean(payload.force || !previous || signature !== previous.signature),
        runtimeOptions: { agentRole: 'parent', orchestration: { port, token: context.token }, systemPrompt: [systemPrompt, `多代理已开启。你负责理解用户需求、规划、验收和最终答复。可用执行子代理：${JSON.stringify(config.workers.map(worker => ({ id: worker.id, model: worker.selection.model })))}。简单问题可直接回答；适合委派时调用 delegate_tasks，将必要背景、明确目标、文件范围和验收条件写入 instructions。每批任务须相互独立；有依赖的下一批必须等待上一批结果。资料检索用 read，修改文件或执行命令用 execute。每轮最多 ${config.maxTasks} 个子任务，不可递归委派。只回传任务与证据，不复制内部思考或供应商私有消息。工具失败不得虚报成功。`].filter(Boolean).join('\n\n') },
      })
    } catch (error) {
      if (previous) this.roots.set(sessionId, previous)
      else { this.roots.delete(sessionId); this.contexts.delete(context.token) }
      throw error
    }
  }

  async prompt(payload) {
    const root = this.roots.get(payload.sessionId)
    if (!root) return this.sessions.prompt(payload)
    if (root.run) throw new Error('多代理任务仍在运行')
    const run = { controller: new AbortController(), tasks: new Map(), delegations: new Map(), children: new Set(), active: 0, turns: 0, pending: new Set(), runId: '' }
    root.run = run
    run.timer = root.config.timeoutMinutes > 0
      ? setTimeout(() => { void this.abort({ sessionId: root.sessionId }, `多代理任务已达到设置的 ${root.config.timeoutMinutes} 分钟时限；可调整时限后继续任务`).catch(() => {}) }, root.config.timeoutMinutes * 60000)
      : null
    try { return await this.sessions.prompt(payload) }
    catch (error) { await this.abort({ sessionId: root.sessionId }).catch(() => {}); throw error }
  }

  onEvent(event) {
    if (event.type === 'tool.completed') {
      const context = this.children.get(event.sessionId)?.context || this.roots.get(event.sessionId)?.context
      if (context) this.leases.release(context, event.toolCallId)
    }
    const child = this.children.get(event.sessionId)
    if (child) {
      const { root, run, task } = child
      if (root.run !== run) return
      if (event.type === 'run.finished') {
        task.status = run.controller.signal.aborted ? 'cancelled' : event.status
        task.summary = String(event.text || '').slice(0, 12000)
        task.error = event.error || ''
        task.finishedAt = event.at
        task.durationMs = event.durationMs
        this.publish(root, run, task)
        child.resolve?.()
      } else if (event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed') {
        task.toolName = event.toolName
        this.publish(root, run, task)
        this.sessions.emit(root.sessionId, { type: 'subagent.tool', task: { ...task }, childEvent: event })
      } else if (event.type === 'approval.requested') {
        task.status = 'waiting_approval'
        this.publish(root, run, task)
        this.sessions.emit(root.sessionId, { type: 'approval.requested', request: { ...event.request, sessionId: event.sessionId, title: `${task.title}: ${event.request.title}` } })
      } else if (event.type === 'approval.resolved') {
        task.status = 'running'
        this.publish(root, run, task)
        this.sessions.emit(root.sessionId, { type: 'approval.resolved', requestId: event.requestId, decision: event.decision })
      } else if (event.type === 'run.active' && ++child.turns > 64) {
        task.error = '子代理超过单任务轮次限制'
        const active = this.sessions.runs.get(event.sessionId)
        if (active) active.failureReason = task.error
        void this.sessions.abort({ sessionId: event.sessionId }).catch(() => {})
      }
      return
    }
    const root = this.roots.get(event.sessionId)
    const run = root?.run
    if (!run) return
    if (event.type === 'run.started') run.runId = event.runId
    if (event.type === 'run.active' && ++run.turns > 128) void this.abort({ sessionId: event.sessionId }, '主代理超过本轮轮次限制').catch(() => {})
    if (event.type === 'run.finished') {
      clearTimeout(run.timer)
      run.controller.abort()
      // Foreground delegation normally has already joined all children.
      // Unexpected exits still cancel and retire every descendant.
      run.cleanup = this.stopChildren(root, run).then(() => {
        this.leases.releaseContext(root.context)
        if (root.run === run) root.run = null
      })
      void run.cleanup.catch(() => {})
    }
  }

  publish(root, run, task) {
    if (root.run === run) this.sessions.emit(root.sessionId, { type: 'subagent.updated', runId: run.runId, task: { ...task } })
    const record = this.workbench?.store.state.tasks[run.runId]
    if (record) {
      record.subtasks ||= {}
      record.subtasks[task.id] = { ...task }
      void this.workbench.store.save().catch(() => {})
    }
  }

  async abort(payload, error = '') {
    const root = this.roots.get(payload.sessionId)
    const run = root?.run
    if (!run) return this.sessions.abort(payload)
    if (run.stopping) return run.stopping
    if (error) {
      const active = this.sessions.runs.get(root.sessionId)
      if (active) active.failureReason = error
    }
    run.controller.abort()
    clearTimeout(run.timer)
    run.stopping = (async () => {
      await this.stopChildren(root, run)
      await this.sessions.abort(payload)
      this.leases.releaseContext(root.context)
      if (error) this.sessions.emit(root.sessionId, { type: 'team.stopped', error })
      if (root.run === run) root.run = null
      return { ok: true }
    })()
    return run.stopping
  }

  async stopChildren(root, run) {
    for (const task of run.tasks.values()) if (task.status === 'queued') { task.status = 'cancelled'; task.finishedAt = new Date().toISOString(); this.publish(root, run, task) }
    await Promise.all([...run.children].map(id => this.sessions.abort({ sessionId: id }).catch(() => {})))
    await Promise.allSettled([...run.pending])
  }

  async slot(root, run) {
    if (run.controller.signal.aborted) throw stopped()
    return new Promise((resolve, reject) => {
      const request = { root, run, resolve, reject }
      request.cancel = () => { this.childQueue = this.childQueue.filter(item => item !== request); reject(stopped()); this.drain() }
      run.controller.signal.addEventListener('abort', request.cancel, { once: true })
      this.childQueue.push(request)
      this.drain()
    })
  }

  drain() {
    while (this.childSlots < 2) {
      const index = this.childQueue.findIndex(item => item.run.active < item.root.config.maxParallel)
      if (index < 0) return
      const [item] = this.childQueue.splice(index, 1)
      item.run.controller.signal.removeEventListener('abort', item.cancel)
      if (item.run.controller.signal.aborted) { item.reject(stopped()); continue }
      this.childSlots++
      item.run.active++
      item.resolve(() => { this.childSlots--; item.run.active--; this.drain() })
    }
  }

  async delegate(context, items) {
    const root = this.roots.get(context.sessionId)
    const run = root?.run
    if (context.role !== 'parent' || !run || run.controller.signal.aborted) throw stopped()
    if (!Array.isArray(items) || !integer(items.length, 1, 4) || run.tasks.size + items.length > root.config.maxTasks) throw new Error('委派任务超过本轮或单批数量限制')
    const plans = items.map(item => {
      const worker = root.config.workers.find(candidate => candidate.id === item?.workerId)
      if (!worker || !['read', 'execute'].includes(item.mode) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100 || typeof item.instructions !== 'string' || !item.instructions.trim() || item.instructions.length > 12000) throw new Error('子任务模型、类型或描述无效')
      return { item, worker }
    })
    const keys = new Map()
    for (const { item } of plans) {
      const key = item.key || crypto.randomUUID()
      if (typeof key !== 'string' || !/^[\w-]{1,80}$/.test(key) || keys.has(key)) throw new Error('子任务 key 重复或无效')
      item.key = key
      keys.set(key, item)
    }
    const visiting = new Set(), visited = new Set()
    const visit = key => {
      if (visiting.has(key)) throw new Error('子任务依赖存在循环')
      if (visited.has(key)) return
      const item = keys.get(key)
      if (!item || (item.dependsOn && (!Array.isArray(item.dependsOn) || item.dependsOn.length > 4))) throw new Error('子任务依赖无效')
      visiting.add(key)
      for (const dep of item.dependsOn || []) visit(dep)
      visiting.delete(key); visited.add(key)
    }
    for (const key of keys.keys()) visit(key)
    const jobsByKey = new Map()
    const schedule = ({ item, worker }) => {
      if (jobsByKey.has(item.key)) return jobsByKey.get(item.key)
      const dependencies = (item.dependsOn || []).map(key => schedule(plans.find(plan => plan.item.key === key)))
      const task = { id: crypto.randomUUID(), key: item.key, dependsOn: item.dependsOn || [], isolated: Boolean(this.workbench && item.mode === 'execute' && item.isolate !== false), instructions: item.instructions, workerId: worker.id, model: worker.selection.model, groupId: worker.selection.groupId, groupName: worker.catalogModel.group_name, title: item.title, mode: item.mode, status: 'queued' }
      run.tasks.set(task.id, task)
      this.publish(root, run, task)
      const job = Promise.all(dependencies).then(async results => {
        if (results.some(result => result.status !== 'completed')) {
          task.status = 'blocked'; task.error = '前置任务未成功'; this.publish(root, run, task)
          return { taskId: task.id, status: task.status, error: task.error }
        }
        for (const result of results) if (result.mergePending) await this.mergeTask(root.sessionId, result.taskId)
        return this.execute(root, run, task, item.instructions, worker)
      }).catch(error => { task.status = 'failed'; task.error = error.message; this.publish(root, run, task); return { taskId: task.id, status: 'failed', error: error.message } })
      jobsByKey.set(item.key, job)
      run.pending.add(job)
      void job.finally(() => run.pending.delete(job)).catch(() => {})
      return job
    }
    const jobs = plans.map(schedule)
    const results = await Promise.all(jobs)
    if (run.controller.signal.aborted) throw stopped()
    return { tasks: results }
  }

  async execute(root, run, task, instructions, worker) {
    let release
    let context
    let child
    try {
      release = await this.slot(root, run)
      if (run.controller.signal.aborted) throw stopped()
      const sessionId = `child-${task.id}`
      context = { token: crypto.randomBytes(32).toString('hex'), sessionId, role: 'child', readOnly: task.mode === 'read', isolated: task.isolated }
      const finished = new Promise(resolve => { child = { root, run, task, context, resolve, turns: 0 } })
      this.children.set(sessionId, child)
      this.contexts.set(context.token, context)
      run.children.add(sessionId)
      const parent = this.sessions.sessions.get(root.sessionId)
      // Hold an execution task's lease across its entire tool sequence so a
      // second worker cannot navigate the shared browser or edit between steps.
      if (task.mode === 'execute' && !task.isolated) await this.leases.acquire(context, '@task', 'execute', run.controller.signal)
      let cwd = parent.cwd
      if (task.isolated) {
        task.workdir = path.join(this.workbench.store.directory, 'isolated', task.id)
        task.base = await this.workbench.snapshots.persist(`${task.id}-base`, await this.workbench.snapshots.isolate(parent.cwd, task.workdir))
        cwd = task.workdir
      }
      if (run.controller.signal.aborted) throw stopped()
      task.startedAt = new Date().toISOString()
      task.status = 'running'
      this.publish(root, run, task)
      await this.sessions.start({
        sessionId, parentSessionId: root.sessionId, accessMode: 'managed', model: worker.selection.model,
        provider: worker.catalogModel.provider, models: [worker.catalogModel], cwd,
        permissionMode: parent.permissionMode, thinkingLevel: worker.selection.thinkingLevel,
        runtimeOptions: { agentRole: 'child', readOnly: context.readOnly, background: true, orchestration: { port: this.port, token: context.token }, systemPrompt: `你是独立的执行子代理，只完成当前分配任务，不再委派。${context.readOnly ? '仅可读取和分析，不得修改文件、运行 shell 或操作共享浏览器。' : '工具权限继承主任务授权，不得扩大授权。'} 汇报实际完成内容、变更文件、验证结果及未解决问题；不能把计划当作已执行结果，不输出内部思维链。结果用简洁文字返回主代理。` },
      })
      if (run.controller.signal.aborted) throw stopped()
      await this.sessions.prompt({ sessionId, message: instructions, thinkingLevel: worker.selection.thinkingLevel })
      await finished
      if (task.isolated) {
        const after = await this.workbench.snapshots.capture(task.workdir)
        task.changes = this.workbench.snapshots.changes(await this.workbench.snapshots.load(task.base), after)
        task.mergePending = task.status === 'completed' && task.changes.length > 0
        this.publish(root, run, task)
      }
    } catch (error) {
      task.status = run.controller.signal.aborted ? 'cancelled' : 'failed'
      task.error = error?.message || String(error)
      task.finishedAt = new Date().toISOString()
      this.publish(root, run, task)
    } finally {
      if (context) {
        const record = this.sessions.sessions.get(context.sessionId)
        if (this.sessions.runs.has(context.sessionId)) await this.sessions.abort({ sessionId: context.sessionId }).catch(() => {})
        if (record?.piSessionPath) await this.retireRuntime(record.piSessionPath)
        this.contexts.delete(context.token)
        this.leases.releaseContext(context)
        this.children.delete(context.sessionId)
        run.children.delete(context.sessionId)
      }
      release?.()
    }
    return { taskId: task.id, title: task.title, model: task.model, status: task.status, summary: task.summary || '', error: task.error || '', mergePending: task.mergePending || false, changes: task.changes?.map(change => ({ path: change.path, kind: change.kind })) || [] }
  }

  storedTask(sessionId, id) {
    const current = this.roots.get(sessionId)?.run?.tasks.get(id)
    if (current) return current
    const record = Object.values(this.workbench?.store.state.tasks || {}).reverse().find(task => task.sessionId === sessionId && task.subtasks?.[id])
    if (!record) throw new Error('子任务不存在')
    this.workbench.task(record.id)
    return record.subtasks[id]
  }

  async mergeTask(sessionId, id) {
    const task = this.storedTask(sessionId, id)
    if (!task.mergePending || task.status !== 'completed' || !task.base) throw new Error('没有可合入的子任务结果')
    const operation = this.mergeQueue.catch(() => {}).then(async () => {
      if (!task.mergePending) throw new Error('结果已合入')
      const result = await this.workbench.snapshots.apply(task.base.cwd, task.changes)
      task.mergePending = false; task.mergedAt = new Date().toISOString()
      const root = this.roots.get(sessionId)
      if (root?.run) this.publish(root, root.run, task)
      await this.workbench.store.save()
      return result
    })
    this.mergeQueue = operation
    return operation
  }

  async retryTask(sessionId, id) {
    const task = this.storedTask(sessionId, id)
    if (!['failed', 'cancelled', 'blocked'].includes(task.status)) throw new Error('只能重试失败的子任务')
    const root = this.roots.get(sessionId)
    if (root?.run) return this.delegate(root.context, [{ workerId: task.workerId, title: task.title, mode: task.mode, instructions: task.instructions, isolate: task.isolated }])
    const owner = Object.values(this.workbench.store.state.tasks).reverse().find(record => record.sessionId === sessionId && record.subtasks?.[id])
    if (!owner) throw new Error('原始任务不存在')
    return this.workbench.options.resume(owner, `Only retry this failed subtask using delegate_tasks with workerId ${task.workerId}, mode ${task.mode}. Do not repeat other completed tasks. Title: ${task.title}\nInstructions: ${task.instructions}\nPrior error: ${task.error || ''}`)
  }

  async handle(req, res) {
    const respond = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) } }
    const context = this.contexts.get(String(req.headers['x-anyu-agent-token'] || ''))
    if (req.method !== 'POST' || !context) { respond(403, { error: 'Invalid agent context' }); return }
    try {
      let bytes = 0
      const chunks = []
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new Error('请求过大'); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (this.contexts.get(context.token) !== context) throw stopped()
      const child = this.children.get(context.sessionId)
      const run = child?.run || this.roots.get(context.sessionId)?.run
      if (!run || run.controller.signal.aborted) throw stopped()
      let result
      if (req.url === '/delegate') {
        if (context.role !== 'parent' || typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 200) throw new Error('委派标识无效')
        const previous = run.delegations.get(body.requestId)
        const signature = JSON.stringify(body.tasks)
        if (previous && previous.signature !== signature) throw new Error('相同委派标识不能提交不同任务')
        const job = previous?.job || this.delegate(context, body.tasks)
        if (!previous) run.delegations.set(body.requestId, { signature, job })
        result = await job
      }
      else if (req.url === '/merge' || req.url === '/retry') {
        if (context.role !== 'parent') throw new Error('仅主代理可以操作子任务结果')
        result = req.url === '/merge' ? await this.mergeTask(context.sessionId, body.taskId) : await this.retryTask(context.sessionId, body.taskId)
      }
      else if (req.url === '/acquire' || req.url === '/release') {
        if (typeof body.toolCallId !== 'string' || !body.toolCallId || body.toolCallId.length > 200) throw new Error('工具标识无效')
        if (req.url === '/release') result = this.leases.release(context, body.toolCallId)
        else {
          if (context.readOnly && !READ_TOOLS.has(body.toolName)) throw new Error('该子代理仅允许只读工具')
          result = context.isolated && !String(body.toolName).startsWith('browser_') && !['mcp_call', 'bash'].includes(body.toolName)
            ? { ok: true } : await this.leases.acquire(context, body.toolCallId, body.toolName, run.controller.signal)
        }
      } else throw new Error('未知操作')
      respond(200, result)
    } catch (error) { respond(400, { error: error?.message || String(error) }) }
  }

  async close() {
    await Promise.allSettled([...this.roots.keys()].map(sessionId => this.abort({ sessionId })))
    this.contexts.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }

  snapshot(payload) {
    const snapshot = this.sessions.snapshot(payload)
    const approvals = []
    for (const [sessionId, pending] of this.sessions.approvals) {
      const parent = this.sessions.sessions.get(sessionId)?.parentSessionId
      if (sessionId === payload.sessionId || parent === payload.sessionId) {
        const task = this.children.get(sessionId)?.task
        approvals.push({ ...pending.request, sessionId, ...(task ? { title: `${task.title}: ${pending.request.title}` } : {}) })
      }
    }
    return { ...snapshot, approvals }
  }
}

module.exports = { AgentOrchestrator, ToolLeases, resolveConfig }
