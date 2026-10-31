'use strict'

const path = require('node:path')
const { PetManager } = require('./pet-manager.cjs')
const { PetWindows } = require('./pet-windows.cjs')
const behaviors = require('./pets/behaviors.js')
const { validateReferences } = require('./pet-references.cjs')

function createPets({ app, BrowserWindow, screen, ipcMain, mainWindow, sessions, getCatalog, getOwner, getCwd, getPermission, getSkills = () => [], chooseReferences, openMemoryDirectory, openMain, openExternal }) {
  let windows
  const manager = new PetManager({
    directory: path.join(app.getPath('userData'), 'desktop-pets'),
    assetDirectory: path.join(__dirname, 'pets', 'assets'),
    sessions, getCatalog, getOwner, getCwd, getPermission, getSkills,
    changed: event => {
      if (event.type === 'state') windows?.sync()
      if (event.type === 'links-layout') windows?.syncLinks(event.links)
      windows?.send(event)
      const main = mainWindow()
      if (main && !main.isDestroyed()) main.webContents.send('pet:event', event)
    },
  })
  windows = new PetWindows({ BrowserWindow, screen, manager, directory: __dirname, openMain })
  const state = () => ({ ...manager.state(), behaviors: behaviors.all.map(({ id, name, category }) => ({ id, name, category })), counts: { expressions: behaviors.expressions.length, actions: behaviors.actions.length } })
  ipcMain.handle('pet:command', async (event, action, input = {}) => {
    const isMain = event.sender === mainWindow()?.webContents
    const identity = windows.identity(event.sender)
    if ((!isMain && !identity) || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) throw new Error('桌宠请求来源无效')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求参数无效')
    manager.refreshOwner()
    if (action === 'state' && isMain) return state()
    if (action === 'models' && isMain) return manager.models()
    if (action === 'attachment' && isMain) return manager.attachments(String(input.attachmentId || ''))
    const id = identity?.id || String(input.id || '')
    const character = manager.character(id)
    const config = manager.config(id)
    if (identity?.mode === 'chat' && ['memory-read', 'memory-save', 'memory-directory'].includes(action)) {
      const state = await manager.memoryState(id, input)
      if (action === 'memory-read') return state
      if (action === 'memory-save') return manager.memory.saveNotes(id, input.text, input.revision)
      if (!openMemoryDirectory) throw new Error('当前环境不能打开记忆目录')
      await openMemoryDirectory(state.directory)
      return { ok: true }
    }
    if (identity?.mode === 'chat' && ['skills', 'choose-references', 'references'].includes(action)) {
      if (!manager.owner) throw new Error('请先登录 AnyuAgent')
      const epoch = manager.ownerEpoch
      if (action === 'skills') {
        const skills = await getSkills()
        manager.assertOwner(epoch)
        return skills.map(({ id, name, description }) => ({ id, name, description }))
      }
      let references = input.references
      if (action === 'choose-references') {
        if (!['file', 'folder'].includes(input.kind)) throw new Error('参考类型无效')
        if (!chooseReferences) throw new Error('当前环境不支持文件选择')
        const paths = await chooseReferences(windows.windows.get(id).chat, input.kind)
        references = paths.map(path => ({ path, kind: input.kind }))
      }
      const result = await validateReferences(references)
      manager.assertOwner(epoch)
      return result
    }
    if (action === 'bootstrap' && identity) return { id, mode: identity.mode, nativeShape: Boolean(windows.windows.get(id)?.nativeShape), character: { ...character, config, preview: manager.preview(id), atlas: identity.mode === 'actor' ? manager.preview(id, true) : '' }, snapshot: manager.snapshot(id), link: manager.links.view(id) }
    if (action === 'ready' && identity) { windows.ready(id, identity.mode); return { ok: true } }
    if (action === 'link-options') return { link: manager.links.view(id), peers: manager.state().characters.filter(pet => pet.id !== id && pet.installed && pet.config.enabled).map(pet => ({ id: pet.id, name: pet.name, model: pet.config.model?.id || '', available: !pet.busy && Boolean(pet.config.model) })) }
    if (action === 'link-connect') return manager.links.connect(id, String(input.peerId || ''), input.topic)
    if (action === 'link-disconnect') return manager.links.disconnect(id)
    if (action === 'link-dismiss') { manager.links.dismiss(id); return manager.snapshot(id) }
    if (action === 'speech-ended' && identity?.mode === 'actor') { manager.links.speechEnded(id, input.linkId, input.speechId); return { ok: true } }
    if (action === 'link-open') { windows.chat(id, 'link'); return { ok: true } }
    if (action === 'install' && isMain) { await manager.install(id); return state() }
    if (action === 'uninstall' && isMain) { await manager.uninstall(id); return state() }
    if (action === 'save' && isMain) { await manager.save(id, input.config || {}); return state() }
    if (action === 'voice-preview' && isMain) return manager.previewVoice(id, input.config)
    if (action === 'snapshot') return manager.snapshot(id, input)
    if (action === 'open-url' && identity?.mode === 'chat') {
      const url = new URL(String(input.url || ''))
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('链接格式无效')
      await openExternal(url.href)
      return { ok: true }
    }
    if (action === 'prompt') return manager.prompt(id, input)
    if (action === 'abort') { await manager.abort(id); return { ok: true } }
    if (action === 'new-chat') return manager.newChat(id)
    if (action === 'approve') {
      if (!config.sessionId) throw new Error('会话尚未开始')
      if (!['allow', 'deny'].includes(input.decision)) throw new Error('审批选项无效')
      const request = sessions.approvals.get(config.sessionId)?.request
      if (!request || request.requestId !== input.requestId) throw new Error('这项确认已失效')
      if (input.decision === 'deny' && request.method !== 'confirm') { await manager.abort(id); return { ok: true } }
      return sessions.approve({ sessionId: config.sessionId, requestId: String(input.requestId || ''), decision: input.decision, value: input.value })
    }
    if (action === 'chat') {
      if (!manager.installed(id)) throw new Error('请先安装角色资源')
      if (!config.enabled) await manager.save(id, { enabled: true })
      windows.chat(id)
      return { ok: true }
    }
    if (action === 'close-chat') { windows.windows.get(id)?.chat?.hide(); return { ok: true } }
    if (action === 'settings' || action === 'expand') { openMain({ id, settings: action === 'settings', sessionId: config.sessionId, model: config.model }); return { ok: true } }
    if (action === 'interact') {
      const motion = behaviors.all.find(item => item.id === input.motion)
      if (!motion) throw new Error('动作不存在')
      if (!config.enabled) throw new Error('请先启用角色')
      windows.send({ type: 'motion', id, motion: motion.id })
      return { ok: true }
    }
    if (identity?.mode === 'actor') {
      if (action === 'hit-regions') return { ok: true, applied: windows.setHitRegions(id, input.regions) }
      if (action === 'hit-test') { windows.hitTest(id, input.interactive === true); return { ok: true } }
      if (action === 'drag-start') { windows.beginDrag(id, input.cursor); return { ok: true } }
      if (action === 'drag') { windows.drag(id, input.cursor); return { ok: true } }
      if (action === 'drag-end') { await windows.endDrag(id, input.cursor); return { ok: true } }
    }
    throw new Error('不支持的桌宠操作')
  })
  return {
    manager, windows,
    sync: () => { manager.refreshOwner(); windows.sync(); windows.send({ type: 'state', state: state() }) },
    close: () => { manager.close(); windows.close(); ipcMain.removeHandler('pet:command') },
  }
}

module.exports = { createPets }
