'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8')
const source = main.slice(main.indexOf('function authFile()'), main.indexOf('function piAgentDir()'))
const jwt = exp => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`
const futureToken = () => jwt(Math.floor(Date.now() / 1000) + 3600)
const saved = () => ({ accessToken: futureToken(), refreshToken: 'remembered-refresh-secret', user: { id: 7, email: 'remember@example.com' } })

function harness(t, requestApi = async () => { throw new Error('Unexpected network request') }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-auth-memory-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  function launch(gateway = 'https://x.ailzd.com', filesystem = fs) {
    const context = {
      fs: filesystem, path, Buffer, process, Date, auth: null, authGeneration: 0, authRefreshPromise: null, desktopPets: null,
      GATEWAY_BASE: gateway, app: { getPath: () => directory }, requestApi,
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') },
    }
    vm.runInNewContext(source, context)
    return context
  }
  return { directory, launch, file: path.join(directory, 'anyu-auth.json') }
}

test('reopening restores encrypted credentials without a network round trip', async t => {
  const h = harness(t)
  const original = saved()
  h.launch().saveAuth(original)
  const disk = fs.readFileSync(h.file, 'utf8')
  assert.ok(!disk.includes(original.accessToken) && !disk.includes(original.refreshToken))
  const reopened = h.launch()
  reopened.loadAuth()
  const state = await reopened.restoreDesktopAuth()
  assert.equal(state.authenticated, true)
  assert.equal(state.accessToken, original.accessToken)
  assert.equal(state.refreshToken, original.refreshToken)
  assert.equal(state.expiresAt, JSON.parse(Buffer.from(original.accessToken.split('.')[1], 'base64url')).exp * 1000)
})

test('expired access tokens rotate once for simultaneous UI and model requests', async t => {
  let calls = 0, release
  const pending = new Promise(resolve => { release = resolve })
  const h = harness(t, async route => { assert.equal(route, '/auth/refresh'); calls++; return pending })
  const runtime = h.launch()
  runtime.saveAuth({ ...saved(), accessToken: jwt(1) })
  const restored = runtime.restoreDesktopAuth()
  const ui = runtime.restoreDesktopAuth(true)
  const model = runtime.refreshAuthAccessToken()
  const next = futureToken()
  release({ access_token: next, refresh_token: 'rotated-refresh' })
  const results = await Promise.all([restored, ui, model])
  assert.equal(calls, 1)
  assert.equal(results[0].accessToken, next)
  assert.equal(results[1].refreshToken, 'rotated-refresh')
  assert.equal(results[2], next)
  const reopened = h.launch(); reopened.loadAuth()
  assert.equal(reopened.auth.refreshToken, 'rotated-refresh')
})

for (const status of [0, 429, 502, 503]) test(`temporary ${status} refresh failure retains the remembered login`, async t => {
  const h = harness(t, async () => { throw Object.assign(new Error('temporarily unavailable'), { status }) })
  const runtime = h.launch()
  runtime.saveAuth({ ...saved(), accessToken: jwt(1) })
  const before = fs.readFileSync(h.file, 'utf8')
  const state = await runtime.restoreDesktopAuth()
  assert.equal(state.authenticated, true)
  assert.equal(state.error.status, status)
  assert.equal(fs.readFileSync(h.file, 'utf8'), before)
})

for (const status of [401, 403]) test(`rejected refresh ${status} clears credentials and stays logged out after reopening`, async t => {
  const h = harness(t, async () => { throw Object.assign(new Error('revoked'), { status }) })
  const runtime = h.launch(); runtime.saveAuth(saved())
  assert.equal((await runtime.restoreDesktopAuth(true)).authenticated, false)
  assert.equal(fs.existsSync(h.file), false)
  const reopened = h.launch(); reopened.loadAuth()
  assert.equal((await reopened.restoreDesktopAuth()).authenticated, false)
})

test('a late refresh cannot restore a session after logout', async t => {
  let release
  const h = harness(t, () => new Promise(resolve => { release = resolve }))
  const runtime = h.launch(); runtime.saveAuth(saved())
  const refreshing = runtime.restoreDesktopAuth(true)
  runtime.clearAuth()
  release({ access_token: futureToken(), refresh_token: 'late-refresh' })
  assert.equal((await refreshing).authenticated, false)
  assert.equal(fs.existsSync(h.file), false)
})

test('a late refresh rejection cannot remove a different signed-in account', async t => {
  let reject
  const h = harness(t, () => new Promise((_, fail) => { reject = fail }))
  const runtime = h.launch(); runtime.saveAuth(saved())
  const refreshing = runtime.restoreDesktopAuth(true)
  runtime.clearAuth()
  runtime.saveAuth({ ...saved(), refreshToken: 'another-account', user: { id: 8 } })
  reject(Object.assign(new Error('old session revoked'), { status: 401 }))
  assert.equal((await refreshing).error, undefined)
  assert.equal(runtime.auth.user.id, 8)
  assert.ok(fs.existsSync(h.file))
})

test('a refresh-only legacy login can recover its access token', async t => {
  const h = harness(t, async () => ({ access_token: futureToken(), refresh_token: 'renewed' }))
  h.launch().saveAuth({ ...saved(), accessToken: '' })
  const runtime = h.launch(); runtime.loadAuth()
  assert.equal((await runtime.restoreDesktopAuth()).authenticated, true)
})

test('credentials are isolated from a different API origin', async t => {
  const h = harness(t); h.launch().saveAuth(saved())
  const local = h.launch('http://127.0.0.1:8080'); local.loadAuth()
  assert.equal((await local.restoreDesktopAuth()).authenticated, false)
})

test('an interrupted replacement leaves the previous encrypted login intact', t => {
  const h = harness(t); h.launch().saveAuth(saved())
  const before = fs.readFileSync(h.file, 'utf8')
  const failing = h.launch('https://x.ailzd.com', { ...fs, renameSync: () => { throw new Error('interrupted') } })
  assert.throws(() => failing.saveAuth({ ...saved(), refreshToken: 'replacement' }), /interrupted/)
  assert.equal(fs.readFileSync(h.file, 'utf8'), before)
  assert.equal(fs.readdirSync(h.directory).some(file => file.endsWith('.tmp')), false)
})
