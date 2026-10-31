'use strict'

const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const { once } = require('node:events')

const HISTORY_PREFIX = 'anyu_provider_v1:'
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })

function relayResponse(response, res, statusChanged = () => {}) {
  return new Promise((resolve, reject) => {
    response.on('error', reject)
    response.on('aborted', () => reject(new Error('Upstream stream disconnected')))
    const headers = { 'Content-Type': response.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store', ...(response.headers['retry-after'] ? { 'Retry-After': response.headers['retry-after'] } : {}) }
    if (response.statusCode !== 409) {
      statusChanged(response.statusCode)
      res.writeHead(response.statusCode, headers)
      if (String(headers['Content-Type']).includes('text/event-stream')) res.flushHeaders()
      response.once('end', resolve); response.pipe(res)
      return
    }
    const chunks = []; let size = 0
    response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error('Upstream error body exceeds limit')); else chunks.push(chunk) })
    response.once('end', () => {
      const body = Buffer.concat(chunks)
      let code
      try { code = JSON.parse(body).error?.code } catch {}
      // Codex retries 409. A deliberate host request limit is not transient.
      const status = code === 'TASK_REQUEST_LIMIT' ? 400 : 409
      statusChanged(status, code)
      res.writeHead(status, headers); res.end(body); resolve()
    })
  })
}

function contentOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return (content || []).map(part => {
    if (['input_text', 'output_text', 'text'].includes(part.type)) return { type: 'text', text: part.text || '' }
    if (part.type === 'input_image') {
      const match = String(part.image_url || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i)
      if (!match) throw new Error('This model bridge requires inline image data')
      return { type: 'image', mimeType: match[1], data: match[2] }
    }
    throw new Error(`Unsupported model input: ${part.type}`)
  })
}

// Provider SDKs own their wire formats. Only the App Server boundary is mapped
// here; opaque thinking signatures survive tool rounds and persisted resumes.
function toProviderContext(body, model) {
  const messages = [], instructions = body.instructions ? [body.instructions] : []
  const toolSpecs = [...(body.tools || [])]
  const names = new Map()
  let restored = false
  const assistant = () => ({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: 'stop', timestamp: Date.now() })
  for (const item of typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || []) {
    if (item.type === 'additional_tools') { toolSpecs.push(...(item.tools || [])); continue }
    if (item.type === 'reasoning') {
      if (String(item.encrypted_content || '').startsWith(HISTORY_PREFIX)) {
        const saved = JSON.parse(Buffer.from(item.encrypted_content.slice(HISTORY_PREFIX.length), 'base64').toString('utf8'))
        if (saved.role !== 'assistant' || !Array.isArray(saved.content)) throw new Error('Invalid provider history')
        messages.push(saved); restored = true
        for (const part of saved.content) if (part.type === 'toolCall') names.set(part.id, part.name)
      }
      continue
    }
    if (item.type === 'function_call') {
      names.set(item.call_id, item.name)
      if (restored) continue
      let last = messages.at(-1)
      if (last?.role !== 'assistant') { last = assistant(); messages.push(last) }
      last.content.push({ type: 'toolCall', id: item.call_id, name: item.name, arguments: JSON.parse(item.arguments || '{}') })
      last.stopReason = 'toolUse'
    } else if (item.type === 'function_call_output') {
      restored = false
      messages.push({ role: 'toolResult', toolCallId: item.call_id, toolName: names.get(item.call_id) || '', content: contentOf(item.output), isError: false, timestamp: Date.now() })
    } else if (item.type === 'agent_message') {
      if (!restored) messages.push({ ...assistant(), content: contentOf(item.content) })
    } else if (!item.type || item.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') instructions.push(contentOf(item.content).map(part => part.text || '').join('\n'))
      else if (item.role === 'assistant') { if (!restored) messages.push({ ...assistant(), content: contentOf(item.content) }) }
      else { restored = false; messages.push({ role: 'user', content: contentOf(item.content), timestamp: Date.now() }) }
    } else throw new Error(`Unsupported Responses history item: ${item.type}`)
  }
  const tools = [], toolNamespaces = new Map()
  const expanded = toolSpecs.flatMap(tool => tool.type === 'namespace' ? (tool.tools || []).map(child => ({ ...child, namespace: tool.name })) : [tool])
  for (const tool of expanded) {
    if (tool.type !== 'function') throw new Error(`Unsupported tool type for ${model.api}: ${tool.type} (${tool.name})`)
    if (toolNamespaces.has(tool.name) && toolNamespaces.get(tool.name) !== tool.namespace) throw new Error(`Ambiguous tool name: ${tool.name}`)
    toolNamespaces.set(tool.name, tool.namespace)
    if (!tools.some(existing => existing.name === tool.name)) tools.push({ name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } })
  }
  return { systemPrompt: instructions.join('\n\n'), messages, tools, toolNamespaces }
}

class CodexProviderBridge {
  constructor({ model, credential, conversationOnly = false, getThinking = () => 'auto', onModelRequest = () => {}, onProviderActivity = () => {} }) {
    this.model = model
    this.credential = credential
    this.conversationOnly = conversationOnly
    this.getThinking = getThinking
    this.onModelRequest = onModelRequest
    this.onProviderActivity = onProviderActivity
    this.token = crypto.randomBytes(32).toString('base64url')
    this.sockets = new Set()
    this.controllers = new Set()
    this.providerRequests = new Map()
    this.preferNativeResponses = model.preferNativeResponses === true && model.api === 'openai-completions'
    this.agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) }
  }
  async start() {
    this.server = http.createServer((req, res) => { void this.handle(req, res) })
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening')
    this.origin = `http://127.0.0.1:${this.server.address().port}/v1`
    return this
  }
  async close() {
    for (const controller of this.controllers) controller.abort()
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise(resolve => this.server.close(resolve))
    for (const agent of Object.values(this.agents)) agent.destroy()
  }
  async handle(req, res) {
    if (req.url.startsWith('/provider/')) { this.forwardProvider(req, res); return }
    const actual = Buffer.from(String(req.headers.authorization || ''))
    const expected = Buffer.from(`Bearer ${this.token}`)
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { res.writeHead(401); res.end(); return }
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
    const controller = new AbortController()
    this.controllers.add(controller)
    res.once('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      const chunks = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 64 * 1024 * 1024) throw Object.assign(new Error('Model input exceeds 64 MiB'), { status: 413 })
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks))
      if (body.model !== this.model.id) throw Object.assign(new Error('Model does not match the selected group'), { status: 400 })
      if (this.conversationOnly) {
        body.tools = []
        body.tool_choice = 'none'
        if (Array.isArray(body.input)) body.input = body.input.filter(item => item.type !== 'additional_tools')
      }
      this.onModelRequest()
      if (this.model.api === 'openai-responses') await this.proxy(body, req, res, controller.signal)
      else {
        if (this.preferNativeResponses) {
          if (await this.proxy(body, req, res, controller.signal, true)) return
          this.preferNativeResponses = false
        }
        await this.convert(body, res, controller.signal)
      }
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return
      if (res.headersSent) res.destroy(error)
      else { res.writeHead(Number(error.status) || 502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message, type: 'anyu_provider_error', ...(error.code ? { code: error.code } : {}) } })) }
    } finally { this.controllers.delete(controller) }
  }
  forwardProvider(req, res) {
    const match = req.url.match(/^\/provider\/([a-f0-9]{48})(\/.*)$/)
    const pending = match && this.providerRequests.get(match[1])
    if (!pending || req.method !== 'POST') { res.writeHead(404); res.end(); return }
    const base = new URL(this.model.baseUrl)
    const target = new URL(match[2], base.origin)
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) { res.writeHead(400); res.end(); return }
    const headers = { ...req.headers, host: target.host }
    delete headers.connection
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: 'POST', headers, signal: pending.signal, agent: this.agents[target.protocol] }, response => {
      void relayResponse(response, res, (status, code) => { pending.status = status; pending.code = code }).catch(error => res.destroy(error))
    })
    upstream.on('error', error => {
      if (res.headersSent) res.destroy(error)
      else { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })) }
    })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
    req.pipe(upstream)
  }
  proxy(body, req, res, signal, allowProtocolFallback = false) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.model.baseUrl.replace(/\/$/, '')}/responses`)
      // Converted providers keep their signatures in private reasoning items.
      // The visible messages/tool calls are already present for native history.
      const nativeBody = Array.isArray(body.input) ? { ...body, input: body.input.filter(item => !(item.type === 'reasoning' && String(item.encrypted_content || '').startsWith(HISTORY_PREFIX))) } : body
      const data = Buffer.from(JSON.stringify(nativeBody))
      const upstream = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'POST', signal, agent: this.agents[url.protocol],
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${this.credential}`, 'Content-Length': data.length, ...(req.headers['x-session-id'] ? { 'x-session-id': req.headers['x-session-id'] } : {}) },
      }, response => {
        if (allowProtocolFallback && response.statusCode === 403) {
          const chunks = []; let size = 0
          response.on('error', reject)
          response.on('aborted', () => reject(new Error('Upstream stream disconnected')))
          response.on('data', chunk => {
            size += chunk.length
            if (size > 1024 * 1024) response.destroy(new Error('Upstream error body exceeds limit'))
            else chunks.push(chunk)
          })
          response.once('end', () => {
            const data = Buffer.concat(chunks)
            let code
            try { const error = JSON.parse(data); code = error.code || error.error?.code } catch {}
            // This exact rejection occurs before upstream execution. Never
            // replay timeouts, overloads, model errors or a partially read SSE.
            if (code === 'ANYU_AGENT_PROTOCOL_MISMATCH') { resolve(false); return }
            res.writeHead(403, { 'Content-Type': response.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' })
            res.end(data); resolve(true)
          })
          return
        }
        relayResponse(response, res).then(() => resolve(true), reject)
      })
      upstream.on('error', reject)
      upstream.end(data)
    })
  }
  async convert(body, res, signal) {
    const api = this.model.api === 'google-vertex' ? 'google-generative-ai' : this.model.api
    if (!['openai-completions', 'anthropic-messages', 'google-generative-ai'].includes(api)) throw new Error(`Unsupported model protocol: ${api}`)
    const provider = await import(`@earendil-works/pi-ai/api/${api}`)
    const context = toProviderContext(body, this.model)
    const level = this.getThinking()
    const claude = api === 'anthropic-messages' && /^claude-/i.test(this.model.id)
    const claudeId = this.model.id.toLowerCase().replaceAll('.', '-')
    const adaptiveClaude = claude && /^claude-(?:opus-4-[6-8]|sonnet-4-6|(?:opus|sonnet|haiku|fable|mythos)-5|mythos-preview)(?:-|$)/.test(claudeId)
    const reasoning = level === 'auto' ? undefined : level === 'off' ? undefined : level
    const requestId = crypto.randomBytes(24).toString('hex')
    const transport = { status: 502, signal }
    this.providerRequests.set(requestId, transport)
    const explicitMax = Number.isSafeInteger(this.model.maxTokens) && this.model.maxTokens > 0
    const known = api === 'anthropic-messages' && (claude || !explicitMax) ? Object.values((await import('@earendil-works/pi-ai/providers/anthropic.models')).ANTHROPIC_MODELS).find(model => model.id === this.model.id) : undefined
    const model = { ...(claude ? known : {}), ...this.model, api, maxTokens: explicitMax ? this.model.maxTokens : known?.maxTokens || 65536, baseUrl: `${new URL(this.origin).origin}/provider/${requestId}${new URL(this.model.baseUrl).pathname}`, ...(level === 'off' ? { reasoning: false } : {}) }
    if (claude) {
      // Do not import SDK fallback models: the selected group owns model routing.
      model.compat = { ...(known?.compat?.supportsTemperature === false ? { supportsTemperature: false } : {}), forceAdaptiveThinking: adaptiveClaude, ...this.model.compat }
      model.thinkingLevelMap = { ...(adaptiveClaude ? { xhigh: 'xhigh', max: 'max' } : {}), ...known?.thinkingLevelMap, ...this.model.thinkingLevelMap }
    }
    const stream = provider.streamSimple(model, context, {
      apiKey: this.credential, signal, reasoning, maxRetries: 0, timeoutMs: 15 * 60000,
      onResponse: response => { transport.status = response.status },
      onPayload: payload => {
        if (claude && level === 'auto') {
          delete payload.thinking
          if (payload.output_config) delete payload.output_config.effort
          // Keep upstream default effort; opt in only to the public summary.
          if (adaptiveClaude && !claudeId.includes('-4-')) payload.thinking = { type: 'adaptive', display: 'summarized' }
        } else if (adaptiveClaude) {
          const limited = level === 'off' || level === 'between_tools'
          payload.thinking = { type: level === 'off' ? 'disabled' : level === 'between_tools' ? 'between_tools' : 'adaptive' }
          payload.output_config = { ...payload.output_config, effort: limited ? 'high' : level }
        }
        if (claude && payload.thinking && payload.thinking.type !== 'disabled') payload.thinking.display = 'summarized'
        // Anthropic requires max_tokens. Other protocols keep their upstream
        // default unless the catalogue explicitly declares an output limit.
        if (!explicitMax && api !== 'anthropic-messages') {
          delete payload.max_tokens; delete payload.max_completion_tokens
          if (payload.config) delete payload.config.maxOutputTokens
        }
        return payload
      },
    })
    const id = `resp_${crypto.randomUUID().replace(/-/g, '')}`
    const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: model.id, status: 'in_progress', output: [] }
    let sequence = 0, begun = false, thinking = ''
    const thinkingDeltas = new Set()
    const items = new Map()
    const send = async event => {
      if (signal.aborted) throw new Error('Model request cancelled')
      if (!res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`)) await once(res, 'drain', { signal })
    }
    const start = async () => {
      if (begun) return
      begun = true
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      await send({ type: 'response.created', response })
      await send({ type: 'response.output_item.added', output_index: 0, item: { id: `rs_${id}`, type: 'reasoning', summary: [] } })
    }
    const textItem = async index => {
      if (items.has(index)) return items.get(index)
      await start()
      const item = { id: `msg_${id}_${index}`, type: 'message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: '', annotations: [] }] }
      const entry = { index: items.size + 1, item }
      items.set(index, entry)
      await send({ type: 'response.output_item.added', output_index: entry.index, item: { ...item, content: [] } })
      await send({ type: 'response.content_part.added', output_index: entry.index, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      return entry
    }
    try { for await (const event of stream) {
      if (event.type === 'error') {
        const error = new Error(event.error.errorMessage || 'Provider request failed')
        error.status = transport.status >= 400 ? transport.status : 502
        error.code = transport.code
        throw error
      }
      if (claude && event.type === 'start') await start()
      if (claude && (event.type === 'thinking_start' || event.type === 'toolcall_start') && !event.partial?.content[event.contentIndex]?.redacted) {
        await start()
        this.onProviderActivity(event.type)
      }
      if (event.type === 'text_delta') {
        const entry = await textItem(event.contentIndex)
        entry.item.content[0].text += event.delta
        await send({ type: 'response.output_text.delta', output_index: entry.index, item_id: entry.item.id, content_index: 0, delta: event.delta })
      }
      const publicThinking = !event.partial?.content[event.contentIndex]?.redacted
      const thinkingFallback = claude && event.type === 'thinking_end' && !thinkingDeltas.has(event.contentIndex)
      if (publicThinking && (event.type === 'thinking_delta' || thinkingFallback)) {
        const delta = thinkingFallback ? event.content : event.delta
        if (!delta) continue
        thinkingDeltas.add(event.contentIndex)
        await start()
        if (!thinking) await send({ type: 'response.reasoning_summary_part.added', output_index: 0, item_id: `rs_${id}`, summary_index: 0, part: { type: 'summary_text', text: '' } })
        thinking += delta
        await send({ type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: `rs_${id}`, summary_index: 0, delta })
      }
      if (event.type !== 'done') continue
      if (event.reason === 'length') throw new Error('Model output limit reached before the turn completed')
      await start()
      const message = event.message
      const summary = thinking ? [{ type: 'summary_text', text: thinking }] : []
      const history = { id: `rs_${id}`, type: 'reasoning', summary, encrypted_content: HISTORY_PREFIX + Buffer.from(JSON.stringify(message)).toString('base64') }
      const outputItems = new Map([[0, history]])
      for (let i = 0; i < message.content.length; i++) if (message.content[i].type === 'text') await textItem(i)
      let nextToolIndex = items.size + 1
      if (thinking) {
        await send({ type: 'response.reasoning_summary_text.done', output_index: 0, item_id: history.id, summary_index: 0, text: thinking })
        await send({ type: 'response.reasoning_summary_part.done', output_index: 0, item_id: history.id, summary_index: 0, part: summary[0] })
      }
      await send({ type: 'response.output_item.done', output_index: 0, item: history })
      for (let i = 0; i < message.content.length; i++) {
        const part = message.content[i]
        if (part.type === 'text') {
          const entry = await textItem(i)
          entry.item.status = 'completed'; entry.item.content[0].text = part.text
          await send({ type: 'response.output_text.done', output_index: entry.index, item_id: entry.item.id, content_index: 0, text: part.text })
          await send({ type: 'response.output_item.done', output_index: entry.index, item: entry.item })
          outputItems.set(entry.index, entry.item)
        } else if (part.type === 'toolCall') {
          const namespace = context.toolNamespaces.get(part.name)
          const item = { id: `fc_${id}_${i}`, type: 'function_call', call_id: part.id, name: part.name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(part.arguments), status: 'completed' }
          const index = nextToolIndex++
          await send({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } })
          await send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments })
          await send({ type: 'response.output_item.done', output_index: index, item })
          outputItems.set(index, item)
        }
      }
      const usage = message.usage || zeroUsage()
      const output = [...outputItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
      await send({ type: 'response.completed', response: { ...response, status: 'completed', output, usage: { input_tokens: usage.input + usage.cacheRead + usage.cacheWrite, output_tokens: usage.output, total_tokens: usage.totalTokens, input_tokens_details: { cached_tokens: usage.cacheRead }, output_tokens_details: { reasoning_tokens: usage.reasoning || 0 } } } })
      res.end()
      return
    }
    throw new Error('Provider stream ended without completion')
    } catch (error) {
      if (!claude || !begun || res.destroyed || signal.aborted) throw error
      // Once SSE has started, preserve the provider failure instead of closing
      // the socket and turning every native error into a generic disconnect.
      await send({ type: 'response.failed', response: { ...response, status: 'failed', error: { code: error.code || 'server_error', message: error.message } } })
      res.end()
    } finally { this.providerRequests.delete(requestId) }
  }
}

module.exports = { CodexProviderBridge, toProviderContext, contentOf, HISTORY_PREFIX }
