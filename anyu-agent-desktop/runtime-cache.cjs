'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid runtime file path')
  return value
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

class RuntimeCache {
  constructor({ resourcesPath, cachePath }) {
    this.resourcesPath = resourcesPath
    this.cachePath = cachePath
    this.pending = new Map()
    const catalog = path.join(resourcesPath, 'runtime-bundles/catalog.json')
    this.catalog = fs.existsSync(catalog) ? JSON.parse(fs.readFileSync(catalog, 'utf8')) : { components: {} }
    if (this.catalog.version !== undefined && this.catalog.version !== 1) throw new Error('Unsupported runtime catalog')
    for (const item of Object.values(this.catalog.components)) {
      if (!/^[a-f0-9]{64}$/.test(item.id) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw new Error('Invalid runtime catalog')
      safeRelative(item.archive)
      safeRelative(item.executable)
      if (!item.files?.[item.executable]) throw new Error('Missing runtime executable')
      for (const [name, file] of Object.entries(item.files)) {
        safeRelative(name)
        if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid runtime file')
      }
      if (crypto.createHash('sha256').update(JSON.stringify(item.files)).digest('hex') !== item.id) throw new Error('Invalid runtime identity')
    }
  }

  executable(name, fallback) {
    const item = this.catalog.components[name]
    return item ? path.join(this.cachePath, item.id, item.executable) : fallback
  }

  async validate(directory, item) {
    try {
      if ((await fs.promises.lstat(directory)).isSymbolicLink()) return false
      for (const [relative, expected] of Object.entries(item.files)) {
        const file = path.join(directory, relative)
        const stat = await fs.promises.lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes || await hashFile(file) !== expected.sha256) return false
        const real = await fs.promises.realpath(file)
        if (!real.startsWith((await fs.promises.realpath(directory)) + path.sep)) return false
      }
      return true
    } catch { return false }
  }

  ensure(name, fallback) {
    const item = this.catalog.components[name]
    if (!item) return Promise.resolve(fallback)
    if (!this.pending.has(item.id)) {
      const operation = this.materialize(item).catch(error => { this.pending.delete(item.id); throw error })
      this.pending.set(item.id, operation)
    }
    return this.pending.get(item.id)
  }

  async materialize(item) {
    const directory = path.join(this.cachePath, item.id)
    if (await this.validate(directory, item)) return path.join(directory, item.executable)
    const archive = path.join(this.resourcesPath, 'runtime-bundles', item.archive)
    if ((await fs.promises.stat(archive)).size !== item.bytes || await hashFile(archive) !== item.sha256) throw new Error('Runtime archive verification failed; repair the installation')
    await fs.promises.mkdir(this.cachePath, { recursive: true })
    const staging = await fs.promises.mkdtemp(path.join(this.cachePath, '.prepare-'))
    try {
      const zip = await require('unzipper').Open.file(archive)
      const seen = new Set()
      for (const entry of zip.files) {
        if (entry.type === 'Directory') continue
        const relative = safeRelative(entry.path)
        const expected = item.files[relative]
        if (!expected || seen.has(relative) || entry.uncompressedSize !== expected.bytes || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error('Unexpected runtime archive entry')
        seen.add(relative)
        const destination = path.join(staging, relative)
        await fs.promises.mkdir(path.dirname(destination), { recursive: true })
        await pipeline(entry.stream(), fs.createWriteStream(destination, { flags: 'wx', mode: 0o700 }))
      }
      if (seen.size !== Object.keys(item.files).length || !await this.validate(staging, item)) throw new Error('Extracted runtime verification failed')
      // Never overwrite a runtime another instance may be executing.
      try { await fs.promises.rename(staging, directory) }
      catch (error) {
        if (!await this.validate(directory, item)) throw new Error(`Runtime cache is damaged or locked: ${directory}`, { cause: error })
      }
      return path.join(directory, item.executable)
    } finally { await fs.promises.rm(staging, { recursive: true, force: true }) }
  }
}

module.exports = { RuntimeCache, hashFile, safeRelative }
