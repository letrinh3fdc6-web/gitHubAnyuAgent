const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const { installGracefulQuit } = require('../shutdown.cjs')

function application() {
  const app = new EventEmitter()
  app.exits = 0
  app.quit = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    app.emit('before-quit', event)
    if (!event.prevented) app.exits++
  }
  return app
}

test('waits for runtime cleanup, including repeated quit requests', async () => {
  const app = application()
  let finish
  let stops = 0
  let quitting = false
  installGracefulQuit(app, {
    beforeStop: () => { quitting = true },
    stop: () => { assert.ok(quitting); stops++; return new Promise(resolve => { finish = resolve }) }
  })
  app.quit()
  app.quit()
  await sleep(0)
  assert.equal(stops, 1)
  assert.equal(app.exits, 0)
  finish()
  await sleep(0)
  assert.equal(app.exits, 1)
})

test('reports a stalled cleanup and exits within the configured deadline', async () => {
  const app = application()
  const errors = []
  installGracefulQuit(app, { stop: () => new Promise(() => {}), timeoutMs: 15, onError: error => errors.push(error.message) })
  app.quit()
  await sleep(50)
  assert.equal(app.exits, 1)
  assert.deepEqual(errors, ['Desktop shutdown cleanup timed out'])
})

test('cleanup failures do not trap the user in an unclosable application', async () => {
  const app = application()
  const errors = []
  installGracefulQuit(app, { stop: () => { throw Error('cleanup failed') }, onError: error => errors.push(error.message) })
  app.quit()
  await sleep(0)
  assert.equal(app.exits, 1)
  assert.deepEqual(errors, ['cleanup failed'])
})
