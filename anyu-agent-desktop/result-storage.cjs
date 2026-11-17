'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { localFileCandidate } = require('./browser-policy.cjs')

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const inside = (root, file) => { const relative = path.relative(root, file); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const missing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR'

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'
  try {
    const handle = await fsp.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await fsp.rename(temporary, file)
  } finally { await fsp.rm(temporary, { force: true }).catch(() => {}) }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

async function verifiedCopy(source, target, { exclusive = false } = {}) {
  const before = await fsp.stat(source)
  if (!before.isFile()) throw new Error('Result is not a regular file: ' + source)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const temporary = target + '.' + crypto.randomUUID() + '.tmp'
  const hash = crypto.createHash('sha256')
  try {
    await pipeline(fs.createReadStream(source), new Transform({ transform(chunk, _, done) { hash.update(chunk); done(null, chunk) } }), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    const after = await fsp.stat(source)
    const sha256 = hash.digest('hex')
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || (await fsp.stat(temporary)).size !== before.size || await hashFile(temporary) !== sha256) {
      throw new Error('Result changed while being preserved; retry after the writer finishes: ' + source)
    }
    const handle = await fsp.open(temporary, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    if (exclusive) {
      // Publish a complete immutable blob once, without replacing one being read.
      try { await fsp.link(temporary, target) } catch (error) { if (error.code !== 'EEXIST') throw error }
    } else await fsp.rename(temporary, target)
    return { sha256, bytes: before.size }
  } finally { await fsp.rm(temporary, { force: true }).catch(() => {}) }
}

async function copyTree(source, target, originalRoot = source, targetRoot = target) {
  await fsp.mkdir(target, { recursive: true })
  let files = 0
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name)
    if (entry.isSymbolicLink()) {
      const real = await fsp.realpath(from)
      const link = inside(originalRoot, real) ? path.join(targetRoot, path.relative(originalRoot, real)) : real
      const stat = await fsp.stat(from)
      await fsp.symlink(link, to, stat.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file')
    } else if (entry.isDirectory()) files += await copyTree(from, to, originalRoot, targetRoot)
    else if (entry.isFile()) { await verifiedCopy(from, to); files++ }
    else throw new Error('Unsupported workspace entry; original workspace was retained: ' + from)
  }
  return files
}

// Persistent user data is independent of application binaries, OS temporary
// files and preview tokens. Legacy paths are mapped by full root, never basename.
class ResultStorage {
  constructor({ userData, legacyRoots = [], onWarning = () => {} }) {
    this.userData = path.resolve(userData)
    this.workspace = path.join(this.userData, 'workspace')
    this.directory = path.join(this.userData, 'result-storage')
    this.imports = path.join(this.directory, 'workspaces')
    this.legacyRoots = new Set(legacyRoots.map(root => path.resolve(root)))
    this.onWarning = onWarning
    this.migrations = new Map()
    this.writes = new Map()
    this.saved = new Map()
    this.pending = new Set()
    this.calls = new Map()
  }

  registerLegacy(root) {
    if (root && path.isAbsolute(root) && key(root) !== key(this.workspace)) this.legacyRoots.add(path.resolve(root))
  }

  async initialize() {
    if (!this.initializing) {
      this.initializing = (async () => {
        await fsp.mkdir(this.workspace, { recursive: true })
        await fsp.mkdir(this.imports, { recursive: true })
        for (const entry of await fsp.readdir(this.imports, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue
          const record = JSON.parse(await fsp.readFile(path.join(this.imports, entry.name, 'record.json'), 'utf8'))
          if (record.complete !== true || !path.isAbsolute(record.source || '') || digest(key(record.source)) !== entry.name) throw new Error('Workspace migration record is invalid')
          this.registerLegacy(record.source)
        }
      })().catch(error => { this.initializing = null; throw error })
    }
    return this.initializing
  }

  legacyRoot(file) {
    return [...this.legacyRoots].sort((a, b) => b.length - a.length).find(root => inside(root, file))
  }

  originalPath(file) {
    for (const root of this.legacyRoots) {
      const imported = path.join(this.importDirectory(root), 'workspace')
      if (inside(imported, file)) return path.join(root, path.relative(imported, file))
    }
    return file
  }

  importDirectory(root) { return path.join(this.imports, digest(key(root))) }

  async backupSource(root) {
    const installation = path.dirname(root)
    const backups = installation + '.workspace-backups'
    let entries
    try { entries = await fsp.readdir(backups, { withFileTypes: true }) } catch (error) { if (missing(error)) return ''; throw error }
    for (const entry of entries.filter(entry => entry.isDirectory() && !entry.name.endsWith('.partial')).sort((a, b) => b.name.localeCompare(a.name))) {
      try {
        const folder = path.join(backups, entry.name)
        const record = JSON.parse(await fsp.readFile(path.join(folder, 'backup.json'), 'utf8'))
        if (record.version === 1 && record.complete === true && key(record.source) === key(root)) return path.join(folder, 'workspace')
      } catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error }
    }
    return ''
  }

  async migrate(root) {
    const id = key(root)
    if (this.migrations.has(id)) return this.migrations.get(id)
    const operation = this.importWorkspace(root)
    this.migrations.set(id, operation)
    try { return await operation } catch (error) { this.migrations.delete(id); throw error }
  }

  async importWorkspace(root) {
    await this.initialize()
    const directory = this.importDirectory(root), target = path.join(directory, 'workspace')
    try {
      const record = JSON.parse(await fsp.readFile(path.join(directory, 'record.json'), 'utf8'))
      if (record.version !== 1 || key(record.source) !== key(root) || record.complete !== true) throw new Error('Workspace migration record is invalid')
      if (!(await fsp.stat(target)).isDirectory()) throw new Error('Persistent workspace is unavailable')
      return target
    } catch (error) { if (!missing(error)) throw error }
    let source = root
    try { if (!(await fsp.stat(source)).isDirectory()) throw new Error('Legacy workspace is not a directory') }
    catch (error) { if (!missing(error)) throw error; source = await this.backupSource(root) }
    const staging = directory + '.' + crypto.randomUUID() + '.partial'
    try {
      const stagedWorkspace = path.join(staging, 'workspace')
      const files = source ? await copyTree(source, stagedWorkspace, source, target) : 0
      await fsp.mkdir(stagedWorkspace, { recursive: true })
      await atomicJson(path.join(staging, 'record.json'), { version: 1, source: root, copiedFrom: source, files, complete: true, at: new Date().toISOString() })
      await fsp.rename(staging, directory)
      return target
    } catch (error) {
      // Only discard the unique staging directory created by this operation.
      if (path.dirname(staging) === this.imports && staging.startsWith(directory + '.') && staging.endsWith('.partial')) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
      }
      throw new Error('工作区保护未完成，原文件已保留：' + error.message)
    }
  }

  async resolveWorkspace(cwd) {
    await this.initialize()
    if (!cwd) return this.workspace
    const candidate = this.originalPath(localFileCandidate('', cwd))
    const root = this.legacyRoot(candidate)
    if (!root) return candidate
    return path.join(await this.migrate(root), path.relative(root, candidate))
  }

  async mappedPath(candidate) {
    candidate = this.originalPath(candidate)
    const root = this.legacyRoot(candidate)
    return root ? path.join(await this.migrate(root), path.relative(root, candidate)) : candidate
  }

  recordFile(source) { return path.join(this.directory, 'records', digest(key(source)) + '.json') }

  async resolve(cwd, requested) {
    await this.initialize()
    const original = localFileCandidate(cwd, requested)
    const mapped = await this.mappedPath(original)
    try { return await fsp.realpath(mapped) } catch (error) { if (!missing(error)) throw error }
    for (const candidate of new Set([original, mapped])) {
      try {
        const record = JSON.parse(await fsp.readFile(this.recordFile(candidate), 'utf8'))
        if (key(record.source) !== key(candidate)) throw new Error('Result record path mismatch')
        return await this.restoreRecord(record)
      } catch (error) { if (!missing(error)) throw error }
    }
    const recovered = await this.recoverCheckpoint(this.originalPath(original))
    if (recovered) return recovered
    const error = new Error('结果文件已不存在，且未找到可验证的本地副本。原路径：' + original)
    error.code = 'ENOENT'
    throw error
  }

  async restoreRecord(record) {
    if (!/^[a-f0-9]{64}$/.test(record.sha256 || '') || !path.isAbsolute(record.root) || !record.relative || path.isAbsolute(record.relative) || !inside(record.root, path.resolve(record.root, record.relative))) throw new Error('Invalid result recovery record')
    const blob = path.join(this.directory, 'blobs', record.sha256)
    if (await hashFile(blob) !== record.sha256) throw new Error('结果副本校验失败，已停止恢复，避免打开损坏内容')
    const target = path.join(this.directory, 'files', digest(key(record.root)), record.relative)
    // A recovered file can become the user's working copy. Never reset edits.
    try { if ((await fsp.stat(target)).isFile()) return target } catch (error) { if (!missing(error)) throw error }
    await verifiedCopy(blob, target)
    return target
  }

  async preserve(file, cwd, original = file) {
    const real = await fsp.realpath(file)
    if (['files', 'blobs', 'recovered'].some(folder => inside(path.join(this.directory, folder), real))) return real
    const operationKey = key(real)
    const previous = this.writes.get(operationKey) || Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      const stat = await fsp.stat(real)
      if (!stat.isFile()) return real
      let root = path.dirname(real)
      if (cwd) {
        try { const canonical = await fsp.realpath(cwd); if (inside(canonical, real)) root = canonical } catch (error) { if (!missing(error)) throw error }
      }
      const relative = path.relative(root, real), mirror = path.join(this.directory, 'files', digest(key(root)), relative)
      const signature = JSON.stringify([key(root), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
      const saved = this.saved.get(operationKey)
      if (saved?.signature === signature) {
        try {
          await fsp.access(mirror)
          await fsp.access(path.join(this.directory, 'blobs', saved.record.sha256))
          if (key(original) !== key(real) && !saved.aliases.has(key(original))) {
            await atomicJson(this.recordFile(original), { ...saved.record, source: original })
            saved.aliases.add(key(original))
          }
          return mirror
        } catch (error) { if (!missing(error)) throw error }
      }
      const result = await verifiedCopy(real, mirror)
      const blob = path.join(this.directory, 'blobs', result.sha256)
      await fsp.mkdir(path.dirname(blob), { recursive: true })
      try { await fsp.access(blob) } catch (error) { if (!missing(error)) throw error; await verifiedCopy(mirror, blob, { exclusive: true }) }
      if (await hashFile(blob) !== result.sha256) throw new Error('结果副本校验失败：' + path.basename(real))
      const record = { version: 1, source: real, root, relative, ...result, at: new Date().toISOString() }
      await atomicJson(this.recordFile(real), record)
      if (key(original) !== key(real)) await atomicJson(this.recordFile(original), { ...record, source: original })
      if (this.saved.size >= 4096) this.saved.delete(this.saved.keys().next().value)
      this.saved.set(operationKey, { signature, record, aliases: new Set([key(original)]) })
      return mirror
    })
    this.writes.set(operationKey, operation)
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation); if (this.writes.get(operationKey) === operation) this.writes.delete(operationKey) }
  }

  async preserveResult(cwd, requested) {
    const original = localFileCandidate(cwd, requested)
    const real = await this.resolve(cwd, requested)
    if (!(await fsp.stat(real)).isFile()) return real
    const root = cwd ? await this.resolveWorkspace(cwd) : path.dirname(real)
    await this.preserve(real, root, original)
    await this.preserveDependencies(real, root)
    return real
  }

  async previewRoot(file, cwd) {
    for (const folder of ['files', 'recovered']) {
      const base = path.join(this.directory, folder)
      if (inside(base, file)) return path.join(base, path.relative(base, file).split(path.sep)[0])
    }
    if (cwd) {
      const mapped = await this.resolveWorkspace(cwd)
      try { const root = await fsp.realpath(mapped); if (inside(root, file)) return root } catch (error) { if (!missing(error)) throw error }
    }
    return path.dirname(file)
  }

  async preserveDependencies(file, cwd, visited = new Set()) {
    const root = await this.previewRoot(file, cwd)
    if (visited.has(key(file))) return
    visited.add(key(file))
    if (visited.size > 2000) throw new Error('结果关联文件过多，持久保存未完成，请将完整项目保存在工作区')
    const extension = path.extname(file).toLowerCase()
    if (!['.html', '.htm', '.svg', '.css'].includes(extension)) return
    const source = await fsp.readFile(file, 'utf8')
    const references = []
    if (extension === '.css') {
      for (const match of source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+["']([^"']+)["']/gi)) references.push(match[1] || match[2] || match[3] || match[4])
    } else {
      const { DOMParser } = require('@xmldom/xmldom')
      let document
      try { document = new DOMParser({ onError() {} }).parseFromString(source, extension === '.svg' ? 'image/svg+xml' : 'text/html') }
      catch { this.onWarning(new Error('原文件已保存，但无法解析关联资源：' + path.basename(file)), { path: file }); return }
      for (const element of Array.from(document.getElementsByTagName('*'))) {
        for (const attribute of ['src', 'href', 'xlink:href', 'poster']) if (element.hasAttribute(attribute)) references.push(element.getAttribute(attribute))
        const style = element.getAttribute('style') || (element.tagName.toLowerCase() === 'style' ? element.textContent : '')
        for (const match of String(style).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) references.push(match[1])
      }
    }
    for (const reference of references) {
      if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue
      let relative
      try { relative = decodeURIComponent(reference.split(/[?#]/)[0]) } catch { continue }
      if (!relative) continue
      const candidate = relative.startsWith('/') ? path.resolve(root, '.' + relative) : path.resolve(path.dirname(file), relative)
      if (!inside(root, candidate) || visited.has(key(candidate))) continue
      let real
      try { real = await fsp.realpath(candidate); if (!inside(root, real) || !(await fsp.stat(real)).isFile()) continue }
      catch (error) { if (missing(error)) continue; throw error }
      await this.preserve(real, root)
      await this.preserveDependencies(real, root, visited)
    }
  }

  async preserveCheckpoint(task, snapshot) {
    if (!snapshot) return
    for (const change of task.changes || []) {
      if (!change.after) continue
      const file = path.resolve(task.cwd, change.path)
      if (!inside(task.cwd, file)) continue
      await this.preserve(file, task.cwd)
    }
  }

  async recoverCheckpoint(original) {
    const directory = path.join(this.userData, 'task-workbench', 'blobs')
    let names
    try { names = await fsp.readdir(path.join(directory, 'manifests')) } catch (error) { if (missing(error)) return ''; throw error }
    const matches = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let snapshot
      try { snapshot = JSON.parse(await fsp.readFile(path.join(directory, 'manifests', name), 'utf8')) } catch { continue }
      if (!snapshot?.cwd || !path.isAbsolute(snapshot.cwd) || !inside(snapshot.cwd, original)) continue
      const relative = path.relative(snapshot.cwd, original).split(path.sep).join('/')
      if (snapshot.files?.[relative]?.hash) matches.push({ snapshot, relative })
    }
    matches.sort((a, b) => String(b.snapshot.at).localeCompare(String(a.snapshot.at)))
    if (!matches.length) return ''
    const { snapshot, relative } = matches[0]
    const root = path.join(this.directory, 'recovered', digest(key(snapshot.cwd) + '\n' + snapshot.at))
    for (const [name, entry] of Object.entries(snapshot.files)) {
      const target = path.resolve(root, name)
      if (path.isAbsolute(name) || !inside(root, target) || target === root || !/^[a-f0-9]{64}$/.test(entry.hash || '')) throw new Error('Invalid workspace recovery snapshot')
      const blob = path.join(directory, entry.hash)
      if (await hashFile(blob) !== entry.hash) throw new Error('历史结果副本校验失败，原始记录已保留')
      try { if ((await fsp.stat(target)).isFile()) continue } catch (error) { if (!missing(error)) throw error }
      await verifiedCopy(blob, target)
    }
    return path.join(root, relative)
  }

  observe(event, record) {
    if (event.type === 'run.finished') {
      for (const id of this.calls.keys()) if (id.startsWith(event.sessionId + ':')) this.calls.delete(id)
      return
    }
    if (event.type === 'message.completed' && record?.cwd && event.content) {
      const pending = (async () => {
        const { marked } = await import('marked')
        const files = new Set()
        marked.walkTokens(marked.lexer(String(event.content)), token => {
          const candidate = token.type === 'link' || token.type === 'image' ? token.href : token.type === 'codespan' ? token.text : ''
          if (typeof candidate !== 'string' || !candidate || /^(?:https?:|data:|mailto:|#|\/\/)/i.test(candidate)) return
          if (token.type === 'codespan' && !path.isAbsolute(candidate) && !/^file:/i.test(candidate)) return
          files.add(candidate)
        })
        for (const file of files) {
          try { await this.preserveResult(record.cwd, file) }
          catch (error) { if (!missing(error)) this.onWarning(error, { sessionId: event.sessionId, path: file }) }
        }
      })().catch(error => this.onWarning(error, { sessionId: event.sessionId })).finally(() => this.pending.delete(pending))
      this.pending.add(pending)
      return
    }
    const id = event.sessionId + ':' + event.toolCallId
    if (event.type === 'tool.started') { this.calls.set(id, { name: event.toolName, args: event.args }); return }
    if (event.type !== 'tool.completed') return
    const started = this.calls.get(id)
    this.calls.delete(id)
    if (event.isError || !record?.cwd) return
    const name = event.toolName || started?.name || ''
    const args = Object.keys(event.args || {}).length ? event.args : started?.args || {}
    if (!/^(?:write|edit|write_file|edit_file|browser_open|create_file)$/i.test(name)) return
    const file = args.path || args.file_path || args.filePath || args.file
    if (typeof file !== 'string' || !file.trim()) return
    const pending = this.preserveResult(record.cwd, file).catch(error => this.onWarning(error, { sessionId: event.sessionId, path: file })).finally(() => this.pending.delete(pending))
    this.pending.add(pending)
  }

  async flush() { while (this.pending.size) await Promise.allSettled([...this.pending]) }
}

module.exports = { ResultStorage, verifiedCopy, copyTree, hashFile, inside, key }
