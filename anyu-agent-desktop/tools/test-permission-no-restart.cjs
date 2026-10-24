const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8')
const begin = source.indexOf('  async function choosePermissionMode(')
const end = source.indexOf('  const THINKING_LEVELS', begin)
function harness(result) {
  const store = new Map()
  const calls = []
  const state = { permissionMode: 'confirm', activePermissionMode: null, loading: true }
  const context = {
    state, localStorage: { setItem: (key, value) => store.set(key, value) }, renderApp() {}, systemAccessLabel: () => 'worker ready',
    window: { anyu: { setAgentPermissionMode: async mode => { calls.push(mode); return result }, requestSystemElevation: async () => result } },
  }
  vm.runInNewContext(`${source.slice(begin, end)}; this.choose = choosePermissionMode; this.elevate = requestElevation`, context)
  return { context, state, store, calls }
}

test('legacy UI saves only the canonical successful result without restarting the app', async () => {
  const h = harness({ ok: true, mode: 'full', activeMode: 'confirm', deferred: 1, message: 'next turn', systemAccess: { executionAdministrator: true } })
  await h.context.choose('full')
  assert.deepEqual(h.calls, ['full'])
  assert.equal(h.state.permissionMode, 'full')
  assert.equal(h.state.activePermissionMode, 'confirm')
  assert.equal(h.store.get('anyu.permissionMode'), 'full')
  assert.equal(h.state.elevationNotice, 'next turn')
})

test('UAC cancellation retains the previous UI and stored permission', async () => {
  const h = harness({ ok: false, code: 'UAC_CANCELLED', message: 'cancelled', mode: 'confirm' })
  await h.context.choose('full')
  assert.equal(h.state.permissionMode, 'confirm')
  assert.equal(h.store.size, 0)
  assert.equal(h.state.error, 'cancelled')
})

test('explicit elevation prepares the execution host without changing mode', async () => {
  const h = harness({ ok: true, state: { executionAdministrator: true } })
  await h.context.elevate()
  assert.equal(h.state.permissionMode, 'confirm')
  assert.equal(h.state.systemAccess.executionAdministrator, true)
})

test('controlled and automatic tools require confirmation; unknown plugin tools cannot bypass it', async () => {
  const { default: installGate } = await import(pathToFileURL(path.join(__dirname, '../pi-approval-gate.mjs')))
  let gate
  installGate({ on: (_name, callback) => { gate = callback } })
  const previous = process.env.ANYU_PERMISSION_MODE
  try {
    for (const mode of ['confirm', 'auto', '']) {
      process.env.ANYU_PERMISSION_MODE = mode
      for (const toolName of ['bash', 'write', 'apply_patch', 'custom_plugin_action', 'browser_navigate']) {
        const denied = await gate({ toolName }, { ui: { confirm: async () => false } })
        assert.equal(denied.block, true)
        assert.equal(await gate({ toolName }, { ui: { confirm: async () => true } }), undefined)
      }
      for (const toolName of ['read', 'grep', 'find', 'ls']) assert.equal(await gate({ toolName }, {}), undefined)
      assert.equal((await gate({ toolName: 'bash' }, {})).block, true)
    }
    process.env.ANYU_PERMISSION_MODE = 'full'
    assert.equal(await gate({ toolName: 'bash' }, {}), undefined)
  } finally {
    if (previous === undefined) delete process.env.ANYU_PERMISSION_MODE
    else process.env.ANYU_PERMISSION_MODE = previous
  }
})
