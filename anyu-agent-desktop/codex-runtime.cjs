'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { CodexClient } = require('./codex-client.cjs')
const { CodexProviderBridge } = require('./codex-provider.cjs')
const { CodexTools } = require('./codex-tools.cjs')

function runtimeConfig(model, bridge, policy) {
  return {
    model: model.id, model_provider: 'anyu',
    'model_providers.anyu': { name: 'AnyuAgent', base_url: bridge.origin, wire_api: 'responses', env_key: 'ANYU_CODEX_LOCAL_KEY', request_max_retries: 2, stream_max_retries: 2, stream_idle_timeout_ms: 300000, supports_websockets: false },
    model_context_window: policy.contextWindow,
    model_auto_compact_token_limit: policy.native?.enabled === false ? Number.MAX_SAFE_INTEGER : policy.triggerTokens,
    approval_policy: 'on-request', sandbox_mode: 'read-only', web_search: 'disabled',
    'features.shell_tool': false, 'features.apply_patch_freeform': false,
    'features.view_image': false, 'features.js_repl': false, 'features.code_mode': false,
    'code_mode.enabled': false, 'code_mode_host.enabled': false, 'features.code_mode_only': false,
    'features.tool_search': false, 'features.incremental_tools': false,
    'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.goals': false,
    'agents.enabled': false,
    'features.apps': false, 'features.plugins': false, 'features.image_generation': false,
    'features.browser_use': false, 'features.computer_use': false,
    'features.responses_websockets': false, 'features.responses_websockets_v2': false,
  }
}

class CodexRuntime {
  constructor(options, emit) {
    this.options = options
    this.emit = emit
    this.turn = null
    this.controller = null
    this.pendingUi = new Map()
    this.uiTail = Promise.resolve()
    this.thinking = options.thinkingLevel || 'auto'
    this.usage = null
    this.closed = false
    this.lastText = ''
    this.activeMessages = new Map()
    this.currentMessage = null
    this.endedMessages = new Set()
  }
  async initialize() {
    const options = this.options
    this.tools = await new CodexTools({ ...options, ask: (request, signal) => this.ask(request, signal), emit: event => this.emit(event) }).initialize()
    this.bridge = await new CodexProviderBridge({ model: options.model, credential: options.credential, conversationOnly: options.conversationOnly, getThinking: () => this.thinking, onModelRequest: () => {
      if (!this.compaction) this.emit({ type: 'turn_start' })
    }, onProviderActivity: type => {
      if (!this.compaction) this.emit({ type: 'message_update', assistantMessageEvent: { type } })
    } }).start()
    // Provider catalog entries declare tools supported by this host. Preserve
    // the exact upstream model id without inheriting app-specific tool modes.
    fs.mkdirSync(options.home, { recursive: true })
    const catalog = path.join(options.home, 'anyu-model-catalog.json')
    fs.writeFileSync(catalog, JSON.stringify({ models: [{
      slug: options.model.id, display_name: options.model.name || options.model.id, description: 'AnyuAgent selected model',
      default_reasoning_level: 'medium', supported_reasoning_levels: (options.model.thinkingLevels || ['low', 'medium', 'high']).filter(level => level !== 'off').map(effort => ({ effort, description: effort })),
      shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0,
      base_instructions: 'You are AnyuAgent. Complete the user task using the host-provided tools and respect host approval decisions.',
      supports_reasoning_summaries: true, support_verbosity: false, default_reasoning_summary: 'none',
      apply_patch_tool_type: null, context_window: options.contextPolicy.contextWindow,
      effective_context_window_percent: 100, truncation_policy: { mode: 'tokens', limit: 10000 },
      input_modalities: options.model.input || ['text'], experimental_supported_tools: [],
      tool_mode: 'default', use_responses_lite: false,
    }] }), { mode: 0o600 })
    this.client = new CodexClient({ home: options.home, cwd: options.cwd, config: { ...runtimeConfig(options.model, this.bridge, options.contextPolicy), model_catalog_json: catalog }, env: { ANYU_CODEX_LOCAL_KEY: this.bridge.token } })
    this.client.on('notification', message => this.notification(message))
    this.client.on('request', message => { void this.serverRequest(message) })
    this.client.on('disconnect', error => {
      if (!this.closed && (this.turn || this.starting || this.compaction)) this.finish(error.message)
    })
    await this.client.initialize()
    const base = { model: options.model.id, modelProvider: 'anyu', cwd: options.cwd, approvalPolicy: 'on-request', sandbox: 'read-only', developerInstructions: [
      'You are AnyuAgent. Use the provided host tools for files, commands, browser, MCP and delegation. Tools enforce the user permission mode and project rules. Use browser_open to open the built-in browser. Use runtime_probe for dependency diagnostics. Report real progress briefly during multi-step work. Tool failure is evidence to diagnose, never claim it succeeded. Preserve user changes and verify completed work.',
      'The internal read-only sandbox applies to disabled native tools. The available host tools can perform authorized work, including edits and commands, subject to their actual approval results. Do not infer that all host tools are read-only.',
      options.systemPrompt || '', this.tools.skillPrompt || '',
    ].filter(Boolean).join('\n\n') }
    if (options.conversationOnly) base.developerInstructions = `You are in a conversation-only desktop companion session. Reply naturally in text; no tools are available.\n\n${options.systemPrompt || ''}`
    let saved
    try { saved = JSON.parse(fs.readFileSync(options.sessionPath, 'utf8').trim()) } catch (error) { if (error.code !== 'ENOENT') throw error }
    let result
    if (saved?.threadId) result = await this.client.request('thread/resume', { ...base, threadId: saved.threadId })
    else if (saved?.forkThreadId) result = await this.client.request('thread/fork', { ...base, threadId: saved.forkThreadId })
    else result = await this.client.request('thread/start', { ...base, dynamicTools: this.tools.specs(), allowProviderModelFallback: false })
    this.threadId = result.thread.id
    fs.mkdirSync(path.dirname(options.sessionPath), { recursive: true })
    const temporary = `${options.sessionPath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ type: 'session', engine: 'codex', version: 1, threadId: this.threadId, home: options.home, cwd: options.cwd, timestamp: saved?.timestamp || new Date().toISOString() }) + '\n', { mode: 0o600 })
    fs.renameSync(temporary, options.sessionPath)
    return this.state()
  }
  state() {
    return { sessionFile: this.options.sessionPath, model: this.options.model, thinkingLevel: this.thinking, isStreaming: Boolean(this.turn || this.starting), engine: 'codex-app-server', threadId: this.threadId }
  }
  async command(command) {
    switch (command.type) {
      case 'get_state': return this.state()
      case 'set_thinking_level': this.thinking = command.level || command.thinkingLevel || 'auto'; return { thinkingLevel: this.thinking }
      case 'get_session_stats': {
        const tokens = this.usage?.last?.totalTokens ?? null
        return { contextUsage: { tokens, contextWindow: this.options.contextPolicy.contextWindow, percent: tokens === null ? null : tokens / this.options.contextPolicy.contextWindow * 100 }, tokenUsage: this.usage }
      }
      case 'prompt': {
        if (this.turn || this.starting || this.compaction) throw new Error('This session is still running')
        this.controller = new AbortController(); this.starting = true; this.lastText = ''; this.activeMessages.clear(); this.endedMessages.clear(); this.currentMessage = null; this.turnUsage = {}
        const input = [{ type: 'text', text: command.message || '', text_elements: [] }, ...(command.images || []).map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` }))]
        this.emit({ type: 'agent_start' })
        try {
          const result = await this.client.request('turn/start', { threadId: this.threadId, input, ...(this.thinking !== 'auto' ? { effort: this.thinking === 'off' ? 'none' : this.thinking } : {}) })
          // turn/completed can arrive in the same stdout chunk as the RPC reply.
          if (this.starting) this.turn = result.turn.id
          this.starting = false
          if (this.controller.signal.aborted && this.turn) await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turn })
          return { accepted: true }
        } catch (error) { this.starting = false; this.finish(error.message); throw error }
      }
      case 'steer':
        if (!this.turn) throw new Error('No active turn to steer')
        return this.client.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turn, input: [{ type: 'text', text: command.message, text_elements: [] }] })
      case 'abort':
        this.controller?.abort()
        for (const ui of this.pendingUi.values()) ui.resolve(false)
        this.pendingUi.clear()
        if (this.turn) await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turn }).catch(error => { if (!/no active turn/i.test(error.message)) throw error })
        return { ok: true }
      case 'compact': {
        if (this.turn || this.compaction) throw new Error('Session is busy')
        const tokensBefore = this.usage?.last?.totalTokens
        this.emit({ type: 'compaction_start', reason: 'manual' })
        const result = new Promise((resolve, reject) => { this.compaction = { resolve, reject, tokensBefore } })
        try { await this.client.request('thread/compact/start', { threadId: this.threadId }) }
        catch (error) { this.finish(error.message) }
        return result
      }
      case 'clear_queue': return { ok: true }
      case 'get_available_thinking_levels': return { levels: this.options.model.thinkingLevels || ['off'] }
      case 'set_session_name': return this.client.request('thread/name/set', { threadId: this.threadId, name: command.name })
      default: throw new Error(`Unsupported App Server command: ${command.type}`)
    }
  }
  notification({ method, params = {} }) {
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return
    if (params.turnId && this.turn && params.turnId !== this.turn) return
    if (method === 'turn/started') this.turn = params.turn.id
    else if (method === 'thread/tokenUsage/updated') {
      if (this.turn || this.starting) {
        for (const [key, value] of Object.entries(params.tokenUsage.total || {})) {
          const delta = this.usage?.total ? Math.max(0, value - (this.usage.total[key] || 0)) : params.tokenUsage.last?.[key] || 0
          this.turnUsage ||= {}; this.turnUsage[key] = (this.turnUsage[key] || 0) + delta
        }
      }
      this.usage = params.tokenUsage
    }
    else if (method === 'item/started' && params.item.type === 'agentMessage') {
      // The server may re-announce the same item when reconciling the completed
      // response. Preserve the existing text block and its streamed deltas.
      if (this.activeMessages.has(params.item.id)) return
      this.endMessage()
      this.lastText = ''
      this.activeMessages.set(params.item.id, '')
      this.currentMessage = { role: 'assistant', id: params.item.id }
      this.emit({ type: 'message_start', message: { role: 'assistant', id: params.item.id } })
    } else if (method === 'item/agentMessage/delta') {
      this.activeMessages.set(params.itemId, (this.activeMessages.get(params.itemId) || '') + params.delta)
      this.lastText = this.activeMessages.get(params.itemId)
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: params.delta } })
    } else if (method === 'item/reasoning/summaryTextDelta') {
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: params.delta } })
    } else if (method === 'item/completed' && params.item.type === 'agentMessage') {
      if (this.endedMessages.has(params.item.id)) return
      this.lastText = params.item.text || this.activeMessages.get(params.item.id) || ''
      this.currentMessage = { role: 'assistant', id: params.item.id, content: [{ type: 'text', text: this.lastText }] }
    } else if (method === 'error') {
      if (params.willRetry) this.emit({ type: 'auto_retry_start', attempt: ++this.retryCount || (this.retryCount = 1), maxAttempts: 2 })
      else this.lastError = params.error?.message || 'Codex turn failed'
    } else if (method === 'item/started' && params.item.type === 'contextCompaction') {
      if (!this.compaction) { this.autoCompaction = { tokensBefore: this.usage?.last?.totalTokens }; this.emit({ type: 'compaction_start', reason: 'threshold' }) }
    } else if (method === 'thread/compacted' || method === 'item/completed' && params.item.type === 'contextCompaction') this.compacted()
    else if (method === 'turn/completed') {
      const error = params.turn.status === 'failed' ? params.turn.error?.message || this.lastError || 'Codex turn failed' : ''
      if (this.compaction) { if (error) this.finish(error); else this.compacted(true) }
      else this.finish(error, params.turn.status === 'interrupted')
    }
  }
  endMessage(extra = {}) {
    if (!this.currentMessage) return
    this.emit({ type: 'message_end', message: { ...this.currentMessage, content: [{ type: 'text', text: this.lastText }], stopReason: 'stop', ...extra } })
    this.endedMessages.add(this.currentMessage.id)
    this.currentMessage = null
  }
  compacted(manualFinished = false) {
    if (this.autoCompaction) {
      this.emit({ type: 'compaction_end', reason: 'threshold', result: { ...this.autoCompaction, estimatedTokensAfter: this.usage?.last?.totalTokens } })
      this.autoCompaction = null
    }
    const pending = this.compaction
    if (!pending || !manualFinished) return
    this.compaction = null; this.turn = null
    const result = { tokensBefore: pending.tokensBefore, estimatedTokensAfter: this.usage?.last?.totalTokens }
    this.emit({ type: 'compaction_end', reason: 'manual', result })
    pending.resolve(result)
  }
  finish(error = '', interrupted = false) {
    const wasActive = this.turn || this.starting
    this.turn = null; this.starting = false; this.lastError = ''; this.retryCount = 0
    this.controller?.abort()
    for (const ui of this.pendingUi.values()) ui.resolve(false)
    this.pendingUi.clear()
    if (this.compaction) {
      const pending = this.compaction; this.compaction = null
      this.emit({ type: 'compaction_end', reason: 'manual', errorMessage: error })
      pending.reject(new Error(error || 'Compaction interrupted'))
    } else if (wasActive) {
      if (this.autoCompaction) { this.autoCompaction = null; this.emit({ type: 'compaction_end', reason: 'threshold', errorMessage: error || 'Compaction interrupted' }) }
      const last = this.turnUsage
      this.endMessage({ stopReason: interrupted ? 'aborted' : error ? 'error' : 'stop', errorMessage: error, ...(last ? { usage: { input: Math.max(0, (last.inputTokens || 0) - (last.cachedInputTokens || 0) - (last.cacheWriteInputTokens || 0)), output: last.outputTokens || 0, cacheRead: last.cachedInputTokens || 0, cacheWrite: last.cacheWriteInputTokens || 0, totalTokens: last.totalTokens || 0 } } : {}) })
      this.emit({ type: 'agent_end', error })
      this.emit({ type: 'agent_settled', error })
    }
  }
  ask(request, signal = this.controller?.signal) {
    const run = this.uiTail.then(() => {
      if (signal?.aborted) return false
      return new Promise(resolve => {
        const id = crypto.randomUUID()
        const finish = value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pendingUi.delete(id); resolve(value) }
        const abort = () => finish(false)
        const timer = setTimeout(abort, 10 * 60000)
        this.pendingUi.set(id, { resolve: finish, method: request.method })
        signal?.addEventListener('abort', abort, { once: true })
        this.emit({ type: 'extension_ui_request', id, ...request })
      })
    })
    this.uiTail = run.catch(() => {})
    return run
  }
  respondUi(response) {
    const ui = this.pendingUi.get(response.id)
    if (!ui) return
    ui.resolve(ui.method === 'confirm' ? response.confirmed === true : ui.method === 'select' ? response.selected : response.value)
  }
  async serverRequest(message) {
    try {
      const params = message.params || {}
      if (params.threadId !== this.threadId || !this.controller || this.controller.signal.aborted) {
        this.client.reject(message.id, 'The turn is no longer active'); return
      }
      if (message.method === 'item/tool/call') {
        this.endMessage()
        const result = await this.tools.execute(params, this.controller.signal)
        this.client.respond(message.id, result)
      } else if (message.method === 'item/tool/requestUserInput') {
        const answers = {}
        for (const question of params.questions || []) {
          const choices = question.options?.map(option => option.label) || []
          const value = await this.ask({ method: choices.length && !question.isOther ? 'select' : 'input', title: question.header || 'AnyuAgent', message: question.question, ...(choices.length ? { options: choices, placeholder: choices.join(' / ') } : {}) })
          answers[question.id] = { answers: value === false ? [] : [String(value ?? '')] }
        }
        this.client.respond(message.id, { answers })
      } else if (message.method.endsWith('/requestApproval')) {
        // Native mutation tools are disabled. Never approve a stray native
        // execution that would bypass the host's explicit project policy.
        this.client.respond(message.id, { decision: 'decline' })
      } else this.client.reject(message.id, `Unsupported server request: ${message.method}`)
    } catch (error) { if (!this.client.closed) this.client.reject(message.id, error.message) }
  }
  async close() {
    this.closed = true
    this.finish('Runtime stopped', true)
    await this.client?.close()
    await this.bridge?.close()
  }
}

module.exports = { CodexRuntime, runtimeConfig }
