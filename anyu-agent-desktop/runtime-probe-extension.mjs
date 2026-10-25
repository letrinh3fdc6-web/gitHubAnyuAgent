import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const COMMANDS = Object.freeze({
  node: { label: 'Node.js', names: ['node'], required: false },
  python: { label: 'Python', names: ['python3', 'python', 'py'], required: false },
  gitbash: { label: 'Bash', names: ['bash'], required: false },
  ffmpeg: { label: 'FFmpeg', names: ['ffmpeg'], required: false },
  ffprobe: { label: 'FFprobe', names: ['ffprobe'], required: false },
  msedge: { label: 'Microsoft Edge', names: ['msedge'], required: false },
  chrome: { label: 'Google Chrome', names: ['chrome', 'google-chrome', 'chromium'], required: false },
})

function envValue(env, name) {
  const key = process.platform === 'win32' ? Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) : name
  return String(env[key] || '')
}

function installedCandidates(id, env) {
  if (id === 'python') return [envValue(env, 'PYTHON')].filter(Boolean)
  const overrides = id === 'gitbash' ? [envValue(env, 'PI_BASH_PATH'), envValue(env, 'GIT_BASH_PATH')].filter(Boolean) : []
  if (process.platform === 'darwin') {
    const browsers = { msedge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome' }
    return browsers[id] ? [path.join('/Applications', browsers[id]), path.join(os.homedir(), 'Applications', browsers[id])] : overrides
  }
  if (process.platform !== 'win32') return overrides
  const roots = ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)'].map((name) => envValue(env, name)).filter(Boolean)
  const local = envValue(env, 'LOCALAPPDATA')
  const relative = { msedge: 'Microsoft/Edge/Application/msedge.exe', chrome: 'Google/Chrome/Application/chrome.exe', gitbash: 'Git/bin/bash.exe' }[id]
  if (!relative) return overrides
  return [...overrides, ...roots.map((root) => path.join(root, relative)), ...(local ? [path.join(local, id === 'gitbash' ? 'Programs' : '', relative)] : [])]
}

function executableCandidates(name, env = process.env, candidates = []) {
  const raw = String(name || '').trim()
  if (!raw) return []
  if (path.isAbsolute(raw)) return [raw]
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : ['']
  const result = []
  for (const entry of envValue(env, 'PATH').split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!directory || !path.isAbsolute(directory)) continue
    for (const suffix of suffixes) result.push(path.join(directory, raw + suffix))
  }
  return [...new Set([...candidates, ...result])]
}

function inspectExecutable(names, env = process.env, candidates = [], id = '') {
  let denied = null
  for (const name of names) {
    for (const candidate of executableCandidates(name, env, candidates)) {
      if (!path.isAbsolute(candidate)) continue
      // Windows Store aliases and WSL launchers are not installed Python/Git Bash.
      if (process.platform === 'win32' && ((id === 'python' && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(candidate)) || (id === 'gitbash' && /[\\/]Windows[\\/](System32|SysWOW64)[\\/]bash\.exe$/i.test(candidate)))) continue
      try {
        if (!fs.statSync(candidate).isFile()) continue
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK)
        return { available: true, status: 'located-unverified', path: path.resolve(candidate), errorCode: null }
      } catch (error) {
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          denied ||= { available: false, status: 'access-denied', path: path.resolve(candidate), errorCode: error.code }
        }
      }
    }
  }
  return denied || { available: false, status: 'missing', path: null, errorCode: null }
}

function probeDirectory(directory) {
  const result = { path: directory, exists: false, directory: false, readable: false, writable: null, writeCheck: 'not-tested', errorCode: null }
  try {
    const stat = fs.statSync(directory)
    result.exists = true
    result.directory = stat.isDirectory()
    if (result.directory) {
      fs.opendirSync(directory).closeSync()
      result.readable = true
      // Node's W_OK check does not validate Windows directory ACLs. Do not claim
      // write permission without an actual write; this tool remains read-only.
      if (process.platform !== 'win32') {
        result.writeCheck = 'access-only'
        try { fs.accessSync(directory, fs.constants.W_OK); result.writable = true } catch { result.writable = false }
      }
    } else result.errorCode = 'ENOTDIR'
  } catch (error) { result.errorCode = error.code || 'UNKNOWN' }
  return result
}

function probeEnvironment(cwd, env = process.env) {
  const executables = {}
  for (const [id, definition] of Object.entries(COMMANDS)) {
    executables[id] = {
      label: definition.label,
      required: definition.required,
      ...inspectExecutable(definition.names, env, installedCandidates(id, env), id),
    }
  }
  const workspace = probeDirectory(cwd)
  return {
    ok: workspace.readable,
    platform: process.platform,
    arch: process.arch,
    os: os.platform() === 'win32' ? `${os.platform()} ${os.release()}` : os.platform(),
    cwd,
    workspace,
    executables,
    builtinBrowserConfigured: Boolean(env.LETA_BROWSER_BRIDGE_PORT && env.LETA_BROWSER_BRIDGE_TOKEN),
    optionalMissing: Object.entries(executables).filter(([, item]) => !item.required && item.status === 'missing').map(([id]) => id),
    notes: [
      'Edge 和 Chrome 是可选外部浏览器；AnyuAgent 的内置浏览器不依赖它们。',
      '独立 Pi 运行时不要求系统安装 Node；其他依赖是否必需取决于当前任务。',
      'available 仅表示找到程序，未启动验证；实际任务需要时再检查版本和执行结果。',
      'ok 仅表示工作区可读取，不代表管理员身份或写入一定成功。Windows 写入 ACL 未测试；应以实际操作的错误码为准。',
    ],
  }
}

export default function runtimeProbeExtension(pi) {
  pi.registerTool({
    name: 'runtime_probe',
    label: '检查本机运行环境',
    description: '只读检查工作区和本机依赖位置。逐项查找 Node、Python、Bash、FFmpeg、Edge、Chrome，不执行程序。外部浏览器和 Node 不是 AnyuAgent 的启动前提；依赖是否必需由当前任务决定。程序存在不代表已验证能运行。',
    promptSnippet: 'Inspect local runtime and workspace readiness before diagnosing a command or dependency failure',
    promptGuidelines: [
      'Use runtime_probe for environment discovery instead of an all-or-nothing Get-Command node, python, msedge, chrome check.',
      'Missing optional software is not a permission error. Prefer browser_open for the built-in browser; verify a located executable only when the task needs it.',
      'Distinguish ENOENT/CommandNotFound, EACCES/EPERM/AccessDenied, and an application nonzero exit code. Never conceal an actual failure or infer administrator access from this report.',
    ],
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute(_id, _params, _signal, _update, ctx) {
      const cwd = path.resolve(String(ctx?.cwd || process.cwd()))
      const result = probeEnvironment(cwd)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })
}

export { probeEnvironment }
