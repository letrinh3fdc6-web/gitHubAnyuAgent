'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_CONTEXT_SETTINGS = Object.freeze({ enabled: true, mode: 'auto', triggerPercent: 85, keepRecentTokens: 20000 })
const DEFAULT_AUTO_COMPACT_TOKENS = 1000000

function validateContextSettings(value) {
  if (!value || typeof value.enabled !== 'boolean' || !['auto', 'custom'].includes(value.mode)) throw new Error('Invalid context compression mode')
  if (!Number.isInteger(value.triggerPercent) || value.triggerPercent < 50 || value.triggerPercent > 90) throw new Error('Compression threshold must be between 50 and 90 percent')
  if (!Number.isSafeInteger(value.keepRecentTokens) || value.keepRecentTokens < 1000) throw new Error('Recent context must be a safe integer of at least 1000 tokens')
  return { enabled: value.enabled, mode: value.mode, triggerPercent: value.triggerPercent, keepRecentTokens: value.keepRecentTokens }
}

function readObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
    return value
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}

function writeObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

// Use Pi's native summarization and append-only history; only calculate its settings.
function contextPolicy(settings, model, project = {}) {
  const window = Math.floor(Number(model.contextWindow || model.context_window) || 128000)
  if (window < 2048) throw new Error('Model context window is too small')
  const targetTokens = settings.mode === 'auto' ? DEFAULT_AUTO_COMPACT_TOKENS : Math.floor(window * settings.triggerPercent / 100)
  const reserveTokens = Math.max(Math.min(16384, Math.floor(window / 4)), window - targetTokens)
  const native = { enabled: settings.enabled, reserveTokens, keepRecentTokens: settings.keepRecentTokens, ...project }
  if (typeof native.enabled !== 'boolean' || !Number.isInteger(native.reserveTokens) || !Number.isInteger(native.keepRecentTokens) || native.reserveTokens < 1 || native.keepRecentTokens < 1) throw new Error('Invalid project compaction settings')
  if (native.reserveTokens >= window) throw new Error('Project reserveTokens must be smaller than this model context window')
  const triggerTokens = window - native.reserveTokens
  const retentionLimitTokens = Math.floor(triggerTokens * 0.8)
  if (project.keepRecentTokens !== undefined && project.keepRecentTokens >= triggerTokens) throw new Error('Project keepRecentTokens must be smaller than the compression threshold')
  // Reserve room for the summary and subsequent messages instead of imposing a
  // fixed token cap on models with very different context windows.
  if (project.keepRecentTokens === undefined) native.keepRecentTokens = Math.min(native.keepRecentTokens, retentionLimitTokens)
  return { native, contextWindow: window, triggerTokens, triggerPercent: Math.round(triggerTokens / window * 1000) / 10, retentionLimitTokens, retentionLimited: project.keepRecentTokens === undefined && native.keepRecentTokens < settings.keepRecentTokens, source: Object.keys(project).length ? 'project' : 'app' }
}

class AgentContextSettings {
  constructor(directory) { this.file = path.join(directory, 'context-settings.json') }
  get() { return validateContextSettings({ ...DEFAULT_CONTEXT_SETTINGS, ...readObject(this.file) }) }
  save(value) { const settings = validateContextSettings(value); writeObject(this.file, settings); return settings }
  policy(model, cwd, settings = this.get()) {
    const project = cwd ? readObject(path.join(cwd, '.pi', 'settings.json')).compaction || {} : {}
    return contextPolicy(validateContextSettings(settings), model, project)
  }
  prepare(agentDir, baseDir, policy) {
    const inherited = readObject(path.join(baseDir, 'settings.json'))
    writeObject(path.join(agentDir, 'settings.json'), { ...inherited, compaction: policy.native })
  }
}

module.exports = { AgentContextSettings, DEFAULT_CONTEXT_SETTINGS, validateContextSettings, contextPolicy }
