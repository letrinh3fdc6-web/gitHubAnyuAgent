const http = require('http')
const https = require('https')
const crypto = require('crypto')

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024
const ANYU_AGENT_GATEWAY_PATH = '/api/v1/integrations/anyu-agent/gateway'
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept', 'accept-encoding', 'content-type', 'anthropic-version', 'anthropic-beta',
  'openai-beta', 'x-session-id', 'x-request-id'
])

function createUpstreamAgent(protocol) {
  return protocol === 'https:'
    ? new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 })
    : new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 })
}

function managedProviderName(api, groupId) {
  const protocol = api === 'anthropic-messages' ? 'anthropic' : api === 'google-generative-ai' || api === 'google-vertex' ? 'gemini' : 'openai'
  return `anyu-gateway-${protocol}-g${Number(groupId)}`
}

function managedBaseUrl(origin, api, groupId, contextKey = '') {
	const route = `${String(origin || '').replace(/\/$/, '')}/anyu/${Number(groupId)}${contextKey ? `/context/${encodeURIComponent(contextKey)}` : ''}`
  if (api === 'anthropic-messages') return route
  return api === 'google-generative-ai' || api === 'google-vertex' ? `${route}/v1beta` : `${route}/v1`
}

function authorizedLocalRequest(req, token) {
  const authorization = String(req.headers.authorization || '').trim()
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || ''
  const candidate = bearer || String(req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '').trim()
  const expected = Buffer.from(String(token || ''))
  const actual = Buffer.from(candidate)
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function parseManagedRoute(requestUrl) {
  let url
  try { url = new URL(requestUrl, 'http://127.0.0.1') } catch { return null }
	const match = url.pathname.match(/^\/anyu\/([1-9]\d*)(?:\/context\/([a-zA-Z0-9_-]{1,64}))?(\/.*)$/)
	if (!match) return null
	const groupId = Number(match[1])
	const upstreamPath = match[3]
	if (!Number.isSafeInteger(groupId) || groupId <= 0 || !allowedGatewayPath(upstreamPath)) return null
	return { groupId, upstreamPath: `${upstreamPath}${url.search}`, ...(match[2] ? { contextKey: match[2] } : {}) }
}

function requestModel(route, body) {
	const path = String(route?.upstreamPath || '').split('?')[0]
	const pathMatch = path.match(/\/models\/([^/:?#]+):/i)
	if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]).replace(/^models\//, '').trim()
	try {
		const payload = body?.length ? JSON.parse(body.toString('utf8')) : null
		return String(payload?.model || '').replace(/^models\//, '').trim().slice(0, 256)
	} catch { return '' }
}

function normalizeManagedRequestBody(route, body) {
  const path = String(route?.upstreamPath || '').split('?')[0]
  const responses = path === '/v1/responses' || path === '/v1/responses/compact'
  if (!responses && path !== '/v1/chat/completions') return body
  let payload
  try { payload = JSON.parse(body.toString('utf8')) } catch { return body }
  const effort = responses ? payload?.reasoning?.effort : payload?.reasoning_effort
  if (effort !== 'off') return body
  // Pi 的关闭档是 off；本机 OpenAI 兼容网关接受的关闭值为 none。
  if (responses) payload.reasoning.effort = 'none'
  else payload.reasoning_effort = 'none'
  return Buffer.from(JSON.stringify(payload))
}

function allowedGatewayPath(pathname) {
  const path = String(pathname || '').split('?')[0]
  return /^\/v1\/(?:responses(?:\/compact)?|chat\/completions|messages(?:\/count_tokens)?)$/.test(path) ||
    /^\/v1beta\/models\/[^/?#]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(path)
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(Object.assign(new Error('请求体超过本机桥接限制'), { statusCode: 413 }))
      return
    }
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(Object.assign(new Error('请求体超过本机桥接限制'), { statusCode: 413 }))
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.once('end', () => resolve(Buffer.concat(chunks)))
    req.once('aborted', () => reject(Object.assign(new Error('客户端已取消请求'), { statusCode: 499 })))
    req.once('error', reject)
  })
}

function responseHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'set-cookie' || value == null) continue
    out[name] = value
  }
  return out
}

function writeJSON(res, statusCode, message) {
  if (res.headersSent || res.writableEnded) return
  const body = Buffer.from(JSON.stringify({ error: { type: 'anyu_agent_bridge_error', message } }))
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length), 'Cache-Control': 'no-store' })
  res.end(body)
}

class LocalGatewayBridge {
  constructor(options = {}) {
    this.gatewayBase = new URL(options.gatewayBase)
    if (!['http:', 'https:'].includes(this.gatewayBase.protocol)) throw new Error('网关地址必须使用 HTTP 或 HTTPS')
    // 与主进程的正式域名请求共用 DNS 兜底，避免系统 DNS 返回保留测试地址。
    this.lookup = typeof options.lookup === 'function' ? options.lookup : undefined
    this.userAgent = String(options.userAgent || 'AnyuAgent-Desktop')
    this.getAccessToken = options.getAccessToken
    this.refreshAccessToken = options.refreshAccessToken
    this.beforeRequest = options.beforeRequest
    this.onResponse = options.onResponse
    this.maxRequestBytes = Number(options.maxRequestBytes || DEFAULT_MAX_REQUEST_BYTES)
    this.server = null
    this.sockets = new Set()
    this.thinkingContexts = new Map()
    // Pi 会连续发起多轮请求，复用到正式网关的连接可避免重复 TCP/TLS 握手。
    this.upstreamAgent = createUpstreamAgent(this.gatewayBase.protocol)
    this.token = ''
    this.origin = ''
  }

  async start() {
    // 多会话并行后，网关桥是所有 Pi 子进程共用的入口；令牌一旦轮换，
    // 先启动的进程会被 401 掐断。已启动时直接复用现有监听与令牌。
    if (this.server && this.token && this.origin) return { origin: this.origin, token: this.token }
    await this.stop()
    if (!this.upstreamAgent || this.upstreamAgent.destroyed) this.upstreamAgent = createUpstreamAgent(this.gatewayBase.protocol)
    this.token = crypto.randomBytes(32).toString('base64url')
    this.server = http.createServer((req, res) => { void this.handle(req, res) })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server?.off('listening', onListening); reject(error) }
      const onListening = () => { this.server?.off('error', onError); resolve() }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(0, '127.0.0.1')
    })
    const address = this.server.address()
    this.origin = `http://127.0.0.1:${address.port}`
    return { origin: this.origin, token: this.token }
  }

  setThinkingLevel(contextKey, level = 'auto') {
    if (!contextKey) return
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(contextKey) || !/^(auto|off|on|between_tools|minimal|low|medium|high|xhigh|max)$/.test(level)) throw new Error('无效的思考深度')
    this.thinkingContexts.set(contextKey, level)
  }

  removeThinkingContext(contextKey) { this.thinkingContexts.delete(contextKey) }

  async stop() {
    const server = this.server
    this.server = null
    this.origin = ''
    this.token = ''
    this.thinkingContexts.clear()
    if (!server) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise((resolve) => server.close(() => resolve()))
    this.upstreamAgent.destroy()
  }

  async handle(req, res) {
    if (!authorizedLocalRequest(req, this.token)) {
      writeJSON(res, 401, '本机桥接令牌无效')
      return
    }
    if (String(req.method || '').toUpperCase() !== 'POST') {
      writeJSON(res, 405, '本机桥接不支持该请求方法')
      return
    }
    const route = parseManagedRoute(req.url)
    if (!route) {
      writeJSON(res, 404, '本机桥接路径不在允许范围内')
      return
    }
    if (route.contextKey && !this.thinkingContexts.has(route.contextKey)) {
      writeJSON(res, 400, '当前会话的思考配置已失效，请重新发送')
      return
    }
		let body
    try { body = await readRequestBody(req, this.maxRequestBytes) } catch (error) {
      writeJSON(res, Number(error.statusCode || 400), error.message || '无法读取请求体')
			return
		}
		route.model = requestModel(route, body)
		if (!route.model) {
			writeJSON(res, 400, '请求缺少有效模型')
			return
		}
    if (this.beforeRequest && !/count[_T]okens/.test(route.upstreamPath)) {
      route.requestId = `anyu-${crypto.randomUUID()}`
      try { await this.beforeRequest(route) } catch (error) { writeJSON(res, 409, error.message); return }
    }
		await this.proxy(req, res, route, normalizeManagedRequestBody(route, body), true)
  }

  async proxy(clientRequest, clientResponse, route, body, allowRefresh) {
    const accessToken = String(this.getAccessToken?.() || '')
    if (!accessToken) {
      writeJSON(clientResponse, 401, '登录状态已失效，请重新登录')
      return
    }
    // 自动分组请求只能进入 AnYuAgent 专用网关，绝不回落到旧通用 URL。
    const target = new URL(`${ANYU_AGENT_GATEWAY_PATH}${route.upstreamPath}`, this.gatewayBase)
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-AnYu-Group-ID': String(route.groupId),
      'X-AnYu-Model': route.model,
      'User-Agent': this.userAgent,
      'Content-Length': String(body.length)
    }
    if (route.contextKey) headers['X-AnYu-Thinking-Level'] = this.thinkingContexts.get(route.contextKey)
    for (const [name, value] of Object.entries(clientRequest.headers || {})) {
      if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase()) && value != null) headers[name] = value
    }
    if (route.requestId) headers['x-request-id'] = route.requestId
    const transport = target.protocol === 'https:' ? https : http
    await new Promise((resolve) => {
      const requestOptions = { method: clientRequest.method, headers, agent: this.upstreamAgent }
      if (this.lookup) requestOptions.lookup = this.lookup
      const upstream = transport.request(target, requestOptions, (upstreamResponse) => {
        this.onResponse?.(route, upstreamResponse.headers, upstreamResponse.statusCode)
        if (upstreamResponse.statusCode === 401 && allowRefresh) {
          const chunks = []
          upstreamResponse.on('data', (chunk) => chunks.push(chunk))
          upstreamResponse.once('end', async () => {
            try {
              const refreshed = await this.refreshAccessToken?.()
              if (refreshed && !clientResponse.writableEnded) {
                await this.proxy(clientRequest, clientResponse, route, body, false)
              } else if (!clientResponse.writableEnded) {
                const payload = Buffer.concat(chunks)
                clientResponse.writeHead(401, responseHeaders(upstreamResponse.headers))
                clientResponse.end(payload)
              }
            } catch (error) {
              writeJSON(clientResponse, 401, error.message || '登录状态刷新失败')
            }
            resolve()
          })
          return
        }
        if (!clientResponse.headersSent) clientResponse.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers))
        upstreamResponse.pipe(clientResponse)
        upstreamResponse.once('end', resolve)
        upstreamResponse.once('error', (error) => {
          // Once SSE headers are sent, a JSON error would corrupt the protocol.
          if (clientResponse.headersSent) clientResponse.destroy(error)
          else writeJSON(clientResponse, 502, error.message || '网关响应失败')
          resolve()
        })
      })
      upstream.once('error', (error) => { writeJSON(clientResponse, 502, error.message || '无法连接网关'); resolve() })
      clientRequest.once('aborted', () => upstream.destroy())
      clientResponse.once('close', () => { if (!clientResponse.writableEnded) upstream.destroy() })
      upstream.end(body)
    })
  }
}

module.exports = { ANYU_AGENT_GATEWAY_PATH, LocalGatewayBridge, managedProviderName, managedBaseUrl, parseManagedRoute, allowedGatewayPath, requestModel, normalizeManagedRequestBody }
