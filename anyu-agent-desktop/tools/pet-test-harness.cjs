'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { AgentSessionService } = require('../agent-session.cjs')
const { PetManager } = require('../pet-manager.cjs')

const models = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', group_id: 10, group_name: 'GPT Pro', api: 'openai-responses', provider: 'openai' },
  { id: 'deepseek-v4', name: 'DeepSeek V4', group_id: 20, group_name: 'DeepSeek', api: 'openai-completions', provider: 'openai' },
  { id: 'claude-sonnet', name: 'Claude Sonnet', group_id: 30, group_name: 'Claude', api: 'anthropic-messages', provider: 'anthropic' },
]
function createHarness(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-pets-test-'))
  let owner = 'test-user-a'
  const starts = [], commands = [], events = [], runtimes = new Map(), approvals = []
  const sessions = new AgentSessionService({
    userDataDir: directory,
    startRuntime: async input => {
      starts.push(input)
      await options.beforeStart?.(input)
      const sessionPath = input.sessionPath || path.join(directory, `${input.agentSessionId.replaceAll(':', '_')}.jsonl`)
      runtimes.set(sessionPath, { permissionMode: input.permissionMode })
      return { sessionPath, cwd: directory, permissionMode: input.permissionMode }
    },
    resolveRuntime: key => runtimes.get(key),
    sendCommand: async input => { commands.push(input); if (input.type === 'abort') sessions.ingest(input.sessionKey, { type: 'agent_settled' }) },
    respondUi: async input => approvals.push(input),
    broadcast: () => {},
  })
  const managerOptions = {
    directory: path.join(directory, 'pets'), assetDirectory: path.resolve(__dirname, '../pets/assets'), sessions,
    getCatalog: async () => ({ models }), getOwner: () => owner, getCwd: () => directory, getPermission: options.getPermission || (() => 'confirm'),
    changed: event => events.push(event), voice: options.voice || { speak: async () => ({ mode: 'off', text: '' }) },
  }
  const manager = new PetManager(managerOptions)
  function ingest(id, event) {
    const sessionId = manager.config(id).sessionId
    sessions.ingest(sessions.sessions.get(sessionId).piSessionPath, event)
  }
  function finish(id, text = 'Completed') {
    ingest(id, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } })
    ingest(id, { type: 'agent_settled' })
  }
  async function enable(id, model = models[0]) { await manager.install(id); await manager.save(id, { enabled: true, model }) }
  async function cleanup() {
    manager.close()
    await sessions.stopAll()
    // Only remove this harness's unique temporary directory.
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('anyu-pets-test-')) fs.rmSync(directory, { recursive: true, force: true })
  }
  return { directory, sessions, manager, managerOptions, starts, commands, approvals, events, ingest, finish, enable, cleanup, setOwner: value => { owner = value } }
}
module.exports = { createHarness, models }
