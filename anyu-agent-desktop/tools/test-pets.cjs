'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PetManager } = require('../pet-manager.cjs')
const { PetVoice, spokenText } = require('../pet-voice.cjs')
const { AgentOrchestrator } = require('../agent-orchestrator.cjs')
const { PetWindows, fitBounds } = require('../pet-windows.cjs')
const { validateReferences, referencedSkills } = require('../pet-references.cjs')
const { CHARACTERS, VOICES, defaults, resolveConfig } = require('../pet-catalog.cjs')
const behaviors = require('../pets/behaviors.js')
const { createHarness, models } = require('./pet-test-harness.cjs')
const { resolvePermissionMode: resolveExecutionPermission } = require('../agent-permissions.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function harness(t, options) { const h = createHarness(options); t.after(h.cleanup); return h }

// Execute the production wiring so a hardcoded permission cannot pass via mocks.
function mainPetPermission(readAgentPermissionMode) {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.cjs'), 'utf8')
  const resolverStart = source.indexOf('function resolvePermissionMode(requested) {')
  const resolverEnd = source.indexOf('\n}', resolverStart) + 2
  const start = source.indexOf('  desktopPets = createPets({')
  const end = source.indexOf('\n  pluginManager =', start)
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart && start >= 0 && end > start)
  const context = { app: {}, BrowserWindow: {}, screen: {}, ipcMain: {}, agentSessionService: {}, readAgentPermissionMode, resolveExecutionPermission, createPets: options => options }
  vm.runInNewContext(`${source.slice(resolverStart, resolverEnd)}\n${source.slice(start, end)}`, context)
  return context.desktopPets.getPermission
}

test('production pet wiring inherits the same persisted permission as ordinary conversations', () => {
  let mode = 'full'
  const getPermission = mainPetPermission(() => mode)
  for (const selected of ['full', 'confirm', 'auto', 'full']) {
    mode = selected
    assert.equal(getPermission(), resolveExecutionPermission(mode))
  }
})

test('cold sends expose a pending message before catalog or runtime initialization and reconcile exactly once', async t => {
  const gate = deferred(), h = harness(t, { beforeStart: () => gate.promise })
  await h.enable('mint')
  const pending = h.manager.prompt('mint', { requestId: 'cold-send', message: 'Visible immediately' })
  assert.equal(h.manager.snapshot('mint').pending.message, 'Visible immediately')
  assert.equal(h.events.find(event => event.type === 'preparing').request.requestId, 'cold-send')
  assert.equal(h.sessions.runs.size, 0)
  gate.resolve(); await pending
  assert.equal(h.manager.snapshot('mint').pending, null)
  assert.equal(h.events.filter(event => event.event?.type === 'run.started' && event.event.requestId === 'cold-send').length, 1)
  assert.equal(h.manager.snapshot('mint').messages.filter(message => message.role === 'user').length, 1)
  h.finish('mint')
})

test('cold-send failure exposes the request identity and releases pending state', async t => {
  const h = harness(t)
  await h.enable('mint')
  h.manager.getCatalog = async () => { throw new Error('catalog unavailable') }
  await assert.rejects(h.manager.prompt('mint', { requestId: 'failed-send', message: 'Keep this text visible' }), /catalog unavailable/)
  assert.equal(h.manager.snapshot('mint').pending, null)
  assert.equal(h.manager.isBusy('mint'), false)
  assert.equal(h.events.find(event => event.type === 'prepare-failed').requestId, 'failed-send')
})

test('link intent waits for renderer acknowledgement and is delivered only once', () => {
  const sent = [], pair = { chatReady: false, chatIntent: 'link', chat: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } } }
  const windows = Object.create(PetWindows.prototype)
  windows.windows = new Map([['mint', pair]])
  windows.flushIntent('mint')
  assert.equal(sent.length, 0)
  windows.ready('mint', 'actor')
  assert.equal(sent.length, 0)
  windows.ready('mint', 'chat'); windows.ready('mint', 'chat')
  assert.deepEqual(sent, [['pet:event', { type: 'link-menu', id: 'mint' }]])
})

test('active drag locks native hit testing and state refresh cannot reset its position', () => {
  const calls = [], current = { x: 350, y: 240, width: 280, height: 330 }
  const actor = { getBounds: () => current, setBounds: bounds => calls.push(bounds), isDestroyed: () => false, setIgnoreMouseEvents: ignore => calls.push(ignore) }
  const windows = Object.create(PetWindows.prototype)
  Object.assign(windows, { owner: 'same', manager: { owner: 'same', state: () => ({ authenticated: true, characters: [{ id: 'mint', installed: true, config: { enabled: true, scale: 1, position: { x: 50, y: 50 } } }] }) },
    windows: new Map([['mint', { actor }]]), drags: new Map([['mint', {}]]), create: () => actor,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }, placeChat() {}, syncLinks() {} })
  windows.hitTest('mint', false)
  assert.equal(calls[0], false)
  windows.sync()
  assert.deepEqual(calls[1], current)
})

test('drag completion uses the captured release point even after the physical cursor moves away', async () => {
  let bounds = { x: 40, y: 100, width: 280, height: 330 }, saved
  const actor = { getBounds: () => bounds, setBounds: value => { bounds = value }, isDestroyed: () => false, setIgnoreMouseEvents() {} }
  const windows = Object.create(PetWindows.prototype)
  Object.assign(windows, { windows: new Map([['mint', { actor }]]), drags: new Map(), placeChat() {}, syncLinks() {},
    manager: { save: async (_id, config) => { saved = config.position } },
    screen: { getCursorScreenPoint: () => ({ x: 1900, y: 20 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } })
  windows.beginDrag('mint', { x: 100, y: 200 })
  windows.drag('mint', { x: 190, y: 245 })
  await windows.endDrag('mint', { x: 210, y: 265 })
  assert.deepEqual(saved, { x: 150, y: 165 })
  await windows.endDrag('mint', { x: 1900, y: 20 })
  assert.deepEqual(actor.getBounds(), { x: 150, y: 165, width: 280, height: 330 })
  assert.equal(windows.drags.size, 0)
})

test('native cursor probes recover missing forwarded mousemoves and keep remote actors click-through', () => {
  const sent = [], changes = []
  const makeActor = x => ({ isVisible: () => true, isDestroyed: () => false, getBounds: () => ({ x, y: 0, width: 280, height: 330 }), webContents: { send: (_, event) => sent.push(event) }, setIgnoreMouseEvents: value => changes.push(value) })
  const windows = Object.create(PetWindows.prototype)
  let cursor = { x: 150, y: 100 }
  Object.assign(windows, { screen: { getCursorScreenPoint: () => cursor }, drags: new Map(), windows: new Map([
    ['orbit', { actor: makeActor(0), actorReady: true }], ['jelly', { actor: makeActor(400), actorReady: true }],
  ]) })
  windows.probePointer()
  assert.deepEqual(sent[0], { type: 'pointer-probe', id: 'orbit', x: 150, y: 100, cursor })
  assert.equal(sent[1].type, 'pointer-outside')
  windows.hitTest('orbit', true); windows.hitTest('orbit', true)
  assert.deepEqual(changes, [true, false], 'unchanged hit results must not reinstall native mouse hooks')
  windows.drags.set('orbit', {})
  sent.length = 0; windows.probePointer()
  assert.equal(sent.length, 0, 'polling must not interfere with captured drags')
  windows.drags.clear(); cursor = { x: 550, y: 100 }
  windows.probePointer()
  assert.equal(sent[0].type, 'pointer-outside')
  assert.equal(sent[1].id, 'jelly')
})

test('native hit regions retain immediate mouse input, bound geometry and avoid resetting capture', () => {
  const shapes = [], ignores = []
  const actor = { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 280, height: 330 }), setShape: value => shapes.push(value), setIgnoreMouseEvents: value => ignores.push(value) }
  const windows = Object.create(PetWindows.prototype)
  Object.assign(windows, { windows: new Map([['jelly', { actor, nativeShape: true, acceptsPointer: true }]]), drags: new Map() })
  windows.setHitRegions('jelly', [{ x: -4.5, y: 12.5, width: 20, height: 25 }, { x: 270, y: 325, width: 50, height: 20 }])
  assert.deepEqual(shapes[0], [{ x: 0, y: 12, width: 16, height: 26 }, { x: 270, y: 325, width: 10, height: 5 }])
  windows.setHitRegions('jelly', [{ x: -4.5, y: 12.5, width: 20, height: 25 }, { x: 270, y: 325, width: 50, height: 20 }])
  assert.equal(shapes.length, 1)
  windows.hitTest('jelly', false)
  windows.beginDrag('jelly', { x: 140, y: 130 })
  windows.setHitRegions('jelly', [{ x: 50, y: 30, width: 30, height: 30 }])
  assert.equal(shapes.length, 1, 'shape remains stable during pointer capture')
  assert.deepEqual(ignores, [], 'cursor polling and drag startup cannot toggle native mouse capture')
  windows.drags.clear()
  assert.throws(() => windows.setHitRegions('jelly', [{ x: NaN, y: 0, width: 1, height: 1 }]), /Invalid/)
  assert.throws(() => windows.setHitRegions('jelly', Array(65).fill({ x: 0, y: 0, width: 1, height: 1 })), /Invalid/)
  windows.setHitRegions('jelly', [])
  assert.deepEqual(shapes.at(-1), [{ x: 0, y: 0, width: 1, height: 1 }], 'empty shapes must not restore a full-window input region')
})

test('native mouseleave without button metadata does not cancel a captured drag', t => {
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send() {} })
    }
    isDestroyed() { return false }
    getBounds() { return this.bounds }
    setBounds(value) { this.bounds = value }
    setIgnoreMouseEvents() {}
    async loadFile() {}
    destroy() {}
  }
  const screen = Object.assign(new EventEmitter(), { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) })
  let saved
  const manager = { state: () => ({ characters: [{ id: 'orbit', name: 'Orbit', config: { position: { x: 40, y: 100 }, scale: 1 } }] }),
    links: { list: () => [] }, save: async (_id, input) => { saved = input.position } }
  const windows = new PetWindows({ BrowserWindow: Window, screen, manager, directory: '', openMain() {} }); t.after(() => windows.close())
  const actor = windows.create('orbit', 'actor')
  windows.beginDrag('orbit', { x: 100, y: 200 })
  actor.webContents.emit('before-mouse-event', {}, { type: 'mouseLeave', button: 'none' })
  assert.equal(windows.drags.has('orbit'), true)
  actor.webContents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left', globalX: 180, globalY: 245 })
  assert.equal(windows.drags.has('orbit'), false)
  assert.deepEqual(saved, { x: 120, y: 145 })
  windows.beginDrag('orbit', { x: 180, y: 245 })
  actor.webContents.emit('did-start-loading')
  assert.equal(windows.drags.has('orbit'), false, 'reload releases stale drag state instead of permanently skipping pointer recovery')
})

test('pet skills and file references reach the model while clean text and references replay after restart', async t => {
  const h = harness(t)
  const folder = path.join(h.directory, '参考资料'), file = path.join(folder, 'with spaces.txt')
  fs.mkdirSync(folder); fs.writeFileSync(file, 'fixture')
  const skill = { id: 'qa-files', name: '文件整理', path: path.join(h.directory, 'skills', 'qa-files') }
  h.manager.getSkills = () => [skill]
  await h.enable('orbit')
  const references = [{ path: file, kind: 'file' }, { path: folder, kind: 'folder' }]
  await h.manager.prompt('orbit', { message: '@qa-files 整理这些资料', references })
  const sent = h.commands.find(command => command.type === 'prompt')
  assert.match(sent.message, /SKILL\.md/)
  assert.ok(sent.message.includes(JSON.stringify(file)))
  assert.match(sent.message, /ANYU_TRAINING/)
  assert.equal(h.starts[0].permissionMode, 'confirm')
  h.finish('orbit')
  const restored = new PetManager(h.managerOptions); t.after(() => restored.close())
  const first = restored.snapshot('orbit').messages[0]
  assert.equal(first.content, '@qa-files 整理这些资料')
  assert.deepEqual(first.references.map(item => item.path), [file, folder])
  assert.deepEqual(first.attachments, [])
  restored.close()
  assert.equal(h.events.find(event => event.event?.type === 'run.started').event.input, first.content)
  await h.manager.prompt('orbit', { message: '', references })
  assert.match(h.commands.filter(command => command.type === 'prompt').at(-1).message, /用户附加的本地文件与文件夹/)
  h.finish('orbit')
  await assert.rejects(h.manager.prompt('orbit', { message: 'missing', references: [{ kind: 'file', path: path.join(folder, 'missing.txt') }] }), /不存在/)
  assert.equal(h.manager.isBusy('orbit'), false)
  assert.equal(h.manager.snapshot('orbit').pending, null)
})

test('reference validation rejects malformed paths and selects only exact installed skill mentions', async t => {
  const h = harness(t)
  await assert.rejects(validateReferences([{ path: 'relative.txt', kind: 'file' }]), /路径无效/)
  await assert.rejects(validateReferences([{ path: h.directory, kind: 'file' }]), /类型已改变/)
  await assert.rejects(validateReferences(Array(21).fill({ path: h.directory, kind: 'folder' })), /20/)
  assert.equal((await validateReferences([{ path: h.directory, kind: 'folder' }, { path: h.directory, kind: 'folder' }])).length, 1)
  const skills = [{ id: 'qa-files' }, { id: 'qa-design' }]
  assert.deepEqual(referencedSkills('test@example.com @qa-files, @qa-files-extra @qa-design。', skills), skills)
  assert.deepEqual(referencedSkills('test@qa-files @unknown', skills), [])
})

test('pets refresh permissions on the next turn without changing the active turn or losing history', async t => {
  let mode = 'confirm'
  const h = harness(t, { getPermission: mainPetPermission(() => mode) })
  await h.enable('mint')
  await h.manager.prompt('mint', { message: 'first task' })
  const sessionId = h.manager.config('mint').sessionId
  const record = h.sessions.sessions.get(sessionId)
  const sessionPath = record.piSessionPath
  mode = 'full'
  assert.equal(h.sessions.resolveRuntime(sessionPath).permissionMode, 'confirm')
  h.ingest('mint', { type: 'extension_ui_request', id: 'controlled', method: 'confirm', title: 'Run command?' })
  assert.equal(h.approvals.length, 0)
  await h.sessions.approve({ sessionId, requestId: 'controlled', decision: 'deny' })
  assert.equal(h.approvals.at(-1).confirmed, false)
  h.finish('mint', 'First task finished')

  await h.manager.prompt('mint', { message: 'full task' })
  assert.equal(h.starts.at(-1).permissionMode, 'full')
  assert.equal(h.starts.at(-1).force, true)
  assert.equal(h.sessions.resolveRuntime(sessionPath).permissionMode, 'full')
  h.ingest('mint', { type: 'extension_ui_request', id: 'full', method: 'confirm', title: 'Run command?' })
  assert.equal(h.approvals.at(-1).confirmed, true)
  assert.equal(h.sessions.approvals.has(sessionId), false)
  h.finish('mint')

  await h.manager.prompt('mint', { message: 'another full task' })
  assert.equal(h.starts.at(-1).force, false)
  h.finish('mint')
  for (const selected of ['confirm', 'auto']) {
    mode = selected
    await h.manager.prompt('mint', { message: `controlled task ${selected}` })
    assert.equal(h.starts.at(-1).permissionMode, 'confirm')
    h.ingest('mint', { type: 'extension_ui_request', id: selected, method: 'confirm', title: 'Run command?' })
    assert.equal(h.sessions.approvals.get(sessionId).request.requestId, selected)
    await h.sessions.approve({ sessionId, requestId: selected, decision: 'deny' })
    h.finish('mint')
  }
  assert.equal(h.manager.config('mint').sessionId, sessionId)
  assert.equal(record.piSessionPath, sessionPath)
  assert.ok(h.manager.snapshot('mint').messages.some(message => message.content === 'First task finished'))
})

function animationHarness(reduced = false) {
  let now = 0, seed = 117, cancelled = false
  const translations = [], interactions = []
  const context = { setTransform() {}, clearRect() {}, save() {}, restore() {}, rotate() {}, scale() {}, drawImage() {}, fillText() {}, translate: (...args) => translations.push(args) }
  const canvas = { clientWidth: 280, clientHeight: 330, getContext: () => context }
  const window = { AnyuPetBehaviors: behaviors }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../pets/stage.js'), 'utf8'), {
    window, document: { hidden: true }, performance: { now: () => now }, devicePixelRatio: 1,
    Image: class { width = 1280; height = 1920 }, matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => { cancelled = true },
  })
  const stage = new window.AnyuPetStage(canvas, 'test.png', {
    random: () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 },
    onInteraction: (track, kind) => interactions.push({ id: track.id, kind }),
  })
  stage.image.onload()
  return { stage, translations, interactions, advance: value => { now = value; stage.loop(now) }, cancelled: () => cancelled }
}

test('automatic animation cycles through all 100 behaviors before repeating', () => {
  const h = animationHarness(), ids = [h.stage.track.id]
  for (let i = 1; i < 100; i++) { h.advance(h.stage.idleAt + 1); ids.push(h.stage.track.id) }
  assert.equal(new Set(ids).size, 100)
  const last = h.stage.track.id
  h.advance(h.stage.idleAt + 1)
  assert.notEqual(h.stage.track.id, last)
  assert.ok(h.stage.idleAt - h.stage.started - h.stage.track.duration < 1000)
  h.stage.destroy(); assert.equal(h.cancelled(), true)
})

test('cached alpha hit testing follows rotation, scaling and pose without reading the drawing canvas', () => {
  const { stage } = animationHarness()
  stage.hitMask = new Uint8Array(320 * 576 * 4)
  const pose = 17, px = 12, py = 35
  stage.hitMask[((Math.floor(pose / 5) * 96 + py) * 320 + pose % 5 * 64 + px) * 4 + 3] = 255
  for (const angle of [0, .65, -1.4]) for (const sx of [1.1, -.8]) {
    const t = stage.hitTransform = { x: 140, y: 170, angle, sx, sy: .85, renderW: 170, renderH: 260, pose }
    const lx = ((px + .5) / 64 - .5) * t.renderW * sx
    const ly = ((py + .5) / 96 - .5) * t.renderH * t.sy
    assert.equal(stage.hit(t.x + lx * Math.cos(angle) - ly * Math.sin(angle), t.y + lx * Math.sin(angle) + ly * Math.cos(angle)), true)
    assert.equal(stage.hit(t.x, t.y), false, 'transparent mask pixels must pass through')
    assert.equal(stage.hit(-1000, -1000), false)
  }
})

test('native silhouette regions follow mirrored and rotated poses and keep capture geometry stable', () => {
  const { stage, advance } = animationHarness()
  stage.poseRegions = Array.from({ length: 30 }, () => [{ left: -.25, right: .25, top: -.4, bottom: .4 }])
  stage.play('expression-0')
  for (const angle of [0, .65, -1.4]) for (const sx of [1.1, -.8, .01]) {
    const t = stage.hitTransform = { x: 140, y: 170, angle, sx, sy: .85, renderW: 170, renderH: 260, pose: 0 }
    const regions = stage.hitRegions()
    for (const u of [-.25, 0, .25]) for (const v of [-.4, 0, .4]) {
      const dx = u * t.renderW * sx, dy = v * t.renderH * t.sy
      const x = t.x + dx * Math.cos(angle) - dy * Math.sin(angle), y = t.y + dx * Math.sin(angle) + dy * Math.cos(angle)
      assert.ok(regions.some(rect => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height))
    }
    assert.ok(regions.every(rect => rect.width > 0 && rect.height > 0))
    assert.ok(!regions.some(rect => 1 >= rect.x && 1 < rect.x + rect.width && 1 >= rect.y && 1 < rect.y + rect.height), 'blank corners remain outside native shape')
  }
  stage.play('roll'); advance(100)
  const before = { ...stage.hitTransform }
  stage.dragging = true; advance(900)
  assert.deepEqual({ ...stage.hitTransform }, before)
  stage.dragging = false; advance(1300)
  assert.notDeepEqual({ ...stage.hitTransform }, before)
})

test('idle drawing is bounded while pointer interaction raises the frame budget', () => {
  const h = animationHarness()
  h.advance(100)
  const count = h.translations.length
  h.advance(140)
  assert.equal(h.translations.length, count)
  h.stage.interact('click')
  h.advance(141)
  assert.equal(h.translations.length, count + 1)
})

test('between actions the visible desktop actor keeps breathing even when Chromium reports hidden', () => {
  const h = animationHarness()
  h.stage.play('expression-0')
  h.advance(2230); const first = h.translations.at(-1)
  h.advance(2400); const second = h.translations.at(-1)
  assert.notDeepEqual(first, second)
  assert.equal(h.stage.track.id, 'expression-0')
})

test('hover is randomized with a cooldown, while clicks always get a new reaction', () => {
  const h = animationHarness(), initial = h.stage.track.id
  const hover = h.stage.interact('hover')
  assert.notEqual(hover.id, initial)
  const started = h.stage.started
  h.advance(200)
  assert.equal(h.stage.interact('hover'), null)
  assert.equal(h.stage.started, started)
  const click = h.stage.interact('click')
  assert.notEqual(click.id, hover.id)
  h.advance(2500)
  assert.ok(h.stage.interact('hover'))
  assert.deepEqual(h.interactions.map(item => item.kind), ['hover', 'click', 'hover'])
})

test('busy tasks continue moving and speaking or dragging does not trigger unrelated idle actions', () => {
  const h = animationHarness()
  h.stage.busy = true; h.stage.play('working')
  h.advance(h.stage.idleAt + 1)
  assert.ok(['think', 'read', 'listen', 'check'].includes(h.stage.track.id))
  h.stage.speaking(true)
  const speakingTrack = h.stage.track.id
  h.advance(h.stage.idleAt + 5000)
  assert.equal(h.stage.track.id, speakingTrack)
  h.stage.speaking(false); h.stage.dragging = true
  h.advance(h.stage.idleAt + 6000)
  assert.equal(h.stage.track.id, speakingTrack)
})

test('reduced motion changes expressions without continuous movement', () => {
  const h = animationHarness(true)
  h.advance(150); const first = h.translations.at(-1)
  h.advance(600); assert.deepEqual(h.translations.at(-1), first)
  const id = h.stage.track.id
  h.advance(h.stage.idleAt + 1)
  assert.notEqual(h.stage.track.id, id)
})

test('five original atlases contain 30 poses and 100 unique valid behaviors', () => {
  assert.equal(CHARACTERS.length, 5)
  assert.equal(behaviors.expressions.length, 30)
  assert.equal(behaviors.actions.length, 70)
  assert.equal(new Set(behaviors.all.map(item => item.id)).size, 100)
  assert.equal(new Set(behaviors.actions.map(item => JSON.stringify(item.frames))).size, 70)
  for (const track of behaviors.all) {
    assert.ok(track.duration > 0)
    assert.equal(track.frames[0][0], 0)
    assert.equal(track.frames.at(-1)[0], 1)
    track.frames.forEach((frame, i) => {
      assert.equal(frame.length, 7)
      assert.ok(frame.every(Number.isFinite))
      assert.ok(frame[6] >= 0 && frame[6] < 30 && Number.isInteger(frame[6]))
      if (i) assert.ok(frame[0] > track.frames[i - 1][0])
    })
  }
  for (const character of CHARACTERS) {
    const bytes = fs.readFileSync(path.resolve(__dirname, '../pets/assets', character.asset))
    assert.equal(bytes.readUInt32BE(16), 1280)
    assert.equal(bytes.readUInt32BE(20), 1920)
    assert.equal(bytes[25], 6, 'RGBA atlas required')
  }
})

test('install validates resources, deduplicates requests and preserves settings on uninstall', async t => {
  const h = harness(t)
  await Promise.all([h.manager.install('mint'), h.manager.install('mint')])
  assert.ok(h.manager.installed('mint'))
  assert.deepEqual(fs.readFileSync(h.manager.assetFile('mint')), fs.readFileSync(path.join(h.manager.assetDirectory, 'mint.png')))
  await h.manager.save('mint', { prefix: 'Speak briefly' })
  await h.manager.uninstall('mint')
  assert.equal(h.manager.installed('mint'), false)
  assert.equal(h.manager.config('mint').prefix, 'Speak briefly')
  await assert.rejects(h.manager.install('../other'), /角色不存在/)
  h.manager.readAsset = async () => Buffer.from('invalid png')
  await assert.rejects(h.manager.install('snow'), /资源损坏/)
  assert.equal(h.manager.installed('snow'), false)
})

test('exact model binding, prefix and user permissions reach the session runtime', async t => {
  const h = harness(t)
  await h.enable('mint', models[1])
  await assert.rejects(h.manager.save('mint', { model: { ...models[1], group_id: 10 } }), /不可用/)
  await h.manager.save('mint', { prefix: 'Call me Alex' })
  await h.manager.prompt('mint', { message: 'hello' })
  assert.equal(h.starts[0].models[0].group_id, 20)
  assert.equal(h.starts[0].model, 'deepseek-v4')
  assert.equal(h.starts[0].permissionMode, 'confirm')
  assert.match(h.starts[0].systemPrompt, /Call me Alex/)
  assert.match(h.starts[0].systemPrompt, /小薄荷/)
  await assert.rejects(h.manager.save('mint', { prefix: 'changed' }), /正在运行/)
  await assert.rejects(h.manager.prompt('mint', { message: 'second' }), /正在回复/)
  h.finish('mint')
  await h.manager.prompt('mint', { message: 'next' })
  assert.equal(h.starts.at(-1).force, false)
  h.finish('mint')
})

test('independent characters run concurrently and cancelling one leaves the other active', async t => {
  const h = harness(t)
  await h.enable('mint'); await h.enable('snow', models[2])
  await Promise.all([h.manager.prompt('mint', { message: 'mint task' }), h.manager.prompt('snow', { message: 'snow task' })])
  assert.equal(h.sessions.runs.size, 2)
  assert.notEqual(h.manager.config('mint').sessionId, h.manager.config('snow').sessionId)
  await h.manager.abort('mint')
  assert.equal(h.manager.isBusy('mint'), false)
  assert.equal(h.manager.isBusy('snow'), true)
  h.finish('snow', 'Snow response')
  assert.equal(h.manager.snapshot('snow').messages.at(-1).content, 'Snow response')
  assert.ok(!h.manager.snapshot('mint').messages.some(message => message.content === 'Snow response'))
})

test('prompt attachments and archived role settings survive restart', async t => {
  const h = harness(t)
  await h.enable('mint')
  const images = [{ mimeType: 'image/png', data: fs.readFileSync(path.join(h.manager.assetDirectory, 'mint-preview.png')).toString('base64') }]
  await h.manager.prompt('mint', { message: 'Look at this', images })
  const sessionId = h.manager.config('mint').sessionId
  h.finish('mint')
  assert.deepEqual(h.manager.snapshot('mint').messages[0].attachments, images)
  const restored = new PetManager(h.managerOptions); t.after(() => restored.close())
  assert.deepEqual(restored.snapshot('mint').messages[0].attachments, images)
  assert.equal(restored.config('mint').sessionId, sessionId)
  restored.newChat('mint')
  assert.ok(restored.ownsSession(sessionId))
  assert.match(restored.sessionOptions(sessionId).systemPrompt, /小薄荷/)
  await assert.rejects(restored.prompt('mint', { message: 'bad', images: [{ mimeType: 'image/svg+xml', data: 'abc' }] }), /格式无效/)
  restored.close()
})

test('account switch isolates sessions, cancels old tasks and rejects in-flight saves', async t => {
  const h = harness(t)
  await h.enable('mint'); await h.manager.prompt('mint', { message: 'private' })
  const sessionId = h.manager.config('mint').sessionId
  const gate = deferred()
  h.manager.getCatalog = () => gate.promise
  const saving = h.manager.save('snow', { model: models[0] })
  h.setOwner('test-user-b'); h.manager.refreshOwner()
  gate.resolve({ models })
  await assert.rejects(saving, /登录账户已改变/)
  await tick()
  assert.equal(h.sessions.runs.has(sessionId), false)
  assert.equal(h.manager.ownsSession(sessionId), false)
  assert.throws(() => h.manager.sessionOptions(sessionId), /不属于/)
  assert.equal(h.manager.config('snow').model, null)
  h.setOwner('test-user-a'); h.manager.refreshOwner()
  assert.equal(h.manager.config('mint').sessionId, sessionId)
})

test('cancel during startup prevents prompt submission and remains reusable', async t => {
  const gate = deferred()
  const h = harness(t, { beforeStart: () => gate.promise })
  await h.enable('mint')
  const pending = h.manager.prompt('mint', { message: 'cancel me' })
  await tick(); await h.manager.abort('mint'); gate.resolve()
  await assert.rejects(pending, /已取消/)
  assert.equal(h.commands.filter(command => command.type === 'prompt').length, 0)
  assert.equal(h.manager.isBusy('mint'), false)
  await h.manager.prompt('mint', { message: 'resume' }); h.finish('mint')
})

test('delayed settings update cannot erase a session created while catalog loads', async t => {
  const h = harness(t)
  await h.enable('mint')
  const gate = deferred()
  h.manager.getCatalog = () => gate.promise
  const saving = h.manager.save('mint', { model: models[0], volume: .4 })
  h.manager.getCatalog = async () => ({ models })
  await h.manager.prompt('mint', { message: 'first' })
  const sessionId = h.manager.config('mint').sessionId
  gate.resolve({ models }); await saving
  assert.equal(h.manager.config('mint').sessionId, sessionId)
  assert.equal(h.manager.config('mint').volume, .4)
  h.finish('mint')
})

test('muting voice during startup does not cancel the model task', async t => {
  const gate = deferred()
  const h = harness(t, { beforeStart: () => gate.promise })
  await h.enable('mint')
  const prompting = h.manager.prompt('mint', { message: 'continue silently' })
  await tick(); await h.manager.save('mint', { speech: 'off' }); gate.resolve()
  await prompting
  assert.equal(h.commands.filter(command => command.type === 'prompt').length, 1)
  h.finish('mint')
})

test('stale speech from an earlier turn is discarded, including main-window sends', async t => {
  const speech = deferred()
  const h = harness(t, { voice: { speak: () => speech.promise } })
  await h.enable('mint'); await h.manager.prompt('mint', { message: 'first' }); h.finish('mint', 'old audio')
  await h.sessions.prompt({ sessionId: h.manager.config('mint').sessionId, message: 'new main turn' })
  speech.resolve({ mode: 'system', text: 'old audio' }); await tick()
  assert.equal(h.events.filter(event => event.type === 'speech').length, 0)
  await h.manager.abort('mint')
})

test('role prefix survives main-window continuation and multi-agent start', async t => {
  const h = harness(t)
  await h.enable('mint'); await h.manager.save('mint', { prefix: 'Call me Alex' })
  await h.manager.prompt('mint', { message: 'hello' }); h.finish('mint')
  const sessionId = h.manager.config('mint').sessionId
  const host = new AgentOrchestrator({ sessions: h.sessions, getCatalog: async () => ({ models }) }); t.after(() => host.close())
  const payload = { sessionId, model: models[0].id, models: [models[0]], permissionMode: 'confirm', force: true }
  await host.start(payload, h.manager.sessionOptions(sessionId))
  assert.match(h.starts.at(-1).systemPrompt, /Call me Alex/)
  await host.start({ ...payload, team: { enabled: true, maxParallel: 1, maxTasks: 8, timeoutMinutes: 0, workers: [{ id: 'worker', selection: { model: models[1].id, groupId: 20, api: models[1].api, thinkingLevel: 'auto' } }] } }, h.manager.sessionOptions(sessionId))
  assert.match(h.starts.at(-1).systemPrompt, /Call me Alex/)
  assert.match(h.starts.at(-1).systemPrompt, /delegate_tasks/)
})

test('old factory voices upgrade without changing personal preferences or account state', async t => {
  const h = harness(t)
  const original = {
    voice: 'zh-CN-XiaoyiNeural', rate: 0, pitch: 7, speech: 'off', volume: .25,
    model: models[1], prefix: 'My own prefix', position: { x: 50, y: 60 }, sessionId: 'pet:mochi:old',
  }
  h.manager.settings.characters.mochi = original
  const config = h.manager.config('mochi')
  assert.equal(config.voice, 'zh-TW-HsiaoYuNeural')
  assert.equal(config.rate, 3); assert.equal(config.pitch, 6)
  for (const key of ['speech', 'volume', 'model', 'prefix', 'position', 'sessionId']) assert.deepEqual(config[key], original[key])
  assert.deepEqual(h.manager.settings.characters.mochi, original, 'read does not mutate persisted settings')
  await h.manager.save('mochi', { scale: .9 })
  assert.equal(JSON.parse(fs.readFileSync(h.manager.file, 'utf8')).characters.mochi.voicePresetVersion, 1)
  h.setOwner('other-account'); h.manager.refreshOwner()
  assert.equal(h.manager.config('mochi').sessionId, '')
  h.setOwner('test-user-a'); h.manager.refreshOwner()
  assert.equal(h.manager.config('mochi').voice, 'zh-TW-HsiaoYuNeural')
  assert.equal(h.manager.config('mochi').speech, 'off')
  // Explicitly selecting the old voice after upgrade must survive another read.
  await h.manager.save('mochi', { voice: original.voice, rate: 0, pitch: 7 })
  assert.equal(h.manager.config('mochi').voice, original.voice)
})

test('custom voices and tuning survive migration while missing defaults use role recommendations', () => {
  const mochi = CHARACTERS.find(character => character.id === 'mochi')
  for (const customization of [{ voice: 'ja-JP-NanamiNeural' }, { rate: -10 }, { pitch: 9 }]) {
    const saved = { voice: 'zh-CN-XiaoyiNeural', rate: 0, pitch: 7, ...customization }
    const config = resolveConfig(mochi, saved)
    for (const key of ['voice', 'rate', 'pitch']) assert.equal(config[key], saved[key])
  }
  assert.equal(new Set(VOICES.map(voice => voice.id)).size, VOICES.length)
  for (const character of CHARACTERS) {
    const config = resolveConfig(character)
    assert.deepEqual(config, defaults(character))
    assert.ok(VOICES.some(voice => voice.id === config.voice && voice.language.startsWith('zh-')))
  }
})

test('voice previews use the selected language without saving unsaved preferences', async t => {
  const calls = [], h = harness(t, { voice: { speak: async (text, config) => { calls.push({ text, config }); return { mode: 'off', text } } } })
  const before = h.manager.config('mint')
  await h.manager.previewVoice('mint', { voice: 'ja-JP-NanamiNeural', rate: -8, pitch: 4 })
  assert.match(calls.at(-1).text, /こんにちは/)
  assert.equal(calls.at(-1).config.voice, 'ja-JP-NanamiNeural')
  assert.equal(calls.at(-1).config.rate, -8)
  await h.manager.previewVoice('mint', { voice: 'en-US-JennyNeural' })
  assert.match(calls.at(-1).text, /Hello/)
  await h.manager.previewVoice('mint', { voice: 'zh-TW-HsiaoYuNeural' })
  assert.match(calls.at(-1).text, /小薄荷/)
  assert.deepEqual(h.manager.config('mint'), before)
})

test('voice synthesis caches and deduplicates, strips code and never falls back to system speech', async t => {
  const h = harness(t)
  let count = 0
  const voice = new PetVoice(path.join(h.directory, 'voice'), async (_text, file) => { count++; fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.alloc(512)])) })
  const config = h.manager.config('mint')
  const [a, b] = await Promise.all([voice.speak('hello', config), voice.speak('hello', config)])
  assert.equal(count, 1); assert.deepEqual(a, b); assert.equal(a.mode, 'natural')
  await voice.speak('hello', config); assert.equal(count, 1)
  await voice.speak('hello', { ...config, voice: 'zh-TW-HsiaoYuNeural' }); assert.equal(count, 2)
  await voice.speak('hello', { ...config, rate: -10 }); assert.equal(count, 3)
  await voice.speak('hello', { ...config, volume: .1 }); assert.equal(count, 3)
  voice.synthesize = async () => { throw new Error('offline') }
  const failed = await voice.speak('different text', config)
  assert.equal(failed.mode, 'off'); assert.ok(failed.warning)
  assert.equal((await voice.speak('hello', { ...config, speech: 'off' })).mode, 'off')
  assert.equal(spokenText('Hello\n```js\nsecret()\n```\n[world](https://example.com)'), 'Hello world')
})

test('window bounds remain usable on small and negative-coordinate displays', () => {
  assert.deepEqual(fitBounds({ x: -2000, y: 999, width: 410, height: 560 }, { x: -1920, y: 0, width: 1920, height: 1080 }), { x: -1920, y: 520, width: 410, height: 560 })
  assert.deepEqual(fitBounds({ x: 50, y: 50, width: 410, height: 560 }, { x: 0, y: 0, width: 320, height: 400 }), { x: 0, y: 0, width: 320, height: 400 })
})
