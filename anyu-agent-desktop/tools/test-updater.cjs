const assert = require('assert')
const crypto = require('crypto')
const { compareVersions, artifactFromManifest, verifyBuffer } = require('../updater.cjs')

assert(compareVersions('1.0.9', '1.0.8') > 0)
assert(compareVersions('v1.0.8', '1.0.8') === 0)
assert(compareVersions('1.0.8-beta.1', '1.0.8') < 0)

const buffer = Buffer.from('anyu-agent-updater-test')
const manifest = {
  basePath: '/downloads',
  anyuAgent: {
    version: '1.0.9', name: 'AnYuAgent-Setup-1.0.9.exe', bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'), url: '/downloads/AnYuAgent-Setup-1.0.9.exe'
  }
}
const artifact = artifactFromManifest(manifest, '1.0.8')
assert.strictEqual(artifact.version, '1.0.9')
assert.strictEqual(artifact.url, 'https://x.ailzd.com/downloads/AnYuAgent-Setup-1.0.9.exe')
assert.strictEqual(artifact.currentVersion, '1.0.8')
assert.strictEqual(verifyBuffer(buffer, buffer.length, artifact.sha256).length, 64)
assert.throws(() => verifyBuffer(buffer, buffer.length + 1, artifact.sha256), /大小校验失败/)
assert.throws(() => verifyBuffer(buffer, buffer.length, '0'.repeat(64)), /SHA-256 校验失败/)
console.log('updater version parsing: passed')
console.log('updater manifest parsing: passed')
console.log('updater package verification: passed')
