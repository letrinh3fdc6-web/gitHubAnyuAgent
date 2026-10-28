const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { fileURLToPath } = require('node:url')

function allowedBrowserUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return false
    return true
  } catch { return false }
}

function workspaceFile(root, requested) {
  // 先做词法边界检查，调用方还需对真实路径重复检查符号链接。
  const candidate = path.resolve(root, requested)
  const relative = path.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('文件不在当前工作区内')
  return candidate
}

function localFilePath(cwd, requested) {
  let value = String(requested || '').trim()
  if (/^file:/i.test(value)) value = fileURLToPath(value)
  else if (value.startsWith('artifact://')) value = value.slice('artifact://'.length)
  if (/^~(?:[\\/]|$)/.test(value)) value = path.join(require('node:os').homedir(), value.slice(1))
  if (!value || value.includes('\0')) throw new Error('文件路径无效')
  if (!path.isAbsolute(value) && !path.isAbsolute(String(cwd || ''))) throw new Error('相对路径需要选择工作目录')
  return fs.realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value))
}

// Each explicitly opened file gets its own origin; old pages cannot read a new preview.
class ArtifactPreviews {
  constructor() { this.entries = new Map() }
  open(file, cwd) {
    let root = path.dirname(file)
    try {
      const workspace = fs.realpathSync(cwd)
      workspaceFile(workspace, path.relative(workspace, file))
      root = workspace
    } catch {}
    const id = crypto.randomBytes(24).toString('hex')
    const resources = /\.html?$/i.test(file)
    this.entries.set(id, { root, file, resources })
    if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value)
    return `leta-preview://${id}/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/')}`
  }
  resolve(value, referer = '') {
    const url = new URL(value)
    const entry = this.entries.get(url.hostname)
    if (url.protocol !== 'leta-preview:' || !entry || url.username || url.password || url.port) throw new Error('预览已失效')
    if (referer) {
      const source = new URL(referer)
      if (source.protocol !== url.protocol || source.host !== url.host) throw new Error('跨站资源请求不允许')
    }
    const candidate = workspaceFile(entry.root, `.${decodeURIComponent(url.pathname)}`)
    const real = fs.realpathSync(candidate)
    workspaceFile(entry.root, path.relative(entry.root, real))
    if (!entry.resources && real !== entry.file) throw new Error('文件未被选中预览')
    return real
  }
  has(value) {
    try { const url = new URL(value); return url.protocol === 'leta-preview:' && this.entries.has(url.hostname) } catch { return false }
  }
  clear() { this.entries.clear() }
}

module.exports = { allowedBrowserUrl, workspaceFile, localFilePath, ArtifactPreviews }
