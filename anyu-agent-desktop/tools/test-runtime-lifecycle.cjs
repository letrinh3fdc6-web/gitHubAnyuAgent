'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const http = require('node:http')
const crypto = require('node:crypto')
const { KeyedSerialQueue, waitForSpawn, withStartupCancellation } = require('../runtime-lifecycle.cjs')
const { LocalGatewayBridge } = require('../gateway-bridge.cjs')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('independent keys start together, same-key failures release the queue', async () => {
  const queue = new KeyedSerialQueue()
  const gate = deferred()
  const entered = []
  const first = queue.run('a', async () => { entered.push('a1'); await gate.promise; throw new Error('failed') })
  const failed = assert.rejects(first, /failed/)
  const second = queue.run('a', () => entered.push('a2'))
  await queue.run('b', () => entered.push('b'))
  assert.deepEqual(entered, ['a1', 'b'])
  gate.resolve()
  await Promise.all([failed, second])
  assert.deepEqual(entered, ['a1', 'b', 'a2'])
  await queue.drain(() => {})
  assert.equal(queue.tails.size, 0)
})

test('shutdown blocks admission and waits for in-flight startup before cleanup', async () => {
  const queue = new KeyedSerialQueue()
  const gate = deferred()
  let cleaned = false
  const start = queue.run('a', () => gate.promise)
  const stop = queue.drain(() => { cleaned = true })
  assert.equal(queue.drain(() => assert.fail('duplicate shutdown')), stop)
  await assert.rejects(queue.run('b', () => assert.fail('late startup')), /stopping/)
  assert.equal(cleaned, false)
  gate.resolve()
  await Promise.all([start, stop])
  assert.equal(cleaned, true)
  await queue.run('b', () => {})
})

test('spawn readiness follows events and removes temporary listeners', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  const ready = waitForSpawn(child)
  child.emit('spawn')
  await ready
  for (const type of ['spawn', 'error', 'exit']) assert.equal(child.listenerCount(type), 0)
  const failed = waitForSpawn(child)
  child.emit('error', new Error('cannot spawn'))
  await assert.rejects(failed, /cannot spawn/)
  const exited = waitForSpawn(child)
  child.emit('exit', 9)
  await assert.rejects(exited, /9/)
  await assert.rejects(waitForSpawn(child, { timeoutMs: 5 }), /timed out/)
  for (const type of ['spawn', 'error', 'exit']) assert.equal(child.listenerCount(type), 0)
})

test('startup cancellation releases a slow shared preparation without a late continuation', async () => {
  const controller = new AbortController()
  const gate = deferred()
  let continued = false
  const operation = withStartupCancellation(gate.promise, controller.signal).then(() => { continued = true })
  controller.abort()
  await assert.rejects(operation, /cancelled/)
  gate.resolve()
  await Promise.resolve()
  assert.equal(continued, false)
  await assert.rejects(withStartupCancellation(Promise.resolve('late'), controller.signal), /cancelled/)
})

test('main-process startup cancels each pending session before shutdown and can restart after logout', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8')
  const starts = []
  let cleanups = 0
  const context = {
    KeyedSerialQueue, AbortController, path, crypto, process, isQuitting: false,
    piStarts: new KeyedSerialQueue(), piStartCancellation: new AbortController(),
    startPiWithRecovery: options => {
      starts.push(options.agentSessionId)
      return withStartupCancellation(options.ready ? Promise.resolve('ready') : new Promise(() => {}), options.startupSignal)
    },
    stopPiUnsafe: async () => { cleanups++ },
  }
  const stop = source.slice(source.indexOf('function stopPi()'), source.indexOf('async function stopPiUnsafe()'))
  const start = source.slice(source.indexOf('async function startPi(options'), source.indexOf('let permissionChangeLock'))
  vm.runInNewContext(`${stop}\n${start}`, context)
  const first = assert.rejects(context.startPi({ agentSessionId: 'first' }), /cancelled/)
  const second = assert.rejects(context.startPi({ agentSessionId: 'second' }), /cancelled/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(starts, ['first', 'second'])
  const stopping = context.stopPi()
  await assert.rejects(context.startPi({ agentSessionId: 'late' }), /stopping/)
  await Promise.all([first, second, stopping])
  assert.equal(cleanups, 1)
  assert.equal(context.piStarts.tails.size, 0)
  assert.equal(await context.startPi({ agentSessionId: 'next-login', ready: true }), 'ready')
})

test('concurrent gateway starts share one listener and token across stop/restart', async t => {
  const bridge = new LocalGatewayBridge({ gatewayBase: 'http://127.0.0.1:1' })
  t.after(() => bridge.stop())
  const starts = await Promise.all(Array.from({ length: 20 }, () => bridge.start()))
  for (const result of starts) assert.deepEqual(result, starts[0])
  const stop = bridge.stop()
  const restart = bridge.start()
  await stop
  assert.notEqual((await restart).token, starts[0].token)
  const pendingStart = bridge.start()
  const pendingStop = bridge.stop()
  await Promise.all([pendingStart, pendingStop])
  assert.equal(bridge.server, null)
  assert.equal(bridge.upstreamAgent, null)
})

test('browser bridge concurrent starts retain every workspace and share their token', async t => {
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8')
  const start = source.indexOf('function stopBrowserBridge()')
  const end = source.indexOf('function sendPi(', start)
  assert.ok(start > 0 && end > start)
  const context = { http, crypto, fs, browserBridge: null, browserBridgeToken: '', browserBridgeCwds: new Set(), browserBridgeLifecycle: new KeyedSerialQueue() }
  vm.runInNewContext(source.slice(start, end), context)
  t.after(() => context.stopBrowserBridge())
  const dirs = [__dirname, path.dirname(__dirname)]
  const results = await Promise.all(dirs.map(cwd => context.startBrowserBridge(cwd)))
  assert.equal(results[0].token, results[1].token)
  assert.equal(results[0].port, results[1].port)
  for (const cwd of dirs) assert.ok(context.browserBridgeCwds.has(fs.realpathSync(cwd)))
  await context.stopBrowserBridge()
  assert.equal(context.browserBridge, null)
  assert.equal(context.browserBridgeCwds.size, 0)
})
