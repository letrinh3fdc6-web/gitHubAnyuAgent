const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { DesktopUpdater } = require('../desktop-updates.cjs')
const { writeMarker, readMarker } = require('../windows-update.cjs')

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-update-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bytes = Buffer.from('verified update payload')
  const artifact = { name: 'AnyuAgent-Setup-2.0.0.exe', version: '2.0.0', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  const events = [], requests = [], prepared = [], quits = []
  const app = { getVersion: () => '1.0.0', isPackaged: true, getPath: kind => kind === 'exe' ? path.join(directory, 'AnyuAgent.exe') : directory }
  const updater = new DesktopUpdater({ app, manifestUrl: 'https://updates.example.test/downloads/manifest.json', platform: 'win32', pollMs: 5,
    emit: event => events.push(event), quit: () => quits.push(true),
    fetch: async (url) => {
      requests.push(url)
      return url.includes('manifest.json') ? Response.json({ anyuAgent: artifact }) : new Response(bytes)
    },
    prepare: async payload => { prepared.push(payload); writeMarker(payload.markerPath, { ...payload, expectedVersion: payload.version, status: 'prepared' }); return { logPath: 'test.log' } },
    ...options,
  })
  return { updater, directory, bytes, artifact, events, requests, prepared, quits }
}

test('one click downloads, verifies, commits install and quits once; repeated clicks share the operation', async t => {
  const { updater, prepared, events, quits } = fixture(t)
  const first = updater.install()
  assert.equal(first, updater.install())
  assert.equal((await first).status, 'installing')
  assert.equal(prepared.length, 1)
  assert.equal(path.basename(prepared[0].installerPath), 'AnyuAgent-Setup.exe')
  assert.equal(path.basename(path.dirname(prepared[0].installerPath)), prepared[0].sha256)
  assert.equal(readMarker(updater.markerPath).status, 'installing')
  assert(events.some(event => event.phase === 'downloading' && event.percent === 100))
  assert(events.some(event => event.phase === 'verifying'))
  await updater.install()
  assert.equal(prepared.length, 1)
  await delay(175)
  assert.equal(quits.length, 1)
})

test('bad package never starts an installer or quits the current application', async t => {
  const item = fixture(t)
  item.artifact.sha256 = '0'.repeat(64)
  await assert.rejects(item.updater.install(), /校验失败/)
  assert.equal(item.updater.state.phase, 'error')
  assert.equal(item.prepared.length, 0)
  assert.equal(item.quits.length, 0)
  assert.deepEqual(fs.readdirSync(path.join(item.directory, 'updates', item.artifact.sha256)), [])
})

test('waits for active work and resumes automatically after the last task settles', { timeout: 10000 }, async t => {
  let busy = true
  const item = fixture(t, { isBusy: () => busy })
  const operation = item.updater.install()
  while (item.updater.state.phase !== 'waiting') await delay(5, undefined, { signal: t.signal })
  assert.equal(item.prepared.length, 0)
  busy = false
  assert.equal((await operation).status, 'installing')
  await delay(175)
})

test('cancelling while waiting preserves the verified download and never exits', { timeout: 10000 }, async t => {
  const item = fixture(t, { isBusy: () => true })
  const operation = item.updater.install()
  while (item.updater.state.phase !== 'waiting') await delay(5, undefined, { signal: t.signal })
  assert.equal(item.updater.cancel(), true)
  assert.equal((await operation).status, 'cancelled')
  assert.equal(fs.readdirSync(path.join(item.directory, 'updates')).length, 1)
  assert.equal(item.prepared.length, 0)
  assert.equal(item.quits.length, 0)
})

test('helper bootstrap failure leaves the old application open; retry reuses verified bytes', async t => {
  let calls = 0
  const item = fixture(t, { prepare: async () => { calls++; throw new Error('bootstrap failed') } })
  await assert.rejects(item.updater.install(), /bootstrap failed/)
  await assert.rejects(item.updater.install(), /bootstrap failed/)
  assert.equal(calls, 2)
  assert.equal(item.requests.filter(url => url.endsWith('.exe')).length, 1)
  assert.equal(item.quits.length, 0)
})

test('verified downloads from the old hash filename are reused under the branded installer name', async t => {
  const item = fixture(t)
  const cache = path.join(item.directory, 'updates')
  fs.mkdirSync(cache)
  const legacyPath = path.join(cache, `AnyuAgent-update-${item.artifact.sha256}.exe`)
  fs.writeFileSync(legacyPath, item.bytes)
  assert.equal((await item.updater.install()).status, 'installing')
  assert.equal(item.requests.filter(url => url.endsWith('.exe')).length, 0)
  assert.equal(path.basename(item.prepared[0].installerPath), 'AnyuAgent-Setup.exe')
  assert.deepEqual(fs.readFileSync(item.prepared[0].installerPath), item.bytes)
  assert.equal(fs.existsSync(legacyPath), true)
  await delay(175)
})

test('a corrupted legacy cache is not trusted when migrating to the branded installer name', async t => {
  const item = fixture(t)
  const cache = path.join(item.directory, 'updates')
  fs.mkdirSync(cache)
  fs.writeFileSync(path.join(cache, `AnyuAgent-update-${item.artifact.sha256}.exe`), Buffer.alloc(item.bytes.length))
  assert.equal((await item.updater.install()).status, 'installing')
  assert.equal(item.requests.filter(url => url.endsWith('.exe')).length, 1)
  assert.deepEqual(fs.readFileSync(item.prepared[0].installerPath), item.bytes)
  await delay(175)
})

test('recovering an interrupted update does not auto-run an installer and exposes its diagnostic', t => {
  const item = fixture(t)
  writeMarker(item.updater.markerPath, { status: 'failed', expectedVersion: '2.0.0', error: 'installer exit 2', logPath: 'update.log' })
  item.updater.recover()
  assert.equal(item.updater.state.phase, 'error')
  assert.equal(item.updater.state.logPath, 'update.log')
  assert.equal(item.prepared.length, 0)
  assert.equal(item.quits.length, 0)
})

test('new application acknowledges its actual version only after renderer startup', t => {
  const item = fixture(t)
  writeMarker(item.updater.markerPath, { status: 'restarting', expectedVersion: '1.0.0', session: 'one' })
  item.updater.recover()
  assert.equal(item.updater.state.phase, 'updated')
  assert.equal(readMarker(item.updater.markerPath).status, 'restarting')
  item.updater.acknowledgeLaunch()
  assert.equal(readMarker(item.updater.markerPath).status, 'completed')
  assert.equal(readMarker(item.updater.markerPath).actualVersion, '1.0.0')
})

test('completed updates are not announced again on every launch', t => {
  const item = fixture(t)
  writeMarker(item.updater.markerPath, { status: 'completed', expectedVersion: '1.0.0' })
  item.updater.recover()
  assert.equal(item.updater.state.phase, 'idle')
})
