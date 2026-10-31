'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { CHARACTERS, VOICES, resolveConfig } = require('./pet-catalog.cjs')
const { PetVoice } = require('./pet-voice.cjs')
const { PetLinks } = require('./pet-links.cjs')
const { normalizeReferences, validateReferences, referencedSkills, referencePrompt } = require('./pet-references.cjs')
const { PetMemory } = require('./pet-memory.cjs')
const { importPetMemory } = require('./pet-memory-import.cjs')

const bounded = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback
const modelKey = model => JSON.stringify([model?.id || '', model?.group_id || 0, model?.api || ''])
const png = bytes => bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

class PetManager {
  constructor({ directory, assetDirectory, sessions, getCatalog, getOwner, getCwd, getPermission, getSkills = () => [], changed, openMain, voice, readAsset }) {
    Object.assign(this, { directory, assetDirectory, sessions, getCatalog, getOwner, getCwd, getPermission, openMain })
    this.getSkills = getSkills
    this.changed = changed || (() => {})
    this.voice = voice || new PetVoice(path.join(directory, 'voice-cache'))
    this.readAsset = readAsset || (file => fsp.readFile(file))
    this.busy = new Map()
    this.preparing = new Map()
    this.installing = new Map()
    this.speechEpoch = new Map()
    this.taskEpoch = new Map()
    this.startSignatures = new Map()
    this.assetCache = new Map()
    this.installCache = new Map()
    this.ownerEpoch = 0
    this.owner = ''
    this.settings = { characters: {} }
    this.links = new PetLinks(this)
    this.unsubscribe = sessions.subscribe(event => this.onEvent(event))
    this.refreshOwner()
  }
  refreshOwner() {
    const owner = String(this.getOwner() || '')
    if (owner === this.owner && this.file) return
    this.links.reset()
    this.memory?.close()
    const previousSessions = Object.keys(this.settings.sessions || {})
    this.owner = owner
    this.ownerEpoch++
    const account = crypto.createHash('sha256').update(owner || 'guest').digest('hex').slice(0, 24)
    this.file = path.join(this.directory, 'accounts', account, 'settings.json')
    this.settings = { characters: {}, sessions: {} }
    try { this.settings = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch {}
    if (!this.settings || !this.settings.characters || typeof this.settings.characters !== 'object') this.settings = { characters: {} }
    this.settings.sessions ||= {}
    this.memory = null; this.memoryError = ''
    if (owner) {
      try { this.memory = new PetMemory(path.join(path.dirname(this.file), 'memory'), CHARACTERS) }
      catch (error) { this.memoryError = error.message }
    }
    for (const character of CHARACTERS) {
      const config = this.config(character.id)
      if (config.sessionId && !this.settings.sessions[config.sessionId]) this.settings.sessions[config.sessionId] = { id: character.id, systemPrompt: this.systemPrompt(character.id, config) }
    }
    const memory = this.memory, epoch = this.ownerEpoch
    this.memoryReady = memory ? importPetMemory(this, memory, { ...this.settings.sessions }, epoch).catch(error => {
      if (this.memory === memory && !memory.closed) this.memoryFailure(error)
    }) : Promise.resolve()
    this.startSignatures.clear()
    this.busy.clear()
    this.preparing.clear()
    for (const character of CHARACTERS) {
      this.speechEpoch.set(character.id, (this.speechEpoch.get(character.id) || 0) + 1)
      this.taskEpoch.set(character.id, (this.taskEpoch.get(character.id) || 0) + 1)
    }
    for (const sessionId of previousSessions) if (this.sessions.runs.has(sessionId)) void this.sessions.abort({ sessionId }).catch(() => {})
  }
  assertOwner(epoch) {
    if (epoch !== this.ownerEpoch || this.owner !== String(this.getOwner() || '')) throw new Error('登录账户已改变，请重新操作')
  }
  ownsSession(sessionId) {
    this.refreshOwner()
    const parent = this.sessions.sessions?.get(sessionId)?.parentSessionId
    if (parent?.startsWith('pet:')) return this.ownsSession(parent)
    return !String(sessionId || '').startsWith('pet:') || Boolean(this.owner && this.settings.sessions?.[sessionId])
  }
  assertSession(sessionId) {
    if (!this.ownsSession(sessionId)) throw new Error('此角色会话不属于当前登录账户')
  }
  systemPrompt(id, config = this.config(id)) {
    return [this.character(id).persona, '你通过 AnyuAgent 桌面伙伴与用户交流。普通聊天自然简短；任务需要时使用工具，保持原有权限、审批与事实标准。角色设定不改变模型的实际能力。亲昵是用户选择的虚拟陪伴风格，尊重用户边界和现实人际关系，不要求排他、不用内疚感挽留，不虚构线下经历或未保存的记忆。', config.prefix ? `用户设定的角色提示词前缀：\n${config.prefix}` : ''].filter(Boolean).join('\n\n')
  }
  sessionOptions(sessionId) {
    this.assertSession(sessionId)
    const entry = this.settings.sessions?.[sessionId]
    if (!entry) return {}
    const config = this.config(entry.id)
    return { systemPrompt: config.sessionId === sessionId ? this.systemPrompt(entry.id, config) : entry.systemPrompt }
  }
  character(id) {
    const character = CHARACTERS.find(item => item.id === id)
    if (!character) throw new Error('角色不存在')
    return character
  }
  config(id) {
    return resolveConfig(this.character(id), this.settings.characters[id])
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(this.settings, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }
  assetFile(id) { return path.join(this.directory, 'characters', this.character(id).id, 'character.png') }
  installed(id) {
    const file = this.assetFile(id)
    try {
      const stat = fs.statSync(file), key = `${stat.size}:${stat.mtimeMs}`
      if (this.installCache.get(file)?.key === key) return this.installCache.get(file).valid
      const header = Buffer.alloc(32), fd = fs.openSync(file, 'r')
      try { fs.readSync(fd, header, 0, header.length, 0) } finally { fs.closeSync(fd) }
      const valid = stat.size > 32 && png(header)
      this.installCache.set(file, { key, valid })
      return valid
    } catch { return false }
  }
  preview(id, installed = false) {
    const file = installed ? this.assetFile(id) : path.join(this.assetDirectory, `${this.character(id).id}-preview.png`)
    if (!this.assetCache.has(file)) {
      try { const bytes = fs.readFileSync(file); if (png(bytes)) this.assetCache.set(file, `data:image/png;base64,${bytes.toString('base64')}`) } catch {}
    }
    return this.assetCache.get(file) || ''
  }
  state() {
    this.refreshOwner()
    return { authenticated: Boolean(this.owner), voices: VOICES, characters: CHARACTERS.map(character => ({ ...character, preview: this.preview(character.id), installed: this.installed(character.id), installing: this.installing.has(character.id), config: this.config(character.id), busy: this.isBusy(character.id) })) }
  }
  notify() { this.changed({ type: 'state', state: this.state() }) }
  isBusy(id) { return Boolean(this.links.active(id)) || this.busy.has(id) || this.sessions.runs.has(this.config(id).sessionId) }
  async install(id) {
    this.character(id)
    if (this.installing.has(id)) return this.installing.get(id)
    const task = (async () => {
      this.changed({ type: 'download', id, progress: 0 })
      const bytes = await this.readAsset(path.join(this.assetDirectory, this.character(id).asset))
      if (!png(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('角色资源损坏，请重新安装最新版桌面端')
      const file = this.assetFile(id)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${crypto.randomUUID()}.tmp`
      try {
        await fsp.writeFile(temporary, bytes)
        const verified = await fsp.readFile(temporary)
        if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(bytes).digest(), crypto.createHash('sha256').update(verified).digest())) throw new Error('资源校验失败')
        await fsp.rename(temporary, file)
      } finally { await fsp.rm(temporary, { force: true }).catch(() => {}) }
      this.assetCache.delete(file)
      this.changed({ type: 'download', id, progress: 100 })
    })()
    this.installing.set(id, task)
    try { await task } finally { this.installing.delete(id); this.notify() }
    return this.state()
  }
  async uninstall(id) {
    if (this.installing.has(id)) throw new Error('角色资源正在安装，请等待完成')
    if (this.isBusy(id)) throw new Error('角色正在执行任务，请先停止任务')
    await this.save(id, { enabled: false })
    await fsp.rm(this.assetFile(id), { force: true })
    this.assetCache.delete(this.assetFile(id))
    this.notify()
    return this.state()
  }
  async save(id, input) {
    this.refreshOwner()
    const ownerEpoch = this.ownerEpoch
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('角色配置无效')
    if (input.enabled && !this.owner) throw new Error('请先登录 AnyuAgent')
    const current = this.config(id)
    const next = {}
    for (const name of ['enabled', 'sounds']) if (typeof input[name] === 'boolean') next[name] = input[name]
    if (input.prefix !== undefined) next.prefix = String(input.prefix).slice(0, 6000)
    if (input.model !== undefined) {
      if (input.model === null) next.model = null
      else {
        const catalog = await this.getCatalog()
        this.assertOwner(ownerEpoch)
        const selected = catalog.models?.find(model => modelKey(model) === modelKey(input.model))
        if (!selected) throw new Error('所选分组模型已不可用，请刷新模型目录')
        next.model = { id: selected.id, group_id: selected.group_id, api: selected.api }
      }
    }
    if (input.voice !== undefined) {
      if (!VOICES.some(voice => voice.id === input.voice)) throw new Error('音色不可用')
      next.voice = input.voice
    }
    if (input.speech !== undefined) {
      if (!['natural', 'system', 'off'].includes(input.speech)) throw new Error('语音模式无效')
      next.speech = input.speech === 'system' ? 'natural' : input.speech
    }
    for (const [name, min, max] of [['scale', 0.65, 1.6], ['rate', -30, 35], ['pitch', -15, 20], ['volume', 0, 1]]) if (input[name] !== undefined) next[name] = bounded(input[name], min, max, current[name])
    if (input.position && Number.isFinite(input.position.x) && Number.isFinite(input.position.y)) next.position = { x: Math.round(input.position.x), y: Math.round(input.position.y) }
    this.assertOwner(ownerEpoch)
    const latest = this.config(id)
    const merged = { ...latest, ...next }
    if (merged.enabled && !this.installed(id)) throw new Error('请先安装角色资源')
    if (this.isBusy(id) && (modelKey(merged.model) !== modelKey(latest.model) || merged.prefix !== latest.prefix)) throw new Error('任务正在运行，完成或停止后再更改模型和提示词')
    if (!merged.enabled) await this.links.disconnect(id)
    this.assertOwner(ownerEpoch)
    this.settings.characters[id] = merged
    if (!merged.enabled || merged.speech === 'off') {
      this.speechEpoch.set(id, (this.speechEpoch.get(id) || 0) + 1)
      this.changed({ type: 'silence', id })
    }
    this.persist()
    this.notify()
    return this.state()
  }
  async models() { return (await this.getCatalog()).models || [] }
  memoryFailure(error, id) {
    this.memoryError = `记忆保存或读取失败：${error.message || error}`
    this.changed({ type: 'memory-error', id, error: this.memoryError })
  }
  async readyMemory() {
    const epoch = this.ownerEpoch
    await this.memoryReady
    this.assertOwner(epoch)
    if (!this.owner || !this.memory) throw new Error(this.memoryError || '请先登录 AnyuAgent')
    return this.memory
  }
  async memoryState(id, options) {
    this.refreshOwner(); this.character(id)
    const memory = await this.readyMemory()
    return { directory: memory.folder(id), notes: memory.notes(id), ...memory.history(id, options), warning: this.memoryError }
  }
  async prompt(id, input) {
    this.refreshOwner()
    const owner = this.owner
    const ownerEpoch = this.ownerEpoch
    if (!owner) throw new Error('请先登录 AnyuAgent')
    if (this.isBusy(id)) throw new Error('这个角色正在回复，请等待或停止后再发送')
    const config = this.config(id)
    const message = String(input.message || '').trim()
    const images = Array.isArray(input.images) ? input.images : []
    const references = normalizeReferences(input.references)
    if (message.length > 100000 || images.length > 6) throw new Error('消息或图片数量超过限制')
    if (!message && !images.length && !references.length) throw new Error('请输入消息或添加参考内容')
    for (const image of images) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) || typeof image.data !== 'string' || image.data.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/.test(image.data)) throw new Error('图片格式无效或超过 10 MB')
    }
    if (images.reduce((size, image) => size + image.data.length, 0) > 32 * 1024 * 1024) throw new Error('图片总大小过大，请缩小图片后重试')
    if (!config.model) throw new Error('请在设置中为角色选择模型')
    const token = {}
    this.busy.set(id, token)
    this.speechEpoch.set(id, (this.speechEpoch.get(id) || 0) + 1)
    this.taskEpoch.set(id, (this.taskEpoch.get(id) || 0) + 1)
    const epoch = this.taskEpoch.get(id)
    const preparing = { requestId: String(input.requestId || crypto.randomUUID()).slice(0, 128), message, attachments: images, references }
    this.preparing.set(id, preparing)
    this.changed({ type: 'preparing', id, request: preparing })
    this.changed({ type: 'silence', id })
    try {
      const memory = await this.readyMemory()
      await validateReferences(references)
      const skills = referencedSkills(message, await this.getSkills())
      const recalled = memory.context(id, { query: message, exclude: config.sessionId })
      const modelMessage = [referencePrompt(message, references, skills), recalled].filter(Boolean).join('\n\n')
      this.assertOwner(ownerEpoch)
      if (epoch !== this.taskEpoch.get(id)) throw new Error('任务已取消')
      const catalog = await this.getCatalog()
      this.assertOwner(ownerEpoch)
      if (epoch !== this.taskEpoch.get(id)) throw new Error('任务已取消')
      const model = catalog.models?.find(model => modelKey(model) === modelKey(config.model))
      if (!model) throw new Error('角色绑定的分组模型已不可用，请在设置中重新选择')
      if (!config.sessionId) {
        config.sessionId = `pet:${id}:${crypto.randomUUID()}`
        this.settings.characters[id] = { ...this.config(id), sessionId: config.sessionId }
        this.settings.sessions[config.sessionId] = { id, systemPrompt: this.systemPrompt(id, config) }
        this.persist()
      }
      const systemPrompt = this.systemPrompt(id, config)
      const cwd = this.getCwd()
      const permissionMode = this.getPermission()
      const signature = JSON.stringify([modelKey(model), systemPrompt, cwd, permissionMode])
      const record = this.sessions.sessions?.get(config.sessionId)
      const changed = record && (modelKey(record.models?.[0]) !== modelKey(model) || record.runtimeOptions?.systemPrompt !== systemPrompt)
      await this.sessions.start({ sessionId: config.sessionId, accessMode: 'managed', model: model.id, provider: model.provider, models: [model], cwd, permissionMode, force: Boolean(changed || this.startSignatures.get(id) !== signature), runtimeOptions: { systemPrompt } })
      this.assertOwner(ownerEpoch)
      if (epoch !== this.taskEpoch.get(id)) throw new Error('任务已取消')
      this.startSignatures.set(id, signature)
      let imageAttachmentId
      if (images.length || references.length || skills.length || recalled) {
        imageAttachmentId = `pet-image:${crypto.randomUUID()}`
        const file = this.attachmentFile(imageAttachmentId)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ images, references, message }), { mode: 0o600 })
      }
      this.settings.sessions[config.sessionId] = { id, systemPrompt }
      this.persist()
      return await this.sessions.prompt({ sessionId: config.sessionId, message: modelMessage, imageAttachmentId, images: images.map(image => ({ ...image, type: 'image' })) })
    } catch (error) {
      if (this.preparing.get(id) === preparing && ownerEpoch === this.ownerEpoch) {
        this.preparing.delete(id)
        this.changed({ type: 'prepare-failed', id, requestId: preparing.requestId, error: error.message, cancelled: epoch !== this.taskEpoch.get(id) })
      }
      throw error
    } finally { if (this.busy.get(id) === token) this.busy.delete(id); this.notify() }
  }
  attachmentFile(id) {
    id = String(id || '').replace(/^pet-image:/, '')
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('图片标识无效')
    return path.join(path.dirname(this.file), 'attachments', `${id}.json`)
  }
  attachments(id) {
    return this.attachmentContext(id).images
  }
  attachmentContext(id) {
    try {
      const saved = JSON.parse(fs.readFileSync(this.attachmentFile(id), 'utf8'))
      return Array.isArray(saved) ? { images: saved, references: [] } : saved
    } catch { return { images: [], references: [] } }
  }
  rememberAttachments(payload) {
    const sessionId = payload.sessionId || payload.conversationId
    if (!String(sessionId || '').startsWith('pet:') || !payload.images?.length || !payload.imageAttachmentId) return
    this.assertSession(sessionId)
    const file = this.attachmentFile(payload.imageAttachmentId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(payload.images), { mode: 0o600 })
  }
  snapshot(id, options = {}) {
    this.refreshOwner()
    const config = this.config(id)
    const result = config.sessionId ? this.sessions.snapshot({ sessionId: config.sessionId, beforeSeq: Number(options.beforeSeq) || 0 }) : { messages: [] }
    return { ...result, messages: result.messages.map(message => {
      const context = this.attachmentContext(message.imageAttachmentId)
      return { ...message, content: context.message ?? message.content, attachments: context.images, references: context.references }
    }), pending: this.preparing.get(id) || null, sessionId: config.sessionId, busy: this.isBusy(id), activeRunId: this.sessions.runs.get(config.sessionId)?.runId || '', approval: this.sessions.approvals?.get(config.sessionId)?.request || null }
  }
  async abort(id) {
    this.refreshOwner()
    await this.links.disconnect(id)
    const sessionId = this.config(id).sessionId
    this.taskEpoch.set(id, (this.taskEpoch.get(id) || 0) + 1)
    this.speechEpoch.set(id, (this.speechEpoch.get(id) || 0) + 1)
    this.changed({ type: 'silence', id })
    if (sessionId && this.sessions.runs.has(sessionId)) await this.sessions.abort({ sessionId })
    this.notify()
  }
  newChat(id) {
    this.refreshOwner()
    if (this.isBusy(id)) throw new Error('请先停止当前任务')
    this.links.dismiss(id)
    this.settings.characters[id] = { ...this.config(id), sessionId: '' }
    this.startSignatures.delete(id)
    this.persist()
    this.changed({ type: 'reset', id })
    this.notify()
    return this.snapshot(id)
  }
  onEvent(event) {
    this.refreshOwner()
    const owned = this.settings.sessions[event.sessionId]
    if (owned && !event.sessionId.includes(':link:') && this.memory) {
      try {
        if (event.type === 'run.started') {
          const context = this.attachmentContext(event.imageAttachmentId)
          this.memory.append(owned.id, [{ key: `${event.runId}:user`, conversation: event.sessionId, kind: 'personal', speaker: 'user', text: context.message ?? event.input ?? '', at: event.at }])
        } else if (event.type === 'run.finished' && event.status === 'completed') {
          this.memory.append(owned.id, [{ key: `${event.runId}:assistant`, conversation: event.sessionId, kind: 'personal', speaker: owned.id, text: event.text || '', at: event.at }])
        }
      } catch (error) { this.memoryFailure(error, owned.id) }
    }
    const character = CHARACTERS.find(item => this.config(item.id).sessionId === event.sessionId)
    if (!character) return
    const preparing = event.type === 'run.started' ? this.preparing.get(character.id) : null
    if (event.type === 'run.started') {
      this.preparing.delete(character.id)
      this.speechEpoch.set(character.id, (this.speechEpoch.get(character.id) || 0) + 1)
      this.changed({ type: 'silence', id: character.id })
    }
    const context = event.imageAttachmentId ? this.attachmentContext(event.imageAttachmentId) : null
    this.changed({ type: 'agent', id: character.id, event: { ...event, ...(preparing ? { requestId: preparing.requestId } : {}), ...(context ? { input: context.message ?? event.input, attachments: context.images, references: context.references } : {}) } })
    if (event.type === 'run.finished' && event.status === 'completed' && event.text) {
      const epoch = this.speechEpoch.get(character.id)
      const owner = this.owner
      const config = this.config(character.id)
      if (!config.enabled) return
      void this.voice.speak(event.text, config).then(audio => {
        if (epoch === this.speechEpoch.get(character.id) && owner === this.owner && this.config(character.id).enabled) this.changed({ type: 'speech', id: character.id, audio, volume: config.volume })
      }).catch(() => {})
    }
  }
  async previewVoice(id, input = {}) {
    const config = this.config(id)
    const voice = VOICES.find(item => item.id === input.voice) || VOICES.find(item => item.id === config.voice)
    return this.voice.speak(voice.preview || `你好，我是${this.character(id).name}。今天过得怎么样？我会在这里陪着你，我们慢慢来。`, { ...config, voice: voice.id, speech: ['natural', 'system', 'off'].includes(input.speech) ? input.speech : config.speech, rate: bounded(input.rate, -30, 35, config.rate), pitch: bounded(input.pitch, -15, 20, config.pitch) })
  }
  close() { this.links.close(); this.unsubscribe?.(); this.memory?.close(); for (const character of CHARACTERS) this.speechEpoch.set(character.id, (this.speechEpoch.get(character.id) || 0) + 1) }
}

module.exports = { PetManager, modelKey }
