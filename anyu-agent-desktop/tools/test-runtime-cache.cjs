'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { RuntimeCache } = require('../runtime-cache.cjs')
const { bundle } = require('./pack-runtimes.cjs')

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-runtime-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), resourcesPath = path.join(root, 'resources'), output = path.join(resourcesPath, 'runtime-bundles'), cachePath = path.join(root, 'cache')
  fs.mkdirSync(source); fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(source, 'runtime.exe'), 'test-runtime')
  fs.writeFileSync(path.join(source, 'asset.txt'), 'runtime-asset')
  const item = await bundle(source, output, 'runtime.exe', '1.2.3')
  fs.writeFileSync(path.join(output, 'catalog.json'), JSON.stringify({ version: 1, components: { pi: item } }))
  return { root, item, output, resourcesPath, cachePath, cache: new RuntimeCache({ resourcesPath, cachePath }) }
}

test('runtime extraction is verified, concurrent calls share it, and later app versions reuse it offline', async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([f.cache.ensure('pi'), f.cache.ensure('pi')])
  assert.equal(a, b)
  const before = fs.statSync(a).mtimeMs
  fs.rmSync(path.join(f.output, f.item.archive))
  const fresh = new RuntimeCache(f)
  assert.equal(await fresh.ensure('pi'), a)
  assert.equal(fs.statSync(a).mtimeMs, before)
  assert.equal(fs.readFileSync(path.join(path.dirname(a), 'asset.txt'), 'utf8'), 'runtime-asset')
})

test('damaged bundled bytes are never executed and do not replace a valid prior runtime', async t => {
  const f = await fixture(t)
  fs.writeFileSync(path.join(f.output, f.item.archive), 'corrupt')
  await assert.rejects(f.cache.ensure('pi'), /verification failed/)
  assert.equal(fs.existsSync(f.cache.executable('pi')), false)
})

test('missing components keep development and legacy bundle behavior', async t => {
  const f = await fixture(t)
  assert.equal(await f.cache.ensure('legacy', 'original-path'), 'original-path')
})

test('cache content corruption is detected and never overwritten while it may be in use', async t => {
  const f = await fixture(t)
  const executable = await f.cache.ensure('pi')
  fs.writeFileSync(executable, 'test-corrupt')
  await assert.rejects(new RuntimeCache(f).ensure('pi'), /damaged or locked/)
  assert.equal(fs.readFileSync(executable, 'utf8'), 'test-corrupt')
})

test('catalog traversal is rejected before any files are written', async t => {
  const f = await fixture(t)
  f.item.executable = '../escape.exe'
  fs.writeFileSync(path.join(f.output, 'catalog.json'), JSON.stringify({ version: 1, components: { pi: f.item } }))
  assert.throws(() => new RuntimeCache(f), /Invalid runtime file path/)
})

test('unchanged runtime produces byte-identical archives with stable entry order', async t => {
  const f = await fixture(t)
  const source = path.join(f.root, 'source')
  for (let index = 0; index < 64; index++) fs.writeFileSync(path.join(source, `file-${index}.bin`), Buffer.alloc(1024 + index, index))
  const first = await bundle(source, f.output, 'runtime.exe', '1.2.3')
  const second = await bundle(source, f.output, 'runtime.exe', '1.2.3')
  assert.equal(first.id, second.id)
  assert.equal(first.sha256, second.sha256)
  const archive = await require('unzipper').Open.file(path.join(f.output, second.archive))
  assert.deepEqual(archive.files.map(file => file.path), Object.keys(second.files))
})
