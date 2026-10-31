'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PetWindows } = require('../pet-windows.cjs')
const source = fs.readFileSync(path.join(__dirname, '../pets/pet.js'), 'utf8')

function player() {
  const calls = [], errors = [], captures = new Set(), listeners = {}
  let start = Promise.resolve(), captureError = null, releaseError = null
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture(id) { if (captureError) throw captureError; captures.add(id) },
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture(id) { if (releaseError) throw releaseError; captures.delete(id) },
  }
  const nodes = { 'drag-handle': {}, bubble: {} }
  const stage = { dragging: false, hit: () => true, interact() {} }
  const context = vm.createContext({
    canvas, stage, performance: { now: () => 100 }, $: id => nodes[id],
    recentBodyHit: () => false, showError: error => errors.push(error),
    document: { addEventListener: (type, callback) => { listeners[type] = callback } },
    window: { addEventListener() {} },
    call(action, input) { calls.push({ action, input }); return action === 'drag-start' ? start : Promise.resolve({ ok: true }) },
  })
  vm.runInContext(`let drag = null, nativeShape = true, nativeShapeKey = 'shape', interactive = true, lastDragAt = 0;
    ${source.slice(source.indexOf('async function startDrag('), source.indexOf('canvas.onkeydown ='))}
    function state() { return { drag, nativeShapeKey }; }`, context)
  const event = (overrides = {}) => ({ button: 0, buttons: 1, pointerId: 1, screenX: 200, screenY: 150, clientX: 100, clientY: 100, currentTarget: canvas, preventDefault() {}, ...overrides })
  return { context, canvas, nodes, stage, calls, errors, captures, listeners, event,
    gate(value) { start = value }, failCapture(error) { captureError = error }, failRelease(error) { releaseError = error } }
}

test('host locks the drag before pointer capture, after queued shape updates', async () => {
  const h = player(); let resolve
  h.gate(new Promise(done => { resolve = done }))
  const started = h.context.startDrag(h.event())
  assert.equal(h.stage.dragging, true)
  assert.deepEqual(h.calls.map(c => c.action), ['drag-start'])
  assert.equal(h.captures.size, 0)
  resolve(); await started
  assert.equal(h.captures.has(1), true)
  h.listeners.pointerup(h.event({ buttons: 0 }))
  assert.equal(h.stage.dragging, false)
  assert.equal(h.context.state().drag, null)
})

test('releasing over the handle while startup is pending cannot leave a frozen drag', async () => {
  const h = player(); let resolve
  h.gate(new Promise(done => { resolve = done }))
  const started = h.context.startDrag(h.event({ currentTarget: h.nodes['drag-handle'] }))
  h.listeners.pointerup(h.event({ buttons: 0 }))
  resolve(); await started
  assert.equal(h.captures.size, 0)
  assert.equal(h.stage.dragging, false)
  assert.deepEqual(h.calls.map(c => c.action), ['drag-start', 'drag-end'])
})

test('failed capture clears both body and handle drags and allows the next attempt', async () => {
  for (const target of ['canvas', 'handle']) {
    const h = player()
    h.failCapture(Object.assign(new Error('pointer no longer active'), { name: 'NotFoundError' }))
    await h.context.startDrag(h.event({ currentTarget: target === 'canvas' ? h.canvas : h.nodes['drag-handle'] }))
    assert.equal(h.stage.dragging, false)
    assert.equal(h.context.state().drag, null)
    assert.equal(h.calls.at(-1).action, 'drag-end')
    assert.equal(h.errors.length, 0)
    h.failCapture(null)
    await h.context.startDrag(h.event())
    assert.equal(h.captures.has(1), true)
  }
})

test('host startup and release errors never retain local drag state', async () => {
  const h = player()
  h.gate(Promise.reject(new Error('host rejected')))
  await h.context.startDrag(h.event())
  assert.equal(h.context.state().drag, null)
  assert.equal(h.calls.at(-1).action, 'drag-end')
  assert.equal(h.errors.length, 1)
  h.gate(Promise.resolve())
  await h.context.startDrag(h.event())
  h.failRelease(new Error('capture already lost'))
  h.context.finishDrag(null, true)
  assert.equal(h.context.state().drag, null)
  assert.equal(h.calls.at(-1).action, 'drag-end')
})

test('other pointers cannot cancel a drag; document events move it before capture acknowledgement', async () => {
  const h = player(); let resolve
  h.gate(new Promise(done => { resolve = done }))
  const started = h.context.startDrag(h.event())
  h.listeners.pointercancel(h.event({ pointerId: 2 }))
  assert.ok(h.context.state().drag)
  h.listeners.pointermove(h.event({ screenX: 250, currentTarget: h.nodes['drag-handle'] }))
  assert.equal(h.calls.at(-1).action, 'drag')
  h.listeners.pointermove(h.event({ buttons: 0 }))
  resolve(); await started
  assert.equal(h.context.state().drag, null)
  assert.equal(h.calls.at(-1).action, 'drag-end')
  assert.equal(h.captures.size, 0)
})

test('an old startup acknowledgement cannot capture or cancel the next drag', async () => {
  const h = player(); let resolve
  h.gate(new Promise(done => { resolve = done }))
  const first = h.context.startDrag(h.event())
  h.gate(Promise.resolve())
  await h.context.startDrag(h.event({ pointerId: 2 }))
  resolve(); await first
  assert.deepEqual([...h.captures], [2])
  assert.equal(h.context.state().drag.pointerId, 2)
})

test('native mouse-down freezes shape before renderer IPC and released mousemove repairs missed release', async t => {
  const shapes = [], sent = []
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send: (_name, event) => sent.push(event) })
    }
    isDestroyed() { return false }
    getBounds() { return this.bounds }
    setBounds(bounds) { this.bounds = bounds }
    setIgnoreMouseEvents() {}
    setShape(shape) { shapes.push(shape) }
    async loadFile() {}
    destroy() {}
  }
  const area = { x: 0, y: 0, width: 1920, height: 1080 }
  const screen = Object.assign(new EventEmitter(), { getDisplayNearestPoint: () => ({ workArea: area }) })
  const manager = { state: () => ({ characters: [{ id: 'mint', config: { position: { x: 40, y: 100 }, scale: 1 } }] }), links: { list: () => [] }, save: async () => {} }
  const windows = new PetWindows({ BrowserWindow: Window, screen, manager, directory: '', openMain() {} })
  t.after(() => windows.close())
  const actor = windows.create('mint', 'actor'), pair = windows.windows.get('mint')
  pair.nativeShape = true
  const shape = [{ x: 60, y: 40, width: 120, height: 230 }]
  assert.equal(windows.setHitRegions('mint', shape), true)
  const count = shapes.length
  actor.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' })
  assert.equal(windows.setHitRegions('mint', [{ ...shape[0], x: 90 }]), false)
  assert.equal(shapes.length, count)
  windows.beginDrag('mint', { x: 100, y: 200 })
  actor.webContents.emit('before-mouse-event', {}, { type: 'mouseMove', modifiers: ['leftButtonDown'], globalX: 120, globalY: 210 })
  assert.equal(windows.drags.has('mint'), true)
  actor.webContents.emit('before-mouse-event', {}, { type: 'mouseMove', modifiers: [], globalX: 130, globalY: 220 })
  assert.equal(windows.drags.has('mint'), false)
  assert.equal(pair.pointerDown, false)
  assert.equal(sent.at(-1).type, 'drag-release')
  assert.equal(windows.setHitRegions('mint', shape), true)
  assert.equal(shapes.length, count + 1)
})
