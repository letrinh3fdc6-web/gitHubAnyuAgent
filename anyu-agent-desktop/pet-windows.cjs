'use strict'

const path = require('node:path')

function pointerPoint(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) < 100000 && Math.abs(value.y) < 100000 ? { x: value.x, y: value.y } : null
}

function fitBounds(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width), height = Math.min(bounds.height, workArea.height)
  return { x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, bounds.x))), y: Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, bounds.y))), width: Math.round(width), height: Math.round(height) }
}

class PetWindows {
  constructor({ BrowserWindow, screen, manager, directory, openMain }) {
    Object.assign(this, { BrowserWindow, screen, manager, directory, openMain })
    this.windows = new Map()
    this.drags = new Map()
    this.reposition = () => this.sync()
    screen.on('display-removed', this.reposition)
    screen.on('display-metrics-changed', this.reposition)
    // Forwarded Chromium mousemoves can stop across overlapping transparent windows.
    // Probe only actors under the native cursor; other actors remain click-through.
    this.pointerTimer = setInterval(() => this.probePointer(), 80)
    this.pointerTimer.unref?.()
  }
  identity(sender) {
    for (const [id, pair] of this.windows) for (const mode of ['actor', 'chat']) if (pair[mode]?.webContents === sender) return { id, mode }
    return null
  }
  create(id, mode) {
    const character = this.manager.state().characters.find(item => item.id === id)
    const pair = this.windows.get(id) || {}
    if (pair[mode] && !pair[mode].isDestroyed()) return pair[mode]
    const area = character.config.position ? this.screen.getDisplayNearestPoint(character.config.position).workArea : this.screen.getPrimaryDisplay().workArea
    const scale = character.config.scale
    const size = mode === 'actor' ? { width: Math.round(280 * scale), height: Math.round(330 * scale) } : { width: 410, height: 560 }
    const position = character.config.position || { x: area.x + area.width - size.width - 30 - this.windows.size * 50, y: area.y + area.height - size.height }
    const win = new this.BrowserWindow({
      ...fitBounds({ ...position, ...size }, area), title: `${character.name} · AnyuAgent`, show: false,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: mode === 'chat',
      resizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: mode === 'chat',
      webPreferences: { preload: path.join(this.directory, 'pet-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: mode !== 'actor', autoplayPolicy: 'no-user-gesture-required' },
    })
    pair[mode] = win
    pair[`${mode}Ready`] = false
    if (mode === 'actor') {
      pair.acceptsPointer = undefined
      pair.pointerInside = undefined
      pair.shapeKey = ''
      pair.pointerDown = false
      pair.nativeShape = process.platform === 'win32' && typeof win.setShape === 'function'
      if (pair.nativeShape) {
        win.setShape([{ x: 0, y: 0, width: 1, height: 1 }])
        win.setIgnoreMouseEvents(false)
        pair.acceptsPointer = true
      }
    }
    this.windows.set(id, pair)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('will-redirect', event => event.preventDefault())
    win.webContents.on('did-start-loading', () => {
      pair[`${mode}Ready`] = false
      if (mode === 'actor') { pair.shapeKey = ''; pair.pointerDown = false; void this.endDrag(id).catch(() => {}) }
    })
    if (mode === 'actor') win.webContents.on('before-mouse-event', (_event, mouse) => {
      // Lock shape changes at native mouse-down, before the renderer can start its drag.
      if (mouse.type === 'mouseDown' && mouse.button === 'left') pair.pointerDown = true
      const released = mouse.type === 'mouseUp' && mouse.button === 'left'
      const unpressedMove = mouse.type === 'mouseMove' && Array.isArray(mouse.modifiers) && !mouse.modifiers.includes('leftButtonDown')
      if (released || unpressedMove) pair.pointerDown = false
      if (!this.drags.has(id)) return
      if (!released && !unpressedMove) return
      const cursor = pointerPoint({ x: mouse.globalX, y: mouse.globalY })
      void this.endDrag(id, released ? cursor : null).catch(() => {})
      if (!win.isDestroyed()) win.webContents.send('pet:event', { type: 'drag-release', id, cursor: released ? cursor : null })
    })
    win.once('ready-to-show', () => { if (!win.isDestroyed()) mode === 'actor' ? win.showInactive() : win.show() })
    win.on('closed', () => { if (pair[mode] === win) delete pair[mode] })
    void win.loadFile(path.join(this.directory, 'pets', 'index.html'), { query: { mode } })
    return win
  }
  sync() {
    const state = this.manager.state()
    if (this.owner !== this.manager.owner) {
      for (const id of [...this.windows.keys()]) this.closeCharacter(id)
      this.owner = this.manager.owner
    }
    for (const character of state.characters) {
      const id = character.id
      if (!state.authenticated || !character.config.enabled || !character.installed) { this.closeCharacter(id); continue }
      const actor = this.create(id, 'actor')
      const old = actor.getBounds()
      const area = this.screen.getDisplayMatching(old).workArea
      actor.setBounds(fitBounds({ ...old, ...(!this.drags.has(id) && character.config.position || {}), width: Math.round(280 * character.config.scale), height: Math.round(330 * character.config.scale) }, area))
      this.placeChat(id)
    }
    this.syncLinks()
  }
  syncLinks(links = this.manager.links.list()) {
    const lines = links.flatMap(link => {
      const actors = link.participants.map(id => this.windows.get(id)?.actor)
      if (actors.some(actor => !actor || actor.isDestroyed())) return []
      const [a, b] = actors.map(actor => actor.getBounds())
      const direction = b.x + b.width / 2 >= a.x + a.width / 2 ? 1 : -1
      return [{ id: link.id, x1: a.x + a.width * (.5 + direction * .3), y1: a.y + a.height * .5, x2: b.x + b.width * (.5 - direction * .3), y2: b.y + b.height * .5, color: link.characters[0].color }]
    })
    if (!lines.length) { this.linkWindow?.destroy(); this.linkWindow = null; this.linkLayout = ''; return }
    const xs = lines.flatMap(line => [line.x1, line.x2]), ys = lines.flatMap(line => [line.y1, line.y2])
    const x = Math.floor(Math.min(...xs) - 12), y = Math.floor(Math.min(...ys) - 12)
    const bounds = { x, y, width: Math.ceil(Math.max(...xs) - x + 12), height: Math.ceil(Math.max(...ys) - y + 12) }
    const data = { type: 'link-lines', lines: lines.map(line => ({ ...line, x1: line.x1 - x, y1: line.y1 - y, x2: line.x2 - x, y2: line.y2 - y })) }
    const layout = JSON.stringify([bounds, data])
    if (layout === this.linkLayout) return
    this.linkLayout = layout
    if (!this.linkWindow || this.linkWindow.isDestroyed()) {
      const win = new this.BrowserWindow({ ...bounds, show: false, frame: false, transparent: true, hasShadow: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, webPreferences: { preload: path.join(this.directory, 'pet-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
      this.linkWindow = win
      win.setIgnoreMouseEvents(true)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', event => event.preventDefault())
      win.once('ready-to-show', () => { if (!win.isDestroyed()) { this.linkLayout = ''; this.syncLinks(); win.showInactive() } })
      void win.loadFile(path.join(this.directory, 'pets', 'link-lines.html'))
    }
    this.linkWindow.setBounds(bounds)
    this.linkWindow.webContents.send('pet:event', data)
  }
  placeChat(id) {
    const pair = this.windows.get(id)
    if (!pair?.chat || pair.chat.isDestroyed() || !pair.actor) return
    const actor = pair.actor.getBounds(), area = this.screen.getDisplayMatching(actor).workArea
    const width = 410, height = 560
    const x = actor.x + actor.width + width + 10 <= area.x + area.width ? actor.x + actor.width + 8 : actor.x - width - 8
    pair.chat.setBounds(fitBounds({ x, y: actor.y + actor.height - height, width, height }, area))
  }
  chat(id, intent) {
    this.create(id, 'actor')
    const pair = this.windows.get(id)
    if (intent) pair.chatIntent = intent
    const win = this.create(id, 'chat')
    this.placeChat(id); win.show(); win.focus()
    this.flushIntent(id)
  }
  ready(id, mode) {
    const pair = this.windows.get(id)
    if (!pair) return
    pair[`${mode}Ready`] = true
    if (mode === 'chat') this.flushIntent(id)
  }
  flushIntent(id) {
    const pair = this.windows.get(id)
    if (!pair?.chatReady || !pair.chatIntent || !pair.chat || pair.chat.isDestroyed()) return
    const intent = pair.chatIntent; pair.chatIntent = null
    if (intent === 'link') pair.chat.webContents.send('pet:event', { type: 'link-menu', id })
  }
  send(event) {
    const entries = event.id ? [[event.id, this.windows.get(event.id)]] : [...this.windows]
    for (const [, pair] of entries) for (const win of [pair?.actor, pair?.chat]) if (win && !win.isDestroyed()) win.webContents.send('pet:event', event)
  }
  beginDrag(id, cursor) {
    const actor = this.windows.get(id)?.actor
    if (actor) {
      this.hitTest(id, true)
      this.drags.set(id, { cursor: pointerPoint(cursor) || this.screen.getCursorScreenPoint(), bounds: actor.getBounds() })
    }
  }
  probePointer() {
    const cursor = this.screen.getCursorScreenPoint()
    for (const [id, pair] of this.windows) {
      const actor = pair.actor
      if (!pair.actorReady || !actor || actor.isDestroyed() || !actor.isVisible() || this.drags.has(id)) continue
      const bounds = actor.getBounds()
      const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height
      if (inside) actor.webContents.send('pet:event', { type: 'pointer-probe', id, x: cursor.x - bounds.x, y: cursor.y - bounds.y, cursor })
      else if (pair.pointerInside !== false) {
        this.hitTest(id, false)
        actor.webContents.send('pet:event', { type: 'pointer-outside', id })
      }
      pair.pointerInside = inside
    }
  }
  drag(id, point) {
    const drag = this.drags.get(id), actor = this.windows.get(id)?.actor
    if (!drag || !actor) return
    const cursor = pointerPoint(point) || this.screen.getCursorScreenPoint()
    const bounds = { ...drag.bounds, x: drag.bounds.x + cursor.x - drag.cursor.x, y: drag.bounds.y + cursor.y - drag.cursor.y }
    actor.setBounds(fitBounds(bounds, this.screen.getDisplayNearestPoint(cursor).workArea))
    this.placeChat(id)
    this.syncLinks()
  }
  async endDrag(id, cursor) {
    const pair = this.windows.get(id)
    if (pair) { pair.pointerDown = false; pair.shapeKey = '' }
    if (!this.drags.has(id)) return
    if (pointerPoint(cursor)) this.drag(id, cursor)
    this.drags.delete(id)
    const actor = this.windows.get(id)?.actor
    if (actor) { const { x, y } = actor.getBounds(); await this.manager.save(id, { position: { x, y } }) }
  }
  hitTest(id, interactive) {
    const pair = this.windows.get(id), actor = pair?.actor
    if (pair?.nativeShape) return
    const next = Boolean(interactive || this.drags.has(id))
    if (actor && !actor.isDestroyed() && pair.acceptsPointer !== next) {
      pair.acceptsPointer = next
      actor.setIgnoreMouseEvents(!next, { forward: true })
    }
  }
  setHitRegions(id, regions) {
    const pair = this.windows.get(id), actor = pair?.actor
    if (!pair?.nativeShape || !actor || actor.isDestroyed() || pair.pointerDown || this.drags.has(id)) return false
    if (!Array.isArray(regions) || regions.length > 64) throw new Error('Invalid pet hit regions')
    const { width, height } = actor.getBounds()
    const shape = regions.flatMap(rect => {
      if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width <= 0 || rect.height <= 0) throw new Error('Invalid pet hit region')
      const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y))
      const right = Math.min(width, Math.ceil(rect.x + rect.width)), bottom = Math.min(height, Math.ceil(rect.y + rect.height))
      return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : []
    })
    if (!shape.length) shape.push({ x: 0, y: 0, width: 1, height: 1 })
    const key = JSON.stringify(shape)
    if (key === pair.shapeKey) return true
    actor.setShape(shape)
    pair.shapeKey = key
    return true
  }
  closeCharacter(id) {
    const pair = this.windows.get(id)
    this.drags.delete(id)
    for (const win of [pair?.actor, pair?.chat]) if (win && !win.isDestroyed()) win.destroy()
    this.windows.delete(id)
  }
  close() {
    clearInterval(this.pointerTimer)
    this.linkWindow?.destroy(); this.linkWindow = null
    this.screen.removeListener('display-removed', this.reposition)
    this.screen.removeListener('display-metrics-changed', this.reposition)
    for (const id of [...this.windows.keys()]) this.closeCharacter(id)
  }
}

module.exports = { PetWindows, fitBounds }
