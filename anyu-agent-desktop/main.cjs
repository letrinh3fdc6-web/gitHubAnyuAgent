const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage, shell, session, dialog, Menu, Tray, protocol, screen } = require('electron')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const dns = require('node:dns')
const net = require('node:net')
const http = require('node:http')
const { Agent: UndiciAgent } = require('undici')
const QRCode = require('qrcode')
const { normalizeBrowserBounds } = require('./browser-layout.cjs')
const { RENDERER_ORIGIN, RENDERER_SCHEME, createRendererHandler } = require('./renderer-protocol.cjs')
const { allowedBrowserUrl, workspaceFile } = require('./browser-policy.cjs')
const { LocalFeedback, feedbackUrl } = require('./local-feedback.cjs')
const { detailThumbnail } = require('./detail-thumbnails.cjs')
// 旧版/损坏安装包可能漏带可选详情图模块；不能因此让整个主进程启动崩溃。
let LocalDetail
try {
  ({ LocalDetail } = require('./local-detail.cjs'))
} catch (error) {
  console.error('[startup] local-detail.cjs unavailable:', error?.message || error)
  LocalDetail = class MissingLocalDetail {
    constructor() {}
    start() { throw new Error('当前安装包缺少商品详情图模块，请重新安装最新版 AnyuAgent') }
    get() { throw new Error('当前安装包缺少商品详情图模块，请重新安装最新版 AnyuAgent') }
  }
}
const { runCommerceAction } = require('./commerce-browser.cjs')
const { analyzeWithPi } = require('./skill-analysis.cjs')
protocol?.registerSchemesAsPrivileged?.([
  { scheme: 'leta-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: RENDERER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])
const { DEFAULT_MANIFEST_URL, compareVersions, artifactFromManifest } = require('./updater.cjs')
const { PluginManager, MAX_PACKAGE_BYTES } = require('./plugin-manager.cjs')
const { SkillManager } = require('./skill-manager.cjs')
const { prepare: prepareDependencies, dependencyEnvironment, resolvePython } = require('./dependency-manager.cjs')
const { existingBash, shellEnvironment, ensureWindowsShell } = require('./tools/windows-shell-bootstrap.cjs')
const { LocalGatewayBridge, managedProviderName, managedBaseUrl } = require('./gateway-bridge.cjs')
const { AgentSessionService } = require('./agent-session.cjs')
const {
  ELEVATION_ENV_FLAG,
  writeIntent: writeElevationIntent,
  readIntent: readElevationIntent,
  clearIntent: clearElevationIntent,
  isElevatedLaunch
} = require('./elevation-intent.cjs')
// 思考强度模板库：主进程与渲染层共用同一份判断，避免两边正则漂移。
const { resolveThinking } = require('./thinking-presets.js')

// GPU 缓存在部分机器上会反复"拒绝访问 (0x5)"导致 GPU 进程崩溃 → 窗口关闭 → app 退出。
// opt-in 方式（不影响默认安装与线上包）：
//   1) 环境变量 ANYU_DISABLE_GPU=1（启动器显式设置）
//   2) 用户主目录存在 .leta-disable-gpu 标记文件（对该机器全局生效，双击快捷方式也走此路径）
const gpuFlagPath = path.join(os.homedir(), '.leta-disable-gpu')
if (String(process.env.ANYU_DISABLE_GPU || '') === '1' || fs.existsSync(gpuFlagPath)) {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
}

// 发布包默认连接正式服务；本机联调仍通过下方显式本机开关启用。
const OFFICIAL_API_ORIGIN = String(process.env.ANYU_DEFAULT_API_BASE || 'https://x.ailzd.com').trim()
// Session binding on the backend hashes trusted client IP + User-Agent. Every
// main-process request must therefore use one stable UA, including the local
// gateway bridge that forwards pi traffic.
const APP_USER_AGENT = `AnyuAgent-Desktop/${require('./package.json').version} (${process.platform}; ${process.arch})`
// 用户配置的 API Base 是服务根地址；管理接口统一走 /api/v1，OpenAI/Anthropic 网关统一走 /v1。
const DEFAULT_API_BASE = OFFICIAL_API_ORIGIN
const REQUEST_TIMEOUT_MS = 20000
// 远程部署可通过 ANYU_DNS_FALLBACK 提供逗号分隔的 DNS 兜底地址；本地默认不做公网回落。
const OFFICIAL_DNS_FALLBACK = String(process.env.ANYU_DNS_FALLBACK || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
// 官方站点主机名：只有它走带兜底的专用 DNS 解析与 dispatcher。
const OFFICIAL_API_HOST = (() => {
  try { return new URL(OFFICIAL_API_ORIGIN).hostname.toLowerCase() } catch { return '' }
})()

function isUsableAddress(address) {
  const value = String(address || '')
  if (!net.isIP(value)) return false
  if (value.includes(':')) return !/^f[cd]/i.test(value)
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some((item) => !Number.isInteger(item))) return false
  const [a, b] = octets
  return a !== 0 && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 198 && b >= 18 && b <= 19) && !(a >= 224)
}

function officialLookup(hostname, options, callback) {
  if (!OFFICIAL_DNS_FALLBACK.length) {
    return dns.lookup(hostname, options, callback)
  }
  dns.lookup(hostname, { ...options, all: true }, (error, records) => {
    const usable = (records || []).filter((record) => isUsableAddress(record.address))
    const selected = usable.length ? usable : OFFICIAL_DNS_FALLBACK.map((address) => ({ address, family: 4 }))
    if (!selected.length) return callback(error || new Error('正式服务器 DNS 解析失败'))
    callback(null, options?.all ? selected : selected[0].address, options?.all ? undefined : selected[0].family)
  })
}

function gatewayLookup(hostname, options, callback) {
  if (String(hostname || '').toLowerCase() === OFFICIAL_API_HOST) return officialLookup(hostname, options, callback)
  return dns.lookup(hostname, options, callback)
}

const officialDispatcher = new UndiciAgent({ connect: { lookup: officialLookup } })

// 统一沿用正式网页端的 /api/v1 前缀，避免环境变量尾斜杠或重复前缀导致请求落到错误地址。
function normalizeApiBase(value) {
  const raw = String(value || DEFAULT_API_BASE).trim() || DEFAULT_API_BASE
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error(`Anyu 服务地址无效，请使用 ${OFFICIAL_API_ORIGIN}`) }
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error('Anyu 服务地址必须使用 HTTP 或 HTTPS')
  let pathname = parsed.pathname.replace(/\/+$/g, '')
  if (/\/api\/v1$/i.test(pathname)) pathname = pathname.slice(0, -7) || ''
  if (/\/v1$/i.test(pathname)) pathname = pathname.slice(0, -3) || ''
  parsed.pathname = pathname || '/'
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

// 判断地址是否指向本机回环，用于阻止发布版误把请求打进本机。
function isLocalOrigin(value) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(value || '').trim())
}

const customApiBase = String(process.env.ANYU_API_BASE || '').trim()
const allowCustomApiBase = process.env.ANYU_ALLOW_CUSTOM_API_BASE === '1'
// 发布包默认只访问正式域名；本机地址必须显式开启 ANYU_ALLOW_LOCAL_API_BASE=1 才允许生效，
// 避免已安装的客户端在用户不知情的情况下把登录、密钥和模型请求打进 127.0.0.1。
const allowLocalApiBase = process.env.ANYU_ALLOW_LOCAL_API_BASE === '1'
const runtimeMode = String(process.env.ANYU_RUNTIME_MODE || '').trim().toLowerCase()
// 源码启动默认是本机联调；打包发布永远走正式站，除非显式开启本机开关。
const localRuntime = allowLocalApiBase && (runtimeMode === 'local' || (runtimeMode !== 'remote' && !app.isPackaged))
const localApiBase = customApiBase && isLocalOrigin(customApiBase)
  ? customApiBase
  : 'http://127.0.0.1:8080'
const API_BASE = localRuntime
  ? normalizeApiBase(localApiBase)
  : (allowCustomApiBase && customApiBase && (allowLocalApiBase || !isLocalOrigin(customApiBase))
    ? normalizeApiBase(customApiBase)
    : DEFAULT_API_BASE)
const GATEWAY_BASE = API_BASE.replace(/\/$/, '')
const MANAGEMENT_BASE = `${GATEWAY_BASE}/api/v1`
// AiHub 使用 Jeecg 的独立会话，不能复用 TokenRouter 的 JWT。
function normalizeAiHubBase(value) {
  const raw = String(value || 'http://127.0.0.1:8080/jeecg-boot').trim()
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error('AiHub 服务地址无效') }
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error('AiHub 服务地址必须使用 HTTP 或 HTTPS')
  parsed.pathname = parsed.pathname.replace(/\/+$/g, '') || '/'
  parsed.search = ''; parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}
const AIHUB_BASE = normalizeAiHubBase(process.env.ANYU_AIHUB_BASE || 'http://127.0.0.1:8080/jeecg-boot')
const AIHUB_ENV_TOKEN = String(process.env.ANYU_AIHUB_TOKEN || '').trim()
// 本机联调实例保持离线，避免启动时通过更新检查访问线上服务。
const LOCAL_ONLY_API = localRuntime && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(API_BASE).hostname.toLowerCase())
const PI_PROVIDER = 'anyu-gateway'
const UPDATE_MANIFEST_URL = process.env.ANYU_UPDATE_MANIFEST_URL || `${GATEWAY_BASE}/downloads/downloads-manifest.json`
const USER_DATA_DIR = String(process.env.ANYU_USER_DATA_DIR || '').trim()
// 本机联调可使用独立数据目录，未设置时保持 Electron 默认路径不变。
if (USER_DATA_DIR) {
  const resolvedUserDataDir = path.resolve(USER_DATA_DIR)
  fs.mkdirSync(resolvedUserDataDir, { recursive: true })
  app.setPath('userData', resolvedUserDataDir)
}

// Agent 权限档位由主进程持久化，渲染层的 localStorage 只能作为网页端回退。
// 这样切换“完全访问”后，即使窗口重新加载，下一次 Pi 启动也会继续使用
// gptFullAccess，而不是只显示一个视觉开关。
const AGENT_PERMISSION_FILE = 'anyu-permission.json'
const AGENT_PERMISSION_MODES = new Set(['auto', 'confirm', 'full'])
function agentPermissionFile() { return path.join(app.getPath('userData'), AGENT_PERMISSION_FILE) }
function normalizeAgentPermissionMode(value) {
  const mode = String(value || '').toLowerCase()
  return AGENT_PERMISSION_MODES.has(mode) ? mode : 'auto'
}
function readAgentPermissionMode() {
  try {
    const raw = JSON.parse(fs.readFileSync(agentPermissionFile(), 'utf8'))
    return normalizeAgentPermissionMode(raw?.mode)
  } catch {
    return 'auto'
  }
}
function writeAgentPermissionMode(mode) {
  const normalized = normalizeAgentPermissionMode(mode)
  const target = agentPermissionFile()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ mode: normalized, updatedAt: Date.now() }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return normalized
}

// 读取当前进程的系统授权状态；系统权限只能由 Windows/macOS 自己授予。
//
// 判定结果缓存：提权流程会连续调用多次（提权前判定 + 提权后回报状态），
// 每次都同步拉起 PowerShell 会明显拖慢界面。缓存只在单进程内有效，
// 提权必然重启进程，所以不存在"缓存掩盖了提权结果"的问题。
let windowsAdministratorCache = null

function isWindowsAdministrator() {
  if (process.platform !== 'win32') return false
  if (windowsAdministratorCache !== null) return windowsAdministratorCache
  try {
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent() | ForEach-Object { $_.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    windowsAdministratorCache = result.trim().toLowerCase() === 'true'
    return windowsAdministratorCache
  } catch {
    // 探测失败（超时、PowerShell 被策略拦截）时不写入缓存，下次调用重试，
    // 避免一次瞬时失败就把"已经是管理员"永久误判成"不是"。
    return false
  }
}

function systemAccessState() {
  const platform = process.platform
  const elevated = platform === 'win32' ? isWindowsAdministrator() : typeof process.getuid === 'function' && process.getuid() === 0
  // launchedElevated 表示"本进程是被提权流程拉起的"，用于区分
  // "没提权"和"提权了但系统没给权限"这两种完全不同的失败原因。
  const launchedElevated = isElevatedLaunch()
  if (platform === 'win32') {
    return { platform, elevated, administrator: elevated, uacAvailable: true, canRequestElevation: !elevated, fullDiskAccess: null, launchedElevated }
  }
  if (platform === 'darwin') {
    return { platform, elevated, administrator: elevated, uacAvailable: false, canRequestElevation: false, fullDiskAccess: 'unknown', privacySettingsAvailable: true, launchedElevated }
  }
  return { platform, elevated, administrator: elevated, uacAvailable: false, canRequestElevation: false, fullDiskAccess: null, privacySettingsAvailable: false, launchedElevated }
}

async function requestSystemElevation(payload = {}) {
  if (process.platform === 'win32') {
    if (isWindowsAdministrator()) return { ok: true, restarted: false, state: systemAccessState() }
    const executable = app.getPath('exe')
    const launchArgs = JSON.stringify(process.argv.slice(1))
    const script = '$launchArgs = ConvertFrom-Json $env:ANYU_ELEVATION_ARGS; Start-Process -FilePath $env:ANYU_ELEVATION_EXE -ArgumentList $launchArgs -Verb RunAs'
    try {
      // 意图先同步落盘，再拉起提权实例。顺序不能反：新实例启动时就会读它，
      // 而渲染进程的 localStorage 写入没有落盘保证。
      writeElevationIntent(app.getPath('userData'), payload?.permissionMode)
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: { ...process.env, ANYU_ELEVATION_EXE: executable, ANYU_ELEVATION_ARGS: launchArgs, [ELEVATION_ENV_FLAG]: '1' }
      })
      pendingElevationIntent = readElevationIntent(app.getPath('userData'))
      setTimeout(() => app.quit(), 120)
      return { ok: true, restarted: true, state: { ...systemAccessState(), pending: true } }
    } catch (error) {
      // UAC 被取消或拉起失败：清掉意图，避免下次启动凭空套用完整访问。
      clearElevationIntent(app.getPath('userData'))
      pendingElevationIntent = null
      return { ok: false, cancelled: true, message: error?.message || 'Windows UAC 授权未完成', state: systemAccessState() }
    }
  }
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    return { ok: true, openedSettings: true, state: systemAccessState() }
  }
  return { ok: false, message: '当前系统不支持应用内申请管理员权限', state: systemAccessState() }
}

async function openSystemPrivacySettings(section = 'fullDiskAccess') {
  if (process.platform !== 'darwin') return { ok: false, state: systemAccessState() }
  // macOS 将完全磁盘访问和辅助功能分成两个独立的 TCC 授权项。
  const target = section === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_AllFiles'
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${target}`)
  return { ok: true, section: target, state: systemAccessState() }
}
// 读取当前生效的提权意图。惰性读取一次并缓存在内存里，
// 这样"意图生效"不依赖 whenReady 里某一行的执行顺序。
function currentElevationIntent() {
  if (!pendingElevationIntent) pendingElevationIntent = readElevationIntent(app.getPath('userData'))
  return pendingElevationIntent
}

// 读取本次启动的提权意图，供渲染进程在界面里同步权限状态。
// permissionMode 为 null 表示"只提权、不改权限模式"。
function elevationIntentState() {
  const intent = currentElevationIntent()
  const state = systemAccessState()
  return {
    pending: Boolean(intent),
    permissionMode: intent?.permissionMode || null,
    createdAt: intent?.createdAt || 0,
    launchedElevated: state.launchedElevated,
    elevated: state.elevated
  }
}

// 渲染进程确认提权意图已落地后清除，避免下次启动重复套用。
function acknowledgeElevationIntent() {
  clearElevationIntent(app.getPath('userData'))
  pendingElevationIntent = null
  return { ok: true }
}

function providerForApi(api) {
  return api === 'anthropic-messages' ? `${PI_PROVIDER}-anthropic` : api === 'google-generative-ai' || api === 'google-vertex' ? `${PI_PROVIDER}-gemini` : `${PI_PROVIDER}-openai`
}
function baseUrlForApi(api) {
  // Anthropic's SDK appends /v1/messages itself; its base URL must stay at the origin.
  if (api === 'anthropic-messages') return GATEWAY_BASE
  return api === 'google-generative-ai' || api === 'google-vertex' ? `${GATEWAY_BASE}/v1beta` : `${GATEWAY_BASE}/v1`
}
function canonicalApi(value, fallback = 'openai-completions') {
  const raw = String(value || '').toLowerCase()
  if (raw.includes('anthropic') || raw.includes('claude')) return 'anthropic-messages'
  if (raw.includes('google') || raw.includes('gemini')) return 'google-generative-ai'
  if (raw.includes('response')) return 'openai-responses'
  if (raw.includes('openai') || raw.includes('completion') || raw.includes('chat')) return 'openai-completions'
  return fallback
}
function modelInputCapabilities(model, id, api) {
  const values = [model?.input, model?.input_modalities, model?.modalities, model?.capabilities?.input, model?.capabilities?.input_modalities, model?.capabilities?.modalities]
    .flatMap((value) => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,|]+/) : [])
    .map((value) => String(value).toLowerCase().trim()).filter(Boolean)
  const visionFlags = [model?.supports_images, model?.supportsImages, model?.supports_vision, model?.supportsVision, model?.vision, model?.capabilities?.vision, model?.capabilities?.supports_vision, model?.capabilities?.supportsVision]
  const explicitFalse = visionFlags.some((value) => value === false)
  const explicitTrue = visionFlags.some((value) => value === true)
  const lower = `${id || ''} ${model?.name || ''} ${api || ''}`.toLowerCase()
  // “直来直去”原则：目录没有做任何能力声明（无 input/modality/vision 字段）时，
  // 默认视为支持图片直传——不支持视觉的模型会由 API 明确报错，而不是被静默替换成
  // "(image omitted: model does not support images)" 占位文本，让用户误以为图传了却测不了。
  // 显式声明 vision:false / 不支持时仍然降级，尊重目录的明确否定。
  const undeclared = !explicitFalse && !explicitTrue && values.length === 0 && !/image-generation|image-edit|embedding|audio/.test(lower)
  const inferred = undeclared || (!explicitFalse && !/image-generation|image-edit|embedding|audio/.test(lower) && /gemini|claude|anthropic|gpt-4o|gpt-4\.1|gpt-5|gpt-6|o[1-9]|vision|multimodal|vl|qwen2?\.5-vl|qwen3-vl|qvq|glm-4v|doubao-vision|kimi-vl|moonshot-v1-vision|internvl|pixtral|llava|ernie-4\.5/.test(lower))
  const hasImage = !explicitFalse && (explicitTrue || values.some((value) => /image|vision|multimodal|photo|picture/.test(value)) || inferred)
  const input = values.length ? [...new Set(values.map((value) => value === 'vision' || value === 'multimodal' ? 'image' : value).filter((value) => !explicitFalse || value !== 'image'))] : ['text']
  if (hasImage && !input.includes('image')) input.push('image')
  return input
}
function modelPermissionMode(model, provider = '') {
  const explicit = String(model?.permissionMode || model?.permission_mode || '').toLowerCase()
  if (explicit === 'full' || explicit === 'confirm') return explicit
  const toolFlags = [
    model?.supportsTools, model?.supports_tools, model?.toolUse,
    model?.tool_use, model?.capabilities?.tools, model?.capabilities?.tool_use
  ]
  if (toolFlags.some((value) => value === false)) return 'confirm'
  if (toolFlags.some((value) => value === true)) return 'full'
  const lower = `${model?.id || model?.name || ''} ${model?.api || ''} ${provider || ''}`.toLowerCase()
  // Leta 的主流对话模型都具备 Agent 工具调用能力；未知模型保守地要求确认。
  if (/gpt|codex|openai|claude|anthropic|gemini|google|grok|qwen|deepseek|glm|kimi|mistral|moonshot|doubao|llama/.test(lower)) return 'full'
  return 'confirm'
}
function resolvePermissionMode(requested, model, provider = '') {
  const mode = String(requested || '').toLowerCase()
  if (mode === 'full' || mode === 'confirm') return mode
  // auto 由主进程持久化设置优先决定。这样工作区设置在窗口刷新、
  // Electron 重启后仍然是权威来源；持久化为 auto 时再回退到模型能力推断。
  const persisted = readAgentPermissionMode()
  if (persisted === 'full' || persisted === 'confirm') return persisted
  return modelPermissionMode(model, provider)
}
let mainWindow
let windowsShellBootstrapPromise = null
function startWindowsShellBootstrap() {
  if (process.platform !== 'win32') return Promise.resolve({ status: 'unsupported', shellPath: '' })
  const readyPath = existingBash()
  if (readyPath) return Promise.resolve({ status: 'ready', shellPath: readyPath, installed: false })
  // 启动阶段和首次启动 Pi 可能同时触发依赖准备，复用同一个 Promise，避免并发拉起两个安装器。
  if (!windowsShellBootstrapPromise) {
    windowsShellBootstrapPromise = ensureWindowsShell((progress) => {
      mainWindow?.webContents?.send('anyu:shell-bootstrap-progress', progress)
    }).finally(() => { windowsShellBootstrapPromise = null })
  }
  return windowsShellBootstrapPromise
}
let tray = null
let isQuitting = false
let browserView = null
let browserState = { open: false, url: '', title: '', loading: false, error: '', canGoBack: false, canGoForward: false, zoomFactor: 1 }
let reportedBrowserBounds = null
let previewRoot = ''
let browserBridge = null
let browserBridgeToken = ''
const browserBridgeCwds = new Set()
let previewProtocolRegistered = false
let browserHistoryTransition = false
let auth = null
let authRefreshPromise = null
// 本次启动读到的提权意图。只要它还在，Pi 启动就必须保证权限模式落地；
// 渲染进程确认生效（或用户主动改成别的模式）后才清除。
let pendingElevationIntent = null
const keyCache = new Map()
// 多会话并行：每个会话一个 Pi 子进程。渲染层切换会话只是切换“前台”，
// 后台会话的进程与任务继续运行；pi:event / pi:exit 会带 sessionKey 供渲染层路由。
const PI_MAX_RUNTIMES = 4
const piRuntimes = new Map()
let piActiveKey = ''
let piStartLock = Promise.resolve()
// 进程启动时刻：用于判断"现在跑的这个主进程是什么时候加载的代码"。
const processStartedAt = Date.now()
function activePiRuntime() {
  const active = piRuntimes.get(piActiveKey)
  if (active?.child && active.child.exitCode === null && active.child.signalCode === null) return active
  for (const candidate of piRuntimes.values()) {
    if (candidate.child && candidate.child.exitCode === null && candidate.child.signalCode === null) return candidate
  }
  return null
}
// 按会话定位运行时：多会话并行时，命令只能发给它自己的子进程，
// 否则切换会话后 abort / prompt 会打到别的会话上。
function resolvePiRuntime(sessionKey) {
  const requested = String(sessionKey || '').trim()
  if (!requested) return activePiRuntime()
  const resolved = isInside(piSessionDir(), requested) ? path.resolve(requested) : requested
  const direct = piRuntimes.get(resolved)
  if (direct?.child && direct.child.exitCode === null && direct.child.signalCode === null) return direct
  for (const runtime of piRuntimes.values()) {
    if ((runtime.key === resolved || runtime.key === requested) && runtime.child && runtime.child.exitCode === null && runtime.child.signalCode === null) return runtime
  }
  return null
}
let updateInProgress = false
let recoveredUpdateState = null
let pluginManager = null
let skillManager = null
let agentSessionService = null
const dependencyJobs = new Map()
function preparePluginDependencies(record) {
  if (!record?.id || !record.dependencies || !Object.keys(record.dependencies).length) return
  if (dependencyJobs.has(record.id)) return dependencyJobs.get(record.id)
  pluginManager?.updateDependencyStatus(record.id, 'pending', {})
  const operation = pluginProgressReporter('dependencies', record.id)
  // 环境准备必须是后台任务：插件安装完成即可使用，依赖失败只标记状态，不阻塞市场 UI。
  const job = Promise.resolve().then(() => prepareDependencies(record.dependencies, operation.report))
    .then((result) => {
      if (pluginManager?.get(record.id)?.installedPath !== record.installedPath) return
      const missing = [...(result.missingCommands || []), ...(result.missingPython || [])]
      pluginManager?.updateDependencyStatus(record.id, result.status, { missing, optionalMissing: result.missingOptionalCommands || [], failures: result.failures || [] })
      operation.report({
        phase: result.status === 'ready' ? 'dependency-ready' : 'dependency-manual', percent: 100,
        message: result.status === 'ready' ? '插件运行环境已就绪' : `环境安装已结束，仍缺少：${missing.join(', ') || '请检查依赖状态'}`,
        pluginId: record.id
      })
    })
    .catch((error) => {
      if (pluginManager?.get(record.id)?.installedPath !== record.installedPath) return
      const message = error?.message || String(error)
      pluginManager?.updateDependencyStatus(record.id, 'manual', { error: message })
      operation.report({ phase: 'dependency-manual', percent: 100, message: `环境准备失败：${message}`, pluginId: record.id })
    })
    .finally(() => dependencyJobs.delete(record.id))
  dependencyJobs.set(record.id, job)
  return job
}
let piSkillLaunch = null
let localFeedback = null
let localDetail = null
let shopMonitorSyncBusy = false

// 桌面端在线时轮询运营系统的到期任务，并在本机专属浏览器中执行采集。
async function syncShopMonitorJobs() {
  if (shopMonitorSyncBusy || !localFeedback || !auth?.accessToken) return
  shopMonitorSyncBusy = true
  try {
    const jobs = await requestApi('/admin/shop-monitors/agent/jobs')
    for (const job of Array.isArray(jobs) ? jobs : []) {
      let task
      try { task = localFeedback.startShopMonitor({ url: job.shop_url, maxRounds: 60 }) } catch (error) {
        await requestApi(`/admin/shop-monitors/runs/${encodeURIComponent(String(job.run_id))}/complete`, { method: 'POST', body: { status: 'failed', error_message: error?.message || '店铺监控技能未安装', products: [] } }).catch(() => {})
        continue
      }
      let state = null
      for (let attempt = 0; attempt < 190; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        state = await localFeedback.get(task.taskId)
        if (['OK', 'FAILED', 'CANCELLED'].includes(state.status)) break
      }
      const result = state?.result || {}
      await requestApi(`/admin/shop-monitors/runs/${encodeURIComponent(String(job.run_id))}/complete`, {
        method: 'POST',
        body: {
          status: state?.status === 'OK' && result?.ok !== false ? 'success' : 'failed',
          error_message: state?.status === 'OK' ? '' : String(result.message || state?.message || '浏览器采集失败'),
          products: Array.isArray(result?.products) ? result.products : []
        }
      })
    }
  } catch {
    // 未登录、后端暂不可用或没有到期任务时静默等待下一轮。
  } finally { shopMonitorSyncBusy = false }
}
const analysisControllers = new Set()
const BUSINESS_PLUGIN_IDS = {
  feedback: 'tmall-public-feedback-analysis', shopMonitor: 'tmall-shop-monitor', imageAnalysis: 'ai-image-analysis', detail: 'tmall-detail-reference'
}
function requireBusinessPlugin(id) {
  const record = pluginManager?.get(id)
  if (!record?.enabled || !record.installedPath || !fs.existsSync(record.installedPath)) throw new Error('请先在插件市场安装并启用该技能')
  return record
}
const BROWSER_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024
const gatewayBridge = new LocalGatewayBridge({
  gatewayBase: GATEWAY_BASE,
  lookup: gatewayLookup,
  userAgent: APP_USER_AGENT,
  getAccessToken: () => auth?.accessToken || '',
  refreshAccessToken: () => refreshAuthAccessToken()
})

function timestampValue(value) {
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function sendUpdateProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:progress', payload)
}

// 插件操作统一从主进程发事件，渲染层只维护一条卡片内的进度状态。
function sendPluginProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('plugin:progress', payload)
}

function pluginProgressReporter(action, pluginId = '') {
  const operationId = crypto.randomUUID()
  return {
    operationId,
    report: (progress = {}) => sendPluginProgress({
      operationId,
      action,
      pluginId: String(progress.pluginId || pluginId || ''),
      ...progress
    })
  }
}

async function readPluginDownload(response, report) {
  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body?.getReader?.()
  if (!reader) {
    const data = Buffer.from(await response.arrayBuffer())
    report({ phase: 'downloaded', percent: 28, message: '插件下载完成' })
    return data
  }
  const chunks = []
  let received = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    const chunk = Buffer.from(part.value)
    chunks.push(chunk)
    received += chunk.length
    const percent = total > 0 ? Math.min(26, 10 + Math.round((received / total) * 16)) : 18
    report({ phase: 'downloading', percent, message: total > 0 ? `正在下载插件 ${Math.round((received / total) * 100)}%` : '正在下载插件' })
  }
  report({ phase: 'downloaded', percent: 28, message: '插件下载完成' })
  return Buffer.concat(chunks)
}

function sendBrowserState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent-browser:state', { ...browserState })
}

function browserBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !reportedBrowserBounds) return null
  return normalizeBrowserBounds(reportedBrowserBounds, mainWindow.getContentBounds())
}

function setBrowserBounds(reportedBounds = reportedBrowserBounds) {
  reportedBrowserBounds = reportedBounds
  if (!browserView || browserView.webContents.isDestroyed()) return
  const bounds = browserBounds()
  if (!bounds) {
    browserView.setVisible(false)
    return
  }
  browserView.setBounds(bounds)
  browserView.setVisible(true)
}

function setBrowserZoomFactor(value = 1) {
  const parsed = Number(value)
  const zoomFactor = Number.isFinite(parsed) ? Math.min(2, Math.max(0.5, parsed)) : 1
  browserState = { ...browserState, zoomFactor }
  if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.setZoomFactor(zoomFactor)
  sendBrowserState()
  return { ...browserState }
}

function isAllowedBrowserUrl(value) {
  return allowedBrowserUrl(value)
}

function sanitizeArtifactHtml(source) {
  // CSP 必须先于用户文件解析；内联交互可运行，但不能发请求、提交表单或加载外部资源。
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"
  const html = String(source || '')
  const prefix = html.match(/^\s*<!doctype\s+html[^>]*>/i)?.[0] || ''
  return `${prefix}<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${html.slice(prefix.length)}`
}

function escapeArtifactText(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function artifactDataUrl(filePath) {
  const stats = fs.statSync(filePath)
  if (!stats.isFile() || stats.size > BROWSER_ARTIFACT_MAX_BYTES) throw new Error('结果文件不存在或超过预览大小限制')
  const extension = path.extname(filePath).toLowerCase()
  const data = fs.readFileSync(filePath)
  if (extension === '.html' || extension === '.htm') {
    const html = sanitizeArtifactHtml(data.toString('utf8'))
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  }
  if (extension === '.json' || extension === '.csv' || extension === '.md' || extension === '.txt') {
    const text = data.toString('utf8')
    const html = `<!doctype html><meta charset="utf-8"><style>body{font:13px ui-monospace,Consolas,monospace;padding:24px;white-space:pre-wrap;word-break:break-word;color:#202124;background:#fff}</style><pre>${escapeArtifactText(text)}</pre>`
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  }
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' })[extension]
  if (!mime) throw new Error('当前文件类型暂不支持内置预览')
  return `data:${mime};base64,${data.toString('base64')}`
}

// 工作区协议只服务可预览的静态资源，禁止任意文件类型与越界读取。
const PREVIEW_MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.md': 'text/markdown', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const PREVIEW_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"

async function previewResponse(request) {
  try {
    const referer = String(request.referrer || request.headers?.get?.('referer') || '')
    if (referer && !referer.startsWith('leta-preview://workspace/')) throw new Error('跨站资源请求不允许')
    const url = new URL(request.url)
    if (url.hostname !== 'workspace' || !previewRoot) throw new Error('预览不可用')
    const candidate = workspaceFile(previewRoot, `.${decodeURIComponent(url.pathname)}`)
    const real = await fs.promises.realpath(candidate)
    workspaceFile(previewRoot, path.relative(previewRoot, real))
    const stat = await fs.promises.stat(real)
    const mime = PREVIEW_MIME[path.extname(real).toLowerCase()]
    if (!stat.isFile() || !mime || stat.size > BROWSER_ARTIFACT_MAX_BYTES) throw new Error('文件类型或大小不支持预览')
    const data = await fs.promises.readFile(real)
    const display = ['application/json', 'text/csv', 'text/markdown', 'text/plain'].includes(mime)
    const body = display ? `<!doctype html><meta charset="utf-8"><style>body{font:13px ui-monospace,Consolas,monospace;padding:24px;white-space:pre-wrap;word-break:break-word;color:#202124;background:#fff}</style><pre>${escapeArtifactText(data.toString('utf8'))}</pre>` : data
    return new Response(body, { headers: { 'Content-Type': display ? 'text/html; charset=utf-8' : `${mime}${mime.startsWith('text/') ? '; charset=utf-8' : ''}`, 'Content-Security-Policy': PREVIEW_CSP, 'X-Content-Type-Options': 'nosniff' } })
  } catch { return new Response('预览文件不存在或不在工作区内', { status: 404 }) }
}

function ensureBrowserView() {
  if (browserView && !browserView.webContents.isDestroyed()) return browserView
  const browserSession = session.fromPartition('persist:leta-agent-browser')
  // The embedded commerce browser is untrusted web content: no camera,
  // microphone, geolocation or notification access from inside the app.
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.setPermissionCheckHandler(() => false)
  if (!previewProtocolRegistered) { browserSession.protocol.handle('leta-preview', previewResponse); previewProtocolRegistered = true }
  browserView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, session: browserSession } })
  browserView.webContents.setZoomFactor(Number(browserState.zoomFactor) || 1)
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    if (!browserState.url.startsWith('artifact://') && isAllowedBrowserUrl(url)) void openBrowserUrl(url).catch(() => {})
    return { action: 'deny' }
  })
  browserView.webContents.on('did-start-loading', () => { browserState = { ...browserState, loading: true, error: '' }; sendBrowserState() })
  browserView.webContents.on('did-stop-loading', () => { browserState = { ...browserState, loading: false, title: browserView.webContents.getTitle() || browserState.title }; sendBrowserState() })
  browserView.webContents.on('page-title-updated', (_, title) => { browserState = { ...browserState, title: String(title || '') }; sendBrowserState() })
  browserView.webContents.on('will-navigate', (event, url) => {
    const preview = url.startsWith('leta-preview://workspace/')
    if (browserState.url.startsWith('artifact://') && !browserHistoryTransition ? !preview : !isAllowedBrowserUrl(url) && !(browserHistoryTransition && preview)) event.preventDefault()
  })
  browserView.webContents.on('will-redirect', (event, url) => {
    if (browserState.url.startsWith('artifact://') ? !url.startsWith('leta-preview://workspace/') : !isAllowedBrowserUrl(url)) event.preventDefault()
  })
  browserView.webContents.on('did-navigate', (_, url) => {
    browserHistoryTransition = false
    const displayUrl = url.startsWith('leta-preview://workspace/') && previewRoot
      ? `artifact://${path.resolve(previewRoot, `.${decodeURIComponent(new URL(url).pathname)}`)}` : url
    browserState = { ...browserState, url: displayUrl }
    browserState = { ...browserState, canGoBack: browserView.webContents.navigationHistory.canGoBack(), canGoForward: browserView.webContents.navigationHistory.canGoForward() }
    sendBrowserState()
  })
  browserView.webContents.on('did-fail-load', (_, code, description) => { if (code !== -3) browserState = { ...browserState, loading: false, error: description || '浏览器页面加载失败' }; sendBrowserState() })
  mainWindow.contentView.addChildView(browserView)
  setBrowserBounds()
  return browserView
}

async function openBrowserUrl(url) {
  if (!isAllowedBrowserUrl(url)) throw new Error('只支持 HTTP(S) 网页地址')
  const view = ensureBrowserView()
  browserState = { ...browserState, open: true, url: String(url), title: new URL(String(url)).hostname, loading: true, error: '' }
  sendBrowserState()
  void view.webContents.loadURL(String(url)).catch((error) => {
    browserState = { ...browserState, loading: false, error: error.message || '页面加载失败' }
    sendBrowserState()
  })
  return { ...browserState }
}

async function openPaymentBrowser(payload = {}) {
  const method = String(payload.method || '').trim().toLowerCase()
  const snapshot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : null
  if (method !== 'airwallex' || !snapshot?.clientSecret || !snapshot?.intentId) {
    throw new Error('当前支付方式不支持在内置支付页继续')
  }
  const view = ensureBrowserView()
  const origin = API_BASE
  const landing = `${origin}/`
  const query = new URLSearchParams()
  if (snapshot.orderId) query.set('order_id', String(snapshot.orderId))
  if (snapshot.outTradeNo) query.set('out_trade_no', String(snapshot.outTradeNo))
  if (snapshot.resumeToken) query.set('resume_token', String(snapshot.resumeToken))
  const target = `${origin}/payment/airwallex${query.toString() ? `?${query.toString()}` : ''}`
  const recoveryKey = 'payment.recovery.current'
  browserState = { ...browserState, open: true, url: target, title: 'Airwallex Payment', loading: true, error: '' }
  sendBrowserState()
  try {
    // 先进入同源页面，再写入恢复快照，最后加载支付路由，避免支付组件挂载时读不到 localStorage。
    await view.webContents.loadURL(landing)
    const serialized = JSON.stringify({
      orderId: Number(snapshot.orderId) || 0,
      amount: Number(snapshot.amount) || 0,
      qrCode: String(snapshot.qrCode || ''),
      expiresAt: String(snapshot.expiresAt || ''),
      paymentType: 'airwallex',
      payUrl: String(snapshot.payUrl || ''),
      outTradeNo: String(snapshot.outTradeNo || ''),
      clientSecret: String(snapshot.clientSecret || ''),
      intentId: String(snapshot.intentId || ''),
      currency: String(snapshot.currency || ''),
      countryCode: String(snapshot.countryCode || ''),
      paymentEnv: String(snapshot.paymentEnv || ''),
      payAmount: Number(snapshot.payAmount) || 0,
      orderType: 'balance',
      paymentMode: String(snapshot.paymentMode || ''),
      resumeToken: String(snapshot.resumeToken || ''),
      createdAt: Date.now()
    })
    await view.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(recoveryKey)}, ${JSON.stringify(serialized)})`, true)
    await view.webContents.loadURL(target)
    // 支付组件挂载后不再需要恢复快照，及时从持久浏览器会话移除其中的 client_secret。
    const cleanupTimer = setTimeout(() => {
      if (!view.webContents.isDestroyed()) void view.webContents.executeJavaScript(`localStorage.removeItem(${JSON.stringify(recoveryKey)})`, true).catch(() => {})
    }, 15_000)
    cleanupTimer.unref?.()
    browserState = { ...browserState, url: target, title: 'Airwallex Payment', loading: false, error: '' }
    sendBrowserState()
    return { ...browserState }
  } catch (error) {
    browserState = { ...browserState, loading: false, error: error?.message || '支付页面加载失败' }
    sendBrowserState()
    throw error
  }
}

// QR 内容来自服务端订单，二维码在本机生成，避免把支付串交给第三方二维码服务。
async function createPaymentQrDataUrl(value) {
  const text = String(value || '').trim()
  if (!text || text.length > 4096) throw new Error('支付二维码内容无效')
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
}


async function openBrowserArtifact(payload = {}) {
  const cwd = path.resolve(String(payload.cwd || ''))
  const requested = String(payload.path || '').trim()
  if (!cwd || !path.isAbsolute(cwd) || !requested) throw new Error('结果文件位置无效')
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作目录不存在')
  const candidate = path.resolve(cwd, requested)
  if (!isInside(cwd, candidate) || !fs.existsSync(candidate)) throw new Error('只能预览当前工作目录中的结果文件')
  if (!isInside(fs.realpathSync(cwd), fs.realpathSync(candidate))) throw new Error('结果文件不能指向工作目录外')
  const realRoot = fs.realpathSync(cwd)
  const realCandidate = fs.realpathSync(candidate)
  if (!PREVIEW_MIME[path.extname(realCandidate).toLowerCase()] || fs.statSync(realCandidate).size > BROWSER_ARTIFACT_MAX_BYTES) throw new Error('当前文件类型或大小不支持内置预览')
  const view = ensureBrowserView()
  previewRoot = realRoot
  browserState = { ...browserState, open: true, url: `artifact://${candidate}`, title: path.basename(candidate), loading: true, error: '' }
  sendBrowserState()
  const relative = path.relative(realRoot, realCandidate).split(path.sep).map(encodeURIComponent).join('/')
  void view.webContents.loadURL(`leta-preview://workspace/${relative}`).catch((error) => {
    browserState = { ...browserState, loading: false, error: error.message || '结果预览失败' }
    sendBrowserState()
  })
  return { ...browserState }
}

function inspectWorkspaceArtifacts(payload = {}) {
  const cwd = path.resolve(String(payload.cwd || ''))
  const requestedPaths = Array.isArray(payload.paths) ? payload.paths.slice(0, 32) : []
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('结果文件位置无效')
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作目录不存在')
  const previewExtensions = new Set(['.html', '.htm', '.json', '.csv', '.md', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'])
  const textExtensions = new Set(['.html', '.htm', '.json', '.csv', '.md', '.txt', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.go', '.py', '.yaml', '.yml', '.sql'])
  const unique = new Map()
  for (const requested of requestedPaths) {
    const raw = String(requested || '').trim().replace(/^['"`]|['"`]$/g, '')
    if (!raw) continue
    const candidate = path.resolve(cwd, raw)
    if (!isInside(cwd, candidate) || !fs.existsSync(candidate)) continue
    if (!isInside(fs.realpathSync(cwd), fs.realpathSync(candidate))) continue
    const relativePath = path.relative(cwd, candidate) || path.basename(candidate)
    const stats = fs.statSync(candidate)
    if (stats.isDirectory()) {
      unique.set(candidate.toLowerCase(), { path: relativePath, name: path.basename(candidate), extension: '', size: 0, lineCount: 0, directory: true, previewable: false })
      continue
    }
    if (!stats.isFile()) continue
    const extension = path.extname(candidate).toLowerCase()
    let lineCount = 0
    if (textExtensions.has(extension) && stats.size <= 2 * 1024 * 1024) {
      try { lineCount = fs.readFileSync(candidate, 'utf8').split(/\r?\n/).length } catch {}
    }
    unique.set(candidate.toLowerCase(), {
      path: relativePath,
      name: path.basename(candidate),
      extension,
      size: stats.size,
      lineCount,
      previewable: previewExtensions.has(extension) && stats.size <= BROWSER_ARTIFACT_MAX_BYTES
    })
  }
  return { artifacts: [...unique.values()] }
}

async function openWorkspacePath(payload = {}) {
  const cwd = path.resolve(String(payload.cwd || ''))
  const requested = String(payload.path || '').trim()
  if (!cwd || !path.isAbsolute(cwd) || !requested) throw new Error('路径位置无效')
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作目录不存在')
  const candidate = path.resolve(cwd, requested)
  if ((!isInside(cwd, candidate) && candidate !== cwd) || !fs.existsSync(candidate)) throw new Error('路径不存在或越界')
  const real = fs.realpathSync(candidate)
  const realRoot = fs.realpathSync(cwd)
  if ((!isInside(realRoot, real) && real !== realRoot) || !isInside(cwd, candidate) && candidate !== cwd) throw new Error('路径不能指向工作目录外')
  if (payload.mode === 'explorer') {
    if (process.platform === 'win32') spawn('explorer.exe', [fs.statSync(real).isDirectory() ? real : `/select,${real}`], { detached: true, windowsHide: true }).unref()
    else shell.showItemInFolder(real)
  } else {
    const error = await shell.openPath(real)
    if (error) throw new Error(error)
  }
  return { ok: true, path: real }
}

function closeBrowserView() {
  localFeedback?.cancel()
  localDetail?.cancel()
  if (browserView && mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(browserView)
  if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.close()
  browserView = null
  previewRoot = ''
  browserState = { open: false, url: '', title: '', loading: false, error: '', canGoBack: false, canGoForward: false, zoomFactor: 1 }
  reportedBrowserBounds = null
  sendBrowserState()
  return { ...browserState }
}

async function checkForUpdate() {
  if (LOCAL_ONLY_API) {
    return { ok: true, currentVersion: app.getVersion(), latestVersion: app.getVersion(), available: false, localOnly: true, message: '本机版已固定到本机服务，跳过线上更新检查' }
  }
  const manifestUrl = new URL(UPDATE_MANIFEST_URL)
  manifestUrl.searchParams.set('_letaagent_cache_bust', String(Date.now()))
  const response = await fetch(manifestUrl, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache'
    }
  })
  const text = await response.text()
  let manifest
  try { manifest = text ? JSON.parse(text) : null } catch { throw new Error('更新目录不是有效 JSON') }
  if (!response.ok) throw new Error(`更新目录不可用 (HTTP ${response.status})`)
  const artifact = artifactFromManifest(manifest, app.getVersion(), manifestUrl.href)
  if (new URL(artifact.url).origin !== manifestUrl.origin) throw new Error('更新包地址不属于当前更新源')
  return { ok: true, currentVersion: app.getVersion(), latestVersion: artifact.version, available: compareVersions(artifact.version, app.getVersion()) > 0, artifact: { name: artifact.name, version: artifact.version, bytes: artifact.bytes, sha256: artifact.sha256, url: artifact.url } }
}

function updaterScriptPath() { return path.join(app.getPath('temp'), `letaagent-updater-${process.pid}-${Date.now()}.ps1`) }

function pendingUpdatePath() { return path.join(app.getPath('userData'), 'pending-update.json') }

function writePendingUpdate(installerPath, expectedVersion) {
  const markerPath = pendingUpdatePath()
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  const marker = {
    status: 'ready',
    installerPath,
    expectedVersion: String(expectedVersion || ''),
    executablePath: app.getPath('exe'),
    installDirectory: path.dirname(app.getPath('exe')),
    createdAt: new Date().toISOString()
  }
  const temporaryPath = `${markerPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(temporaryPath, markerPath)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
    fs.rmSync(markerPath, { force: true })
    fs.renameSync(temporaryPath, markerPath)
  }
  return markerPath
}

function safePendingInstallerPath(installerPath) {
  const candidate = path.resolve(String(installerPath || ''))
  const tempRoot = path.resolve(app.getPath('temp')) + path.sep
  return candidate.startsWith(tempRoot) && /^AnyuAgent-update-[A-Za-z0-9._-]+\.exe$/i.test(path.basename(candidate))
    ? candidate
    : ''
}

function openUpdateInstaller(installerPath, expectedVersion = '') {
  const candidate = safePendingInstallerPath(installerPath)
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error('更新安装包不存在，请重新下载')
  const child = spawn(candidate, [], { detached: true, windowsHide: false, stdio: 'ignore' })
  child.once('error', (error) => sendUpdateProgress({ phase: 'error', version: expectedVersion, message: `打开更新安装包失败：${error.message || error}` }))
  child.unref()
  sendUpdateProgress({ phase: 'ready', version: expectedVersion, percent: 100, message: '安装包已打开，请确认覆盖安装' })
  return { ok: true, status: 'ready', latestVersion: String(expectedVersion || '') }
}

function openPendingUpdateInstaller() {
  const markerPath = pendingUpdatePath()
  let pending
  try { pending = JSON.parse(fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, '')) } catch { throw new Error('没有可用的更新安装包，请重新下载') }
  return openUpdateInstaller(pending?.installerPath, pending?.expectedVersion)
}

function scheduleWindowsInstall(installerPath, expectedVersion, markerPath = pendingUpdatePath()) {
  const executablePath = app.getPath('exe')
  const installDirectory = path.dirname(executablePath)
  const scriptPath = updaterScriptPath()
  const logPath = `${scriptPath}.log`
  const lockPath = `${markerPath}.lock`
  const script = [
    'param([int]$ParentPid, [string]$Installer, [string]$Executable, [string]$InstallDirectory, [string]$ExpectedVersion, [string]$Script, [string]$Log, [string]$Marker, [string]$Lock)',
    "$ErrorActionPreference = 'Stop'",
    '$success = $false',
    '$lockStream = $null',
    '$lockAcquired = $false',
    'function Set-MarkerStatus([string]$Status, [string]$ErrorMessage) { try { $raw = Get-Content -LiteralPath $Marker -Raw -ErrorAction SilentlyContinue; $data = if ($raw) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }; $data | Add-Member -NotePropertyName status -NotePropertyValue $Status -Force; $data | Add-Member -NotePropertyName error -NotePropertyValue $ErrorMessage -Force; $data | Add-Member -NotePropertyName logPath -NotePropertyValue $Log -Force; $data | Add-Member -NotePropertyName updatedAt -NotePropertyValue (Get-Date).ToString("o") -Force; $temporaryMarker = "$Marker.$PID.tmp"; $utf8 = New-Object System.Text.UTF8Encoding($false); [IO.File]::WriteAllText($temporaryMarker, ($data | ConvertTo-Json -Depth 8), $utf8); Move-Item -LiteralPath $temporaryMarker -Destination $Marker -Force } catch {} }',
    'function Write-Log([string]$Message) { try { Add-Content -LiteralPath $Log -Value ("[{0}] {1}" -f (Get-Date -Format o), $Message) -Encoding utf8 } catch {} }',
    'try {',
    '  try { $lockStream = [IO.File]::Open($Lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $lockAcquired = $true } catch { Write-Log "另一个更新器正在运行，退出"; exit 0 }',
    '  Write-Log "更新器启动，父进程 PID=$ParentPid，安装包=$Installer"',
    '  $deadline = (Get-Date).AddSeconds(60)',
    '  while ((Get-Date) -lt $deadline) {',
    '    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue',
    '    if (-not $parent) { break }',
    '    Start-Sleep -Milliseconds 250',
    '  }',
    '  $remaining = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue',
    '  if ($remaining) { Write-Log "父进程未按时退出，强制结束"; Stop-Process -Id $ParentPid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }',
    '  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "更新安装包不存在: $Installer" }',
    '  if (-not (Test-Path -LiteralPath $InstallDirectory -PathType Container)) { throw "安装目录不存在: $InstallDirectory" }',
    '  $exitCode = 1',
    '  for ($attempt = 1; $attempt -le 3; $attempt++) {',
    '    # NSIS requires the quoted /D value when the install directory contains spaces.',
    '    $installArgument = "/D=`"$InstallDirectory`""',
    '    $installerArgs = @("/S", "/NCRC", $installArgument)',
    '    try {',
    '      $probe = $null',
    '      $probe = Join-Path $InstallDirectory (".anyu-write-test-" + [guid]::NewGuid().ToString("N"))',
    '      [IO.File]::WriteAllText($probe, "update")',
    '      Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue',
    '      Write-Log "尝试 $attempt：直接运行安装器"',
    '      $process = Start-Process -FilePath $Installer -ArgumentList $installerArgs -Wait -PassThru -ErrorAction Stop',
    '    } catch {',
    '      if ($probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }',
    '      Write-Log "直接运行失败，尝试请求管理员权限：$($_.Exception.Message)"',
    '      $process = Start-Process -FilePath $Installer -ArgumentList $installerArgs -Verb RunAs -Wait -PassThru -ErrorAction Stop',
    '    }',
    '    $exitCode = [int]$process.ExitCode',
    '    Write-Log "安装器退出码=$exitCode"',
    '    if ($exitCode -ne 0) {',
    '      try { Write-Log "非零退出码，使用管理员权限重试"; $process = Start-Process -FilePath $Installer -ArgumentList $installerArgs -Verb RunAs -Wait -PassThru -ErrorAction Stop; $exitCode = [int]$process.ExitCode; Write-Log "管理员重试退出码=$exitCode" } catch { Write-Log "管理员重试失败：$($_.Exception.Message)" }',
    '    }',
    '    if ($exitCode -eq 0) { break }',
    '    Start-Sleep -Seconds 2',
    '  }',
    '  if ($exitCode -ne 0) { throw "安装器退出码: $exitCode" }',
    '  $target = $Executable',
    '  $ready = $false',
    '  for ($i = 0; $i -lt 40; $i++) {',
    '    if (Test-Path -LiteralPath $target -PathType Leaf) { $ready = $true; break }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '  if (-not $ready) { throw "安装完成后找不到客户端: $target" }',
    '  $installedVersion = [string](Get-Item -LiteralPath $target).VersionInfo.ProductVersion',
    '  Write-Log "安装后版本=$installedVersion"',
    '  if ($ExpectedVersion -and (-not $installedVersion -or -not $installedVersion.StartsWith($ExpectedVersion, [StringComparison]::OrdinalIgnoreCase))) { throw "安装版本校验失败: 期望 $ExpectedVersion，实际 $installedVersion" }',
    '  $started = $false',
    '  for ($launchAttempt = 1; $launchAttempt -le 3; $launchAttempt++) {',
    '    Write-Log "尝试启动客户端 $launchAttempt"',
    '    $client = Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) -PassThru -ErrorAction SilentlyContinue',
    '    if ($client) { Start-Sleep -Seconds 5; $running = Get-Process -Id $client.Id -ErrorAction SilentlyContinue; if ($running -and -not $running.HasExited) { $started = $true; break } }',
    '    Start-Sleep -Seconds 1',
    '  }',
    '  if (-not $started) { throw "客户端重启失败: $target" }',
    '  Write-Log "客户端已启动，更新成功"',
    '  $success = $true',
  '} catch {',
    '  $failure = $_.Exception.Message',
    '  Write-Log "更新失败：$failure"',
    '  Set-MarkerStatus "failed" $failure',
    '  exit 1',
    '} finally {',
    '  if ($lockStream) { try { $lockStream.Dispose() } catch {} }',
    '  if ($success) {',
    '    Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue',
    '    Remove-Item -LiteralPath $Marker -Force -ErrorAction SilentlyContinue',
    '  }',
    '  if ($lockAcquired) { Remove-Item -LiteralPath $Lock -Force -ErrorAction SilentlyContinue }',
    '  if ($lockAcquired) { Remove-Item -LiteralPath $Script -Force -ErrorAction SilentlyContinue }',
    '}'
  ].join('\r\n') + '\r\n'
  // 必须写入 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 文件按 ANSI(GBK) 解析，
  // 脚本里的中文字符串会被错位切分导致引号失配 → 脚本解析失败且一个字都不执行
  // （表现为"更新调度后安装器静默消失"）。
  fs.writeFileSync(scriptPath, '\uFEFF' + script, { encoding: 'utf8', mode: 0o600 })
  const { spawn: spawnChild } = require('child_process')
  const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ParentPid', String(process.pid), '-Installer', installerPath, '-Executable', executablePath, '-InstallDirectory', installDirectory, '-ExpectedVersion', String(expectedVersion || ''), '-Script', scriptPath, '-Log', logPath, '-Marker', markerPath, '-Lock', lockPath]
  const child = spawnChild(powershell, args, { detached: true, windowsHide: true, stdio: 'ignore' })
  child.once('error', (error) => {
    try { fs.appendFileSync(logPath, `更新器启动失败: ${error.message}\r\n`, { encoding: 'utf8' }) } catch {}
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      marker.status = 'failed'; marker.error = `更新器启动失败: ${error.message}`; marker.logPath = logPath; marker.updatedAt = new Date().toISOString()
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch {}
  })
  child.unref()
  return { scriptPath, logPath, executablePath, markerPath, lockPath }
}

function recoverPendingUpdate() {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  const markerPath = pendingUpdatePath()
  let pending
  try { pending = JSON.parse(fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, '')) } catch { return false }
  if (pending?.status === 'failed') {
    recoveredUpdateState = { status: 'error', message: String(pending.error || '上次自动更新失败'), logPath: String(pending.logPath || '') }
    return false
  }
  const installerPath = String(pending?.installerPath || '')
  const expectedVersion = String(pending?.expectedVersion || '')
  if (expectedVersion && compareVersions(app.getVersion(), expectedVersion) >= 0) {
    const safeInstallerPath = safePendingInstallerPath(installerPath)
    try { fs.rmSync(markerPath, { force: true }); if (safeInstallerPath) fs.rmSync(safeInstallerPath, { force: true }) } catch {}
    return false
  }
  const safeInstallerPath = safePendingInstallerPath(installerPath)
  if (!safeInstallerPath || !fs.existsSync(safeInstallerPath)) {
    try { fs.rmSync(markerPath, { force: true }) } catch {}
    return false
  }
  // 更新包已经下载好时只恢复“待用户确认安装”状态，绝不静默执行或退出当前客户端。
  recoveredUpdateState = {
    status: 'ready',
    latestVersion: expectedVersion,
    message: '更新安装包已下载，点击左下角按钮打开并确认覆盖安装',
    installerPath: safeInstallerPath
  }
  return false
}

function getUpdateState() {
  return recoveredUpdateState ? { ...recoveredUpdateState } : { status: 'idle', message: '' }
}

async function downloadAndInstallUpdate() {
  if (updateInProgress) throw new Error('更新正在进行中')
  updateInProgress = true
  let installerPath = ''
  let markerPath = ''
  try {
    const info = await checkForUpdate()
    if (!info.available) return { ...info, status: 'latest' }
    if (process.platform !== 'win32') throw new Error('当前自动安装仅支持 Windows')
    if (!app.isPackaged) throw new Error('开发模式不能自动安装更新，请使用已安装的 AnyuAgent')
    const tempName = `AnyuAgent-update-${info.latestVersion}-${Date.now()}.exe`
    installerPath = path.join(app.getPath('temp'), tempName)
    sendUpdateProgress({ phase: 'downloading', version: info.latestVersion, loaded: 0, total: info.artifact.bytes, percent: 0 })
    const response = await fetch(info.artifact.url, { headers: { Accept: 'application/octet-stream' } })
    if (!response.ok || !response.body) throw new Error(`更新包下载失败 (HTTP ${response.status})`)
    const file = await fs.promises.open(installerPath, 'wx', 0o700)
    const hash = crypto.createHash('sha256')
    let loaded = 0
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        await file.write(buffer)
        hash.update(buffer)
        loaded += buffer.length
        sendUpdateProgress({ phase: 'downloading', version: info.latestVersion, loaded, total: info.artifact.bytes, percent: Math.min(100, Math.round(loaded / info.artifact.bytes * 100)) })
      }
      await file.sync()
    } finally {
      await file.close()
    }
    const actualSha256 = hash.digest('hex')
    if (loaded !== info.artifact.bytes) throw new Error(`更新包大小校验失败（期望 ${info.artifact.bytes}，实际 ${loaded}）`)
    if (actualSha256 !== info.artifact.sha256.toLowerCase()) throw new Error('更新包 SHA-256 校验失败')
    markerPath = writePendingUpdate(installerPath, info.latestVersion)
    // Do not stop Pi, quit Electron, or run NSIS silently. The visible installer
    // lets the user choose the overwrite directory and close AnyuAgent at the
    // appropriate time, avoiding a half-replaced desktop installation.
    const opened = openUpdateInstaller(installerPath, info.latestVersion)
    return { ...info, ...opened, status: 'ready', installerReady: true }
  } catch (error) {
    if (installerPath) { try { fs.rmSync(installerPath, { force: true }) } catch {} }
    if (markerPath) { try { fs.rmSync(markerPath, { force: true }) } catch {} }
    sendUpdateProgress({ phase: 'error', message: error.message || '自动更新失败' })
    throw error
  } finally {
    updateInProgress = false
  }
}

function authFile() { return path.join(app.getPath('userData'), 'anyu-auth.json') }
function protect(value) {
  if (!value) return ''
  // 系统安全存储不可用时仅保留当前进程会话，禁止把令牌明文写入磁盘。
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : ''
}
function unprotect(value) {
  if (!value) return ''
  if (!safeStorage.isEncryptionAvailable()) return ''
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')) } catch { return '' }
}
function loadAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(authFile(), 'utf8'))
    auth = { accessToken: unprotect(raw.accessToken), refreshToken: unprotect(raw.refreshToken), aiHubAccessToken: unprotect(raw.aiHubAccessToken), user: raw.user || null }
    if (!auth.accessToken) auth = null
  } catch { auth = null }
}
function saveAuth(data) {
  auth = data
  const out = { accessToken: protect(data.accessToken), refreshToken: protect(data.refreshToken), aiHubAccessToken: protect(data.aiHubAccessToken), user: data.user || null }
  fs.mkdirSync(path.dirname(authFile()), { recursive: true })
  fs.writeFileSync(authFile(), JSON.stringify(out), { mode: 0o600 })
}

function clearAuth() {
	auth = null
	try { fs.rmSync(authFile(), { force: true }) } catch {}
}

async function refreshAuthAccessToken() {
  if (!auth?.refreshToken) return ''
  if (authRefreshPromise) return authRefreshPromise
  authRefreshPromise = (async () => {
    const refreshed = await requestApi('/auth/refresh', { method: 'POST', body: { refresh_token: auth.refreshToken } }, false)
    if (!refreshed?.access_token) throw new Error('登录状态刷新失败')
    saveAuth({ ...auth, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || auth.refreshToken })
    return auth.accessToken
  })()
  try { return await authRefreshPromise } finally { authRefreshPromise = null }
}

function piAgentDir() { return path.join(app.getPath('userData'), 'pi') }
function piSessionDir() { return path.join(piAgentDir(), 'sessions') }
function piAttachmentDir() { return path.join(piAgentDir(), 'attachments') }
function piAttachmentIndexFile() { return path.join(piAttachmentDir(), 'index.json') }
function piMediaDir() { return path.join(piAgentDir(), 'media') }
function piMediaIndexFile() { return path.join(piMediaDir(), 'index.json') }
function piSessionMetaFile() { return path.join(piAgentDir(), 'sessions-meta.json') }
function readPiSessionMeta() {
  try {
    const value = JSON.parse(fs.readFileSync(piSessionMetaFile(), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
function writePiSessionMeta(meta) {
  fs.mkdirSync(piAgentDir(), { recursive: true })
  fs.writeFileSync(piSessionMetaFile(), JSON.stringify(meta, null, 2), { mode: 0o600 })
}
function sessionMetaKey(sessionPath) { return path.resolve(String(sessionPath || '')) }
function assertPiSessionPath(sessionPath, { allowMissing = true } = {}) {
  const value = String(sessionPath || '')
  if (!value || !isInside(piSessionDir(), value) || path.extname(value).toLowerCase() !== '.jsonl') throw new Error('不允许操作工作区之外的会话文件')
  if (!allowMissing && !fs.existsSync(value)) throw new Error('会话文件不存在')
  return path.resolve(value)
}
async function sessionMetaAction(payload = {}) {
  const action = String(payload.action || '')
  const sessionPath = assertPiSessionPath(payload.sessionPath, { allowMissing: action === 'delete' })
  const key = sessionMetaKey(sessionPath)
  const meta = readPiSessionMeta()
  const current = meta[key] && typeof meta[key] === 'object' ? meta[key] : {}
  if (action === 'pin') {
    meta[key] = { ...current, pinned: Boolean(payload.pinned), updatedAt: Date.now() }
  } else if (action === 'rename') {
    const title = String(payload.title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!title) throw new Error('会话名称不能为空')
    meta[key] = { ...current, title, updatedAt: Date.now() }
  } else if (action === 'delete') {
    const attachmentKey = attachmentSessionKey(sessionPath)
    await mediaWrites.get(attachmentKey)?.catch(() => {})
    try { if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { force: true }) } catch (error) { throw new Error(`删除会话失败：${error.message}`) }
    delete meta[key]
    const attachmentIndex = readAttachmentIndex()
    for (const record of (Array.isArray(attachmentIndex[attachmentKey]) ? attachmentIndex[attachmentKey] : [])) {
      try { if (record?.file) fs.rmSync(record.file, { force: true }) } catch {}
    }
    delete attachmentIndex[attachmentKey]
    writeAttachmentIndex(attachmentIndex)
    const mediaIndex = readMediaIndex()
    delete mediaIndex[attachmentKey]
    writeMediaIndex(mediaIndex)
    await fs.promises.rm(piMediaRecordFile(attachmentKey), { force: true })
  } else throw new Error('不支持的会话操作')
  writePiSessionMeta(meta)
  return { ok: true, action, path: sessionPath, pinned: Boolean(meta[key]?.pinned), title: meta[key]?.title || '' }
}

// 分叉会话：会话记录就是本机的一个 .jsonl 文件（%APPDATA%/leta-agent-desktop/pi/sessions），
// 分叉 = 原样复制出一份新文件、换一个新会话 id。原会话一个字节都不动，
// 新会话从第一条消息开始延续同样的上下文（Pi 加载文件即恢复全部记忆）。
// 这样两条会话可以各自继续，互不影响——和 Codex 的本机历史分支是同一种思路。
function forkPiSession(payload = {}) {
  const source = assertPiSessionPath(payload.sessionPath)
  if (!fs.existsSync(source)) throw new Error('会话文件不存在')
  const raw = fs.readFileSync(source, 'utf8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  if (!lines.length) throw new Error('会话是空的，没有可分叉的内容')
  let header
  try { header = JSON.parse(lines[0]) } catch { throw new Error('会话文件损坏，无法分叉') }
  if (header?.type !== 'session') throw new Error('会话文件缺少会话头，无法分叉')
  const sessionId = crypto.randomUUID()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const target = path.join(path.dirname(source), `${stamp}Z_${sessionId}.jsonl`)
  if (fs.existsSync(target)) throw new Error('分叉目标文件已存在，请重试')
  const nextHeader = { ...header, id: sessionId, timestamp: new Date().toISOString() }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, [JSON.stringify(nextHeader), ...lines.slice(1)].join('\n') + '\n', { mode: 0o600 })
  cloneSessionSidecars(source, target)
  // 分叉出来的会话默认沿用原标题并加个分支标记，避免在列表里分不清谁是谁。
  const meta = readPiSessionMeta()
  const baseTitle = String(meta[sessionMetaKey(source)]?.title || '').trim()
  const title = baseTitle ? `${baseTitle} 分支`.slice(0, 80) : ''
  if (title) meta[sessionMetaKey(target)] = { title, forkedFrom: source, createdAt: Date.now() }
  writePiSessionMeta(meta)
  piSessionsCache = { signature: '', sessions: [] }
  return { ok: true, path: target, title, forkedFrom: source }
}

// 会话分叉不仅复制 Pi 的 jsonl，还要复制客户端维护的附件/媒体侧车。
// 否则分叉后的对话看得到历史文字，却拿不到原会话的图片和技能结果，
// 继续发送时会表现成“上下文丢失”或技能重新失败。
function cloneSessionSidecars(source, target) {
  try {
    const sourceKey = attachmentSessionKey(source)
    const targetKey = attachmentSessionKey(target)
    const index = readAttachmentIndex()
    const records = Array.isArray(index[sourceKey]) ? index[sourceKey] : []
    if (records.length) {
      const copied = records.flatMap((record) => {
        if (!record?.file || !fs.existsSync(record.file)) return []
        const file = path.join(piAttachmentDir(), `${targetKey}-${safeAttachmentId(record.id)}.bin`)
        try {
          fs.copyFileSync(record.file, file)
          return [{ ...record, file }]
        } catch { return [] }
      })
      if (copied.length) { index[targetKey] = copied; writeAttachmentIndex(index) }
    }
  } catch { /* 侧车复制失败不应阻断会话本身的分叉 */ }
  try {
    const sourceKey = attachmentSessionKey(source)
    const targetKey = attachmentSessionKey(target)
    const sourceMedia = piMediaRecordFile(sourceKey)
    const targetMedia = piMediaRecordFile(targetKey)
    if (fs.existsSync(sourceMedia)) {
      fs.mkdirSync(path.dirname(targetMedia), { recursive: true })
      fs.copyFileSync(sourceMedia, targetMedia)
      const record = JSON.parse(fs.readFileSync(targetMedia, 'utf8'))
      fs.writeFileSync(targetMedia, JSON.stringify({ ...record, sessionPath: target }), { mode: 0o600 })
    }
  } catch { /* 业务卡片是增强信息，不能让它阻断主会话 */ }
}
function attachmentSessionKey(sessionPath) {
  return crypto.createHash('sha256').update(String(sessionPath || 'unsaved')).digest('hex')
}
function readAttachmentIndex() {
  try {
    const value = JSON.parse(fs.readFileSync(piAttachmentIndexFile(), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function writeAttachmentIndex(index) {
  fs.mkdirSync(piAttachmentDir(), { recursive: true })
  fs.writeFileSync(piAttachmentIndexFile(), JSON.stringify(index, null, 2), { mode: 0o600 })
}
function safeAttachmentId(value) {
  const id = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  return id || `attachment-${Date.now()}`
}
function savePiAttachments(payload = {}) {
  const sessionPath = String(payload.sessionPath || '')
  if (sessionPath && !isInside(piSessionDir(), sessionPath)) throw new Error('不允许保存工作区之外的会话附件')
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : []
  if (!attachments.length) return []
  const index = readAttachmentIndex()
  const key = attachmentSessionKey(sessionPath)
  const current = Array.isArray(index[key]) ? index[key] : []
  fs.mkdirSync(piAttachmentDir(), { recursive: true })
  const saved = []
  for (const attachment of attachments) {
    if (attachment?.kind !== 'image' || typeof attachment.data !== 'string' || !attachment.data) continue
    const id = safeAttachmentId(attachment.id)
    let buffer
    try { buffer = Buffer.from(attachment.data, 'base64') } catch { continue }
    if (!buffer.length || buffer.length > 16 * 1024 * 1024) continue
    const file = path.join(piAttachmentDir(), `${key}-${id}.bin`)
    fs.writeFileSync(file, buffer, { mode: 0o600 })
    const record = {
      id, kind: 'image', name: String(attachment.name || id).slice(0, 240),
      size: Number(attachment.size || buffer.length), mimeType: String(attachment.mimeType || 'image/png'),
      messageText: String(payload.messageText || ''), createdAt: Number(payload.createdAt || Date.now()), file
    }
    const oldIndex = current.findIndex((item) => item.id === id && item.messageText === record.messageText)
    if (oldIndex >= 0) current[oldIndex] = record
    else current.push(record)
    saved.push({ ...record })
  }
  index[key] = current.slice(-500)
  writeAttachmentIndex(index)
  return saved
}
function loadPiAttachments(sessionPath) {
  const key = attachmentSessionKey(String(sessionPath || ''))
  const index = readAttachmentIndex()
  const records = Array.isArray(index[key]) ? index[key] : []
  return records.flatMap((record) => {
    try {
      const data = fs.readFileSync(record.file).toString('base64')
      return [{ ...record, dataUrl: `data:${record.mimeType || 'image/png'};base64,${data}` }]
    } catch { return [] }
  })
}
function readMediaIndex() {
  try {
    const value = JSON.parse(fs.readFileSync(piMediaIndexFile(), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function writeMediaIndex(index) {
  fs.mkdirSync(piMediaDir(), { recursive: true })
  fs.writeFileSync(piMediaIndexFile(), JSON.stringify(index, null, 2), { mode: 0o600 })
}
function piMediaRecordFile(key) { return path.join(piMediaDir(), 'sessions', `${key}.json`) }
function piOptimisticRecordFile(key) { return path.join(piMediaDir(), 'sessions', `${key}.optimistic.json`) }
const mediaWrites = new Map()
function mediaRecordSources(item) {
  const sources = []
  const add = (value) => { if (value && typeof value === 'object' && !sources.includes(value)) sources.push(value) }
  add(item); add(item?.data); add(item?.result); add(item?.output); add(item?.image); add(item?.data?.[0]); add(item?.result?.[0]); add(item?.output?.[0])
  return sources
}
function mediaRecordData(item) {
  for (const source of mediaRecordSources(item)) {
    for (const key of ['data', 'b64_json', 'base64', 'image_data', 'image_base64']) {
      const raw = source?.[key]
      if (typeof raw !== 'string') continue
      const value = raw.trim()
      if (!value) continue
      if (/^data:[^,]+,/i.test(value)) return value.slice(value.indexOf(',') + 1)
      if (/^base64,/i.test(value)) return value.slice(value.indexOf(',') + 1)
      if (!/^(?:https?:\/\/|data:)/i.test(value)) return value
    }
  }
  return ''
}
function mediaRecordUrl(item, mimeType, data) {
  for (const source of mediaRecordSources(item)) {
    for (const key of ['dataUrl', 'data_url', 'url', 'image_url', 'imageUrl', 'src', 'data']) {
      const value = String(source?.[key] || '').trim()
      if (/^(?:https?:\/\/|data:)/i.test(value)) return value
    }
  }
  return data ? `data:${mimeType};base64,${data}` : ''
}
function mediaMessageRecord(message) {
  if (!message || !['user', 'assistant', 'tool'].includes(message.role)) return null
  const record = {
    id: message.id ? String(message.id) : undefined,
    role: message.role,
    content: String(message.content || ''),
    createdAt: Number(message.createdAt || Date.now()),
    startedAt: message.startedAt ? Number(message.startedAt) : undefined,
    finishedAt: message.finishedAt ? Number(message.finishedAt) : undefined,
    isError: Boolean(message.isError),
    mediaPending: Boolean(message.mediaPending),
    autoEdit: Boolean(message.autoEdit),
    autoEditPending: Boolean(message.autoEditPending),
    autoEditAwaitingConfirmation: Boolean(message.autoEditAwaitingConfirmation),
    autoEditPlan: message.autoEditPlan || undefined,
    autoEditAnalysis: message.autoEditAnalysis ? String(message.autoEditAnalysis) : undefined,
    autoEditInputs: Array.isArray(message.autoEditInputs) ? message.autoEditInputs.map(String).slice(0, 100) : undefined,
    // 保存图片规划卡的可读状态，重启客户端后仍能还原规划过程。
    mediaPhase: message.mediaPhase ? String(message.mediaPhase) : undefined,
    mediaPlanSteps: Array.isArray(message.mediaPlanSteps) ? message.mediaPlanSteps.map((step) => String(step || '')).filter(Boolean).slice(0, 4) : undefined,
    mediaPlanCompleted: Number.isFinite(Number(message.mediaPlanCompleted)) ? Number(message.mediaPlanCompleted) : undefined,
    mediaPlanSummary: message.mediaPlanSummary ? String(message.mediaPlanSummary) : undefined,
    mediaPlanSource: message.mediaPlanSource ? String(message.mediaPlanSource) : undefined,
    mediaPlanText: message.mediaPlanText ? String(message.mediaPlanText) : undefined,
    businessSkill: message.businessSkill ? String(message.businessSkill) : undefined,
    businessPending: Boolean(message.businessPending),
    businessPhase: message.businessPhase ? String(message.businessPhase) : undefined,
    businessStatus: message.businessStatus ? String(message.businessStatus) : undefined,
    businessResult: message.businessResult || undefined,
    businessAssets: Array.isArray(message.businessAssets) ? message.businessAssets : undefined,
    feedbackTaskId: message.feedbackTaskId ? String(message.feedbackTaskId) : undefined,
    feedbackUrl: message.feedbackUrl ? String(message.feedbackUrl) : undefined,
    feedbackPrompt: message.feedbackPrompt ? String(message.feedbackPrompt) : undefined,
    feedbackCollected: Boolean(message.feedbackCollected),
    feedbackRetry: Boolean(message.feedbackRetry),
    shopAnalysisRetry: Boolean(message.shopAnalysisRetry),
    artifactCwd: message.artifactCwd ? String(message.artifactCwd) : undefined,
    artifacts: Array.isArray(message.artifacts) ? message.artifacts : undefined
  }
  if (Array.isArray(message.attachments)) {
    record.attachments = message.attachments.map((item) => {
      const mimeType = String(item?.mimeType || item?.mime_type || 'image/png').split(';')[0] || 'image/png'
      const data = mediaRecordData(item)
      const dataUrl = mediaRecordUrl(item, mimeType, data)
      return { item, mimeType, data, dataUrl }
    }).filter(({ item, dataUrl }) => item?.kind === 'image' && dataUrl).map(({ item, mimeType, data, dataUrl }) => ({
      id: String(item.id || `media-image-${Date.now()}`), kind: 'image', name: String(item.name || 'Leta 生图.png'),
      size: Number(item.size || Math.floor(String(data || '').length * 0.75)), mimeType, data: item.previewOnly ? '' : data, dataUrl,
      previewOnly: Boolean(item.previewOnly),
      downloadTaskId: item.downloadTaskId ? String(item.downloadTaskId) : undefined,
      downloadIndex: Number.isFinite(Number(item.downloadIndex)) ? Number(item.downloadIndex) : 0
    }))
  }
  if (message.media?.kind === 'video' && typeof message.media.dataUrl === 'string' && message.media.dataUrl) {
    record.media = { kind: 'video', name: String(message.media.name || 'Leta 生视频.mp4'), data: String(message.media.data || ''), dataUrl: message.media.dataUrl, downloadTaskId: message.media.downloadTaskId ? String(message.media.downloadTaskId) : undefined }
  }
  if (message.mediaPlan) record.mediaPlan = message.mediaPlan
  return record
}
async function savePiMediaMessages(payload = {}) {
  const sessionPath = String(payload.sessionPath || '')
  if (!sessionPath || !isInside(piSessionDir(), sessionPath)) throw new Error('不允许保存工作区之外的媒体会话')
  const messages = Array.isArray(payload.messages) ? payload.messages.map(mediaMessageRecord).filter(Boolean).slice(-100) : []
  const key = attachmentSessionKey(sessionPath)
  const record = { sessionPath, cwd: String(payload.cwd || ''), modified: Date.now(), messages }
  const file = piMediaRecordFile(key)
  // 同一会话串行提交，临时文件加原子替换避免崩溃后留下截断的 JSON。
  const previous = mediaWrites.get(key) || Promise.resolve()
  const write = previous.catch(() => {}).then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
      await fs.promises.rename(temporary, file)
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    return { ok: true }
  })
  mediaWrites.set(key, write)
  try { return await write } finally { if (mediaWrites.get(key) === write) mediaWrites.delete(key) }
}
function loadPiMediaMessages(sessionPath) {
  const key = attachmentSessionKey(String(sessionPath || ''))
  let record
  try { record = JSON.parse(fs.readFileSync(piMediaRecordFile(key), 'utf8')) }
  catch { record = readMediaIndex()[key] }
  return Array.isArray(record?.messages) ? recoverLegacyFeedback(record.messages, record.cwd) : []
}

// 发送后、Pi 尚未写入首个事件前保存用户消息，避免切换会话时乐观消息只存在 renderer 内存。
function savePiOptimisticMessage(payload = {}) {
  const sessionPath = String(payload.sessionPath || '')
  if (!sessionPath || !isInside(piSessionDir(), sessionPath)) throw new Error('不允许保存工作区之外的会话消息')
  const message = payload.message && typeof payload.message === 'object' ? {
    id: String(payload.message.id || ''),
    role: 'user',
    content: String(payload.message.content || ''),
    createdAt: Number(payload.message.createdAt || Date.now()),
    attachments: Array.isArray(payload.message.attachments) ? payload.message.attachments.map((item) => ({
      id: String(item?.id || ''), name: String(item?.name || ''), kind: String(item?.kind || ''),
      mimeType: String(item?.mimeType || ''), size: Number(item?.size || 0)
    })).slice(0, 32) : []
  } : null
  if (!message?.id || !message.content && !message.attachments.length) throw new Error('乐观消息为空')
  const key = attachmentSessionKey(sessionPath)
  const file = piOptimisticRecordFile(key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const record = { sessionPath, cwd: String(payload.cwd || sessionWorkingDirectory(sessionPath) || ''), modified: Date.now(), message }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
  fs.renameSync(temporary, file)
  return { ok: true }
}
function loadPiOptimisticMessage(sessionPath) {
  const key = attachmentSessionKey(String(sessionPath || ''))
  const file = piOptimisticRecordFile(key)
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.message || null } catch { return null }
}
function clearPiOptimisticMessage(sessionPath) {
  const key = attachmentSessionKey(String(sessionPath || ''))
  const file = piOptimisticRecordFile(key)
  try { fs.rmSync(file, { force: true }) } catch {}
}
function recoverLegacyFeedback(messages, cwd) {
  if (!messages.some((message) => message?.content === 'businessHtml is not defined' && !message.businessSkill)) return messages
  const directory = path.join(app.getPath('userData'), 'local-skill-tasks', 'feedback')
  let tasks = []
  try {
    tasks = fs.readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name)).flatMap((name) => {
      try { return [JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))] } catch { return [] }
    })
  } catch { return messages }
  return messages.map((message) => {
    if (message?.content !== 'businessHtml is not defined' || message.businessSkill || !String(message.id || '').endsWith(':result')) return message
    const user = messages.find((item) => item.id === message.id.slice(0, -7) && item.role === 'user')
    const url = String(user?.content || '').match(/https:\/\/[^\s]+/)?.[0]
    const matches = tasks.filter((task) => task.status === 'OK' && task.url === url && Math.abs(Date.parse(task.createdAt) - Number(user.createdAt)) < 60000)
    if (matches.length !== 1) return message
    const task = matches[0]
    // 旧版漏存了业务字段；仅凭唯一 URL 与时间窗口恢复已成功采集的任务，不再抓取。
    return { ...message, businessSkill: 'feedback', businessPending: false, businessPhase: '分析失败', businessStatus: 'FAILED', feedbackTaskId: task.taskId, feedbackUrl: task.url, feedbackPrompt: String(user.content || '').replace(/^(?:@评价分析\s*)+/g, ''), feedbackCollected: true, feedbackRetry: true, artifactCwd: String(cwd || app.getPath('home')), content: '原始采集已保留，可继续分析。' }
  })
}
function piExecutable() {
  const packaged = app.isPackaged
  return packaged
    ? path.join(process.resourcesPath, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi')
    : path.join(__dirname, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi')
}

function defaultWorkspacePath() {
  const installRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname
  const candidate = path.join(installRoot, 'workspace')
  try {
    fs.mkdirSync(candidate, { recursive: true })
    fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK)
    return candidate
  } catch {
    const fallback = path.join(app.getPath('userData'), 'workspace')
    fs.mkdirSync(fallback, { recursive: true })
    return fallback
  }
}
// Electron 主进程能直接读 app.asar，但 pi.exe 这类外部进程读不到包内文件：
// 打包后必须把路径换成 app.asar.unpacked 下的实体文件（配合 package.json 的 asarUnpack）。
function externalProcessPath(fileName) {
  const packed = path.join(__dirname, fileName)
  const marker = `${path.sep}app.asar${path.sep}`
  if (!packed.includes(marker)) return packed
  const unpacked = packed.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
  return fs.existsSync(unpacked) ? unpacked : packed
}
function materializePiSession(payload = {}) {
  const sessionPath = String(payload.sessionPath || '')
  if (!sessionPath || !isInside(piSessionDir(), sessionPath)) throw new Error('不允许创建工作区之外的会话文件')
  if (fs.existsSync(sessionPath)) {
    const requestedCwd = String(payload.cwd || '').trim()
    if (requestedCwd) {
      try {
        const lines = fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/)
        const header = JSON.parse(lines[0])
        if (header?.type === 'session' && header.cwd !== requestedCwd) {
          header.cwd = requestedCwd; lines[0] = JSON.stringify(header); fs.writeFileSync(sessionPath, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 })
          return { ok: true, created: false, updated: true, path: sessionPath }
        }
      } catch {}
    }
    return { ok: true, created: false, path: sessionPath }
  }
  const sessionId = path.basename(sessionPath, '.jsonl').split('_').pop() || crypto.randomUUID()
  const cwd = String(payload.cwd || app.getPath('home'))
  const header = { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.writeFileSync(sessionPath, `${JSON.stringify(header)}\n`, { mode: 0o600 })
  return { ok: true, created: true, path: sessionPath }
}
function createPiSession(payload = {}) {
  const directory = piSessionDir()
  fs.mkdirSync(directory, { recursive: true })
  const requestedCwd = String(payload.cwd || '').trim()
  const cwd = requestedCwd && path.isAbsolute(requestedCwd) && fs.existsSync(requestedCwd) && fs.statSync(requestedCwd).isDirectory()
    ? requestedCwd
    : app.getPath('home')
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sessionId = crypto.randomUUID()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const sessionPath = path.join(directory, `${stamp}_${sessionId}.jsonl`)
    const header = { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }
    let descriptor
    try {
      descriptor = fs.openSync(sessionPath, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify(header)}\n`)
      return { ok: true, created: true, path: sessionPath, cwd }
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === 7) throw error
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }
  throw new Error('无法创建新的对话会话，请重试')
}
// 直接读会话 .jsonl，不经过 Pi 进程。切换会话时如果目标会话的进程还没起来，
// 渲染层可以先用它把历史画出来，不必干等 pi.exe 冷启动（通常 1~3 秒）。
// 返回结构与 Pi 的 get_messages 保持一致，后续真值到达时无缝覆盖。
function readPiSessionMessages(sessionPath) {
  const resolved = assertPiSessionPath(sessionPath)
  if (!fs.existsSync(resolved)) return []
  let raw = ''
  try { raw = fs.readFileSync(resolved, 'utf8') } catch { return [] }
  const entries = []
  for (const line of raw.split(/\r?\n/)) {
    const text = String(line || '').trim()
    if (!text) continue
    let entry; try { entry = JSON.parse(text) } catch { continue }
    if (entry && typeof entry === 'object' && entry.id) entries.push(entry)
  }
  // 必须与 Pi 的 buildSessionContext 走同一条路径，否则直读会把被压缩掉、
  // 或已经分叉弃用的历史一并画出来：
  //   1) 从叶子条目沿 parentId 回溯出当前分支；
  //   2) 若分支上有 compaction，则只保留压缩点之后的条目。
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const path = []
  const seen = new Set()
  let current = entries[entries.length - 1]
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  path.reverse()
  let compactionIndex = -1
  for (let index = path.length - 1; index >= 0; index--) {
    if (path[index].type === 'compaction') { compactionIndex = index; break }
  }
  let visible = path
  if (compactionIndex >= 0) {
    const compaction = path[compactionIndex]
    const kept = [compaction]
    let foundFirstKept = !compaction.firstKeptEntryId
    for (let index = 0; index < compactionIndex; index++) {
      if (path[index].id === compaction.firstKeptEntryId) foundFirstKept = true
      if (foundFirstKept) kept.push(path[index])
    }
    visible = kept.concat(path.slice(compactionIndex + 1))
  }
  const messages = []
  for (const entry of visible) {
    if (entry.type !== 'message' || !entry.message) continue
    const message = entry.message
    if (!['user', 'assistant', 'toolResult'].includes(message?.role)) continue
    // 刻意不注入 entry.id：Pi 的 get_messages 同样不带 id，两边形状一致，
    // 渲染层对“本地乐观消息”的按内容/时间归并才能照常工作。
    messages.push(message.timestamp ? message : { ...message, timestamp: entry.timestamp })
  }
  return messages
}
function sessionWorkingDirectory(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return ''
  try {
    const first = fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/).find(Boolean)
    const header = first ? JSON.parse(first) : null
    return header?.type === 'session' ? String(header.cwd || '') : ''
  } catch { return '' }
}
function isInside(parent, candidate) {
  const root = path.resolve(parent) + path.sep
  return path.resolve(candidate).startsWith(root)
}
function keyValue(record) {
  if (!record || typeof record !== 'object') return ''
  for (const name of ['key', 'api_key', 'apiKey', 'token', 'secret', 'value', 'key_value', 'secret_key', 'token_value']) {
    if (typeof record[name] === 'string' && record[name].trim()) return record[name].trim()
  }
  return ''
}
function rememberKeys(payload) {
  const items = Array.isArray(payload) ? payload : payload?.items || payload?.data || payload?.keys || []
  if (!Array.isArray(items)) return
  for (const item of items) if (item?.id != null) keyCache.set(String(item.id), item)
}

function modelConfig(models, runtime = {}) {
  const grouped = new Map()
  for (const model of (Array.isArray(models) ? models : [])) {
    const id = String(model?.modelId || model?.model_id || model?.id || model?.name || '').replace(/^models\//, '').trim()
    if (!id) continue
    const lower = `${id} ${model?.api || ''}`.toLowerCase()
    const api = canonicalApi(model?.api, lower.includes('gemini') || lower.includes('google') ? 'google-generative-ai' : lower.includes('claude') || lower.includes('anthropic') ? 'anthropic-messages' : 'openai-completions')
    const groupId = Number(model?.groupId || model?.group_id || 0)
    const managed = runtime.managed === true && Number.isSafeInteger(groupId) && groupId > 0
    const provider = managed ? managedProviderName(api, groupId) : providerForApi(api)
    const baseUrl = managed ? managedBaseUrl(runtime.bridgeOrigin, api, groupId) : baseUrlForApi(api)
    if (!grouped.has(provider)) grouped.set(provider, { api, baseUrl, models: [] })
    const displayName = String(model?.name || model?.display_name || id)
    // 思考强度能力统一交给模板库判定：主进程与渲染层共用一份规则，
    // 接口显式声明的档位优先，其次才按模型族匹配模板。
    const thinking = resolveThinking({
      id,
      name: displayName,
      api,
      reasoning: model?.reasoning ?? model?.supports_reasoning ?? model?.supportsReasoning,
      thinkingLevels: model?.thinkingLevels || model?.thinking_levels || model?.reasoning_levels,
      thinkingLevelMap: model?.thinkingLevelMap || model?.thinking_level_map || model?.reasoning_effort_map || model?.reasoningEffortMap
    })
    grouped.get(provider).models.push({
      id,
      name: displayName,
      api,
      baseUrl,
      reasoning: thinking.reasoning,
      thinkingLevels: thinking.levels,
      // pi's models.json schema rejects null here; omit the field for models
      // that have no per-level effort mapping instead of failing the whole catalog.
      ...(thinking.map ? { thinkingLevelMap: thinking.map } : {}),
      compat: model?.compat,
      input: modelInputCapabilities(model, id, api),
      supportsImages: modelInputCapabilities(model, id, api).includes('image'),
      supportsTools: model?.supportsTools ?? model?.supports_tools ?? model?.capabilities?.tools,
      permissionMode: model?.permissionMode || model?.permission_mode || '',
      contextWindow: Number(model?.contextWindow || model?.context_window || 128000),
      // Deliberately no maxTokens: the desktop must not impose a character or
      // token ceiling. The model/backend decides when generation ends.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
  }
  const providers = {}
  for (const [provider, group] of grouped) providers[provider] = { name: `Anyu ${group.api}`, baseUrl: group.baseUrl, api: group.api, apiKey: '$ANYU_API_KEY', authHeader: true, models: group.models }
  return { providers }
}

function parsePiLines(runtime, chunk) {
  runtime.buffer += chunk.toString('utf8')
  while (true) {
    const index = runtime.buffer.indexOf('\n')
    if (index < 0) break
    const line = runtime.buffer.slice(0, index).replace(/\r$/, '')
    runtime.buffer = runtime.buffer.slice(index + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    // Session layer first: it owns the normalized event stream, approvals and
    // the append-only log. Legacy renderer forwarding below stays untouched.
    try { agentSessionService?.ingest(runtime.key, message) } catch (error) { console.error('[agent-session]', error?.message || error) }
    if (message.type === 'response' && message.id && runtime.pending.has(message.id)) {
      settlePiRequest(runtime, message.id, message.success === false ? new Error(message.error || 'Pi command failed') : null, message)
    }
    // 命令确认只用于主进程兑现 IPC Promise，渲染进程不会消费 response；
    // 不再把这类内部事件转发到 renderer，减少高频 IPC 噪声。
    if (message.type === 'response') continue
    if (message.type === 'agent_settled') runtime.inFlightPrompt = false
    runtime.lastEventAt = Date.now()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pi:event', { ...message, sessionKey: runtime.key })
  }
}

function settlePiRequest(runtime, id, error, value) {
  const pending = runtime.pending.get(id)
  if (!pending) return
  runtime.pending.delete(id)
  if (pending.timer) clearTimeout(pending.timer)
  if (error) pending.reject(error)
  else pending.resolve(value)
}

async function stopPiRuntime(runtime) {
  const child = runtime.child
  runtime.child = null
  for (const id of [...runtime.pending.keys()]) settlePiRequest(runtime, id, new Error('Pi process stopped'))
  if (!child) return
  try { child.stdin?.end() } catch {}
  try { child.kill() } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve()
    const timer = setTimeout(resolve, 1200)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  if (child.exitCode === null && !child.signalCode) {
    try { child.kill('SIGKILL') } catch {}
  }
}

async function stopPi() {
  piSkillLaunch = null
  try { agentSessionService?.stopAll() } catch {}
  localFeedback?.cancel()
  for (const controller of analysisControllers) controller.abort()
  await stopBrowserBridge()
  const runtimes = [...piRuntimes.values()]
  piRuntimes.clear()
  piActiveKey = ''
  await Promise.all(runtimes.map((runtime) => stopPiRuntime(runtime)))
  await gatewayBridge.stop()
}

async function stopBrowserBridge() {
  const server = browserBridge
  browserBridge = null
  browserBridgeToken = ''
  browserBridgeCwds.clear()
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}

async function startBrowserBridge(cwd) {
  // 多会话并行后浏览器桥由所有 Pi 子进程共享：令牌保持稳定，只按需登记新的工作区，
  // 否则第二次启动会轮换令牌，让先启动的会话打不开结果文件。
  const realpath = (() => { try { return fs.realpathSync(cwd) } catch { return '' } })()
  if (browserBridge && browserBridgeToken) {
    if (realpath) browserBridgeCwds.add(realpath)
    return { port: browserBridge.address().port, token: browserBridgeToken }
  }
  await stopBrowserBridge()
  browserBridgeToken = crypto.randomBytes(32).toString('hex')
  if (realpath) browserBridgeCwds.add(realpath)
  const token = browserBridgeToken
  const server = http.createServer((request, response) => {
    const fail = (code, message) => { response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(message) }
    const route = String(request.url || '')
    const allowedRoutes = new Set(['/open', '/commerce', '/artifacts'])
    if (request.method !== 'POST' || !allowedRoutes.has(route) || request.headers['x-leta-token'] !== token || browserBridge !== server) { fail(403, '浏览器请求无效'); return }
    const maxBytes = route === '/artifacts' ? 26 * 1024 * 1024 : 8192
    const chunks = []
    let bodyBytes = 0
    let rejected = false
    request.on('data', (chunk) => {
      bodyBytes += chunk.length
      if (bodyBytes > maxBytes) {
        rejected = true
        fail(413, '浏览器请求内容过大')
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', async () => {
      if (rejected) return
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const requested = (() => { try { return fs.realpathSync(String(payload.cwd || '')) } catch { return '' } })()
        if (!requested || !browserBridgeCwds.has(requested)) throw new Error('工作区不匹配')
        if (route === '/open') {
          const url = String(payload.url || '').trim()
          const filePath = String(payload.path || '').trim()
          if (Boolean(url) === Boolean(filePath)) throw new Error('必须指定一个网页或文件')
          if (url) await openBrowserUrl(url)
          else await openBrowserArtifact({ path: filePath, cwd: requested })
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('OK')
          return
        }
        if (route === '/commerce') {
          const result = await runCommerceAction(payload, {
            openUrl: openBrowserUrl,
            getWebContents: () => ensureBrowserView().webContents
          })
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(result))
          return
        }
        const result = writeAnyuAgentArtifacts({ ...payload, cwd: requested })
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(result))
      } catch (error) { fail(400, error.message || '浏览器打开失败') }
    })
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    browserBridge = server
    return { port: server.address().port, token }
  } catch (error) { browserBridgeToken = ''; browserBridgeCwds.clear(); throw error }
}

function sendPi(command, runtimeArg = null) {
  const explicit = runtimeArg?.child?.stdin?.writable ? runtimeArg : null
  const runtime = explicit || activePiRuntime()
  if (!runtime?.child?.stdin?.writable) return Promise.reject(new Error('Pi Agent 尚未启动'))
  const id = command.id || `anyu-${++runtime.counter}`
  const payload = { ...command, id }
  // Prompt and steer are asynchronous task submissions. Pi acknowledges them
  // separately from the eventual agent_end/agent_settled events, so applying a
  // client-side timeout here can report a false failure while the task is still
  // running. They remain pending until Pi acknowledges them or the process exits.
  // 异步任务提交只等待 Pi 的接收确认，不能因长输出超过客户端等待时间而误报失败。
  const timeoutMs = ['prompt', 'steer', 'follow_up'].includes(command.type) ? 0 : 15000
  if (timeoutMs === 0) runtime.inFlightPrompt = true
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => { settlePiRequest(runtime, id, new Error(`Pi 命令超时：${command.type || 'unknown'}`)) }, timeoutMs)
      : null
    runtime.pending.set(id, { resolve, reject, timer })
    try { runtime.child.stdin.write(`${JSON.stringify(payload)}\n`) } catch (error) {
      settlePiRequest(runtime, id, error)
    }
  })
}

// 只清理空闲的后台运行时，给新会话腾位置；正在跑任务的绝不能杀。
function evictIdlePiRuntimes(keepKey) {
  if (piRuntimes.size < PI_MAX_RUNTIMES) return
  // 只淘汰空闲的后台进程，按最久未使用优先；正在生成任务的绝不能杀。
  const candidates = [...piRuntimes.entries()]
    .filter(([key, runtime]) => key !== keepKey && key !== piActiveKey && !runtime.inFlightPrompt)
    .sort((left, right) => Number(left[1].lastUsedAt || 0) - Number(right[1].lastUsedAt || 0))
  for (const [key, runtime] of candidates) {
    if (piRuntimes.size < PI_MAX_RUNTIMES) return
    piRuntimes.delete(key)
    // 主动淘汰不会走子进程的 exit 分支，这里显式通知渲染层：该会话已无进程，
    // 否则左侧列表会一直卡在“运行中”。
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pi:exit', { code: null, sessionKey: key, evicted: true })
    void stopPiRuntime(runtime)
  }
  if (piRuntimes.size >= PI_MAX_RUNTIMES) throw new Error(`最多同时保持 ${PI_MAX_RUNTIMES} 个会话进程，请等部分任务完成后再开新会话`)
}

async function startPiUnsafe(options = {}) {
  const managed = options.accessMode !== 'key'
  const executable = piExecutable()
  if (!fs.existsSync(executable)) throw new Error(`Pi 运行时不存在：${executable}`)
  const requestedSession = options.sessionPath && isInside(piSessionDir(), options.sessionPath) ? path.resolve(options.sessionPath) : ''
  const key = requestedSession || `anon:${crypto.randomUUID()}`
  const existing = piRuntimes.get(key)
  if (existing?.child && existing.child.exitCode === null && existing.child.signalCode === null && !options.force) {
    // 同会话复用现有进程：切换会话因此不再中止正在运行的任务。
    existing.lastUsedAt = Date.now()
    piActiveKey = key
    // 浏览器桥是所有进程共享的，这里只补登记该会话的工作区（幂等，不会轮换令牌）。
    try { await startBrowserBridge(existing.cwd) } catch {}
    return { ok: true, reused: true, cwd: existing.cwd, sessionDir: piSessionDir(), sessionPath: existing.key, permissionMode: existing.permissionMode }
  }
  // Pi 的 Bash 工具依赖 Git Bash；等待后台安装完成，避免先启动后误选系统 WSL bash.exe。
  if (process.platform === 'win32') {
    const shell = await startWindowsShellBootstrap().catch((error) => ({ status: 'manual', shellPath: '', error: error?.message || String(error) }))
    if (!shell?.shellPath && !existingBash()) console.warn(`[shell] Git Bash 不可用：${shell?.error || '请在设置中安装 Git for Windows'}`)
  }
  if (existing) {
    piRuntimes.delete(key)
    await stopPiRuntime(existing)
  }
  evictIdlePiRuntimes(key)
  let credential = ''
  let bridgeOrigin = ''
  if (managed) {
    if (!auth?.accessToken) throw new Error('登录状态已失效，请重新登录')
    const bridge = await gatewayBridge.start()
    credential = bridge.token
    bridgeOrigin = bridge.origin
  } else {
    const record = keyCache.get(String(options.keyId))
    credential = keyValue(record)
    if (!credential) throw new Error('所选密钥没有可用的 API Key，请刷新密钥列表后重试')
  }
  const agentDir = piAgentDir(); const sessionDir = piSessionDir()
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(modelConfig(options.models, { managed, bridgeOrigin }), null, 2), { mode: 0o600 })
  const selectedModel = (Array.isArray(options.models) ? options.models : []).find((model) => String(model?.id || model?.name || '') === String(options.model || '')) || options.models?.[0] || {}
  const selectedModelId = String(selectedModel?.modelId || selectedModel?.model_id || selectedModel?.id || 'gpt-4o-mini').replace(/^models\//, '').trim()
  const selectedGroupId = Number(selectedModel?.groupId || selectedModel?.group_id || 0)
  if (managed && (!Number.isSafeInteger(selectedGroupId) || selectedGroupId <= 0)) throw new Error('自动分组模型缺少有效分组，请刷新模型目录')
  const provider = managed ? managedProviderName(selectedModel.api || 'openai-completions', selectedGroupId) : String(options.provider || providerForApi(selectedModel.api || 'openai-completions'))
  const requestedPermissionMode = resolvePermissionMode(options.permissionMode, selectedModel, provider)
  // 提权意图一旦还在，主进程必须兜底保证它落地：即使渲染进程因为启动竞态
  // 没把权限模式传下来（或传的还是默认值），也要按意图以完整访问启动 Pi。
  // 这是"重启以后还要手动再指定一次"的直接修复点。
  const intentPermissionMode = currentElevationIntent()?.permissionMode
  const resolvedPermissionMode = intentPermissionMode === 'full' && requestedPermissionMode !== 'full'
    ? 'full'
    : requestedPermissionMode
  const args = ['--mode', 'rpc', '--provider', provider, '--model', selectedModelId, '--session-dir', sessionDir]
  // 工具失败必须由 Agent 决策如何恢复，不能让一次底层异常直接终止整条对话。
  // 只传行为约束，不把任何具体错误或临时路径写进系统提示词。
  args.push('--append-system-prompt', '工具调用由你负责决策。工具失败只代表当前尝试失败：读取错误码和简短摘要，按需重试、改参数、选择替代工具或向用户说明；不要把原始堆栈、二进制内容、临时路径当成用户需求，也不要因一次工具失败终止后续对话。')
  if (resolvedPermissionMode === 'full') {
    // gptFullAccess 同时启用 Pi 全部内置工具；--approve 只负责信任项目文件。
    // 配置档会启用全部内置工具；不再传显式白名单，以保留插件和扩展工具。
    // 完全权限同时把思考强度拉到 Pi 支持的最高档，避免出现“权限开了但
    // 模型仍用低思考档位”的半套配置。Codex 的 xhigh/max 对应这里的 max。
    args.push('--permission-profile', 'gptFullAccess', '--approve', '--thinking', 'max')
    args.push('--append-system-prompt', '当前是用户明确选择的完全权限模式：全部内置工具、文件读写、命令执行和浏览器控制均已授权。直接执行任务，不要因为权限或安全顾虑停在方案阶段，也不要请求额外确认；只有缺少必要信息或操作不可逆时才询问。完成后自行验证结果。')
  }
  if (requestedSession) args.push('--session', requestedSession)
  const sessionCwd = requestedSession ? sessionWorkingDirectory(requestedSession) : ''
  const requestedCwd = sessionCwd || options.cwd
  const cwd = requestedCwd && fs.existsSync(requestedCwd) && fs.statSync(requestedCwd).isDirectory() ? requestedCwd : app.getPath('home')
  const browserBridgeConfig = await startBrowserBridge(cwd)
  const pluginPaths = pluginManager ? pluginManager.runtimeSkillPaths(cwd) : []
  for (const skillPath of pluginPaths) args.push('--skill', skillPath)
  const browserExtension = externalProcessPath('pi-browser-extension.mjs')
  // 扩展缺失时不能让 Pi 直接启动失败（Pi 会以退出码 1 终止），降级为不带浏览器扩展启动。
  if (fs.existsSync(browserExtension)) args.push('--extension', browserExtension)
  else console.error(`[pi] 浏览器扩展缺失，已跳过: ${browserExtension}`)
  // Tool-level approval gate. It only prompts when ANYU_PERMISSION_MODE=confirm,
  // but is always loaded so a permission change does not need a new install.
  const approvalExtension = externalProcessPath('pi-approval-gate.mjs')
  if (fs.existsSync(approvalExtension)) args.push('--extension', approvalExtension)
  else console.error(`[pi] 审批扩展缺失，已跳过: ${approvalExtension}`)
  const runtime = { key, buffer: '', pending: new Map(), counter: 0, child: null, inFlightPrompt: false, lastUsedAt: Date.now(), lastEventAt: 0, cwd, permissionMode: resolvedPermissionMode }
  let startupStderr = ''
  let stateResponse = null
  try {
  runtime.child = spawn(executable, args, {
    cwd,
    env: { ...dependencyEnvironment(shellEnvironment(process.env)), PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, ANYU_API_KEY: credential, ANYU_PERMISSION_PROFILE: resolvedPermissionMode === 'full' ? 'gptFullAccess' : '', ANYU_PERMISSION_MODE: resolvedPermissionMode, PI_SKIP_VERSION_CHECK: '1', LETA_BROWSER_BRIDGE_PORT: String(browserBridgeConfig.port), LETA_BROWSER_BRIDGE_TOKEN: browserBridgeConfig.token },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const child = runtime.child
  child.stdout.on('data', (chunk) => parsePiLines(runtime, chunk))
  child.stderr.on('data', (data) => { const message = data.toString(); startupStderr = `${startupStderr}${message}`.slice(-4000); console.error(`[pi] ${message}`); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pi:stderr', message) })
  child.once('error', (error) => {
    if (runtime.child === child) {
      runtime.child = null
      for (const id of [...runtime.pending.keys()]) settlePiRequest(runtime, id, error)
    }
  })
  child.once('exit', (code) => {
    if (runtime.child === child) {
      runtime.child = null
      try { agentSessionService?.runtimeExited(runtime.key, code) } catch (error) { console.error('[agent-session]', error?.message || error) }
      // 带上 Pi 的最后一段 stderr：否则用户只看到"已退出 (1)"，无法定位是扩展、模型还是网络问题。
      const detail = startupStderr.trim()
      const error = new Error(`Pi Agent 已退出 (${code ?? 'unknown'})${detail ? `: ${detail.slice(-800)}` : ''}`)
      for (const id of [...runtime.pending.keys()]) settlePiRequest(runtime, id, error)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pi:exit', { code, sessionKey: runtime.key })
    }
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Pi Agent 启动超时${startupStderr.trim() ? `: ${startupStderr.trim().slice(-1200)}` : ''}`)), 12000)
    const fail = (error) => { clearTimeout(timer); reject(error) }
    child.once('error', fail)
    child.once('exit', (code, signal) => { fail(new Error(`Pi Agent 启动失败 (${code ?? signal ?? 'unknown'})${startupStderr.trim() ? `: ${startupStderr.trim().slice(-1200)}` : ''}`)) })
    const check = () => {
      if (child.exitCode !== null) { fail(new Error(`Pi Agent 启动失败 (${child.exitCode})${startupStderr.trim() ? `: ${startupStderr.trim().slice(-1200)}` : ''}`)); return }
      if (runtime.child === child) { clearTimeout(timer); resolve() } else setTimeout(check, 60)
    }
    setTimeout(check, 120)
  })
  stateResponse = await sendPi({ type: 'get_state' }, runtime)
  const skillLaunch = { executable, cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ANYU_API_KEY: credential, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', ANYU_PERMISSION_MODE: '', ANYU_PERMISSION_PROFILE: '', LETA_BROWSER_BRIDGE_TOKEN: '', LETA_BROWSER_BRIDGE_PORT: '' } }
  runtime.skillLaunch = skillLaunch
  piSkillLaunch = skillLaunch
  } catch (error) {
    // 启动失败只清理这个会话自己的进程，不能连坐正在跑任务的后台会话。
    await stopPiRuntime(runtime)
    throw error
  }
  piRuntimes.set(key, runtime)
  // 匿名键对齐：新会话没有预建文件，Pi 启动后才有真实 sessionFile，
  // 把运行时重挂到真实路径上，后续事件才能和渲染层的 sessionPath 对上。
  let finalKey = key
  try {
    const actualSession = String(stateResponse?.data?.sessionFile || '').trim()
    if (!requestedSession && actualSession && isInside(piSessionDir(), actualSession)) {
      finalKey = path.resolve(actualSession)
      const clash = piRuntimes.get(finalKey)
      if (clash && clash !== runtime) await stopPiRuntime(clash)
      piRuntimes.delete(key)
      runtime.key = finalKey
      piRuntimes.set(finalKey, runtime)
    }
  } catch (error) {
    // 这一段在 try/catch 之外、piRuntimes.set 之后：以前这里抛出（例如引用了
    // 未声明的变量）会留下"已登记却用不了"的运行时——Pi 子进程泄漏成孤儿，
    // 下次启动还被当成可复用而直接返回，表现为反复"未连接"。失败必须清理干净。
    piRuntimes.delete(key)
    piRuntimes.delete(finalKey)
    await stopPiRuntime(runtime)
    throw error
  }
  // 保存可复用的启动参数，权限档位切换时由主进程重启同一会话。
  // force 和恢复标记只属于当前调用，不能带进下一次重启。
  const { force: _force, __sessionRecoveryAttempt: _recoveryAttempt, ...startOptions } = options
  runtime.startOptions = {
    ...startOptions,
    sessionPath: finalKey,
    permissionMode: resolvedPermissionMode,
    force: false,
    __sessionRecoveryAttempt: undefined,
  }
  piActiveKey = finalKey
  return { ok: true, cwd, sessionDir, permissionMode: resolvedPermissionMode, sessionPath: finalKey, reused: false }
}

function isSessionStartConflict(error, sessionPath = '') {
  const message = String(error?.message || error || '')
  if (!/EEXIST|file already exists/i.test(message)) return false
  const requested = path.basename(String(sessionPath || '').trim())
  return !requested || message.includes(requested) || /session/i.test(message)
}

// Pi 使用独占方式打开会话文件。旧版客户端崩溃、重复启动或外部 Pi 进程
// 可能让旧路径暂时无法再次打开；不能把这个底层错误写进同一条对话上下文。
// 自动从最后一个稳定快照分叉到全新路径，保留历史并让本轮消息继续执行。
async function startPiWithRecovery(options = {}) {
  try {
    return await startPiUnsafe(options)
  } catch (error) {
    if (options.__sessionRecoveryAttempt || !isSessionStartConflict(error, options.sessionPath)) throw error
    if (options.sessionPath && fs.existsSync(options.sessionPath)) {
      const recovered = forkPiSession({ sessionPath: options.sessionPath })
      return { ...await startPiUnsafe({ ...options, sessionPath: recovered.path, __sessionRecoveryAttempt: true }), recoveredFrom: path.resolve(options.sessionPath) }
    }
    // Pi may report an EEXIST for an internally generated session path even
    // when the caller started anonymously. Materialize a fresh unique session
    // and retry once rather than failing a business skill before collection.
    const recovered = createPiSession({ cwd: options.cwd })
    return { ...await startPiUnsafe({ ...options, sessionPath: recovered.path, __sessionRecoveryAttempt: true }), recoveredFrom: '' }
  }
}

async function analyzeLocalSkill(prompt, images = [], onProgress, modelOverride = null, sessionKey = '') {
  const runtime = sessionKey ? resolvePiRuntime(sessionKey) : activePiRuntime()
  const launch = runtime?.skillLaunch || piSkillLaunch
  if (!runtime?.child || !launch) throw new Error('请先选择模型并启动当前 Agent 会话')
  const response = await sendPi({ type: 'get_state' }, runtime)
  const state = response.data || response
  const provider = String(modelOverride?.provider || state?.model?.provider || '').trim()
  const model = String(modelOverride?.model || state?.model?.id || '').trim()
  if (!provider || !model) throw new Error('当前 Agent 没有可用的模型')
  // 不再按目录元数据预判“这个模型能不能识图”：目录标注经常滞后（比如 qwen 系列的新模型），
  // 误判会把用户明确指定的模型直接挡死。请求照发，能不能识别由模型返回的结果决定——
  // 真不支持时 API 会报错，把错误原样给用户即可。
  const controller = new AbortController()
  analysisControllers.add(controller)
  try { return await analyzeWithPi({ ...launch, provider, model, prompt, images, signal: controller.signal, onProgress }) }
  finally { analysisControllers.delete(controller) }
}

async function autoEditAnalyze(payload = {}) {
  const runtime = activePiRuntime()
  const launch = runtime?.skillLaunch || piSkillLaunch
  if (!runtime?.child || !launch) throw new Error('请先选择模型并启动当前 Agent 会话')
  const response = await sendPi({ type: 'get_state' }, runtime)
  const current = response.data || response
  const provider = String(payload.model?.provider || current?.model?.provider || '').trim()
  const model = String(payload.model?.model || payload.model?.id || current?.model?.id || '').trim()
  if (!provider || !model) throw new Error('当前 Agent 没有可用的模型')
  const images = (Array.isArray(payload.thumbnails) ? payload.thumbnails : []).map((item) => ({ type: 'image', data: item.data, mimeType: item.mimeType || 'image/jpeg' })).filter((item) => item.data)
  const prompt = String(payload.prompt || '').slice(0, 50000)
  const systemPrompt = '你是专业短视频导演、编剧和剪辑师。你必须先理解每个素材在讲什么，再设计成片，不得机械拼接。只根据素材清单、视频关键帧、时间点和转录内容输出严格 JSON，不要 Markdown。先在 JSON 的 creativeBrief 中写清主题、目标受众、核心卖点、叙事弧线、节奏和设计风格；在 script 中写出开场钩子、镜头顺序、每镜头画面意图、字幕/旁白文案和转场理由；然后给出可执行时间线。JSON schema: {"version":3,"creativeBrief":{"theme":"","audience":"","hook":"","sellingPoints":[],"storyArc":"","visualStyle":"","pacing":""},"script":[{"beat":"hook|problem|proof|benefit|cta","assetId":"a001","sourceStart":0,"sourceEnd":3,"visualIntent":"","copy":"","voiceover":"","transitionReason":""}],"aspect":"9:16|16:9|1:1","fps":30,"clips":[{"assetId":"a001","start":0,"end":3,"speed":1,"transition":"fade","reason":"","visualIntent":""}],"overlays":[{"assetId":"a002","start":0,"end":2,"position":"bottom-right","scale":0.24,"opacity":0.9}],"audio":[{"assetId":"a003","role":"music","start":0,"end":10,"volume":0.16}],"subtitles":[{"start":0,"end":2,"text":"字幕","beat":"hook"}],"voiceoverText":"完整旁白","readSubtitles":true,"notes":[]}. 必须逐段说明视频内容，至少使用全部可视素材中的有意义片段；只有一个素材时如实使用一个。必须生成与画面同步、具有信息密度的中文字幕，不能用空泛的“很好看/很精彩”。可靠转录可作为逐字字幕；若转录不可用，只能基于关键帧写内容字幕，不得伪称逐字识别。优先保留原声，音乐只做低音量铺底；完全无音轨时生成与脚本一致的中文旁白，不能输出静音片。'
  const text = await analyzeWithPi({ ...launch, provider, model, prompt, images, systemPrompt })
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const first = raw.indexOf('{'); const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) raw = raw.slice(first, last + 1)
  let plan
  try { plan = JSON.parse(raw) } catch { throw new Error('AI 剪辑计划不是合法 JSON，请重试当前任务') }
  if (!plan || !Array.isArray(plan.clips) || !plan.clips.length) throw new Error('AI 没有生成有效剪辑片段')
  if (!plan.creativeBrief || !String(plan.creativeBrief.theme || '').trim() || !Array.isArray(plan.script) || !plan.script.length) throw new Error('AI 没有完成素材理解和脚本设计，请重试当前任务')
  plan.analysisPath = payload.analysisPath
  plan.voiceoverText = String(plan.voiceoverText || '').slice(0, 6000)
  return plan
}

async function startPi(options = {}) {
  const execute = async () => {
    // 启动失败只影响这一个会话（startPiUnsafe 已自行清理新起的进程），
    // 不能再调用 stopPi() 把其它会话正在跑的任务一起杀掉。
    return startPiWithRecovery(options)
  }
  const run = piStartLock.then(execute, execute)
  piStartLock = run.catch(() => {})
  return run
}

async function setAgentPermissionMode(mode) {
  const normalized = writeAgentPermissionMode(mode)
  let restarted = 0
  const activeKey = piActiveKey
  const runtimes = [...piRuntimes.values()]
  // 先重启当前前台会话，保证设置窗口返回后用户看到的就是新权限。
  runtimes.sort((left, right) => Number(right.key === activeKey) - Number(left.key === activeKey))
  for (const runtime of runtimes) {
    if (!runtime?.startOptions) continue
    const { force: _force, __sessionRecoveryAttempt: _recoveryAttempt, ...baseOptions } = runtime.startOptions
    await startPi({
      ...baseOptions,
      sessionPath: runtime.key,
      permissionMode: normalized,
      force: true,
      __sessionRecoveryAttempt: undefined,
    })
    restarted += 1
  }
  if (activeKey && piRuntimes.has(activeKey)) piActiveKey = activeKey
  return {
    ok: true,
    mode: normalized,
    restarted,
    activeMode: activePiRuntime()?.permissionMode || normalized,
    systemAccess: systemAccessState(),
  }
}

// 会话列表缓存：切换会话时 listPiSessions 会被反复调用，而它原本要
// 逐个 readFileSync 读完整条 .jsonl。这里用“只 stat 不读内容”的指纹做
// 失效判断——文件大小/修改时间/创建时间变了才真正重读，命中时直接返回
// 上一次解析好的列表，把切换会话时的一次磁盘风暴降为一次目录扫描。
let piSessionsCache = { signature: '', sessions: [] }
function statSignature(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return `${Math.round(stat.mtimeMs)}|${stat.size}|${Math.round(stat.birthtimeMs || stat.ctimeMs || 0)}`
  } catch { return 'missing' }
}
function listPiSessions(options = {}) {
  const force = options?.force === true
  const directory = piSessionDir()
  if (!fs.existsSync(directory)) return []
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  visit(directory)
  files.sort()
  let mediaNames = []
  let optimisticNames = []
  try {
    const names = fs.readdirSync(path.join(piMediaDir(), 'sessions'))
    mediaNames = names.filter((name) => /^[a-f0-9]{64}\.json$/i.test(name))
    optimisticNames = names.filter((name) => /^[a-f0-9]{64}\.optimistic\.json$/i.test(name))
  } catch {}
  // 指纹只用 stat / 目录枚举，不做任何文件内容读取，成本可忽略。
  const signature = [
    files.length,
    files.map((file) => `${path.resolve(file)}:${statSignature(file)}`).join(';'),
    statSignature(piSessionMetaFile()),
    statSignature(piMediaIndexFile()),
    mediaNames.length,
    mediaNames.join(','),
    optimisticNames.length,
    optimisticNames.map((name) => `${name}:${statSignature(path.join(piMediaDir(), 'sessions', name))}`).join(';')
  ].join('#')
  // 命中缓存时返回副本：渲染层会就地改 title/pinned，不能污染缓存里的对象。
  if (!force && signature && signature === piSessionsCache.signature) return piSessionsCache.sessions.map((item) => ({ ...item }))
  const sessionMeta = readPiSessionMeta()
  const sessions = files.map((file) => {
    let title = '新会话'; let modified = 0; let firstMessageAt = 0; let entryCreatedAt = 0; let fileBirthtime = 0; let cwd = ''; let hasNamedTitle = false
    try {
      const stat = fs.statSync(file)
      modified = stat.mtimeMs
      fileBirthtime = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        let entry; try { entry = JSON.parse(line) } catch { continue }
        const messageTime = entry.message && (entry.message.timestamp || entry.message.createdAt || entry.message.time)
        const entryTime = timestampValue(entry.timestamp || entry.createdAt || entry.time || messageTime)
        if (entry.type === 'session') { if (entry.name) { title = entry.name; hasNamedTitle = true }; cwd = String(entry.cwd || ''); if (!entryCreatedAt && entryTime) entryCreatedAt = entryTime }
        const message = entry.message
        if (message?.role === 'user') {
          if (!firstMessageAt && entryTime) firstMessageAt = entryTime
          const content = Array.isArray(message.content) ? message.content.find((part) => part.type === 'text')?.text : message.content
          if (!hasNamedTitle && content) title = String(content).replace(/\s+/g, ' ').slice(0, 48)
        }
      }
    } catch {}
    const metadata = sessionMeta[sessionMetaKey(file)] || {}
    firstMessageAt = firstMessageAt || entryCreatedAt || fileBirthtime || modified
    return { path: file, title: String(metadata.title || title), createdAt: Number(firstMessageAt), firstMessageAt: Number(firstMessageAt), modified, cwd, pinned: Boolean(metadata.pinned) }
  })
  // A media-only first message is intentionally kept in a sidecar until Pi
  // receives a normal assistant turn. Include that virtual session in history
  // so it behaves like every other conversation immediately.
  const mediaIndex = readMediaIndex()
  for (const name of mediaNames) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try { mediaIndex[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(piMediaDir(), 'sessions', name), 'utf8')) } catch {}
  }
  const mediaByPath = new Map(Object.values(mediaIndex).map((record) => [path.resolve(String(record?.sessionPath || '')), record]))
  // Pi 首条 user 事件写入前，渲染层会先把消息保存到 optimistic sidecar。
  // 侧栏必须把这类会话当作真实会话列出，否则用户切换会话时会暂时看不到刚发送的对话。
  const optimisticRecords = []
  for (const name of optimisticNames) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(piMediaDir(), 'sessions', name), 'utf8'))
      const sessionPath = String(record?.sessionPath || '')
      if (sessionPath && isInside(piSessionDir(), sessionPath)) optimisticRecords.push(record)
    } catch {}
  }
  const optimisticByPath = new Map(optimisticRecords.map((record) => [path.resolve(String(record.sessionPath || '')), record]))
  for (const item of sessions) {
    const sessionKey = path.resolve(item.path)
    const record = mediaByPath.get(sessionKey)
    const optimistic = optimisticByPath.get(sessionKey)
    const firstUser = (record?.messages || []).find((message) => message?.role === 'user')
    const optimisticUser = optimistic?.message?.role === 'user' ? optimistic.message : null
    if (item.title === '新会话' && (firstUser?.content || optimisticUser?.content)) {
      item.title = String(firstUser?.content || optimisticUser.content).replace(/\s+/g, ' ').slice(0, 48)
    }
    if (record?.createdAt || record?.modified || optimistic?.message?.createdAt || optimistic?.modified) {
      item.createdAt = item.firstMessageAt = timestampValue(firstUser?.createdAt || optimisticUser?.createdAt || record?.createdAt || optimistic?.modified || record?.modified)
    }
    if (!item.cwd && optimistic?.cwd) item.cwd = String(optimistic.cwd)
  }
  const known = new Set(sessions.map((item) => path.resolve(item.path)))
  for (const record of Object.values(mediaIndex)) {
    const sessionPath = String(record?.sessionPath || '')
    if (!sessionPath || !isInside(piSessionDir(), sessionPath) || known.has(path.resolve(sessionPath))) continue
    const firstUser = (record.messages || []).find((message) => message?.role === 'user')
    const metadata = sessionMeta[sessionMetaKey(sessionPath)] || {}
    const createdAt = timestampValue(record.createdAt || record.modified)
    sessions.push({ path: sessionPath, title: String(metadata.title || firstUser?.content || '新会话').replace(/\s+/g, ' ').slice(0, 48) || '新会话', createdAt, firstMessageAt: createdAt, modified: createdAt, cwd: String(record.cwd || ''), pinned: Boolean(metadata.pinned) })
    known.add(path.resolve(sessionPath))
  }
  // 乐观消息侧车可能先于会话文件存在；补成虚拟会话，待 Pi 正式写入后自然合并。
  for (const record of optimisticRecords) {
    const sessionPath = String(record?.sessionPath || '')
    if (!sessionPath || !isInside(piSessionDir(), sessionPath) || known.has(path.resolve(sessionPath))) continue
    const message = record?.message && typeof record.message === 'object' ? record.message : {}
    const metadata = sessionMeta[sessionMetaKey(sessionPath)] || {}
    const createdAt = timestampValue(message.createdAt || record.modified)
    sessions.push({
      path: sessionPath,
      title: String(metadata.title || message.content || '新会话').replace(/\s+/g, ' ').slice(0, 48) || '新会话',
      createdAt,
      firstMessageAt: createdAt,
      modified: Number(record.modified || createdAt),
      cwd: String(record.cwd || sessionWorkingDirectory(sessionPath) || ''),
      pinned: Boolean(metadata.pinned)
    })
    known.add(path.resolve(sessionPath))
  }
  sessions.sort((a, b) => Number(b.createdAt || b.firstMessageAt || b.modified || 0) - Number(a.createdAt || a.firstMessageAt || b.modified || 0) || String(a.path).localeCompare(String(b.path)))
  piSessionsCache = { signature, sessions: sessions.map((item) => ({ ...item })) }
  return sessions
}

function buildApiUrl(route) {
  const value = String(route || '')
  if (!value.startsWith('/')) throw new Error('Anyu API 路径必须使用相对路径')
  return `${MANAGEMENT_BASE}${value}`
}

// 使用同一套超时与取消逻辑，避免不同请求类型出现不一致的网络错误。
async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
  const externalSignal = init.signal
  const abortExternal = () => controller.abort(externalSignal.reason || new Error('request aborted'))
  if (externalSignal) {
    if (externalSignal.aborted) abortExternal()
    else externalSignal.addEventListener('abort', abortExternal, { once: true })
  }
  try {
    const parsedUrl = new URL(url)
    const dispatcher = parsedUrl.hostname.toLowerCase() === OFFICIAL_API_HOST ? officialDispatcher : undefined
    const headers = new Headers(init.headers || {})
    // Renderer-proxied requests carry Chromium's User-Agent; the backend binds
    // sessions to IP + UA, so every desktop request must use the same UA or the
    // token issued at login is rejected by the next main-process request.
    headers.set('User-Agent', APP_USER_AGENT)
    return await fetch(url, { ...init, headers, signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) })
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', abortExternal)
  }
}

function formatNetworkError(error, url, area = '请求') {
  const reason = String(error?.cause?.code || error?.cause?.message || error?.code || error?.message || '').toLowerCase()
  if (error?.name === 'AbortError' || reason.includes('timeout') || reason.includes('timed out')) {
    return new Error(`${area}连接正式服务器超时（${REQUEST_TIMEOUT_MS / 1000} 秒）：${url}。请检查网络、DNS 或代理设置后重试。`)
  }
  if (reason.includes('enotfound') || reason.includes('dns') || reason.includes('getaddrinfo')) {
    return new Error(`${area}无法解析正式服务器域名：${url}。请检查 DNS 设置后重试。`)
  }
  if (reason.includes('certificate') || reason.includes('tls') || reason.includes('ssl')) {
    return new Error(`${area}与正式服务器的 HTTPS 连接失败：${url}。请检查系统时间和证书拦截软件。`)
  }
  return new Error(`${area}无法连接正式服务器：${url}。请检查网络、DNS 或代理设置后重试。`)
}

async function requestApi(route, options = {}, retry = true) {
  const url = buildApiUrl(route)
  const headers = { Accept: 'application/json', ...(options.headers || {}) }
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const catalogRequest = /^\/(?:integrations\/anyu-agent\/catalog|groups\/available)(?:\?|$)/i.test(route)
  let response
  try {
    response = await fetchWithTimeout(url, {
      method: options.method || 'GET', headers,
      body: options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : JSON.stringify(options.body),
      signal: options.signal
    }, catalogRequest ? 12000 : REQUEST_TIMEOUT_MS)
  } catch (error) {
    throw formatNetworkError(error, url, catalogRequest ? '模型目录' : '登录/账户')
  }
  let payload = null
  const text = await response.text()
  try { payload = text ? JSON.parse(text) : null } catch { payload = { message: text } }
  if (response.status === 401 && retry && auth?.refreshToken && !route.includes('/auth/')) {
    const refreshed = await refreshAuthAccessToken().catch(() => '')
    if (refreshed) {
      return requestApi(route, options, false)
    }
    clearAuth()
  }
  if (!response.ok || (payload && payload.code && payload.code !== 0)) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status})`)
    error.status = response.status; error.code = payload?.code
    throw error
  }
  const result = payload && payload.code === 0 ? payload.data : payload
  if (/^\/keys(?:[?\/]|$)/i.test(route)) rememberKeys(result)
  return result
}

// 流式文本请求：@生图 的规划阶段要把模型真实输出逐段回传（“吐字”），
// 取代过去固化展示的步骤清单。只解析 OpenAI chat/completions 与 responses 两种 SSE 增量。
async function streamApi(route, options = {}, onDelta) {
  const url = buildApiUrl(route)
  const headers = { Accept: 'text/event-stream', ...(options.headers || {}) }
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetchWithTimeout(url, {
      method: options.method || 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify({ ...(options.body || {}), stream: true })
    }, REQUEST_TIMEOUT_MS)
  } catch (error) {
    throw formatNetworkError(error, url, '流式请求')
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    let message = `Request failed (${response.status})`
    try { message = JSON.parse(text)?.message || message } catch { /* 保留默认错误 */ }
    throw new Error(message)
  }
  const consumeDelta = (payload) => String(
    payload?.choices?.[0]?.delta?.content
    || payload?.choices?.[0]?.message?.content
    || (payload?.type === 'response.output_text.delta' ? payload?.delta : '')
    || ''
  )
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', full = ''
  const consumeLine = (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    let parsed
    try { parsed = JSON.parse(data) } catch { return }
    const delta = consumeDelta(parsed)
    if (!delta) return
    full += delta
    onDelta?.(delta)
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      consumeLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
    }
  }
  consumeLine(buffer)
  return full
}

function buildAiHubUrl(route) {
  const value = String(route || '')
  if (!value.startsWith('/')) throw new Error('AiHub 路径必须使用 / 下的相对路径')
  return `${AIHUB_BASE}${value}`
}

function aiHubAccessToken() {
  return String(auth?.aiHubAccessToken || AIHUB_ENV_TOKEN || '').trim()
}

function parseAiHubPayload(payload, status) {
  if (payload && payload.success === false) {
    const error = new Error(payload.message || `AiHub 请求失败 (HTTP ${status})`)
    error.status = status; error.code = payload.code
    throw error
  }
  if (payload && payload.success === true && Object.prototype.hasOwnProperty.call(payload, 'result')) return payload.result
  return payload
}

// AiHub 遵循 Jeecg 的 X-Access-Token 认证，和 9090 的 Bearer JWT 分开处理。
async function requestAiHub(route, options = {}) {
  const url = buildAiHubUrl(route)
  const headers = { Accept: 'application/json', ...(options.headers || {}) }
  const token = aiHubAccessToken()
  if (token) {
    headers['X-Access-Token'] = token
    headers.Authorization = `Bearer ${token}`
  }
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  let response
  try {
    response = await fetchWithTimeout(url, {
      method: options.method || 'GET', headers,
      body: options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : JSON.stringify(options.body),
      signal: options.signal
    }, REQUEST_TIMEOUT_MS)
  } catch (error) {
    throw formatNetworkError(error, url, 'AiHub 请求')
  }
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = { message: text } }
  if (!response.ok) {
    const message = response.status === 401
      ? '本机 AiHub/Jeecg 未登录 (401)。当前插件只提供技能入口，抓取仍由 8080 服务转发到本机 Worker；AnyuAgent 和淘宝登录不能代替 AiHub 登录。请配置有效的 ANYU_AIHUB_TOKEN 后重启客户端。'
      : payload?.message || payload?.error || `AiHub 请求失败 (HTTP ${response.status})`
    const error = new Error(message)
    error.status = response.status; error.code = payload?.code
    throw error
  }
  return parseAiHubPayload(payload, response.status)
}

async function requestAiHubMultipart(route, fields = {}, files = [], maxFileBytes = 16 * 1024 * 1024) {
  const boundary = `----AnyuAgent${crypto.randomBytes(12).toString('hex')}`
  const chunks = []
  const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value)))
  for (const [name, value] of Object.entries(fields || {})) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value ?? '')}\r\n`)
  }
  for (const file of Array.isArray(files) ? files : []) {
    if (!file?.field || typeof file.data !== 'string') continue
    const data = Buffer.from(file.data, 'base64')
    if (!data.length || data.length > maxFileBytes) continue
    const field = String(file.field).replace(/[^a-zA-Z0-9_.-]/g, '_')
    const filename = String(file.name || 'reference.png').replace(/["\\\r\n]/g, '_')
    const mime = String(file.mimeType || 'application/octet-stream').replace(/[\r\n]/g, '')
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`)
    push(data); push('\r\n')
  }
  push(`--${boundary}--\r\n`)
  return requestAiHub(route, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks)
  })
}

// Keep multipart assembly and media downloads in the main process so the
// renderer never needs to handle the Leta JWT or gateway credentials.
async function requestMultipart(route, fields = {}, files = [], retry = true, maxFileBytes = 16 * 1024 * 1024) {
  const boundary = `----AnyuAgent${crypto.randomBytes(12).toString('hex')}`
  const chunks = []
  const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value)))
  for (const [name, value] of Object.entries(fields || {})) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value ?? '')}\r\n`)
  }
  for (const file of Array.isArray(files) ? files : []) {
    if (!file?.field || typeof file.data !== 'string') continue
    let data
    try { data = Buffer.from(file.data, 'base64') } catch { continue }
    if (!data.length || data.length > maxFileBytes) continue
    const field = String(file.field).replace(/[^a-zA-Z0-9_.-]/g, '_')
    const filename = String(file.name || 'reference.png').replace(/["\\\r\n]/g, '_')
    const mime = String(file.mimeType || 'application/octet-stream').replace(/[\r\n]/g, '')
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`)
    push(data); push('\r\n')
  }
  push(`--${boundary}--\r\n`)
  const headers = { Accept: 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`
  let response
  try {
    response = await fetchWithTimeout(buildApiUrl(route), { method: 'POST', headers, body: Buffer.concat(chunks) })
  } catch (error) {
    throw formatNetworkError(error, buildApiUrl(route), '媒体请求')
  }
  const text = await response.text()
  let payload = null; try { payload = text ? JSON.parse(text) : null } catch { payload = { message: text } }
  if (response.status === 401 && retry && auth?.refreshToken) {
    const refreshed = await requestApi('/auth/refresh', { method: 'POST', body: { refresh_token: auth.refreshToken } }, false).catch(() => null)
    if (refreshed?.access_token) {
      saveAuth({ ...auth, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || auth.refreshToken })
      return requestMultipart(route, fields, files, false, maxFileBytes)
    }
    clearAuth()
  }
  if (!response.ok || (payload && payload.code && payload.code !== 0)) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status})`)
    error.status = response.status; error.code = payload?.code; throw error
  }
  return payload && payload.code === 0 ? payload.data : payload
}

async function publishPluginPackage(publication, options = {}) {
  const packagePath = String(publication?.filePath || '')
  if (!packagePath || !fs.existsSync(packagePath)) throw new Error('插件发布包不存在')
  const data = fs.readFileSync(packagePath)
  if (!data.length || data.length > MAX_PACKAGE_BYTES) throw new Error('插件包超过 64 MB 限制')
  const manifest = publication.manifest || {}
  const publisher = options.publisher && typeof options.publisher === 'object' ? options.publisher : { id: 'community', name: String(options.publisherName || '社区用户'), verified: false }
  const fields = {
    plugin_id: String(manifest.id || ''),
    version: String(manifest.version || ''),
    publisher_name: String(publisher.name || ''),
    visibility: options.visibility === 'private' ? 'private' : 'public',
    sha256: String(publication.sha256 || ''),
    manifest: JSON.stringify(manifest),
    metadata: JSON.stringify({ ...manifest, publisher, visibility: options.visibility === 'private' ? 'private' : 'public' })
  }
  return requestMultipart('/marketplace/plugins/publish', fields, [{ field: 'package', name: `${manifest.id || 'plugin'}-${manifest.version || 'latest'}.anyu-plugin.zip`, mimeType: 'application/zip', data: data.toString('base64') }], true, MAX_PACKAGE_BYTES)
}

async function requestBinary(route, retry = true) {
  const headers = { Accept: '*/*' }
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`
  let response
  try {
    response = await fetchWithTimeout(buildApiUrl(route), { headers })
  } catch (error) {
    throw formatNetworkError(error, buildApiUrl(route), '媒体下载')
  }
  if (response.status === 401 && retry && auth?.refreshToken) {
    const refreshed = await requestApi('/auth/refresh', { method: 'POST', body: { refresh_token: auth.refreshToken } }, false).catch(() => null)
    if (refreshed?.access_token) {
      saveAuth({ ...auth, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || auth.refreshToken })
      return requestBinary(route, false)
    }
    clearAuth()
  }
  if (!response.ok) throw new Error(`媒体结果不可用 (HTTP ${response.status})`)
  const data = Buffer.from(await response.arrayBuffer())
  let mimeType = response.headers.get('content-type') || 'application/octet-stream'
  if (!/^image\//i.test(mimeType) && !/^video\//i.test(mimeType)) {
    if (data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp') mimeType = 'video/mp4'
    else if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) mimeType = 'video/webm'
    else if (data.length >= 8 && data.toString('ascii', 1, 4) === 'PNG') mimeType = 'image/png'
    else if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) mimeType = 'image/jpeg'
  }
  return { data: data.toString('base64'), mimeType }
}

async function listKeyModels(keyId) {
  const record = keyCache.get(String(keyId))
  const apiKey = keyValue(record)
  if (!apiKey) throw new Error('所选密钥没有可用的 API Key，请刷新密钥列表后重试')
  // The user-authenticated route is protocol-aware and is the source of truth
  // for Anthropic/Gemini/vendor-specific keys. The gateway /v1/models fallback
  // is retained for OpenAI-compatible keys and older Leta deployments.
  for (const route of [`/keys/${keyId}/models?role=chat`, `/codex/keys/${keyId}/models?role=chat`]) {
    try {
      const result = await requestApi(route)
      const entries = result?.items || result?.models || result?.data || (Array.isArray(result) ? result : [])
      if (Array.isArray(entries) && entries.length) return result
    } catch {}
  }
  const modelsUrl = `${GATEWAY_BASE}/v1/models`
  let response
  try {
    response = await fetchWithTimeout(modelsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }
    })
  } catch (error) {
    throw formatNetworkError(error, modelsUrl, '模型目录')
  }
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = { message: text } }
  if (!response.ok) {
    const fallback = record?.models || record?.model_list || record?.available_models
    if (Array.isArray(fallback) && fallback.length) return { items: fallback }
    const protocol = canonicalApi(record?.api || record?.protocol || record?.provider, 'openai-completions')
    throw new Error(`${protocol === 'anthropic-messages' ? 'Anthropic' : protocol === 'google-generative-ai' ? 'Gemini' : '当前协议'} 密钥模型目录不可用 (HTTP ${response.status})，请在 Leta 中确认该密钥已绑定模型`)
  }
  return payload && payload.code === 0 ? payload.data : payload
}

async function login(body) {
  const data = await requestApi('/auth/login', { method: 'POST', body }, false)
  if (data?.requires_2fa) return data
  saveAuth({ accessToken: data.access_token, refreshToken: data.refresh_token || '', user: data.user || null })
  return data
}
async function login2fa(body) {
  const data = await requestApi('/auth/login/2fa', { method: 'POST', body }, false)
  saveAuth({ accessToken: data.access_token, refreshToken: data.refresh_token || '', user: data.user || null })
  return data
}

// 桌面端复用网站的邮箱注册、验证码和密码找回接口。
async function register(body) {
  const data = await requestApi('/auth/register', { method: 'POST', body }, false)
  if (data?.access_token) saveAuth({ accessToken: data.access_token, refreshToken: data.refresh_token || '', user: data.user || null })
  return data
}

async function sendVerifyCode(body) {
  return requestApi('/auth/send-verify-code', { method: 'POST', body }, false)
}

async function forgotPassword(body) {
  return requestApi('/auth/forgot-password', { method: 'POST', body }, false)
}

async function resetPassword(body) {
  return requestApi('/auth/reset-password', { method: 'POST', body }, false)
}

async function publicSettings() {
  return requestApi('/settings/public', {}, false)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray
  const iconPath = path.join(__dirname, 'branding', process.platform === 'win32' ? 'leta.ico' : 'logo.png')
  tray = new Tray(iconPath)
  tray.setToolTip('AnyuAgent')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开对话', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出 AnyuAgent', click: () => { isQuitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => showMainWindow())
  return tray
}

let rendererProtocolRegistered = false

function windowShapeRects(width, height, radius = 14) {
  const rects = []
  const safeRadius = Math.max(1, Math.min(radius, Math.floor(Math.min(width, height) / 2)))
  for (let y = 0; y < safeRadius; y += 1) {
    const dy = safeRadius - y
    const inset = Math.round(safeRadius - Math.sqrt(Math.max(0, safeRadius * safeRadius - dy * dy)))
    if (width - inset * 2 > 0) rects.push({ x: inset, y, width: width - inset * 2, height: 1 })
  }
  if (height - safeRadius * 2 > 0) rects.push({ x: 0, y: safeRadius, width, height: height - safeRadius * 2 })
  for (let y = height - safeRadius; y < height; y += 1) {
    const dy = y - (height - safeRadius)
    const inset = Math.round(safeRadius - Math.sqrt(Math.max(0, safeRadius * safeRadius - dy * dy)))
    if (width - inset * 2 > 0) rects.push({ x: inset, y, width: width - inset * 2, height: 1 })
  }
  return rects
}

let windowShapeTimer = null

function applyRoundedWindowShape(win = mainWindow) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return
  try {
    if (win.isMaximized() || win.isFullScreen()) {
      win.setShape([])
      return
    }
    const [width, height] = win.getSize()
    win.setShape(windowShapeRects(width, height))
  } catch (error) {
    console.warn('[window] rounded shape unavailable:', error?.message || error)
  }
}

function scheduleRoundedWindowShape(win = mainWindow) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return
  if (windowShapeTimer) clearTimeout(windowShapeTimer)
  windowShapeTimer = setTimeout(() => {
    windowShapeTimer = null
    applyRoundedWindowShape(win)
  }, 80)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1050, minHeight: 700,
    title: 'AnyuAgent', backgroundColor: '#00000000',
    frame: false, transparent: true, roundedCorners: true, hasShadow: true,
    icon: path.join(__dirname, 'branding', 'leta.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  applyRoundedWindowShape(mainWindow)
  mainWindow.once('ready-to-show', () => applyRoundedWindowShape(mainWindow))
  mainWindow.on('resize', () => scheduleRoundedWindowShape(mainWindow))
  mainWindow.on('maximize', () => applyRoundedWindowShape(mainWindow))
  mainWindow.on('unmaximize', () => scheduleRoundedWindowShape(mainWindow))
  mainWindow.on('enter-full-screen', () => applyRoundedWindowShape(mainWindow))
  mainWindow.on('leave-full-screen', () => scheduleRoundedWindowShape(mainWindow))
  const fallbackRenderer = () => mainWindow?.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  const rendererUrl = String(process.env.ANYU_RENDERER_URL || '').trim()
  const rendererFile = String(process.env.ANYU_RENDERER_FILE || path.join(__dirname, 'renderer-vue', 'index.html')).trim()
  if (rendererUrl) {
    try {
      const parsedRendererUrl = new URL(rendererUrl)
      if (!['http:', 'https:'].includes(parsedRendererUrl.protocol)) throw new Error('ANYU_RENDERER_URL must use HTTP or HTTPS')
      void mainWindow.loadURL(parsedRendererUrl.href).catch((error) => {
        console.error('[startup] Vue renderer URL failed; loading the bundled renderer:', error?.message || error)
        void fallbackRenderer()
      })
    } catch (error) {
      console.error('[startup] Vue renderer URL is invalid; loading the bundled renderer:', error?.message || error)
      void fallbackRenderer()
    }
  } else if (fs.existsSync(rendererFile)) {
    if (!rendererProtocolRegistered) {
      protocol.handle(RENDERER_SCHEME, createRendererHandler({
        rendererFile: path.resolve(rendererFile),
        apiBase: GATEWAY_BASE,
        readAsset: (url, options) => require('electron').net.fetch(url, options),
        fetchApi: (url, options) => fetchWithTimeout(url, options, 120000)
      }))
      rendererProtocolRegistered = true
    }
    void mainWindow.loadURL(`${RENDERER_ORIGIN}/anyu-agent`).catch((error) => {
      console.error('[startup] Vue renderer file failed; loading the bundled renderer:', error?.message || error)
      void fallbackRenderer()
    })
  } else {
    void fallbackRenderer()
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' } })
  // The preload exposes the full desktop capability surface to whatever page
  // this window loads. Never let a link, redirect or window.location replace
  // the trusted renderer with remote content.
  const guardRendererNavigation = (event, url) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === RENDERER_SCHEME && parsed.host === 'desktop') return
    } catch { /* malformed URL is never trusted */ }
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  }
  mainWindow.webContents.on('will-navigate', guardRendererNavigation)
  mainWindow.webContents.on('will-redirect', guardRendererNavigation)
  mainWindow.on('resize', setBrowserBounds)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      hideMainWindow()
    }
  })
  mainWindow.on('closed', () => { browserView = null; mainWindow = null })
  createTray()
}

// 生图模型别名只在桌面端请求边界归一化，聊天和视频模型保持原值。
const IMAGE_MODEL_ALIASES = Object.freeze({
  'tt-image-2': 'gpt-image-2'
})

function requiredMediaSelection(payload, kind) {
  // 兼容旧版桌面端和网页端返回的 snake_case/对象字段，统一在 IPC 边界收敛。
  const groupValue = payload?.groupId ?? payload?.group_id ?? payload?.groupID ?? payload?.videoGroupId ?? payload?.video_group_id
  const modelValue = payload?.model ?? payload?.model_id ?? payload?.modelId ?? payload?.videoModel ?? payload?.video_model
  const groupId = Number(typeof groupValue === 'object' ? groupValue?.id ?? groupValue?.group_id ?? groupValue?.groupId : groupValue)
  const model = String(typeof modelValue === 'object' ? modelValue?.name ?? modelValue?.model ?? modelValue?.id : modelValue || '').trim()
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !model) {
    throw new Error(`请选择当前目录中的${kind === 'image' ? '图片' : '视频'}分组和模型`)
  }
  const normalizedModel = kind === 'image' ? (IMAGE_MODEL_ALIASES[model.toLowerCase()] || model) : model
  return { groupId, model: normalizedModel }
}

const LETA_AGENT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const LETA_AGENT_MAX_IMAGES = 50

function normalizeImageReferences(value) {
  const references = Array.isArray(value) ? value : []
  if (references.length > LETA_AGENT_MAX_IMAGES) throw new Error(`最多支持 ${LETA_AGENT_MAX_IMAGES} 张参考图`)
  let totalBytes = 0
  return references.map((file) => {
    const name = String(file?.name || '未命名图片').slice(0, 120)
    const data = String(file?.data || '').replace(/^data:[^;,]+;base64,/i, '').replace(/^base64,/i, '').replace(/\s+/g, '')
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error(`参考图“${name}”没有有效的图片数据`)
    const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
    if (!bytes) throw new Error(`参考图“${name}”是空文件`)
    if (bytes > 16 * 1024 * 1024) throw new Error(`参考图“${name}”超过 16 MB 上传限制，请压缩后重试`)
    totalBytes += bytes
    if (totalBytes > 64 * 1024 * 1024) throw new Error('所有参考图合计不能超过 64 MB，请减少图片或压缩后重试')
    const mimeType = String(file?.mimeType || 'image/png').split(';')[0].trim()
    if (!/^image\/(?:png|jpe?g|webp|gif)$/i.test(mimeType)) throw new Error(`参考图“${name}”格式不受支持`)
    return { ...file, name, data, mimeType, field: 'reference_images' }
  })
}

function validTaskId(value) {
  const taskId = String(value || '').trim()
  if (!taskId || taskId.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(taskId)) throw new Error('任务编号无效')
  return taskId
}

function validTmallUrl(value) {
  const raw = String(value || '').trim()
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error('请提供有效的淘宝或天猫商品链接') }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const allowed = hostname === 'taobao.com' || hostname.endsWith('.taobao.com') || hostname === 'tmall.com' || hostname.endsWith('.tmall.com')
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowed) throw new Error('评价分析只支持 https://taobao.com 或 https://tmall.com 商品链接')
  return parsed.href
}

function normalizeLetaImage(file) {
  if (!file || typeof file.data !== 'string') throw new Error('图片数据无效')
  const data = file.data.replace(/^data:[^;,]+;base64,/, '')
  let decoded
  try { decoded = Buffer.from(data, 'base64') } catch { throw new Error('图片数据无法解析') }
  if (!decoded.length || decoded.length > LETA_AGENT_MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 20 MB')
  return {
    field: 'file',
    name: String(file.name || 'reference.png').replace(/["\\\r\n]/g, '_').slice(0, 120),
    mimeType: String(file.mimeType || 'image/png').split(';')[0].trim() || 'image/png',
    data: decoded.toString('base64')
  }
}

function extractUploadResult(result) {
  const item = result && typeof result === 'object' ? result : {}
  const nested = item.data && typeof item.data === 'object' ? item.data : {}
  const url = [item.url, item.path, item.message, nested.url, nested.path, nested.message].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value)) || ''
  const id = String(item.id || item.assetId || item.asset_id || nested.id || nested.assetId || '').trim()
  if (!url && !id) throw new Error('图片上传成功但未返回可用资源地址')
  return { id, url }
}

async function letaAgentImageAnalysis(payload = {}) {
  const files = Array.isArray(payload.images) ? payload.images : []
  if (!files.length) throw new Error('请先上传至少一张图片')
  if (files.length > LETA_AGENT_MAX_IMAGES) throw new Error(`最多支持 ${LETA_AGENT_MAX_IMAGES} 张图片`)
  const record = requireBusinessPlugin(BUSINESS_PLUGIN_IDS.imageAnalysis)
  // 兼容市场压缩包和本地导入插件两种目录布局，避免提示词路径导致技能直接报错。
  const promptCandidates = ['skills/ai-image-analysis/prompts/analysis.md', 'prompts/analysis.md']
  const promptFile = promptCandidates.map((relative) => workspaceFile(record.installedPath, relative)).find((candidate) => fs.existsSync(candidate))
  if (!promptFile) throw new Error('已安装的测图技能缺少 prompts/analysis.md，请在插件市场更新或重新安装')
  if (!fs.existsSync(promptFile)) throw new Error('已安装的是旧版测图技能，请在插件市场更新或重新安装')
  workspaceFile(fs.realpathSync(record.installedPath), fs.realpathSync(promptFile))
  const instruction = await fs.promises.readFile(promptFile, 'utf8')
  const normalized = files.map(normalizeLetaImage)
  if (normalized.some((file) => !/^image\/(png|jpe?g|webp|gif)$/i.test(file.mimeType))) throw new Error('测图支持 PNG、JPEG、WebP 和 GIF 图片')
  const totalBytes = normalized.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0)
  if (totalBytes > 8 * 1024 * 1024) throw new Error('本次测图图片总大小不能超过 8 MB，请分批提交')
  const images = normalized.map((file) => ({ type: 'image', data: file.data, mimeType: file.mimeType }))
  const prompt = `${instruction}\n用户目标：${String(payload.prompt || '').trim().slice(0, 12000)}\n图片顺序：${normalized.map((file, index) => `${index + 1}. ${file.name}`).join('\n')}`
  const modelOverride = payload.model && typeof payload.model === 'object'
    ? { provider: payload.model.provider, model: payload.model.model || payload.model.id, input: payload.model.input }
    : null
  const text = await analyzeLocalSkill(prompt, images, undefined, modelOverride)
  return { status: 'OK', response: text, local: true, assets: normalized.map((file) => ({ name: file.name, url: `data:${file.mimeType};base64,${file.data}` })) }
}

function writeAnyuAgentArtifacts(payload = {}) {
  const cwd = path.resolve(String(payload.cwd || ''))
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('结果工作目录不存在')
  const files = Array.isArray(payload.files) ? payload.files : []
  if (!files.length || files.length > 8) throw new Error('结果文件数量无效')
  let totalBytes = 0
  const written = []
  for (const file of files) {
    const name = String(file?.name || '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:html?|json|csv|md|txt)$/i.test(name)) throw new Error('结果文件名无效')
    const content = String(file?.content || '')
    const data = Buffer.from(content, 'utf8')
    totalBytes += data.length
    if (totalBytes > 25 * 1024 * 1024) throw new Error('结果文件总大小不能超过 25 MB')
    const target = path.resolve(cwd, name)
    if (!isInside(cwd, target)) throw new Error('结果文件只能写入当前工作目录')
    fs.writeFileSync(target, data, { mode: 0o600 })
    written.push({ name, path: name, bytes: data.length })
  }
  return { ok: true, files: written }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  // 先读取上次提权流程留下的意图：被提权重启后，本次启动要据此恢复完整访问，
  // 并让界面直接反映"已生效"，而不是等用户再手动点一次。
  pendingElevationIntent = readElevationIntent(app.getPath('userData'))
  if (recoverPendingUpdate()) return
  loadAuth()
  // Session layer: stable conversation ids -> pi sessions, normalized events,
  // approvals and an append-only log. The renderer no longer talks to pi
  // directly for the desktop workspace.
  agentSessionService = new AgentSessionService({
    userDataDir: app.getPath('userData'),
    startRuntime: (options) => startPi(options),
    sendCommand: (command, runtime) => sendPi(command, runtime),
    respondUi: (response, runtime) => {
      if (!runtime?.child?.stdin?.writable) throw new Error('Agent 运行时未启动')
      runtime.child.stdin.write(`${JSON.stringify(response)}\n`)
      return Promise.resolve({ ok: true })
    },
    stopRuntime: (runtime) => stopPiRuntime(runtime),
    resolveRuntime: (key) => resolvePiRuntime(key),
    broadcast: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    },
    log: (...args) => console.log('[agent-session]', ...args)
  })
  pluginManager = new PluginManager(app.getPath('userData'))
  skillManager = new SkillManager(app.getPath('userData'))
  try {
    const bundledSkills = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'skills')
      : path.join(__dirname, 'skills')
    skillManager.ensureBundled(bundledSkills)
  } catch (error) { console.error('[skills]', error?.message || error) }
  // Bash 是 Pi 编程工具的基础环境。后台准备，不阻塞窗口首屏；已有 Git Bash 直接复用。
  setTimeout(() => { void startWindowsShellBootstrap() }, 1200)
  // 环境准备放到首屏之后后台执行，不阻塞窗口打开；中断后下次启动会继续检查。
  setTimeout(() => {
    for (const record of pluginManager?.state()?.installed || []) {
      if (record.dependencyStatus === 'pending' || (record.dependencies && record.dependencyStatus !== 'ready')) preparePluginDependencies(record)
    }
  }, 2500)
  localFeedback = new LocalFeedback({
    directory: path.join(app.getPath('userData'), 'local-skill-tasks', 'feedback'),
    plugin: () => requireBusinessPlugin(BUSINESS_PLUGIN_IDS.feedback),
    shopPlugin: () => requireBusinessPlugin(BUSINESS_PLUGIN_IDS.shopMonitor),
    openBrowser: async (url) => {
      const view = ensureBrowserView()
      // 本地采集和用户登录复用同一视图与持久化 session，不再调用独立 Worker 服务。
      browserState = { ...browserState, open: true, url, loading: true, error: '' }
      sendBrowserState()
      if (view.webContents.getURL() !== String(url) || view.webContents.isLoadingMainFrame()) {
        await view.webContents.loadURL(String(url)).catch((error) => {
          if (!/ERR_ABORTED|\(-3\)/i.test(String(error?.message || error))) throw error
        })
      }
      await new Promise((resolve) => {
        if (!view.webContents.isLoadingMainFrame() && feedbackUrl(view.webContents.getURL())) return resolve()
        const timer = setTimeout(resolve, 15000)
        const done = () => { clearTimeout(timer); view.webContents.removeListener('did-stop-loading', done); resolve() }
        view.webContents.once('did-stop-loading', done)
      })
      return view.webContents
    },
    analyze: analyzeLocalSkill
  })
  localDetail = new LocalDetail({
    directory: path.join(app.getPath('userData'), 'local-skill-tasks', 'detail-reference'),
    plugin: () => requireBusinessPlugin(BUSINESS_PLUGIN_IDS.detail),
    createThumbnail: detailThumbnail,
    openBrowser: async (url) => {
      const view = ensureBrowserView()
      browserState = { ...browserState, open: true, url, loading: true, error: '' }
      sendBrowserState()
      return view.webContents
    }
  })
  setInterval(() => { void syncShopMonitorJobs() }, 60 * 1000)
  setTimeout(() => { void syncShopMonitorJobs() }, 5000)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
     callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'"] } })
  })
  // Permissions are explicit: the app only needs clipboard access for its copy
  // buttons. Camera, microphone, geolocation and notifications stay denied.
  const allowedPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write'])
  const permissionHandler = (_contents, permission, callback) => callback(allowedPermissions.has(String(permission)))
  const permissionCheck = (_contents, permission) => allowedPermissions.has(String(permission))
  session.defaultSession.setPermissionRequestHandler(permissionHandler)
  session.defaultSession.setPermissionCheckHandler(permissionCheck)
  ipcMain.handle('system:state', () => systemAccessState())
  ipcMain.handle('system:request-elevation', (_, payload) => requestSystemElevation(payload || {}))
  ipcMain.handle('system:elevation-intent', () => elevationIntentState())
  ipcMain.handle('system:acknowledge-elevation', () => acknowledgeElevationIntent())
  ipcMain.handle('system:open-privacy-settings', (_, section) => openSystemPrivacySettings(section))
  ipcMain.handle('agent:permission-state', () => ({
    mode: readAgentPermissionMode(),
    activeMode: activePiRuntime()?.permissionMode || null,
    runtimeCount: piRuntimes.size,
    systemAccess: systemAccessState(),
  }))
  ipcMain.handle('agent:set-permission-mode', (_, mode) => setAgentPermissionMode(mode))
  ipcMain.handle('auth:state', async () => {
    if (!auth?.accessToken && !auth?.refreshToken) return { authenticated: false }
    // In the local development runtime the web renderer keeps its own copy of
    // the JWT. Validating here rotates the token on some backends and makes the
    // renderer's copy invalid, so trust the saved local session instead.
    if (LOCAL_ONLY_API && auth?.accessToken && auth.user) return { authenticated: true, user: auth.user }
    try {
      let user
      try {
        user = await requestApi('/auth/me')
      } catch (error) {
        // 应用长时间未打开时 access token 可能过期，先轮换会话再恢复登录态。
        if (!auth?.refreshToken || error?.status !== 401) throw error
        const refreshed = await requestApi('/auth/refresh', { method: 'POST', body: { refresh_token: auth.refreshToken } }, false)
        if (!refreshed?.access_token) throw error
        saveAuth({ ...auth, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || auth.refreshToken })
        user = await requestApi('/auth/me', {}, false)
      }
      saveAuth({ ...auth, user: user.user || user })
      return { authenticated: true, user: auth.user }
    } catch { clearAuth(); return { authenticated: false } }
  })
  ipcMain.handle('auth:sync', (_, payload = {}) => {
    const accessToken = String(payload?.accessToken || '').trim()
    if (!accessToken) return { ok: false }
    saveAuth({
      accessToken,
      refreshToken: String(payload?.refreshToken || auth?.refreshToken || ''),
      user: payload?.user || auth?.user || null
    })
    return { ok: true }
  })
  ipcMain.handle('auth:login', (_, body) => login(body))
  ipcMain.handle('auth:login2fa', (_, body) => login2fa(body))
  ipcMain.handle('auth:register', (_, body) => register(body))
  ipcMain.handle('auth:send-verify-code', (_, body) => sendVerifyCode(body))
  ipcMain.handle('auth:forgot-password', (_, body) => forgotPassword(body))
  ipcMain.handle('auth:reset-password', (_, body) => resetPassword(body))
  ipcMain.handle('auth:public-settings', () => publicSettings())
  ipcMain.handle('auth:logout', async () => {
    try { if (auth?.refreshToken) await requestApi('/auth/logout', { method: 'POST', body: { refresh_token: auth.refreshToken } }) } catch {}
    await stopPi()
    clearAuth(); return { ok: true }
  })
  ipcMain.handle('api:request', (_, route, options) => requestApi(route, options || {}))
  ipcMain.handle('api:stream', async (event, streamId, route, options = {}) => {
    try {
      const text = await streamApi(route, options, (delta) => {
        if (!event.sender.isDestroyed()) event.sender.send('api:stream-delta', streamId, delta)
      })
      return { ok: true, text }
    } catch (error) {
      return { ok: false, error: error?.message || '流式请求失败' }
    }
  })
  // AnyuAgent 业务技能统一走主进程，渲染层不接触 JWT 或上传鉴权信息。
  ipcMain.handle('letaAgent:browser-status', () => ({ ...browserState, local: true }))
  ipcMain.handle('letaAgent:browser-login', (_, payload = {}) => {
    const url = validTmallUrl(payload.url || 'https://taobao.com/')
    // 已在采集视图中等待登录时不重新导航，避免清掉用户刚输入的登录内容。
    if (localFeedback.active) return { ...browserState, local: true }
    return openBrowserUrl(url)
  })
  ipcMain.handle('letaAgent:browser-snapshot', async () => {
    if (!browserView || browserView.webContents.isDestroyed()) throw new Error('请先打开内置浏览器')
    const image = await browserView.webContents.capturePage()
    return { image: image.toDataURL(), url: browserState.url, local: true }
  })
  ipcMain.handle('letaAgent:browser-input', (_, payload = {}) => {
    const allowed = new Set(['click', 'drag', 'wheel', 'type', 'key'])
    const action = String(payload.action || '').toLowerCase()
    if (!allowed.has(action)) throw new Error('不支持的浏览器操作')
    throw new Error('请直接在右侧内置浏览器中操作，无需远程输入接口')
  })
  ipcMain.handle('letaAgent:feedback-collect', (_, payload = {}) => {
    requireBusinessPlugin(BUSINESS_PLUGIN_IDS.feedback)
    const body = {
      url: validTmallUrl(payload.url),
      prompt: String(payload.prompt || '').slice(0, 4000),
      modelCode: String(payload.modelCode || '').slice(0, 120),
      maxReviewPages: Math.min(300, Math.max(1, Number(payload.maxReviewPages) || 200)),
      maxQuestionPages: Math.min(100, Math.max(1, Number(payload.maxQuestionPages) || 80))
    }
    if (payload.sessionId) body.sessionId = String(payload.sessionId).slice(0, 160)
    return localFeedback.start(body)
  })
  ipcMain.handle('letaAgent:shop-monitor-collect', (_, payload = {}) => {
    requireBusinessPlugin(BUSINESS_PLUGIN_IDS.shopMonitor)
    return localFeedback.startShopMonitor({ url: validTmallUrl(payload.url), maxRounds: Math.min(240, Math.max(5, Number(payload.maxRounds) || 180)) })
  })
  ipcMain.handle('letaAgent:shop-analysis-started', (event, taskId, options = {}) => {
    requireBusinessPlugin(BUSINESS_PLUGIN_IDS.shopMonitor)
    return localFeedback.shopAnalysis(validTaskId(taskId), options, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('letaAgent:shop-analysis-progress', progress)
    })
  })
  ipcMain.handle('letaAgent:feedback-status', (_, taskId) => localFeedback.get(validTaskId(taskId)))
  ipcMain.handle('letaAgent:detail-collect', (_, payload = {}) => {
    requireBusinessPlugin(BUSINESS_PLUGIN_IDS.detail)
    return localDetail.start({
      url: validTmallUrl(payload.url),
      maxImages: Math.min(24, Math.max(1, Number(payload.maxImages) || 12)),
      includeData: payload.includeData !== false,
      maxImageBytes: Math.min(12 * 1024 * 1024, Math.max(1024 * 1024, Number(payload.maxImageBytes) || 8 * 1024 * 1024))
    })
  })
  ipcMain.handle('letaAgent:detail-status', (_, taskId, options = {}) => localDetail.get(validTaskId(taskId), { includeData: options.includeData !== false }))
  ipcMain.handle('letaAgent:feedback-analysis-started', (event, taskId, prompt) => localFeedback.analysis(validTaskId(taskId), prompt, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('letaAgent:feedback-analysis-progress', progress)
  }))
  ipcMain.handle('letaAgent:image-analysis', (_, payload = {}) => { requireBusinessPlugin(BUSINESS_PLUGIN_IDS.imageAnalysis); return letaAgentImageAnalysis(payload) })
  ipcMain.handle('letaAgent:task-status', () => { throw new Error('测图已改为本机执行，不再使用 AiHub 任务；请重新提交测图') })
  ipcMain.handle('letaAgent:write-artifacts', (_, payload = {}) => writeAnyuAgentArtifacts(payload))
  ipcMain.handle('anyu:skills-groups', () => requestApi('/groups/available'))
  ipcMain.handle('anyu:image-create', (_, payload = {}) => {
    const selection = requiredMediaSelection(payload, 'image')
    const files = normalizeImageReferences(payload.references)
    return requestMultipart('/anyu-ai/tasks', {
      prompt: payload.prompt, group_id: selection.groupId, model: selection.model,
      size: payload.size || '1024x1024', quality: payload.quality || 'auto', count: payload.count || 1
    }, files)
  })
  ipcMain.handle('anyu:image-task', (_, taskId) => requestApi(`/anyu-ai/tasks/${encodeURIComponent(String(taskId || ''))}`))
  ipcMain.handle('anyu:image-download', (_, taskId, index = 0) => requestBinary(`/anyu-ai/tasks/${encodeURIComponent(String(taskId || ''))}/images/${Number(index) || 0}`))
  ipcMain.handle('anyu:video-create', (_, payload = {}) => {
    const selection = requiredMediaSelection(payload, 'video')
    // Keep provider defaults server-owned. The skill planner supplies a value
    // only when the user's request and the selected model make one necessary.
    const fields = { prompt: payload.prompt, group_id: selection.groupId, model: selection.model }
    if (Number.isFinite(Number(payload.duration)) && Number(payload.duration) > 0) fields.duration = Number(payload.duration)
    if (String(payload.resolution || '').trim()) fields.resolution = String(payload.resolution).trim()
    if (String(payload.aspectRatio || '').trim()) fields.aspect_ratio = String(payload.aspectRatio).trim()
    return requestMultipart('/anyu-ai/video-tasks', fields, (payload.references || []).map((file) => ({ ...file, field: file.field || 'reference_images' })))
  })
  ipcMain.handle('anyu:video-task', (_, taskId) => requestApi(`/anyu-ai/video-tasks/${encodeURIComponent(String(taskId || ''))}`))
  ipcMain.handle('anyu:video-download', (_, taskId) => requestBinary(`/anyu-ai/video-tasks/${encodeURIComponent(String(taskId || ''))}/video`))
  const runAutoEditWorker = async (args, output) => {
    const workerCandidates = [
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'tools', 'auto_edit_worker.py'),
      path.join(__dirname, 'tools', 'auto_edit_worker.py')
    ]
    const worker = workerCandidates.find((candidate) => fs.existsSync(candidate)) || workerCandidates[0]
    if (!fs.existsSync(worker)) throw new Error('自动剪辑执行器不存在')
    const python = await resolvePython()
    if (!python) throw new Error('Python 环境尚未就绪，请在插件市场重试环境安装')
    return await new Promise((resolve, reject) => {
      const child = spawn(python, [worker, ...args], { cwd: output, windowsHide: true, env: dependencyEnvironment() })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('close', (code) => {
        const lastLine = stdout.trim().split(/\r?\n/).at(-1)
        if (code !== 0) {
          let detail = lastLine || stderr.trim() || `自动剪辑失败 (${code})`
          const errorLine = stderr.trim().split(/\r?\n/).at(-1)
          try { detail = JSON.parse(lastLine || errorLine || '{}').error || detail } catch {}
          if (detail === (lastLine || errorLine) && errorLine) {
            try { detail = JSON.parse(errorLine).error || detail } catch {}
          }
          return reject(new Error(detail))
        }
        try { resolve(JSON.parse(lastLine || '{}')) } catch { reject(new Error('自动剪辑执行器返回结果不可解析')) }
      })
    })
  }
  ipcMain.handle('anyu:auto-edit-analyze', async (event, payload = {}) => {
    const root = path.resolve(String(payload.outputRoot || app.getPath('videos')))
    fs.mkdirSync(root, { recursive: true })
    const output = path.join(root, `leta-auto-edit-${Date.now()}`)
    fs.mkdirSync(output, { recursive: true })
    const inputs = Array.isArray(payload.inputs) ? payload.inputs.map((value) => String(value || '').trim()).filter(Boolean).map((value) => path.resolve(value)) : []
    if (!inputs.length && payload.input) inputs.push(path.resolve(String(payload.input)))
    if (inputs.some((value) => !fs.existsSync(value))) throw new Error('自动剪辑素材路径不存在')
    const imageRoot = path.join(output, 'attachment-assets')
    fs.mkdirSync(imageRoot, { recursive: true })
    const imageExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' }
    for (const [index, item] of (Array.isArray(payload.images) ? payload.images : []).entries()) {
      const mimeType = String(item?.mimeType || '').split(';')[0].toLowerCase()
      const extension = imageExt[mimeType]
      const data = String(item?.data || '').replace(/^data:[^;,]+;base64,/, '')
      const bytes = Buffer.from(data, 'base64')
      if (!extension || !bytes.length || bytes.length > 12 * 1024 * 1024) throw new Error(`第 ${index + 1} 张图片附件无法作为剪辑素材读取`)
      const file = path.join(imageRoot, `attachment-${String(index + 1).padStart(2, '0')}${extension}`)
      fs.writeFileSync(file, bytes, { mode: 0o600 })
      inputs.push(file)
    }
    if (!inputs.length) throw new Error('没有可分析的媒体附件')
    if (inputs.length > 100) throw new Error('单次最多处理 100 个输入，请将素材分批发送')
    const inputsFile = path.join(output, 'inputs.json')
    fs.writeFileSync(inputsFile, JSON.stringify(inputs), { encoding: 'utf8', mode: 0o600 })
    if (event.sender && !event.sender.isDestroyed()) event.sender.send('anyu:auto-edit-progress', { taskId: String(payload.taskId || ''), message: '正在读取全部视频、图片、动画和音频素材…' })
    const analyzed = await runAutoEditWorker(['--mode', 'analyze', '--inputs-json', inputsFile, '--output', output], output)
    const assets = Array.isArray(analyzed.assets) ? analyzed.assets : []
    const thumbnailRows = []
    for (const row of Array.isArray(analyzed.thumbnails) ? analyzed.thumbnails : []) {
      try {
        const file = path.resolve(String(row.path || ''))
        const bytes = fs.readFileSync(file)
        if (bytes.length <= 2 * 1024 * 1024) thumbnailRows.push({ assetId: row.assetId, name: row.name, mimeType: 'image/jpeg', data: bytes.toString('base64') })
      } catch {}
    }
    if (event.sender && !event.sender.isDestroyed()) event.sender.send('anyu:auto-edit-progress', { taskId: String(payload.taskId || ''), message: `已盘点 ${analyzed.assetCount} 个素材，正在让 AI 分析关键帧并规划镜头、字幕和声音…` })
    const prompt = `用户剪辑要求：${String(payload.prompt || '').slice(0, 8000)}\n\n你必须先逐个阅读素材：说明每个视频关键帧在讲什么、人物/产品/动作/场景/情绪、可用片段和不适合片段；结合转录判断内容，再设计有吸引力的开场、脚本、镜头顺序、字幕和旁白。不要快速套模板，不要只取每个视频开头。\n\n素材分析（JSON）：${JSON.stringify({ assets, thumbnails: analyzed.thumbnails || [] }, null, 2)}\n\n请按系统约定先输出 creativeBrief 和 script，再输出可执行剪辑计划。`
    const plan = await autoEditAnalyze({ prompt, analysisPath: path.join(output, 'analysis.json'), thumbnails: thumbnailRows })
    const planPath = path.join(output, 'edit-plan.json')
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 })
    return { ...analyzed, plan, planPath, outputDir: output }
  })
  ipcMain.handle('anyu:auto-edit', async (event, payload = {}) => {
    const root = path.resolve(String(payload.outputRoot || app.getPath('videos')))
    const output = path.resolve(String(payload.outputDir || path.join(root, `leta-auto-edit-${Date.now()}`)))
    fs.mkdirSync(output, { recursive: true })
    const planPath = path.resolve(String(payload.planPath || ''))
    if (!fs.existsSync(planPath)) throw new Error('自动剪辑计划不存在，请先完成 AI 素材分析')
    if (event.sender && !event.sender.isDestroyed()) event.sender.send('anyu:auto-edit-progress', { taskId: String(payload.taskId || ''), message: 'AI 计划已就绪，正在执行多轨剪辑、转场、字幕和音频校验…' })
    return { ...(await runAutoEditWorker(['--mode', 'render', '--plan', planPath, '--output', output], output)), outputDir: output }
  })
  ipcMain.handle('payment:qr-data-url', (_, value) => createPaymentQrDataUrl(value))
  ipcMain.handle('payment:open-browser', (_, payload = {}) => openPaymentBrowser(payload || {}))
  ipcMain.handle('pi:key-models', (_, keyId) => listKeyModels(keyId))
  ipcMain.handle('agent:start', (_, payload) => agentSessionService.start(payload || {}))
  ipcMain.handle('agent:prompt', (_, payload) => agentSessionService.prompt(payload || {}))
  ipcMain.handle('agent:abort', (_, payload) => agentSessionService.abort(payload || {}))
  ipcMain.handle('agent:approve', (_, payload) => agentSessionService.approve(payload || {}))
  ipcMain.handle('agent:events', (_, payload) => agentSessionService.history(payload || {}))
  ipcMain.handle('agent:snapshot', (_, payload) => agentSessionService.snapshot(payload || {}))
  ipcMain.handle('agent:sessions', () => agentSessionService.list())
  ipcMain.handle('pi:save-attachments', (_, payload) => savePiAttachments(payload || {}))
  ipcMain.handle('pi:attachments', (_, sessionPath) => loadPiAttachments(sessionPath))
  ipcMain.handle('pi:materialize-session', (_, payload) => materializePiSession(payload || {}))
  ipcMain.handle('pi:create-session', (_, payload) => createPiSession(payload || {}))
  ipcMain.handle('pi:save-media', (_, payload) => savePiMediaMessages(payload || {}))
  ipcMain.handle('pi:save-optimistic-message', (_, payload) => savePiOptimisticMessage(payload || {}))
  ipcMain.handle('pi:optimistic-message', (_, sessionPath) => loadPiOptimisticMessage(sessionPath || ''))
  ipcMain.handle('pi:clear-optimistic-message', (_, sessionPath) => { clearPiOptimisticMessage(sessionPath || ''); return { ok: true } })
  ipcMain.handle('pi:media', (_, sessionPath) => loadPiMediaMessages(sessionPath))
  ipcMain.handle('pi:list-sessions', () => listPiSessions())
  // 冷会话秒开：不经过 Pi 进程，主进程直接把会话文件里的历史读出来。
  ipcMain.handle('pi:session-messages', (_, sessionPath) => {
    try { return { messages: readPiSessionMessages(sessionPath) } } catch { return { messages: [] } }
  })
  ipcMain.handle('pi:session-action', (_, payload) => sessionMetaAction(payload || {}))
  ipcMain.handle('pi:session-fork', (_, payload) => forkPiSession(payload || {}))
  ipcMain.handle('pi:start', (_, options) => startPi(options || {}))
  // 构建标记：暴露"当前这个进程实际加载的是哪一份代码"。改完 main.cjs 若不彻底
  // 退出重开，Electron 主进程内存里仍是旧代码，表现会和磁盘上的源码不一致——
  // 悬停连接状态就能看到运行中的代码版本，不用靠猜。
  ipcMain.handle('app:build-info', () => {
    const statOf = (file) => { try { return Math.round(fs.statSync(file).mtimeMs) } catch { return 0 } }
    return {
      pid: process.pid,
      startedAt: processStartedAt,
      mainFile: __filename,
      mainMtime: statOf(__filename),
      rendererMtime: statOf(path.join(__dirname, 'renderer', 'app.js')),
      preloadMtime: statOf(path.join(__dirname, 'preload.cjs'))
    }
  })
  ipcMain.handle('app:api-base', () => API_BASE)
  ipcMain.handle('app:default-workspace', () => {
    const installDirectory = path.dirname(app.getPath('exe'))
    const projectCandidate = path.resolve(__dirname, '..', '..', '..')
    const projectDirectory = fs.existsSync(path.join(projectCandidate, 'external', 'anyuagent-github')) ? projectCandidate : ''
    return {
      path: defaultWorkspacePath(),
      installDirectory,
      homeDirectory: app.getPath('home'),
      projectDirectory,
    }
  })
  ipcMain.handle('pi:stop', async (_, options = {}) => {
    const requested = String(options?.sessionKey || options?.sessionPath || '').trim()
    // 不指定会话才整体退出（登出/退出应用）；指定会话只停它自己，
    // 并且“指定了一个已经没有进程的会话”时不能误伤其它会话。
    if (!requested) return stopPi().then(() => ({ ok: true }))
    const target = resolvePiRuntime(requested)
    if (!target) return { ok: true }
    piRuntimes.delete(target.key)
    if (piActiveKey === target.key) piActiveKey = ''
    await stopPiRuntime(target)
    return { ok: true }
  })
  ipcMain.handle('pi:command', (_, command) => {
    const allowed = new Set(['prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'new_session', 'switch_session', 'get_state', 'set_model', 'set_thinking_level', 'get_available_thinking_levels', 'cycle_thinking_level', 'get_messages', 'get_entries', 'get_tree', 'set_session_name'])
    if (!command || !allowed.has(command.type)) throw new Error('不支持的 Pi 命令')
    if (command.type === 'switch_session' && !isInside(piSessionDir(), command.sessionPath)) {
      throw new Error('不允许打开工作区之外的会话文件')
    }
    // 多会话并行：命令必须落在它自己的子进程上。
    const runtime = resolvePiRuntime(command.sessionKey || command.sessionPath)
    return sendPi(command, runtime)
  })
  ipcMain.handle('pi:ui-response', (_, response) => {
    const runtime = resolvePiRuntime(response?.sessionKey) || activePiRuntime()
    if (!response?.id || !runtime?.child?.stdin?.writable) return { ok: false }
    runtime.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
    return { ok: true }
  })
  ipcMain.handle('app:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('app:choose-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('skills:list', () => skillManager?.list() || [])
  ipcMain.handle('skills:read', (_, id) => skillManager.read(id))
  ipcMain.handle('skills:install-local', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return skillManager.install(result.filePaths[0])
  })
  ipcMain.handle('plugin:state', () => pluginManager.state())
  ipcMain.handle('plugin:scan', (_, sourcePath) => pluginManager.scanPackage(sourcePath))
  ipcMain.handle('plugin:pick-package', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Leta 插件', extensions: ['anyu-plugin', 'zip'] }, { name: '所有文件', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('plugin:install-local', async (_, payload = {}) => {
    const operation = pluginProgressReporter('install', payload.pluginId)
    try {
      const installed = await pluginManager.install(payload.path, {
        scope: payload.scope,
        projectPath: payload.projectPath,
        source: 'local',
        visibility: payload.visibility || 'private',
        onProgress: (progress) => operation.report(progress)
      })
      preparePluginDependencies(installed)
      return installed
    } catch (error) {
      operation.report({ phase: 'error', percent: 100, message: error.message || '插件安装失败' })
      throw error
    }
  })
  ipcMain.handle('plugin:set-enabled', (_, payload = {}) => {
    if (payload.id === BUSINESS_PLUGIN_IDS.feedback && !payload.enabled) localFeedback.cancel()
    if (payload.id === BUSINESS_PLUGIN_IDS.detail && !payload.enabled) localDetail.cancel()
    return pluginManager.setEnabled(payload.id, payload.enabled)
  })
  ipcMain.handle('plugin:uninstall', async (_, id) => {
    if (id === BUSINESS_PLUGIN_IDS.feedback) localFeedback.cancel()
    if (id === BUSINESS_PLUGIN_IDS.detail) localDetail.cancel()
    const operation = pluginProgressReporter('uninstall', id)
    try {
      return await pluginManager.uninstall(id, { onProgress: (progress) => operation.report(progress) })
    } catch (error) {
      operation.report({ phase: 'error', percent: 100, message: error.message || '插件卸载失败' })
      throw error
    }
  })
  ipcMain.handle('plugin:rollback', (_, payload = {}) => pluginManager.rollback(payload.id, payload.version))
  ipcMain.handle('plugin:retry-dependencies', async (_, id) => {
    const record = pluginManager.get(String(id || ''))
    if (!record) throw new Error('插件不存在')
    if (!record.dependencies || !Object.keys(record.dependencies).length) return record
    preparePluginDependencies(record)
    return record
  })
  ipcMain.handle('plugin:marketplace', async () => {
    try {
      const result = await requestApi('/marketplace/plugins')
      const entries = Array.isArray(result) ? result : result?.items || result?.plugins || result?.data || []
      return (Array.isArray(entries) ? entries : []).map((item) => ({
        ...item,
        id: item?.id || item?.pluginId || item?.plugin_id,
        displayName: item?.displayName || item?.display_name || item?.name,
        description: item?.description || item?.summary || '',
        publisher: item?.publisher || item?.publisherName || item?.publisher_name,
        verified: Boolean(item?.verified || item?.publisher?.verified),
        downloadUrl: item?.downloadUrl || item?.download_url || item?.packageUrl || item?.package_url,
        categories: item?.categories || item?.tags || [],
        keywords: item?.keywords || []
      }))
    } catch (error) { throw new Error(`插件市场加载失败：${error.message || error}`) }
  })
  ipcMain.handle('plugin:install-marketplace', async (_, payload = {}) => {
    const operation = pluginProgressReporter('install', payload.id)
    let filePath = ''
    const rawUrl = String(payload.downloadUrl || payload.download_url || '')
    const url = new URL(rawUrl, GATEWAY_BASE)
    const localOrigin = new URL(GATEWAY_BASE)
    if (url.protocol !== 'https:' && !(LOCAL_ONLY_API && url.origin === localOrigin.origin)) throw new Error('市场插件下载地址无效')
    if (url.origin === localOrigin.origin && !/^\/api\/v1\/marketplace\/plugins\/[a-z0-9.-]+\/download$/.test(url.pathname)) throw new Error('市场插件下载路径无效')
    try {
      operation.report({ phase: 'preparing', percent: 5, message: '准备下载插件' })
    const response = await fetchWithTimeout(url.toString(), { headers: { Accept: 'application/octet-stream' } }, REQUEST_TIMEOUT_MS)
    if (!response.ok) throw new Error(`插件下载失败 (HTTP ${response.status})`)
    if (Number(response.headers.get('content-length')) > MAX_PACKAGE_BYTES) throw new Error('插件包超过 64 MB 限制')
    const data = await readPluginDownload(response, operation.report)
    if (!data.length || data.length > MAX_PACKAGE_BYTES) throw new Error('插件包超过 64 MB 限制')
    const expectedHash = String(payload.sha256 || '').toLowerCase()
    if (expectedHash && (!/^[a-f0-9]{64}$/.test(expectedHash) || crypto.createHash('sha256').update(data).digest('hex') !== expectedHash)) throw new Error('插件包校验失败')
    const filename = `${crypto.randomUUID()}.anyu-plugin.zip`
    filePath = path.join(pluginManager.downloadPath, filename)
    fs.writeFileSync(filePath, data, { mode: 0o600 })
      const scan = await pluginManager.scanPackage(filePath)
      if (payload.id && scan.manifest.id !== String(payload.id)) throw new Error('插件包与市场目录不匹配')
      operation.report({ phase: 'validating', percent: 32, message: '校验插件', pluginId: scan.manifest.id })
      const installed = await pluginManager.install(filePath, {
        scope: payload.scope,
        projectPath: payload.projectPath,
        source: 'marketplace',
        visibility: 'public',
        onProgress: (progress) => operation.report({ ...progress, pluginId: progress.pluginId || scan.manifest.id })
      })
      preparePluginDependencies(installed)
      return installed
    } catch (error) {
      operation.report({ phase: 'error', percent: 100, message: error.message || '插件安装失败' })
      throw error
    } finally { fs.rmSync(filePath, { force: true }) }
  })
  ipcMain.handle('plugin:publish', async (_, payload = {}) => {
    const id = String(payload.id || '')
    const record = pluginManager.get(id)
    if (!record?.installedPath) throw new Error('请选择一个已安装的自定义插件')
    const publisherName = String(payload.publisherName || '').trim()
    if (!publisherName) throw new Error('请填写发布者名称')
    const visibility = payload.visibility === 'private' ? 'private' : 'public'
    const publication = await pluginManager.preparePublish(record.installedPath, {
      publisherId: String(payload.publisherId || auth?.user?.id || auth?.user?.user_id || 'community'),
      publisherName,
      visibility
    })
    try {
      const result = await publishPluginPackage(publication, { publisherName, visibility, publisher: publication.manifest.publisher })
      const status = String(result?.publishStatus || result?.reviewStatus || result?.status || result?.state || 'submitted')
      return pluginManager.markPublished(id, {
        visibility,
        status,
        publisher: publication.manifest.publisher,
        marketplaceId: result?.id || result?.pluginId || result?.plugin_id,
        downloadUrl: result?.downloadUrl || result?.download_url || result?.packageUrl
      })
    } finally { fs.rmSync(publication.filePath, { force: true }) }
  })
  ipcMain.handle('update:check', async () => checkForUpdate())
  ipcMain.handle('update:state', () => getUpdateState())
  ipcMain.handle('update:download-install', async () => downloadAndInstallUpdate())
  ipcMain.handle('update:open-installer', () => openPendingUpdateInstaller())
  ipcMain.handle('app:open-external', (_, url) => { if (/^https?:/i.test(url)) return shell.openExternal(url) })
  ipcMain.handle('app:open-file', async (_, payload = {}) => {
    const requested = String(payload.path || '').trim()
    const cwd = String(payload.cwd || '').trim()
    if (!requested || !cwd || !path.isAbsolute(cwd)) throw new Error('文件打开位置无效')
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('工作目录不存在')
    const candidate = path.resolve(cwd, requested)
    if (!isInside(cwd, candidate) && candidate !== path.resolve(cwd)) throw new Error('只能打开当前工作目录中的文件')
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error('文件不存在：' + requested)
    if (!isInside(fs.realpathSync(cwd), fs.realpathSync(candidate))) throw new Error('文件不能指向工作目录外')
    const error = await shell.openPath(candidate)
    if (error) throw new Error(error)
    return { ok: true, path: candidate }
  })
  ipcMain.handle('app:open-path', (_, payload = {}) => openWorkspacePath(payload))
  ipcMain.handle('app:inspect-artifacts', (_, payload = {}) => inspectWorkspaceArtifacts(payload))
  ipcMain.handle('agent-browser:open-url', (_, url) => openBrowserUrl(url))
  ipcMain.handle('agent-browser:open-artifact', (_, payload = {}) => openBrowserArtifact(payload))
  ipcMain.on('agent-browser:set-bounds', (_, bounds) => setBrowserBounds(bounds))
  ipcMain.handle('agent-browser:close', () => closeBrowserView())
  ipcMain.handle('agent-browser:reload', async () => {
    if (!browserView || browserView.webContents.isDestroyed()) return { ...browserState, open: false }
    await browserView.webContents.reload()
    return { ...browserState }
  })
  ipcMain.handle('agent-browser:back', () => { if (browserView?.webContents.navigationHistory.canGoBack()) { browserHistoryTransition = true; browserView.webContents.navigationHistory.goBack() }; return { ...browserState } })
  ipcMain.handle('agent-browser:forward', () => { if (browserView?.webContents.navigationHistory.canGoForward()) { browserHistoryTransition = true; browserView.webContents.navigationHistory.goForward() }; return { ...browserState } })
  ipcMain.handle('agent-browser:set-zoom-factor', (_, factor) => setBrowserZoomFactor(factor))
  ipcMain.handle('agent-browser:get-state', () => ({ ...browserState }))
  ipcMain.handle('window:action', (_, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
    else if (action === 'close') {
      isQuitting = true
      mainWindow.close()
      return { ok: true, maximized: false }
    }
    return { ok: true, maximized: mainWindow.isMaximized() }
  })
  ipcMain.handle('window:set-width', (_, requestedWidth) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
    if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return { ok: true, width: mainWindow.getSize()[0], clamped: true }
    const width = Math.round(Number(requestedWidth))
    if (!Number.isFinite(width)) return { ok: false }
    const [currentWidth, height] = mainWindow.getSize()
    const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea
    const nextWidth = Math.max(1050, Math.min(workArea.width - 16, width))
    if (nextWidth !== currentWidth) mainWindow.setSize(nextWidth, height, false)
    return { ok: true, width: nextWidth, clamped: nextWidth !== width }
  })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { void stopPi() })
