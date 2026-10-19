// 诊断用夹具：在离屏窗口里冒充 preload，向渲染层暴露一套可控的 window.anyu。
//
// 用途：复现「切换模型时界面卡死」这类只在真实主进程 + 真实 Pi 子进程存在时
// 才会出现的现象，而不必启动第二个应用实例（开发实例与线上实例共用同一个
// userData 目录，真启动会顶掉用户正在用的窗口）。
//
// 行为由环境变量控制：
//   MOCK_PI_MODE=fail   pi:start / pi:command 直接拒绝（模拟 "Pi Agent 已退出 (1)"）
//   MOCK_PI_MODE=ok     正常返回
// 通过 window.__mock 主动制造事件（stderr 风暴等）。
const { contextBridge } = require('electron')

const PI_MODE = process.env.MOCK_PI_MODE || 'fail'
const MODEL_COUNT = Number(process.env.MOCK_MODEL_COUNT || 38)
// 模拟「Pi 启动很慢」：主进程要等到超时才把失败抛回来（真实上限 12 秒）。
const PI_START_DELAY = Number(process.env.MOCK_PI_START_DELAY || 0)
// 模拟「Pi 进程活着但不回话」：sendPi 在真实主进程里要等 15 秒才超时。
const PI_COMMAND_DELAY = Number(process.env.MOCK_PI_COMMAND_DELAY || 0)

const listeners = { stderr: [], event: [], exit: [], update: [], plugin: [], browser: [] }
const on = (name) => (listener) => { listeners[name].push(listener); return () => { listeners[name] = listeners[name].filter((item) => item !== listener) } }

// ── 目录数据：覆盖国产模型与海外模型，品牌标签走真实的 modelProviderLabel 分支 ──
const CN_MODELS = [
  ['deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash'],
  ['deepseek-v4.1', 'DeepSeek-V4.1'],
  ['deepseek-reasoner', 'DeepSeek-Reasoner'],
  ['qwen3-max', '通义千问3-Max'],
  ['qwen3-coder-plus', 'Qwen3-Coder-Plus'],
  ['qwen3-235b-a22b', 'Qwen3-235B-A22B'],
  ['glm-4.6', 'GLM-4.6'],
  ['glm-4.5-air', 'GLM-4.5-Air'],
  ['kimi-k2.5', 'Kimi-K2.5'],
  ['moonshot-v1-128k', 'Moonshot-v1-128k'],
  ['doubao-seed-1.6', '豆包-Seed-1.6'],
  ['minimax-m2', 'MiniMax-M2']
]
const EN_MODELS = [
  ['gpt-5.6', 'GPT-5.6'],
  ['gpt-5.1-codex', 'GPT-5.1-Codex'],
  ['claude-sonnet-4.6', 'Claude-Sonnet-4.6'],
  ['claude-opus-4.5', 'Claude-Opus-4.5'],
  ['gemini-3.1-pro', 'Gemini-3.1-Pro'],
  ['grok-5', 'Grok-5']
]

const GROUPS = [
  { id: 1024, name: 'Deepseek超低价', display_brand: 'Deepseek超低价', platform: 'openai', pool_type: 'discount', rate_multiplier: 0.35, status: 'active' },
  { id: 1025, name: '国产大模型专线', display_brand: '国产大模型专线', platform: 'openai', pool_type: 'stable', rate_multiplier: 1, status: 'active' },
  { id: 1026, name: 'Claude 专线', display_brand: 'Claude 专线', platform: 'anthropic', pool_type: 'stable', rate_multiplier: 1.2, status: 'active' },
  { id: 1027, name: 'GPT 官方池', display_brand: 'GPT 官方池', platform: 'openai', pool_type: 'stable', rate_multiplier: 1, status: 'active' }
]

function buildModels() {
  const rows = []
  const push = (group, pair, index) => rows.push({
    model_id: pair[0], display_name: pair[1], group_id: group.id,
    group_name: group.name, group_rate_multiplier: group.rate_multiplier,
    effective_rate_multiplier: group.rate_multiplier * 1.05, platform: group.platform,
    api: group.platform === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    reasoning: !/flash|air|coder/.test(pair[0]), sequence: index
  })
  CN_MODELS.forEach((pair, index) => push(GROUPS[0], pair, index))
  CN_MODELS.forEach((pair, index) => push(GROUPS[1], pair, index + 100))
  EN_MODELS.forEach((pair, index) => push(GROUPS[index % 2 === 0 ? 2 : 3], pair, index + 200))
  // 按需补足到指定规模：用于压测某一分组模型极多时的渲染成本。
  let extra = 0
  while (rows.length < MODEL_COUNT) {
    const index = rows.length
    push(GROUPS[0], [`deepseek-bulk-${index}`, `DeepSeek-Bulk-${index}`], 900 + extra)
    extra += 1
  }
  return rows
}

const CATALOG = buildModels()
const SESSION = 'C:\\Users\\Administrator\\.leta-agent\\agent\\sessions\\diag.jsonl'

const RESPONSES = {
  '/auth/me': { user: { id: 1, email: 'wanzong@qq.com', role: 'user' } },
  '/groups/available': GROUPS,
  '/integrations/anyu-agent/catalog': {
    models: CATALOG,
    groups: GROUPS.map((group) => ({ ...group, model_count: CATALOG.filter((model) => model.group_id === group.id).length }))
  }
}

function respond(route) {
  const path = String(route || '')
  if (path.startsWith('/keys')) {
    return { items: [{ id: 1, name: '默认密钥', status: 'active', group: { platform: 'openai' } }], total: 1 }
  }
  if (RESPONSES[path]) return RESPONSES[path]
  return {}
}

const api = {
  // ── 启动链路 ──
  appBuildInfo: async () => ({ pid: 1, startedAt: Date.now(), mainFile: 'mock', mainMtime: Date.now(), rendererMtime: Date.now(), preloadMtime: Date.now() }),
  elevationIntent: async () => null,
  acknowledgeElevation: async () => ({ ok: true }),
  authState: async () => ({ authenticated: true, user: { id: 1, email: 'wanzong@qq.com' } }),
  systemAccessState: async () => ({ platform: 'win32', administrator: false, launchedElevated: false }),
  requestSystemElevation: async () => ({ cancelled: true }),
  openSystemPrivacySettings: async () => ({ ok: true }),
  request: async (route) => respond(typeof route === 'string' ? route.split('?')[0] : route),
  pluginState: async () => ({ installed: [], state: {} }),
  pluginMarketplace: async () => ({ items: [] }),
  skillsGroups: async () => ({ groups: [] }),
  checkForUpdate: async () => ({ available: false, version: '1.0.28' }),
  updateState: async () => ({ status: 'idle' }),
  // ── Pi ──
  piStart: async () => {
    if (PI_START_DELAY > 0) await new Promise((resolve) => setTimeout(resolve, PI_START_DELAY))
    if (PI_MODE === 'fail') throw new Error('Error invoking remote method \'pi:start\': Error: Pi Agent 已退出 (1)')
    return { ok: true, cwd: 'C:\\workspace', permissionMode: 'full', reused: false }
  },
  piStop: async () => ({ ok: true }),
  piCommand: async (command) => {
    if (PI_COMMAND_DELAY > 0) await new Promise((resolve) => setTimeout(resolve, PI_COMMAND_DELAY))
    if (PI_MODE === 'fail') throw new Error('Error invoking remote method \'pi:command\': Error: Pi Agent 尚未启动')
    if (command?.type === 'get_available_thinking_levels') return { data: { levels: ['off', 'low', 'medium', 'high'] } }
    if (command?.type === 'get_state') return { data: { sessionFile: SESSION, thinkingLevel: 'medium' } }
    return { ok: true }
  },
  piListSessions: async () => [],
  piSessionMessages: async () => ({ messages: [] }),
  piAttachments: async () => [],
  piMedia: async () => [],
  piKeyModels: async () => ({ items: [] }),
  piUiResponse: async () => ({ ok: true }),
  // ── 事件订阅：把监听器收集起来，由 __mock 主动投喂 ──
  onPiStderr: on('stderr'),
  onPiEvent: on('event'),
  onPiExit: on('exit'),
  onUpdateProgress: on('update'),
  onPluginProgress: on('plugin'),
  onBrowserState: on('browser'),
  // ── 其它 ──
  windowAction: async () => ({ ok: true }),
  browserState: async () => ({ open: false }),
  browserSetBounds: () => {},
  browserClose: async () => ({ ok: true }),
  openExternal: async () => ({ ok: true }),
  openFile: async () => ({ ok: true }),
  chooseDirectory: async () => null,
  logout: async () => ({ ok: true })
}

contextBridge.exposeInMainWorld('anyu', api)
contextBridge.exposeInMainWorld('__mock', {
  modelCount: CATALOG.length,
  sessionPath: SESSION,
  emitStderr: (message) => { for (const listener of [...listeners.stderr]) listener(message) },
  emitPiEvent: (event) => { for (const listener of [...listeners.event]) listener(event) },
  emitPiExit: (info) => { for (const listener of [...listeners.exit]) listener(info) },
  listenerCount: () => Object.fromEntries(Object.entries(listeners).map(([key, list]) => [key, list.length]))
})
