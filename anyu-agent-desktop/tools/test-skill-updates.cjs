const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { Writable } = require('node:stream')
const archiver = require('archiver')
const { SkillManager } = require('../skill-manager.cjs')
const store = require('../skill-store.cjs')
const { SkillUpdater } = require('../skill-updates.cjs')

const content = '---\nname: demo\ndescription: Demo skill\n---\n'
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function packageFor(id, version = '1.0.0') {
  const chunks = []
  const output = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done() } })
  const archive = archiver('zip')
  const complete = new Promise((resolve, reject) => { output.on('finish', resolve); archive.on('error', reject) })
  archive.pipe(output)
  archive.append(`${content}Version ${version}`, { name: 'SKILL.md' })
  archive.append(`print('${version}')`, { name: 'scripts/run.py' })
  await archive.finalize(); await complete
  const bytes = Buffer.concat(chunks)
  return { skill: { id, name: id, version, sha256: createHash('sha256').update(bytes).digest('hex') }, bytes }
}
async function fixture(t, ids = ['demo']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-skill-sync-'))
  const manager = new SkillManager(directory)
  const packages = []
  for (const id of ids) {
    const original = await packageFor(id)
    await store.installPackage(manager, original.skill, original.bytes, '')
    packages.push(await packageFor(id, '2.0.0'))
  }
  const controls = { busy: false, owner: '1:user', downloads: [], catalogs: 0 }
  const options = {
    manager, owner: () => controls.owner, isBusy: () => controls.busy,
    catalog: async () => { controls.catalogs++; return { skills: packages.map(item => item.skill) } },
    download: async skill => { controls.downloads.push(skill.id); return packages.find(item => item.skill.id === skill.id) },
  }
  const updaters = []
  const create = overrides => { const updater = new SkillUpdater({ ...options, ...overrides }); updaters.push(updater); return updater }
  t.after(() => {
    updaters.forEach(updater => updater.dispose())
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  })
  return { directory, manager, packages, controls, options, create }
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for background skill synchronization')
}

test('startup after app upgrade updates installed store skills, backs up training and stays idempotent across restart', async t => {
  const f = await fixture(t)
  fs.writeFileSync(path.join(f.manager.root, 'demo/SKILL.md'), `${content}Local training`)
  f.manager.saveTraining({ id: 'demo', customRules: 'My preferences', revision: f.manager.readTraining('demo').revision })
  f.manager.saveTraining({ customRules: 'Global preferences', revision: f.manager.readTraining().revision })
  fs.mkdirSync(path.join(f.manager.root, 'local'))
  fs.writeFileSync(path.join(f.manager.root, 'local/SKILL.md'), `${content}Local-only`)
  f.packages.push(await packageFor('local', '2.0.0'), await packageFor('not-installed', '2.0.0'))
  const updater = f.create()
  const result = await updater.sync()
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.updated, ['demo'])
  assert.deepEqual(f.controls.downloads, ['demo'])
  assert.equal(f.manager.read('demo').storeVersion, '2.0.0')
  assert.equal(f.manager.readTraining('demo').customRules, 'My preferences')
  assert.equal(f.manager.readTraining().customRules, 'Global preferences')
  const backups = fs.readdirSync(path.join(f.directory, 'skill-backups'))
  assert.match(fs.readFileSync(path.join(f.directory, 'skill-backups', backups[0], 'SKILL.md'), 'utf8'), /Local training/)
  assert.equal(f.manager.list().length, 2)
  await f.create().sync()
  assert.deepEqual(f.controls.downloads, ['demo'])
})

test('offline startup keeps the old version and retries automatically', async t => {
  const f = await fixture(t)
  let online = false
  const updater = f.create({ retryMs: 10, catalog: async () => { if (!online) throw new Error('offline'); return f.options.catalog() } })
  assert.equal((await updater.sync()).status, 'error')
  assert.equal(f.manager.read('demo').storeVersion, '1.0.0')
  online = true
  await until(() => updater.state.status === 'ready')
  assert.equal(f.manager.read('demo').storeVersion, '2.0.0')
})

test('active tasks defer synchronization and resume automatically without interrupting them', async t => {
  const f = await fixture(t)
  f.controls.busy = true
  const updater = f.create({ idleMs: 10 })
  assert.equal((await updater.sync()).status, 'waiting')
  assert.equal(f.controls.catalogs, 0)
  f.controls.busy = false
  await until(() => updater.state.status === 'ready')
  assert.equal(f.manager.read('demo').storeVersion, '2.0.0')
})

test('a task beginning during download prevents replacement until the next idle retry', async t => {
  const f = await fixture(t)
  const updater = f.create({ download: async skill => { f.controls.busy = true; return f.options.download(skill) } })
  assert.equal((await updater.sync()).status, 'waiting')
  assert.equal(f.manager.read('demo').storeVersion, '1.0.0')
  f.controls.busy = false
  updater.download = f.options.download
  await updater.sync()
  assert.equal(f.manager.read('demo').storeVersion, '2.0.0')
})

test('manual install locks and repeated requests share a single synchronization', async t => {
  const f = await fixture(t)
  const locks = new Set(['demo'])
  const entered = latch(); const release = latch()
  const updater = f.create({ locks, download: async skill => { assert(locks.has(skill.id)); entered.resolve(); await release.promise; return f.options.download(skill) } })
  assert.equal((await updater.sync()).status, 'waiting')
  assert.equal(f.controls.catalogs, 0)
  locks.clear()
  const operation = updater.sync()
  await entered.promise
  assert.equal(updater.sync(), operation)
  release.resolve()
  await operation
  assert.equal(locks.size, 0)
  assert.deepEqual(f.controls.downloads, ['demo'])
})

test('logout and login session changes discard in-flight downloads', async t => {
  const f = await fixture(t)
  const updater = f.create({ download: async skill => { f.controls.owner = '2:user'; return f.options.download(skill) } })
  assert.equal((await updater.sync()).status, 'waiting')
  assert.equal(f.manager.read('demo').storeVersion, '1.0.0')
  f.controls.owner = ''
  assert.equal((await updater.sync()).status, 'idle')
  f.controls.owner = '3:user'
  updater.download = f.options.download
  await updater.sync()
  assert.equal(f.manager.read('demo').storeVersion, '2.0.0')
})

test('one failed package does not block the other installed skills and only failures are retried', async t => {
  const f = await fixture(t, ['demo', 'other'])
  const updater = f.create({ download: async skill => { if (skill.id === 'demo') throw Object.assign(new Error('changed catalog'), { status: 409 }); return f.options.download(skill) } })
  const state = await updater.sync()
  assert.equal(state.status, 'error')
  assert.deepEqual(state.failed, ['demo'])
  assert.equal(f.manager.read('other').storeVersion, '2.0.0')
  updater.download = f.options.download
  assert.equal((await updater.sync()).status, 'ready')
  assert.deepEqual(f.controls.downloads, ['other', 'demo'])
})

test('tampered packages cannot alter the installed version', async t => {
  const f = await fixture(t)
  const revision = store.localRevision(path.join(f.manager.root, 'demo'))
  const updater = f.create({ download: async () => ({ bytes: Buffer.from('tampered') }) })
  assert.equal((await updater.sync()).status, 'error')
  assert.equal(store.localRevision(path.join(f.manager.root, 'demo')), revision)
  assert.equal(updater.commit, null)
})

test('local training changed during a download is never overwritten', async t => {
  const f = await fixture(t)
  const updater = f.create({ download: async skill => {
    fs.writeFileSync(path.join(f.manager.root, 'demo/SKILL.md'), `${content}Training during download`)
    return f.options.download(skill)
  } })
  assert.equal((await updater.sync()).status, 'error')
  assert.match(f.manager.read('demo').content, /Training during download/)
})

test('unpublished skills are retained and stale catalogs cannot downgrade a newer manual installation', async t => {
  const f = await fixture(t, ['demo', 'other'])
  const newer = await packageFor('demo', '3.0.0')
  const updater = f.create({ catalog: async () => {
    await store.installPackage(f.manager, newer.skill, newer.bytes, store.localRevision(path.join(f.manager.root, 'demo')))
    return { skills: [f.packages[0].skill] }
  } })
  assert.equal((await updater.sync()).status, 'ready')
  assert.equal(f.manager.read('demo').storeVersion, '3.0.0')
  assert.equal(f.manager.read('other').storeVersion, '1.0.0')
  assert.deepEqual(f.controls.downloads, [])
})

test('runtime admissions wait through Windows replacement retries', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const rename = fs.renameSync
  const attempted = latch()
  let blocked = false
  fs.renameSync = (source, destination) => {
    if (path.basename(source).startsWith('.store-') && !blocked) {
      blocked = true; attempted.resolve()
      throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    }
    return rename(source, destination)
  }
  try {
    const updater = f.create()
    const operation = updater.sync()
    await attempted.promise
    let admitted = false
    const admission = updater.waitForCommit().then(() => { admitted = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(admitted, false)
    await operation; await admission
    assert.equal(updater.state.status, 'ready')
    assert.equal(f.manager.read('demo').storeVersion, '2.0.0')
  } finally { fs.renameSync = rename }
})

test('a task arriving during a Windows retry rolls the old version back and releases admissions', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const rename = fs.renameSync
  let blocked = false
  fs.renameSync = (source, destination) => {
    if (path.basename(source).startsWith('.store-') && !blocked) {
      blocked = true; f.controls.busy = true
      throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    }
    return rename(source, destination)
  }
  try {
    const updater = f.create()
    assert.equal((await updater.sync()).status, 'waiting')
    assert.equal(f.manager.read('demo').storeVersion, '1.0.0')
    assert.equal(updater.commit, null)
    await updater.waitForCommit()
  } finally { fs.renameSync = rename }
})

test('empty installs do not fetch the catalog or auto-install skills', async t => {
  const f = await fixture(t, [])
  assert.equal((await f.create().sync()).status, 'ready')
  assert.equal(f.controls.catalogs, 0)
})

test('release packaging includes the skill updater required by the main process', () => {
  const metadata = require('../package.json')
  assert(metadata.build.files.includes('skill-updates.cjs'))
  assert(fs.existsSync(path.resolve(__dirname, '../skill-updates.cjs')))
})
