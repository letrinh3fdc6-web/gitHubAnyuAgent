const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const {createHash} = require('node:crypto')
const archiver = require('archiver')
const {VideoStudio, checkedManifest, extract} = require('../video-studio.cjs')

async function zip(file, entries) {
  const output = require('node:fs').createWriteStream(file), archive = archiver('zip')
  const finished = new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); output.on('error', reject) })
  archive.pipe(output); for (const [name, content] of Object.entries(entries)) archive.append(content, {name})
  await archive.finalize(); await finished
}
test('runtime manifests bind downloads to the configured origin and enforce client compatibility', () => {
  const component = {path: '/downloads/anyu-video-studio/0.1.0/test.zip', sha256: 'a'.repeat(64), size: 1000, unpackedSize: 2000}
  const manifest = {schema: 1, id: 'anyu-video-studio', version: '0.1.0', minClientVersion: '1.0.82', platforms: {[`${process.platform}-${process.arch}`]: component}}
  assert.equal(checkedManifest(manifest, 'https://x.ailzd.com/api/v1', '1.0.82').url, 'https://x.ailzd.com/downloads/anyu-video-studio/0.1.0/test.zip')
  assert.throws(() => checkedManifest(manifest, 'https://x.ailzd.com', '1.0.81'), /1.0.82/)
  assert.throws(() => checkedManifest({...manifest, platforms: {}}, 'https://x.ailzd.com', '1.0.82'), /不支持/)
  component.path = 'https://other.invalid/file.zip'; assert.throws(() => checkedManifest(manifest, 'https://x.ailzd.com', '1.0.82'), /路径/)
})
test('download, verify, health-check, atomically install; duplicate preparation shares a job', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-video-install-'))
  let server, studio
  try {
    const archive = path.join(root, 'runtime.zip')
    await zip(archive, {'runtime/service.mjs': "import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);process.stdout.write(JSON.stringify({id:r.id,result:{ready:true}})+'\\n')}).on('close',()=>process.exit());", 'editor/dist/index.html': '<title>Test runtime</title>', 'padding.txt': 'internal-test-only '.repeat(1000)})
    const bytes = await fs.readFile(archive), sha256 = createHash('sha256').update(bytes).digest('hex')
    let requests = 0
    server = http.createServer((req, res) => { requests++; res.writeHead(200, {'Content-Length': bytes.length}); res.end(bytes) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const skills = {root: path.join(root, 'skills')}; await fs.mkdir(path.join(skills.root, 'anyu-video-studio'), {recursive: true})
    await fs.writeFile(path.join(skills.root, 'anyu-video-studio/SKILL.md'), 'test')
    await fs.writeFile(path.join(skills.root, 'anyu-video-studio/ANYU_RUNTIME.json'), JSON.stringify({schema: 1, id: 'anyu-video-studio', version: '0.1.0', minClientVersion: '1.0.82', platforms: {[`${process.platform}-${process.arch}`]: {path: '/downloads/anyu-video-studio/test.zip', sha256, size: bytes.length, unpackedSize: 40000}}}))
    studio = new VideoStudio({userData: root, skills, version: '1.0.82', apiBase: () => `http://127.0.0.1:${server.address().port}`})
    assert.equal(studio.status().status, 'not-installed')
    await Promise.all([studio.prepare(), studio.prepare()]); assert.equal(requests, 1); assert.equal(studio.status().status, 'ready')
    await studio.prepare(); assert.equal(requests, 1)
    const traversal = path.join(root, 'bad.zip'); await zip(traversal, {'CON.txt': 'bad'})
    await assert.rejects(extract(traversal, path.join(root, 'bad-out'), 1000), /不安全/)
    const bounded = path.join(root, 'bounded.zip'); await zip(bounded, {'large.txt': 'x'.repeat(10000)})
    await assert.rejects(extract(bounded, path.join(root, 'bounded-out'), 1000), /超限/)
  } finally { await studio?.close(); if (server) await new Promise(resolve => server.close(resolve)); await fs.rm(root, {recursive: true, force: true, maxRetries: 4, retryDelay: 250}) }
})
test('failed component health never becomes ready and retry remains possible', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-video-failure-'))
  let server, studio
  try {
    const archive = path.join(root, 'runtime.zip')
    await zip(archive, {'runtime/service.mjs': "process.stderr.write('missing dependency');process.exit(1)", 'editor/dist/index.html': 'test', 'padding.txt': 'test '.repeat(2000)})
    const bytes = await fs.readFile(archive), sha256 = createHash('sha256').update(bytes).digest('hex')
    server = http.createServer((req, res) => { res.writeHead(200, {'Content-Length': bytes.length}); res.end(bytes) }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const skills = {root: path.join(root, 'skills')}; await fs.mkdir(path.join(skills.root, 'anyu-video-studio'), {recursive: true})
    await fs.writeFile(path.join(skills.root, 'anyu-video-studio/ANYU_RUNTIME.json'), JSON.stringify({schema: 1, id: 'anyu-video-studio', version: '0.1.0', minClientVersion: '1.0.82', platforms: {[`${process.platform}-${process.arch}`]: {path: '/downloads/anyu-video-studio/test.zip', sha256, size: bytes.length, unpackedSize: 20000}}}))
    studio = new VideoStudio({userData: root, skills, version: '1.0.82', apiBase: () => `http://127.0.0.1:${server.address().port}`})
    await assert.rejects(studio.prepare(), /退出/); assert.equal(studio.status().status, 'failed')
    assert.equal(require('node:fs').existsSync(path.join(studio.root, sha256, '.ready.json')), false)
    await assert.rejects(studio.prepare(), /退出/)
  } finally { await studio?.close(); if (server) await new Promise(resolve => server.close(resolve)); await fs.rm(root, {recursive: true, force: true, maxRetries: 4, retryDelay: 250}) }
})
