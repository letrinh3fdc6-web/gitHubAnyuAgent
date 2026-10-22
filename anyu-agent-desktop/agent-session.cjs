'use strict'

// Agent session layer: one stable session id per conversation, normalized
// event stream, append-only event log and first-class approvals.
//
// The pi runtime stays an implementation detail. Renderers consume AgentEvent
// v1 only, so the local runtime can later be swapped or mirrored by a remote
// runtime without touching the UI.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const EVENT_VERSION = 1
const MAX_LOG_BYTES = 0
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const ABORT_GRACE_MS = 5000
const MAX_RECENT_EVENTS = 600
const SNAPSHOT_PAGE_SIZE = 200
const SNAPSHOT_TAIL_START_BYTES = 4 * 1024 * 1024
const SNAPSHOT_TAIL_MAX_BYTES = 64 * 1024 * 1024

function nowIso() {
  return new Date().toISOString()
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text
      if (typeof content.value === 'string') return content.value
      if (content.content !== undefined) return textOfContent(content.content)
    }
    return ''
  }
  return content.map((item) => textOfContent(item)).join('')
}

function deltaOf(event) {
  const update = event.assistantMessageEvent || event.messageEvent || event.delta || event.update
  if (typeof update === 'string') return { kind: 'text', delta: update }
  if (!update || typeof update !== 'object') return { kind: 'none', delta: '' }
  const type = String(update.type || '')
  // Tool-call argument deltas are partial JSON, not assistant prose. Forwarding
  // them would leak {"path":...} into the visible answer.
  if (type.includes('tool') || type.includes('function_call') || type.includes('arguments')) {
    return { kind: 'none', delta: '' }
  }
  if (type === 'thinking_delta' || type === 'thinking') {
    return { kind: 'thinking', delta: String(update.delta || update.text || update.thinking || '') }
  }
  if (type && type !== 'text' && type !== 'text_delta' && type !== 'content_block_delta') {
    return { kind: 'none', delta: '' }
  }
  if (typeof update.delta === 'string') return { kind: 'text', delta: update.delta }
  if (typeof update.text === 'string') return { kind: 'text', delta: update.text }
  return { kind: 'none', delta: '' }
}

function toolOutputOf(event) {
  const result = event.partialResult || event.result
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    if (typeof result.output === 'string') return result.output
    if (result.content !== undefined) return textOfContent(result.content)
  }
  return ''
}

function safeSessionId(value) {
  const id = String(value || '').trim()
  if (!id || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('会话标识无效')
  return id
}

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32)
}

class AgentSessionService {
  constructor(options = {}) {
    this.userDataDir = String(options.userDataDir || '')
    if (!this.userDataDir) throw new Error('AgentSessionService requires userDataDir')
    this.startRuntime = options.startRuntime
    this.sendCommand = options.sendCommand
    this.configureThinking = options.configureThinking
    this.respondUi = options.respondUi
    this.stopRuntime = options.stopRuntime
    this.resolveRuntime = options.resolveRuntime
    this.broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => {}
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.root = path.join(this.userDataDir, 'agent-sessions')
    this.logsDir = path.join(this.root, 'logs')
    this.indexFile = path.join(this.root, 'index.json')
    this.sessions = new Map()
    this.runs = new Map()
    this.approvals = new Map()
    this.recent = new Map()
    this.seq = Date.now()
    this.loadIndex()
  }

  // ---------------------------------------------------------------- persistence

  loadIndex() {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true })
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      for (const record of Object.values(raw?.sessions || {})) {
        if (!record || typeof record !== 'object' || !record.sessionId) continue
        this.sessions.set(String(record.sessionId), { ...record, models: Array.isArray(record.models) ? record.models : [] })
      }
    } catch {
      // First run or a corrupt index must not block the app.
    }
  }

  persist() {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      const sessions = {}
      for (const record of this.sessions.values()) {
        sessions[record.sessionId] = {
          sessionId: record.sessionId,
          piSessionPath: record.piSessionPath || '',
          cwd: record.cwd || '',
          model: record.model || '',
          provider: record.provider || '',
          permissionMode: record.permissionMode || '',
          title: record.title || '',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          lastStatus: record.lastStatus || '',
        }
      }
      const temporary = `${this.indexFile}.${process.pid}.tmp`
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions }, null, 2), { mode: 0o600 })
      fs.renameSync(temporary, this.indexFile)
    } catch (error) {
      this.log('persist failed:', error?.message || error)
    }
  }

  logFile(sessionId) {
    return path.join(this.logsDir, `${hashId(sessionId)}.jsonl`)
  }

  appendLog(sessionId, record) {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true })
      const file = this.logFile(sessionId)
      try {
        if (MAX_LOG_BYTES > 0 && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
      } catch {
        // No existing log yet.
      }
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    } catch (error) {
      this.log('append log failed:', error?.message || error)
    }
  }

  // ---------------------------------------------------------------- event bus

  nextSeq() {
    this.seq = Math.max(this.seq + 1, Date.now())
    return this.seq
  }

  emit(sessionId, event) {
    const run = this.runs.get(sessionId)
    const payload = {
      v: EVENT_VERSION,
      seq: this.nextSeq(),
      at: nowIso(),
      sessionId,
      ...(run?.runId ? { runId: run.runId } : {}),
      ...event,
    }
    const bucket = this.recent.get(sessionId) || []
    bucket.push(payload)
    if (bucket.length > MAX_RECENT_EVENTS) bucket.splice(0, bucket.length - MAX_RECENT_EVENTS)
    this.recent.set(sessionId, bucket)
    this.appendLog(sessionId, { seq: payload.seq, at: payload.at, event: payload })
    try {
      this.broadcast('agent:event', { sessionId, event: payload })
    } catch (error) {
      this.log('broadcast failed:', error?.message || error)
    }
    return payload
  }

  // ---------------------------------------------------------------- session API

  async start(payload = {}) {
    const sessionId = safeSessionId(payload.sessionId || payload.conversationId)
    const record = this.sessions.get(sessionId) || {
      sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    const model = String(payload.model || record.model || '')
    const provider = String(payload.provider || record.provider || '')
    const models = Array.isArray(payload.models) ? payload.models : record.models || []
    const permissionMode = String(payload.permissionMode || record.permissionMode || '')
    const cwd = String(payload.cwd || record.cwd || '')
    const modelChanged = Boolean(record.model && model && record.model !== model)
    const permissionChanged = Boolean(record.permissionMode && permissionMode && record.permissionMode !== permissionMode)
    const cwdChanged = Boolean(record.cwd && cwd && path.resolve(record.cwd) !== path.resolve(cwd))

    const started = await this.startRuntime({
      accessMode: payload.accessMode || 'managed',
      model,
      provider,
      models,
      sessionPath: record.piSessionPath || undefined,
      cwd: cwd || undefined,
      permissionMode: permissionMode || undefined,
      thinkingLevel: payload.thinkingLevel || 'auto',
      force: Boolean(modelChanged || permissionChanged || cwdChanged || payload.force),
    })

    record.piSessionPath = String(started?.sessionPath || record.piSessionPath || '')
    record.cwd = String(started?.cwd || cwd || '')
    record.permissionMode = String(started?.permissionMode || permissionMode || '')
    record.model = model
    record.provider = provider
    record.models = models
    record.updatedAt = nowIso()
    record.lastStatus = record.lastStatus || 'ready'
    this.sessions.set(sessionId, record)
    this.persist()

    this.emit(sessionId, {
      type: 'session.ready',
      sessionPath: record.piSessionPath,
      cwd: record.cwd,
      model: record.model,
      permissionMode: record.permissionMode,
      reused: Boolean(started?.reused),
    })
    return {
      ok: true,
      sessionId,
      sessionPath: record.piSessionPath,
      cwd: record.cwd,
      permissionMode: record.permissionMode,
      reused: Boolean(started?.reused),
    }
  }

  async prompt(payload = {}) {
    const sessionId = safeSessionId(payload.sessionId || payload.conversationId)
    const record = this.sessions.get(sessionId)
    if (!record) throw new Error('Agent 会话尚未初始化')
    const message = String(payload.message || '')
    if (!message.trim() && !Array.isArray(payload.images)) throw new Error('消息不能为空')
    if (this.runs.get(sessionId)) throw new Error('当前会话仍在运行，请等待或先停止当前任务')

    let runtime = this.resolveRuntime?.(record.piSessionPath) || null
    if (!runtime) {
      await this.start({ ...record, sessionId, cwd: record.cwd, models: record.models || [] })
      runtime = this.resolveRuntime?.(record.piSessionPath) || null
    }
    if (!runtime) throw new Error('Agent 运行时未启动')
    if (this.runs.get(sessionId)) throw new Error('当前会话仍在运行，请等待或先停止当前任务')

    const run = {
      runId: crypto.randomUUID(),
      sessionId,
      input: message,
      images: Array.isArray(payload.images) ? payload.images : [],
      status: 'running',
      text: '',
      thinking: '',
      error: '',
      startedAt: nowIso(),
    }
    run.settled = new Promise((resolve) => { run.resolveSettled = resolve })
    this.runs.set(sessionId, run)
    record.updatedAt = nowIso()
    record.lastStatus = 'running'
    this.persist()
    this.emit(sessionId, { type: 'run.started', input: message })

    try {
      await this.configureThinking?.(runtime, payload.thinkingLevel || 'auto')
      if (this.runs.get(sessionId) !== run || run.aborting) throw new Error('当前任务已取消')
      await this.sendCommand({ type: 'prompt', sessionKey: record.piSessionPath, message, ...(run.images.length ? { images: run.images } : {}) }, runtime)
    } catch (error) {
      if (this.runs.get(sessionId) === run) this.finishRun(sessionId, { status: run.aborting ? 'cancelled' : 'failed', error: error?.message || String(error) })
      throw error
    }
    return { ok: true, sessionId, runId: run.runId }
  }

  async abort(payload = {}) {
    const sessionId = safeSessionId(payload.sessionId || payload.conversationId)
    const record = this.sessions.get(sessionId)
    if (!record) return { ok: false }
    const runtime = this.resolveRuntime?.(record.piSessionPath) || null
    if (!runtime) return { ok: false }
    const run = this.runs.get(sessionId)
    if (run?.abortPromise) return run.abortPromise
    if (run) {
      run.aborting = true
      this.emit(sessionId, { type: 'run.aborting' })
    }
    const stopping = (async () => {
      let timer
      try {
        await Promise.race([
          Promise.all([this.sendCommand({ type: 'abort', sessionKey: record.piSessionPath }, runtime), run?.settled]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Agent 停止超时')), ABORT_GRACE_MS) }),
        ])
      } catch (error) {
        if (!this.stopRuntime) throw error
        // Escalate only this session if its runtime does not acknowledge stop.
        await this.stopRuntime(runtime)
        if (run && this.runs.get(sessionId) === run) this.finishRun(sessionId, { status: 'cancelled' })
      } finally {
        clearTimeout(timer)
      }
      return { ok: true }
    })()
    if (run) run.abortPromise = stopping
    return stopping
  }

  async approve(payload = {}) {
    const sessionId = safeSessionId(payload.sessionId || payload.conversationId)
    const requestId = String(payload.requestId || payload.id || '')
    const pending = this.approvals.get(sessionId)
    if (!pending || pending.request.requestId !== requestId) return { ok: false }
    const decision = String(payload.decision || 'deny')
    const value = payload.value
    const record = this.sessions.get(sessionId)
    const runtime = record ? this.resolveRuntime?.(record.piSessionPath) : null
    if (!runtime) {
      this.settleApproval(sessionId, 'failed', new Error('Agent 运行时已停止'))
      return { ok: false }
    }
    const request = pending.request
    const response = { type: 'extension_ui_response', id: request.requestId, sessionKey: record.piSessionPath }
    if (request.method === 'confirm') response.confirmed = decision === 'allow'
    else if (request.method === 'select') response.selected = value ?? request.options?.[0]?.value ?? request.options?.[0]
    else response.value = value ?? payload.text ?? ''
    try {
      await this.respondUi(response, runtime)
    } catch (error) {
      this.log('approval response failed:', error?.message || error)
    }
    this.settleApproval(sessionId, 'resolved', null, { decision, value })
    return { ok: true }
  }

  settleApproval(sessionId, status, error, detail = {}) {
    const pending = this.approvals.get(sessionId)
    if (!pending) return
    this.approvals.delete(sessionId)
    if (pending.timer) clearTimeout(pending.timer)
    if (status === 'failed') pending.reject(error)
    else pending.resolve(detail)
    this.emit(sessionId, {
      type: 'approval.resolved',
      requestId: pending.request.requestId,
      decision: detail.decision || (status === 'timeout' ? 'timeout' : 'deny'),
      ...(error ? { error: error?.message || String(error) } : {}),
    })
  }

  requestApproval(sessionId, request, timeoutMs = APPROVAL_TIMEOUT_MS) {
    const existing = this.approvals.get(sessionId)
    if (existing) {
      // A second prompt before the first is answered must not deadlock pi.
      this.settleApproval(sessionId, 'resolved', null, { decision: 'deny' })
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleApproval(sessionId, 'timeout')
        const record = this.sessions.get(sessionId)
        const runtime = record ? this.resolveRuntime?.(record.piSessionPath) : null
        if (runtime) {
          const response = { type: 'extension_ui_response', id: request.requestId, sessionKey: record.piSessionPath }
          if (request.method === 'confirm') response.confirmed = false
          else response.value = ''
          this.respondUi(response, runtime).catch(() => {})
        }
      }, timeoutMs)
      if (timer.unref) timer.unref()
      this.approvals.set(sessionId, { request, resolve, reject, timer })
      this.emit(sessionId, { type: 'approval.requested', request })
    })
  }

  runtimeExited(piSessionPath, code) {
    const record = this.findByPath(piSessionPath)
    if (!record) return
    const run = this.runs.get(record.sessionId)
    if (run) {
      run.error = `Agent 进程已退出 (${code ?? 'unknown'})`
      this.finishRun(record.sessionId, { status: run.aborting ? 'cancelled' : 'failed', error: run.aborting ? '' : run.error })
    }
    this.settleApproval(record.sessionId, 'failed', new Error('Agent 进程已退出'))
    this.emit(record.sessionId, { type: 'session.exited', code: code ?? null })
  }

  // ---------------------------------------------------------------- ingest pi events

  ingest(piSessionPath, event) {
    if (!event || typeof event !== 'object' || event.type === 'response') return
    const record = this.findByPath(piSessionPath)
    if (!record) return
    const sessionId = record.sessionId
    const run = this.runs.get(sessionId)

    if (event.type === 'message_start') {
      const message = event.message || event.assistantMessage
      if (message?.role === 'assistant') {
        if (run) { run.text = ''; run.thinking = ''; run.error = '' }
        this.emit(sessionId, { type: 'message.started', messageId: message?.id || message?.messageId || null })
      }
      return
    }

    if (event.type === 'message_update') {
      const { kind, delta } = deltaOf(event)
      if (!delta) return
      if (kind === 'thinking') {
        if (run) run.thinking += delta
        this.emit(sessionId, { type: 'thinking.delta', delta })
      } else {
        if (run) run.text += delta
        this.emit(sessionId, { type: 'message.delta', delta })
      }
      return
    }

    if (event.type === 'message_end') {
      const message = event.message
      if (message?.role !== 'assistant') return
      const content = textOfContent(message.content) || run?.text || ''
      const error = message.errorMessage || (message.stopReason === 'error' ? '模型请求失败，请稍后重试' : '')
      if (run && content) run.text = content
      if (run) run.error = String(error)
      this.emit(sessionId, {
        type: 'message.completed',
        content,
        errorMessage: String(error),
        stopReason: message.stopReason || '',
      })
      return
    }

    if (event.type === 'tool_execution_start') {
      this.emit(sessionId, {
        type: 'tool.started',
        toolCallId: event.toolCallId || event.id || '',
        toolName: event.toolName || '',
        args: event.args || {},
      })
      return
    }

    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      this.emit(sessionId, {
        type: event.type === 'tool_execution_end' ? 'tool.completed' : 'tool.updated',
        toolCallId: event.toolCallId || event.id || '',
        toolName: event.toolName || '',
        args: event.args || {},
        output: toolOutputOf(event),
        isError: Boolean(event.isError),
      })
      return
    }

    if (event.type === 'extension_ui_request') {
      this.handleUiRequest(sessionId, record, event)
      return
    }

    if (event.type === 'auto_retry_start') {
      this.emit(sessionId, { type: 'run.retrying', attempt: event.attempt || 1, maxAttempts: event.maxAttempts || 3 })
      return
    }

    if (event.type === 'auto_retry_end') {
      if (run && event.success === false && event.finalError) run.error = String(event.finalError)
      return
    }

    if (event.type === 'agent_start' || event.type === 'turn_start') {
      this.emit(sessionId, { type: 'run.active' })
      return
    }

    if (event.type === 'agent_end') {
      if (event.willRetry) {
        this.emit(sessionId, { type: 'run.retrying', attempt: event.attempt || 1, maxAttempts: event.maxAttempts || 3 })
        return
      }
      const error = event.error || event.errorMessage
      if (run && error) run.error = String(error)
      this.emit(sessionId, { type: 'run.turn_end', willRetry: Boolean(event.willRetry), error: error ? String(error) : '' })
      return
    }

    if (event.type === 'agent_settled') {
      const error = event.error || event.errorMessage
      if (run && error) run.error = String(error)
      this.finishRun(sessionId, { status: run?.aborting ? 'cancelled' : run?.error ? 'failed' : 'completed', error: run?.aborting ? '' : run?.error || '' })
      return
    }

    if (event.type === 'session_info_changed') {
      this.emit(sessionId, { type: 'session.info', name: event.name || event.sessionName || '' })
    }
  }

  handleUiRequest(sessionId, record, event) {
    const request = {
      requestId: String(event.id || ''),
      method: String(event.method || 'confirm'),
      title: String(event.title || event.message || '需要确认'),
      message: String(event.message || ''),
      options: Array.isArray(event.options) ? event.options : undefined,
      placeholder: event.placeholder || '',
      defaultValue: event.defaultValue ?? '',
      createdAt: nowIso(),
    }
    if (request.method === 'confirm' && record.permissionMode === 'full') {
      const runtime = this.resolveRuntime?.(record.piSessionPath)
      if (runtime) {
        this.respondUi({ type: 'extension_ui_response', id: request.requestId, confirmed: true, sessionKey: record.piSessionPath }, runtime).catch(() => {})
      }
      this.emit(sessionId, { type: 'approval.auto', request })
      return
    }
    this.requestApproval(sessionId, request).catch(() => {})
  }

  finishRun(sessionId, { status, error = '' } = {}) {
    const run = this.runs.get(sessionId)
    if (!run) return
    this.runs.delete(sessionId)
    const record = this.sessions.get(sessionId)
    if (record) {
      record.lastStatus = status
      record.updatedAt = nowIso()
      this.persist()
    }
    this.emit(sessionId, {
      type: 'run.finished',
      runId: run.runId,
      status,
      error,
      text: run.text,
      thinking: run.thinking,
      durationMs: Math.max(0, Date.now() - Date.parse(run.startedAt)),
    })
    this.settleApproval(sessionId, 'failed', new Error('本轮已结束'))
    run.resolveSettled?.()
  }

  // ---------------------------------------------------------------- queries

  findByPath(piSessionPath) {
    const target = String(piSessionPath || '')
    if (!target) return null
    for (const record of this.sessions.values()) {
      if (record.piSessionPath && path.resolve(record.piSessionPath) === path.resolve(target)) return record
    }
    return null
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map((record) => ({
        sessionId: record.sessionId,
        piSessionPath: record.piSessionPath || '',
        cwd: record.cwd || '',
        model: record.model || '',
        permissionMode: record.permissionMode || '',
        title: record.title || '',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastStatus: record.lastStatus || '',
        running: Boolean(this.runs.get(record.sessionId)),
      }))
  }

  history(payload = {}) {
    const sessionId = safeSessionId(payload.sessionId || payload.conversationId)
    const afterSeq = Number(payload.afterSeq || 0)
    const file = this.logFile(sessionId)
    const events = []
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line)
          if (record?.event && Number(record.seq) > afterSeq) events.push(record.event)
        } catch {
          // Skip a torn line from a crash.
        }
      }
    } catch {
      // No log yet.
    }
    return { events: events.slice(-2000), nextSeq: events.length ? events[events.length - 1].seq : afterSeq }
  }

  readLogRecords(sessionId, { tailBytes = 0, beforeSeq = 0 } = {}) {
    const file = this.logFile(sessionId)
    const archive = `${file}.1`
    let size = 0
    try { size = fs.statSync(file).size } catch { return { records: [], truncated: false, size: 0, maxSeq: 0, archiveExists: fs.existsSync(archive) } }
    const parse = (text, truncated) => {
      const records = []
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line)
          if (!record?.event) continue
          const seq = Number(record.seq || record.event.seq || 0)
          if (beforeSeq > 0 && seq >= beforeSeq) continue
          records.push({ ...record, seq })
        } catch {
          // Skip a torn line from a crash.
        }
      }
      return {
        records,
        truncated,
        size,
        maxSeq: records.length ? records[records.length - 1].seq : 0,
        archiveExists: fs.existsSync(archive),
      }
    }
    if (tailBytes <= 0 || tailBytes >= size) {
      try {
        const texts = []
        if (fs.existsSync(archive)) texts.push(fs.readFileSync(archive, 'utf8'))
        texts.push(fs.readFileSync(file, 'utf8'))
        return parse(texts.join('\n'), false)
      } catch { return { records: [], truncated: false, size, maxSeq: 0, archiveExists: fs.existsSync(archive) } }
    }
    let bytes = Math.max(1024, tailBytes)
    while (true) {
      const start = Math.max(0, size - bytes)
      const length = size - start
      const buffer = Buffer.alloc(length)
      const fd = fs.openSync(file, 'r')
      try { fs.readSync(fd, buffer, 0, length, start) } finally { fs.closeSync(fd) }
      let text = buffer.toString('utf8')
      // The first line of a tail read is usually incomplete; drop it.
      if (start > 0) {
        const newline = text.indexOf('\n')
        text = newline >= 0 ? text.slice(newline + 1) : ''
      }
      const result = parse(text, start > 0)
      if (result.records.length || start === 0 || bytes >= size) return result
      bytes = Math.min(size, bytes * 2)
    }
  }

  buildSnapshotMessages(records, sessionId = '') {
    const messages = []
    const activities = new Map()
    let current = null
    let started = false
    for (const record of records) {
      const event = record.event
      if (!event) continue
      if (event.type === 'run.started') {
        started = true
        const runId = String(event.runId || `run-${event.seq}`)
        const seq = Number(record.seq || event.seq || 0)
        current = {
          id: `${runId}-assistant`,
          runId,
          role: 'assistant',
          content: '',
          activities: [],
          createdAt: event.at,
          isStreaming: true,
          seq,
        }
        messages.push({ id: `${runId}-user`, runId, role: 'user', content: String(event.input || ''), createdAt: event.at, seq })
      } else if (!started || !current) {
        continue
      } else if (event.type === 'message.started') {
        current.content = ''
        current.isError = false
        delete current.error
        current.isStreaming = true
      } else if (event.type === 'run.retrying') {
        current.isStreaming = true
      } else if (event.type === 'message.delta') {
        current.content += event.delta
      } else if (event.type === 'message.completed' && event.content) {
        current.content = event.content
      } else if (event.type === 'tool.started') {
        const activity = { id: event.toolCallId || `${event.seq}`, kind: 'tool', name: event.toolName, status: 'running', input: event.args, startedAt: event.at }
        activities.set(activity.id, activity)
        current.activities.push(activity)
      } else if (event.type === 'tool.completed') {
        const activity = activities.get(event.toolCallId)
        if (activity) {
          activity.status = event.isError ? 'failed' : 'completed'
          activity.output = event.output
          activity.finishedAt = event.at
        }
      } else if (event.type === 'run.finished') {
        current.isStreaming = false
        current.isError = event.status === 'failed'
        if (event.error) current.error = event.error
        if (event.text) current.content = event.text
        if (current.isError && !current.content) current.content = event.error || 'Agent 运行失败'
        messages.push(current)
        current = null
      }
    }
    if (current) {
      current.isStreaming = Boolean(this.runs.get(sessionId))
      messages.push(current)
    }
    return messages.filter((message) => message.role === 'user' || message.content || message.activities?.length)
  }

  snapshot(payload = {}) {
    const sessionId = safeSessionId(payload.sessionId || payload.conversationId)
    const limit = Math.min(1000, Math.max(20, Number(payload.limit) || SNAPSHOT_PAGE_SIZE))
    const beforeSeq = Number(payload.beforeSeq || 0)
    let records = []
    let truncated = false
    let archiveExists = false
    let maxSeq = 0
    if (beforeSeq > 0) {
      const data = this.readLogRecords(sessionId, { beforeSeq })
      records = data.records
      maxSeq = data.maxSeq
    } else {
      let bytes = SNAPSHOT_TAIL_START_BYTES
      while (true) {
        const data = this.readLogRecords(sessionId, { tailBytes: bytes })
        records = data.records
        truncated = data.truncated
        archiveExists = Boolean(data.archiveExists && data.truncated)
        maxSeq = data.maxSeq
        const built = this.buildSnapshotMessages(records, sessionId)
        if (!truncated || built.length >= limit * 2 || !data.size || bytes >= data.size || bytes >= SNAPSHOT_TAIL_MAX_BYTES) break
        bytes = Math.min(data.size, Math.max(bytes * 2, SNAPSHOT_TAIL_START_BYTES))
      }
    }
    const built = this.buildSnapshotMessages(records, sessionId)
    let start = Math.max(0, built.length - limit * 2)
    while (start < built.length && built[start].role !== 'user') start += 1
    const window = built.slice(start)
    const oldestSeq = window.length ? Number(window[0].seq || 0) : 0
    const hasMore = beforeSeq > 0 ? start > 0 : (start > 0 || truncated || archiveExists)
    return {
      messages: window.map(({ seq, ...message }) => message),
      nextSeq: maxSeq || (window.length ? oldestSeq : 0),
      hasMore,
      oldestSeq,
    }
  }

  stopAll() {
    for (const sessionId of [...this.approvals.keys()]) this.settleApproval(sessionId, 'failed', new Error('会话已停止'))
    for (const run of this.runs.values()) run.aborting = true
  }
}

module.exports = { AgentSessionService, EVENT_VERSION }
