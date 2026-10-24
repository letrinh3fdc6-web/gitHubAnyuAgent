const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('../../../../frontend/node_modules/typescript')

const source = fs.readFileSync(path.join(__dirname, '../../../../frontend/src/views/public/AnyuAgentWorkspaceView.vue'), 'utf8')
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))) }
const code = ts.transpileModule([
  extract('function normalizePermissionMode(', 'function openWorkspaceSettings('),
  extract('async function applyPermissionMode(', 'async function openPrivacySettings('),
  'this.apply = applyPermissionMode; this.load = loadPermissionState; this.elevate = requestElevation;',
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function harness(result, native = true) {
  const context = {
    permissionMode: { value: 'confirm' }, activePermissionMode: { value: null }, permissionBusy: { value: false },
    permissionNotice: { value: '' }, systemAccess: { value: null }, permissionModeName: mode => mode,
    localStorage: { setItem() {}, getItem: () => 'confirm' }, window: {},
  }
  let elevations = 0
  if (native) context.window.anyu = {
    setAgentPermissionMode: async () => result, agentPermissionState: async () => result,
    requestSystemElevation: async () => { elevations++; return result },
  }
  vm.runInNewContext(code, context)
  return { context, elevations: () => elevations }
}

test('Vue applies the canonical result, keeps active mode separate and never launches UAC twice', async () => {
  const h = harness({ ok: true, mode: 'full', activeMode: null, systemAccess: { platform: 'win32', executionAdministrator: true, executionHost: 'worker' } })
  await h.context.apply('full')
  assert.equal(h.context.permissionMode.value, 'full')
  assert.equal(h.context.activePermissionMode.value, null)
  assert.equal(h.elevations(), 0)
})

test('Vue preserves the previous selection after cancellation and displays the real failure', async () => {
  const h = harness({ ok: false, mode: 'confirm', message: 'UAC cancelled' })
  await h.context.apply('full')
  assert.equal(h.context.permissionMode.value, 'confirm')
  assert.equal(h.context.permissionNotice.value, 'UAC cancelled')
  assert.equal(h.context.permissionBusy.value, false)
})

test('Vue distinguishes persisted full permission from effective privilege after an ordinary launch', async () => {
  const h = harness({ mode: 'full', activeMode: null, ready: false, systemAccess: { platform: 'win32', executionAdministrator: false } })
  await h.context.load()
  assert.equal(h.context.activePermissionMode.value, null)
  assert.match(h.context.permissionNotice.value, /尚未授权/)
})

test('browser preview cannot claim an active local execution permission', async () => {
  const h = harness({}, false)
  await h.context.apply('full')
  assert.equal(h.context.activePermissionMode.value, null)
  assert.equal(h.context.systemAccess.value.platform, 'browser')
})
