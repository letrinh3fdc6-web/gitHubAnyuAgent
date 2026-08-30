const crypto = require('crypto')

const DEFAULT_MANIFEST_URL = 'https://x.ailzd.com/downloads/downloads-manifest.json'

function versionParts(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/) || []
  return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0), match[4] || '']
}

function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  if (a[3] === b[3]) return 0
  if (!a[3]) return 1
  if (!b[3]) return -1
  return a[3].localeCompare(b[3], undefined, { numeric: true })
}

function artifactFromManifest(manifest, currentVersion) {
  if (!manifest || typeof manifest !== 'object') throw new Error('更新目录格式无效')
  const configured = manifest.anyuAgent || manifest.anyuagent || manifest.app
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  const candidate = configured && typeof configured === 'object'
    ? configured
    : artifacts
      .filter((item) => /anyuagent|anyu-ai-tool-manager/i.test(String(item?.name || '')))
      .sort((a, b) => compareVersions(b.version || String(b.name).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1], a.version || String(a.name).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1]))[0]
  if (!candidate || !candidate.name) throw new Error('更新目录中没有 AnYuAgent 安装包')
  const version = String(candidate.version || String(candidate.name).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] || '').trim()
  if (!version) throw new Error('更新目录缺少 AnYuAgent 版本号')
  const bytes = Number(candidate.bytes)
  const sha256 = String(candidate.sha256 || '').trim().toLowerCase()
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('更新包校验信息不完整')
  const basePath = String(manifest.basePath || '/downloads').replace(/\/$/, '')
  const relativeUrl = String(candidate.url || `${basePath}/${candidate.name}`).replace(/^\//, '')
  const url = /^https?:\/\//i.test(relativeUrl) ? relativeUrl : `${DEFAULT_MANIFEST_URL.replace(/\/downloads\/downloads-manifest\.json$/i, '')}/${relativeUrl}`
  return { version, name: String(candidate.name), bytes, sha256, url, currentVersion: String(currentVersion || '') }
}

function verifyBuffer(buffer, expectedBytes, expectedSha256) {
  if (!Buffer.isBuffer(buffer)) throw new Error('更新包下载结果无效')
  if (Number(expectedBytes) !== buffer.length) throw new Error(`更新包大小校验失败（期望 ${expectedBytes}，实际 ${buffer.length}）`)
  const actual = crypto.createHash('sha256').update(buffer).digest('hex')
  if (actual.toLowerCase() !== String(expectedSha256 || '').toLowerCase()) throw new Error('更新包 SHA-256 校验失败')
  return actual
}

module.exports = { DEFAULT_MANIFEST_URL, versionParts, compareVersions, artifactFromManifest, verifyBuffer }
