const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const archiver = require('archiver')
const { Writable } = require('node:stream')
const { SkillManager } = require('../skill-manager.cjs')
const { decodePackage, installPackage, localRevision, readDownload, packageDetail } = require('../skill-store.cjs')
const content = '---\nname: demo\ndescription: Demo skill\n---\n# Rules\n'
async function zip(files) {
  const chunks = []
  const archive = archiver('zip')
  const output = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done() } })
  const complete = new Promise((resolve, reject) => { output.on('finish', resolve); archive.on('error', reject) })
  archive.pipe(output)
  for (const [name, value] of Object.entries(files)) archive.append(value, { name })
  await archive.finalize(); await complete
  return Buffer.concat(chunks)
}
const metadata = bytes => ({ id: 'demo', version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex') })
test('install, update and preserve trained originals and custom rules', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-store-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manager = new SkillManager(directory)
  const bytes = await zip({ 'SKILL.md': content, 'scripts/run.py': 'print(1)' })
  await installPackage(manager, metadata(bytes), bytes, '')
  assert.equal(manager.list()[0].storeSha256, metadata(bytes).sha256)
  fs.writeFileSync(path.join(manager.root, 'demo/SKILL.md'), `${content}\nLocally trained`)
  const rules = manager.readTraining('demo')
  manager.saveTraining({ id: 'demo', customRules: 'Company preferences', revision: rules.revision })
  const revision = localRevision(path.join(manager.root, 'demo'))
  const next = await zip({ 'SKILL.md': `${content}\nNew version`, 'scripts/run.py': 'print(2)' })
  await installPackage(manager, { ...metadata(next), version: '2.0.0' }, next, revision)
  assert.equal(manager.readTraining('demo').customRules, 'Company preferences')
  assert.equal(manager.list()[0].storeVersion, '2.0.0')
  const backups = fs.readdirSync(path.join(directory, 'skill-backups'))
  assert.equal(backups.length, 1)
  assert.match(fs.readFileSync(path.join(directory, 'skill-backups', backups[0], 'SKILL.md'), 'utf8'), /Locally trained/)
  await assert.rejects(installPackage(manager, metadata(bytes), bytes, revision), /已变更/)
  await assert.rejects(installPackage(manager, metadata(bytes), next, localRevision(path.join(manager.root, 'demo'))), /SHA-256/)
  assert.match(manager.read('demo').content, /New version/)
})
const seedRoot = path.resolve(__dirname, '../../../../backend/internal/anyuagent/skillstore/assets')
test('server seeds contain full resources and are accepted by the independent desktop validator', { skip: !fs.existsSync(seedRoot) && 'Server source is not part of the standalone desktop repository' }, async () => {
  for (const id of ['pptx', 'xlsx']) {
    const bytes = fs.readFileSync(path.join(seedRoot, `${id}.zip`))
    const files = await decodePackage(bytes)
    assert(files.some(f => f.name === 'SKILL.md')); assert(files.some(f => f.name === 'LICENSE.txt')); assert(files.some(f => f.name.startsWith('scripts/')))
  }
})
test('a failure after atomic replacement restores the original local version', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-store-rollback-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manager = new SkillManager(directory)
  const original = await zip({ 'SKILL.md': content })
  await installPackage(manager, metadata(original), original, '')
  fs.writeFileSync(path.join(manager.root, 'ANYU_TRAINING.md'), 'x'.repeat(17000))
  const target = path.join(manager.root, 'demo')
  const before = localRevision(target)
  const update = await zip({ 'SKILL.md': `${content}\nUpdate` })
  await assert.rejects(installPackage(manager, metadata(update), update, before), /训练规则/)
  assert.equal(localRevision(target), before)
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), content)
})
test('Windows transient directory locks retry without losing the previous skill or training', { skip: process.platform !== 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-store-locked-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const manager = new SkillManager(directory)
  const bytes = await zip({ 'SKILL.md': content })
  await installPackage(manager, metadata(bytes), bytes, '')
  const rules = manager.readTraining('demo')
  manager.saveTraining({ id: 'demo', customRules: 'Preserve my preferences', revision: rules.revision })
  const before = localRevision(path.join(manager.root, 'demo'))
  const next = await zip({ 'SKILL.md': `${content}\nUpdated after transient lock` })
  const rename = fs.renameSync
  let blocked = 0
  fs.renameSync = (source, target) => {
    if (path.basename(source).startsWith('.store-') && blocked++ < 2) throw Object.assign(new Error('Transient directory lock'), { code: 'EPERM' })
    return rename(source, target)
  }
  try { await installPackage(manager, metadata(next), next, before) } finally { fs.renameSync = rename }
  assert.equal(blocked, 3)
  assert.match(manager.read('demo').content, /Updated after transient lock/)
  assert.equal(manager.readTraining('demo').customRules, 'Preserve my preferences')
  assert.equal(fs.readdirSync(path.join(directory, 'skill-backups')).length, 1)
  assert.equal(fs.readdirSync(manager.root).filter(name => name.startsWith('.store-')).length, 0)
})

test('Windows retries recheck local edits before moving an existing skill', { skip: process.platform !== 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-store-lock-edit-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const manager = new SkillManager(directory)
  const bytes = await zip({ 'SKILL.md': content })
  await installPackage(manager, metadata(bytes), bytes, '')
  const target = path.join(manager.root, 'demo')
  const before = localRevision(target)
  const next = await zip({ 'SKILL.md': `${content}\nRemote update` })
  const rename = fs.renameSync
  let blocked = false
  fs.renameSync = (source, destination) => {
    if (source === target && !blocked) {
      blocked = true
      setImmediate(() => fs.writeFileSync(path.join(target, 'SKILL.md'), `${content}\nNew local training`))
      throw Object.assign(new Error('Transient directory lock'), { code: 'EBUSY' })
    }
    return rename(source, destination)
  }
  try { await assert.rejects(installPackage(manager, metadata(next), next, before), /本机技能已变更/) } finally { fs.renameSync = rename }
  assert.match(manager.read('demo').content, /New local training/)
  assert.equal(fs.readdirSync(manager.root).filter(name => name.startsWith('.store-')).length, 0)
})

test('package validation rejects collisions, training overrides and Windows device paths', async () => {
  for (const name of ['skill.md', 'ANYU_TRAINING.md', 'con.txt', 'scripts/bad.', '.anyu-store.json']) {
    await assert.rejects(decodePackage(await zip({ 'SKILL.md': content, [name]: 'bad' })))
  }
})
test('download bounds and HTTP failures are enforced', async () => {
  assert.equal((await readDownload(new Response('test'))).toString(), 'test')
  await assert.rejects(readDownload(new Response('bad', { status: 403 })), /403/)
  await assert.rejects(readDownload(new Response('small', { headers: { 'content-length': String(17 * 1024 * 1024) } })), /超限/)
})

test('trusted package detail supports legacy packages and normalizes optional fields', async () => {
  const legacy = await zip({ 'SKILL.md': content })
  assert.equal((await packageDetail(metadata(legacy), legacy)).content, content)
  const info = { schema_version: 1, summary: '商品视觉', starter: '请处理附件商品。', steps: null, examples: null, sources: null }
  const bytes = await zip({ 'SKILL.md': content, 'anyu-skill.json': JSON.stringify(info) })
  const detail = await packageDetail(metadata(bytes), bytes)
  assert.deepEqual(detail.experience.steps, [])
  assert.deepEqual(detail.experience.examples, [])
  assert.deepEqual(detail.experience.sources, [])
  assert.deepEqual(detail.experience.required_tools, [])
  await assert.rejects(packageDetail({ ...metadata(bytes), sha256: '0'.repeat(64) }, bytes), /SHA-256/)
})

test('detail validation rejects malformed metadata and unsupported nested fields', async () => {
  const valid = { schema_version: 1, summary: '商品视觉', starter: '请处理附件商品。' }
  for (const patch of [
    { schema_version: 2 }, { unknown: 'field' }, { summary: 'x'.repeat(801) },
    { steps: 'not an array' }, { examples: 0 }, { sources: false }, { required_tools: ['bad tool'] },
    { examples: [{ title: '示例', prompt: '需求', unknown: true }] },
    { sources: [{ name: 'Source', license: 'MIT', url: 'https://name:secret@example.com/' }] },
    { sources: [{ name: 'Source', license: 'MIT', url: 'javascript:alert(1)' }] },
    { sources: [{ name: 'Source', license: 'MIT', url: 'https://example.com/', unknown: true }] }
  ]) {
    const bytes = await zip({ 'SKILL.md': content, 'anyu-skill.json': JSON.stringify({ ...valid, ...patch }) })
    await assert.rejects(packageDetail(metadata(bytes), bytes), /信息|标识|示例|来源/)
  }
})
