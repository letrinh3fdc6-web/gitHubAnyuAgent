const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const unzipper = require('unzipper')

const MAX_PACKAGE = 16 * 1024 * 1024
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i
function validPath(name) {
  return typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 240 && !/[\\:<>"|?*\x00-\x1f]/.test(name) &&
    name.split('/').every(part => part && part !== '..' && part !== '.' && !part.startsWith('.') && !/[. ]$/.test(part) && !reserved.test(part)) &&
    name.toLowerCase() !== 'anyu_training.md'
}
async function decodePackage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PACKAGE || !bytes.length) throw new Error('技能包大小无效')
  const archive = await unzipper.Open.buffer(bytes)
  if (archive.files.length > 1000) throw new Error('技能包文件过多')
  const entries = []; const seen = new Set(); let total = 0
  for (const file of archive.files) {
    const directory = file.type === 'Directory'
    const name = directory ? file.path.replace(/\/$/, '') : file.path
    const key = name.toLowerCase()
    const mode = file.externalFileAttributes >>> 16
    const type = mode & 0o170000
    if (!validPath(name) || seen.has(key) || (type && type !== 0o100000 && type !== 0o040000)) throw new Error('技能包包含不安全或重复路径')
    seen.add(key)
    if (directory) continue
    total += file.uncompressedSize
    if (file.uncompressedSize > 8 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('技能包解压大小超限')
    // Consume streams with a hard bound; never trust ZIP central-directory sizes.
    const chunks = []; let size = 0
    const stream = file.stream()
    for await (const chunk of stream) {
      size += chunk.length
      if (size > 8 * 1024 * 1024 || size > file.uncompressedSize) { stream.destroy(); throw new Error('技能包文件大小不匹配') }
      chunks.push(chunk)
    }
    if (size !== file.uncompressedSize) throw new Error('技能包文件不完整')
    entries.push({ name, bytes: Buffer.concat(chunks) })
  }
  if (!entries.some(entry => entry.name === 'SKILL.md' && entry.bytes.length && entry.bytes.length <= 1024 * 1024)) throw new Error('技能包缺少 SKILL.md')
  const files = new Set(entries.map(entry => entry.name.toLowerCase()))
  for (const entry of entries) {
    for (let parent = path.posix.dirname(entry.name); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (files.has(parent.toLowerCase())) throw new Error('技能包文件与目录冲突')
    }
  }
  return entries
}

function localRevision(directory) {
  if (!fs.existsSync(directory)) return ''
  const digest = createHash('sha256'); let count = 0; let size = 0
  function visit(current) {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('本机技能含有链接，请先手动整理技能目录')
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name))
    } else {
      size += stat.size; count++
      if (!stat.isFile() || size > 128 * 1024 * 1024 || count > 4000) throw new Error('本机技能目录过大或文件类型无效，请先手动备份')
      digest.update(path.relative(directory, current)); digest.update('\0'); digest.update(fs.readFileSync(current)); digest.update('\0')
    }
  }
  visit(directory); return digest.digest('hex')
}

async function renameDirectory(source, target, before) {
  for (let attempt = 0; ; attempt++) {
    before?.()
    try { fs.renameSync(source, target); return } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error
      await new Promise(resolve => setTimeout(resolve, 40 * 2 ** attempt))
    }
  }
}

// @project-doc docs/interfaces/anyuagent_skill_store.md#installation
async function installPackage(manager, skill, bytes, expectedRevision) {
  if (!idPattern.test(skill?.id) || !/^[a-f0-9]{64}$/.test(skill?.sha256) || hash(bytes) !== skill.sha256) throw new Error('技能包 SHA-256 校验失败')
  const entries = await decodePackage(bytes)
  const target = path.join(manager.root, skill.id)
  if (localRevision(target) !== expectedRevision) throw new Error('本机技能已变更，请重新安装以免覆盖正在训练的内容')
  const stage = path.join(manager.root, `.store-${randomUUID()}`)
  const backupRoot = path.join(path.dirname(manager.root), 'skill-backups')
  const backup = path.join(backupRoot, `${skill.id}-${Date.now()}-${randomUUID()}`)
  let moved = false; let installed = false
  try {
    fs.mkdirSync(stage, { recursive: true })
    for (const entry of entries) {
      const output = path.join(stage, ...entry.name.split('/'))
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, entry.bytes, { flag: 'wx' })
    }
    const rules = path.join(target, 'ANYU_TRAINING.md')
    if (fs.existsSync(rules)) fs.copyFileSync(rules, path.join(stage, 'ANYU_TRAINING.md'))
    fs.writeFileSync(path.join(stage, '.anyu-store.json'), JSON.stringify({ version: skill.version, sha256: skill.sha256, name: String(skill.name || '').trim().slice(0, 120) }))
    // A downloader must not overwrite changes made while the package was in flight.
    if (localRevision(target) !== expectedRevision) throw new Error('本机技能已变更，请刷新后重试')
    if (fs.existsSync(target)) {
      fs.mkdirSync(backupRoot, { recursive: true })
      await renameDirectory(target, backup, () => {
        if (localRevision(target) !== expectedRevision) throw new Error('本机技能已变更，请刷新后重试')
      })
      moved = true
    }
    await renameDirectory(stage, target, () => {
      if (fs.existsSync(target)) throw new Error('本机技能已变更，请刷新后重试')
    })
    installed = true
    return manager.read(skill.id)
  } catch (error) {
    try {
      if (installed) await renameDirectory(target, stage)
      if (moved && !fs.existsSync(target)) await renameDirectory(backup, target)
    } catch (rollback) {
      throw new Error(`技能安装失败，原版本备份保留在 ${backup}；请关闭占用后重试。${error.message}；恢复失败：${rollback.message}`, { cause: error })
    }
    throw error
  } finally {
    if (fs.existsSync(stage)) await fs.promises.rm(stage, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

async function readDownload(response) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); const error = new Error(`技能下载失败 (${response.status})`); error.status = response.status; throw error }
  if (Number(response.headers.get('content-length')) > MAX_PACKAGE) { await response.body?.cancel().catch(() => {}); throw new Error('技能包大小超限') }
  let size = 0; const chunks = []; let expired = false
  const reader = response.body.getReader()
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, 60000)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (expired) throw new Error('技能包下载超时，请重试')
      if (done) break
      size += value.length
      if (size > MAX_PACKAGE) throw new Error('技能包大小超限')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function packageDetail(skill, bytes) {
  if (!idPattern.test(skill?.id) || hash(bytes) !== skill.sha256) throw new Error('技能包 SHA-256 校验失败')
  const entries = await decodePackage(bytes)
  const content = new TextDecoder('utf-8', { fatal: true }).decode(entries.find(entry => entry.name === 'SKILL.md').bytes)
  const metadata = entries.find(entry => entry.name === 'anyu-skill.json')
  if (!metadata) return { ...skill, content }
  if (metadata.bytes.length > 32768) throw new Error('技能展示信息过大')
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata.bytes))
  const validText = (text, max) => typeof text === 'string' && text.trim() && !text.includes('\0') && Array.from(text).length <= max
  const validList = (items, maxCount, maxText) => items === null || items === undefined || Array.isArray(items) && items.length <= maxCount && items.every(item => validText(item, maxText))
  const knownKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(key => keys.includes(key))
  const optionalArray = items => items == null || Array.isArray(items)
  if (!knownKeys(value, ['schema_version', 'summary', 'inputs', 'deliverables', 'steps', 'starter', 'examples', 'sources', 'required_tools']) || value.schema_version !== 1 || !validText(value.summary, 800) || !validText(value.starter, 4000) ||
    !validList(value.inputs, 10, 240) || !validList(value.deliverables, 12, 240) || !validList(value.steps, 10, 240) ||
    !validList(value.required_tools, 10, 64) || !optionalArray(value.examples) || (value.examples || []).length > 8 ||
    !optionalArray(value.sources) || (value.sources || []).length > 12) throw new Error('技能展示信息格式无效')
  for (const tool of value.required_tools || []) if (!idPattern.test(tool.replaceAll('_', '-'))) throw new Error('技能工具标识无效')
  for (const example of value.examples || []) if (!knownKeys(example, ['title', 'prompt']) || !validText(example.title, 80) || !validText(example.prompt, 4000)) throw new Error('技能示例格式无效')
  for (const source of value.sources || []) {
    let url
    try { url = new URL(source?.url) } catch { throw new Error('技能来源地址无效') }
    if (!knownKeys(source, ['name', 'url', 'license']) || !validText(source.name, 160) || !validText(source.license, 80) || typeof source.url !== 'string' || source.url.length > 1000 || url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('技能来源格式无效')
  }
  return { ...skill, content, experience: { ...value, inputs: value.inputs || [], deliverables: value.deliverables || [], steps: value.steps || [], required_tools: value.required_tools || [], examples: value.examples || [], sources: value.sources || [] } }
}

module.exports = { decodePackage, installPackage, localRevision, readDownload, packageDetail, idPattern }
