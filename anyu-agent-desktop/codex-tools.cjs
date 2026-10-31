'use strict'
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'runtime_probe'])
const libraryFile = relative => pathToFileURL(path.join(__dirname, 'node_modules/@earendil-works/pi-coding-agent/dist', relative)).href

class CodexTools {
  constructor({ cwd, readOnly = false, conversationOnly = false, ask, emit, model, agentDir, skillPaths = [] }) {
    Object.assign(this, { cwd, readOnly, conversationOnly, ask, emit, model, agentDir, skillPaths })
    this.tools = new Map()
    this.hooks = new Map()
    this.tail = Promise.resolve()
  }
  async initialize() {
    if (this.conversationOnly) { this.skillPrompt = ''; return this }
    const [{ createAllTools }, { validateToolArguments }, skills] = await Promise.all([
      import(libraryFile('core/tools/index.js')),
      import('@earendil-works/pi-ai'),
      import(libraryFile('core/skills.js')),
    ])
    this.validate = validateToolArguments
    const all = createAllTools(this.cwd, { bash: { exposeSessionEnvironment: false }, powershell: { exposeSessionEnvironment: false } })
    for (const tool of Object.values(all)) if (!this.readOnly || READ_TOOLS.has(tool.name)) this.tools.set(tool.name, tool)
    const api = {
      registerTool: tool => { if (!this.readOnly || READ_TOOLS.has(tool.name)) this.tools.set(tool.name, tool) },
      on: (name, handler) => { const list = this.hooks.get(name) || []; list.push(handler); this.hooks.set(name, list) },
      setActiveTools: names => { for (const name of this.tools.keys()) if (!names.includes(name)) this.tools.delete(name) },
    }
    for (const filename of ['runtime-probe-extension.mjs', 'pi-workbench-extension.mjs', 'pi-approval-gate.mjs', 'pi-subagent-extension.mjs', ...(!this.readOnly ? ['pi-browser-extension.mjs'] : [])]) {
      const module = await import(pathToFileURL(path.join(__dirname, filename)).href)
      module.default(api, { registerUnavailable: true })
    }
    for (const hook of this.hooks.get('session_start') || []) await hook({}, this.context())
    const loaded = skills.loadSkills({ cwd: this.cwd, agentDir: this.agentDir, skillPaths: this.skillPaths, includeDefaults: true })
    this.skillPrompt = skills.formatSkillsForPrompt(loaded.skills)
    return this
  }
  context(signal) {
    return { cwd: this.cwd, model: this.model, hasUI: true, ui: { confirm: (title, message) => this.ask({ method: 'confirm', title, message }, signal) } }
  }
  specs() {
    return [...this.tools.values()].map(tool => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters }))
  }
  execute(call, signal) {
    // A session has one approval card and one lease holder. Serialize calls in
    // that session; separate parent/child runtimes still execute concurrently.
    const run = this.tail.then(() => this.perform(call, signal))
    this.tail = run.catch(() => {})
    return run
  }
  async perform(call, signal) {
    let result, isError = false
    const tool = this.tools.get(call.tool)
    const id = call.callId
    const args = call.arguments
    const event = { toolName: call.tool === 'powershell' ? 'bash' : call.tool, toolCallId: id, input: args }
    const update = partialResult => this.emit({ type: 'tool_execution_update', toolName: call.tool, toolCallId: id, args, partialResult })
    this.emit({ type: 'tool_execution_start', toolName: call.tool, toolCallId: id, args })
    try {
      if (signal?.aborted) throw new Error('Task cancelled')
      if (!tool || (this.readOnly && !READ_TOOLS.has(call.tool))) throw new Error('Tool is unavailable in this session')
      const validated = this.validate(tool, { name: call.tool, arguments: args })
      for (const hook of this.hooks.get('tool_call') || []) {
        const policy = await hook({ ...event, input: validated }, this.context(signal))
        if (signal?.aborted) throw new Error('Task cancelled')
        if (policy?.block) throw new Error(policy.reason || 'Tool blocked')
      }
      result = await tool.execute(id, validated, signal, update, this.context(signal))
      isError = result?.isError === true
    } catch (error) { isError = true; result = { content: [{ type: 'text', text: error.message || String(error) }] } }
    finally {
      for (const hook of this.hooks.get('tool_result') || []) await hook({ ...event, result, isError }, this.context(signal)).catch(() => {})
    }
    this.emit({ type: 'tool_execution_end', toolName: call.tool, toolCallId: id, args, result, isError })
    return {
      success: !isError,
      contentItems: (result?.content || []).map(part => part.type === 'image'
        ? { type: 'inputImage', imageUrl: `data:${part.mimeType};base64,${part.data}` }
        : { type: 'inputText', text: String(part.text || '') }),
    }
  }
}

module.exports = { CodexTools, READ_TOOLS }
