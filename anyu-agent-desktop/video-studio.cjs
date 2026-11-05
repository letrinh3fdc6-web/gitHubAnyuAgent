const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const unzipper = require('unzipper')
const { downloadWithResume } = require('./dependency-download.cjs')

const SKILL = 'anyu-video-studio'
const PLATFORM = `${process.platform}-${process.arch}`
const safeName = name => typeof name === 'string' && name.length <= 240 && !/[\\:\x00-\x1f<>"|?*]/.test(name) && name.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))
async function commitStage(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { await fsp.rename(source, target); return }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 9) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}
function checkedManifest(value, apiBase, version) {
  if (value?.schema !== 1 || value.id !== SKILL || !/^\d+\.\d+\.\d+$/.test(value.version) || !/^\d+\.\d+\.\d+$/.test(value.minClientVersion)) throw new Error('剪辑运行包描述无效')
  const numbers = v => v.split('.').map(Number)
  const a = numbers(version), b = numbers(value.minClientVersion)
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) break; if (a[i] < b[i]) throw new Error(`此技能需要 AnyuAgent ${value.minClientVersion} 或更高版本`) }
  const component = value.platforms?.[PLATFORM]
  if (!component) throw new Error(`剪辑运行包暂不支持 ${PLATFORM}`)
  if (!/^[a-f0-9]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.size) || component.size < 1 || component.size > 1536 * 1024 ** 2 || !Number.isSafeInteger(component.unpackedSize) || component.unpackedSize < component.size || component.unpackedSize > 5 * 1024 ** 3) throw new Error('剪辑运行包大小或摘要无效')
  if (!/^\/downloads\/anyu-video-studio\/[a-zA-Z0-9/._-]+\.zip$/.test(component.path) || component.path.includes('..')) throw new Error('剪辑运行包下载路径无效')
  const base = new URL(apiBase)
  const url = new URL(component.path, base)
  if (url.origin !== base.origin || url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('剪辑运行包必须从当前可信服务下载')
  return { ...component, url: url.href, version: value.version }
}
async function extract(file, destination, limit) {
  const archive = await unzipper.Open.file(file)
  if (archive.files.length > 60000) throw new Error('剪辑运行包文件过多')
  const seen = new Set(); let bytes = 0
  for (const entry of archive.files) {
    const directory = entry.type === 'Directory', name = directory ? entry.path.replace(/\/$/, '') : entry.path
    const key = name.toLowerCase(), type = (entry.externalFileAttributes >>> 16) & 0o170000
    if (!safeName(name) || seen.has(key) || type && ![0o100000, 0o040000].includes(type)) throw new Error('剪辑运行包含不安全路径')
    seen.add(key)
    const target = path.join(destination, ...name.split('/'))
    if (directory) { await fsp.mkdir(target, { recursive: true }); continue }
    if (entry.uncompressedSize > 1024 ** 3 || bytes + entry.uncompressedSize > limit) throw new Error('剪辑运行包解压大小超限')
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const handle = await fsp.open(target, 'wx'); let size = 0
    try {
      for await (const chunk of entry.stream()) {
        bytes += chunk.length; size += chunk.length
        if (bytes > limit || size > entry.uncompressedSize) throw new Error('剪辑运行包大小不匹配')
        await handle.writeFile(chunk)
      }
      if (size !== entry.uncompressedSize) throw new Error('剪辑运行包不完整')
    } finally { await handle.close() }
    if (process.platform !== 'win32') await fsp.chmod(target, (entry.externalFileAttributes >>> 16) & 0o111 ? 0o755 : 0o644)
  }
}

// @project-doc docs/interfaces/anyuagent_video_studio.md#runtime
class VideoStudio {
  constructor(options) {
    this.options = options; this.root = path.join(options.userData, 'skill-runtimes', SKILL); this.pending = new Map(); this.clients = new Map(); this.installing = null
    this.state = { status: 'not-installed', message: '尚未下载剪辑运行环境' }
    this.indexFile = path.join(this.root, 'projects.json'); this.indexQueue = Promise.resolve()
    try { this.projects = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) } catch { this.projects = {} }
  }
  manifest() {
    const file = path.join(this.options.skills.root, SKILL, 'ANYU_RUNTIME.json')
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 32000) throw new Error('剪辑运行包描述无效')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  descriptor() { return checkedManifest(this.manifest(), this.options.apiBase(), this.options.version) }
  modelDescriptor() { const manifest = this.manifest(); if (!manifest.models?.whisperTiny) throw new Error('此技能版本尚未发布离线识别模型'); return checkedManifest({...manifest, platforms: {[PLATFORM]: manifest.models.whisperTiny}}, this.options.apiBase(), this.options.version) }
  modelDirectory() {
    if (this.options.devModelRoot) return this.options.devModelRoot
    const model = this.modelDescriptor(), directory = path.join(this.root, 'models', model.sha256)
    if (JSON.parse(fs.readFileSync(path.join(directory, '.ready.json'), 'utf8')).sha256 !== model.sha256) throw new Error('请先下载离线字幕识别模型')
    return directory
  }
  directory() {
    if (this.options.devRoot) return this.options.devRoot
    const descriptor = this.descriptor()
    const root = path.join(this.root, descriptor.sha256)
    const ready = JSON.parse(fs.readFileSync(path.join(root, '.ready.json'), 'utf8'))
    if (ready.sha256 !== descriptor.sha256) throw new Error('剪辑运行环境尚未就绪')
    return root
  }
  status() {
    if (this.installing) return this.state
    try { this.directory(); let transcriptionReady = false, transcriptionAvailable = false; try { this.modelDescriptor(); transcriptionAvailable = true } catch {}; try { this.modelDirectory(); transcriptionReady = true } catch {}; return { ...this.state, status: 'ready', message: '剪辑环境已就绪', transcriptionReady, transcriptionAvailable } }
    catch { return this.state.status === 'failed' ? this.state : { status: 'not-installed', message: '需要下载剪辑运行环境' } }
  }
  report(state) { this.state = { ...state, skillId: SKILL }; this.options.progress?.(this.status()) }
  async prepare() {
    if (this.installing) return this.installing
    this.installing = this.install().catch(error => { this.report({ status: 'failed', message: error.message }); throw error }).finally(() => { this.installing = null })
    return this.installing
  }
  async prepareModel() {
    if (this.modelInstalling) return this.modelInstalling
    this.modelInstalling = this.installModel().finally(() => { this.modelInstalling = null })
    return this.modelInstalling
  }
  async installModel() {
    if (this.status().status !== 'ready') throw new Error('请先准备剪辑运行环境')
    try { this.modelDirectory(); return this.status() } catch {}
    const model = this.modelDescriptor(), root = path.join(this.root, 'models'), target = path.join(root, model.sha256), stage = path.join(root, `.stage-${randomUUID()}`)
    await fsp.mkdir(root, { recursive: true })
    const space = await fsp.statfs(root)
    if (space.bavail * space.bsize < model.size + model.unpackedSize + 256 * 1024 ** 2) throw new Error('磁盘空间不足以安装识别模型')
    const download = path.join(root, `${model.sha256}.zip`)
    try {
      await downloadWithResume(model.url, download, model.sha256, progress => this.report({...progress, status: 'ready', component: 'whisper-tiny', componentStatus: 'downloading'}), '离线字幕', { maxBytes: model.size })
      if ((await fsp.stat(download)).size !== model.size) throw new Error('识别模型大小不匹配')
      await fsp.mkdir(stage); await extract(download, stage, model.unpackedSize)
      for (const name of await fsp.readdir(stage)) if (!['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt', 'README.md', 'LICENSE', 'source.json'].includes(name)) throw new Error('识别模型包含未声明文件')
      for (const name of ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt']) if (!(await fsp.stat(path.join(stage, name))).isFile()) throw new Error('识别模型缺少必要文件')
      await this.request({owner: 'internal', sessionId: 'internal', runId: 'model-health'}, {action: 'model-health', modelDirectory: stage})
      await fsp.writeFile(path.join(stage, '.ready.json'), JSON.stringify({sha256: model.sha256})); await commitStage(stage, target)
      this.report({status: 'ready', component: 'whisper-tiny', componentStatus: 'ready', message: '离线字幕模型已就绪'}); return this.status()
    } catch (error) { this.report({status: 'ready', component: 'whisper-tiny', componentStatus: 'failed', message: `离线字幕模型安装失败：${error.message}`}); throw error }
    finally { await fsp.rm(stage, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}) }
  }
  async install() {
    if (this.options.devRoot) { await this.request({ owner: 'internal', sessionId: 'internal', runId: 'health' }, { action: 'health' }); this.report({ status: 'ready', message: '内部剪辑环境检查通过' }); return this.status() }
    try { this.directory(); return this.status() } catch {}
    const descriptor = this.descriptor()
    const space = await fsp.statfs(this.options.userData)
    if (space.bavail * space.bsize < descriptor.size + descriptor.unpackedSize + 512 * 1024 ** 2) throw new Error('可用磁盘空间不足以安装剪辑环境')
    await fsp.mkdir(this.root, { recursive: true })
    const download = path.join(this.root, `${descriptor.sha256}.zip`)
    this.report({ status: 'downloading', message: '正在下载剪辑环境', totalBytes: descriptor.size, receivedBytes: 0 })
    await downloadWithResume(descriptor.url, download, descriptor.sha256, progress => this.report({ ...progress, status: 'downloading' }), SKILL, { maxBytes: descriptor.size, timeoutMs: 45000 })
    if ((await fsp.stat(download)).size !== descriptor.size) throw new Error('运行包体积与清单不匹配')
    const stage = path.join(this.root, `.stage-${randomUUID()}`), target = path.join(this.root, descriptor.sha256)
    try {
      this.report({ status: 'verifying', message: '正在展开并校验剪辑环境' })
      await fsp.mkdir(stage); await extract(download, stage, descriptor.unpackedSize)
      await fsp.access(path.join(stage, 'runtime/service.mjs')); await fsp.access(path.join(stage, 'editor/dist/index.html'))
      const health = await this.request({ owner: 'internal', sessionId: 'internal', runId: 'health' }, { action: 'health' }, stage)
      if (!health.ready) throw new Error('剪辑环境检查失败')
      await this.closeClient(stage)
      await fsp.writeFile(path.join(stage, '.ready.json'), JSON.stringify({ sha256: descriptor.sha256, version: descriptor.version }))
      await commitStage(stage, target)
      this.report({ status: 'ready', version: descriptor.version, message: '剪辑环境已就绪' }); return this.status()
    } finally { await this.closeClient(stage); await fsp.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  }
  async start(directory) {
    if (this.clients.has(directory)) return this.clients.get(directory)
    const scope = this.options.devRoot === directory ? 'internal-dev' : path.basename(directory)
    const child = spawn(process.execPath, [path.join(directory, 'runtime/service.mjs')], { cwd: directory, windowsHide: true, env: { ...process.env, ...this.options.environment?.(), ELECTRON_RUN_AS_NODE: '1', ANYU_VIDEO_DATA: path.join(this.options.userData, 'video-projects', scope) }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.clients.set(directory, child)
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', line => { try { const data = JSON.parse(line); const pending = this.pending.get(data.id); if (pending) { this.pending.delete(data.id); clearTimeout(pending.timer); data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result) } } catch {} })
    child.stderr.on('data', data => this.options.log?.(String(data).slice(-2000)))
    const failed = error => { if (this.clients.get(directory) === child) this.clients.delete(directory); for (const [id, pending] of this.pending) if (pending.child === child) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id) } }
    child.once('error', failed); child.once('exit', () => failed(new Error('剪辑服务已退出，请重新尝试')))
    child.stdin.on('error', () => {})
    return child
  }
  async request(context, input, directory = this.directory()) {
    const child = await this.start(directory)
    if (!child?.stdin.writable) throw new Error('剪辑服务尚未启动')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('剪辑操作超时，请查询已有工程或任务，勿重复创建')) }, ['create', 'import'].includes(input.action) ? 180000 : 60000)
      this.pending.set(id, { resolve, reject, timer, child })
      child.stdin.write(`${JSON.stringify({ id, context, input })}\n`, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) } })
    })
  }
  async dispatch(task, input) {
    if (!fs.existsSync(path.join(this.options.skills.root, SKILL, 'SKILL.md'))) throw new Error('请先从技能商店下载安装智能剪辑技能')
    if (['auto', 'narrate'].includes(input.action) && task.settings?.policy?.network === false) throw new Error('Online voice synthesis disabled by project policy')
    const context = { owner: task.owner, sessionId: task.sessionId, runId: task.id, model: task.model, groupId: task.modelSpec?.groupId || task.modelSpec?.group_id, network: task.settings?.policy?.network !== false }
    if (input.action === 'transcribe') input = {...input, request: {...input.request, modelDirectory: this.modelDirectory()}}
    if (input.action === 'editor') { try { input = {...input, modelDirectory: this.modelDirectory()} } catch {} }
    let directory
    if (input.projectId) {
      const scope = this.projects[input.projectId]
      if (!scope || !/^(internal-dev|[a-f0-9]{64})$/.test(scope)) throw new Error('剪辑工程版本索引不存在，请从原工程继续')
      directory = scope === 'internal-dev' && this.options.devRoot ? this.options.devRoot : path.join(this.root, scope)
      if (directory !== this.options.devRoot) await fsp.access(path.join(directory, '.ready.json'))
    } else { if (this.status().status !== 'ready') throw new Error('请先在技能商店完成剪辑运行环境下载'); directory = this.directory() }
    const result = await this.request(context, input, directory)
    if (['create', 'import'].includes(input.action)) {
      this.projects[result.id] = this.options.devRoot === directory ? 'internal-dev' : path.basename(directory)
      const save = this.indexQueue.catch(() => {}).then(async () => {
        await fsp.mkdir(this.root, { recursive: true }); const temporary = `${this.indexFile}.${randomUUID()}.tmp`
        try { await fsp.writeFile(temporary, JSON.stringify(this.projects)); await fsp.rename(temporary, this.indexFile) } finally { await fsp.rm(temporary, { force: true }) }
      }); this.indexQueue = save; await save
    }
    if (input.action === 'editor') {
      await this.options.openEditor(result.url, result.projectId, () => this.request(context, {action: 'editor-close', projectId: result.projectId}, directory).catch(error => this.options.log?.(error.message)))
      return { projectId: result.projectId, opened: true }
    }
    if (input.action === 'export') return { file: result.path }
    return result
  }
  async closeClient(directory) {
    const child = this.clients.get(directory); if (!child) return
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const timer = setTimeout(() => child.kill(), 5000)
      child.once('close', () => { clearTimeout(timer); resolve() }); child.stdin.end()
    })
    this.clients.delete(directory)
  }
  async close() { await this.indexQueue; await Promise.all([...this.clients.keys()].map(directory => this.closeClient(directory))) }
}
module.exports = { VideoStudio, checkedManifest, extract }
