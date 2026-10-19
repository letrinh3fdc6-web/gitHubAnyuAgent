const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { installOfflineArtifact } = require('../dependency-manager.cjs')

const DEPENDENCY_CACHE_ROOT = process.env.ANYU_DEPENDENCY_CACHE_DIR || path.join(process.env.LOCALAPPDATA || process.env.HOME || process.cwd(), 'AnyuAgent', 'dependency-cache')
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  // 无管理员权限时把 Git 安装到 LetaAgent 自己的依赖目录。
  path.join(DEPENDENCY_CACHE_ROOT, 'tools', 'git', 'bin', 'bash.exe')
]

function existingBash() {
  return GIT_BASH_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || ''
}

function shellEnvironment(base = process.env, bashPath = existingBash()) {
  if (!bashPath) return { ...base }
  const gitRoot = path.dirname(path.dirname(bashPath))
  const unixBin = path.join(gitRoot, 'usr', 'bin')
  const pathValue = String(base.PATH || base.Path || '')
  const additions = [gitRoot, unixBin].filter((entry) => !pathValue.toLowerCase().split(path.delimiter).includes(entry.toLowerCase()))
  return {
    ...base,
    PATH: [...additions, pathValue].filter(Boolean).join(path.delimiter),
    PI_BASH_PATH: bashPath,
    GIT_BASH_PATH: bashPath
  }
}

function gitInstallerArgs() {
  return ['install', '--id', 'Git.Git', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']
}

function runWinget(timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn('winget.exe', gitInstallerArgs(), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch {}; resolve({ ok: false, code: 124, error: 'Git Bash 安装超时' }) }, timeoutMs)
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000) })
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, code: 1, error: error.message }) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code: code ?? 1, error: stderr.trim() }) })
  })
}

async function ensureWindowsShell(report = () => {}) {
  if (process.platform !== 'win32') return { status: 'unsupported', shellPath: '' }
  const before = existingBash()
  if (before) {
    report({ phase: 'shell-ready', percent: 100, message: 'Git Bash 已就绪' })
    return { status: 'ready', shellPath: before, installed: false }
  }
  report({ phase: 'shell-installing', percent: 15, indeterminate: true, message: '正在准备 Git Bash 运行环境' })
  const offline = await installOfflineArtifact('git', report)
  const offlineBash = existingBash()
  if (offline.ok && offlineBash) {
    report({ phase: 'shell-ready', percent: 100, message: 'Git Bash 已通过离线包安装并就绪' })
    return { status: 'ready', shellPath: offlineBash, installed: true, source: 'offline' }
  }
  const outcome = await runWinget()
  const after = existingBash()
  if (after) {
    report({ phase: 'shell-ready', percent: 100, message: 'Git Bash 已安装并就绪' })
    return { status: 'ready', shellPath: after, installed: true }
  }
  report({ phase: 'shell-manual', percent: 100, message: 'Git Bash 未能自动安装，可在设置中手动安装 Git for Windows', error: outcome.error || `安装退出码 ${outcome.code}` })
  return { status: 'manual', shellPath: '', installed: false, error: outcome.error || `安装退出码 ${outcome.code}` }
}

module.exports = { GIT_BASH_CANDIDATES, existingBash, shellEnvironment, ensureWindowsShell }
