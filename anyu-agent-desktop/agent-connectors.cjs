'use strict'

const crypto = require('node:crypto')

// The official MCP client owns protocol negotiation, pagination and transport.
// Credentials never cross the renderer boundary after saving.
class AgentConnectors {
  constructor({ store, encrypt, decrypt }) {
    this.store = store
    this.encrypt = encrypt
    this.decrypt = decrypt
    this.clients = new Map()
  }

  list() {
    return Object.values(this.store.state.connectors).map(({ secret, ...item }) => ({ ...item, authenticated: Boolean(secret) }))
  }

  async save(input) {
    const id = input.id || crypto.randomUUID()
    const previous = this.store.state.connectors[id]
    const name = String(input.name || '').trim().slice(0, 80)
    if (!name || !['stdio', 'http', 'sse'].includes(input.transport)) throw new Error('Connector name and transport required')
    let url = ''
    if (input.transport !== 'stdio') {
      const parsed = new URL(input.url)
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('Remote MCP requires HTTPS')
      if (parsed.username || parsed.password) throw new Error('Use the credential field')
      url = parsed.href
    } else if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 1024) throw new Error('MCP executable required')
    if (input.args && (!Array.isArray(input.args) || input.args.length > 40 || input.args.some(arg => typeof arg !== 'string' || arg.length > 4096))) throw new Error('Invalid MCP arguments')
    const secret = input.token === undefined ? previous?.secret || '' : input.token ? this.encrypt(String(input.token)) : ''
    if (input.token && !secret) throw new Error('OS credential encryption is unavailable')
    const sameEndpoint = previous?.url === url && previous?.command === input.command && previous?.transport === input.transport && JSON.stringify(previous?.args || []) === JSON.stringify(input.args || [])
    this.store.state.connectors[id] = { id, name, transport: input.transport, url, command: input.command || '', args: input.args || [], secret, allowedTools: sameEndpoint ? previous.allowedTools || [] : [], tools: [], health: 'unchecked' }
    await this.disconnect(id)
    await this.store.save()
    return this.list()
  }

  async connect(id) {
    if (this.clients.has(id)) return this.clients.get(id)
    const config = this.store.state.connectors[id]
    if (!config) throw new Error('Connector not found')
    const job = (async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const client = new Client({ name: 'AnyuAgent', version: '1.0.0' })
      let transport
      if (config.transport === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        transport = new StdioClientTransport({ command: config.command, args: config.args, stderr: 'ignore', ...(config.secret ? { env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', MCP_TOKEN: this.decrypt(config.secret) } } : {}) })
      } else {
        const requestInit = { headers: config.secret ? { Authorization: `Bearer ${this.decrypt(config.secret)}` } : {} }
        if (config.transport === 'sse') {
          const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
          transport = new SSEClientTransport(new URL(config.url), { requestInit })
        } else {
          const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
          transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit })
        }
      }
      try { await client.connect(transport, { timeout: 15000 }); return client }
      catch (error) { await transport.close().catch(() => {}); throw error }
    })()
    this.clients.set(id, job)
    try { return await job } catch (error) { this.clients.delete(id); throw error }
  }

  async health(id) {
    const config = this.store.state.connectors[id]
    if (!config) throw new Error('Connector not found')
    try {
      const client = await this.connect(id)
      const tools = []
      let cursor
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000 })
        tools.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor && tools.length < 200)
      config.tools = tools.slice(0, 200).map(({ name, description, inputSchema }) => ({ name, description: String(description || '').slice(0, 2000), inputSchema }))
      config.health = 'ready'
      config.error = ''
    } catch (error) {
      config.health = 'failed'
      config.error = error.code === 401 || /401/.test(error.message) ? 'Authentication required' : 'Connection failed; check address, executable and credentials'
    }
    config.checkedAt = new Date().toISOString()
    await this.store.save()
    return this.list()
  }

  async allow(id, tools) {
    const config = this.store.state.connectors[id]
    if (!config || !Array.isArray(tools) || tools.some(name => !config.tools.some(tool => tool.name === name))) throw new Error('Unknown MCP tools')
    config.allowedTools = [...new Set(tools)]
    await this.store.save()
    return this.list()
  }

  async call(id, name, args) {
    const config = this.store.state.connectors[id]
    if (!config?.allowedTools?.includes(name)) throw new Error('This MCP tool has not been enabled')
    return (await this.connect(id)).callTool({ name, arguments: args || {} }, undefined, { timeout: 60000 })
  }

  async disconnect(id) {
    const job = this.clients.get(id)
    this.clients.delete(id)
    if (job) await job.then(client => client.close()).catch(() => {})
  }
  async remove(id) { await this.disconnect(id); delete this.store.state.connectors[id]; await this.store.save(); return this.list() }
  async close() { await Promise.allSettled([...this.clients.keys()].map(id => this.disconnect(id))) }
}

module.exports = { AgentConnectors }
