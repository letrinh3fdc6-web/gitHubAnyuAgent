const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { spawn } = require('child_process')
const archiver = require('archiver')

const REGISTRY_VERSION = 1
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
const MAX_FILES = 2000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024
const RESERVED_SKILLS = new Set(['image', 'video'])

function now() { return new Date().toISOString() }
function asString(value, fallback = '') { return typeof value === 'string' ? value.trim() : fallback }
function isInside(parent, candidate) {
  const root = path.resolve(parent) + path.sep
  return path.resolve(candidate).startsWith(root)
}
function safeRelative(value) {
  const text = asString(value)
  if (!text || path.isAbsolute(text)) throw new Error('插件路径必须是相对路径')
  const normalized = path.normalize(text)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) throw new Error('插件包含不安全路径')
  return normalized
}
function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}
function copyDir(source, target) {
  fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false })
}
function listTree(root) {
  const result = []
  let totalBytes = 0
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (!isInside(root, fullPath)) throw new Error('插件路径越界')
      if (entry.isSymbolicLink()) throw new Error('插件不允许包含符号链接')
      if (entry.isDirectory()) visit(fullPath)
      else {
        const stats = fs.statSync(fullPath)
        if (stats.size > MAX_FILE_BYTES) throw new Error(`插件文件过大: ${entry.name}`)
        totalBytes += stats.size
        if (totalBytes > MAX_UNPACKED_BYTES) throw new Error('插件解压后总大小超过 256 MB 限制')
        result.push(fullPath)
        if (result.length > MAX_FILES) throw new Error('插件文件数量超过限制')
      }
    }
  }
  visit(root)
  return result
}
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('anyu-plugin.json 无效')
  const id = asString(raw.id)
  const version = asString(raw.version)
  const name = asString(raw.name || id)
  const displayName = asString(raw.displayName || raw.display_name || name)
  const description = asString(raw.description)
  if (!/^[a-z0-9][a-z0-9.-]{1,80}$/.test(id)) throw new Error('插件 id 只能包含小写字母、数字、点和连字符')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('插件 version 必须使用 SemVer')
  if (!name || !displayName || !description) throw new Error('插件必须包含 name、displayName 和 description')
  const rawSkills = Array.isArray(raw.skills) ? raw.skills : []
  if (!rawSkills.length) throw new Error('插件至少需要一个 Skill')
  const skills = rawSkills.map((item) => {
    const skill = typeof item === 'string' ? { name: path.basename(item), path: item } : item
    const skillPath = safeRelative(skill?.path || '')
    const skillName = asString(skill?.name || path.basename(skillPath))
    if (!/^[a-z0-9-]+$/.test(skillName) || RESERVED_SKILLS.has(skillName)) throw new Error(`Skill 名称不可用: ${skillName}`)
    return { name: skillName, path: skillPath, description: asString(skill?.description) }
  })
  const permissions = raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : {}
  return {
    schemaVersion: Number(raw.schemaVersion || 1), id, name, displayName, version, description,
    publisher: raw.publisher && typeof raw.publisher === 'object' ? raw.publisher : { id: 'local', name: '本地用户', verified: false },
    license: asString(raw.license, '未声明'), icon: asString(raw.icon), categories: Array.isArray(raw.categories) ? raw.categories.map(String).slice(0, 8) : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String).slice(0, 20) : [], skills, permissions,
    compatibility: raw.compatibility && typeof raw.compatibility === 'object' ? raw.compatibility : {},
    repository: asString(raw.repository), homepage: asString(raw.homepage), entry: { type: 'skills-only' }
  }
}
function readManifest(root) {
  const manifestPath = path.join(root, 'anyu-plugin.json')
  if (!isInside(root, manifestPath) || !fs.existsSync(manifestPath)) throw new Error('插件根目录缺少 anyu-plugin.json')
  let raw
  try { raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { throw new Error('anyu-plugin.json 不是有效 JSON') }
  return normalizeManifest(raw)
}
function readRawManifest(root) {
  const manifestPath = path.join(root, 'anyu-plugin.json')
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { throw new Error('anyu-plugin.json 不是有效 JSON') }
}
function validateSkillFiles(root, manifest) {
  for (const skill of manifest.skills || []) {
    const declaredPath = safeRelative(skill.path)
    const candidate = path.join(root, declaredPath)
    const skillFile = path.basename(declaredPath).toLowerCase() === 'skill.md'
      ? candidate
      : path.join(candidate, 'SKILL.md')
    if (!isInside(root, skillFile) || !fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) {
      throw new Error(`Skill 缺少 SKILL.md: ${skill.name}`)
    }
  }
}
function publisherName(value) {
  const name = asString(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name || name.length > 80) throw new Error('发布者名称必须为 1-80 个字符')
  return name
}
function archiveDirectory(source, destination) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    const archive = archiver('zip', { zlib: { level: 9 } })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      try { output.destroy() } catch {}
      try { fs.rmSync(destination, { force: true }) } catch {}
      reject(error)
    }
    output.once('error', fail)
    archive.once('error', fail)
    output.once('close', () => {
      if (settled) return
      settled = true
      const bytes = fs.statSync(destination).size
      if (!bytes || bytes > MAX_PACKAGE_BYTES) {
        try { fs.rmSync(destination, { force: true }) } catch {}
        reject(new Error('插件包超过 64 MB 限制'))
        return
      }
      resolve({ bytes, sha256: hashFile(destination) })
    })
    archive.pipe(output)
    archive.directory(source, false)
    archive.finalize().catch(fail)
  })
}
async function extractZip(zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true })
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:ANYU_PLUGIN_ZIP -DestinationPath $env:ANYU_PLUGIN_DEST -Force'], {
        windowsHide: true,
        env: { ...process.env, ANYU_PLUGIN_ZIP: zipPath, ANYU_PLUGIN_DEST: destination }
      })
      let stderr = ''
      child.stderr.on('data', (data) => { stderr += data.toString() })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `插件解压失败 (${code})`)))
    })
    return
  }
  let unzipper
  try { unzipper = require('unzipper') } catch { throw new Error('当前系统缺少 ZIP 解压组件') }
  const directory = await unzipper.Open.file(zipPath)
  for (const entry of directory.files) {
    const relative = safeRelative(entry.path)
    const target = path.join(destination, relative)
    if (!isInside(destination, target)) throw new Error('插件 ZIP 包含越界路径')
    if (entry.type === 'Directory') fs.mkdirSync(target, { recursive: true })
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); await new Promise((resolve, reject) => entry.stream().pipe(fs.createWriteStream(target)).on('finish', resolve).on('error', reject)) }
  }
}
function locateRoot(directory) {
  if (fs.existsSync(path.join(directory, 'anyu-plugin.json'))) return directory
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  if (entries.length === 1 && fs.existsSync(path.join(directory, entries[0].name, 'anyu-plugin.json'))) return path.join(directory, entries[0].name)
  throw new Error('未找到插件根目录 anyu-plugin.json')
}

class PluginManager {
  constructor(userDataPath) {
    this.root = path.join(userDataPath, 'plugins')
    this.registryPath = path.join(this.root, 'registry.json')
    this.downloadPath = path.join(this.root, 'downloads')
    this.packagePath = path.join(this.root, 'packages')
    this.quarantinePath = path.join(this.root, 'quarantine')
    fs.mkdirSync(this.root, { recursive: true }); fs.mkdirSync(this.downloadPath, { recursive: true }); fs.mkdirSync(this.packagePath, { recursive: true }); fs.mkdirSync(this.quarantinePath, { recursive: true })
    this.registry = this.readRegistry()
  }
  readRegistry() {
    try {
      const value = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'))
      if (value && value.version === REGISTRY_VERSION && value.plugins && typeof value.plugins === 'object') return value
    } catch {}
    return { version: REGISTRY_VERSION, updatedAt: now(), plugins: {} }
  }
  saveRegistry() { this.registry.updatedAt = now(); const tmp = `${this.registryPath}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.registry, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.registryPath) }
  listInstalled() {
    return Object.values(this.registry.plugins).map((item) => ({
      ...item,
      versions: (Array.isArray(item.versions) ? item.versions : []).map((version) => ({
        version: version.version,
        installedAt: version.installedAt,
        sha256: version.sha256
      }))
    })).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)))
  }
  async scanPackage(sourcePath) {
    const stats = fs.statSync(sourcePath)
    if (stats.isDirectory()) {
      const root = locateRoot(sourcePath); const files = listTree(root); const manifest = readManifest(root)
      validateSkillFiles(root, manifest)
      return { manifest, root, files: files.length, sha256: hashFile(path.join(root, 'anyu-plugin.json')), warnings: manifest.permissions && Object.keys(manifest.permissions).length ? ['此插件声明了额外权限，请安装前确认。'] : [] }
    }
    if (stats.size > MAX_PACKAGE_BYTES) throw new Error('插件包超过 64 MB 限制')
    const temp = fs.mkdtempSync(path.join(this.quarantinePath, 'scan-'))
    try { await extractZip(sourcePath, temp); const root = locateRoot(temp); const files = listTree(root); const manifest = readManifest(root); validateSkillFiles(root, manifest); return { manifest, root, files: files.length, sha256: hashFile(sourcePath), warnings: manifest.permissions && Object.keys(manifest.permissions).length ? ['此插件声明了额外权限，请安装前确认。'] : [] } } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  }
  async install(sourcePath, options = {}) {
    const source = path.resolve(String(sourcePath || ''))
    if (!fs.existsSync(source)) throw new Error('插件文件或目录不存在')
    const scan = await this.scanPackage(source)
    const manifest = scan.manifest
    const target = path.join(this.packagePath, manifest.id, manifest.version)
    if (!isInside(this.packagePath, target)) throw new Error('插件安装路径无效')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const staging = fs.mkdtempSync(path.join(this.quarantinePath, 'install-'))
    try {
      if (fs.statSync(source).isDirectory()) copyDir(scan.root, staging)
      else { await extractZip(source, staging); const root = locateRoot(staging); if (root !== staging) { const flattened = fs.mkdtempSync(path.join(this.quarantinePath, 'flatten-')); copyDir(root, flattened); fs.rmSync(staging, { recursive: true, force: true }); fs.renameSync(flattened, staging) } }
      listTree(staging); const installedManifest = readManifest(staging); validateSkillFiles(staging, installedManifest)
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
      fs.renameSync(staging, target)
    } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error }
    const old = this.registry.plugins[manifest.id]
    const versions = Array.isArray(old?.versions) ? old.versions.filter((item) => item.version !== manifest.version) : []
    versions.unshift({ version: manifest.version, path: target, installedAt: now(), sha256: scan.sha256 })
    const record = { id: manifest.id, name: manifest.name, displayName: manifest.displayName, description: manifest.description, version: manifest.version, publisher: manifest.publisher, categories: manifest.categories, keywords: manifest.keywords, permissions: manifest.permissions, license: manifest.license, skills: manifest.skills, installedPath: target, versions: versions.slice(0, 5), scope: options.scope === 'project' ? 'project' : 'user', projectPath: options.scope === 'project' ? path.resolve(String(options.projectPath || '')) : '', enabled: old ? old.enabled !== false : true, source: options.source || 'local', visibility: options.visibility || 'private', publishStatus: options.publishStatus || (old?.publishStatus || 'private'), marketplaceId: old?.marketplaceId || '', downloadUrl: old?.downloadUrl || '', installedAt: old?.installedAt || now(), updatedAt: now(), lastScan: { files: scan.files, sha256: scan.sha256, warnings: scan.warnings } }
    this.registry.plugins[manifest.id] = record; this.saveRegistry(); return { ...record, versions: undefined }
  }
  get(id) { return this.registry.plugins[String(id)] || null }
  async preparePublish(sourcePath, options = {}) {
    const source = path.resolve(String(sourcePath || ''))
    if (!fs.existsSync(source)) throw new Error('插件文件或目录不存在')
    const scan = await this.scanPackage(source)
    const staging = fs.mkdtempSync(path.join(this.quarantinePath, 'publish-'))
    let packagePath = ''
    try {
      if (fs.statSync(source).isDirectory()) copyDir(scan.root, staging)
      else { await extractZip(source, staging); const root = locateRoot(staging); if (root !== staging) { const flattened = fs.mkdtempSync(path.join(this.quarantinePath, 'publish-flat-')); copyDir(root, flattened); fs.rmSync(staging, { recursive: true, force: true }); fs.renameSync(flattened, staging) } }
      const raw = readRawManifest(staging)
      if (options.publisherName !== undefined) raw.publisher = { id: asString(options.publisherId, 'community'), name: publisherName(options.publisherName), verified: false }
      if (options.visibility) raw.visibility = options.visibility === 'public' ? 'public' : 'private'
      fs.writeFileSync(path.join(staging, 'anyu-plugin.json'), JSON.stringify(raw, null, 2), { mode: 0o600 })
      const files = listTree(staging)
      const manifest = readManifest(staging)
      packagePath = path.join(this.downloadPath, `${manifest.id}-${manifest.version}-${crypto.randomUUID()}.anyu-plugin.zip`)
      const archive = await archiveDirectory(staging, packagePath)
      return { manifest, files: files.length, filePath: packagePath, ...archive }
    } catch (error) {
      if (packagePath) fs.rmSync(packagePath, { force: true })
      throw error
    } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  }
  markPublished(id, publication = {}) {
    const record = this.registry.plugins[String(id)]
    if (!record) throw new Error('插件未安装')
    record.visibility = publication.visibility === 'private' ? 'private' : 'public'
    record.publishStatus = asString(publication.status, 'submitted') || 'submitted'
    if (publication.publisher && typeof publication.publisher === 'object') record.publisher = publication.publisher
    record.marketplaceId = asString(publication.marketplaceId || publication.id)
    record.downloadUrl = asString(publication.downloadUrl || publication.download_url)
    record.updatedAt = now()
    this.saveRegistry()
    return { ...record, versions: undefined }
  }
  setEnabled(id, enabled) { const record = this.registry.plugins[String(id)]; if (!record) throw new Error('插件未安装'); record.enabled = Boolean(enabled); record.updatedAt = now(); this.saveRegistry(); return { ...record, versions: undefined } }
  uninstall(id) { const key = String(id); const record = this.registry.plugins[key]; if (!record) throw new Error('插件未安装'); for (const version of record.versions || []) { if (version.path && isInside(this.packagePath, version.path)) fs.rmSync(version.path, { recursive: true, force: true }) } delete this.registry.plugins[key]; this.saveRegistry(); return { ok: true, id: key } }
  rollback(id, version) { const record = this.registry.plugins[String(id)]; const target = (record?.versions || []).find((item) => item.version === String(version)); if (!record || !target || !fs.existsSync(target.path)) throw new Error('没有可用的回滚版本'); record.installedPath = target.path; record.version = target.version; record.updatedAt = now(); this.saveRegistry(); return { ...record, versions: undefined } }
  runtimeSkillPaths(cwd) {
    const result = []
    for (const record of Object.values(this.registry.plugins)) {
      if (!record.enabled || !record.installedPath || !fs.existsSync(record.installedPath)) continue
      if (record.scope === 'project' && (!record.projectPath || path.resolve(record.projectPath) !== path.resolve(cwd || ''))) continue
      for (const skill of record.skills || []) {
        const declaredPath = safeRelative(skill.path)
        const candidate = path.join(record.installedPath, declaredPath)
        const skillDir = path.basename(declaredPath).toLowerCase() === 'skill.md' ? path.dirname(candidate) : candidate
        if (isInside(record.installedPath, skillDir) && fs.existsSync(path.join(skillDir, 'SKILL.md'))) result.push(skillDir)
      }
    }
    return result
  }
  state() { return { registryVersion: REGISTRY_VERSION, installed: this.listInstalled(), root: this.root } }
}

module.exports = { PluginManager, MAX_PACKAGE_BYTES, MAX_UNPACKED_BYTES }
