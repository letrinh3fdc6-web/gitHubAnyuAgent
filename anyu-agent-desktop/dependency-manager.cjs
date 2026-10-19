const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const unzipper = require('unzipper')
const { fetchText, downloadWithResume } = require('./dependency-download.cjs')

const COMMANDS = Object.freeze({
  ffmpeg: { executable: 'ffmpeg', wingetId: 'Gyan.FFmpeg.Shared', label: 'FFmpeg', offlineKey: 'ffmpeg' },
  ffprobe: { executable: 'ffprobe', wingetId: 'Gyan.FFmpeg.Shared', label: 'FFprobe', offlineKey: 'ffmpeg' },
  python: { executable: process.platform === 'win32' ? 'py' : 'python3', wingetId: 'Python.Python.3.11', label: 'Python', offlineKey: 'python' },
  git: { executable: 'bash', wingetId: 'Git.Git', label: 'Git Bash', offlineKey: 'git' },
  soffice: { executable: 'soffice', wingetId: 'TheDocumentFoundation.LibreOffice', label: 'LibreOffice' }
})
const PYTHON_PACKAGES = Object.freeze({ openpyxl: 'openpyxl', pandas: 'pandas', markitdown: 'markitdown', 'python-pptx': 'python-pptx', defusedxml: 'defusedxml', lxml: 'lxml' })
const PYTHON_MODULES = Object.freeze({ ...PYTHON_PACKAGES, 'python-pptx': 'pptx' })
const PYPI_INDEXES = Object.freeze(['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://mirrors.aliyun.com/pypi/simple', 'https://pypi.org/simple'])
const dependencyManifestBase = String(
  process.env.ANYU_DEPENDENCY_MANIFEST_URL ||
  process.env.ANYU_API_BASE ||
  process.env.ANYU_DEFAULT_API_BASE ||
  'http://127.0.0.1:8080'
).trim()
const DEPENDENCY_MANIFEST_URL = dependencyManifestBase.includes('/dependencies-manifest.json')
  ? dependencyManifestBase
  : `${dependencyManifestBase.replace(/\/+$/, '')}/downloads/dependencies/dependencies-manifest.json`
const DEPENDENCY_CACHE_DIR = path.resolve(process.env.ANYU_DEPENDENCY_CACHE_DIR || path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), 'AnyuAgent', 'dependency-cache'))
const registryFile = path.join(DEPENDENCY_CACHE_DIR, 'runtime.json')
let preparationQueue = Promise.resolve()
let queuedPreparations = 0
const offlineJobs = new Map()

function reportProgress(report, payload) { try { report?.({ ...payload, updatedAt: new Date().toISOString() }) } catch {} }
function runtimeState() { try { return JSON.parse(fs.readFileSync(registryFile, 'utf8')) } catch { return {} } }
function saveRuntime(state) {
  fs.mkdirSync(DEPENDENCY_CACHE_DIR, { recursive: true })
  const temporary = `${registryFile}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2))
  fs.renameSync(temporary, registryFile)
}
function inside(root, candidate) { const relative = path.relative(root, candidate); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) }
function dependencyEnvironment(base = process.env) {
  const state = runtimeState()
  const bins = (Array.isArray(state.bins) ? state.bins : []).filter((entry) => typeof entry === 'string' && inside(DEPENDENCY_CACHE_DIR, entry) && fs.existsSync(entry))
  const managedPython = state.python && inside(DEPENDENCY_CACHE_DIR, state.python) && fs.existsSync(state.python) ? state.python : ''
  const python = managedPython || base.PYTHON || ['Python312', 'Python311'].map((name) => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', name, 'python.exe')).find((candidate) => fs.existsSync(candidate)) || ''
  if (python) bins.unshift(path.dirname(python), path.join(path.dirname(python), 'Scripts'))
  const originalPath = String(base.PATH || base.Path || '')
  const value = [...new Set([...bins, ...originalPath.split(path.delimiter)])].filter(Boolean).join(path.delimiter)
  const env = { ...base, PATH: value }
  // Windows 环境变量不区分大小写，不能同时传入不同的 Path/PATH。
  delete env.Path
  if (python) env.PYTHON = python
  return env
}

function run(command, args, timeoutMs = 180000, report, dependency = '', phase = 'dependency-installing', heartbeatMs = 5000, percent = 10, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, env: options.env || dependencyEnvironment() })
    const startedAt = Date.now()
    let stdout = ''; let stderr = ''; let settled = false
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(heartbeat); resolve(result) }
    const heartbeat = setInterval(() => reportProgress(report, { phase, dependency, percent, indeterminate: true, message: `${dependency} 安装器仍在运行，已等待 ${Math.max(1, Math.floor((Date.now() - startedAt) / 1000))} 秒` }), heartbeatMs)
    heartbeat.unref?.()
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', () => { try { child.kill() } catch {} })
      } else { try { child.kill('SIGKILL') } catch {} }
      finish({ code: 124, stdout, stderr: '安装超时，可稍后重试' })
    }, timeoutMs)
    const onOutput = (stream) => (chunk) => {
      const value = chunk.toString()
      if (stream === 'stdout') stdout = `${stdout}${value}`.slice(-8192)
      else stderr = `${stderr}${value}`.slice(-8192)
      const message = value.replace(/\u001b\[[0-9;]*m/g, '').trim().replace(/\s+/g, ' ').slice(-240)
      if (message) reportProgress(report, { phase, dependency, percent, indeterminate: true, message: `${dependency}：${message}` })
    }
    child.stdout?.on('data', onOutput('stdout')); child.stderr?.on('data', onOutput('stderr'))
    child.once('error', (error) => finish({ code: 1, stdout, stderr: error.message }))
    child.once('close', (code) => finish({ code: code ?? 1, stdout, stderr }))
  })
}
async function resolvePython() {
  const env = dependencyEnvironment()
  const candidates = [env.PYTHON, process.platform === 'win32' ? 'py' : 'python3', 'python', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe')].filter(Boolean)
  for (const command of [...new Set(candidates)]) {
    const result = await run(command, ['-c', 'import sys; print(sys.executable); assert sys.version_info >= (3, 10)'], 12000)
    if (result.code === 0) return result.stdout.trim().split(/\r?\n/).at(-1)
  }
  return ''
}
function bashCandidates() {
  return [process.env.PI_BASH_PATH, process.env.GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'), path.join(DEPENDENCY_CACHE_DIR, 'tools', 'git', 'bin', 'bash.exe')].filter(Boolean)
}
async function commandReady(name) {
  if (name === 'python') return Boolean(await resolvePython())
  const spec = COMMANDS[name]
  if (!spec) return false
  const candidates = name === 'git' ? bashCandidates() : [spec.executable]
  for (const command of candidates) if ((await run(command, [name.startsWith('ff') ? '-version' : '--version'], 15000)).code === 0) return true
  return false
}
async function pythonModuleExists(name, report, percent = 5, python = '') {
  if (!PYTHON_MODULES[name]) return false
  const executable = python || await resolvePython()
  if (!executable) return false
  const result = await run(executable, ['-c', `import importlib; importlib.import_module(${JSON.stringify(PYTHON_MODULES[name])})`], 15000, report, name, 'dependency-checking', 5000, percent)
  return result.code === 0
}
function normalizeDependencies(raw) {
  const dependencies = raw && typeof raw === 'object' ? raw : {}
  const list = (name) => [...new Set((Array.isArray(dependencies[name]) ? dependencies[name] : []).map((value) => String(value).trim()).filter(Boolean))]
  return { commands: list('commands'), python: list('python'), optionalCommands: list('optionalCommands') }
}
async function inspect(dependencies, report, percent = 5) {
  const normalized = normalizeDependencies(dependencies)
  const missingCommands = []; const missingPython = []; const missingOptionalCommands = []
  for (const name of normalized.commands) if (!await commandReady(name)) missingCommands.push(name)
  const python = normalized.python.length ? await resolvePython() : ''
  for (const name of normalized.python) if (!await pythonModuleExists(name, report, percent, python)) missingPython.push(name)
  for (const name of normalized.optionalCommands) if (!await commandReady(name)) missingOptionalCommands.push(name)
  return { ...normalized, missingCommands, missingPython, missingOptionalCommands, ready: !missingCommands.length && !missingPython.length }
}

async function dependencyManifest() {
  const cached = path.join(DEPENDENCY_CACHE_DIR, 'manifest.json')
  try {
    const raw = await fetchText(DEPENDENCY_MANIFEST_URL, 10000)
    const manifest = JSON.parse(raw)
    if (manifest.schemaVersion !== 1 || !manifest.packages) throw new Error('依赖清单格式错误')
    await fs.promises.mkdir(DEPENDENCY_CACHE_DIR, { recursive: true })
    await fs.promises.writeFile(cached, raw)
    return manifest
  } catch {
    try { return JSON.parse(await fs.promises.readFile(cached, 'utf8')) } catch { return null }
  }
}
async function rankPypiIndexes(report, indexes = PYPI_INDEXES) {
  const results = []
  for (const url of indexes) {
    const started = Date.now()
    try { await fetchText(`${url}/defusedxml/`, 5000); results.push({ url, latency: Date.now() - started }) } catch { results.push({ url, latency: Infinity }) }
  }
  results.sort((a, b) => a.latency - b.latency)
  reportProgress(report, { phase: 'dependency-source', percent: 4, message: `依赖源检测完成：${results[0]?.url || ''}` })
  return results.map((entry) => entry.url)
}
async function fastestPypiIndex(report) { return (await rankPypiIndexes(report))[0] }

async function installFfmpegArchive(file, report) {
  const root = path.join(DEPENDENCY_CACHE_DIR, 'tools')
  await fs.promises.mkdir(root, { recursive: true })
  const staging = await fs.promises.mkdtemp(path.join(root, 'ffmpeg-'))
  try {
    const archive = await unzipper.Open.file(file)
    let bytes = 0
    if (archive.files.length > 5000) throw new Error('压缩包文件过多')
    for (const entry of archive.files) {
      const target = path.resolve(staging, entry.path)
      if (!inside(staging, target) || entry.path.includes(':') || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('压缩包包含不安全路径')
      bytes += entry.uncompressedSize
      if (bytes > 1024 * 1024 * 1024) throw new Error('压缩包解压后过大')
      if (entry.type === 'Directory') await fs.promises.mkdir(target, { recursive: true })
      else { await fs.promises.mkdir(path.dirname(target), { recursive: true }); await pipeline(entry.stream(), fs.createWriteStream(target)) }
    }
    const bins = []
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const entry = archive.files.find((item) => path.basename(item.path).toLowerCase() === name)
      if (!entry) throw new Error(`离线包缺少 ${name}`)
      const executable = path.resolve(staging, entry.path)
      if ((await run(executable, ['-version'], 15000, report, name, 'dependency-checking')).code !== 0) throw new Error(`${name} 无法执行`)
      bins.push(path.dirname(executable))
    }
    // 先验证独立版本目录，最后原子提交指针；旧环境从不原地覆盖。
    saveRuntime({ ...runtimeState(), bins: [...new Set(bins)] })
    return { ok: true, message: 'FFmpeg 和 FFprobe 已验证，重启后可继续使用' }
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true })
    throw error
  }
}
async function installOfflineArtifact(key, report = () => {}) {
  if (!['ffmpeg', 'python', 'git'].includes(key)) return { ok: false, message: '不支持的系统依赖' }
  if (offlineJobs.has(key)) return offlineJobs.get(key)
  const job = (async () => {
    try {
      if (process.platform !== 'win32') throw new Error('离线系统包暂只支持 Windows')
      const manifest = await dependencyManifest()
      const spec = manifest?.packages?.[key]
      if (!spec?.url || !/^[a-f0-9]{64}$/i.test(spec.sha256 || '') || !/^[a-zA-Z0-9._-]+$/.test(spec.file || '')) throw new Error('没有可用的已校验离线包')
      const file = path.join(DEPENDENCY_CACHE_DIR, spec.file)
      const sources = [new URL(spec.url, DEPENDENCY_MANIFEST_URL).toString(), ...(Array.isArray(spec.mirrors) ? spec.mirrors : [])]
      const errors = []
      let downloaded = false
      for (const source of sources) {
        try { await downloadWithResume(source, file, spec.sha256, report, spec.label || key); downloaded = true; break }
        catch (error) { errors.push(`${source}: ${error.message}`); reportProgress(report, { phase: 'dependency-fallback', dependency: key, message: `${spec.label || key} 切换下载源：${error.message}` }) }
      }
      if (!downloaded) throw new Error(errors.join('\n'))
      if (key === 'ffmpeg') return await installFfmpegArchive(file, report)
      // 安装参数由客户端控制，不能执行远端清单中的任意参数。
      // Git 显式安装到依赖目录，避免安装器在当前用户环境下进入维护模式却没有落地文件。
      const gitTarget = path.join(DEPENDENCY_CACHE_DIR, 'tools', 'git')
      if (key === 'git') fs.mkdirSync(gitTarget, { recursive: true })
      const args = key === 'git' ? ['/VERYSILENT', '/NORESTART', `/DIR=${gitTarget}`] : ['/quiet', '/norestart', 'InstallAllUsers=0', 'PrependPath=0', 'Include_launcher=1', 'InstallLauncherAllUsers=0']
      const result = await run(file, args, 600000, report, spec.label || key)
      const ok = await commandReady(key)
      if (key === 'git' && ok) {
        const state = runtimeState()
        const bins = Array.isArray(state.bins) ? state.bins : []
        saveRuntime({ ...state, bins: [...new Set([...bins, path.join(gitTarget, 'bin'), path.join(gitTarget, 'usr', 'bin')])] })
      }
      return { ok, message: ok ? '安装并执行检查通过' : (result.stderr || `安装后未找到可执行环境，退出码 ${result.code}`) }
    } catch (error) { return { ok: false, message: error.message || String(error) } }
  })()
  offlineJobs.set(key, job)
  try { return await job } finally { offlineJobs.delete(key) }
}
async function installCommand(name, report, percent) {
  if (await commandReady(name)) return { ok: true }
  const spec = COMMANDS[name]
  if (!spec || process.platform !== 'win32') return { ok: false, message: `${name} 需要手动安装` }
  const offline = spec.offlineKey ? await installOfflineArtifact(spec.offlineKey, report) : null
  if (offline?.ok) return offline
  reportProgress(report, { phase: 'dependency-fallback', percent, dependency: name, message: `${spec.label} 离线包不可用，切换 winget：${offline?.message || ''}` })
  const result = await run('winget.exe', ['install', '--id', spec.wingetId, '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'], 300000, report, spec.label)
  return { ok: await commandReady(name), message: [offline?.message, result.stderr || result.stdout].filter(Boolean).join('；').slice(-1200) }
}
async function installPythonPackages(names, report, options = {}) {
  const python = options.python || await resolvePython()
  if (!python) return { ok: false, message: '未找到可执行的 Python 3.10+' }
  const previous = runtimeState()
  const packages = [...new Set([...(previous.pythonPackages || []), ...names])]
  if (packages.some((name) => !PYTHON_PACKAGES[name])) return { ok: false, message: '包含未支持的 Python 包' }
  const root = path.join(DEPENDENCY_CACHE_DIR, 'tools')
  await fs.promises.mkdir(root, { recursive: true })
  const staging = await fs.promises.mkdtemp(path.join(root, 'python-env-'))
  const executable = path.join(staging, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const errors = []
  try {
    const created = await run(python, ['-m', 'venv', staging], 120000, report, 'Python 独立环境')
    if (created.code !== 0) throw new Error(created.stderr || '创建独立 Python 环境失败')
    const indexes = options.indexes || await rankPypiIndexes(report)
    for (const index of indexes) {
      reportProgress(report, { phase: 'dependency-installing', percent: 20, dependency: 'python', indeterminate: true, message: `正在安装 Python 包，下载源：${index}` })
      const result = await run(executable, ['-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--retries', '1', '--timeout', '15', '--only-binary=:all:', '-i', index, ...packages.map((name) => PYTHON_PACKAGES[name])], options.timeoutMs || 300000, report, 'Python 包')
      let ready = result.code === 0
      if (ready) for (const name of packages) if (!await pythonModuleExists(name, report, 94, executable)) ready = false
      if (ready) {
        saveRuntime({ ...runtimeState(), python: executable, pythonPackages: packages })
        return { ok: true, message: 'Python 包已安装并通过导入测试', python: executable, index }
      }
      errors.push(`${index}: ${(result.stderr || result.stdout || '导入失败').slice(-500)}`)
    }
    throw new Error(errors.join('\n'))
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, message: error.message || String(error) }
  }
}
function dependencyRuntimeInfo() { return { pypiIndexes: [...PYPI_INDEXES], manifestUrl: DEPENDENCY_MANIFEST_URL, cacheDir: DEPENDENCY_CACHE_DIR } }
async function prepare(dependencies, report) {
  if (queuedPreparations++ > 0) reportProgress(report, { phase: 'dependency-queued', percent: 2, indeterminate: true, message: '前一个环境安装任务完成后将继续' })
  const current = preparationQueue.then(() => prepareSerial(dependencies, report))
  preparationQueue = current.catch(() => {})
  try { return await current } finally { queuedPreparations-- }
}
async function prepareSerial(dependencies, report) {
  reportProgress(report, { phase: 'dependency-checking', percent: 3, message: '正在检查插件运行环境' })
  let state = await inspect(dependencies, report)
  const failures = []
  for (const name of state.missingCommands) {
    const result = await installCommand(name, report, 10)
    if (!result.ok) failures.push({ dependency: name, message: result.message })
  }
  if (state.missingPython.length) {
    const result = await installPythonPackages(state.python, report)
    if (!result.ok) failures.push({ dependency: state.missingPython.join(', '), message: result.message })
  }
  state = await inspect(dependencies, report, 94)
  const status = state.ready ? 'ready' : 'manual'
  reportProgress(report, { phase: state.ready ? 'dependency-ready' : 'dependency-manual', percent: 100, message: state.ready ? '运行环境已就绪' : `仍缺少：${[...state.missingCommands, ...state.missingPython].join(', ')}`, failures, optionalMissing: state.missingOptionalCommands })
  return { status, ...state, failures }
}
module.exports = { COMMANDS, PYTHON_PACKAGES, PYTHON_MODULES, PYPI_INDEXES, normalizeDependencies, inspect, prepare, run, fastestPypiIndex, dependencyRuntimeInfo, dependencyManifest, downloadWithResume, installOfflineArtifact, dependencyEnvironment, resolvePython, installPythonPackages, installFfmpegArchive, pythonModuleExists }
