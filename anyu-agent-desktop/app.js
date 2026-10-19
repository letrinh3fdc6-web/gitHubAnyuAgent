(() => {
  const root = document.querySelector('#app')
  // 思考强度模板库由 index.html 在 app.js 之前引入，主进程用的是同一份文件。
  // 缺失说明脚本顺序被改坏了，这里直接报错，避免悄悄退化成"所有模型都只有关闭档"。
  const thinkingPresets = globalThis.LetaThinkingPresets
  if (!thinkingPresets) throw new Error('思考强度模板库未加载：thinking-presets.js 必须在 app.js 之前引入')
  const mediaObjectUrls = new Map()
  const savedPermissionMode = localStorage.getItem('anyu.permissionMode')
  const permissionModeWasSelected = localStorage.getItem('anyu.permissionMode.userSelected') === '1'
  // 旧版本默认保存的是 confirm，新版本将其视为未主动选择，交给模型能力自动适配。
  const initialPermissionMode = permissionModeWasSelected && ['auto', 'confirm', 'full'].includes(savedPermissionMode) ? savedPermissionMode : 'auto'
  // 外观主题。id 必须与 renderer/styles.css 中的 :root[data-anyu-theme="<id>"]
  // 与 .appearance-card[data-appearance-theme="<id>"] 一一对应，
  // tools/test-appearance-theme.cjs 会校验三者一致。
  const APPEARANCE_THEMES = [
    { id: 'cloud', name: '云白', hint: '中性白，默认外观' },
    { id: 'rice', name: '宣纸', hint: '米黄纸感 + 朱砂' },
    { id: 'celadon', name: '青瓷', hint: '淡青 + 松绿' },
    { id: 'navy', name: '藏青', hint: '冷蓝 + 靛蓝' },
    { id: 'bamboo', name: '竹青', hint: '淡竹 + 竹绿' },
    { id: 'ochre', name: '赭石', hint: '暖砂 + 赭红' },
    { id: 'rouge', name: '胭脂', hint: '淡粉 + 胭脂红' },
    { id: 'frost', name: '霜灰', hint: '极简中性灰' }
  ]
  const APPEARANCE_THEME_IDS = APPEARANCE_THEMES.map((theme) => theme.id)
  const defaultAppearanceTheme = APPEARANCE_THEME_IDS[0]

  // 未知或已下线的主题一律回落到默认主题，避免升级后残留旧值导致样式失效。
  function normalizeAppearanceTheme(value) {
    const id = String(value || '').trim()
    return APPEARANCE_THEME_IDS.includes(id) ? id : defaultAppearanceTheme
  }

  // 主题只体现在 <html> 的 data-anyu-theme 上，样式表据此切换令牌，
  // 组件结构不随主题变化。
  function applyAppearanceTheme(id) {
    document.documentElement.dataset.anyuTheme = normalizeAppearanceTheme(id)
  }

  function persistAppearanceTheme(id) {
    const next = normalizeAppearanceTheme(id)
    applyAppearanceTheme(next)
    try {
      localStorage.setItem('anyu.appearanceTheme', next)
    } catch {
      // 隐私模式或磁盘受限时写入会失败，本次会话仍然生效。
    }
    return next
  }

  const initialAppearanceTheme = normalizeAppearanceTheme(localStorage.getItem('anyu.appearanceTheme'))
  applyAppearanceTheme(initialAppearanceTheme)
  const state = {
    user: null, keys: [], keysLoaded: false, catalog: [], catalogGroups: [], catalogSource: '', sessions: [], sessionPath: null,
    messages: [], mediaMessages: {}, mediaBusyCount: 0, mediaActivity: {}, attachments: [], imageLibrary: [], composerText: '', imageMenuOpen: false, imagePreview: null,
    selectedKey: 0,
    accessMode: 'auto',
    model: localStorage.getItem('anyu.selectedModel') || '', cwd: localStorage.getItem('anyu.cwd') || '', sessionCwd: null,
    thinkingLevel: localStorage.getItem('anyu.thinkingLevel') || 'medium', thinkingLevels: ['off'],
    loading: false, skillBusy: null, error: '', twoFactor: null, permission: null, piState: null,
    authChecking: true, authView: 'login', authBusy: false, authNotice: '', authSettings: null, authSettingsLoading: false,
    authCodeCooldownUntil: 0, authForm: { email: '', password: '', verifyCode: '', promoCode: '', invitationCode: '', resetEmail: '', resetToken: '', newPassword: '', confirmPassword: '' },
    activeRequest: null, retryNotice: '', runInProgress: false, runPoll: null,
    renderQueued: false, streamingMessage: null, forceScroll: false, appRenderQueued: false, deferredAppRenderTimer: null, promptInteractionAt: 0, optimisticMessages: {},
    renderedSessionPath: null, runStartedAt: 0, sessionScrollPositions: {},
    settingsOpen: false, settingsSection: 'general', appearanceTheme: initialAppearanceTheme, pluginMarketLoading: false, pluginMarketTab: 'marketplace', pluginMarketCategory: 'all', pluginMarketQuery: '', pluginMarketError: '', pluginPublishOpen: false, pluginPublishId: '', pluginPublishName: '', pluginPublishVisibility: 'public', pluginPublishLoading: false, pluginState: { installed: [], marketplace: [] }, pluginOperations: {},
    skillsMarketOpen: false, skillsLoading: false, skillGroups: [], skillMenuOpen: false, skillMenuQuery: '', skillMenuActiveIndex: 0, skillEnabled: { image: true, video: true },
    skillConfigs: { image: { groupId: 0, model: '', size: '1024x1024', quality: 'auto' }, video: { groupId: 0, model: '' } },
    switching: false, sessionSwitching: false, sessionLoadingPath: null, sessionSwitchToken: 0, balanceRefresh: null,
    // 每个会话的运行状态：running=有任务在跑，unread=任务已完成但用户还没看。
    sessionRuns: {}, sessionRenderQueued: false,
    // 每个会话自己的排队任务与技能占用，切换会话互不可见、互不阻塞。
    sessionQueues: {}, sessionSkills: {},
    // 每个会话最近一次渲染的消息快照：切换会话先画缓存，后台再补增量，切换秒开。
    sessionMessagesCache: {}, groupMenuOpen: false, groupMenuQuery: '', groupPoolTab: localStorage.getItem('anyu.groupPoolTab') || 'stable', groupProviderFilter: 'all', selectedGroupId: Number(localStorage.getItem('anyu.selectedGroupId') || 0), modelMenuOpen: false, modelMenuGroupId: '', modelMenuQuery: '', permissionMenuOpen: false, thinkingMenuOpen: false, pendingAgentRestart: false, configRevision: 0,
    skillLoadPromise: null, skillError: '',
    // 主进程/渲染层实际加载的代码版本（悬停连接状态可见），用于判断是否还在跑旧代码。
    buildInfo: null,
    // 当前是“还没发过消息的新会话”：Pi 进程由后台懒启动，连接状态显示“就绪”。
    pendingNewAgent: false,
    update: { status: 'idle', currentVersion: '', latestVersion: '', percent: 0, message: '' },
    queuedTasks: [], queueMenuId: null, queueDraining: false, sessionMenu: null, composerCursor: null,
    permissionMode: initialPermissionMode, activePermissionMode: null, systemAccess: null, elevationNotice: '',
    browser: { open: false, url: '', title: '', loading: false, error: '' }
  }
  // ---------- 排队任务按会话隔离 ----------
  // 排队是“会话自己的”属性：在测图会话里排的队，只能在这个会话里看到、也只能
  // 在这个会话里被消耗。之前是全局一条 state.queuedTasks，切到别的会话还能看到
  // 别的会话的排队任务，互相干扰。
  // 这里用访问器把 state.queuedTasks 变成“当前会话队列”的视图，真正的存储在
  // state.sessionQueues；所有既有代码（push/unshift/splice/filter/shift）不用改。
  function queueSessionKey(sessionPath = state.sessionPath) { return normalizeSessionKey(sessionPath) || '__pending__' }
  function sessionQueue(sessionPath = state.sessionPath) {
    const key = queueSessionKey(sessionPath)
    let list = state.sessionQueues[key]
    if (!Array.isArray(list)) { list = []; state.sessionQueues[key] = list }
    return list
  }
  function setSessionQueue(sessionPath, list) {
    const key = queueSessionKey(sessionPath)
    if (Array.isArray(list) && list.length) state.sessionQueues[key] = list
    else delete state.sessionQueues[key]
  }
  Object.defineProperty(state, 'queuedTasks', {
    configurable: true,
    get() { return sessionQueue(state.sessionPath) },
    set(list) { setSessionQueue(state.sessionPath, Array.isArray(list) ? list : []) }
  })
  // 技能占用（测图/评价分析/生图）同样按会话隔离：A 会话在跑技能，
  // B 会话照常发消息、照常排队，互不影响。
  function setSessionSkill(sessionPath, skill) {
    const key = queueSessionKey(sessionPath)
    if (skill) state.sessionSkills[key] = skill
    else delete state.sessionSkills[key]
  }
  function releaseSessionSkill(...sessionPaths) {
    for (const sessionPath of sessionPaths) {
      delete state.sessionSkills[queueSessionKey(sessionPath)]
    }
  }
  Object.defineProperty(state, 'skillBusy', {
    configurable: true,
    get() { return state.sessionSkills[queueSessionKey(state.sessionPath)] || null },
    set(value) { setSessionSkill(state.sessionPath, value) }
  })
  const api = (route, options) => window.anyu.request(route, options)
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  const initials = (email) => String(email || 'A').slice(0, 1).toUpperCase()
  // 构建标记：显示"正在运行的这个主进程加载的是哪份代码"。改了 main.cjs 但没彻底
  // 退出重开时，这里的时间戳会明显早于源码修改时间，一眼就能看出还在跑旧代码。
  function buildStampTitle() {
    const info = state.buildInfo
    if (!info) return '连接状态'
    const fmt = (ms) => {
      if (!ms) return '未知'
      const at = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }
    return `主进程 PID ${info.pid}（启动于 ${fmt(info.startedAt)}）· main.cjs ${fmt(info.mainMtime)} · 渲染层 ${fmt(info.rendererMtime)}｜改完代码需彻底退出重开才生效`
  }
  function cleanDisplayText(value, maxLength = 80) {
    if (value == null) return ''
    const text = typeof value === 'object'
      ? value.name ?? value.title ?? value.label ?? value.display_name ?? value.displayName ?? ''
      : value
    return String(text).normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
  }
  function looksLikeSecret(value) {
    const text = String(value || '')
    if (!text) return false
    // Some API responses put the credential itself in `name` (or use a
    // generated numeric identifier). Never expose those values as labels.
    if (/^(?:sk|key|token|bearer|AIza|ghp|xox[baprs])[-_]/i.test(text) && text.length > 20) return true
    if (/^\d{8,}$/.test(text)) return true
    if (text.length > 64) return true
    return /^[A-Za-z0-9_-]{28,}$/.test(text) && !/[\s-]/.test(text.slice(0, 12))
  }
  function keyDisplayName(key) {
    const id = key?.id == null ? '' : String(key.id)
    if (!key || !id) return '选择密钥'
    const rawSecret = [key?.key, key?.api_key, key?.apiKey, key?.token, key?.secret]
      .map((value) => cleanDisplayText(value, 256)).find(Boolean)
    const candidates = [
      key?.display_name, key?.displayName, key?.title, key?.label,
      key?.key_name, key?.keyName, key?.description, key?.name, key?.group?.name,
      Array.isArray(key?.groups) ? key.groups[0]?.name : ''
    ]
    for (const candidate of candidates) {
      const text = cleanDisplayText(candidate)
      if (text && text !== rawSecret && !looksLikeSecret(text)) return text
    }
    return `密钥 ${id}`
  }
  const textOf = (content) => Array.isArray(content) ? content.map((part) => part?.type === 'text' ? part.text || '' : typeof part?.content === 'string' ? part.content : '').join('') : String(content || '')
  const thinkingOf = (content) => Array.isArray(content) ? content.filter((part) => part?.type === 'thinking').map((part) => part.thinking || '').join('') : ''
  const formatBytes = (bytes) => { const size = Number(bytes || 0); if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`; return `${(size / 1024 / 1024).toFixed(1)} MB` }
  const errorText = (value) => String(value?.message || value || '').replace(/\s+/g, ' ').trim()
  // 切换模型时界面最多等 Pi 这么久。超过就先解锁输入栏，把迟到的结果放掉。
  const MODEL_SWITCH_TIMEOUT_MS = 3000
  // stderr 错误条的最小刷新间隔：防止 Pi 刷屏时把整壳重建打成按帧刷新。
  const STDERR_NOTICE_INTERVAL_MS = 700
  // Pi 侧的命令在主进程里有 15 秒超时，那是为了不误判"长任务还在跑"。
  // 但界面不能陪着一起等：Pi 进程活着却不回话时，一次切换就要冻结 15 秒，
  // 用户只会认为应用卡死。这里给"界面等待"单独设一个上限，超时后先放人。
  // Promise.race 会给入参都挂上处理函数，迟到的拒绝不会变成未处理异常。
  const piRequestWithTimeout = (command, timeoutMs) => Promise.race([
    window.anyu.piCommand(command),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(`Pi 响应超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs))
  ])
  function renderInlineMessageContent(value) {
    const source = String(value || '')
    const filePattern = /^(?:[A-Za-z]:[\\/]|\.\.?[\\/])?[\w.\\/-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|md|html?|css|go|py|ya?ml|txt|sql)$/i
    const tokenPattern = /\[([^\]\r\n]+)\]\((https?:\/\/[^\s)]+)\)|`([^`\r\n]+)`|https?:\/\/[^\s<>()]+|(?:[\w.-]+[\\/])*[\w.-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|md|html?|css|go|py|ya?ml|txt|sql)\b/gi
    const link = (url, label) => {
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol)) return esc(label)
        return `<a class="message-link" href="${esc(parsed.href)}" data-external-url="${esc(parsed.href)}" rel="noreferrer">${esc(label)}</a>`
      } catch { return esc(label) }
    }
    let cursor = 0
    let html = ''
    for (const match of source.matchAll(tokenPattern)) {
      html += esc(source.slice(cursor, match.index))
      if (match[1]) html += link(match[2], match[1])
      else if (match[3]) html += filePattern.test(match[3]) ? `<button type="button" class="message-file-link" data-file-path="${esc(match[3])}">${esc(match[3])}</button>` : `<code>${esc(match[3])}</code>`
      else if (/^https?:\/\//i.test(match[0])) html += link(match[0], match[0])
      else html += `<button type="button" class="message-file-link" data-file-path="${esc(match[0])}">${esc(match[0])}</button>`
      cursor = match.index + match[0].length
    }
    return html + esc(source.slice(cursor))
  }
  function renderMessageContent(value) {
    const source = String(value || '')
    const fenced = /```([\w.+-]*)[^\S\r\n]*\r?\n([\s\S]*?)```/g
    let cursor = 0
    let codeIndex = 0
    let result = ''
    for (const match of source.matchAll(fenced)) {
      result += renderInlineMessageContent(source.slice(cursor, match.index))
      const language = String(match[1] || '').trim() || '代码'
      const code = String(match[2] || '').replace(/\s+$/, '')
      const lines = code ? code.split(/\r?\n/).length : 0
      result += `<details class="code-result" data-detail-key="code-${codeIndex++}"><summary><span class="tool-chevron">›</span><span>${esc(language)}</span><small>${lines} 行</small></summary><pre><code>${esc(code)}</code></pre></details>`
      cursor = Number(match.index || 0) + match[0].length
    }
    result += renderInlineMessageContent(source.slice(cursor))
    // 模型偶尔会不加 Markdown 围栏直接返回整页 HTML，仍默认折叠，避免源码铺满对话。
    if (!codeIndex && /^\s*(?:<!doctype\s+html|<html\b)/i.test(source) && source.split(/\r?\n/).length > 8) {
      const lines = source.split(/\r?\n/).length
      return `<details class="code-result" data-detail-key="code-html"><summary><span class="tool-chevron">›</span><span>HTML</span><small>${lines} 行</small></summary><pre><code>${esc(source)}</code></pre></details>`
    }
    return result
  }
  const formatDuration = (milliseconds) => { const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 100) / 10); return seconds < 1 ? '< 1 秒' : `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒` }
  // 报告阶段能跑十几分钟，用只输出"多少秒"的格式会变成 "600 秒" 这种没信息量的文案。
  const formatElapsed = (milliseconds) => {
    const total = Math.max(0, Math.round(Number(milliseconds || 0) / 1000))
    if (total < 60) return `${total} 秒`
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
  }
  function timestampValue(value) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number
    const parsed = Date.parse(String(value || ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  function formatTimestamp(value) {
    const number = timestampValue(value)
    const date = number > 0 ? new Date(number) : new Date(String(value || ''))
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }
  const providerForApi = (api, groupId = 0) => {
    const protocol = api === 'anthropic-messages' ? 'anthropic' : api === 'google-generative-ai' || api === 'google-vertex' ? 'gemini' : 'openai'
    return groupId > 0 ? `anyu-gateway-${protocol}-g${groupId}` : `anyu-gateway-${protocol}`
  }
  const canonicalApi = (value, fallback = 'openai-completions') => { const raw = String(value || '').toLowerCase(); if (raw.includes('anthropic') || raw.includes('claude')) return 'anthropic-messages'; if (raw.includes('google') || raw.includes('gemini')) return 'google-generative-ai'; if (raw.includes('response')) return 'openai-responses'; if (raw.includes('openai') || raw.includes('completion') || raw.includes('chat')) return 'openai-completions'; return fallback }
  const selectedKey = () => state.keys.find((key) => Number(key.id) === state.selectedKey)
  const currentModel = () => state.catalog.find((item) => item.id === state.model)
  const effectiveWorkspace = () => state.sessionCwd || state.cwd || ''
  function modelPermissionMode(model = currentModel()) {
    const explicit = String(model?.permissionMode || model?.permission_mode || '').toLowerCase()
    if (explicit === 'full' || explicit === 'confirm') return explicit
    const toolFlags = [
      model?.supportsTools, model?.supports_tools, model?.toolUse,
      model?.tool_use, model?.capabilities?.tools, model?.capabilities?.tool_use
    ]
    if (toolFlags.some((value) => value === false)) return 'confirm'
    if (toolFlags.some((value) => value === true)) return 'full'
    const lower = `${model?.id || model?.name || ''} ${model?.api || ''} ${model?.provider || ''}`.toLowerCase()
    // Leta 主流模型用于编码 Agent 时默认开放本机工具，未知模型仍保留确认。
    return /gpt|codex|openai|claude|anthropic|gemini|google|grok|qwen|deepseek|glm|kimi|mistral|moonshot|doubao|llama/.test(lower) ? 'full' : 'confirm'
  }
  function effectivePermissionMode() {
    return state.permissionMode === 'auto' ? (state.activePermissionMode || modelPermissionMode()) : state.permissionMode
  }
  // 三种权限模式。auto 按模型能力自动决定，confirm/full 是用户手工锁定。
  const PERMISSION_MODES = [
    { id: 'auto', icon: '⌁', name: '自动适配', hint: '按当前模型的工具能力自动决定是否询问' },
    { id: 'confirm', icon: '✓', name: '受控访问', hint: '敏感操作先询问，其余照常执行' },
    { id: 'full', icon: '⚡', name: '完整访问', hint: '不再询问，直接执行全部内置工具' }
  ]
  function permissionModeMeta(mode) {
    return PERMISSION_MODES.find((item) => item.id === mode) || PERMISSION_MODES[0]
  }
  function permissionModeLabel(mode = effectivePermissionMode()) {
    return permissionModeMeta(mode).name
  }
  function systemAccessLabel() {
    const access = state.systemAccess
    if (!access) return '正在读取系统授权状态'
    if (access.platform === 'win32') {
      if (access.administrator) return 'Windows 管理员权限已启用'
      // 区分"没走提权"和"走了提权但系统没给权限"，否则用户只能靠反复点击试错。
      return access.launchedElevated ? '已按提权流程重启，但系统未授予管理员权限' : 'Windows 标准用户权限'
    }
    if (access.platform === 'darwin') return access.elevated ? 'macOS root 进程' : 'macOS 用户进程；隐私权限需系统授权'
    return access.elevated ? '系统特权进程' : '当前用户权限'
  }
  async function refreshSystemAccess() {
    if (!window.anyu.systemAccessState) return
    try { state.systemAccess = await window.anyu.systemAccessState() } catch { state.systemAccess = null }
  }
  // 读取主进程在提权重启之前同步落盘的意图。
  // 这是"重启后权限没生效、还得手动再指定一次"的修复点：不再依赖渲染进程的
  // localStorage 是否赶在 app.quit() 之前落盘，而是由主进程给出权威结论。
  async function applyElevationIntent() {
    let intent = null
    try { intent = await window.anyu.elevationIntent?.() } catch { intent = null }
    if (!intent?.pending) return null
    if (intent.permissionMode === 'full') {
      state.permissionMode = 'full'
      localStorage.setItem('anyu.permissionMode', 'full')
      localStorage.setItem('anyu.permissionMode.userSelected', '1')
      // 区分"没提权"和"提权了但系统没给权限"，否则用户只能靠反复点击来试错。
      state.elevationNotice = intent.elevated
        ? '已以管理员身份重启，完整访问已生效。'
        : '已按完整访问重启，但系统未授予管理员权限；需要提权的操作仍会被拒绝。'
    } else {
      state.elevationNotice = intent.elevated ? '已以管理员身份重启。' : ''
    }
    return intent
  }

  // 只在权限模式确实落地之后才确认意图。若此刻 Pi 启动失败，意图会保留，
  // 主进程仍会在下一次启动 Pi 时兜底按完整访问拉起。
  async function confirmElevationIntent(intent) {
    if (!intent?.pending) return
    try { await window.anyu.acknowledgeElevation?.() } catch {}
  }

  /**
   * 切换权限模式。
   *
   * 权限模式只是 Pi 的启动参数（--permission-profile gptFullAccess --approve），
   * 重启 Pi 子进程就能生效，完全不需要重启整个应用——更不该因为当前不是管理员
   * 就强制走 UAC 重启。系统管理员权限是另一件事，见下面的 requestElevation()。
   */
  async function choosePermissionMode(mode) {
    if (state.loading) { state.error = '当前任务完成后再切换权限'; renderApp(); return }
    const next = ['auto', 'confirm', 'full'].includes(mode) ? mode : 'auto'
    state.permissionMode = next
    state.permissionMenuOpen = false
    state.elevationNotice = ''
    localStorage.setItem('anyu.permissionMode', next)
    localStorage.setItem('anyu.permissionMode.userSelected', '1')
    // 用户主动选了非完整访问，说明不需要提权意图继续兜底，先撤销再继续。
    if (next !== 'full') { try { await window.anyu.acknowledgeElevation?.() } catch {} }
    let started = false
    // 必须是 state.sessionPath：这里曾经写成裸的 sessionPath，切换权限模式时
    // 会直接抛 ReferenceError，把"重启 Pi 生效新权限"这一步整个打断。
    try { await startAgent(state.sessionPath); started = true } catch (error) { state.error = error.message || '权限模式切换失败' }
    // 权限模式已经在本进程落地，之前的提权意图不再需要兜底；失败时保留，留给主进程兜底。
    if (started) { try { await window.anyu.acknowledgeElevation?.() } catch {} }
    await refreshSystemAccess()
    renderApp()
  }

  /**
   * 申请系统管理员权限。这是独立的显式操作，不再挂在"完整访问"上。
   *
   * Windows 上进程一旦启动就无法自我提权，只能由 UAC 拉起新实例，所以这一步
   * 必然重启应用。把它做成用户主动点的动作，而不是切权限时的副作用，
   * 才不会出现"只是想要完整访问，结果应用莫名其妙重启了"。
   */
  async function requestElevation() {
    if (state.loading) { state.error = '当前任务完成后再申请管理员权限'; renderApp(); return }
    state.permissionMenuOpen = false
    state.elevationNotice = ''
    // 刻意不传 permissionMode：提权只改系统权限，不顺手替用户改权限模式。
    const result = await window.anyu.requestSystemElevation?.({})
    if (result?.state) state.systemAccess = result.state
    if (result?.cancelled) state.error = 'Windows UAC 授权未完成'
    // 提权成功会重启应用；重启后的状态由 applyElevationIntent 恢复。
    if (result?.restarted) { renderApp(); return }
    await refreshSystemAccess()
    renderApp()
  }
  // 档位顺序、中文名、图标、说明文案都定义在 thinking-presets.js 里，
  // 渲染层只做一次转发，避免和主进程各维护一套。
  const THINKING_LEVELS = thinkingPresets.LEVELS
  const thinkingLevelLabel = (level) => thinkingPresets.label(level)
  const thinkingLevelIcon = (level) => thinkingPresets.icon(level)
  /** 当前模型实际可用的思考强度档位。 */
  function modelThinkingLevels(model = currentModel()) {
    if (!model?.reasoning) return ['off']
    const listed = thinkingPresets.normalizeLevels(model.thinkingLevels)
    if (listed.length) return listed
    const fromMap = thinkingPresets.levelsFromMap(model.thinkingLevelMap)
    return fromMap.length ? fromMap : ['off']
  }
  /** 当前模型思考强度所属的模板名，用于在菜单里说明档位是怎么来的。 */
  function modelThinkingTemplate(model = currentModel()) {
    return model?.thinkingTemplate || ''
  }
  function modelCapabilities(model, id = model?.id, api = model?.api) {
    const inputValues = [model?.input, model?.input_modalities, model?.modalities, model?.capabilities?.input, model?.capabilities?.input_modalities, model?.capabilities?.modalities]
      .flatMap((value) => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,|]+/) : [])
      .map((value) => String(value).toLowerCase().trim()).filter(Boolean)
    const visionFlags = [model?.supports_images, model?.supportsImages, model?.supports_vision, model?.supportsVision, model?.vision, model?.capabilities?.vision, model?.capabilities?.supports_vision, model?.capabilities?.supportsVision]
    const explicitFalse = visionFlags.some((value) => value === false)
    const explicitTrue = visionFlags.some((value) => value === true)
    const hasImageValue = inputValues.some((value) => /image|vision|multimodal|photo|picture/.test(value))
    const lower = `${id || ''} ${model?.name || ''} ${api || ''}`.toLowerCase()
    // 与主进程 modelInputCapabilities 保持一致：“直来直去”原则——目录无任何能力声明时
    // 默认视为支持图片直传，不支持由 API 明确报错，而不是静默丢弃图片让模型只看到文件名。
    const undeclared = !explicitFalse && !explicitTrue && inputValues.length === 0 && !/image-generation|image-edit|embedding|audio/.test(lower)
    const inferred = undeclared || (!explicitFalse && !/image-generation|image-edit|embedding|audio/.test(lower) && (
      /gemini|claude|anthropic|gpt-4o|gpt-4\.1|gpt-5|gpt-6|o[1-9]|vision|multimodal|vl|qwen2?\.5-vl|qwen3-vl|qvq|glm-4v|doubao-vision|kimi-vl|moonshot-v1-vision|internvl|pixtral|llava|ernie-4\.5/.test(lower)
    ))
    const supportsImages = !explicitFalse && (explicitTrue || hasImageValue || inferred)
    const input = inputValues.length ? [...new Set(inputValues.map((value) => value === 'vision' || value === 'multimodal' ? 'image' : value).filter((value) => !explicitFalse || value !== 'image'))] : ['text']
    if (supportsImages && !input.includes('image')) input.push('image')
    return { supportsImages, input }
  }
  function balanceValue(user = state.user) {
    if (!user || typeof user !== 'object') return null
    for (const key of ['balance', 'remaining_balance', 'quota', 'remaining_quota', 'credits']) {
      const value = Number(user[key])
      if (Number.isFinite(value)) return value
    }
    return null
  }
  function formatBalance(user = state.user) {
    const value = balanceValue(user)
    if (value === null) return '--'
    return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  function updateButtonLabel() {
    const update = state.update || {}
    if (update.status === 'checking') return '检查更新…'
    if (update.status === 'downloading') return `下载更新 ${Math.max(0, Math.min(100, Number(update.percent || 0)))}%`
    if (update.status === 'ready') return '打开安装包并覆盖安装'
    if (update.status === 'latest') return '已是最新版本'
    if (update.status === 'available') return `发现 v${update.latestVersion || ''}`
    if (update.status === 'error') return '更新失败，重试'
    return '检查更新'
  }
  function updateUpdateControl() {
    const button = document.querySelector('#update-app')
    if (!button) return
    const update = state.update || {}
    const busy = ['checking', 'downloading', 'installing'].includes(update.status)
    button.disabled = busy
    button.classList.toggle('error', update.status === 'error')
    const icon = button.querySelector('.update-icon')
    if (icon) icon.classList.toggle('spinning', busy)
    const label = button.querySelector('.update-label')
    if (label) label.textContent = updateButtonLabel()
  }
  function stopBalanceRefresh() {
    if (state.balanceRefresh) window.clearInterval(state.balanceRefresh)
    state.balanceRefresh = null
  }
  async function refreshBalance(shouldRender = true) {
    if (!state.user) return
    try {
      const me = await api('/auth/me')
      const user = me?.user || me
      if (user && typeof user === 'object') {
        state.user = { ...state.user, ...user }
        const balanceNode = document.querySelector('.balance-summary strong')
        if (balanceNode) balanceNode.textContent = formatBalance(state.user)
        if (shouldRender && !balanceNode) scheduleAppRender()
      }
    } catch {}
  }
  function startBalanceRefresh() {
    stopBalanceRefresh()
    state.balanceRefresh = window.setInterval(() => { void refreshBalance(true) }, 60 * 1000)
  }

  function render() { if (!state.user) state.settingsOpen = false; state.user ? renderApp() : renderLogin() }
  function windowControlsMarkup(className = '') {
    return `<div class="window-controls ${className}" aria-label="窗口控制"><button type="button" data-window-action="minimize" title="最小化">−</button><button type="button" data-window-action="maximize" title="最大化">□</button><button type="button" data-window-action="close" title="关闭">×</button></div>`
  }
  async function loadAuthSettings() {
    if (state.authSettings !== null || state.authSettingsLoading || !window.anyu.publicSettings) return
    state.authSettingsLoading = true
    try { state.authSettings = await window.anyu.publicSettings() } catch { state.authSettings = {} }
    state.authSettingsLoading = false
    if (!state.user) renderLogin()
  }
  function authSetting(name, fallback) {
    return state.authSettings && typeof state.authSettings[name] === 'boolean' ? state.authSettings[name] : fallback
  }
  function authCodeCooldown() {
    return Math.max(0, Math.ceil((Number(state.authCodeCooldownUntil || 0) - Date.now()) / 1000))
  }
  function startAuthCodeCooldown() {
    state.authCodeCooldownUntil = Date.now() + 60 * 1000
    const tick = () => { if (authCodeCooldown() > 0 && !state.user) { renderLogin(); window.setTimeout(tick, 1000) } }
    window.setTimeout(tick, 1000)
  }
  async function switchAccount() {
    state.error = ''; state.sessionSwitchToken++; state.sessionSwitching = false; stopBalanceRefresh()
    try { await window.anyu.piStop() } catch {}
    try { await window.anyu.logout() } catch {}
    state.user = null; state.keys = []; state.keysLoaded = false; state.catalog = []; state.catalogGroups = []; state.selectedGroupId = 0; state.groupMenuOpen = false; state.groupMenuQuery = ''; state.skillGroups = []; state.skillMenuQuery = ''; state.skillMenuActiveIndex = 0; state.mediaMessages = {}; state.mediaActivity = {}; state.mediaBusyCount = 0; state.sessions = []; state.sessionPath = null; state.sessionCwd = null; state.messages = []; state.imageLibrary = []; state.attachments = []; state.composerText = ''; state.piState = null; state.loading = false; state.permission = null; state.settingsOpen = false; state.settingsSection = 'general'; state.keyMenuOpen = false; state.modelMenuOpen = false; state.modelMenuGroupId = ''; state.modelMenuQuery = ''; state.permissionMenuOpen = false; state.thinkingMenuOpen = false; state.imageMenuOpen = false; state.skillMenuOpen = false; state.twoFactor = null; state.streamingMessage = null; state.sessionQueues = {}; state.queueMenuId = null; state.queueDraining = false; state.pendingNewAgent = false; state.authChecking = false; state.authView = 'login'; state.authNotice = ''; state.authBusy = false; state.authForm.password = ''
    render()
  }
  function authInput(id, type, value, label, placeholder, autocomplete = '') {
    return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value)}" ${autocomplete ? `autocomplete="${autocomplete}"` : ''} placeholder="${placeholder}"></div>`
  }
  function captureAuthForm() {
    const value = (selector) => document.querySelector(selector)?.value
    const assign = (key, selector) => { const next = value(selector); if (typeof next === 'string') state.authForm[key] = next }
    assign('email', '#email'); assign('password', '#password'); assign('confirmPassword', '#confirm-password')
    assign('verifyCode', '#verify-code'); assign('promoCode', '#promo-code'); assign('invitationCode', '#invitation-code')
    assign('resetEmail', '#reset-email'); assign('resetToken', '#reset-token'); assign('newPassword', '#new-password')
    const resetConfirmation = value('#confirm-new-password')
    if (typeof resetConfirmation === 'string') state.authForm.confirmPassword = resetConfirmation
  }
  function renderNoKeyApp() {
    root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="side-brand"><div class="brand-mark">A</div><div><strong>AnyuAgent</strong><span>创造无限可能</span></div></div><div class="nav-section"><div class="nav-title">工作区</div><div class="nav-item active"><span class="nav-icon">✦</span>Agent 对话</div></div><div class="side-footer"><button class="settings-link" id="settings-open"><span class="nav-icon">⚙</span>设置</button><div class="user-line"><div class="avatar">${initials(state.user?.email)}</div><div class="user-email" title="${esc(state.user?.email)}">${esc(state.user?.email || 'Anyu 用户')}</div></div><button class="logout" id="logout">切换账号</button></div></aside><main class="main"><header class="topbar"><div class="topbar-title"><h2>Agent 对话</h2><span class="connection-dot offline"></span><span class="connection-label">等待密钥</span></div><div class="top-actions"><button class="icon-button" id="refresh" title="刷新密钥列表">↻</button>${windowControlsMarkup()}</div></header>${state.error ? `<div class="app-alert" role="status">${esc(state.error)}</div>` : ''}<section class="no-key-panel"><div class="no-key-icon">⌁</div><h2>还没有 API 密钥</h2><p>请先前往 Anyu 网站创建 API 密钥，创建后回到这里点击刷新。</p><div class="no-key-actions"><button class="primary no-key-primary" id="open-key-site">去 Anyu 网站创建密钥</button><button class="ghost" id="refresh-keys">我已创建，刷新密钥</button></div><p class="muted no-key-note">桌面端不会保存或展示你的密钥明文。</p></section></main></div>`
    document.querySelectorAll('[data-window-action]').forEach((node) => node.addEventListener('click', () => window.anyu.windowAction(node.dataset.windowAction)))
    document.querySelector('#open-key-site')?.addEventListener('click', () => window.anyu.openExternal('http://127.0.0.1:9090'))
    document.querySelector('#refresh-keys')?.addEventListener('click', async () => { await refreshKeysAndStart() })
    document.querySelector('#refresh')?.addEventListener('click', async () => { await refreshKeysAndStart() })
    document.querySelector('#logout')?.addEventListener('click', switchAccount)
    document.querySelector('#settings-open')?.addEventListener('click', () => { state.settingsOpen = true; state.settingsSection = 'general'; renderApp() })
  }
  async function refreshKeysAndStart() {
    state.error = ''; state.switching = true; renderApp()
    try {
      await loadRouteData()
      chooseModel()
      await startAgent(state.sessionPath)
    } catch (error) { state.error = errorText(error) || '密钥刷新失败' }
    finally { state.switching = false; renderApp() }
  }
  function renderLogin() {
    captureAuthForm()
    void loadAuthSettings()
    const two = state.twoFactor
    if (state.authChecking) {
      root.innerHTML = `<main class="login">${windowControlsMarkup('login-window-controls')}<section class="login-card auth-checking"><div class="brand"><div class="brand-mark">A</div><div><h1>AnyuAgent</h1><small>独立 Pi Agent 桌面客户端</small></div></div><div class="login-loading"><span class="spinner"></span><span>正在检查登录状态…</span></div><p class="muted" style="font-size:11px;margin-top:24px">正在连接 Anyu 账号服务</p></section></main>`
      document.querySelectorAll('[data-window-action]').forEach((node) => node.addEventListener('click', () => window.anyu.windowAction(node.dataset.windowAction)))
      return
    }
    const form = state.authForm
    const view = state.authView
    const registrationEnabled = authSetting('registration_enabled', true)
    const passwordResetEnabled = authSetting('password_reset_enabled', true)
    const passwordResetNeedsWebVerification = ['turnstile_enabled', 'tencent_captcha_enabled', 'aliyun_captcha_enabled'].some((name) => authSetting(name, false))
    const emailVerifyEnabled = authSetting('email_verify_enabled', false)
    const promoEnabled = authSetting('promo_code_enabled', false)
    const invitationEnabled = authSetting('invitation_code_enabled', false)
    const cooldown = authCodeCooldown()
    let content = ''
    if (two) {
      content = `<h2>完成安全验证</h2><p class="muted">账号 ${esc(two.user_email_masked || '')} 已开启双重验证。</p><div class="field"><label for="totp">Authenticator 验证码</label><input id="totp" inputmode="numeric" maxlength="6" placeholder="输入 6 位验证码"></div><button class="primary" id="verify">进入 AnyuAgent</button>`
    } else if (view === 'register') {
      content = `<h2>注册 Anyu 账号</h2><p class="muted">注册后即可在桌面端登录并同步你的 API 密钥。</p>${registrationEnabled ? `<form id="auth-form">${authInput('email', 'email', form.email, 'Anyu 邮箱', 'name@example.com', 'email')}${authInput('password', 'password', form.password, '密码', '至少 6 位密码', 'new-password')}${authInput('confirm-password', 'password', form.confirmPassword, '确认密码', '再次输入密码', 'new-password')}${emailVerifyEnabled ? `<div class="field"><label for="verify-code">邮箱验证码</label><div class="inline-field"><input id="verify-code" inputmode="numeric" value="${esc(form.verifyCode)}" placeholder="输入邮箱验证码"><button type="button" class="ghost inline-action" id="send-code" ${cooldown ? 'disabled' : ''}>${cooldown ? `${cooldown}s 后重试` : '发送验证码'}</button></div></div>` : ''}${invitationEnabled ? authInput('invitation-code', 'text', form.invitationCode, '邀请码', '如网站要求，请填写邀请码') : ''}${promoEnabled ? authInput('promo-code', 'text', form.promoCode, '优惠码（可选）', '输入优惠码') : ''}<button class="primary" id="register" type="submit">注册并开始</button></form>` : `<div class="auth-notice">当前网站暂未开放注册，请前往 AnyuAgent 网站 完成注册。</div><button class="primary" id="open-site">打开网站注册</button>`}`
    } else if (view === 'forgot') {
      content = `<h2>找回密码</h2><p class="muted">输入注册邮箱，我们会发送密码重置链接。</p>${passwordResetEnabled && !passwordResetNeedsWebVerification ? `<form id="auth-form">${authInput('reset-email', 'email', form.resetEmail, '注册邮箱', 'name@example.com', 'email')}<button class="primary" id="forgot" type="submit">发送重置邮件</button></form>` : `<div class="auth-notice">${passwordResetNeedsWebVerification ? '网站已开启安全验证，请前往 AnyuAgent 网站 完成密码找回。' : '当前网站未开启密码找回，请前往 AnyuAgent 网站 操作。'}</div><button class="primary" id="open-site">打开网站找回密码</button>`}`
    } else if (view === 'reset') {
      content = `<h2>重置密码</h2><p class="muted">粘贴邮件中的重置令牌并设置新密码。</p><form id="auth-form">${authInput('reset-email', 'email', form.resetEmail, '注册邮箱', 'name@example.com', 'email')}${authInput('reset-token', 'text', form.resetToken, '重置令牌', '粘贴邮件中的 token')}${authInput('new-password', 'password', form.newPassword, '新密码', '至少 6 位密码', 'new-password')}${authInput('confirm-new-password', 'password', form.confirmPassword, '确认新密码', '再次输入新密码', 'new-password')}<button class="primary" id="reset" type="submit">更新密码</button></form>`
    } else {
      content = `<h2>登录 AnyuAgent</h2><p class="muted">登录后同步 Anyu 密钥，在本地 Pi Agent 中对话。</p><form id="auth-form">${authInput('email', 'email', form.email, 'Anyu 邮箱', 'name@example.com', 'username')}${authInput('password', 'password', form.password, '密码', '输入 Anyu 密码', 'current-password')}<button class="primary" id="login" type="submit">登录并开始</button></form>`
    }
    const links = two ? '' : `<div class="auth-links">${view !== 'login' ? '<button type="button" class="link-button" id="show-login">返回登录</button>' : ''}${view === 'login' && registrationEnabled ? '<button type="button" class="link-button" id="show-register">立即注册</button>' : ''}${view === 'login' && passwordResetEnabled ? '<button type="button" class="link-button" id="show-forgot">忘记密码？</button>' : ''}${view === 'forgot' ? '<button type="button" class="link-button" id="show-reset">已有重置令牌</button>' : ''}</div>`
    root.innerHTML = `<main class="login">${windowControlsMarkup('login-window-controls')}<section class="login-card"><div class="brand"><div class="brand-mark">A</div><div><h1>AnyuAgent</h1><small>独立 Pi Agent 桌面客户端</small></div></div>${content}${state.authNotice ? `<div class="auth-notice success">${esc(state.authNotice)}</div>` : ''}${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}${links}<p class="muted" style="font-size:11px;margin-top:24px">账号认证与网站一致 · Pi 会话只保存在本机</p></section></main>`
    document.querySelectorAll('[data-window-action]').forEach((node) => node.addEventListener('click', () => window.anyu.windowAction(node.dataset.windowAction)))
    const button = document.querySelector(two ? '#verify' : '#login')
    document.querySelector('#auth-form')?.addEventListener('submit', async (event) => {
      event.preventDefault(); if (state.authBusy) return
      state.error = ''; state.authNotice = ''; state.authBusy = true; if (button) button.disabled = true
      try {
        if (view === 'login') {
          form.email = document.querySelector('#email')?.value.trim() || ''; form.password = document.querySelector('#password')?.value || ''
          if (!form.email || !form.password) throw new Error('请输入邮箱和密码')
          const data = await window.anyu.login({ email: form.email, password: form.password })
          if (data.requires_2fa) state.twoFactor = data
          else { state.user = data.user; await bootstrap() }
        } else if (view === 'register') {
          form.email = document.querySelector('#email')?.value.trim() || ''; form.password = document.querySelector('#password')?.value || ''; form.confirmPassword = document.querySelector('#confirm-password')?.value || ''
          form.verifyCode = document.querySelector('#verify-code')?.value.trim() || ''; form.invitationCode = document.querySelector('#invitation-code')?.value.trim() || ''; form.promoCode = document.querySelector('#promo-code')?.value.trim() || ''
          if (!form.email || !form.password) throw new Error('请输入邮箱和密码')
          if (form.password.length < 6) throw new Error('密码至少需要 6 位')
          if (form.password !== form.confirmPassword) throw new Error('两次输入的密码不一致')
          if (emailVerifyEnabled && !form.verifyCode) throw new Error('请输入邮箱验证码')
          const data = await window.anyu.register({ email: form.email, password: form.password, verify_code: form.verifyCode || undefined, invitation_code: form.invitationCode || undefined, promo_code: form.promoCode || undefined })
          state.user = data.user; await bootstrap()
        } else if (view === 'forgot') {
          form.resetEmail = document.querySelector('#reset-email')?.value.trim() || ''
          if (!form.resetEmail) throw new Error('请输入注册邮箱')
          const result = await window.anyu.forgotPassword({ email: form.resetEmail })
          state.authNotice = result?.message || '如果邮箱已注册，重置链接会很快发送到你的邮箱。'
        } else if (view === 'reset') {
          form.resetEmail = document.querySelector('#reset-email')?.value.trim() || ''; form.resetToken = document.querySelector('#reset-token')?.value.trim() || ''; form.newPassword = document.querySelector('#new-password')?.value || ''; form.confirmPassword = document.querySelector('#confirm-new-password')?.value || ''
          if (!form.resetEmail || !form.resetToken) throw new Error('请输入邮箱和重置令牌')
          if (form.newPassword.length < 6) throw new Error('新密码至少需要 6 位')
          if (form.newPassword !== form.confirmPassword) throw new Error('两次输入的新密码不一致')
          const result = await window.anyu.resetPassword({ email: form.resetEmail, token: form.resetToken, new_password: form.newPassword })
          state.authNotice = result?.message || '密码已更新，请使用新密码登录。'; state.authView = 'login'; form.password = ''; form.newPassword = ''; form.confirmPassword = ''
        }
      } catch (error) { state.error = errorText(error) || '操作失败，请检查网络和输入' }
      finally { state.authBusy = false; render() }
    })
    button?.addEventListener('click', async () => { if (two) { state.error = ''; state.authBusy = true; button.disabled = true; try { const data = await window.anyu.login2fa({ temp_token: two.temp_token, totp_code: document.querySelector('#totp').value.trim() }); state.user = data.user; state.twoFactor = null; await bootstrap(); render() } catch (error) { state.authBusy = false; state.error = errorText(error) || '验证失败'; render() } } })
    document.querySelector('#send-code')?.addEventListener('click', async () => { if (state.authBusy || authCodeCooldown()) return; const email = document.querySelector('#email')?.value.trim() || ''; if (!email) { state.error = '请先填写邮箱'; render(); return } state.authBusy = true; try { await window.anyu.sendVerifyCode({ email }); state.authNotice = '验证码已发送，请检查邮箱。'; startAuthCodeCooldown() } catch (error) { state.error = errorText(error) || '验证码发送失败' } finally { state.authBusy = false; render() } })
    document.querySelector('#show-login')?.addEventListener('click', () => { state.authView = 'login'; state.error = ''; state.authNotice = ''; renderLogin() })
    document.querySelector('#show-register')?.addEventListener('click', () => { state.authView = 'register'; state.error = ''; state.authNotice = ''; renderLogin() })
    document.querySelector('#show-forgot')?.addEventListener('click', () => { state.authView = 'forgot'; state.error = ''; state.authNotice = ''; renderLogin() })
    document.querySelector('#show-reset')?.addEventListener('click', () => { state.authView = 'reset'; state.error = ''; state.authNotice = ''; renderLogin() })
    document.querySelector('#open-site')?.addEventListener('click', () => window.anyu.openExternal(view === 'register' ? 'http://127.0.0.1:9090/register' : 'http://127.0.0.1:9090/forgot-password'))
  }

  function keyItemsFromResponse(data) {
    if (Array.isArray(data)) return data
    const candidates = [data?.items, data?.keys, data?.data, data?.results, data?.records]
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate
      if (candidate && typeof candidate === 'object') {
        for (const nested of [candidate.items, candidate.keys, candidate.results, candidate.records]) if (Array.isArray(nested)) return nested
      }
    }
    return []
  }
  async function loadKeys() {
    const result = []; let page = 1; let total = Infinity
    while (result.length < total && page <= 50) {
      const data = await api(`/keys?page=${page}&page_size=100&sort_by=created_at&sort_order=desc`)
      const items = keyItemsFromResponse(data)
      if (Array.isArray(items)) result.push(...items)
      total = Number(data?.total ?? data?.pagination?.total ?? result.length)
      if (!items.length) break; page++
    }
    const unique = new Map()
    for (const item of result) {
      if (!item || item.id == null) continue
      const id = String(item.id)
      if (unique.has(id)) continue
      const displayName = keyDisplayName({ ...item, id })
      const rawStatus = item.status
      const status = cleanDisplayText(rawStatus?.label || rawStatus?.name || rawStatus?.status || rawStatus)
      unique.set(id, { ...item, id: item.id, name: displayName, title: displayName, status })
    }
    state.keys = [...unique.values()]
    state.keysLoaded = true
    if (!state.selectedKey || !state.keys.some((key) => Number(key.id) === state.selectedKey)) state.selectedKey = Number(state.keys[0]?.id || 0)
    localStorage.setItem('anyu.selectedKey', String(state.selectedKey || ''))
  }
  async function loadRouteData() {
    state.accessMode = 'auto'
    state.selectedKey = 0
    state.keys = []
    const [models, groups] = await Promise.all([loadCatalog(), loadAvailableAgentGroups()])
    const groupById = new Map(groups.map((group) => [Number(group.id), group]))
    state.catalogGroups = groups.length ? groups.filter((group) => models.some((model) => Number(model.groupId) === Number(group.id))) : [...new Map(models.filter((model) => model.groupId > 0).map((model) => [Number(model.groupId), { id: Number(model.groupId), name: model.groupName || '默认分组', pool_type: 'stable' }])).values()]
    state.catalog = groups.length ? models.map((model) => {
      const group = groupById.get(Number(model.groupId))
      if (!group) return model
      return {
        ...model,
        groupName: group.name || model.groupName,
        groupRate: Number(group.rate_multiplier ?? model.groupRate ?? 1),
        effectiveRate: Number(group.effective_rate_multiplier ?? model.effectiveRate ?? group.rate_multiplier ?? 1),
        rateSource: group.rate_source || '',
        poolType: group.pool_type || 'stable',
        displayBrand: group.display_brand || '',
        capacity: group.capacity || null
      }
    }).filter((model) => model.groupId > 0 && state.catalogGroups.some((group) => Number(group.id) === Number(model.groupId))) : models.filter((model) => model.groupId > 0)
    const currentGroup = state.catalogGroups.find((group) => Number(group.id) === Number(state.selectedGroupId))
    if (!currentGroup) state.selectedGroupId = Number(state.catalogGroups[0]?.id || 0)
    if (typeof chooseModel === 'function') chooseModel()
    if (!state.catalog.length) throw new Error('当前账号没有可用于 AnyuAgent 的聊天分组和模型')
  }

  // 与网页端 API 密钥页面共用正式分组目录，桌面端只显示稳定号池和特价号池。
  async function loadAvailableAgentGroups() {
    if (typeof api !== 'function') return []
    const data = await api('/groups/available')
    const groups = Array.isArray(data) ? data : data?.items || data?.groups || []
    return groups.filter((group) => {
      const type = String(group?.pool_type || '').toLowerCase()
      const status = String(group?.status || '').toLowerCase()
      return (!status || status === 'active') && type !== 'visual'
    }).map((group) => ({ ...group, id: Number(group.id) }))
  }
  function keyPlatform(key = selectedKey()) {
    return String(key?.group?.platform || key?.groups?.[0]?.platform || key?.platform || key?.provider || '').trim()
  }
  function normalizeModel(model, platform = '') {
    const modelId = String(model?.model_id || model?.modelId || model?.id || model?.name || '').replace(/^models\//, '').trim()
    if (!modelId) return null
    const lower = `${modelId} ${platform} ${model?.api || model?.protocol || ''}`.toLowerCase()
    const apiName = lower.includes('gemini') || lower.includes('google') ? 'google-generative-ai' : lower.includes('claude') || lower.includes('anthropic') ? 'anthropic-messages' : 'openai-completions'
    const api = canonicalApi(model?.api, apiName)
    const groupId = Number(model?.group_id || model?.groupId || 0)
    const routeId = Number.isSafeInteger(groupId) && groupId > 0 ? `${api}:${groupId}:${modelId}` : modelId
    const capabilities = modelCapabilities(model, modelId, api)
    // 思考强度与模型族匹配都交给共用模板库，接口显式声明优先。
    const thinking = thinkingPresets.resolveThinking({
      id: modelId,
      name: model?.display_name || model?.displayName || model?.name || '',
      api,
      reasoning: model?.reasoning ?? model?.supports_reasoning ?? model?.supportsReasoning,
      thinkingLevels: model?.thinkingLevels || model?.thinking_levels || model?.reasoning_levels,
      thinkingLevelMap: model?.thinkingLevelMap || model?.thinking_level_map || model?.reasoning_effort_map || model?.reasoningEffortMap
    })
    return {
      id: routeId, modelId, groupId, groupName: model?.group_name || model?.groupName || '',
      name: model?.display_name || model?.displayName || model?.name || modelId, api,
      groupRate: Number(model?.group_rate_multiplier ?? model?.groupRate ?? 1),
      effectiveRate: Number(model?.effective_rate_multiplier ?? model?.effectiveRate ?? 1),
      platform: String(model?.platform || model?.provider_platform || '').trim(),
      provider: providerForApi(api, groupId), reasoning: thinking.reasoning, thinkingLevels: thinking.levels, thinkingLevelMap: thinking.map,
      // 模板名与默认档位一起带上，供输入栏的强度菜单展示"档位是怎么来的"。
      thinkingTemplate: thinking.templateLabel, thinkingDefault: thinking.defaultLevel, thinkingSource: thinking.source,
      input: capabilities.input, supportsImages: capabilities.supportsImages,
      supportsTools: model?.supportsTools ?? model?.supports_tools ?? model?.capabilities?.tools,
      permissionMode: model?.permissionMode || model?.permission_mode || '',
      contextWindow: model?.context_window || model?.contextWindow || 128000,
      maxTokens: model?.max_tokens || model?.maxTokens || 16384
    }
  }
  async function loadCatalog() {
    const data = await api('/integrations/anyu-agent/catalog')
    const models = (data?.models || data?.items || []).map((item) => normalizeModel(item)).filter(Boolean)
    if (!models.length) throw new Error('当前账号没有可用于 AnyuAgent 的文本模型，请联系管理员检查分组和协议权限')
    state.catalogSource = 'AnyuAgent 自动目录'
    return models
  }
  async function loadCatalogForKey(keyId) {
    if (!keyId) throw new Error('没有选择密钥，无法读取对应模型')
    const key = state.keys.find((item) => Number(item.id) === Number(keyId))
    const platform = keyPlatform(key)
    // This endpoint proxies the selected key to the gateway's /v1/models.
    // Do not fall back to the user-wide catalog: that would expose models
    // belonging to another key and can make Pi start with an invalid route.
    const data = await window.anyu.piKeyModels(keyId)
    const entries = data?.items || data?.models || data?.data || (Array.isArray(data) ? data : [])
    const models = entries.map((item) => normalizeModel(item, platform)).filter(Boolean)
    const unique = [...new Map(models.map((item) => [`${item.api}:${item.id}`, item])).values()]
    if (!unique.length) throw new Error('当前密钥没有可用的聊天模型，请在 Anyu 中检查该密钥的分组和模型权限')
    state.catalogSource = '当前密钥模型'
    return unique
  }
  function keyCapabilityGroupIds(kind) {
    if (state.accessMode === 'auto') return []
    const key = selectedKey() || {}
    const names = kind === 'video'
      ? ['video_group_ids', 'videoGroupIDs', 'videoGroupIds', 'video_groups', 'videoGroups']
      : ['image_group_ids', 'imageGroupIDs', 'imageGroupIds', 'image_groups', 'imageGroups']
    // 历史接口有时返回分组对象而不是 ID 数组，统一抽取 ID 后再过滤。
    const groupId = (value) => Number(typeof value === 'object' ? value?.id ?? value?.group_id ?? value?.groupId : value)
    const direct = names.flatMap((name) => Array.isArray(key[name]) ? key[name].map(groupId) : []).filter(Number.isFinite)
    if (direct.length) return [...new Set(direct.map(Number).filter(Number.isFinite))]
    // Older keys expose only group_ids. Reuse those IDs only when the
    // directory proves that the group actually has this media capability;
    // generic text groups therefore cannot leak into the media picker.
    const generic = Array.isArray(key.group_ids) ? key.group_ids : Array.isArray(key.groupIds) ? key.groupIds : []
    return [...new Set(generic.map(Number).filter((id) => {
      const group = state.skillGroups.find((item) => Number(item.id) === id)
      if (!group) return false
      return skillModelsForGroup(group, kind).length > 0
    }))]
  }
  function mediaModelCapability(model) {
    const raw = [model?.capability, model?.capabilities, model?.type, model?.kind, model?.media_type, model?.mediaType, model?.model_type, model?.modelType]
    const values = raw.flatMap((value) => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.keys(value).filter((key) => value[key]) : [value])
      .map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    if (values.some((value) => /video|vid[e]?o|movie|motion|animation/.test(value))) return 'video'
    if (values.some((value) => /image|picture|photo|vision/.test(value))) return 'image'
    if (model?.supports_video === true || model?.supportsVideo === true) return 'video'
    if (model?.supports_image === true || model?.supportsImage === true) return 'image'
    const name = String(model?.name || model?.model || model?.model_id || model?.modelId || model?.id || '').toLowerCase()
    if (/(?:video|veo|sora|seedance|grok[-_ ]?imagine|runway|kling|hailuo|wan2?\.\d.*video|vidu|luma[-_ ]?dream|cogvideo|minimax[-_ ]?video)/.test(name)) return 'video'
    return ''
  }
  function groupModels(group) {
    const rawModels = group?.models
    const models = Array.isArray(rawModels) ? rawModels : rawModels && typeof rawModels === 'object' ? Object.entries(rawModels).map(([name, value]) => ({ ...(value && typeof value === 'object' ? value : {}), name: value?.name || name })) : []
    const nested = ['video_models', 'videoModels', 'image_models', 'imageModels', 'available_models', 'availableModels']
      .flatMap((name) => Array.isArray(group?.[name]) ? group[name] : [])
    return [...models, ...nested].filter((model, index, all) => {
      const id = String(model?.name || model?.model || model?.model_id || model?.modelId || model?.id || '').trim().toLowerCase()
      return id && all.findIndex((item) => String(item?.name || item?.model || item?.model_id || item?.modelId || item?.id || '').trim().toLowerCase() === id) === index
    })
  }
  function legacyVideoModel(group) {
    const platform = String(group?.platform || group?.provider || '').trim().toLowerCase()
    if (!['grok', 'xai'].includes(platform)) return null
    return { name: 'grok-imagine-video-1.5', display_name: 'Grok Imagine Video 1.5', capability: 'video', duration_min: 1, duration_max: 15, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], max_reference_images: 1, uses_grok_fields: true }
  }
  function skillModelsForGroup(group, kind) {
    const models = groupModels(group).filter((model) => mediaModelCapability(model) === kind)
    if (kind === 'video' && !models.length) {
      const fallback = legacyVideoModel(group)
      if (fallback) return [fallback]
    }
    return models.map((model) => ({ ...model, capability: mediaModelCapability(model) || model.capability }))
  }
  function availableSkillGroups(kind) {
    const groups = state.skillGroups.filter((group) => {
      const active = !group.status || String(group.status).toLowerCase() === 'active'
      if (!active || group.data_sharing_enabled) return false
      if (kind === 'image' && !group.allow_image_generation) return false
      return skillModelsForGroup(group, kind).length > 0
    })
    const ids = keyCapabilityGroupIds(kind)
    return ids.length ? groups.filter((group) => ids.includes(Number(group.id))) : groups
  }
  function skillModels(kind) {
    const groups = availableSkillGroups(kind)
    return groups.flatMap((group) => skillModelsForGroup(group, kind).map((model) => ({ ...model, name: String(model.name || model.model || model.model_id || model.modelId || model.id).trim(), groupId: Number(group.id), groupName: group.name })))
  }
  function ensureSkillSelection() {
    for (const kind of ['image', 'video']) {
      const config = state.skillConfigs[kind]
      const models = skillModels(kind)
      const preferredGroup = Number(config.groupId)
      const groupModels = preferredGroup ? models.filter((model) => Number(model.groupId) === preferredGroup) : models
      const selectedModel = groupModels.find((model) => model.name === config.model)
      const nextModel = selectedModel || groupModels[0] || models[0]
      if (nextModel) { config.groupId = Number(nextModel.groupId); config.model = nextModel.name }
      else { config.groupId = 0; config.model = '' }
    }
  }
  async function loadSkillGroups(options = {}) {
    const silent = options.silent !== false
    if (state.skillLoadPromise) return state.skillLoadPromise
    state.skillLoadPromise = (async () => {
      try {
        const data = await window.anyu.skillsGroups()
        const groups = skillGroupsFromResponse(data)
        state.skillGroups = Array.isArray(groups) ? groups : []
        state.skillError = ''
        ensureSkillSelection()
        return true
      } catch (error) {
        state.skillGroups = []
        ensureSkillSelection()
        state.skillError = errorText(error) || '技能目录加载失败'
        // 技能目录是独立能力，默认不覆盖聊天错误；设置页主动加载时再提示。
        if (!silent) state.error = state.skillError
        return false
      } finally {
        state.skillLoadPromise = null
      }
    })()
    return state.skillLoadPromise
  }
  function skillGroupsFromResponse(data) {
    if (Array.isArray(data)) return data
    const candidates = [data?.items, data?.groups, data?.data, data?.result]
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate
      if (candidate && typeof candidate === 'object') {
        for (const nested of [candidate.items, candidate.groups, candidate.records]) if (Array.isArray(nested)) return nested
      }
    }
    return []
  }
  function pluginList() {
    const value = state.pluginState?.installed
    return Array.isArray(value) ? value : []
  }
  function pluginMarketplaceList() {
    const value = state.pluginState?.marketplace
    return Array.isArray(value) ? value : []
  }
  function pluginId(item) { return String(item?.id || item?.pluginId || '') }
  function pluginTitle(item) { return String(item?.displayName || item?.display_name || item?.name || pluginId(item) || '未命名插件') }
  function pluginDescription(item) { return String(item?.description || '面向 AnyuAgent 的可复用 Skill 能力。') }
  function pluginPublisher(item) {
    const publisher = item?.publisher
    return typeof publisher === 'object' ? String(publisher.name || publisher.id || '未知发布者') : String(publisher || '未知发布者')
  }
  const PLUGIN_PRIMARY_CATEGORIES = [
    { value: 'all', label: '全部' },
    { value: 'ecommerce', label: '电商' },
    { value: 'comic-drama', label: '漫剧' }
  ]
  function normalizePluginCategory(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
    if (['ecommerce', 'e-commerce', 'ecommerce-plugin', '电商', '电商类'].includes(normalized)) return 'ecommerce'
    if (['comic-drama', 'comicdrama', 'comic', 'comic-plugin', '漫剧', '漫劇'].includes(normalized)) return 'comic-drama'
    return normalized
  }
  function pluginCategories(item) {
    const categories = Array.isArray(item?.categories) ? item.categories : (Array.isArray(item?.tags) ? item.tags : [])
    return categories.map((value) => String(value || '').trim()).filter(Boolean)
  }
  function pluginCategoryLabel(value) {
    const normalized = normalizePluginCategory(value)
    return PLUGIN_PRIMARY_CATEGORIES.find((category) => category.value === normalized)?.label || String(value || '')
  }
  function pluginMatchesCategory(item, category) {
    if (!category || category === 'all') return true
    return pluginCategories(item).some((value) => normalizePluginCategory(value) === category)
  }
  function pluginMatches(item, query) {
    if (!query) return true
    const haystack = [pluginTitle(item), pluginDescription(item), pluginPublisher(item), ...(item?.keywords || []), ...pluginCategories(item), ...pluginCategories(item).map(pluginCategoryLabel)].join(' ').toLowerCase()
    return haystack.includes(query.toLowerCase())
  }
  function comparePluginVersions(left, right) {
    const parse = (value) => String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
    const a = parse(left); const b = parse(right)
    if (!a || !b) return 0
    for (let index = 1; index <= 3; index += 1) {
      const delta = Number(a[index]) - Number(b[index])
      if (delta) return delta
    }
    if (!a[4] && b[4]) return 1
    if (a[4] && !b[4]) return -1
    return String(a[4] || '').localeCompare(String(b[4] || ''), 'en', { numeric: true })
  }
  function installedPlugin(id) { return pluginList().find((item) => pluginId(item) === id) }
  function businessPlugin(skill) {
    const id = skill === 'feedback' ? 'tmall-public-feedback-analysis' : skill === 'detail-reference' ? 'tmall-detail-reference' : skill === 'shop-monitor' ? 'tmall-shop-monitor' : 'ai-image-analysis'
    const plugin = installedPlugin(id)
    return plugin && plugin.enabled !== false ? plugin : null
  }
  function pluginPublishStatusLabel(item) {
    const status = String(item?.publishStatus || '').toLowerCase()
    if (status === 'submitted' || status === 'pending' || status === 'review') return '审核中'
    if (status === 'approved' || status === 'published' || item?.visibility === 'public') return '已发布'
    if (status === 'rejected') return '需修改'
    return '仅自己可用'
  }
  function pluginOperationFor(id) {
    const entries = Object.values(state.pluginOperations || {}).filter((entry) => String(entry?.pluginId || '') === String(id || ''))
    return entries.sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0))[0] || null
  }
  function pluginOperationMarkup(operation, compact = false) {
    if (!operation) return ''
    const percent = Math.max(0, Math.min(100, Number(operation.percent) || 0))
    const indeterminate = Boolean(operation.indeterminate)
    const actionLabel = operation.action === 'uninstall' ? '卸载' : '安装'
    const phaseLabel = operation.phase === 'complete' ? `${actionLabel}完成` : operation.phase === 'error' ? `${actionLabel}失败` : String(operation.message || `${actionLabel}中`)
    const terminal = ['complete', 'error', 'dependency-ready', 'dependency-manual'].includes(operation.phase)
    return `<div class="plugin-progress ${operation.phase === 'error' ? 'is-error' : ''} ${operation.phase === 'complete' || operation.phase === 'dependency-ready' ? 'is-complete' : ''} ${operation.phase === 'dependency-manual' ? 'is-manual' : ''} ${indeterminate ? 'is-indeterminate' : ''} ${compact ? 'is-compact' : ''}" role="status" data-terminal="${terminal}"><div class="plugin-progress-track"><span style="width:${percent}%"></span></div><div class="plugin-progress-copy"><span>${esc(phaseLabel)}</span>${indeterminate ? '' : `<strong>${percent}%</strong>`}</div></div>`
  }
  function pluginOperationsMarkup() {
    const entries = Object.values(state.pluginOperations || {}).filter((entry) => !entry?.pluginId)
    const operation = entries.sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0))[0]
    return operation ? `<div class="plugin-operation-banner"><span class="plugin-operation-dot"></span>${pluginOperationMarkup(operation)}</div>` : ''
  }
  function pluginCardMarkup(item, mode) {
    const id = pluginId(item)
    if (!id) return ''
    const installed = mode === 'installed' || installedPlugin(id)
    const record = installedPlugin(id)
    const operation = pluginOperationFor(id)
    const operationActive = operation && !['complete', 'error', 'dependency-ready', 'dependency-manual'].includes(operation.phase)
    const display = mode === 'marketplace' ? item : (record || item)
    const version = String(display?.version || '—')
    const categories = pluginCategories(display).slice(0, 3).map((value) => `<span class="plugin-chip">${esc(pluginCategoryLabel(value))}</span>`).join('')
    const updateAvailable = mode === 'marketplace' && record && comparePluginVersions(item?.version, record.version) > 0
    const updateAction = updateAvailable ? `<button class="plugin-action active" data-plugin-action="update" data-plugin-id="${esc(id)}">更新</button>` : ''
    const publishAction = mode === 'installed' && record?.source === 'local'
      ? (record.publishStatus && record.publishStatus !== 'private' ? `<span class="plugin-publish-state">${esc(pluginPublishStatusLabel(record))}</span>` : `<button class="plugin-action" data-plugin-action="publish" data-plugin-id="${esc(id)}">发布</button>`)
      : ''
    const rollbackVersion = Array.isArray(record?.versions)
      ? record.versions.find((entry) => String(entry?.version || '') && String(entry.version) !== version)?.version || ''
      : ''
    const rollbackAction = mode === 'installed' && rollbackVersion
      ? `<button class="plugin-action" data-plugin-action="rollback" data-plugin-id="${esc(id)}" data-plugin-version="${esc(rollbackVersion)}">回滚 v${esc(rollbackVersion)}</button>`
      : ''
    const action = installed
      ? `${updateAction}<button class="plugin-action ${record?.enabled === false ? '' : 'active'}" data-plugin-action="toggle" data-plugin-id="${esc(id)}" ${operationActive ? 'disabled' : ''}>${record?.enabled === false ? '启用' : '已启用'}</button>${rollbackAction}${publishAction}<button class="plugin-text-action" data-plugin-action="uninstall" data-plugin-id="${esc(id)}" ${operationActive ? 'disabled' : ''}>卸载</button>`
      : `<button class="plugin-action active" data-plugin-action="install" data-plugin-id="${esc(id)}" ${operationActive ? 'disabled' : ''}>${operationActive ? '处理中' : '安装'}</button>`
    const trust = (record || item)?.verified || (record || item)?.publisher?.verified ? '<span class="plugin-badge verified">已验证</span>' : '<span class="plugin-badge">社区</span>'
    const dependencyStatus = String(record?.dependencyStatus || '')
    const optionalMissing = Array.isArray(record?.dependencyDetail?.optionalMissing) ? record.dependencyDetail.optionalMissing : []
    const dependencyDetail = record?.dependencyDetail || {}
    const dependencyError = dependencyDetail.error || (Array.isArray(dependencyDetail.failures) ? dependencyDetail.failures.map((entry) => `${entry.dependency}: ${entry.message}`).join('；') : '')
    const dependencyBadge = dependencyStatus === 'pending' ? '<span class="plugin-badge">环境准备中</span>' : dependencyStatus === 'manual' ? '<span class="plugin-badge">需检查环境</span>' : optionalMissing.length ? '<span class="plugin-badge">核心环境已就绪</span>' : ''
    const dependencyRetry = dependencyStatus === 'manual' ? `<div class="plugin-dependency-help"><span>${esc(dependencyError || '依赖未安装完成，请检查网络或权限后重试')}</span><button type="button" class="ghost" data-plugin-action="retry-dependencies" data-plugin-id="${esc(id)}">重试环境安装</button></div>` : ''
    return `<article class="plugin-card"><div class="plugin-card-top"><div class="plugin-icon">${esc(pluginTitle(item).slice(0, 1).toUpperCase())}</div><div class="plugin-card-main"><div class="plugin-card-title"><strong>${esc(pluginTitle(item))}</strong>${trust}${dependencyBadge}</div><p>${esc(pluginDescription(item))}</p><div class="plugin-meta"><span>${esc(pluginPublisher(item))}</span><span>v${esc(version)}</span>${categories}</div>${pluginOperationMarkup(operation, true)}${dependencyRetry}</div></div><div class="plugin-card-actions">${action}</div></article>`
  }
  function pluginMarketMarkup() {
    const tab = state.pluginMarketTab
    const category = PLUGIN_PRIMARY_CATEGORIES.some((entry) => entry.value === state.pluginMarketCategory) ? state.pluginMarketCategory : 'all'
    const query = String(state.pluginMarketQuery || '').trim()
    const installed = pluginList()
    const marketplace = pluginMarketplaceList().filter((item) => pluginMatchesCategory(item, category) && pluginMatches(item, query))
    const uploads = installed.filter((item) => item.visibility !== 'public' || item.source === 'local')
    const items = tab === 'installed' ? installed.filter((item) => pluginMatchesCategory(item, category) && pluginMatches(item, query)) : tab === 'uploads' ? uploads.filter((item) => pluginMatchesCategory(item, category) && pluginMatches(item, query)) : marketplace
    const empty = tab === 'marketplace' ? '市场暂时没有可用目录。你可以导入自己的 .anyu-plugin.zip，安装后立即使用。' : tab === 'installed' ? '还没有安装插件。' : '还没有本地上传的插件。'
    const publish = state.pluginPublishOpen ? `<div class="modal-backdrop plugin-publish-backdrop"><section class="permission-modal plugin-publish-modal"><div class="settings-head"><div><div class="modal-kicker">Publish Plugin</div><h3>发布自定义插件</h3></div><button class="icon-button" id="plugin-publish-close" title="关闭">×</button></div><p>发布前会再次扫描插件包。公开插件将进入审核队列；私有插件仅对你的账号可见。</p><label class="plugin-form-label" for="plugin-publisher-name">发布者</label><input class="modal-input" id="plugin-publisher-name" value="${esc(state.pluginPublishName)}" placeholder="例如：Anyu Community"><label class="plugin-form-label" for="plugin-publish-visibility">可见性</label><select class="modal-input" id="plugin-publish-visibility"><option value="public" ${state.pluginPublishVisibility === 'public' ? 'selected' : ''}>公开发布 · 提交审核</option><option value="private" ${state.pluginPublishVisibility === 'private' ? 'selected' : ''}>私有自定义插件 · 仅自己使用</option></select><div class="modal-actions"><button class="ghost" id="plugin-publish-cancel">取消</button><button class="primary modal-primary" id="plugin-publish-submit" ${state.pluginPublishLoading ? 'disabled' : ''}>${state.pluginPublishLoading ? '发布中…' : '确认发布'}</button></div></section></div>` : ''
    const categoryTabs = PLUGIN_PRIMARY_CATEGORIES.map((entry) => `<button class="plugin-category-tab ${category === entry.value ? 'active' : ''}" data-plugin-category="${esc(entry.value)}" role="tab" aria-selected="${category === entry.value ? 'true' : 'false'}">${esc(entry.label)}</button>`).join('')
    return `<section class="settings-section settings-plugin-market-section"><div class="plugin-market-panel"><header class="plugin-market-head"><div><h2>发现和管理插件</h2><p>安装社区插件，或导入你自己制作的 Agent Skill。</p></div></header><div class="plugin-market-toolbar"><div class="plugin-market-filters"><div class="plugin-tabs"><button class="plugin-tab ${tab === 'marketplace' ? 'active' : ''}" data-plugin-tab="marketplace">发现市场</button><button class="plugin-tab ${tab === 'installed' ? 'active' : ''}" data-plugin-tab="installed">已安装 <span>${installed.length}</span></button><button class="plugin-tab ${tab === 'uploads' ? 'active' : ''}" data-plugin-tab="uploads">我的上传 <span>${uploads.length}</span></button></div><div class="plugin-category-tabs" role="tablist" aria-label="插件一级类目">${categoryTabs}</div></div><div class="plugin-tools"><input id="plugin-search" value="${esc(state.pluginMarketQuery)}" placeholder="搜索插件、Skill 或发布者" aria-label="搜索插件"><button class="ghost" id="plugin-import">导入插件</button></div></div>${state.pluginMarketError ? `<div class="plugin-market-error">${esc(state.pluginMarketError)}</div>` : ''}${pluginOperationsMarkup()}<div class="plugin-market-content">${state.pluginMarketLoading ? '<div class="plugin-market-empty">正在同步插件目录…</div>' : items.length ? `<div class="plugin-grid">${items.map((item) => pluginCardMarkup(item, tab === 'installed' || tab === 'uploads' ? 'installed' : 'marketplace')).join('')}</div>` : `<div class="plugin-market-empty"><strong>${esc(empty)}</strong><span>插件会以版本目录安装，更新失败时可以回滚到上一版本。</span>${tab === 'marketplace' ? '<button class="primary" id="plugin-import-empty">导入本地插件</button>' : ''}</div>`}</div><footer class="plugin-market-foot"><span>${installed.length} 个已安装插件 · 本地注册表已保护</span><span>v1 仅支持 skills-only 插件</span></footer></div></section>${publish}`
  }
  async function loadPluginMarket() {
    state.pluginMarketLoading = true; state.pluginMarketError = ''; scheduleAppRender()
    try {
      const installed = await window.anyu.pluginState()
      const local = installed?.installed || []
      let marketplace = []
      try { marketplace = await window.anyu.pluginMarketplace() } catch (error) { state.pluginMarketError = errorText(error) || '在线插件目录加载失败，已显示本地插件' }
      const merged = new Map((Array.isArray(marketplace) ? marketplace : marketplace?.items || []).map((item) => [pluginId(item), item]))
      for (const item of local) if (!merged.has(pluginId(item))) merged.set(pluginId(item), { ...item, source: item.source || 'local' })
      state.pluginState = { installed: local, marketplace: [...merged.values()] }
    } catch (error) { state.pluginMarketError = errorText(error) || '插件目录加载失败' }
    state.pluginMarketLoading = false; scheduleAppRender()
  }
  async function restartAgentWithPlugins() {
    // 当前任务完成后再加载新插件目录，避免安装或禁用插件打断正在输出的回复。
    if (state.loading || state.skillBusy) {
      state.pendingAgentRestart = true
      return
    }
    if (!state.model) {
      state.error = '插件已更新；选择模型后启动 Agent 即可生效'
      return
    }
    try { await startAgent(state.sessionPath) } catch (error) { state.error = errorText(error) || '插件变更后 Agent 重启失败' }
  }
  async function handlePluginAction(action, id, version = '') {
    const current = installedPlugin(id)
    state.pluginMarketError = ''
    try {
      if (action === 'publish') {
        state.pluginPublishId = id
        state.pluginPublishName = pluginPublisher(current) === '本地用户' ? '' : pluginPublisher(current)
        state.pluginPublishVisibility = 'public'
        state.pluginPublishOpen = true
        renderApp()
        return
      }
      if (action === 'install' || action === 'update') {
        const item = pluginMarketplaceList().find((entry) => pluginId(entry) === id)
        if (!item) throw new Error('插件目录项已失效，请刷新市场')
        if (action === 'update' && current && comparePluginVersions(item.version, current.version) <= 0) throw new Error('当前已是最新版本')
        await window.anyu.pluginInstallMarketplace({ id, downloadUrl: item.downloadUrl || item.download_url, sha256: item.sha256, scope: 'user' })
      } else if (action === 'retry-dependencies') {
        await window.anyu.pluginRetryDependencies(id)
      } else if (action === 'toggle') {
        await window.anyu.pluginSetEnabled({ id, enabled: current?.enabled === false })
      } else if (action === 'rollback') {
        if (!version) throw new Error('没有可用的回滚版本')
        if (!window.confirm(`确认将“${pluginTitle(current)}”回滚到 v${version} 吗？`)) return
        await window.anyu.pluginRollback({ id, version })
      } else if (action === 'uninstall') {
        if (!window.confirm(`确认卸载“${pluginTitle(current)}”吗？`)) return
        await window.anyu.pluginUninstall(id)
      }
      const installed = await window.anyu.pluginState(); state.pluginState = { ...state.pluginState, installed: installed?.installed || [] }
      // 安装完成后停留在当前页面，不强制跳转或重启正在运行的 Agent；
      // 新插件会在下一条消息前按需加载。
      if (state.settingsOpen && state.settingsSection === 'plugins') renderApp()
    } catch (error) { state.pluginMarketError = errorText(error) || '插件操作失败' }
    renderApp()
  }
  async function publishPlugin() {
    const record = installedPlugin(state.pluginPublishId)
    const publisherName = String(state.pluginPublishName || '').trim()
    if (!record || !publisherName) { state.pluginMarketError = '请填写发布者名称'; renderApp(); return }
    state.pluginPublishLoading = true; state.pluginMarketError = ''; renderApp()
    try {
      await window.anyu.pluginPublish({ id: state.pluginPublishId, publisherName, visibility: state.pluginPublishVisibility })
      state.pluginPublishOpen = false
      const installed = await window.anyu.pluginState()
      state.pluginState = { ...state.pluginState, installed: installed?.installed || [] }
      state.pluginMarketTab = 'uploads'
    } catch (error) { state.pluginMarketError = errorText(error) || '插件发布失败' }
    finally { state.pluginPublishLoading = false; renderApp() }
  }
  async function importPluginPackage() {
    state.pluginMarketError = ''; state.pluginMarketLoading = true; renderApp()
    try {
      const sourcePath = await window.anyu.pluginPickPackage()
      if (!sourcePath) return
      const scan = await window.anyu.pluginScan(sourcePath)
      const warnings = Array.isArray(scan.warnings) && scan.warnings.length ? `\n\n安全提示：\n${scan.warnings.map((warning) => `· ${warning}`).join('\n')}` : ''
      const accepted = window.confirm(`准备安装“${pluginTitle(scan.manifest)}” v${scan.manifest.version}。\n\n${pluginDescription(scan.manifest)}${warnings}\n\n确认后插件会以本地私有插件启用。`)
      if (!accepted) return
      await window.anyu.pluginInstallLocal({ path: sourcePath, scope: 'user', visibility: 'private' })
      const installed = await window.anyu.pluginState(); state.pluginState = { ...state.pluginState, installed: installed?.installed || [] }; state.pluginMarketTab = 'installed'
      await restartAgentWithPlugins()
    } catch (error) { state.pluginMarketError = errorText(error) || '插件导入失败' }
    finally { state.pluginMarketLoading = false; renderApp() }
  }
  function protocolLabel(model) {
    const group = cleanDisplayText(model?.groupName || '')
    let protocol = ''
    if (model?.api === 'anthropic-messages') protocol = 'Claude / Anthropic'
    else if (model?.api === 'google-generative-ai' || model?.api === 'google-vertex') protocol = 'Gemini / Google'
    const name = String(model?.id || '').toLowerCase()
    if (!protocol) protocol = /deepseek|qwen|glm|通义|千问|豆包|doubao|moonshot|kimi|minimax|yi-|zhipu|baichuan|ernie|混元/.test(name) ? '国产模型' : 'GPT / OpenAI 兼容'
    return group ? `${group} · ${protocol}` : protocol
  }
  function modelProviderLabel(model) {
    const value = `${model?.modelId || model?.id || ''} ${model?.name || ''} ${model?.platform || ''} ${model?.api || ''}`.toLowerCase()
    if (model?.api === 'anthropic-messages' || /claude|anthropic/.test(value)) return 'Claude'
    if (model?.api === 'google-generative-ai' || /gemini|google/.test(value)) return 'Gemini'
    if (/deepseek/.test(value)) return 'DeepSeek'
    if (/qwen|通义|千问/.test(value)) return 'Qwen'
    if (/glm|智谱/.test(value)) return '智谱 GLM'
    if (/kimi|moonshot/.test(value)) return 'Kimi / Moonshot'
    if (/minimax/.test(value)) return 'MiniMax'
    if (/doubao|豆包/.test(value)) return '豆包'
    if (/grok/.test(value)) return 'Grok'
    if (/mistral/.test(value)) return 'Mistral'
    if (/llama|meta/.test(value)) return 'Meta Llama'
    if (/openai|gpt|codex|o[1-9]/.test(value) || model?.api?.startsWith('openai')) return 'OpenAI'
    return '其他模型'
  }
  function multiplierLabel(value) {
    const number = Number(value)
    return Number.isFinite(number) ? `×${number.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}` : '×1'
  }
  function groupRateMarkup(group) {
    const original = Number(group?.rate_multiplier ?? group?.groupRate ?? 1)
    const effective = Number(group?.effective_rate_multiplier ?? group?.effectiveRate ?? original)
    const changed = Number.isFinite(original) && Number.isFinite(effective) && Math.abs(original - effective) > 0.000001
    if (!changed) return `<strong>${multiplierLabel(effective)}</strong>`
    const source = String(group?.rate_source || '').toLowerCase()
    const sourceLabel = source === 'ranking' || source === 'benefit' ? '<em>排行权益</em>' : ''
    return `<s>${multiplierLabel(original)}</s><strong>${multiplierLabel(effective)}</strong>${sourceLabel}`
  }
  function groupCapacityLabel(group) {
    const capacity = group?.capacity
    if (!capacity) return ''
    const used = Number(capacity.concurrency_used)
    const max = Number(capacity.concurrency_max)
    if (Number.isFinite(max) && max > 0) return `并发 ${Number.isFinite(used) ? used : 0}/${max}`
    return ''
  }
  function activeCatalogGroup() {
    return state.catalogGroups.find((group) => Number(group.id) === Number(state.selectedGroupId)) || null
  }
  function chooseModel() {
    const groupModels = state.catalog.filter((item) => Number(item.groupId) === Number(state.selectedGroupId))
    if (!state.model || !groupModels.some((item) => item.id === state.model)) state.model = groupModels[0]?.id || state.catalog[0]?.id || ''
    localStorage.setItem('anyu.selectedModel', state.model)
    localStorage.setItem('anyu.selectedGroupId', String(Number(state.catalog.find((item) => item.id === state.model)?.groupId || state.selectedGroupId || 0)))
  }
  // 一步直达选模型后，把"当前分组"对齐到该模型所属分组：
  // 分组决定计费倍率与请求通道，跟着模型走才不会出现"模型在 A 组、计费按 B 组"的错位。
  function syncSelectedGroupToModel(modelId) {
    const item = state.catalog.find((entry) => entry.id === modelId)
    if (!item) return
    const groupId = Number(item.groupId) || 0
    if (groupId && groupId !== Number(state.selectedGroupId)) {
      state.selectedGroupId = groupId
      state.configRevision += 1
    }
    localStorage.setItem('anyu.selectedGroupId', String(groupId || Number(state.selectedGroupId) || 0))
  }
  async function activateModel(modelId) {
    if (state.switching || !state.catalog.some((item) => item.id === modelId)) return
    // 生成中的选择只影响下一条任务，当前 Pi 回合继续使用原模型。
    if (state.loading) {
      state.model = modelId
      syncSelectedGroupToModel(modelId)
      state.configRevision += 1
      state.modelMenuOpen = false
      state.groupMenuOpen = false
      localStorage.setItem('anyu.selectedModel', state.model)
      state.pendingAgentRestart = true
      renderApp()
      return
    }
    state.switching = true
    const previousPermissionMode = effectivePermissionMode()
    state.model = modelId
    syncSelectedGroupToModel(modelId)
    state.configRevision += 1
    state.modelMenuOpen = false
    state.groupMenuOpen = false
    localStorage.setItem('anyu.selectedModel', state.model)
    renderApp()
    // 切模型是"下一条任务才生效"的操作，界面已经按新模型重绘好了。
    // 下面只是把选择同步给 Pi，绝不能因为 Pi 不吭声就把输入栏锁住：
    // 以前这里直接用主进程的 15 秒超时，Pi 一旦不响应，点一下模型就冻结
    // 十几秒，看起来和卡死没有区别。
    const model = currentModel()
    const nextPermissionMode = state.permissionMode === 'auto' ? modelPermissionMode() : state.permissionMode
    try {
      if (state.permissionMode === 'auto' && previousPermissionMode !== nextPermissionMode) {
        await Promise.race([
          startAgent(state.sessionPath),
          new Promise((resolve) => setTimeout(resolve, MODEL_SWITCH_TIMEOUT_MS))
        ])
      } else {
        await piRequestWithTimeout({
          type: 'set_model', sessionKey: state.sessionPath,
          provider: model?.provider || providerForApi('openai-completions'),
          modelId: model?.modelId || state.model
        }, MODEL_SWITCH_TIMEOUT_MS)
      }
    } catch (error) { state.error = errorText(error) || '切换模型失败' }
    // 强度档位独立同步：它以前排在 set_model 后面共用同一个 try，set_model
    // 一失败（例如 Pi 没起来）就被整体跳过，于是 state.thinkingLevels 一直停在
    // 初始的 ['off']，输入栏那颗强度 pill 永久置灰点不动。
    // 同步部分（模板定档）当帧生效，Pi 的实际档位在后台覆盖，不占输入栏的锁。
    syncThinkingLevels().then(() => { if (state.user) renderApp() }).catch(() => {})
    state.switching = false
    renderApp()
  }
  async function activateGroup(groupId) {
    const group = state.catalogGroups.find((item) => Number(item.id) === Number(groupId))
    if (!group || state.switching || state.sessionSwitching) return
    const firstModel = state.catalog.find((item) => Number(item.groupId) === Number(group.id))
    if (!firstModel) {
      state.error = '当前分组暂无可用模型'
      state.groupMenuOpen = false
      state.groupMenuQuery = ''
      renderApp()
      return
    }
    const previousGroupId = Number(state.selectedGroupId)
    state.selectedGroupId = Number(group.id)
    if (previousGroupId !== state.selectedGroupId) state.configRevision += 1
    state.groupMenuOpen = false
    state.groupMenuQuery = ''
    localStorage.setItem('anyu.selectedGroupId', String(state.selectedGroupId))
    if (state.model === firstModel.id || state.catalog.some((item) => item.id === state.model && Number(item.groupId) === state.selectedGroupId)) {
      chooseModel()
      if (state.loading && previousGroupId !== state.selectedGroupId) state.pendingAgentRestart = true
      renderApp()
      return
    }
    await activateModel(firstModel.id)
  }
  function thinkingStorageKey(model = currentModel()) {
    return model ? `anyu.thinking.${model.provider || model.api || 'model'}.${model.id}` : 'anyu.thinking.default'
  }
  /**
   * 把一组档位落到状态上。同步函数：pill 必须能在同一帧就点亮，
   * 不能等 Pi 回话——Pi 不响应时那颗 pill 会一直灰着，看起来就是坏的。
   * 强度按模型分开记录，换模型时强度跟着模型走，互不干扰。
   */
  function applyThinkingLevels(model, levels) {
    const list = levels?.length ? [...new Set(levels)] : ['off']
    state.thinkingLevels = list
    // 没有用户记录时的默认档。模板自带每个模型族的合理默认（通常 medium），
    // 不再像过去那样一律顶到最高档——那样会在轻量模型上白烧时间和额度。
    const fallback = model?.thinkingDefault || thinkingPresets.pickDefault(list)
    const saved = localStorage.getItem(thinkingStorageKey(model))
    state.thinkingLevel = list.includes(saved) ? saved : fallback
    localStorage.setItem(thinkingStorageKey(model), state.thinkingLevel)
  }
  async function syncThinkingLevels() {
    const model = currentModel()
    // 第一步立刻用模板推断定档，界面马上可交互。
    applyThinkingLevels(model, modelThinkingLevels(model))
    try {
      // 第二步再拿 Pi 回报的实际档位覆盖（模板可能滞后于新模型）。
      // 加超时：Pi 不回应时退回模板推断的档位即可，不能把界面吊住。
      const result = await piRequestWithTimeout({ type: 'get_available_thinking_levels', sessionKey: state.sessionPath }, MODEL_SWITCH_TIMEOUT_MS)
      const live = thinkingPresets.normalizeLevels(result?.data?.levels)
      if (live.length) applyThinkingLevels(model, live)
    } catch {}
    // piState 为空说明当前根本没有活着的 Pi 进程，此时发 set_thinking_level
    // 只会白等满一次超时（以前 Pi 没起来也算"档位不一致"）。
    if (state.piState && state.piState.thinkingLevel !== state.thinkingLevel) {
      try { await piRequestWithTimeout({ type: 'set_thinking_level', sessionKey: state.sessionPath, level: state.thinkingLevel }, MODEL_SWITCH_TIMEOUT_MS) } catch {}
    }
  }
  let refreshSessionsPromise = null
  async function refreshSessions(shouldApply = () => true) {
    if (!refreshSessionsPromise) refreshSessionsPromise = window.anyu.piListSessions().finally(() => { refreshSessionsPromise = null })
    const sessions = await refreshSessionsPromise
    if (shouldApply()) state.sessions = sessions
    return sessions
  }
  // ---------- 多会话并行：每个会话的运行状态 ----------
  // 切换会话不再中止任务，后台会话继续跑；这里记录“谁在跑 / 谁完成了但没看”。
  function normalizeSessionKey(value) { return String(value || '').trim() }
  function markSessionRun(sessionPath, patch = {}) {
    const key = normalizeSessionKey(sessionPath)
    if (!key) return null
    const previous = state.sessionRuns[key] || { running: false, unread: false, updatedAt: 0 }
    const next = { ...previous, ...patch }
    next.updatedAt = Date.now()
    state.sessionRuns[key] = next
    return next
  }
  function forgetSessionRun(sessionPath) { delete state.sessionRuns[normalizeSessionKey(sessionPath)] }
  function isSessionRunning(sessionPath) {
    const key = normalizeSessionKey(sessionPath)
    if (!key) return false
    // 技能任务（生图/生视频/评价分析/测图）不走 Pi 运行状态，注册在 mediaActivity 里；
    // 之前切走会话后 switchSession 会覆盖 sessionLoadingPath，侧栏的“运行中”就丢了。
    if (mediaActivityForSession(sessionPath).length) return true
    // 当前会话以视图状态为准，后台会话看存档。
    if (key === normalizeSessionKey(state.sessionPath)) return Boolean(state.loading || state.runInProgress || state.activeRequest)
    return Boolean(state.sessionRuns[key]?.running)
  }
  function isSessionUnread(sessionPath) {
    const key = normalizeSessionKey(sessionPath)
    if (!key) return false
    // 正在看的会话永远不算未读。
    if (key === normalizeSessionKey(state.sessionPath)) return false
    return Boolean(state.sessionRuns[key]?.unread)
  }
  function bindSessionListItems(root) {
    if (root.dataset.sessionDelegated !== '1') {
      root.dataset.sessionDelegated = '1'
      root.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-workspace-toggle]')
        if (!toggle || !root.contains(toggle)) return
        event.preventDefault(); event.stopPropagation()
        const key = toggle.dataset.workspaceToggle || ''
        const items = toggle.parentElement?.querySelector('.session-workspace-items')
        const collapsing = !items?.hidden
        if (items) items.hidden = collapsing
        toggle.classList.toggle('is-collapsed', collapsing)
        toggle.parentElement?.classList.toggle('is-collapsed', collapsing)
        if (collapsing) collapsedWorkspaceGroups.add(key)
        else collapsedWorkspaceGroups.delete(key)
        persistCollapsedWorkspaces()
      })
    }
    root.querySelectorAll('.session').forEach((node) => {
      if (node.dataset.bound === '1') return
      node.dataset.bound = '1'
      node.addEventListener('click', () => switchSession(node.dataset.path))
      node.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); state.sessionMenu = { path: node.dataset.path, x: event.clientX, y: event.clientY }; renderApp() })
    })
    // 工作区分组折叠：局部 DOM 操作（hidden + 箭头旋转），不做整体重绘，
    // 避免列表滚动位置被打断（用户正浏览某个分组时点另一组的标题不应跳动）。
    root.querySelectorAll('[data-workspace-toggle]').forEach((node) => {
      if (node.dataset.bound === '1') return
      node.dataset.bound = '1'
    })
  }
  let sessionListNode = null
  let sessionListMarkup = ''
  function renderSessionList() {
    const list = document.querySelector('#session-list')
    if (!list) return false
    const markup = sessionWorkspaceGroupsMarkup()
    // 同一个节点且内容没变化时不重建 DOM，避免打断用户的鼠标交互与选中态。
    if (list === sessionListNode && sessionListMarkup === markup) return true
    // 重建 innerHTML 会把滚动位置归零：用户滚到列表下面点一条历史会话，
    // 列表却弹回最上面，看起来像“点错/被顶走”。这里先记下再还原。
    const scrollTop = Number(list.scrollTop || 0)
    const hadFocus = list.contains(document.activeElement)
    sessionListNode = list
    sessionListMarkup = markup
    list.innerHTML = markup
    list.scrollTop = scrollTop
    bindSessionListItems(list)
    if (hadFocus) list.querySelector('.session.active')?.focus?.({ preventScroll: true })
    // 不做 scrollIntoView：激活项不在视野时会把列表强行拽回去（尤其向上弹），
    // 用户滚到哪里列表就停在哪里，选中高亮本身已经足够定位。
    return true
  }
  function scheduleSessionListRender() {
    if (state.sessionRenderQueued) return
    state.sessionRenderQueued = true
    requestAnimationFrame(() => { state.sessionRenderQueued = false; renderSessionList() })
  }
  // 工作区分组折叠状态：按 workspaceKey 记忆，存 localStorage 跨启动保留。
  const collapsedWorkspaceGroups = (() => {
    try { return new Set(JSON.parse(localStorage.getItem('anyu.collapsedWorkspaces') || '[]')) } catch { return new Set() }
  })()
  function persistCollapsedWorkspaces() {
    try { localStorage.setItem('anyu.collapsedWorkspaces', JSON.stringify([...collapsedWorkspaceGroups])) } catch {}
  }
  function sessionWorkspaceKey(session) {
    const raw = String(session?.cwd || '').trim().replace(/[\\/]+$/, '')
    return raw ? (navigator.platform?.toLowerCase().startsWith('win') ? raw.toLowerCase() : raw) : '__default__'
  }
  function sessionWorkspaceLabel(workspaceKey) {
    if (workspaceKey === '__default__') return '默认工作区'
    const normalized = String(workspaceKey || '').replace(/[\\/]+$/, '')
    const parts = normalized.split(/[\\/]/).filter(Boolean)
    return parts.at(-1) || normalized || '默认工作区'
  }
  function sessionWorkspaceGroupsMarkup() {
    const groups = new Map()
    for (const session of state.sessions) {
      const key = sessionWorkspaceKey(session)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(session)
    }
    return [...groups.entries()].map(([workspaceKey, sessions]) => {
      const workspace = workspaceKey === '__default__' ? '' : workspaceKey
      const items = sessions.map((item) => {
        // 绿点只给“已完成且未读”的会话；运行中显示加载指示；其余不点亮。
        const running = isSessionRunning(item.path) || state.sessionLoadingPath === item.path
        const unread = !running && isSessionUnread(item.path)
        const indicator = running
          ? '<span class="spinner session-spinner" aria-label="运行中"></span>'
          : `<span class="session-status-dot${unread ? ' is-unread' : ''}" aria-label="${unread ? '已完成未读' : '已完成'}"></span>`
        const trailing = running ? '<small class="session-run-tag">运行中</small>' : unread ? '<small class="session-run-tag is-unread">已完成</small>' : ''
        return `<button class="nav-item session ${item.path === state.sessionPath ? 'active' : ''}${running ? ' is-running' : ''}${unread ? ' is-unread' : ''}" data-path="${esc(item.path)}" aria-busy="${running ? 'true' : 'false'}" title="${esc(item.title || '新会话')}\n${esc(workspace || '默认工作区')}"><span class="nav-icon">${indicator}</span><span class="session-copy"><span class="session-label">${esc(item.title || '新会话')}</span><small class="session-time">${esc(formatTimestamp(item.firstMessageAt || item.createdAt || item.modified))}</small></span>${trailing}</button>`
      }).join('')
      const collapsed = collapsedWorkspaceGroups.has(workspaceKey)
      return `<section class="session-workspace-group${collapsed ? ' is-collapsed' : ''}" data-workspace="${esc(workspaceKey)}"><button type="button" class="session-workspace-heading${collapsed ? ' is-collapsed' : ''}" data-workspace-toggle="${esc(workspaceKey)}" title="${esc(collapsed ? '展开该工作区的会话' : '折叠该工作区的会话')}"><span class="session-workspace-chevron" aria-hidden="true">⌄</span><span class="session-workspace-icon">⌂</span><span>${esc(sessionWorkspaceLabel(workspaceKey))}</span><small>${sessions.length}</small></button><div class="session-workspace-items"${collapsed ? ' hidden' : ''}>${items}</div></section>`
    }).join('') || '<div class="empty-sessions">暂无会话</div>'
  }
  function imageAttachmentsFromContent(content) {
    if (!Array.isArray(content)) return []
    return content.filter((part) => part?.type === 'image' && part.data).map((part, index) => ({
      id: `session-image-${index}-${String(part.data).slice(0, 12)}`,
      kind: 'image', name: `参考图片 ${index + 1}`, mimeType: part.mimeType || 'image/png',
      size: Math.floor(String(part.data).length * 0.75), data: part.data,
      dataUrl: `data:${part.mimeType || 'image/png'};base64,${part.data}`
    }))
  }
  async function storedAttachmentsForSession() {
    if (!state.sessionPath || !window.anyu.piAttachments) return []
    try { return await window.anyu.piAttachments(state.sessionPath) } catch { return [] }
  }
  function orderTimeline(messages) {
    // 排序只重排引用，流式事件与时间线必须指向同一个消息对象。
    const merged = (Array.isArray(messages) ? messages : []).map((message, index) => ({ message, index }))
    merged.sort((left, right) => {
      const leftTime = Number(left.message.createdAt || left.message.timestamp || 0); const rightTime = Number(right.message.createdAt || right.message.timestamp || 0)
      if (leftTime !== rightTime) return leftTime - rightTime
      return left.index - right.index
    })
    return merged.map(({ message }) => message)
  }
  function sameTimelineMessage(left, right) {
    if (!left || !right || left.role !== right.role) return false
    if (left.id && right.id && String(left.id) === String(right.id)) return true
    const leftTime = Number(left.createdAt || left.timestamp || 0)
    const rightTime = Number(right.createdAt || right.timestamp || 0)
    // Pi restores message entries without the local media-task id. Use the
    // persisted timestamp/content pair as the cross-source identity, while
    // retaining distinct ids when their timestamps differ.
    return !left.id || !right.id
      ? leftTime === rightTime && String(left.content || '') === String(right.content || '')
      : false
  }
  function containsTimelineMessage(messages, message) {
    return (Array.isArray(messages) ? messages : []).some((item) => sameTimelineMessage(item, message))
  }
  function timelineMessagesUnique(messages) {
    const unique = []
    for (const message of Array.isArray(messages) ? messages : []) {
      const duplicateIndex = unique.findIndex((item) => sameTimelineMessage(item, message))
      if (duplicateIndex < 0) unique.push(message)
      else unique[duplicateIndex] = mergeTimelineMessage(unique[duplicateIndex], message)
    }
    return unique
  }
  function mergeTimelineMessage(existing, incoming) {
    if (!existing) return incoming
    if (!incoming) return existing
    const merged = { ...existing, ...incoming }
    // 刷新时 Pi 消息和本地媒体记录可能拥有同一个 ID；保留本地结果卡中的附件和产物。
    for (const key of ['attachments', 'artifacts', 'businessAssets']) {
      const current = Array.isArray(existing[key]) ? existing[key] : []
      const next = Array.isArray(incoming[key]) ? incoming[key] : []
      if (current.length && !next.length) merged[key] = current
      else if (current.length && next.length) merged[key] = [...new Map([...current, ...next].map((item) => [String(item?.id || item?.path || JSON.stringify(item)), item])).values()]
    }
    for (const key of ['content', 'mediaPhase', 'businessPhase', 'businessStatus', 'mediaPlanText', 'mediaPlanSummary']) {
      if (!String(merged[key] || '').trim() && String(existing[key] || '').trim()) merged[key] = existing[key]
    }
    return merged
  }
  function mediaActivityKey(sessionPath) { return String(sessionPath || '__pending__') }
  function mediaActivityForSession(sessionPath = state.sessionPath) {
    return Array.isArray(state.mediaActivity[mediaActivityKey(sessionPath)]) ? state.mediaActivity[mediaActivityKey(sessionPath)] : []
  }
  function beginMediaActivity(sessionPath, taskId, kind) {
    const key = mediaActivityKey(sessionPath)
    const current = mediaActivityForSession(sessionPath).filter((item) => item.id !== taskId)
    state.mediaActivity[key] = [...current, { id: taskId, kind }]
  }
  function moveMediaActivity(fromPath, toPath, taskId) {
    if (mediaActivityKey(fromPath) === mediaActivityKey(toPath)) return
    const item = mediaActivityForSession(fromPath).find((entry) => entry.id === taskId)
    state.mediaActivity[mediaActivityKey(fromPath)] = mediaActivityForSession(fromPath).filter((entry) => entry.id !== taskId)
    if (item) beginMediaActivity(toPath, item.id, item.kind)
  }
  function endMediaActivity(sessionPath, taskId) {
    const key = mediaActivityKey(sessionPath)
    const remaining = mediaActivityForSession(sessionPath).filter((item) => item.id !== taskId)
    if (remaining.length) state.mediaActivity[key] = remaining
    else delete state.mediaActivity[key]
  }
  function insertTimelineMessage(message) {
    state.messages = orderTimeline([...state.messages, message])
  }
  function removeTimelineMessageById(id) {
    const key = String(id || '')
    if (!key) return false
    const before = state.messages.length
    state.messages = state.messages.filter((item) => String(item?.id || '') !== key)
    return state.messages.length !== before
  }
  function upsertTimelineMessage(message) {
    const id = String(message?.id || '')
    const existing = id ? state.messages.find((item) => String(item?.id || '') === id) : null
    if (existing) Object.assign(existing, message)
    else insertTimelineMessage(message)
    return existing || message
  }
  function upsertMediaTimelineMessage(sessionPath, message) {
    if (!sessionPath || !message) return message
    const current = Array.isArray(state.mediaMessages[sessionPath]) ? state.mediaMessages[sessionPath] : []
    const id = String(message.id || '')
    const index = id ? current.findIndex((item) => String(item?.id || '') === id) : -1
    if (index >= 0) current[index] = { ...current[index], ...message }
    else current.push(message)
    state.mediaMessages[sessionPath] = current.slice(-100)
    return state.mediaMessages[sessionPath][index >= 0 ? index : state.mediaMessages[sessionPath].length - 1]
  }
  function artifactCandidates(value) {
    const source = String(value || '')
    // 只有明确的生成/导出语境才认作产物；普通引用现有文件不进入结果卡。
    if (!/(?:已|成功)?(?:生成|创建|写入|保存|导出|产出|新增)|(?:created|generated|wrote|written|saved|exported)\b/i.test(source)) return []
    const matches = []
    const extension = '(?:html?|json|csv|md|txt|png|jpe?g|webp|gif|svg|pdf|pptx?|xlsx?|xlsm|ods|zip|mp4|mov|webm|mp3|wav|js|cjs|mjs|ts|tsx|jsx|css|go|py|ya?ml|sql)'
    const add = (value) => {
      const candidate = String(value || '').trim().replace(/^[`"']|[`"',:;.!?]$/g, '')
      if (candidate && !/^https?:\/\//i.test(candidate) && new RegExp(`\\.${extension}$`, 'i').test(candidate)) matches.push(candidate)
    }
    for (const match of source.matchAll(/`([^`\r\n]+)`/g)) add(match[1])
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) add(match[1])
    for (const match of source.matchAll(/(?:已生成|生成|已保存|保存|已导出|导出)\s+(.+?\.(?:pptx?|xlsx?|xlsm|csv|pdf|docx?|zip|mp4|mov|webm|mp3|wav|html?|json|md|txt|py|js|ya?ml))(?=$|[\s。；;，,])/gim)) add(match[1])
    // Windows 绝对路径允许空格、中文、括号、& 和方括号；按每行从盘符或相对路径起点扫描。
    for (const line of source.split(/\r?\n/)) {
      if (!/(?:已|成功)?(?:生成|创建|写入|保存|导出|产出|新增)|(?:created|generated|wrote|written|saved|exported)\b/i.test(line)) continue
      const rawPattern = new RegExp(`(?:[A-Za-z]:[\\\\/]|\\.\\.?[\\\\/])[^\\r\\n<>:"|?*]+?\\.${extension}(?=$|[\\s,;，。)）\\]】])`, 'gi')
      for (const match of line.matchAll(rawPattern)) add(match[0])
    }
    return [...new Set(matches)].slice(0, 32)
  }
  // 工件探测的“无工件”结果缓存：长会话里绝大多数消息没有工件，
  // 缓存空结果可以让二次刷新完全跳过逐条 IPC。有工件的结果不缓存，文件变了仍能刷新。
  const emptyArtifactSignatures = new Set()
  async function inspectMessageArtifacts(message, workspace = effectiveWorkspace()) {
    if (!message || !['assistant', 'tool'].includes(message.role) || message.isError || !workspace || !window.anyu.inspectArtifacts) return []
    const candidates = message.role === 'tool'
      ? ['write', 'browser_open'].includes(message.toolName) && message.args?.path ? [String(message.args.path)] : []
      : artifactCandidates(message.content)
    const signature = `${workspace}\n${candidates.join('\n')}`
    if (message.artifactInspectionSignature === signature) return message.discoveredArtifacts || []
    message.artifactInspectionSignature = signature
    if (!candidates.length) { message.discoveredArtifacts = []; return [] }
    if (emptyArtifactSignatures.has(signature)) { message.discoveredArtifacts = []; return [] }
    try {
      const result = await window.anyu.inspectArtifacts({ cwd: workspace, paths: candidates })
      message.discoveredArtifacts = Array.isArray(result?.artifacts) ? result.artifacts : []
      if (!message.discoveredArtifacts.length) emptyArtifactSignatures.add(signature)
    } catch {
      message.discoveredArtifacts = []
    }
    return message.discoveredArtifacts
  }
  function toolCallsFromContent(content) {
    if (!Array.isArray(content)) return []
    return content.filter((part) => ['toolCall', 'tool_call', 'toolUse', 'tool_use'].includes(part?.type)).map((part) => ({
      toolCallId: part.id || part.toolCallId || part.tool_call_id,
      toolName: part.name || part.toolName || part.tool_name,
      args: part.arguments || part.args || part.input || {}
    }))
  }
  const SESSION_MESSAGES_CACHE_LIMIT = 8
  function saveSessionMessagesCache(sessionPath, ordered) {
    const key = String(sessionPath || '').trim()
    if (!key || !Array.isArray(ordered) || !ordered.length) return
    const cache = state.sessionMessagesCache
    // 存副本：后续在本地追加乐观消息时不能把缓存一起改了。
    delete cache[key]
    cache[key] = ordered.slice()
    for (const stale of Object.keys(cache).slice(0, Math.max(0, Object.keys(cache).length - SESSION_MESSAGES_CACHE_LIMIT))) delete cache[stale]
  }
  function restoreSessionMessagesCache(sessionPath) {
    const cached = state.sessionMessagesCache[String(sessionPath || '').trim()]
    if (!Array.isArray(cached) || !cached.length) return false
    state.messages = cached.slice()
    state.imageLibrary = [...new Map(cached.flatMap((message) => message.attachments || []).map((item) => [item.id, item])).values()]
    return true
  }
  // 把 Pi 的持久消息（无论来自 get_messages 还是本地会话文件）归一成时间线条目。
  function normalizePiMessages(messages) {
    const list = Array.isArray(messages) ? messages : []
    const normalized = list.filter((message) => ['user', 'assistant', 'toolResult'].includes(message?.role)).map((message) => {
      const messageText = textOf(message.content) || message.errorMessage || ''
      const inlineImages = imageAttachmentsFromContent(message.content)
      const createdAt = timestampValue(message.timestamp || message.createdAt || message.time)
      // Pi 的持久消息可能没有 ID；恢复同一条本地乐观消息的身份，防止首轮刷新闪烁。
      const optimistic = message.role === 'user' && !message.id && !message.messageId ? state.messages.find((item) => item.role === 'user' && item.id && item.content === messageText && Math.abs(Number(item.createdAt || 0) - createdAt) < 10000) : null
      return {
        id: message.id || message.messageId || optimistic?.id || undefined,
        role: message.role === 'toolResult' ? 'tool' : message.role,
        // Pi persists the message timestamp inside the message object. Keep
        // it so locally-rendered media can be merged into the same timeline.
        createdAt,
        content: messageText,
        thinking: thinkingOf(message.content),
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        toolCalls: toolCallsFromContent(message.content),
        args: message.arguments || message.args || message.input || {},
        isError: message.isError || Boolean(message.errorMessage),
        attachments: inlineImages
      }
    })
    const calls = normalized.flatMap((message) => message.toolCalls || [])
    for (const message of normalized) {
      if (message.role !== 'tool') continue
      const call = calls.find((item) => item.toolCallId && item.toolCallId === message.toolCallId)
      if (call) { message.toolName = message.toolName || call.toolName; message.args = Object.keys(message.args || {}).length ? message.args : call.args }
    }
    return normalized
  }
  function applySessionMessages(sessionPath, normalized) {
    const optimistic = state.optimisticMessages?.[sessionPath]
    const ordered = orderTimeline(timelineMessagesUnique([...normalized, ...(optimistic ? [optimistic] : []), ...(state.mediaMessages[sessionPath] || [])]))
    state.messages = ordered
    state.imageLibrary = [...new Map(ordered.flatMap((message) => message.attachments || []).map((item) => [item.id, item])).values()]
    saveSessionMessagesCache(sessionPath, ordered)
    void restoreOneClickReferencePreviews(sessionPath, ordered)
    return ordered
  }
  // 冷会话秒开：目标会话的 Pi 进程还没拉起时，先用主进程直读的会话文件把历史
  // 画出来。这是“切换对话要等一会”的最主要修复——读盘是毫秒级，拉 pi.exe 是秒级。
  async function paintSessionFromDisk(sessionPath, shouldApply = () => true) {
    if (!sessionPath || !window.anyu.piSessionMessages) return false
    try {
      const result = await window.anyu.piSessionMessages(sessionPath)
      const normalized = normalizePiMessages(result?.messages)
      const optimistic = await window.anyu.piOptimisticMessage?.(sessionPath).catch(() => null)
      if (optimistic?.id) {
        state.optimisticMessages[sessionPath] = optimistic
        if (!normalized.some((item) => item.id === optimistic.id || (item.role === 'user' && item.content === optimistic.content && Math.abs(Number(item.createdAt || 0) - Number(optimistic.createdAt || 0)) < 10000))) normalized.push(optimistic)
      }
      const storedMedia = window.anyu.piMedia ? await window.anyu.piMedia(sessionPath).catch(() => []) : []
      if (Array.isArray(storedMedia) && storedMedia.length) state.mediaMessages[sessionPath] = timelineMessagesUnique([...(state.mediaMessages[sessionPath] || []), ...storedMedia]).slice(-100)
      if ((!normalized.length && !storedMedia.length) || !shouldApply()) return false
      applySessionMessages(sessionPath, normalized)
      return true
    } catch { return false }
  }
  async function refreshMessages(shouldApply = () => true) {
    // 两阶段加载：第一阶段只等 get_messages，立即上屏（这是切换速度的关键）；
    // 本地附件（base64）、媒体与工件探测都可能牵涉多次 IPC/文件读取，放到第二阶段
    // 后台补齐，不阻塞首屏。
    const sessionPath = state.sessionPath
    try {
      const result = await window.anyu.piCommand({ type: 'get_messages', sessionKey: state.sessionPath })
      const normalized = normalizePiMessages(result?.data?.messages)
      const optimistic = await window.anyu.piOptimisticMessage?.(sessionPath).catch(() => null)
      if (optimistic?.id) {
        state.optimisticMessages[sessionPath] = optimistic
        if (!normalized.some((item) => item.id === optimistic.id || (item.role === 'user' && item.content === optimistic.content && Math.abs(Number(item.createdAt || 0) - Number(optimistic.createdAt || 0)) < 10000))) normalized.push(optimistic)
      }
      if (shouldApply()) applySessionMessages(sessionPath, normalized)
      // 第二阶段：附件/媒体/工件在后台补齐，完成后只在数据仍属于当前会话时再上屏。
      void enrichTimeline(shouldApply, sessionPath, normalized)
      return normalized
    } catch {}
  }
  async function enrichTimeline(shouldApply, sessionPath, normalized) {
    try {
      const stored = window.anyu.piAttachments ? await window.anyu.piAttachments(sessionPath).catch(() => []) : []
      const storedMedia = window.anyu.piMedia ? await window.anyu.piMedia(sessionPath).catch(() => []) : []
      const enriched = normalized.map((message) => {
        if (message.role !== 'user' || message.attachments?.length) return message
        const matching = stored.filter((item) => item.messageText === message.content)
        if (!matching.length) return message
        return { ...message, attachments: matching.map((item) => ({ ...item, data: item.dataUrl?.split(',')[1] || '', dataUrl: item.dataUrl })) }
      })
      // 工件探测逐条走 IPC；缓存在消息对象上，这里只对还没探测过的做。
      await Promise.all(enriched.map((message) => inspectMessageArtifacts(message)))
      const localMedia = timelineMessagesUnique([...(state.mediaMessages[sessionPath] || []), ...(storedMedia || [])])
      if (sessionPath) state.mediaMessages[sessionPath] = localMedia.slice(-100)
      const ordered = orderTimeline(timelineMessagesUnique([...enriched, ...localMedia]))
      void restoreOneClickReferencePreviews(sessionPath, ordered)
      if (shouldApply() && state.sessionPath === sessionPath) {
        state.messages = ordered
        state.imageLibrary = [...new Map(ordered.flatMap((message) => message.attachments || []).map((item) => [item.id, item])).values()]
        saveSessionMessagesCache(sessionPath, ordered)
        scheduleLiveUi(false)
      }
      return ordered
    } catch {}
  }
  function upsertSessionListEntry(sessionPath, content = '', createdAt = Date.now(), cwd = '') {
    const path = normalizeSessionKey(sessionPath)
    if (!path) return null
    const title = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 48) || '新会话'
    const existing = state.sessions.find((item) => item.path === path)
    if (existing) {
      const hadPlaceholderTitle = !existing.title || existing.title === '新会话'
      if (hadPlaceholderTitle) {
        existing.title = title
        existing.createdAt = existing.firstMessageAt = Number(createdAt || Date.now())
      }
      existing.modified = Math.max(Number(existing.modified || 0), Number(createdAt || Date.now()))
      existing.createdAt = existing.createdAt || Number(createdAt || Date.now())
      existing.firstMessageAt = existing.firstMessageAt || existing.createdAt
      if (cwd && !existing.cwd) existing.cwd = cwd
    } else state.sessions.push({ path, title, createdAt: Number(createdAt || Date.now()), firstMessageAt: Number(createdAt || Date.now()), modified: Number(createdAt || Date.now()), cwd: String(cwd || '') })
    state.sessions.sort((a, b) => Number(b.createdAt || b.firstMessageAt || b.modified || 0) - Number(a.createdAt || a.firstMessageAt || a.modified || 0) || String(a.path).localeCompare(String(b.path)))
    return existing || state.sessions.find((item) => item.path === path) || null
  }
  function updateSessionTitle(content, createdAt = Date.now()) {
    upsertSessionListEntry(state.sessionPath, content, createdAt, state.sessionCwd || state.cwd || '')
  }
  function sessionContextMenuMarkup() {
    const menu = state.sessionMenu
    if (!menu?.path) return ''
    const session = state.sessions.find((item) => item.path === menu.path)
    const viewportWidth = Math.max(240, Number(window.innerWidth || 1200))
    const viewportHeight = Math.max(180, Number(window.innerHeight || 800))
    const x = Math.max(8, Math.min(Number(menu.x || 0), viewportWidth - 180))
    const y = Math.max(8, Math.min(Number(menu.y || 0), viewportHeight - 184))
    return `<div class="session-context-menu" style="left:${x}px;top:${y}px" data-session-menu><button type="button" data-session-action="pin" data-session-path="${esc(menu.path)}"><span>${session?.pinned ? '★' : '☆'}</span>${session?.pinned ? '取消置顶' : '置顶'}</button><button type="button" data-session-action="rename" data-session-path="${esc(menu.path)}"><span>✎</span>重命名</button><button type="button" data-session-action="fork" data-session-path="${esc(menu.path)}"><span>⑂</span>分叉为新会话</button><button type="button" data-session-action="copy-path" data-session-path="${esc(menu.path)}"><span>⧉</span>复制会话链接</button><button type="button" class="danger" data-session-action="delete" data-session-path="${esc(menu.path)}"><span>⌫</span>删除</button></div>`
  }
  async function handleSessionAction(action, sessionPath) {
    const target = String(sessionPath || '')
    const session = state.sessions.find((item) => item.path === target)
    state.sessionMenu = null
    renderApp()
    if (!target || !window.anyu.piSessionAction) return
    if (action === 'rename') {
      const nextTitle = window.prompt('请输入会话名称', session?.title || '新会话')
      if (nextTitle == null) return
      const title = String(nextTitle).replace(/\s+/g, ' ').trim()
      if (!title) { state.error = '会话名称不能为空'; renderApp(); return }
      try { await window.anyu.piSessionAction({ action, sessionPath: target, title }); await refreshSessions(); renderApp() } catch (error) { state.error = errorText(error) || '重命名失败'; renderApp() }
      return
    }
    if (action === 'pin') {
      try { await window.anyu.piSessionAction({ action, sessionPath: target, pinned: !Boolean(session?.pinned) }); await refreshSessions(); renderApp() } catch (error) { state.error = errorText(error) || '置顶失败'; renderApp() }
      return
    }
    // 复制会话文件绝对路径：会话记录本机就是一个 .jsonl 文件，拿到路径就能
    // 在别处（命令行、另一个客户端）直接打开或续聊这条对话。
    if (action === 'copy-path') {
      const copied = await copyText(target)
      state.error = ''
      window.alert(copied ? `已复制会话链接：\n${target}` : '复制失败，请手动复制')
      return
    }
    // 分叉：复制会话文件为新会话（原会话不动），并直接切过去继续聊。
    if (action === 'fork') {
      try {
        const forked = await window.anyu.piForkSession({ sessionPath: target })
        await refreshSessions()
        await switchSession(forked.path)
      } catch (error) { state.error = errorText(error) || '分叉失败'; renderApp() }
      return
    }
    if (action === 'delete') {
      if (!window.confirm(`确定删除会话“${session?.title || '新会话'}”吗？\n会话消息和本地附件将一并删除。`)) return
      const deletingCurrent = target === state.sessionPath
      try {
        if (deletingCurrent) { clearActiveRequest(); state.loading = false; await window.anyu.piStop({ sessionKey: target }); state.piState = null }
        forgetSessionRun(target)
        await window.anyu.piSessionAction({ action, sessionPath: target })
        if (deletingCurrent) {
          state.sessionPath = null; state.sessionCwd = null; state.messages = []; state.imageLibrary = []; state.mediaMessages = {}; state.mediaActivity = {}
        }
        await refreshSessions()
        if (deletingCurrent && state.sessions[0]) {
          state.sessionPath = state.sessions[0].path; state.sessionCwd = state.sessions[0].cwd || null; state.cwd = state.sessionCwd || localStorage.getItem('anyu.cwd') || ''
          await startAgent(state.sessionPath)
        }
        renderApp()
      } catch (error) { state.error = errorText(error) || '删除失败'; renderApp() }
    }
  }
  async function startAgent(sessionPath = state.sessionPath, shouldApply = () => true) {
    chooseModel()
    const configRevision = state.configRevision
    if (!state.model) throw new Error('请先选择可用模型')
    // force 只重建“这个会话”的进程：换模型/分组或改权限模式时才需要，
    // 其余情况复用已有进程，避免打断正在生成的任务。
    const result = await window.anyu.piStart({ accessMode: state.accessMode, keyId: state.selectedKey, model: state.model, provider: currentModel()?.provider, models: state.catalog, sessionPath, cwd: effectiveWorkspace() || undefined, permissionMode: state.permissionMode, force: Boolean(state.pendingAgentRestart) })
    // 主进程在会话文件冲突时可能自动分叉恢复；后续 IPC 必须使用恢复后的真实路径。
    let activeSessionPath = result?.sessionPath || sessionPath || null
    state.activePermissionMode = result?.permissionMode || effectivePermissionMode()
    if (shouldApply()) {
      if (state.sessionCwd) state.sessionCwd = result.cwd || state.sessionCwd
      else state.cwd = result.cwd || state.cwd
      if (activeSessionPath) state.sessionPath = activeSessionPath
      if (!state.sessionCwd) localStorage.setItem('anyu.cwd', state.cwd)
      if (state.configRevision === configRevision) state.pendingAgentRestart = false
    }
    // 原来这里是 get_state → 强度 → 消息 → 会话列表 的四级串行，切换会话时
    // 每一跳都是一次 IPC 往返。改成两轮并发：
    //   第一轮 get_state 与会话列表同时跑（会话列表在主进程读盘，与 Pi 无关）；
    //   第二轮 get_messages 与思考强度同时跑（都只依赖上面拿到的 sessionFile）。
    const [current] = await Promise.all([
      window.anyu.piCommand({ type: 'get_state', sessionKey: activeSessionPath }),
      refreshSessions(shouldApply).catch(() => null)
    ])
    if (shouldApply()) {
      state.piState = current?.data || null
      state.sessionPath = state.piState?.sessionFile || activeSessionPath || null
      activeSessionPath = state.sessionPath
    }
    await Promise.all([
      refreshMessages(shouldApply).catch(() => null),
      shouldApply() && state.configRevision === configRevision ? syncThinkingLevels().catch(() => null) : Promise.resolve()
    ])
    return { ...result, sessionPath: activeSessionPath }
  }
  // “拉起 Agent”的唯一入口：新建会话的后台启动、用户秒发消息、无进程会话的兜底
  // 都汇到这里。并发调用共享同一个 Promise，避免竞态下 piStart 双开进程——
  // 双开的两个匿名进程会各自落一个新 .jsonl，消息会写进界面对不上的会话里。
  let agentStartPromise = null
  function ensureAgentStarted() {
    if (agentStartPromise) return agentStartPromise
    const owner = state.sessionPath
    const pendingNew = state.pendingNewAgent
    const run = (async () => {
      try {
        // 用户中途切走（切到具体会话）时两者都为假，startAgent 内部就不再回写状态。
        const result = await startAgent(state.sessionPath, () => state.sessionPath === owner || (pendingNew && state.pendingNewAgent))
        state.pendingNewAgent = false
        return result
      } catch (error) {
        state.pendingNewAgent = false
        state.error = errorText(error) || 'Pi Agent 启动失败'
        throw error
      } finally {
        agentStartPromise = null
        scheduleAppRender()
      }
    })()
    agentStartPromise = run
    return run
  }
  async function bootstrap() {
    // 记录当前主进程加载的代码版本：改完 main.cjs 只有彻底退出重开才会生效，
    // 悬停连接状态就能确认跑的是不是最新代码，避免"改了没变化"的误判。
    try { state.buildInfo = await window.anyu.appBuildInfo?.() || null } catch { state.buildInfo = null }
    // 提权意图必须在启动 Pi 之前恢复，否则重启后会先按默认权限拉起一次 Pi。
    const elevationIntent = await applyElevationIntent()
    const [me, plugins] = await Promise.all([
      api('/auth/me'),
      window.anyu.pluginState().catch(() => ({ installed: [] }))
    ])
    state.user = me?.user || me
    if (!String(localStorage.getItem('anyu.cwd') || '').trim() && window.anyu.defaultWorkspace) {
      try {
        const workspace = await window.anyu.defaultWorkspace()
        if (workspace?.path) { state.cwd = workspace.path; localStorage.setItem('anyu.cwd', workspace.path) }
      } catch {}
    }
    state.pluginState = { ...state.pluginState, installed: plugins?.installed || [] }
    // 系统权限探测会调用 PowerShell，在首屏之后执行，避免安装后窗口长时间无响应。
    void refreshSystemAccess().catch(() => {})
    startBalanceRefresh()
    state.keysLoaded = true
    state.accessMode = 'auto'
    state.selectedKey = 0
    await loadRouteData()
    // 技能目录和会话列表互不依赖，首屏并行加载；任一失败都不阻断普通对话。
    await Promise.all([
      loadSkillGroups({ silent: true }).catch(() => {}),
      refreshSessions().catch(() => {})
    ])
    chooseModel()
    if (state.sessions[0]) { state.sessionPath = state.sessions[0].path; state.sessionCwd = state.sessions[0].cwd || null; if (state.sessionCwd) state.cwd = state.sessionCwd }
    try { await ensureAgentStarted(); await confirmElevationIntent(elevationIntent) } catch (error) { state.error = error.message || 'Pi Agent 启动失败' }
  }

  function attachmentDataUrl(attachment) {
    const declared = String(attachment?.dataUrl || attachment?.url || '').trim()
    if (declared) return declared
    const raw = String(attachment?.data || '').trim()
    if (!raw) return ''
    if (/^data:[^,]+,/i.test(raw)) return raw
    if (/^base64,/i.test(raw)) return `data:${attachment?.mimeType || 'image/png'};base64,${raw.slice(raw.indexOf(',') + 1)}`
    return `data:${attachment?.mimeType || 'image/png'};base64,${raw}`
  }
  function attachmentObjectUrl(attachment) {
    const dataUrl = attachmentDataUrl(attachment)
    if (!dataUrl.startsWith('data:')) return dataUrl
    // 缩略图和高清预览可同时存在，不能互相撤销正在显示的 Blob URL。
    const key = `${String(attachment?.id || '') || dataUrl.slice(0, 120)}${attachment?.previewOnly ? ':preview' : ''}`
    const cached = mediaObjectUrls.get(`attachment:${key}`)
    if (cached?.dataUrl === dataUrl) return cached.url
    try {
      const separator = dataUrl.indexOf(',')
      if (separator < 0) return dataUrl
      const header = dataUrl.slice(5, separator)
      const body = dataUrl.slice(separator + 1)
      const mimeType = header.split(';')[0] || attachment?.mimeType || 'application/octet-stream'
      const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
      if (cached?.url) URL.revokeObjectURL(cached.url)
      mediaObjectUrls.set(`attachment:${key}`, { dataUrl, url })
      return url
    } catch { return dataUrl }
  }
  function safeDownloadName(name, fallback) {
    const value = String(name || fallback || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
    return value || fallback || 'download'
  }
  function mediaExtension(mimeType, fallback) {
    const mime = String(mimeType || '').toLowerCase().split(';')[0]
    if (mime === 'image/jpeg') return '.jpg'
    if (mime === 'image/webp') return '.webp'
    if (mime === 'image/gif') return '.gif'
    if (mime === 'video/webm') return '.webm'
    if (mime === 'video/quicktime') return '.mov'
    if (mime === 'video/mp4') return '.mp4'
    return fallback
  }
  function dataUrlBlob(dataUrl, mimeType) {
    const value = String(dataUrl || '')
    if (!value.startsWith('data:')) return null
    const separator = value.indexOf(',')
    if (separator < 0) return null
    try {
      const bytes = Uint8Array.from(atob(value.slice(separator + 1)), (char) => char.charCodeAt(0))
      return new Blob([bytes], { type: mimeType || value.slice(5, separator).split(';')[0] || 'application/octet-stream' })
    } catch { return null }
  }
  async function compactGeneratedImagePreview(dataUrl) {
    const blob = dataUrlBlob(dataUrl)
    if (!blob) throw new Error('生成图没有可解码的本地图片数据')
    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d', { alpha: false })
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return { dataUrl: canvas.toDataURL('image/jpeg', 0.76), width: bitmap.width, height: bitmap.height, previewOnly: true }
    } finally { bitmap.close() }
  }

  async function showImagePreview(attachment) {
    if (!attachment?.dataUrl) return
    state.imagePreview = attachment
    renderApp()
    if (!attachment.previewOnly || !attachment.downloadTaskId) return
    try {
      const original = await window.anyu.imageDownload(attachment.downloadTaskId, Number(attachment.downloadIndex || 0))
      const dataUrl = mediaDataUrl(original, 'image')
      if (!dataUrl) throw new Error('原图数据为空')
      if (state.imagePreview?.id === attachment.id) {
        state.imagePreview = { ...attachment, data: mediaBase64Data(original), dataUrl, previewOnly: false }
        renderApp()
      }
    } catch (error) {
      state.error = errorText(error) || '原图加载失败'
      renderApp()
    }
  }

  async function downloadMedia(attachment, kind = 'image') {
    if (!attachment) return
    try {
      let data = String(attachment.data || '')
      let mimeType = attachment.mimeType || (kind === 'video' ? 'video/mp4' : 'image/png')
      const taskId = attachment.downloadTaskId || attachment.taskId
      if (taskId) {
        try {
          const result = kind === 'video' ? await window.anyu.videoDownload(taskId) : await window.anyu.imageDownload(taskId, Number(attachment.downloadIndex || 0))
          if (result?.data) { data = String(result.data); mimeType = result.mimeType || mimeType }
        } catch (error) {
          if (attachment.previewOnly || !data && !String(attachment.dataUrl || '').startsWith('data:')) throw error
        }
      }
      const blob = data ? new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], { type: mimeType }) : dataUrlBlob(attachment.dataUrl, mimeType)
      if (!blob || !blob.size) throw new Error('媒体数据为空')
      const url = URL.createObjectURL(blob)
      const fallback = kind === 'video' ? 'anyu-video' : 'anyu-image'
      let name = safeDownloadName(attachment.name, fallback)
      if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += mediaExtension(mimeType, kind === 'video' ? '.mp4' : '.png')
      const link = document.createElement('a'); link.href = url; link.download = name; link.style.display = 'none'; document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1500)
    } catch (error) {
      state.error = errorText(error) || '图片下载失败'
      renderApp()
    }
  }
  function attachmentMarkup(attachment, removable = true) {
    const remove = removable ? `<button class="attachment-remove" data-remove-attachment="${esc(attachment.id)}" title="移除附件">×</button>` : ''
    const download = attachment.kind === 'image' ? `<button type="button" class="attachment-download" data-download-image="${esc(attachment.id)}" title="下载图片" aria-label="下载图片">↓</button>` : ''
    if (attachment.kind === 'image') return `<div class="attachment-preview image-attachment" data-image-preview="${esc(attachment.id)}" role="button" tabindex="0" title="点击查看大图"><img src="${esc(attachmentObjectUrl(attachment))}" alt="${esc(attachment.name)}">${download}${remove}<span>${esc(attachment.name)}</span></div>`
    if (attachment.kind === 'video') return `<div class="attachment-preview video-attachment"><video src="${esc(attachment.dataUrl)}" controls preload="metadata"></video><span>${esc(attachment.name || '生成视频')}</span></div>`
    return `<div class="attachment-preview file-attachment"><span class="file-icon">▧</span><span class="attachment-name">${esc(attachment.name)}</span><small>${formatBytes(attachment.size)}</small>${remove}</div>`
  }
  function attachmentsMarkup() {
    return state.attachments.length ? `<div class="attachments-strip">${state.attachments.map((attachment) => attachmentMarkup(attachment)).join('')}</div>` : ''
  }
  function mentionToken(value, cursor) {
    const text = String(value || '')
    const position = Math.max(0, Math.min(Number.isFinite(Number(cursor)) ? Number(cursor) : text.length, text.length))
    const before = text.slice(0, position)
    const match = before.match(/@([^\s@]*)$/)
    if (!match) return null
    return { query: match[1] || '', start: position - match[0].length, end: position, value: match[0] }
  }
  function currentMentionToken() {
    const prompt = document.querySelector('#prompt')
    const value = String(state.composerText || '')
    const cursor = prompt && document.activeElement === prompt ? prompt.selectionStart : state.composerCursor
    return mentionToken(value, cursor)
  }
  function replaceMention(prompt, replacement) {
    if (!prompt) return false
    const value = String(prompt.value || '')
    const cursor = Number.isFinite(Number(prompt.selectionStart)) ? Number(prompt.selectionStart) : value.length
    const token = mentionToken(value, cursor)
    if (!token) return false
    const next = value.slice(0, token.start) + replacement + value.slice(token.end)
    prompt.value = next
    const nextCursor = token.start + String(replacement).length
    prompt.selectionStart = prompt.selectionEnd = nextCursor
    state.composerText = next
    state.composerCursor = nextCursor
    return true
  }
  function imageCandidates() {
    return [...new Map([...state.attachments, ...state.imageLibrary].filter((item) => item?.kind === 'image' && item.dataUrl).map((item) => [item.id, item])).values()]
  }
  function imageReferenceMarkup() {
    const candidates = imageCandidates()
    return `<div class="menu-caption">引用当前会话图片</div>${candidates.length ? candidates.map((item) => `<button type="button" class="image-reference-option" data-image-reference="${esc(item.id)}"><img src="${esc(attachmentObjectUrl(item))}" alt=""><span>${esc(item.name || '参考图片')}</span></button>`).join('') : '<div class="muted menu-empty">先上传一张图片</div>'}`
  }
  function imagePreviewMarkup() {
    if (!state.imagePreview?.dataUrl) return ''
    return `<div class="image-lightbox" data-image-close><div class="image-lightbox-inner" role="dialog" aria-modal="true" aria-label="图片预览"><button type="button" class="image-lightbox-close" data-image-close title="关闭">×</button><img src="${esc(attachmentObjectUrl(state.imagePreview))}" alt="${esc(state.imagePreview.name || '参考图片')}"><div>${esc(state.imagePreview.name || '参考图片')}</div><button type="button" class="media-download lightbox-download" data-download-image="${esc(state.imagePreview.id || '')}">↓ 下载图片</button></div></div>`
  }
  function taskId() { return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
  function taskPayload(task) {
    const attachments = Array.isArray(task?.attachments) ? task.attachments : []
    const content = String(task?.content || '').trim() || (attachments.some((attachment) => attachment.kind === 'image') ? '请分析我上传的图片。' : '请阅读我上传的文件。')
    const imageText = attachments.filter((attachment) => attachment.kind === 'image').map((attachment) => `\n\n[参考图片：${attachment.name || '未命名图片'}]`).join('')
    // 不再按目录标注预判“模型不支持图片”然后拦截：标注经常滞后（qwen 系列新模型就吃过分亏）。
    // 图片一律随请求发出去，能不能识别由模型返回的结果决定。
    const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image')
    return {
      content: content + imageText,
      attachments,
      attachmentText: attachmentContext(attachments),
      images: imageAttachments.map((attachment) => ({ type: 'image', data: attachment.data, mimeType: attachment.mimeType }))
    }
  }
  // @ 标记在消息任何位置都触发：中文没有空格，“电商鞋子高级感@生图”这类写法必须能调用技能，
  // 后面直接跟汉字或 URL 也算。只要求 @ 前面不是 ASCII 字母数字，避免把 user@image.com 这类邮箱当技能。
  function mediaSkillForPrompt(value) {
    const text = String(value || '')
    // 只有明确的 @生图/@image 标记才允许进入图片技能；普通对话不做隐式生图判断。
    if (state.skillEnabled.image && /(?<![A-Za-z0-9])@(生图|image)/i.test(text)) return 'image'
    if (state.skillEnabled.video && /(?<![A-Za-z0-9])@(生视频|视频|video)/i.test(text)) return 'video'
    // 媒体任务必须由明确的 @ 技能标记触发，普通对话中的意图词不启动任务。
    return ''
  }
  function autoEditForPrompt(value) {
    return /(?<![A-Za-z0-9])@(自动剪辑|auto-edit)\b/i.test(String(value || ''))
  }
  function mediaPrompt(value, skill) {
    return String(value || '').replace(skill === 'image' ? /(?<![A-Za-z0-9])@(生图|image)/ig : /(?<![A-Za-z0-9])@(生视频|视频|video)/ig, ' ').replace(/\s+/g, ' ').trim()
  }
  function autoEditPrompt(value) {
    return String(value || '').replace(/(?<![A-Za-z0-9])@(自动剪辑|auto-edit)\b/ig, ' ').replace(/\s+/g, ' ').trim()
  }

  // 业务技能必须由用户显式输入 @ 触发，普通对话内容不会隐式启动采集或测图。
  function businessSkillForPrompt(value) {
    const text = String(value || '')
    if (/(?<![A-Za-z0-9])@(评价分析|淘宝评价|天猫评价|问大家)/iu.test(text)) return 'feedback'
    if (/(?<![A-Za-z0-9])@(测图|AI测图|图片分析)/iu.test(text)) return 'image-analysis'
    if (/(?<![A-Za-z0-9])@(一键详情页|一键详情|详情页生图助手|商品详情图提取|淘宝详情|天猫详情|详情参考|商品详情)/iu.test(text)) return 'detail-reference'
    if (/(?<![A-Za-z0-9])@(店铺分析|店铺监控|天猫店铺监控)/iu.test(text)) return 'shop-monitor'
    return ''
  }

  function businessPrompt(value, skill) {
    const pattern = skill === 'feedback'
      ? /(?<![A-Za-z0-9])@(评价分析|淘宝评价|天猫评价|问大家)/igu
      : skill === 'detail-reference'
        ? /(?<![A-Za-z0-9])@(一键详情页|一键详情|详情页生图助手|商品详情图提取|淘宝详情|天猫详情|详情参考|商品详情)/igu
      : skill === 'shop-monitor'
        ? /(?<![A-Za-z0-9])@(店铺分析|店铺监控|天猫店铺监控)/igu
        : /(?<![A-Za-z0-9])@(测图|AI测图|图片分析)/igu
    return String(value || '').replace(pattern, ' ').replace(/\s+/g, ' ').trim()
  }

  function businessPayload(value) {
    if (!value || typeof value !== 'object') return {}
    if (value.data && typeof value.data === 'object') return value.data
    if (value.result && typeof value.result === 'object') return value.result
    return value
  }

  function businessTaskId(value) {
    const candidates = [
      value?.taskId, value?.task_id, value?.id,
      value?.task?.id, value?.task?.taskId, value?.task?.task_id,
      value?.data?.taskId, value?.data?.task_id, value?.data?.id,
      value?.data?.task?.id, value?.data?.task?.taskId, value?.data?.task?.task_id,
      value?.result?.taskId, value?.result?.task_id, value?.result?.id,
      value?.result?.task?.id, value?.result?.task?.taskId, value?.result?.task?.task_id
    ]
    return candidates.map((candidate) => String(candidate || '').trim()).find(Boolean) || ''
  }

  function businessStatus(value) {
    const candidates = [
      value?.status, value?.state, value?.taskStatus, value?.task_status,
      value?.task?.status, value?.task?.state, value?.task?.taskStatus, value?.task?.task_status,
      value?.data?.status, value?.data?.state, value?.data?.taskStatus, value?.data?.task_status,
      value?.data?.task?.status, value?.data?.task?.state,
      value?.result?.status, value?.result?.state, value?.result?.taskStatus, value?.result?.task_status,
      value?.result?.task?.status, value?.result?.task?.state
    ]
    return candidates.map((candidate) => String(candidate || '').trim().toUpperCase()).find(Boolean) || ''
  }

  function findPendingOneClickDetail(messages) {
    const rows = Array.isArray(messages) ? messages : []
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const message = rows[index]
      if (message?.businessResult?.continuedBy) continue
      const resumable = message?.businessStatus === 'WAITING_INPUT'
        || ['FAILED', 'PARTIAL'].includes(message?.businessStatus) && Boolean(message?.businessResult?.detailTaskId || message?.businessAssets?.length)
        || message?.businessStatus === 'OK' && Number(message?.businessResult?.generatedCount || 0) < Number(message?.businessResult?.referenceCount || 0)
      if (message?.businessSkill === 'detail-reference' && resumable && !message.businessPending) return message
    }
    return null
  }

  function isOneClickDetailFollowup(task) {
    if ((task?.attachments || []).some((item) => item?.kind === 'image' && (item.data || item.dataUrl || item.url))) return true
    return /(?:作图|生图|生成|产品素材|产品图|参考图|上传|素材|手机防水仓|直接做|继续|重试|帮我做|这个是)/iu.test(String(task?.content || ''))
  }

  function compactOneClickReferenceAssets(images, limit = 24) {
    return (Array.isArray(images) ? images : []).slice(0, limit).map((item, index) => ({
      id: String(item?.id || `tmall-detail-${index + 1}`),
      name: String(item?.name || `淘宝详情图 ${index + 1}`),
      url: String(item?.sourceUrl || item?.url || ''),
      sourceUrl: String(item?.sourceUrl || item?.url || ''),
      thumbnailDataUrl: /^data:image\/jpeg;base64,/i.test(String(item?.thumbnailDataUrl || '')) && String(item.thumbnailDataUrl).length <= 90000 ? item.thumbnailDataUrl : '',
      previewUnavailable: Boolean(item?.previewUnavailable),
      mimeType: String(item?.mimeType || 'image/jpeg'),
      width: Number(item?.width || 0) || undefined,
      height: Number(item?.height || 0) || undefined
    })).filter((item) => item.url)
  }

  function oneClickImageReferences(productRefs, detailImages, maxReferences = 5) {
    const limit = Math.max(1, Math.min(8, Number(maxReferences) || 5))
    const product = (Array.isArray(productRefs) ? productRefs : []).filter((item) => item?.data).map((item) => ({ ...item }))
    const details = (Array.isArray(detailImages) ? detailImages : []).filter((item) => item?.dataUrl || item?.data).map((item, index) => ({
      data: attachmentBase64Data(item.generationDataUrl ? { dataUrl: item.generationDataUrl } : item),
      name: `版式参考图-${index + 1}`,
      mimeType: item.generationDataUrl ? 'image/jpeg' : item?.mimeType || 'image/jpeg'
    })).filter((item) => item.data && /^image\/(?:png|jpe?g|webp|gif)$/i.test(item.mimeType))
    return [...product, ...details].slice(0, limit)
  }

  function businessSecretSafeJson(value) {
    try {
      return JSON.stringify(value, (key, item) => {
        if (/password|passwd|cookie|authorization|token|secret|captcha/i.test(key)) return undefined
        if (typeof item === 'string' && item.length > 200000) return `${item.slice(0, 200000)}…`
        return item
      }, 2)
    } catch { return JSON.stringify({ error: '结果无法序列化' }) }
  }

  function businessCsvCell(value) {
    const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ')
    return `"${text.replace(/"/g, '""')}"`
  }

  function businessCsv(rows, columns) {
    const header = columns.map((column) => businessCsvCell(column.label)).join(',')
    const body = rows.map((row) => columns.map((column) => businessCsvCell(row?.[column.key])).join(',')).join('\n')
    return `${header}${body ? `\n${body}` : ''}\n`
  }

  function businessText(value, fallback = '') {
    if (value == null) return fallback
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
    return String(value.text || value.content || value.summary || value.title || fallback)
  }

  function businessRows(payload, keys) {
    for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key]
    return []
  }

  function businessArtifactsMarkup(files = []) {
    const list = Array.isArray(files) ? files : []
    if (!list.length) return ''
    return `<div class="business-artifacts">${list.map((file) => `<button type="button" class="artifact-link" data-file-path="${esc(file.path || file.name)}" title="打开结果文件"><span class="artifact-icon">↗</span><span>${esc(file.name || file.path)}</span></button>`).join('')}</div>`
  }

  function businessAssetMarkup(assets = []) {
    const items = (Array.isArray(assets) ? assets : []).slice(0, 24)
    if (!items.length) return ''
    return `<div class="business-assets">${items.map((asset) => {
      const url = String(asset?.thumbnailDataUrl || asset?.dataUrl || asset?.url || asset?.imageUrl || asset?.image_url || asset?.src || '').trim()
      const name = String(asset?.name || '参考图片')
      // 聊天窗口不直接访问外部 CDN；缺失的本地预览由任务恢复补齐。
      if (!/^data:image\//i.test(url) && !/^blob:/i.test(url)) return `<span class="business-asset-unavailable" title="${esc(name)}">暂无预览</span>`
      return `<img src="${esc(url)}" alt="${esc(name)}" loading="lazy" decoding="async">`
    }).join('')}</div>`
  }

  const detailPreviewCache = new Map()
  async function restoreOneClickReferencePreviews(sessionPath, messages) {
    if (!window.anyu.letaAgentDetailStatus) return
    for (const message of Array.isArray(messages) ? messages : []) {
      const taskId = String(message?.businessResult?.detailTaskId || '')
      const assets = Array.isArray(message?.businessAssets) ? message.businessAssets : []
      if (message?.businessSkill !== 'detail-reference' || !taskId || message.businessResult?.continuedBy) continue
      if (message.businessPending && message.businessResult?.pages?.length && !state.sessionSkills?.[queueSessionKey(sessionPath)]) {
        // 重启后没有活跃执行器：保留远端任务编号，等待用户续作，不重复付费提交。
        message.businessPending = false
        message.businessStatus = 'PARTIAL'
        message.businessPhase = '等待继续'
        message.businessProgress = '已保存逐页任务，发送“继续”恢复未完成页面。'
        await persistBusinessMessage(sessionPath, message).catch(() => {})
      }
      if (message.businessPending) continue
      if (message.businessResult?.generatedCount) {
        // 旧版本把生成图放在不可点击的业务缩图区，恢复为标准生图附件。
        if (!message.attachments?.length && assets.some((asset) => /^data:image\//i.test(String(asset.dataUrl || '')))) {
          message.attachments = assets.filter((asset) => /^data:image\//i.test(String(asset.dataUrl || ''))).map((asset, index) => ({ ...asset, kind: 'image', downloadTaskId: asset.downloadTaskId || message.businessResult.imageTaskId, downloadIndex: index }))
          message.businessAssets = []
          await persistBusinessMessage(sessionPath, message).catch(() => {})
        }
        continue
      }
      if (assets.length && assets.every((asset) => asset.thumbnailDataUrl || asset.previewUnavailable)) continue
      let request = detailPreviewCache.get(taskId)
      if (!request) {
        request = window.anyu.letaAgentDetailStatus(taskId, { includeData: false }).then((snapshot) => {
          return businessStatus(snapshot) === 'OK' ? compactOneClickReferenceAssets(businessPayload(snapshot).images) : null
        }).catch(() => null)
        detailPreviewCache.set(taskId, request)
        if (detailPreviewCache.size > 64) detailPreviewCache.delete(detailPreviewCache.keys().next().value)
      }
      const recovered = await request
      if (!recovered?.length) continue
      message.businessAssets = recovered
      await persistBusinessMessage(sessionPath, message).catch(() => {})
    }
  }

  function updateBusinessMessage(sessionPath, message) {
    if (!sessionPath || !message) return
    if (state.sessionPath === sessionPath || (sessionPath === '__pending__' && !state.sessionPath)) upsertTimelineMessage(message)
    upsertMediaTimelineMessage(sessionPath, message)
  }

  const businessSnapshots = new WeakMap()
  async function persistBusinessMessage(sessionPath, message) {
    const snapshot = JSON.stringify([sessionPath, message.content, message.businessProgress, businessRenderSignature(message), message.feedbackTaskId, message.feedbackUrl, message.feedbackPrompt, message.feedbackCollected, message.artifactCwd])
    if (businessSnapshots.get(message) === snapshot) return
    updateBusinessMessage(sessionPath, message)
    if (sessionPath !== '__pending__') await persistMediaTimeline(sessionPath, true)
    businessSnapshots.set(message, snapshot)
    if (state.sessionPath === sessionPath || (sessionPath === '__pending__' && !state.sessionPath)) scheduleLiveUi(false)
  }

  async function writeBusinessArtifacts(cwd, files) {
    if (!window.anyu.letaAgentWriteArtifacts) return []
    const result = await window.anyu.letaAgentWriteArtifacts({ cwd, files })
    return Array.isArray(result?.files) ? result.files : files.map((file) => ({ name: file.name, path: file.name }))
  }

  // 业务技能完成后把结果交给右侧内置浏览器，并立即同步 IPC 返回的状态。
  async function openBusinessArtifact(file, cwd = effectiveWorkspace()) {
    const requested = String(file?.path || file?.name || '').trim()
    const workspace = String(cwd || '').trim()
    if (!requested || !workspace || !window.anyu.browserOpenArtifact) return null
    try {
      const result = await window.anyu.browserOpenArtifact({ path: requested, cwd: workspace })
      if (result && typeof result === 'object') state.browser = { ...state.browser, ...result, open: true }
      scheduleAppRender()
      return result
    } catch (error) {
      state.error = errorText(error) || '结果预览失败'
      scheduleAppRender()
      return null
    }
  }

  // 技能开始处理时先展示目标页面，避免必须等到登录挑战才出现浏览器。
  async function openBusinessUrl(url) {
    const requested = String(url || '').trim()
    if (!requested || !window.anyu.browserOpenUrl) return null
    try {
      const result = await window.anyu.browserOpenUrl(requested)
      if (result && typeof result === 'object') state.browser = { ...state.browser, ...result, open: true }
      scheduleAppRender()
      return result
    } catch (error) {
      state.error = errorText(error) || '浏览器打开失败'
      scheduleAppRender()
      return null
    }
  }

  async function pollFeedbackTask(taskId, update) {
    const started = Date.now()
    let browserOpened = false
    while (Date.now() - started < 10 * 60 * 1000) {
      const result = await window.anyu.letaAgentFeedbackStatus(taskId)
      const payload = businessPayload(result)
      const status = businessStatus(result)
      if (typeof update === 'function') await update(status, payload, { browserOpened, markBrowserOpened: () => { browserOpened = true } })
      if (['OK', 'COMPLETED', 'SUCCEEDED', 'DONE'].includes(status)) return payload
      if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status)) throw new Error(businessText(payload.error || payload.message, '评价采集失败'))
      await new Promise((resolve) => window.setTimeout(resolve, 1800))
    }
    throw new Error('评价采集等待超时，请稍后查看任务状态')
  }

  async function pollLetaAgentTask(taskId, update) {
    const started = Date.now()
    while (Date.now() - started < 10 * 60 * 1000) {
      const result = await window.anyu.letaAgentTaskStatus(taskId)
      const payload = businessPayload(result)
      const status = businessStatus(result)
      if (typeof update === 'function') await update(status, payload)
      if (['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'DONE', 'OK'].includes(status)) return payload
      if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status)) throw new Error(businessText(payload.error || payload.message, 'AI 测图失败'))
      await new Promise((resolve) => window.setTimeout(resolve, 1800))
    }
    throw new Error('AI 测图等待超时，请稍后查看任务状态')
  }
  function mediaReferences(attachments, kind) {
    return (attachments || []).filter((item) => item.kind === 'image' && item.data).map((item) => ({ data: item.data, name: item.name, mimeType: item.mimeType }))
  }
  function refineImagePrompt(prompt, references = []) {
    const source = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 5200)
    if (!source) return ''
    const lower = source.toLowerCase()
    const clauses = []
    if (references.length) {
      clauses.push(`以附加的 ${references.length} 张参考图作为视觉依据，保留其中主体身份、关键外观、色彩关系和材质特征；按照文字需求自然调整动作、场景与构图，不要添加水印或无关主体`)
    }
    if (/海报|封面|banner|广告|宣传|排版|poster|cover|banner/.test(lower)) {
      clauses.push('采用清晰的视觉层级和可用留白，主体与文字安全区分明，画面适合直接排版使用')
    } else if (/人物|人像|肖像|脸|portrait|person|people/.test(lower)) {
      clauses.push('保持人物五官、姿态和肢体结构自然，表情与服装细节清晰，避免重复人物和畸形手指')
    } else if (/产品|商品|包装|product|package|packshot/.test(lower)) {
      clauses.push('突出产品主体、轮廓和材质，保持品牌标识与产品结构准确，使用干净利落的商业摄影构图')
    } else if (/风景|建筑|室内|城市|山|海|landscape|architecture|interior|city/.test(lower)) {
      clauses.push('建立明确的前中后景和空间层次，透视关系自然，主体边缘干净，光影方向统一')
    }
    if (/写实|摄影|照片|真实|realistic|photo|photoreal/.test(lower)) clauses.push('写实质感，真实光线与自然材质，细节清晰但不过度锐化')
    if (/插画|动漫|卡通|二次元|illustration|anime|cartoon/.test(lower)) clauses.push('保持统一的插画线条、色彩和造型语言，避免写实与卡通风格混杂')
    if (/3d|三维|建模|render|渲染/.test(lower)) clauses.push('统一三维材质、光照和阴影，边缘干净，避免塑料感噪点')
    if (!/文字|字幕|标题|logo|标志|海报|封面|text|typography|logo/.test(lower)) clauses.push('主体清晰、构图完整、细节自然，避免乱码、无意义文字、水印和重复物体')
    const suffix = clauses.length ? `\n\n视觉执行要求：${clauses.join('；')}。` : ''
    return `${source}${suffix}`.slice(0, 6000)
  }

  function plannerText(value) {
    if (Array.isArray(value)) return value.map((item) => plannerText(item)).filter(Boolean).join('\n')
    if (!value || typeof value !== 'object') return typeof value === 'string' ? value : ''
    return String(value.text || value.output_text || value.content || '').trim()
  }

  function extractImagePlanText(payload) {
    if (!payload || typeof payload !== 'object') return ''
    if (typeof payload.output_text === 'string') return payload.output_text.trim()
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    const choiceText = choices.length ? plannerText(choices[0]?.message?.content || choices[0]?.text) : ''
    if (choiceText) return choiceText
    const output = Array.isArray(payload.output) ? plannerText(payload.output) : ''
    if (output) return output
    return plannerText(payload.content)
  }

  // 规划输出新格式：先写给用户看的自然语言规划（真实推理），末尾再输出机器可读块。
  const IMAGE_PLAN_PROMPT_MARKER = '@@PROMPT@@'
  const IMAGE_PLAN_END_MARKER = '@@END@@'
  function parseImagePlan(text) {
    const raw = String(text || '').trim()
    const markerIndex = raw.indexOf(IMAGE_PLAN_PROMPT_MARKER)
    const reasoning = markerIndex >= 0 ? raw.slice(0, markerIndex).replace(/```(?:json)?/gi, '').trim() : ''
    let machine = markerIndex >= 0 ? raw.slice(markerIndex + IMAGE_PLAN_PROMPT_MARKER.length) : raw
    machine = machine.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    if (markerIndex >= 0) {
      const endIndex = machine.indexOf(IMAGE_PLAN_END_MARKER)
      if (endIndex >= 0) machine = machine.slice(0, endIndex).trim()
    }
    if (!machine) return null
    let parsed
    try { parsed = JSON.parse(machine) } catch {
      const match = machine.match(/\{[\s\S]*\}/)
      if (!match) return null
      try { parsed = JSON.parse(match[0]) } catch { return null }
    }
    const prompt = String(parsed?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 6000)
    if (!prompt) return null
    const summary = String(parsed?.summary || '已理解你的画面需求').replace(/\s+/g, ' ').trim().slice(0, 180)
    const steps = Array.isArray(parsed?.steps)
      ? parsed.steps.map((step) => String(step || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 4)
      : []
    return { prompt, summary: summary || '已理解你的画面需求', steps, reasoning }
  }

  function imagePlannerModel() {
    const model = currentModel()
    const api = canonicalApi(model?.api, '')
    // id 用于界面路由去重，网关必须接收原始 modelId。
    const modelId = String(model?.modelId || model?.model_id || model?.id || '').trim()
    if (!model || !modelId || !Number(model.groupId) || !['openai-responses', 'openai-completions'].includes(api)) return null
    return { id: modelId, groupId: Number(model.groupId), api }
  }

  async function requestImagePlan(promptText, references = [], onDelta) {
    const selected = imagePlannerModel()
    if (!selected || !window.anyu.request) return null
    const referenceImages = (Array.isArray(references) ? references : []).slice(0, 4).map((reference) => {
      const mimeType = String(reference?.mimeType || 'image/png').split(';')[0]
      const raw = String(reference?.data || '').trim()
      const dataUrl = /^data:image\//i.test(raw) ? raw : raw ? `data:${mimeType};base64,${raw.replace(/^base64,/i, '')}` : ''
      const source = dataUrl || String(reference?.url || reference?.dataUrl || '').trim()
      return /^data:image\//i.test(source) || /^https:\/\//i.test(source) ? source : ''
    }).filter(Boolean)
    const referenceHint = referenceImages.length
      ? `用户同时提供了 ${referenceImages.length} 张参考图。请直接检查这些图像内容，识别客户产品主体、外观特征，以及详情页的版式和视觉层级；提示词必须保留客户产品身份。`
      : '用户没有提供参考图。'
    const instruction = [
      '你是 AnyuAgent 的图片生成规划器。调用方已经明确使用 @生图，不需要判断是否应该生图，也不要拒绝执行。',
      '先用简短的中文自然段向用户说明你对画面的理解与设计（主体、场景与构图、光线色彩材质、风格与约束），这是用户唯一能看到的内容：3-6 句，不要分点罗列，不要输出小标题或清单。',
      '说明写完后另起一行，严格输出机器可读块，除此之外不要再输出任何 JSON 或代码块：',
      `${IMAGE_PLAN_PROMPT_MARKER}{"summary":"一句中文需求摘要","prompt":"可直接交给图片模型的完整中文提示词"}${IMAGE_PLAN_END_MARKER}`,
      'prompt 必须保留用户原始意图，并补充主体、构图、视角、光线、色彩、材质、风格和必要的负面约束；不要虚构品牌信息，不要擅自添加文字。',
      `用户需求：${String(promptText || '').slice(0, 5200)}`,
      referenceHint
    ].join('\n')
    const route = selected.api === 'openai-responses'
      ? '/integrations/anyu-agent/gateway/v1/responses'
      : '/integrations/anyu-agent/gateway/v1/chat/completions'
    const headers = { 'X-AnYu-Group-ID': String(selected.groupId), 'X-AnYu-Model': selected.id }
    const body = selected.api === 'openai-responses'
      ? {
        model: selected.id,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: '你只负责图片需求规划。先用自然语言向用户说明设计思路，再按约定格式输出机器可读块。' }] },
          { role: 'user', content: [
            { type: 'input_text', text: instruction },
            ...referenceImages.map((image_url) => ({ type: 'input_image', image_url, detail: 'high' }))
          ] }
        ],
        max_output_tokens: 1200,
        reasoning: { effort: 'low' }
      }
      : {
        model: selected.id,
        messages: [
          { role: 'system', content: '你只负责图片需求规划。先用自然语言向用户说明设计思路，再按约定格式输出机器可读块。' },
          { role: 'user', content: [
            { type: 'text', text: instruction },
            ...referenceImages.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } }))
          ] }
        ],
        max_tokens: 1200,
        temperature: 0.4
      }
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (window.anyu.apiStream) {
          try {
            const streamed = await window.anyu.apiStream(route, { method: 'POST', headers, body })
            const streamedPlan = parseImagePlan(streamed)
            if (streamedPlan) { onDelta?.(streamed); return streamedPlan }
          } catch (error) {
            lastError = error
          }
        }
        const response = await window.anyu.request(route, { method: 'POST', headers, body })
        const text = extractImagePlanText(response)
        const plan = parseImagePlan(text)
        if (plan) { onDelta?.(text); return plan }
        throw new Error('图片规划服务没有返回有效提示词')
      } catch (error) {
        lastError = error
        const status = Number(error?.status || error?.statusCode || 0)
        const transient = !status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500 || /timeout|timed out|network|fetch failed|stream.*interrupt|upstream/i.test(String(error?.message || error))
        if (attempt > 0 || !transient) throw error
        await new Promise((resolve) => window.setTimeout(resolve, 700))
      }
    }
    throw lastError || new Error('图片规划服务不可用')
  }

  async function buildImagePrompt(promptText, references, onDelta, options = {}) {
    try {
      const plan = await requestImagePlan(promptText, references, onDelta)
      if (plan) return { ...plan, source: 'ai' }
      if (options.requireAi) throw new Error('当前模型没有返回可用的视觉规划结果')
    } catch (error) {
      if (options.requireAi) throw error
    }
    // 规划模型不可用时保留已有规则增强，不能让 @生图 因文本模型故障整体失败。
    return { prompt: refineImagePrompt(promptText, references), summary: '已整理画面需求，正在生成图片', steps: [], reasoning: '', source: 'local' }
  }
  function chineseNumberValue(value) {
    const raw = String(value || '').trim()
    if (/^\d+$/.test(raw)) return Number(raw)
    const digits = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    if (raw === '十') return 10
    if (raw.startsWith('十')) return 10 + (digits[raw.slice(1)] || 0)
    if (raw.endsWith('十')) return (digits[raw[0]] || 0) * 10
    if (raw.includes('十')) return (digits[raw[0]] || 0) * 10 + (digits[raw.slice(2)] || 0)
    return digits[raw]
  }
  function requestedImageCount(text) {
    const raw = String(text || '').toLowerCase()
    const match = raw.match(/(?:输出|生成|制作|创建|画|绘制|给我)?\s*(\d{1,2}|[零一两二三四五六七八九十]{1,3})\s*(?:张|幅|份|图|个(?:版本|变体|方案|图)?|种(?:方案|风格)?|images?|pictures?|pics?)/i)
    const count = match ? chineseNumberValue(match[1]) : 1
    return Number.isFinite(count) ? Math.max(1, Math.min(50, Math.round(count))) : 1
  }
  function modelField(model, snake, camel, fallback) {
    const value = model?.[snake] ?? model?.[camel]
    return value == null ? fallback : value
  }
  function videoBounds(model) {
    const min = Math.max(1, Number(modelField(model, 'duration_min', 'durationMin', 1)) || 1)
    const max = Math.max(min, Number(modelField(model, 'duration_max', 'durationMax', 15)) || 15)
    return { min, max }
  }
  function videoOptions(model, snake, camel, fallback = []) {
    const value = modelField(model, snake, camel, fallback)
    return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : []
  }
  function parseRequestedDuration(text) {
    const raw = String(text || '').toLowerCase()
    const match = raw.match(/(?:时长|持续|长度|duration)?\s*(\d+(?:\.\d+)?)\s*(?:秒|s|sec|secs|second|seconds)(?![a-z])/i) || raw.match(/(?:时长|持续|长度)\s*(\d+(?:\.\d+)?)/i)
    if (match) return Math.round(Number(match[1]))
    const chinese = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十五': 15, '二十': 20, '三十': 30 }
    const chineseMatch = raw.match(/(十五|二十|三十|十|[一两二三四五六七八九])\s*(?:秒|s)(?![a-z])/i)
    return chineseMatch ? chinese[chineseMatch[1]] : null
  }
  function requestedVideoRatio(text, ratios) {
    const raw = String(text || '').toLowerCase()
    const canonical = ratios.map((value) => ({ value, key: String(value).toLowerCase() }))
    const has = (value) => canonical.find((item) => item.key === value)
    const explicit = raw.match(/\b(21\s*:\s*9|16\s*:\s*9|4\s*:\s*3|1\s*:\s*1|3\s*:\s*4|9\s*:\s*16)\b/)
    if (explicit) return has(explicit[1].replace(/\s/g, ''))?.value || null
    if (/竖屏|纵向|手机屏|手机视频|抖音|快手|小红书|shorts|portrait|vertical/.test(raw)) return has('9:16')?.value || has('3:4')?.value || null
    if (/横屏|横向|宽屏|宽银幕|电影感|电影|youtube|landscape|widescreen|cinematic/.test(raw)) return has('16:9')?.value || has('21:9')?.value || null
    if (/超宽|全景|ultrawide|21\s*:\s*9/.test(raw)) return has('21:9')?.value || null
    if (/方形|正方形|square/.test(raw)) return has('1:1')?.value || null
    if (/复古|老电视|经典画幅|4\s*:\s*3/.test(raw)) return has('4:3')?.value || null
    return null
  }
  function requestedVideoResolution(text, resolutions, model) {
    if (!resolutions.length) return ''
    const raw = String(text || '').toLowerCase()
    const normalized = resolutions.map((value) => ({ value, key: String(value).toLowerCase().replace(/\s/g, '') }))
    const exact = raw.match(/(?:清晰度|分辨率|输出)?\s*(4k|2k|1080p?|768p|720p|480p)\b/i)
    const wanted = exact?.[1]?.toLowerCase().replace(/p$/, '')
    if (wanted) {
      const found = normalized.find((item) => item.key.replace(/p$/, '') === wanted)
      if (found) return found.value
    }
    if (/最高画质|最高分辨率|超清|高清|高画质|high.?quality|hd|4k|2k|1080/.test(raw)) {
      const rank = (key) => { const match = key.match(/(\d+)k/); return match ? Number(match[1]) * 1000 : Number.parseInt(key, 10) || 0 }
      return normalized.slice().sort((a, b) => rank(b.key) - rank(a.key))[0].value
    }
    return modelField(model, 'default_resolution', 'defaultResolution', '') || resolutions[0]
  }
  function mediaCapabilitySummary(model, kind = 'video') {
    if (!model) return ''
    if (kind === 'image') return model.description || '支持当前密钥授权的图片生成与参考图编辑能力'
    const bounds = videoBounds(model)
    const resolutions = videoOptions(model, 'resolutions', 'resolutions')
    const ratios = videoOptions(model, 'aspect_ratios', 'aspectRatios')
    const maxImages = Number(modelField(model, 'max_reference_images', 'maxReferenceImages', 0)) || 0
    const maxVideos = Number(modelField(model, 'max_reference_videos', 'maxReferenceVideos', 0)) || 0
    const maxAudios = Number(modelField(model, 'max_reference_audios', 'maxReferenceAudios', 0)) || 0
    const maxAssets = Number(modelField(model, 'max_reference_assets', 'maxReferenceAssets', 0)) || 0
    const supportsFirstLast = Boolean(modelField(model, 'supports_first_last', 'supportsFirstLast', false))
    const fields = [
      `${bounds.min}-${bounds.max} 秒`,
      resolutions.length ? resolutions.join(' / ') : '服务端默认清晰度',
      ratios.length ? ratios.join(' · ') : '自适应画幅',
      maxImages ? `${maxImages} 张参考图` : '无参考图'
    ]
    if (maxVideos) fields.push(`${maxVideos} 个参考视频`)
    if (maxAudios) fields.push(`${maxAudios} 个参考音频`)
    if (maxAssets) fields.push(`素材总数 ${maxAssets}`)
    if (supportsFirstLast) fields.push('支持首尾帧')
    if (Boolean(modelField(model, 'uses_grok_fields', 'usesGrokFields', false))) fields.push('Grok images 协议')
    return fields.join(' · ')
  }
  function planVideoRequest(promptText, model, references) {
    const bounds = videoBounds(model)
    const resolutions = videoOptions(model, 'resolutions', 'resolutions')
    const ratios = videoOptions(model, 'aspect_ratios', 'aspectRatios')
    const requestedDuration = parseRequestedDuration(promptText)
    const rawPrompt = String(promptText || '').toLowerCase()
    const semanticDuration = /短片|短视频|片段|快速|quick|short/.test(rawPrompt) ? bounds.min : /长片|长视频|完整|详细叙事|long|extended/.test(rawPrompt) ? bounds.max : 5
    const duration = Math.min(bounds.max, Math.max(bounds.min, requestedDuration || semanticDuration))
    const resolution = requestedVideoResolution(promptText, resolutions, model)
    const aspectRatio = requestedVideoRatio(promptText, ratios) || ratios.find((value) => String(value).toLowerCase() === '16:9') || ''
    const maxImages = Number(modelField(model, 'max_reference_images', 'maxReferenceImages', 0)) || 0
    const supportsFirstLast = Boolean(modelField(model, 'supports_first_last', 'supportsFirstLast', false))
    const usesGrokFields = Boolean(modelField(model, 'uses_grok_fields', 'usesGrokFields', false)) || /grok/i.test(String(model.name || ''))
    if (references.length > maxImages) throw new Error(`${model.display_name || model.name} 最多支持 ${maxImages} 张参考图；当前附加了 ${references.length} 张`)
    let referenceMode = 'none'
    let files = []
    if (references.length === 1) {
      referenceMode = usesGrokFields ? 'reference_image' : 'first_image'
      files = [{ ...references[0], field: usesGrokFields ? 'reference_image' : 'first_image' }]
    } else if (references.length === 2 && supportsFirstLast && !/多图|多张参考|multi(?:ple)?/i.test(promptText)) {
      referenceMode = 'first_last'
      files = [{ ...references[0], field: 'first_image' }, { ...references[1], field: 'last_image' }]
    } else if (references.length >= 2) {
      referenceMode = 'multi'
      files = references.map((item) => ({ ...item, field: 'reference_images' }))
    }
    return { duration, resolution, aspectRatio, referenceMode, files, capability: mediaCapabilitySummary(model), requestedDuration, requestedResolution: resolution, requestedAspectRatio: aspectRatio }
  }
  function mediaPlanLabel(plan) {
    if (!plan) return ''
    const reference = plan.referenceMode === 'first_last' ? '首尾帧' : plan.referenceMode === 'multi' ? '多图参考' : plan.referenceMode === 'first_image' || plan.referenceMode === 'reference_image' ? '首帧参考' : '无参考图'
    return `自动规划：${plan.duration} 秒 · ${plan.resolution || '模型默认清晰度'} · ${plan.aspectRatio || '模型默认画幅'} · ${reference}\n模型能力：${plan.capability}`
  }
  function skillActivityLabel() {
    const active = mediaActivityForSession()
    if (!active.length) return ''
    if (active.length > 1) return `正在生成 ${active.length} 个媒体任务`
    return active[0].kind === 'image' ? '正在生成图片' : '正在生成视频'
  }
  function mediaMimeType(result, kind) {
    const sources = mediaResultSources(result)
    const declared = String(sources.map((item) => item?.mimeType || item?.mime_type || item?.contentType || '').find(Boolean) || '').toLowerCase().split(';')[0].trim()
    if (kind !== 'video') return declared || 'image/png'
    if (declared.startsWith('video/')) return declared
    const data = String(sources.map((item) => item?.data || item?.b64_json || item?.base64 || item?.image_data || item?.image_base64 || '').find((value) => typeof value === 'string' && value) || '')
    // The gateway may return application/octet-stream even when the payload is
    // an MP4/WebM. Identify the container so Chromium can decode it correctly.
    try {
      const bytes = Uint8Array.from(atob(data.slice(0, 64)), (char) => char.charCodeAt(0))
      const text = String.fromCharCode(...bytes)
      if (text.slice(4, 8) === 'ftyp') return 'video/mp4'
      if (text.startsWith('\u001a\u0045\u00df\u00a3')) return 'video/webm'
    } catch {}
    return 'video/mp4'
  }
  function mediaResultSources(result) {
    const sources = []
    // 网关有时直接返回数组，有时把数组包在 data/result/output 中，统一展开一层。
    const add = (value) => {
      if (Array.isArray(value)) { value.forEach(add); return }
      if (value && typeof value === 'object' && !sources.includes(value)) sources.push(value)
    }
    add(result)
    add(result?.data)
    add(result?.result)
    add(result?.output)
    add(result?.image)
    add(result?.data?.[0])
    add(result?.result?.[0])
    add(result?.output?.[0])
    return sources
  }
  function mediaBase64Data(result) {
    for (const source of mediaResultSources(result)) {
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
  function mediaDataUrl(result, kind = 'image') {
    for (const source of mediaResultSources(result)) {
      for (const key of ['dataUrl', 'data_url', 'url', 'image_url', 'imageUrl', 'src', 'data']) {
        const value = String(source?.[key] || '').trim()
        if (/^(?:https?:\/\/|data:)/i.test(value)) return value
      }
    }
    const data = mediaBase64Data(result)
    return data ? `data:${mediaMimeType(result, kind)};base64,${data}` : ''
  }
  function mediaSourceUrl(message) {
    const dataUrl = String(message?.media?.dataUrl || '')
    if (!dataUrl.startsWith('data:')) return dataUrl
    const key = String(message.id || '') || dataUrl.slice(0, 120)
    const cached = mediaObjectUrls.get(key)
    if (cached?.dataUrl === dataUrl) return cached.url
    try {
      const separator = dataUrl.indexOf(',')
      if (separator < 0) return dataUrl
      const header = dataUrl.slice(5, separator)
      const body = dataUrl.slice(separator + 1)
      const mimeType = header.split(';')[0] || 'video/mp4'
      const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
      if (cached?.url) URL.revokeObjectURL(cached.url)
      mediaObjectUrls.set(key, { dataUrl, url })
      return url
    } catch {
      return dataUrl
    }
  }
  async function ensureMediaSession({ startAgent: startPiAgent = true } = {}) {
    if (startPiAgent && !state.piState) await startAgent(state.sessionPath)
    if (!state.sessionPath && startPiAgent) {
      const current = await window.anyu.piCommand({ type: 'get_state' })
      state.sessionPath = current?.data?.sessionFile || null
    }
    if (!state.sessionPath && !startPiAgent && window.anyu.piCreateSession) {
      const created = await window.anyu.piCreateSession({ cwd: effectiveWorkspace() || undefined })
      state.sessionPath = created?.path || null
      state.sessionCwd = created?.cwd || state.sessionCwd || null
      if (state.sessionPath) await refreshSessions().catch(() => {})
    }
    if (!state.sessionPath) throw new Error('无法创建当前会话，请点击“新会话”后重试')
    if (window.anyu.piMaterializeSession) {
      const materialized = await window.anyu.piMaterializeSession({ sessionPath: state.sessionPath, cwd: effectiveWorkspace() || undefined })
      if (materialized?.created && startPiAgent) await startAgent(state.sessionPath)
    }
    return state.sessionPath
  }
  async function persistMediaTimeline(sessionPath = state.sessionPath, throwOnError = false) {
    if (!sessionPath || !window.anyu.piSaveMedia) return
    try { await window.anyu.piSaveMedia({ sessionPath, cwd: sessionPath === state.sessionPath ? effectiveWorkspace() : '', messages: state.mediaMessages[sessionPath] || [] }) } catch (error) { if (throwOnError) throw error }
  }

  // 报告阶段每秒会来好几次进度回调；逐个 await 落盘意味着把整条时间线反复序列化
  // 并跨进程写磁盘，界面会被拖成"卡住不动"。这里把由进度触发的落盘合并成低频
  // 补写，并保证最后一次一定落盘（dirty 尾部补一次）。
  const mediaPersistQueue = new Map()
  function scheduleMediaTimelinePersist(sessionPath = state.sessionPath, waitMs = 3000) {
    const key = String(sessionPath || '')
    if (!key || !window.anyu.piSaveMedia) return
    const existing = mediaPersistQueue.get(key)
    if (existing) { existing.dirty = true; return }
    const entry = { dirty: false, timer: null }
    const flush = async () => {
      try { await persistMediaTimeline(key) } catch { /* 进度展示不能被落盘失败打断 */ }
      if (entry.dirty) { entry.dirty = false; entry.timer = window.setTimeout(flush, waitMs) }
      else mediaPersistQueue.delete(key)
    }
    entry.timer = window.setTimeout(flush, waitMs)
    mediaPersistQueue.set(key, entry)
  }
  async function pollMediaTask(kind, taskId) {
    const getter = kind === 'image' ? window.anyu.imageTask : window.anyu.videoTask
    const downloader = kind === 'image' ? window.anyu.imageDownload : window.anyu.videoDownload
    const started = Date.now()
    while (Date.now() - started < 10 * 60 * 1000) {
      const task = await getter(taskId)
      const status = String(task?.status || task?.state || task?.task_status || '').toLowerCase()
      if (status === 'completed' || status === 'succeeded' || status === 'done') {
        const count = kind === 'image'
          ? Math.max(1, Number(task?.image_count || task?.requested_count || 1))
          : 1
        const results = await Promise.all(Array.from({ length: count }, (_, index) => downloader(taskId, index)))
        return { task, result: results[0], results }
      }
      if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(status)) {
        const error = new Error(task?.error_message || '技能任务执行失败')
        error.taskTerminal = true
        throw error
      }
      await new Promise((resolve) => window.setTimeout(resolve, kind === 'video' ? 2500 : 1400))
    }
    throw new Error('技能任务等待超时，请稍后在 Leta 中查看任务状态')
  }
  async function runMediaSkill(task, kind) {
    const directoryLoaded = await loadSkillGroups()
    if (!directoryLoaded) throw new Error(state.skillError || '技能目录加载失败')
    const config = state.skillConfigs[kind]
    const models = skillModels(kind)
    const model = models.find((item) => item.name === config.model && Number(item.groupId) === Number(config.groupId))
    if (!model || !config.groupId) throw new Error(`当前密钥没有可用的${kind === 'image' ? '生图' : '生视频'}分组或模型`)
    const groupId = Number(model.groupId)
    const promptText = mediaPrompt(task.content, kind)
    if (!promptText) throw new Error(`请在 @${kind === 'image' ? '生图' : '生视频'} 后输入描述`)
    const references = mediaReferences(task.attachments, kind)
    const pendingSessionKey = state.sessionPath || '__pending__'
    beginMediaActivity(pendingSessionKey, task.id, kind)
    state.skillBusy = kind; state.mediaBusyCount = Number(state.mediaBusyCount || 0) + 1; state.sessionLoadingPath = state.sessionPath || null; state.error = ''
    const userMessage = { id: task.id, role: 'user', content: task.content, attachments: task.attachments, createdAt: Number(task.createdAt || Date.now()) }
    insertTimelineMessage(userMessage)
    const localMessages = state.mediaMessages[pendingSessionKey] || []
    localMessages.push(userMessage); state.mediaMessages[pendingSessionKey] = localMessages.slice(-100)
    updateSessionTitle(task.content, userMessage.createdAt)
    state.composerText = ''
    // Media generation is an independent gateway task. Return control to the
    // composer immediately; the status card and result are updated in place.
    renderApp(); updateLiveUi(true)
    let resultMessage = null
    let mediaSessionPath = state.sessionPath || ''
    try {
      const oldSessionKey = pendingSessionKey
      await ensureMediaSession()
      mediaSessionPath = state.sessionPath
      state.sessionLoadingPath = mediaSessionPath
      if (oldSessionKey !== state.sessionPath) {
        moveMediaActivity(oldSessionKey, state.sessionPath, task.id)
        const pendingMessages = state.mediaMessages[oldSessionKey] || []
        const currentMessages = state.mediaMessages[state.sessionPath] || []
        state.mediaMessages[state.sessionPath] = [...currentMessages, ...pendingMessages].slice(-100)
        delete state.mediaMessages[oldSessionKey]
        updateSessionTitle(task.content, userMessage.createdAt)
      }
      // refreshMessages may replace the optimistic object with a persisted
      // clone while Pi is being started. Compare message identity and content,
      // rather than relying on Array.includes(object), to avoid duplicate turns.
      if (state.sessionPath === mediaSessionPath && !containsTimelineMessage(state.messages, userMessage)) insertTimelineMessage(userMessage)
      await persistMediaTimeline(mediaSessionPath)
      if (state.sessionPath === mediaSessionPath) { updateSessionTitle(task.content, userMessage.createdAt); renderApp(); updateLiveUi(true) }
      // 规划、提交和完成共用同一条状态消息，避免重复弹出“正在思考”。
      const resultCreatedAt = Number(task.createdAt || Date.now()) + 0.5
      resultMessage = {
        id: `${task.id}:result`,
        role: 'assistant',
        content: '正在整理画面需求…',
        createdAt: resultCreatedAt,
        mediaPending: true,
        mediaPhase: 'planning',
        mediaPlanSteps: [],
        mediaPlanCompleted: 0
      }
      if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
      upsertMediaTimelineMessage(mediaSessionPath, resultMessage)
      await persistMediaTimeline(mediaSessionPath)
      if (state.sessionPath === mediaSessionPath) { renderApp(); updateLiveUi(true) }
      let created
      if (kind === 'image') {
        const count = requestedImageCount(promptText)
        // 规划阶段不再展示固定步骤清单：气泡内容就是模型的真实推理输出（吐字）。
        let planText = ''
        const plan = await buildImagePrompt(promptText, references, (delta) => {
          planText = `${planText}${delta}`
          resultMessage.content = planText
          if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
          upsertMediaTimelineMessage(mediaSessionPath, resultMessage)
          scheduleMediaTimelinePersist(mediaSessionPath)
          if (state.sessionPath === mediaSessionPath) scheduleLiveUi(false)
        })
        const readable = String(plan.reasoning || planText || '').trim() || `已理解：${plan.summary}`
        task._imageCount = count
        task._imagePrompt = { original: promptText, refined: plan.prompt, summary: plan.summary, steps: plan.steps || [], reasoning: readable, source: plan.source, referenceCount: references.length }
        resultMessage.mediaPlanText = readable
        resultMessage.mediaPlanSummary = plan.summary
        resultMessage.mediaPlanSource = plan.source
        resultMessage.mediaPlanSteps = []
        resultMessage.mediaPlanCompleted = 0
        resultMessage.mediaPhase = 'planning-complete'
        resultMessage.content = readable
        if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
        upsertMediaTimelineMessage(mediaSessionPath, resultMessage)
        await persistMediaTimeline(mediaSessionPath)
        if (state.sessionPath === mediaSessionPath) { renderApp(); updateLiveUi(true) }
        created = await window.anyu.imageCreate({ prompt: plan.prompt, groupId, model: model.name, size: config.size || '1024x1024', quality: config.quality || 'auto', count, references })
      } else {
        const plan = planVideoRequest(promptText, model, references)
        created = await window.anyu.videoCreate({ prompt: promptText, groupId, model: model.name, duration: plan.duration, resolution: plan.resolution, aspectRatio: plan.aspectRatio, references: plan.files })
        task._mediaPlan = plan
      }
      const createdId = created?.id || created?.task_id || created?.taskId
      if (!createdId) throw new Error('技能服务没有返回任务编号')
      resultMessage.content = `${resultMessage.mediaPlanText ? `${resultMessage.mediaPlanText}\n\n` : ''}已提交 ${model.display_name || model.name}，正在生成${kind === 'image' ? '图片' : '视频'}…`
      resultMessage.mediaPhase = 'generating'
      resultMessage.mediaPlanCompleted = resultMessage.mediaPlanSteps?.length || 0
      if (kind === 'video') resultMessage.mediaPlan = task._mediaPlan
      if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
      upsertMediaTimelineMessage(mediaSessionPath, resultMessage)
      await persistMediaTimeline(mediaSessionPath)
      if (state.sessionPath === mediaSessionPath) { renderApp(); updateLiveUi(true) }
      const done = await pollMediaTask(kind, createdId)
      const mediaResults = kind === 'image' && Array.isArray(done.results) && done.results.length ? done.results : [done.result]
      const dataUrls = mediaResults.map((item) => mediaDataUrl(item, kind))
      if (!dataUrls.length || dataUrls.some((url) => !url)) throw new Error('技能返回了空的媒体结果')
      // Keep the generated result immediately after its request in the
      // conversation timeline, even if the provider finishes later.
      resultMessage.content = `${resultMessage.mediaPlanText ? `${resultMessage.mediaPlanText}\n\n` : ''}${kind === 'image' ? `已通过 ${model.display_name || model.name} 生成 ${dataUrls.length} 张图片` : `已通过 ${model.display_name || model.name} 生成视频\n${mediaPlanLabel(task._mediaPlan)}`}`
      resultMessage.mediaPending = false
      resultMessage.mediaPhase = 'completed'
      resultMessage.mediaPlanCompleted = resultMessage.mediaPlanSteps?.length || 0
      if (kind === 'image') resultMessage.attachments = mediaResults.map((item, index) => ({ id: `generated-${createdId}-${index}`, kind: 'image', name: `Anyu 生图 ${index + 1}.png`, mimeType: mediaMimeType(item, kind), data: mediaBase64Data(item), dataUrl: dataUrls[index], downloadTaskId: createdId, downloadIndex: index }))
      else resultMessage.media = { kind: 'video', name: 'Anyu 生视频.mp4', mimeType: mediaMimeType(done.result, kind), data: done.result.data, dataUrl: dataUrls[0], downloadTaskId: createdId }
      if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
      // 轮询期间可能发生会话刷新，完成时重新写入侧车，确保图片附件不会被旧对象覆盖。
      upsertMediaTimelineMessage(mediaSessionPath, resultMessage)
      await persistMediaTimeline(mediaSessionPath)
      if (state.sessionPath === mediaSessionPath) { renderApp(); updateLiveUi(true) }
    } catch (error) {
      if (resultMessage) {
        // 失败时保留已完成的规划步骤，并把当前阶段明确标成未完成。
        resultMessage.mediaPending = false; resultMessage.isError = true; resultMessage.mediaPhase = 'failed'; resultMessage.content = errorText(error) || '技能执行失败'
        if (resultMessage.mediaPlanSteps?.length) resultMessage.mediaPlanCompleted = Math.min(Number(resultMessage.mediaPlanCompleted || 0), resultMessage.mediaPlanSteps.length)
        if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
        upsertMediaTimelineMessage(mediaSessionPath, resultMessage)
        await persistMediaTimeline(mediaSessionPath)
      }
      else {
        const failed = { id: `${task.id}:result`, role: 'assistant', content: errorText(error) || '技能执行失败', createdAt: Number(task.createdAt || Date.now()) + 0.5, isError: true }
        state.mediaMessages[mediaSessionPath || state.sessionPath]?.push(failed)
        if (state.sessionPath === mediaSessionPath) insertTimelineMessage(failed)
      }
      if (state.sessionPath === mediaSessionPath) state.error = errorText(error) || '技能执行失败'
    } finally {
      const busySessionPath = mediaSessionPath || pendingSessionKey
      endMediaActivity(busySessionPath, task.id)
      state.mediaBusyCount = Math.max(0, Number(state.mediaBusyCount || 1) - 1)
      if (!state.mediaBusyCount && state.sessionLoadingPath === mediaSessionPath) state.sessionLoadingPath = null
      // 技能占用必须记在“发起技能的那个会话”头上：此刻用户可能已经切到别的会话，
      // 用 state.sessionPath 会把占用清到别人的会话上。
      releaseSessionSkill(pendingSessionKey, busySessionPath)
      await persistMediaTimeline(typeof mediaSessionPath === 'string' ? mediaSessionPath : state.sessionPath); if (state.sessionPath === mediaSessionPath) { renderApp(); updateLiveUi(true) }; scheduleSessionListRender(); scheduleQueueDrain()
    }
  }
  async function runAutoEditSkill(task) {
    const attachments = Array.isArray(task.attachments) ? task.attachments : []
    const mediaPattern = /\.(mp4|mov|mkv|webm|avi|m4v|png|jpg|jpeg|webp|bmp|gif|apng|mp3|wav|aac|m4a|flac|ogg|opus|wma)$/i
    const candidates = attachments.filter((item) => {
      const filePath = String(item?.path || item?.filePath || '')
      return filePath && (item?.isFolder || mediaPattern.test(String(item.name || filePath)))
    })
    let inputs = candidates.map((item) => String(item.path || item.filePath || '')).filter(Boolean)
    const images = attachments.filter((item) => item?.kind === 'image' && item?.data).map((item) => ({ name: item.name, mimeType: item.mimeType, data: item.data }))
    if (!inputs.length) {
      const match = String(task.content || '').match(/(?:[A-Za-z]:\\|\\\\)[^\r\n"]+/)
      if (match?.[0]) inputs = [match[0].trim()]
    }
    if (!inputs.length && !images.length) throw new Error('请上传视频、图片、音频或指定本地素材目录')
    const pendingSessionKey = state.sessionPath || '__pending__'
    let sessionPath = pendingSessionKey
    let stopProgress = null
    beginMediaActivity(pendingSessionKey, task.id, 'auto-edit')
    state.skillBusy = 'auto-edit'; state.mediaBusyCount = Number(state.mediaBusyCount || 0) + 1; state.sessionLoadingPath = state.sessionPath || null; state.error = ''
    setSessionSkill(pendingSessionKey, 'auto-edit')
    const userMessage = { id: task.id, role: 'user', content: task.content, attachments: task.attachments, createdAt: Number(task.createdAt || Date.now()) }
    const resultMessage = { id: `${task.id}:result`, role: 'assistant', content: '正在盘点全部素材、抽取关键帧并识别原声…', createdAt: Number(task.createdAt || Date.now()) + 0.5, autoEdit: true, autoEditPending: true }
    insertTimelineMessage(userMessage); insertTimelineMessage(resultMessage); renderApp(); updateLiveUi(true)
    try {
      const oldSessionKey = sessionPath
      await ensureMediaSession()
      sessionPath = state.sessionPath
      setSessionSkill(sessionPath, 'auto-edit')
      state.sessionLoadingPath = sessionPath
      if (oldSessionKey !== sessionPath) {
        moveMediaActivity(oldSessionKey, sessionPath, task.id)
        const pendingMessages = state.mediaMessages[oldSessionKey] || []
        state.mediaMessages[sessionPath] = [...(state.mediaMessages[sessionPath] || []), ...pendingMessages].slice(-100)
        delete state.mediaMessages[oldSessionKey]
      }
      if (!containsTimelineMessage(state.messages, userMessage)) insertTimelineMessage(userMessage)
      upsertMediaTimelineMessage(sessionPath, userMessage)
      upsertMediaTimelineMessage(sessionPath, resultMessage)
      await persistMediaTimeline(sessionPath)
      stopProgress = window.anyu.onAutoEditProgress?.((progress) => {
        if (progress?.taskId !== task.id || !progress.message) return
        resultMessage.content = String(progress.message)
        upsertTimelineMessage(resultMessage); upsertMediaTimelineMessage(sessionPath, resultMessage)
        if (state.sessionPath === sessionPath) { renderApp(); updateLiveUi(true) }
      })
      const analyzed = await window.anyu.autoEditAnalyze({ taskId: task.id, inputs, images, outputRoot: effectiveWorkspace() || undefined, prompt: autoEditPrompt(task.content) })
      resultMessage.autoEditPending = false
      resultMessage.autoEditAwaitingConfirmation = true
      resultMessage.autoEditPlan = analyzed.plan
      resultMessage.autoEditAnalysis = analyzed.analysis
      resultMessage.autoEditInputs = inputs
      resultMessage.autoEditResult = { analysis: analyzed.analysis, plan: analyzed.planPath, outputDir: analyzed.outputDir }
      resultMessage.content = `剪辑设计方案已完成，请确认后开始渲染。\n主题：${analyzed.plan?.creativeBrief?.theme || ''}\n受众：${analyzed.plan?.creativeBrief?.audience || ''}\n开场钩子：${analyzed.plan?.creativeBrief?.hook || ''}\n视觉风格：${analyzed.plan?.creativeBrief?.visualStyle || ''}\n节奏：${analyzed.plan?.creativeBrief?.pacing || ''}\n脚本：${(analyzed.plan?.script || []).map((item) => item?.copy || item?.visualIntent).filter(Boolean).join('；')}`
      upsertTimelineMessage(resultMessage); upsertMediaTimelineMessage(sessionPath, resultMessage)
      await persistMediaTimeline(sessionPath)
      return
    } catch (error) {
      resultMessage.autoEditPending = false; resultMessage.isError = true; resultMessage.content = errorText(error) || '自动剪辑失败'
    } finally {
      stopProgress?.()
      if (state.sessionPath === sessionPath) upsertTimelineMessage(resultMessage)
      upsertMediaTimelineMessage(sessionPath, resultMessage)
      await persistMediaTimeline(sessionPath)
      if (state.sessionPath === sessionPath) { renderApp(); updateLiveUi(true) }
      endMediaActivity(sessionPath, task.id)
      state.mediaBusyCount = Math.max(0, Number(state.mediaBusyCount || 1) - 1)
      if (!state.mediaBusyCount && state.sessionLoadingPath === sessionPath) state.sessionLoadingPath = null
      releaseSessionSkill(pendingSessionKey, sessionPath)
      scheduleSessionListRender(); scheduleQueueDrain()
    }
  }
  async function confirmAutoEdit(message) {
    if (!message?.autoEditAwaitingConfirmation || !message.autoEditResult?.plan || state.loading || state.skillBusy) return
    const sessionPath = Object.entries(state.mediaMessages).find(([, items]) => items.some((item) => item.id === message.id))?.[0] || state.sessionPath
    message.autoEditAwaitingConfirmation = false
    message.autoEditPending = true
    message.isError = false
    message.content = '已确认剪辑方案，正在渲染成片…'
    beginMediaActivity(sessionPath, message.id, 'auto-edit')
    setSessionSkill(sessionPath, 'auto-edit')
    upsertMediaTimelineMessage(sessionPath, message)
    await persistMediaTimeline(sessionPath)
    renderApp()
    try {
      const result = await window.anyu.autoEdit({ taskId: message.id, outputDir: message.autoEditResult.outputDir, outputRoot: effectiveWorkspace() || undefined, planPath: message.autoEditResult.plan })
      message.autoEditPending = false
      message.autoEditResult = { ...message.autoEditResult, ...result }
      message.content = `自动剪辑完成：${result.output || '已生成成片'}\n音轨响度：${result.audioMeanVolumeDb ?? '已校验'} dB`
      message.media = result.output ? { kind: 'video', name: 'auto-edited.mp4', path: result.output, mimeType: 'video/mp4' } : null
      message.artifacts = [result.output, message.autoEditAnalysis, message.autoEditResult.plan, result.subtitles, result.subtitleStyle].filter(Boolean).map((file) => ({ name: String(file).split(/[\\/]/).pop(), path: file, previewable: /\.(json|srt|ass)$/i.test(file) }))
    } catch (error) {
      message.autoEditPending = false; message.isError = true; message.content = errorText(error) || '自动剪辑失败'
    } finally {
      endMediaActivity(sessionPath, message.id); setSessionSkill(sessionPath, null); await persistMediaTimeline(sessionPath); renderApp(); scheduleSessionListRender(); scheduleQueueDrain()
    }
  }
  async function persistImageAttachments(payload, messageText) {
    const images = (payload?.attachments || []).filter((attachment) => attachment.kind === 'image' && attachment.data)
    if (!images.length || !window.anyu.piSaveAttachments) return
    try { await window.anyu.piSaveAttachments({ sessionPath: state.sessionPath, messageText, attachments: images, createdAt: Date.now() }) } catch {}
  }
  function queueAttachmentSummary(task) {
    const attachments = Array.isArray(task?.attachments) ? task.attachments : []
    if (!attachments.length) return ''
    return `<span class="queue-attachments">▧ ${attachments.length} 个附件</span>`
  }
  function queuedTasksMarkup() {
    if (!state.queuedTasks.length) return ''
    return `<section class="queued-tasks" aria-label="排队任务"><div class="queued-tasks-head"><span><span class="queue-head-icon">☷</span>排队任务 <strong class="queue-count">${state.queuedTasks.length}</strong></span><button class="queue-clear" data-queue-clear title="清空排队">清空</button></div><div class="queued-task-list">${state.queuedTasks.map((task, index) => {
      const menuOpen = state.queueMenuId === task.id
      const actionLabel = state.loading ? '调整方向' : '发送'
      return `<div class="queued-task ${menuOpen ? 'menu-open' : ''}" data-queue-id="${esc(task.id)}"><span class="queue-grip" aria-hidden="true">☷</span><div class="queued-task-main"><div class="queued-task-text" title="${esc(task.content)}">${esc(task.content || '附件任务')}</div><div class="queued-task-meta"><span>第 ${index + 1} 项</span>${queueAttachmentSummary(task)}</div></div><div class="queued-task-actions"><button class="queue-action" data-queue-steer="${esc(task.id)}" title="${actionLabel}" aria-label="${actionLabel}">↳<span>${actionLabel}</span></button><button class="queue-icon" data-queue-remove="${esc(task.id)}" title="删除任务" aria-label="删除任务">⌫</button><button class="queue-icon" data-queue-menu="${esc(task.id)}" title="更多操作" aria-label="更多操作">⋯</button></div>${menuOpen ? `<div class="queue-menu"><button data-queue-edit="${esc(task.id)}"><span>⌕</span>编辑消息</button><button data-queue-open="${esc(task.id)}"><span>⊕</span>在侧边聊天中打开</button><button data-queue-close="${esc(task.id)}"><span>☷</span>关闭排队</button></div>` : ''}</div>`
    }).join('')}</div></section>`
  }
  function hasRenderableMessageContent(message) {
    if (!message) return false
    if (message.role === 'tool' || message.role === 'user') return true
    const text = String(message.content || '').trim()
    const errorTextValue = String(message.errorMessage || message.error || '').trim()
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0
    const hasMedia = Boolean(message.media && (message.media.kind || message.media.url || message.media.data || message.media.path))
    return Boolean(text || errorTextValue || hasAttachments || hasMedia || (message.role === 'assistant' && message.isStreaming))
  }
  function visibleTimelineMessages() {
    return state.messages.filter(hasRenderableMessageContent)
  }
  function stableMessageIdentity(message, index = 0) {
    const id = String(message?.id || message?.messageId || message?.toolCallId || '').trim()
    if (id) return id
    return `${message?.role || 'message'}:${timestampValue(message?.createdAt || message?.timestamp) || 0}:${index}`
  }
  function conversationTimeline(messages = state.messages) {
    const ordered = orderTimeline(Array.isArray(messages) ? messages : [])
    const entries = []
    let activeTurn = null
    let userIndex = 0
    ordered.forEach((message, index) => {
      if (!hasRenderableMessageContent(message)) return
      if (message.role === 'user') {
        const identity = stableMessageIdentity(message, userIndex++)
        entries.push({ kind: 'user', key: `message:${identity}`, message, sourceIndex: state.messages.indexOf(message) })
        activeTurn = { kind: 'turn', key: `turn:${identity}`, user: message, messages: [], sourceIndex: index }
        entries.push(activeTurn)
        return
      }
      if (!activeTurn) {
        const identity = stableMessageIdentity(message, index)
        activeTurn = { kind: 'turn', key: `turn:orphan:${identity}`, user: null, messages: [], sourceIndex: index }
        entries.push(activeTurn)
      }
      activeTurn.messages.push(message)
    })
    const turns = entries.filter((entry) => entry.kind === 'turn')
    const lastTurn = turns.at(-1)
    if (state.loading && !lastTurn) {
      entries.push({ kind: 'turn', key: 'turn:active', user: null, messages: [], sourceIndex: ordered.length, isActive: true })
    } else if (state.loading && lastTurn) lastTurn.isActive = true
    return entries.filter((entry) => entry.kind !== 'turn' || entry.messages.length || entry.isActive)
  }
  function assistantMessagesForTurn(turn) { return (turn?.messages || []).filter((message) => message.role === 'assistant') }
  function toolMessagesForTurn(turn) { return (turn?.messages || []).filter((message) => message.role === 'tool') }
  function turnContent(turn) {
    const assistants = assistantMessagesForTurn(turn)
    // Codex 式回复：工具间隙的独白与参数复述属于过程内容，收进“思考过程”折叠卡；
    // 正文只保留时间线上最后的文本轮（最终答复）。
    const successful = assistants.filter((message) => !message.isError && String(message.content || '').trim())
    if (!successful.length) {
      const failures = assistants.filter((message) => message.isError)
      return failures.length ? String(failures.at(-1).content || '').trim() : ''
    }
    const final = successful.at(-1)
    const trailing = (turn?.messages || []).filter(hasRenderableMessageContent).at(-1)
    // 时间线末端还不是这条文本轮（后面还有工具轮在跑）→ 仍是中间轮，正文先藏起来。
    // 工具正在执行时仍展示当前流式文本；只隐藏已经完成的中间轮，
    // 避免工具卡出现后用户看不到 Agent 已经吐出的阶段性判断。
    if (trailing && trailing !== final && !(turnIsRunning(turn) && final?.isStreaming)) return ''
    return String(final.content || '').trim()
  }
  function turnThinking(turn) {
    const chunks = []
    for (const message of assistantMessagesForTurn(turn).filter((message) => !message.isError)) {
      const text = String(message.thinking || '').trim()
      if (text && !chunks.includes(text)) chunks.push(text)
    }
    return chunks.join('\n\n')
  }
  // 折叠卡内容：思考全文 + 被藏起来的中间轮独白/参数复述，展开才可见。
  function turnProcessText(turn) {
    const final = turnContent(turn)
    const chunks = []
    for (const message of assistantMessagesForTurn(turn).filter((message) => !message.isError)) {
      const text = String(message.content || '').trim()
      if (text && text !== final && !chunks.includes(text)) chunks.push(text)
    }
    return [turnThinking(turn), ...chunks].filter(Boolean).join('\n\n')
  }
  function turnArtifacts(turn) {
    const unique = new Map()
    for (const message of turn?.messages || []) {
      for (const artifact of [...(message.artifacts || []), ...(message.discoveredArtifacts || [])]) {
        const artifactPath = String(artifact?.path || artifact?.name || '').trim()
        if (!artifactPath) continue
        const key = artifactPath.replace(/\\/g, '/').toLowerCase()
        unique.set(key, { ...unique.get(key), ...artifact, path: artifactPath, name: artifact?.name || artifactPath.split(/[\\/]/).at(-1) })
      }
    }
    return [...unique.values()]
  }
  function turnIsRunning(turn) {
    return Boolean(turn?.isActive || (turn?.messages || []).some((message) => message.isStreaming || message.mediaPending || message.businessPending))
  }
  function turnStartedAt(turn) {
    const times = [turn?.user, ...(turn?.messages || [])].map((message) => timestampValue(message?.startedAt || message?.createdAt || message?.timestamp)).filter(Boolean)
    return times.length ? Math.min(...times) : state.runStartedAt || Date.now()
  }
  function turnFinishedAt(turn) {
    const explicit = (turn?.messages || []).map((message) => timestampValue(message?.finishedAt)).filter(Boolean)
    return explicit.length ? Math.max(...explicit) : 0
  }
  function toolStructureSignature(tool) {
    return JSON.stringify({
      running: Boolean(tool?.isStreaming),
      error: Boolean(tool?.isError),
      output: Boolean(tool?.content),
      args: tool?.args && Object.keys(tool.args).length ? tool.args : null
    })
  }
  function turnStructureSignature(turn) {
    return JSON.stringify({
      running: turnIsRunning(turn),
      content: Boolean(turnContent(turn)),
      thinking: Boolean(turnProcessText(turn)),
      artifacts: turnArtifacts(turn).map((artifact) => [artifact.path, artifact.size, artifact.previewable]),
      assistants: assistantMessagesForTurn(turn).map((message) => [stableMessageIdentity(message), businessRenderSignature(message), message.mediaPhase || '', Boolean(message.media), (message.attachments || []).map((item) => [item?.id, item?.mimeType, item?.dataUrl, String(item?.data || '').length])]),
      failures: assistantMessagesForTurn(turn).filter((message) => message.isError).map((message) => [stableMessageIdentity(message), message.content])
    })
  }
  function conversationEntryHtml(entry) {
    return entry.kind === 'user' ? messageHtml(entry.message, { key: entry.key }) : turnHtml(entry)
  }
  const messageKeys = new WeakMap()
  let nextMessageKey = 0
  function messageKey(message) {
    if (!messageKeys.has(message)) messageKeys.set(message, String(++nextMessageKey))
    return messageKeys.get(message)
  }
  // 业务卡片只在结构性状态变化时重建，普通进度文字由增量更新处理。
  function businessRenderSignature(message) {
    if (!message?.businessSkill) return ''
    const result = message.businessResult || {}
    const assets = Array.isArray(message.businessAssets) ? message.businessAssets : []
    const artifacts = Array.isArray(message.artifacts) ? message.artifacts : []
    return JSON.stringify({
      skill: message.businessSkill,
      pending: Boolean(message.businessPending),
      retry: Boolean(message.feedbackRetry || message.shopAnalysisRetry),
      error: Boolean(message.isError),
      phase: String(message.businessPhase || ''),
      status: String(message.businessStatus || ''),
      result: {
        reviewCount: result.reviewCount,
        questionCount: result.questionCount,
        coverage: result.coverage,
        count: result.count,
        text: result.text,
        referenceCount: result.referenceCount,
        generatedCount: result.generatedCount,
        totalCount: result.totalCount,
        continuedBy: result.continuedBy,
        pages: (result.pages || []).map((page) => [page.index, page.status, page.imageTaskId, page.error])
      },
      assets: assets.map((item) => [item?.id, String(item?.thumbnailDataUrl || item?.dataUrl || item?.url || '').slice(0, 80), String(item?.thumbnailDataUrl || item?.dataUrl || '').length]),
      attachments: (message.attachments || []).map((item) => [item?.id, item?.downloadTaskId, String(item?.dataUrl || '').length]),
      artifacts: artifacts.map((item) => String(item?.path || item?.name || ''))
    })
  }
  function runElapsedMarkup() {
    return state.runStartedAt ? `<span class="activity-elapsed">${esc(formatDuration(Date.now() - state.runStartedAt))}</span>` : ''
  }
  function activityMarkup() {
    return turnHtml({ kind: 'turn', key: 'turn:active', user: null, messages: [], isActive: true })
  }
  function messagesMarkup() {
    const messages = conversationTimeline().map(conversationEntryHtml).join('')
    const empty = !messages
      ? state.sessionSwitching
        // 切换到还没缓存的会话时，给一个明确的加载态，避免误以为卡死。
        ? `<div class="empty"><div><strong>正在打开会话…</strong><span>首次打开会拉起该会话的运行进程，稍等片刻。</span></div></div>`
        : `<div class="empty"><div><strong>让我们一起工作吧</strong></div></div>`
      : ''
    return `${messages}${empty}`
  }

  // 业务技能（评价分析的报告阶段能跑十分钟）会把 spinner 画在对话流里的业务卡片上，
  // 而卡片位于这一轮的顶部：正文一长，用户滚到底部后卡片早就出了视口，界面看上去
  // 就是"完全静止、没有任何加载动作"。这里额外在输入区上方提供一条常驻进度条，
  // 不管滚到哪里都能看到任务还在跑。
  const MEDIA_PHASE_LABELS = { planning: '分析需求', 'planning-complete': '规划完成', generating: '生成中', completed: '已完成', failed: '未完成' }
  function liveTaskState() {
    let business = null
    let media = null
    for (const message of Array.isArray(state.messages) ? state.messages : []) {
      if (!message || message.role === 'user' || message.role === 'tool') continue
      if (message.businessPending && message.businessSkill) {
        business = {
          key: String(message.id || ''),
          title: message.businessSkill === 'feedback' ? '评价分析' : message.businessSkill === 'shop-monitor' ? '店铺分析' : message.businessSkill === 'detail-reference' ? '一键详情页' : 'AI 测图',
          phase: String(message.businessPhase || '处理中'),
          progress: String(message.businessProgress || '正在处理…'),
          startedAt: timestampValue(message.startedAt || message.createdAt) || Date.now()
        }
      } else if (message.mediaPending && !media) {
        // 进度条显示气泡最后一行：生图规划阶段的“吐字”在这里也能看到推进。
        const lastLine = String(message.content || '').split('\n').map((item) => item.trim()).filter(Boolean).at(-1) || ''
        media = {
          key: String(message.id || ''),
          title: '媒体生成',
          phase: MEDIA_PHASE_LABELS[String(message.mediaPhase || '')] || '生成中',
          progress: lastLine || String(message.mediaPlanSummary || '正在生成媒体内容…'),
          startedAt: timestampValue(message.startedAt || message.createdAt) || Date.now()
        }
      }
    }
    return business || media
  }
  function liveTaskBarMarkup(task) {
    if (!task) return ''
    return `<div class="live-task-bar" role="status" aria-live="polite"><span class="spinner"></span><strong>${esc(task.title)}</strong><span class="live-task-phase">${esc(task.phase)}</span><span class="live-task-progress">${esc(task.progress)}</span><span class="live-task-elapsed">${esc(formatElapsed(Math.max(0, Date.now() - task.startedAt)))}</span></div>`
  }
  let liveTaskTicker = null
  function updateLiveTaskBar() {
    const slot = document.querySelector('#live-task-slot')
    if (!slot) return
    const task = liveTaskState()
    // 只在标题/阶段/进度文案变化时重建节点，计秒单独更新，避免每秒重建打断 spinner 动画。
    const signature = task ? `${task.key}|${task.title}|${task.phase}|${task.progress}` : ''
    if (slot.dataset.taskSignature !== signature) {
      slot.dataset.taskSignature = signature
      slot.innerHTML = liveTaskBarMarkup(task)
    }
    const elapsed = slot.querySelector('.live-task-elapsed')
    if (elapsed && task) elapsed.textContent = formatElapsed(Math.max(0, Date.now() - task.startedAt))
    if (task && liveTaskTicker === null) liveTaskTicker = window.setInterval(() => updateLiveTaskBar(), 1000)
    else if (!task && liveTaskTicker !== null) { window.clearInterval(liveTaskTicker); liveTaskTicker = null }
  }

  // 只替换结构变化的消息，并沿用用户已展开的过程详情。
  function replaceMessageNode(box, node, entry, before = null) {
    const holder = document.createElement('div')
    holder.innerHTML = conversationEntryHtml(entry)
    const next = holder.firstElementChild
    if (!next) return
    if (node) {
      const previousDetails = [...node.querySelectorAll('details')]
      const nextDetails = [...next.querySelectorAll('details')]
      nextDetails.forEach((detail) => {
        const detailKey = detail.dataset.detailKey
        const kind = ['turn-activity', 'tool-card', 'thinking-card', 'tool-args', 'tool-output', 'code-result'].find((name) => detail.classList.contains(name))
        const previous = detailKey ? previousDetails.find((item) => item.dataset.detailKey === detailKey) : kind ? previousDetails.find((item) => item.classList.contains(kind)) : null
        if (previous) detail.open = previous.open
      })
      node.replaceWith(next)
    } else box.insertBefore(next, before || null)
    bindMessageEvents(next)
    return next
  }

  function pinMessagesToBottom(box = document.querySelector('#messages')) {
    if (!box) return
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight)
  }

  function settleMessagesAtBottom(box = document.querySelector('#messages')) {
    if (!box) return
    // 流式输出每个增量都会调用这里，只做一次同步定位，避免为每个 token
    // 排队动画帧和延迟定时器，减少布局计算并保持 Pi 原生输出节奏。
    pinMessagesToBottom(box)
  }

  function updateLiveUi(forceScroll = false) {
    const box = document.querySelector('#messages')
    const wasAtBottom = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 72 : true
    if (box) {
      const nodes = [...box.querySelectorAll('.message')]
      const existing = new Map(nodes.map((node) => [node.dataset.messageKey, node]))
      const currentNodes = nodes.slice()
      const visibleEntries = conversationTimeline()
      visibleEntries.forEach((entry, index) => {
        const node = existing.get(entry.key)
        const atIndex = currentNodes[index]
        if (!node) {
          currentNodes.splice(index, 0, replaceMessageNode(box, null, entry, atIndex))
          return
        }
        if (node !== atIndex) {
          box.insertBefore(node, atIndex || null)
          const oldIndex = currentNodes.indexOf(node)
          if (oldIndex >= 0) currentNodes.splice(oldIndex, 1)
          currentNodes.splice(index, 0, node)
        }
        const roleMismatch = (entry.kind === 'user') !== node.classList.contains('user') || (entry.kind === 'turn') !== node.classList.contains('assistant-turn')
        const structureMismatch = entry.kind === 'turn' && node.dataset.turnSignature !== turnStructureSignature(entry)
        if (roleMismatch || structureMismatch) {
          currentNodes[index] = replaceMessageNode(box, node, entry)
          return
        }
        if (entry.kind === 'user') {
          node.dataset.messageIndex = String(entry.sourceIndex)
        } else {
          const rawContent = turnContent(entry)
          const bubble = node.querySelector('.message-bubble')
          if (bubble) {
            if (bubble.dataset.raw !== rawContent) {
              if (turnIsRunning(entry) && rawContent.startsWith(bubble.dataset.raw || '')) {
                bubble.append(document.createTextNode(rawContent.slice((bubble.dataset.raw || '').length)))
              } else bubble.innerHTML = rawContent ? renderMessageContent(rawContent) : ''
              bubble.dataset.raw = rawContent
            }
          }
          const processText = turnProcessText(entry)
          const thinking = node.querySelector('.thinking-card div')
          if (thinking && thinking.textContent !== processText) thinking.textContent = processText
          const thinkingCard = node.querySelector('.thinking-card')
          if (thinkingCard) thinkingCard.classList.toggle('is-live', turnIsRunning(entry))
          const businessEntry = assistantMessagesForTurn(entry).find((message) => message?.businessSkill)
          const businessCard = node.querySelector('.business-skill-card')
          if (businessEntry && businessCard) {
            const phase = businessCard.querySelector('.business-skill-phase')
            if (phase) phase.textContent = String(businessEntry.businessPhase || '处理中')
            const progressText = String(businessEntry.businessProgress || '')
            let progress = businessCard.querySelector('.business-progress')
            if (progressText && !progress) {
              progress = document.createElement('div'); progress.className = 'business-progress'
              businessCard.insertBefore(progress, businessCard.querySelector('.business-summary') || null)
            }
            if (progress) {
              progress.classList.toggle('is-done', !businessEntry.businessPending)
              progress.innerHTML = `${businessEntry.businessPending ? '<span class="spinner"></span>' : '<span class="session-status-dot"></span>'}<span></span>`
              progress.lastElementChild.textContent = progressText
            }
          }
          const expectedTools = toolMessagesForTurn(entry)
          const turnContentNode = node.querySelector('.turn-content')
          let activities = node.querySelector('.turn-activities')
          if (expectedTools.length && !activities && turnContentNode) {
            activities = document.createElement('div')
            activities.className = 'turn-activities'
            const anchor = [...turnContentNode.children].find((child) => !child.classList.contains('thinking-card'))
            turnContentNode.insertBefore(activities, anchor || null)
          }
          const activityNodes = activities ? [...activities.querySelectorAll(':scope > .turn-activity')] : []
          const activityByKey = new Map(activityNodes.map((item) => [item.dataset.toolKey, item]))
          expectedTools.forEach((tool, toolIndex) => {
            const toolKey = stableMessageIdentity(tool, toolIndex)
            let activity = activityByKey.get(toolKey)
            const expectedSignature = toolStructureSignature(tool)
            if (!activity || activity.dataset.toolSignature !== expectedSignature) {
              const holder = document.createElement('div')
              holder.innerHTML = turnToolMarkup(tool, toolIndex)
              const replacement = holder.firstElementChild
              if (activity) {
                const openKeys = new Set([...activity.querySelectorAll('details')].filter((detail) => detail.open).map((detail) => detail.dataset.detailKey))
                if (activity.open) openKeys.add(activity.dataset.detailKey)
                if (openKeys.has(replacement.dataset.detailKey)) replacement.open = true
                replacement.querySelectorAll('details').forEach((detail) => { if (openKeys.has(detail.dataset.detailKey)) detail.open = true })
                activity.replaceWith(replacement)
              } else activities?.appendChild(replacement)
              activity = replacement
            }
            const currentAtIndex = activities?.children[toolIndex]
            if (activity && currentAtIndex !== activity) activities.insertBefore(activity, currentAtIndex || null)
          })
          activityNodes.filter((activity) => !expectedTools.some((tool, toolIndex) => stableMessageIdentity(tool, toolIndex) === activity.dataset.toolKey)).forEach((activity) => activity.remove())
          if (!expectedTools.length) activities?.remove()
          toolMessagesForTurn(entry).forEach((tool, toolIndex) => {
            const toolKey = stableMessageIdentity(tool, toolIndex)
            const activity = [...node.querySelectorAll('[data-tool-key]')].find((item) => item.dataset.toolKey === toolKey)
            const pre = activity?.querySelector('.tool-output pre')
            if (pre && pre.textContent !== String(tool.content || '')) pre.textContent = String(tool.content || '')
            const duration = activity?.querySelector('.tool-duration')
            if (duration && tool.startedAt) duration.textContent = formatDuration((tool.finishedAt || Date.now()) - tool.startedAt)
          })
        }
      })
      nodes.filter((node) => !visibleEntries.some((entry) => entry.key === node.dataset.messageKey)).forEach((node) => node.remove())
      box.querySelectorAll('.assistant-turn.is-running .activity-elapsed').forEach((elapsed) => { elapsed.textContent = formatDuration(Date.now() - turnStartedAt(visibleEntries.filter((entry) => entry.kind === 'turn').at(-1))) })
      if (visibleEntries.length) box.querySelector('.empty')?.remove()
      else if (!box.querySelector('.empty')) box.innerHTML = messagesMarkup()
    }
    updateLiveTaskBar()
    const busy = document.querySelector('#busy')
    const currentMediaActivity = mediaActivityForSession()
    const liveTask = liveTaskState()
    // 其他会话里还在跑的技能任务：当前会话没任务时也提醒一句，别让后台任务“消失”。
    const backgroundActivity = Object.entries(state.mediaActivity).reduce((sum, [key, list]) => key === mediaActivityKey(state.sessionPath) || !Array.isArray(list) ? sum : sum + list.length, 0)
    if (busy) busy.textContent = state.loading ? 'Agent 正在工作…' : liveTask ? `${liveTask.title} · ${liveTask.phase}` : currentMediaActivity.length > 0 ? `${currentMediaActivity.length} 个媒体任务生成中` : backgroundActivity > 0 ? `其他会话 ${backgroundActivity} 个任务生成中` : state.queuedTasks.length ? `${state.queuedTasks.length} 项排队中` : ''
    const send = document.querySelector('#send')
    if (send) {
      send.disabled = state.sessionSwitching
      send.classList.toggle('stop', state.loading)
      send.textContent = state.loading ? '■' : '↑'
      send.title = state.loading ? '停止当前任务' : '发送'
      send.setAttribute('aria-label', send.title)
    }
    // 当前回合运行时仍允许配置下一条消息；这些选择只写入本地状态，
    // 不会修改已经发出的请求。
    for (const selector of ['#permission-picker', '#thinking-picker', '#attach-trigger', '#choose-cwd']) {
      const control = document.querySelector(selector)
      if (control) control.disabled = state.sessionSwitching
    }
    for (const selector of ['#model-picker', '#group-picker']) {
      const control = document.querySelector(selector)
      if (control) control.disabled = state.sessionSwitching || state.switching
    }
    const prompt = document.querySelector('#prompt')
    // 历史已经秒开出来时允许先打字，只是还不能发送（要等目标会话的进程就绪）。
    if (prompt) prompt.disabled = state.sessionSwitching && !state.messages.length
    if (!state.attachments.length) document.querySelector('.attachments-strip')?.remove()
    // 会话切换期间禁止任何强制滚动，等待目标会话加载完成后统一恢复位置。
    if (box && !state.sessionSwitching && (forceScroll || wasAtBottom)) {
      settleMessagesAtBottom(box)
    }
  }

  function scheduleLiveUi(forceScroll = false) {
    if (forceScroll && !state.sessionSwitching) state.forceScroll = true
    if (state.renderQueued) return
    state.renderQueued = true
    requestAnimationFrame(() => {
      state.renderQueued = false
      const shouldScroll = Boolean(state.forceScroll)
      state.forceScroll = false
      updateLiveUi(shouldScroll)
    })
  }

  function finishStreamingMessage(message) {
    if (!message) return false
    message.isStreaming = false
    message.finishedAt = message.finishedAt || Date.now()
    if (state.streamingMessage === message) state.streamingMessage = null
    scheduleLiveUi(false)
    return true
  }

  function scheduleAppRender() {
    if (state.appRenderQueued) return
    state.appRenderQueued = true
    requestAnimationFrame(() => {
      state.appRenderQueued = false
      if (!state.user) return
      // 任务流、浏览器状态和余额刷新都可能触发整壳重绘。若用户正在
      // 输入，替换 root.innerHTML 会销毁 textarea，表现为偶发“点不进去”
      // 或刚输入就丢焦点。先让 live UI 局部更新，等用户停止输入再重绘。
      const prompt = document.querySelector('#prompt')
      const activePrompt = prompt && (document.activeElement === prompt || prompt.matches(':hover') || Date.now() - Number(state.promptInteractionAt || 0) < 650)
      if (activePrompt && !state.settingsOpen) {
        updateLiveUi(false)
        window.clearTimeout(state.deferredAppRenderTimer)
        state.deferredAppRenderTimer = window.setTimeout(() => {
          state.deferredAppRenderTimer = null
          if (!state.user || state.settingsOpen) return
          const current = document.querySelector('#prompt')
          if (current === document.activeElement || current?.matches(':hover') || Date.now() - Number(state.promptInteractionAt || 0) < 650) {
            scheduleAppRender()
            return
          }
          renderApp()
        }, 450)
        return
      }
      renderApp()
    })
  }

  function switchSession(path) {
    const target = String(path || '')
    if (!target) return
    // 切到具体会话就不再是"待启动的新会话"：后台那次懒启动的回写会被
    // shouldApply 挡住，不会污染这里的状态。
    state.pendingNewAgent = false
    const selectedSession = state.sessions.find((item) => item.path === target)
    state.sessionCwd = selectedSession?.cwd || null
    state.cwd = state.sessionCwd || localStorage.getItem('anyu.cwd') || ''
    const token = ++state.sessionSwitchToken
    const previousPath = state.sessionPath
    // 在修改 sessionPath 前保存旧会话的视口，切换回来时可精确恢复。
    saveSessionScroll(previousPath)
    // 多会话并行：切走时只是把当前会话的任务状态存档，绝不中止请求。
    // 旧会话的 Pi 进程继续跑，完成后在左侧列表标记为“已完成未读”。
    if (previousPath && previousPath !== target) {
      const stillRunning = Boolean(state.loading || state.runInProgress || state.activeRequest)
      markSessionRun(previousPath, { running: stillRunning, unread: false })
      const pending = state.messages.find((item) => item.role === 'user' && item.id === state.activeRequest?.taskId)
      if (pending && window.anyu.piSaveOptimisticMessage) {
        state.optimisticMessages[previousPath] = pending
        void window.anyu.piSaveOptimisticMessage({ sessionPath: previousPath, message: pending }).catch(() => {})
      }
    }
    // clearActiveRequest() 只清掉当前视图的请求句柄，不再向 Pi 发 abort，
    // 这就是“发送后立刻切换会话就报 Request aborted”的直接修复点。
    stopRunMonitor()
    state.activeRequest = null; state.retryNotice = ''; state.runInProgress = false
    state.loading = false
    state.streamingMessage = null
    state.sessionPath = target
    state.error = ''
    state.sessionSwitching = true
    state.sessionLoadingPath = target
    // 打开会话即视为已读，绿点立刻消失。
    markSessionRun(target, { unread: false })
    // 秒开：先在内存缓存里找这个会话的历史，找到就立刻画上去。
    // 之前切换慢的主因就在这一步——目标会话若没有存活进程，拉起 pi.exe
    // 往往要 1~3 秒，这段时间整屏都是空的。
    const painted = restoreSessionMessagesCache(target)
    if (!painted) {
      // 没有现成内容就先清掉上一个会话的对话，否则屏幕上一直挂着别人的
      // 历史，看起来就是“切了没反应，过一会才刷出来”。紧接着用直读补上。
      state.messages = []
      state.imageLibrary = []
    }
    renderApp()
    // 内存没命中就退一步：让主进程直读会话文件（毫秒级），同样不用等 Pi。
    if (!painted) {
      void paintSessionFromDisk(target, () => token === state.sessionSwitchToken && state.sessionPath === target)
        .then((done) => { if (done && token === state.sessionSwitchToken) renderApp() })
    }
    const loadSession = async () => {
      // 每个会话一个 Pi 进程：目标会话的进程还活着就直接复用（startAgent →
      // startPi 复用运行时），不再在旧进程里执行 switch_session，
      // 因为那会 teardown 正在生成的任务。
      await startAgent(target, () => token === state.sessionSwitchToken)
      markSessionRun(state.sessionPath || target, { unread: false })
      // 切回来时如果后台任务还在生成，恢复“运行中”界面并重启状态轮询，
      // 结束事件仍由该会话进程的 agent_settled 驱动。
      if (state.piState?.isStreaming === true || Boolean(state.sessionRuns[normalizeSessionKey(state.sessionPath || target)]?.running)) {
        state.loading = true; state.runInProgress = true; state.runStartedAt = state.runStartedAt || Date.now()
        if (!state.runPoll) startRunMonitor()
      }
    }
    void loadSession().catch((error) => {
      if (token === state.sessionSwitchToken) state.error = error.message || '打开会话失败'
    })
      .finally(() => {
        if (token !== state.sessionSwitchToken) return
        state.sessionSwitching = false
        state.sessionLoadingPath = null
        renderApp()
        // 该会话之前排队的任务，只有在回到这个会话时才开始消耗；
        // 其它会话的排队不受影响。
        scheduleQueueDrain()
      })
  }

  function keyHtml(key) {
    const selected = Number(key.id) === state.selectedKey
    const hint = key.provider || key.billing_mode || 'Anyu 路由密钥'
    return `<div class="key ${selected ? 'selected' : ''}" data-key="${esc(key.id)}"><div class="key-name"><span class="dot ${key.status && key.status !== 'active' ? 'off' : ''}"></span>${esc(keyDisplayName(key))}</div><div class="key-meta"><span>${esc(cleanDisplayText(hint) || 'Anyu 路由密钥')}</span><span>${key.status === 'active' || !key.status ? '可用' : esc(cleanDisplayText(key.status))}</span></div></div>`
  }
  // 必须返回成功与否：右键“复制会话链接”要靠它决定提示内容。
  async function copyText(value) {
    const text = String(value || '')
    try { await navigator.clipboard.writeText(text); return true } catch {}
    const input = document.createElement('textarea')
    input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select()
    try {
      return Boolean(document.execCommand('copy'))
    } catch { return false }
    finally { input.remove() }
  }
  function historyMessage(index) { return state.messages[Number(index)] }
  function editHistoryMessage(index) {
    const message = historyMessage(index)
    if (!message || message.role !== 'user') return
    state.composerText = message.content || ''; state.attachments = [...(message.attachments || [])]; state.composerCursor = state.composerText.length
    renderApp()
    requestAnimationFrame(() => { const prompt = document.querySelector('#prompt'); if (prompt) { prompt.focus(); prompt.selectionStart = prompt.selectionEnd = prompt.value.length } })
  }
  function resendHistoryMessage(index) {
    const message = historyMessage(index)
    if (!message || message.role !== 'user') return
    void runTask({ id: taskId(), content: message.content || '', attachments: [...(message.attachments || [])], createdAt: Date.now() })
  }
  function bindMessageEvents(container = document) {
    container.querySelectorAll('[data-shop-analysis-retry]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation()
      const message = state.messages.find((item) => item.id === node.dataset.shopAnalysisRetry)
      if (message) void retryShopAnalysis(message)
    }))
    container.querySelectorAll('[data-auto-edit-confirm]').forEach((node) => node.addEventListener('click', () => {
      const message = state.messages.find((item) => item.id === node.dataset.autoEditConfirm)
      if (message) void confirmAutoEdit(message)
    }))
    container.querySelectorAll('[data-feedback-retry]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation()
      const message = state.messages.find((item) => item.id === node.dataset.feedbackRetry)
      if (message) void retryFeedbackAnalysis(message)
    }))
    container.querySelectorAll('[data-message-copy]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); const message = historyMessage(node.closest('[data-message-index]')?.dataset.messageIndex); if (message) void copyText(message.content || '') }))
    container.querySelectorAll('[data-turn-copy]').forEach((node) => node.addEventListener('click', (event) => {
      event.stopPropagation()
      const key = node.closest('[data-message-key]')?.dataset.messageKey
      const turn = conversationTimeline().find((entry) => entry.kind === 'turn' && entry.key === key)
      if (turn) void copyText(turnContent(turn))
    }))
    container.querySelectorAll('[data-message-edit]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); editHistoryMessage(node.closest('[data-message-index]')?.dataset.messageIndex) }))
    container.querySelectorAll('[data-message-resend]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); resendHistoryMessage(node.closest('[data-message-index]')?.dataset.messageIndex) }))
    container.querySelectorAll('[data-external-url]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation()
      const url = String(node.dataset.externalUrl || '')
      if (event.ctrlKey || event.metaKey || event.shiftKey) void window.anyu.openExternal(url)
      else void window.anyu.browserOpenUrl(url).catch((error) => { state.error = errorText(error) || '浏览器打开失败'; scheduleAppRender() })
    }))
    container.querySelectorAll('[data-file-path]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation()
      const requested = String(node.dataset.filePath || '')
      void window.anyu.openPath({ path: requested, cwd: state.sessionCwd || state.cwd, mode: 'explorer' }).catch((error) => { state.error = errorText(error) || '路径打开失败'; scheduleAppRender() })
    }))
    container.querySelectorAll('[data-artifact-preview]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation()
      const requested = String(node.dataset.artifactPreview || '')
      void window.anyu.browserOpenArtifact({ path: requested, cwd: effectiveWorkspace() }).catch((error) => { state.error = errorText(error) || '结果预览失败'; scheduleAppRender() })
    }))
    container.querySelectorAll('[data-artifact-open]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation()
      const requested = String(node.dataset.artifactOpen || '')
      void window.anyu.openFile({ path: requested, cwd: effectiveWorkspace() }).catch((error) => { state.error = errorText(error) || '文件打开失败'; scheduleAppRender() })
    }))
    container.querySelectorAll('[data-path-explorer]').forEach((node) => node.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void window.anyu.openPath({ path: node.dataset.pathExplorer || '', cwd: effectiveWorkspace(), mode: 'explorer' }).catch((error) => { state.error = errorText(error); scheduleAppRender() }) }))
    container.querySelectorAll('[data-path-with]').forEach((node) => node.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void window.anyu.openPath({ path: node.dataset.pathWith || '', cwd: effectiveWorkspace(), mode: 'with' }).catch((error) => { state.error = errorText(error); scheduleAppRender() }) }))
    container.querySelectorAll('[data-path-copy]').forEach((node) => node.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void copyText(node.dataset.pathCopy || '') }))
    container.querySelectorAll('[data-artifact-path-menu]').forEach((node) => node.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); state.pathContextMenu = { path: node.dataset.artifactPathMenu || '', x: event.clientX, y: event.clientY }; renderApp() }))
    document.querySelectorAll('[data-path-context-action]').forEach((node) => node.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); const item = state.pathContextMenu; state.pathContextMenu = null; if (!item) return; if (node.dataset.pathContextAction === 'copy') void copyText(item.path); else void window.anyu.openPath({ path: item.path, cwd: effectiveWorkspace(), mode: node.dataset.pathContextAction === 'with' ? 'with' : 'explorer' }).catch(error => { state.error = errorText(error); scheduleAppRender() }) }))
    container.querySelectorAll('[data-artifact-copy]').forEach((node) => node.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void copyText(node.dataset.artifactCopy || '') }))
  }
  function artifactCardsMarkup(artifacts = []) {
    if (!artifacts.length) return ''
    const previewPattern = /\.(?:html?|json|csv|md|txt|png|jpe?g|webp|gif|svg|pdf)$/i
    return `<section class="turn-artifacts" aria-label="结果文件">${artifacts.map((artifact) => {
      const artifactPath = String(artifact.path || artifact.name || '')
      const name = String(artifact.name || artifactPath.split(/[\\/]/).at(-1) || '结果文件')
      const extension = String(artifact.extension || name.match(/\.[^.]+$/)?.[0] || '').replace(/^\./, '').toUpperCase() || '文件'
      const meta = [extension, artifact.lineCount ? `${artifact.lineCount} 行` : '', artifact.size ? formatBytes(artifact.size) : ''].filter(Boolean).join(' · ')
      const previewable = artifact.previewable !== false && previewPattern.test(artifactPath)
      return `<article class="artifact-card path-result-card" data-artifact-path-menu="${esc(artifactPath)}"><div class="artifact-card-icon">${artifact.directory ? '▱' : '◇'}</div><div class="artifact-card-copy"><strong title="${esc(artifactPath)}">${esc(name)}</strong><span>${esc(artifact.directory ? '目录' : meta)}</span><code class="artifact-path" title="${esc(artifactPath)}">${esc(artifactPath)}</code></div><div class="artifact-card-actions"><button type="button" data-path-explorer="${esc(artifactPath)}">资源管理器打开</button>${previewable ? `<button type="button" data-artifact-preview="${esc(artifactPath)}">预览</button>` : ''}<button type="button" data-path-with="${esc(artifactPath)}">打开方式</button><button type="button" data-path-copy="${esc(artifactPath)}">复制路径</button></div></article>`
    }).join('')}</section>`
  }
  function turnToolMarkup(tool, index) {
    const key = stableMessageIdentity(tool, index)
    const status = tool.isStreaming ? '运行中' : tool.isError ? '失败' : '已完成'
    const duration = tool.startedAt ? `<span class="tool-duration">${esc(formatDuration((tool.finishedAt || Date.now()) - tool.startedAt))}</span>` : ''
    const args = tool.args && Object.keys(tool.args).length ? `<details class="tool-section tool-args" data-detail-key="${esc(key)}:args"><summary>参数</summary><pre>${esc(JSON.stringify(tool.args, null, 2))}</pre></details>` : ''
    const output = tool.content ? `<details class="tool-section tool-output" data-detail-key="${esc(key)}:output"><summary>输出</summary><pre>${esc(tool.content)}</pre></details>` : ''
    return `<details class="turn-activity ${tool.isStreaming ? 'is-running' : ''} ${tool.isError ? 'is-error' : ''}" data-detail-key="tool:${esc(key)}" data-tool-key="${esc(key)}" data-tool-signature="${esc(toolStructureSignature(tool))}"><summary><span class="tool-chevron">›</span><span class="turn-activity-icon">⌘</span><strong>工具 · ${esc(tool.toolName || '执行')}</strong>${duration}<span class="tool-status ${tool.isError ? 'failed' : tool.isStreaming ? 'running' : ''}">${status}</span></summary><div class="turn-activity-body">${tool.isStreaming && !tool.content ? '<div class="tool-progress"><span></span>正在等待工具输出…</div>' : ''}${args}${output}</div></details>`
  }
  function turnPlanMarkup(message) {
    const steps = Array.isArray(message.mediaPlanSteps) ? message.mediaPlanSteps.filter(Boolean) : []
    if (!steps.length) return ''
    const completed = Math.max(0, Math.min(steps.length, Number(message.mediaPlanCompleted || 0)))
    const labels = { planning: '分析需求', 'planning-complete': '规划完成', generating: '生成中', completed: '已完成', failed: '未完成' }
    return `<section class="media-planning-card ${message.mediaPending ? 'is-live' : ''} ${message.mediaPhase === 'failed' ? 'is-error' : ''}" aria-label="图片生成规划"><div class="media-planning-head"><span class="media-planning-icon">✦</span><strong>${message.mediaPlanSource === 'local' ? '规则整理' : 'AI 规划'}</strong><span class="media-planning-phase">${esc(labels[message.mediaPhase] || '图片规划')}</span></div><div class="media-planning-steps">${steps.map((step, stepIndex) => `<div class="media-plan-step ${stepIndex < completed ? 'done' : stepIndex === completed && message.mediaPending ? 'active' : ''}"><span class="media-plan-dot">${stepIndex < completed ? '✓' : stepIndex === completed && message.mediaPending ? '•' : ''}</span><span>${esc(step)}</span></div>`).join('')}</div>${message.mediaPlanSummary ? `<div class="media-planning-summary">${esc(message.mediaPlanSummary)}</div>` : ''}</section>`
  }
  function turnBusinessMarkup(message) {
    if (!message.businessSkill) return ''
    const result = message.businessResult || {}
    const summary = message.businessSkill === 'feedback'
      ? `<div class="business-summary"><span>${esc(result.reviewCount == null ? '正在采集评价' : `评价 ${result.reviewCount} 条`)}</span><span>${esc(result.questionCount == null ? '问大家整理中' : `问大家 ${result.questionCount} 条`)}</span>${result.coverage ? `<span>覆盖率 ${esc(result.coverage)}</span>` : ''}</div>`
      : message.businessSkill === 'detail-reference' ? `<div class="business-summary"><span>参考图 ${esc(result.referenceCount || 0)} 张</span><span>生成 ${esc(result.generatedCount || 0)} 张</span></div>` : message.businessSkill === 'shop-monitor' ? `<div class="business-summary"><span>商品 ${esc(result.count || 0)} 个</span></div>` : `<div class="business-summary"><span>已分析 ${esc(result.count || 0)} 张图片</span></div>`
    const progress = message.businessProgress ? `<div class="business-progress ${message.businessPending ? '' : 'is-done'}">${message.businessPending ? '<span class="spinner"></span>' : '<span class="session-status-dot"></span>'}<span>${esc(message.businessProgress)}</span></div>` : ''
    const businessLabel = message.businessSkill === 'feedback' ? '评价分析' : message.businessSkill === 'detail-reference' ? '一键详情页' : message.businessSkill === 'shop-monitor' ? '店铺分析' : 'AI 测图'
    return `<section class="business-skill-card ${message.businessPending ? 'is-live' : ''} ${message.isError ? 'is-error' : ''}" aria-label="${businessLabel}"><div class="business-skill-head"><span class="business-skill-icon">${message.businessSkill === 'feedback' ? '▤' : '◉'}</span><strong>${businessLabel}</strong><span class="business-skill-phase">${esc(message.businessPhase || '处理中')}</span>${message.businessStatus ? `<span class="business-skill-status">${esc(message.businessStatus)}</span>` : ''}</div>${progress}${summary}${['image-analysis', 'detail-reference', 'shop-monitor'].includes(message.businessSkill) ? businessAssetMarkup(message.businessAssets) : ''}${message.shopAnalysisRetry ? `<button type="button" class="artifact-link" data-shop-analysis-retry="${esc(message.id)}">重试店铺分析</button>` : ''}${message.feedbackTaskId && (message.feedbackRetry || message.isError) ? `<button type="button" class="artifact-link" data-feedback-retry="${esc(message.id)}">继续分析</button>` : ''}</section>`
  }
  function turnHtml(turn) {
    const assistants = assistantMessagesForTurn(turn)
    const tools = toolMessagesForTurn(turn)
    const content = turnContent(turn)
    const thinking = turnProcessText(turn)
    const running = turnIsRunning(turn)
    const failures = assistants.filter((message) => message.isError)
    const hasError = failures.length > 0 && !assistants.some((message) => !message.isError && (message.isStreaming || String(message.content || '').trim()))
    const startedAt = turnStartedAt(turn)
    const finishedAt = turnFinishedAt(turn)
    const duration = Math.max(0, (running ? Date.now() : finishedAt) - startedAt)
    const completion = running ? `<span class="turn-completion is-running"><span class="activity-dot"></span>处理中 <span class="activity-elapsed">${esc(formatDuration(duration))}</span></span>` : finishedAt && startedAt && finishedAt >= startedAt ? `<span class="turn-completion">已处理 ${esc(formatDuration(duration))}</span>` : ''
    const thinkingMarkup = thinking ? `<details class="thinking-card ${running ? 'is-live' : ''}" data-detail-key="thinking"><summary><span class="tool-chevron">›</span><span class="thinking-label">思考过程</span><small>${running ? '进行中' : '已完成'}</small></summary><div>${esc(thinking)}</div></details>` : ''
    const failuresMarkup = failures.length && !hasError ? `<details class="turn-activity is-error" data-detail-key="attempts"><summary><span class="tool-chevron">›</span><strong>重试 · ${failures.length} 次失败尝试</strong></summary><div class="turn-activity-body"><pre>${esc(failures.map((message) => message.content || '模型请求失败').join('\n'))}</pre></div></details>` : ''
    const richMarkup = assistants.map((message) => `${turnPlanMarkup(message)}${turnBusinessMarkup(message)}`).join('')
    const bubble = content ? `<div class="message-bubble ${hasError ? 'tool-error' : ''} ${running ? 'streaming-bubble' : ''}" data-raw="${esc(content)}">${running ? esc(content) : renderMessageContent(content)}</div>` : running && !tools.length && !richMarkup ? '<div class="turn-status" role="status">正在理解需求…</div>' : ''
    const media = assistants.map((message) => message.media?.kind === 'video' ? `<div class="generated-video"><video src="${esc(mediaSourceUrl(message))}" controls playsinline preload="auto"></video><button type="button" class="media-download" data-download-video="${esc(message.id || '')}" title="下载视频">↓ 下载视频</button></div>` : '').join('')
    const attachments = assistants.flatMap((message) => message.attachments || [])
    const lastMessageTime = (turn.messages || []).map((message) => timestampValue(message.createdAt)).filter(Boolean).at(-1)
    const time = finishedAt || lastMessageTime ? `<time class="message-time">${esc(formatTimestamp(finishedAt || lastMessageTime))}</time>` : ''
    return `<article class="message assistant-turn ${running ? 'is-running' : ''}" data-message-key="${esc(turn.key)}" data-turn-signature="${esc(turnStructureSignature(turn))}"><div class="avatar">A</div><div class="message-body"><div class="turn-heading"><span class="message-role">AnyuAgent</span>${completion}</div><div class="turn-content">${thinkingMarkup}${failuresMarkup}${tools.length ? `<div class="turn-activities">${tools.map(turnToolMarkup).join('')}</div>` : ''}${richMarkup}${bubble}${artifactCardsMarkup(turnArtifacts(turn))}${media}${attachments.length ? `<div class="message-attachments">${attachments.map((attachment) => attachmentMarkup(attachment, false)).join('')}</div>` : ''}</div><div class="message-meta">${time}<span class="message-actions"><button type="button" data-turn-copy title="复制回复">复制</button></span></div></div></article>`
  }
  function messageHtml(message, options = {}) {
    const user = message.role === 'user'; const tool = message.role === 'tool'; const index = state.messages.indexOf(message)
    const renderKey = String(options.key || messageKey(message))
    if (!user && !tool && !hasRenderableMessageContent(message) && !message.isStreaming) return ''
    const time = message.createdAt ? `<time class="message-time">${esc(formatTimestamp(message.createdAt))}</time>` : ''
    if (tool) {
      const status = message.isStreaming ? '运行中' : message.isError ? '失败' : '已完成'
      const expanded = ''
      const duration = message.startedAt ? `<span class="tool-duration">${esc(formatDuration((message.finishedAt || Date.now()) - message.startedAt))}</span>` : ''
      const args = message.args && Object.keys(message.args).length ? `<details class="tool-section tool-args" ${expanded}><summary>参数</summary><pre>${esc(JSON.stringify(message.args, null, 2))}</pre></details>` : ''
      const output = message.content ? `<details class="tool-section tool-output" ${expanded}><summary>输出</summary><pre>${esc(message.content)}</pre></details>` : ''
      const progress = message.isStreaming && !message.content ? '<div class="tool-progress"><span></span>正在等待工具输出…</div>' : ''
      return `<article class="message tool-message" data-message-key="${esc(renderKey)}" data-message-index="${index}"><div class="avatar tool-avatar">⌘</div><details class="tool-card" ${expanded}><summary><span class="tool-chevron">›</span><span class="message-role">工具 · ${esc(message.toolName || '执行')}</span>${duration}<span class="tool-status ${message.isError ? 'failed' : message.isStreaming ? 'running' : ''}">${status}</span></summary><div class="tool-card-body">${progress}${args}${output}${message.isError ? '<span class="tool-error">执行失败</span>' : ''}</div></details><time class="message-time">${esc(formatTimestamp(message.createdAt))}</time></article>`
    }
    const shouldShowThinking = Boolean(String(message.thinking || '').trim())
    const thinking = shouldShowThinking ? `<details class="thinking-card ${message.isStreaming ? 'is-live' : ''}"><summary><span class="tool-chevron">›</span><span class="thinking-label">思考过程</span></summary><div>${esc(message.thinking || '')}</div></details>` : ''
    const planSteps = Array.isArray(message.mediaPlanSteps) ? message.mediaPlanSteps.filter(Boolean) : []
    const planCompleted = Math.max(0, Math.min(planSteps.length, Number(message.mediaPlanCompleted || 0)))
    const planPhaseLabels = { planning: '分析需求', 'planning-complete': '规划完成', generating: '生成中', completed: '已完成', failed: '未完成' }
    const planPhaseLabel = planPhaseLabels[message.mediaPhase] || '图片规划'
    const planSourceLabel = message.mediaPlanSource === 'local' ? '规则整理' : 'AI 规划'
    const planMarkup = planSteps.length ? `<section class="media-planning-card ${message.mediaPending ? 'is-live' : ''} ${message.mediaPhase === 'failed' ? 'is-error' : ''}" aria-label="图片生成规划"><div class="media-planning-head"><span class="media-planning-icon">✦</span><strong>${planSourceLabel}</strong><span class="media-planning-phase">${planPhaseLabel}</span></div><div class="media-planning-steps">${planSteps.map((step, stepIndex) => `<div class="media-plan-step ${stepIndex < planCompleted ? 'done' : stepIndex === planCompleted && message.mediaPending ? 'active' : ''}"><span class="media-plan-dot">${stepIndex < planCompleted ? '✓' : stepIndex === planCompleted && message.mediaPending ? '•' : ''}</span><span>${esc(step)}</span></div>`).join('')}</div>${message.mediaPlanSummary ? `<div class="media-planning-summary">${esc(message.mediaPlanSummary)}</div>` : ''}</section>` : ''
    const businessResult = message.businessResult || {}
    const businessPhase = String(message.businessPhase || '处理中')
    const businessStatus = String(message.businessStatus || '')
    const businessSummary = message.businessSkill === 'feedback'
      ? `<div class="business-summary"><span>${esc(businessResult.reviewCount == null ? '正在采集评价' : `评价 ${businessResult.reviewCount} 条`)}</span><span>${esc(businessResult.questionCount == null ? '问大家整理中' : `问大家 ${businessResult.questionCount} 条`)}</span>${businessResult.coverage ? `<span>覆盖率 ${esc(businessResult.coverage)}</span>` : ''}</div>`
      : message.businessSkill === 'image-analysis' ? `<div class="business-summary"><span>已分析 ${esc(businessResult.count || 0)} 张图片</span></div>` : message.businessSkill === 'detail-reference' ? `<div class="business-summary"><span>参考图 ${esc(businessResult.referenceCount || 0)} 张</span><span>生成 ${esc(businessResult.generatedCount || 0)} 张</span></div>` : message.businessSkill === 'shop-monitor' ? `<div class="business-summary"><span>商品 ${esc(businessResult.count || 0)} 个</span></div>` : ''
    const businessProgress = message.businessProgress ? `<div class="business-progress ${message.businessPending ? '' : 'is-done'}">${message.businessPending ? '<span class="spinner"></span>' : '<span class="session-status-dot"></span>'}<span>${esc(message.businessProgress)}</span></div>` : ''
    const businessLabel = message.businessSkill === 'feedback' ? '评价分析' : message.businessSkill === 'detail-reference' ? '一键详情页' : message.businessSkill === 'shop-monitor' ? '店铺分析' : 'AI 测图'
    const businessMarkup = message.businessSkill ? `<section class="business-skill-card ${message.businessPending ? 'is-live' : ''} ${message.isError ? 'is-error' : ''}" aria-label="${businessLabel}"><div class="business-skill-head"><span class="business-skill-icon">${message.businessSkill === 'feedback' ? '▤' : '◉'}</span><strong>${businessLabel}</strong><span class="business-skill-phase">${esc(businessPhase)}</span>${businessStatus ? `<span class="business-skill-status">${esc(businessStatus)}</span>` : ''}</div>${businessProgress}${businessSummary}${['image-analysis', 'detail-reference', 'shop-monitor'].includes(message.businessSkill) ? businessAssetMarkup(message.businessAssets) : ''}${businessArtifactsMarkup(message.artifacts)}${message.shopAnalysisRetry ? `<button type="button" class="artifact-link" data-shop-analysis-retry="${esc(message.id)}">重试店铺分析</button>` : ''}${message.feedbackTaskId && (message.feedbackRetry || message.isError) ? `<button type="button" class="artifact-link" data-feedback-retry="${esc(message.id)}">继续分析</button>` : ''}</section>` : ''
    const autoEditMarkup = message.autoEditAwaitingConfirmation ? `<section class="business-skill-card" aria-label="自动剪辑设计方案"><div class="business-skill-head"><strong>剪辑设计方案</strong><span class="business-skill-phase">等待确认</span></div><div class="business-progress is-done"><span>${esc(message.autoEditPlan?.creativeBrief?.theme || '已完成素材分析')}</span></div><button type="button" class="primary" data-auto-edit-confirm="${esc(message.id)}">确认方案并开始剪辑</button></section>` : ''
    const hasText = Boolean(String(message.content || '').trim())
    const bubble = hasText ? (message.isStreaming ? esc(message.content) : renderMessageContent(message.content)) : ''
    const bubbleMarkup = bubble ? `<div class="message-bubble ${message.isError ? 'tool-error' : ''} ${message.isStreaming ? 'streaming-bubble' : ''}" data-raw="${esc(message.content || '')}">${bubble}</div>` : message.isStreaming && !user ? `<div class="turn-status" role="status"><span class="activity-dot"></span>处理中${runElapsedMarkup()}</div>` : ''
    const media = message.media?.kind === 'video' ? `<div class="generated-video"><video src="${esc(mediaSourceUrl(message))}" controls playsinline preload="auto"></video><button type="button" class="media-download" data-download-video="${esc(message.id || '')}" title="下载视频">↓ 下载视频</button></div>` : ''
    const actions = user ? `<button type="button" data-message-copy title="复制消息">复制</button><button type="button" data-message-edit title="编辑消息">编辑</button><button type="button" data-message-resend title="重发消息">重发</button>` : '<button type="button" data-message-copy title="复制消息">复制</button>'
    return `<article class="message ${user ? 'user' : ''}" data-message-key="${esc(renderKey)}" data-message-index="${index}" data-business-status="${esc(message.businessStatus || '')}" data-business-phase="${esc(message.businessPhase || '')}" data-business-artifacts="${(message.artifacts || []).length}" data-business-signature="${esc(businessRenderSignature(message))}"><div class="avatar">${user ? initials(state.user?.email) : 'A'}</div><div class="message-body"><div class="message-role">${user ? '你' : 'LetaAgent'}</div>${thinking}${planMarkup}${businessMarkup}${autoEditMarkup}${bubbleMarkup}${media}${message.attachments?.length ? `<div class="message-attachments">${message.attachments.map((attachment) => attachmentMarkup(attachment, false)).join('')}</div>` : ''}<div class="message-meta">${time}<span class="message-actions">${actions}</span></div></div></article>`
  }
  function permissionHtml() {
    const request = state.permission
    if (!request) return ''
    if (request.method === 'confirm') {
      const toolName = request.toolName || request.tool || request.name
      const args = request.args && Object.keys(request.args).length ? `<details class="permission-details"><summary>查看操作详情</summary><pre>${esc(JSON.stringify(request.args, null, 2))}</pre></details>` : ''
      return `<div class="modal-backdrop"><section class="permission-modal"><div class="modal-kicker">Pi Agent 权限请求 · ${esc(protocolLabel(currentModel()))}</div><h3>${esc(request.title || (toolName ? `允许 ${toolName}？` : '确认操作'))}</h3><p>${esc(request.message || (toolName ? `Agent 请求执行工具：${toolName}` : 'Agent 请求执行一项操作。'))}</p>${args}<div class="modal-actions"><button class="ghost" id="permission-deny">拒绝</button><button class="primary modal-primary" id="permission-allow">允许本次</button></div></section></div>`
    }
    if (request.method === 'select') return `<div class="modal-backdrop"><section class="permission-modal"><div class="modal-kicker">Pi Agent 需要选择</div><h3>${esc(request.title || '选择')}</h3><div class="select-options">${(request.options || []).map((option, index) => `<button class="ghost option" data-option="${index}">${esc(option)}</button>`).join('')}</div></section></div>`
    return `<div class="modal-backdrop"><section class="permission-modal"><div class="modal-kicker">Pi Agent 需要输入</div><h3>${esc(request.title || '输入')}</h3><input id="permission-input" class="modal-input" placeholder="${esc(request.placeholder || '')}"><div class="modal-actions"><button class="ghost" id="permission-deny">取消</button><button class="primary modal-primary" id="permission-submit">提交</button></div></section></div>`
  }
  function skillGroupOptions(kind) {
    return availableSkillGroups(kind).map((group) => `<option value="${esc(group.id)}" ${Number(state.skillConfigs[kind].groupId) === Number(group.id) ? 'selected' : ''}>${esc(group.name || `${kind === 'image' ? '生图' : '生视频'}分组 ${group.id}`)}</option>`).join('')
  }
  function skillModelOptions(kind) {
    const groupId = Number(state.skillConfigs[kind].groupId)
    return skillModels(kind).filter((model) => Number(model.groupId) === groupId).map((model) => `<option value="${esc(model.name)}" ${model.name === state.skillConfigs[kind].model ? 'selected' : ''}>${esc(model.display_name || model.name)}</option>`).join('')
  }
  // 媒体模型与已安装插件共用菜单，业务技能不随客户端内置。
  function skillMenuEntries() {
    // @ 菜单只展示本机已安装且启用的插件；在线市场目录不参与发现。
    const entries = []
    const imageModels = skillModels('image')
    const videoModels = skillModels('video')
    if (state.skillEnabled.image && imageModels.length) entries.push({
      id: 'image', icon: '✦', label: '@生图', title: '生图',
      aliases: 'image 图片 画图 生成图片', description: '生成或编辑图片',
      detail: state.skillConfigs.image.model || `${imageModels.length} 个模型`
    })
    if (state.skillEnabled.video && videoModels.length) entries.push({
      id: 'video', icon: '◉', label: '@生视频', title: '生视频',
      aliases: 'video 视频 动画 生成视频', description: '生成短视频或动画',
      detail: state.skillConfigs.video.model || `${videoModels.length} 个模型`
    })
    // 插件 Skill 由主进程以 SKILL.md 目录传给 Pi；这里仅负责可发现性和 @ 插入。
    for (const plugin of pluginList().filter((item) => item?.enabled !== false)) {
      const businessAlias = {
        'tmall-public-feedback-analysis': '评价分析',
        'ai-image-analysis': '测图',
        'tmall-detail-reference': '一键详情页',
        'auto-edit': '自动剪辑',
        'presentation-router': '演示文稿',
        'presentation-pptx': 'PPT',
        spreadsheet: 'Excel',
        'tmall-shop-monitor': '店铺分析'
      }[plugin.id] || ''
      const marketName = String(plugin.displayName || '').trim()
      for (const skill of Array.isArray(plugin.skills) ? plugin.skills : []) {
        const name = String(skill?.name || '').trim()
        if (!name || entries.some((entry) => entry.id === `plugin:${plugin.id}:${name}`)) continue
        entries.push({
          id: `plugin:${plugin.id}:${name}`,
          icon: businessAlias ? (businessAlias === '测图' ? '◌' : '⌁') : '◇',
          label: `@${businessAlias || marketName || name}`,
          title: marketName || businessAlias || name,
          aliases: [businessAlias, marketName, plugin.name, name, ...(plugin.keywords || [])].filter(Boolean).join(' '),
          description: String(skill?.description || plugin.description || '插件技能'),
          detail: String(plugin.displayName || plugin.name || '已安装插件')
        })
      }
    }
    return entries
  }
  function filteredSkillMenuEntries(query = state.skillMenuQuery) {
    const normalized = String(query || '').trim().toLocaleLowerCase()
    if (!normalized) return skillMenuEntries()
    return skillMenuEntries().filter((entry) => `${entry.label} ${entry.title} ${entry.aliases} ${entry.description} ${entry.detail}`.toLocaleLowerCase().includes(normalized))
  }
  function skillMenuMarkup() {
    if (!state.skillMenuOpen) return ''
    const entries = filteredSkillMenuEntries()
    const activeIndex = entries.length ? Math.max(0, Math.min(Number(state.skillMenuActiveIndex) || 0, entries.length - 1)) : 0
    state.skillMenuActiveIndex = activeIndex
    const search = `<div class="skill-menu-search"><span aria-hidden="true">⌕</span><input id="skill-menu-search" type="search" value="${esc(state.skillMenuQuery)}" placeholder="搜索技能" aria-label="搜索技能" autocomplete="off"></div>`
    const list = entries.length ? entries.map((entry, index) => `<button type="button" class="skill-menu-item ${index === activeIndex ? 'active' : ''}" data-skill-insert="${esc(entry.id)}" data-skill-index="${index}" aria-selected="${index === activeIndex ? 'true' : 'false'}"><span class="skill-menu-icon">${entry.icon}</span><span class="skill-menu-copy"><strong>${esc(entry.label)}</strong><small>${esc(entry.description)} · ${esc(entry.detail)}</small></span></button>`).join('') : '<div class="muted menu-empty">没有匹配的技能</div>'
    return `<div class="skill-menu" role="listbox" aria-label="技能"><div class="menu-caption">调用技能 <span>${skillMenuEntries().length} 个可用</span></div>${search}<div class="skill-menu-list">${list}</div></div>`
  }
  function skillsMarketMarkup() {
    const imageModels = skillModels('image'); const videoModels = skillModels('video')
    return `<div class="skills-market">${state.skillError ? `<div class="plugin-market-error">${esc(state.skillError)}</div>` : ''}<div class="market-heading"><div><div class="modal-kicker">AnyuAgent Skills</div><h4>技能市场</h4><p>输入 @生图 或 @生视频后，技能会根据描述、参考图和当前模型能力自动选择参数。</p></div><span class="market-status">${state.skillsLoading ? '同步中…' : `${imageModels.length + videoModels.length} 个可用模型`}</span></div><div class="skill-grid"><article class="skill-card"><div class="skill-card-icon image">✦</div><div class="skill-card-copy"><strong>生图 Skill</strong><span>自动处理图片生成与参考图编辑，遵循自动分组的模型目录。</span><small>${imageModels.length ? `${imageModels.length} 个模型 · ${esc(state.skillConfigs.image.model)}` : '当前自动分组暂无生图模型'}</small></div><button class="skill-toggle ${state.skillEnabled.image ? 'enabled' : ''}" data-skill-toggle="image">${state.skillEnabled.image ? '已启用' : '启用'}</button></article><article class="skill-card"><div class="skill-card-icon video">◉</div><div class="skill-card-copy"><strong>生视频 Skill</strong><span>自动理解时长、画幅和画质意图，并适配首帧、首尾帧、多图及厂商协议。</span><small>${videoModels.length ? `${videoModels.length} 个模型 · ${esc(state.skillConfigs.video.model)}` : '当前自动分组暂无视频模型'}</small></div><button class="skill-toggle ${state.skillEnabled.video ? 'enabled' : ''}" data-skill-toggle="video">${state.skillEnabled.video ? '已启用' : '启用'}</button></article></div><div class="skill-config"><div class="config-title">技能模型</div><div class="config-row"><label>生图分组<select id="skill-image-group">${skillGroupOptions('image') || '<option value="">暂无可用分组</option>'}</select></label><label>生图模型<select id="skill-image-model">${skillModelOptions('image') || '<option value="">暂无可用模型</option>'}</select></label></div><div class="config-row"><label>视频分组<select id="skill-video-group">${skillGroupOptions('video') || '<option value="">暂无可用分组</option>'}</select></label><label>视频模型<select id="skill-video-model">${skillModelOptions('video') || '<option value="">暂无可用模型</option>'}</select></label></div></div></div>`
  }
  function coreSkillsMarkup() {
    return `<section class="settings-section settings-core-skills"><div class="setting-label-row"><div><h2>核心技能</h2><p class="settings-section-copy">管理内置图片与视频技能，它们不会被插件卸载影响。</p></div><button type="button" class="ghost" id="skills-refresh">同步目录</button></div><div class="setting-block skill-market-block">${skillsMarketMarkup()}</div></section>`
  }
  function legacyRenderApp() {
    const key = selectedKey(); const model = currentModel()
     root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="side-brand"><div class="brand-mark">A</div><div><strong>AnyuAgent</strong><span>独立 Pi Agent</span></div></div>
      <div class="nav-title">Workspace</div><div class="nav-item active"><span class="nav-icon">✦</span>Agent 对话</div><div class="nav-item" id="new-chat"><span class="nav-icon">＋</span>新建会话</div>
      <div class="nav-title">本机会话</div><div id="session-list">${sessionWorkspaceGroupsMarkup()}</div>
      <div class="side-footer"><div class="user-line"><div class="avatar">${initials(state.user?.email)}</div><div class="user-email" title="${esc(state.user?.email)}">${esc(state.user?.email || 'Anyu 用户')}</div></div><button class="logout" id="logout">切换账号</button></div></aside>
      <main class="main"><header class="topbar"><h2>Agent 对话</h2><div class="top-actions"><span class="muted" style="font-size:12px">${state.catalog.length} 个模型</span><button class="ghost" id="choose-cwd">工作目录</button><button class="ghost" id="refresh">刷新</button><button class="ghost" id="switch-account">切换账号</button></div></header>
      ${state.error ? `<div class="app-alert" role="status">${esc(state.error)}</div>` : ''}
      <div class="workspace"><section class="chat-panel"><div class="chat-head"><div><div class="chat-title">${esc(state.sessions.find((item) => item.path === state.sessionPath)?.title || '新会话')}</div><div class="chat-subtitle">Pi Agent Core · Anyu Gateway · ${esc(effectiveWorkspace() || '未选择工作目录')}</div></div></div>
        <div class="messages" id="messages">${messagesMarkup()}</div>
        <div class="composer"><div class="composer-box"><textarea id="prompt" placeholder="给 AnyuAgent 一条指令…（Enter 发送，Shift+Enter 换行）"></textarea><button class="send" id="send" title="发送">↑</button></div><div class="composer-meta"><span>本地 Pi 可读取、编辑并执行项目文件</span><span id="busy">${state.loading ? 'Agent 正在工作…' : ''}</span></div></div></section>
        <aside class="side-panel"><section class="panel"><div class="panel-title">当前密钥 <small>${state.keys.length} 个</small></div><div class="key-list">${state.keys.length ? state.keys.map(keyHtml).join('') : '<div class="muted">暂无可用密钥</div>'}</div></section>
          <section class="panel"><div class="panel-title">模型与路由</div><div class="model-row"><label>当前模型</label><select id="model">${state.catalog.map((item) => `<option value="${esc(item.id)}" ${item.id === state.model ? 'selected' : ''}>${esc(item.name || item.id)}</option>`).join('')}</select></div><div class="status-line"><span>路由密钥</span><strong>${esc(key?.name || '未选择')}</strong></div><div class="status-line"><span>Agent 状态</span><strong class="status-ok">${state.piState ? '本地已连接' : '未启动'}</strong></div></section>
          <section class="panel"><div class="panel-title">可用模型 <small>${esc(state.catalogSource || '自动同步')}</small></div><div class="catalog-grid">${state.catalog.slice(0, 18).map((item) => `<span class="chip">${esc(item.name || item.id)}</span>`).join('') || '<span class="muted">暂无模型目录</span>'}</div></section>
        </aside></div></main>${permissionHtml()}</div>`
    bindAppEvents(); pinMessagesToBottom(); requestAnimationFrame(() => pinMessagesToBottom())
  }

  function legacyBindAppEvents() {
    document.querySelectorAll('[data-key]').forEach((node) => node.addEventListener('click', async () => { state.selectedKey = Number(node.dataset.key); localStorage.setItem('anyu.selectedKey', String(state.selectedKey)); state.error = ''; try { await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '切换密钥失败' }; renderApp() }))
    document.querySelectorAll('.session').forEach((node) => {
      node.addEventListener('click', () => switchSession(node.dataset.path))
      node.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); state.sessionMenu = { path: node.dataset.path, x: event.clientX, y: event.clientY }; renderApp() })
    })
    document.querySelectorAll('[data-session-action]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); void handleSessionAction(node.dataset.sessionAction, node.dataset.sessionPath) }))
     document.querySelector('.app-shell')?.addEventListener('click', (event) => {
       if (state.sessionMenu && !event.target.closest('[data-session-menu]')) { state.sessionMenu = null; renderApp(); return }
        if ((state.modelMenuOpen || state.groupMenuOpen) && !event.target.closest('.model-picker-wrap, .group-picker-wrap')) { state.modelMenuOpen = false; state.groupMenuOpen = false; renderApp(); return }
       if ((state.permissionMenuOpen || state.thinkingMenuOpen) && !event.target.closest('#permission-picker, #thinking-picker, .bar-menu')) {
        state.permissionMenuOpen = false; state.thinkingMenuOpen = false; renderApp(); return
      }
       if ((state.skillMenuOpen || state.imageMenuOpen) && !event.target.closest('.skill-menu, .image-reference-menu, #prompt, #attach-trigger')) {
        state.skillMenuOpen = false; state.imageMenuOpen = false; renderApp()
      }
    })
    // 这一条是模型下拉框（备用布局）的切换入口，和 activateModel 共用同一套保护：
    // Pi 不响应时不能把界面锁住，超时后照常重绘。
    document.querySelector('#model')?.addEventListener('change', async (event) => { state.model = event.target.value; localStorage.setItem('anyu.selectedModel', state.model); try { await piRequestWithTimeout({ type: 'set_model', sessionKey: state.sessionPath, provider: currentModel()?.provider || providerForApi('openai-completions'), modelId: state.model }, MODEL_SWITCH_TIMEOUT_MS) } catch (error) { state.error = errorText(error) || '切换模型失败' }; renderApp() })
    const switchAccount = async () => {
      state.error = ''
      try { await window.anyu.piStop() } catch {}
      try { await window.anyu.logout() } catch {}
      state.user = null; state.keys = []; state.catalog = []; state.catalogSource = ''; state.sessions = []; state.sessionPath = null; state.messages = []; state.piState = null; state.loading = false; state.permission = null; state.twoFactor = null; state.streamingMessage = null
      render()
    }
    document.querySelector('#logout')?.addEventListener('click', switchAccount)
    document.querySelector('#switch-account')?.addEventListener('click', switchAccount)
    document.querySelector('#refresh')?.addEventListener('click', async () => { state.error = ''; try { await loadRouteData(); chooseModel(); await startAgent(state.sessionPath) } catch (error) { state.error = errorText(error) || '刷新失败' }; renderApp() })
    document.querySelector('#choose-cwd')?.addEventListener('click', async () => { const directory = await window.anyu.chooseDirectory(); if (!directory) return; state.cwd = directory; localStorage.setItem('anyu.cwd', directory); try { await startAgent(state.sessionPath) } catch (error) { state.error = error.message }; renderApp() })
    document.querySelector('#new-chat')?.addEventListener('click', newConversation)
    const prompt = document.querySelector('#prompt'); prompt?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage() } }); document.querySelector('#send')?.addEventListener('click', sendMessage)
    document.querySelector('#permission-allow')?.addEventListener('click', () => answerPermission({ confirmed: true })); document.querySelector('#permission-deny')?.addEventListener('click', () => answerPermission({ confirmed: false })); document.querySelector('#permission-submit')?.addEventListener('click', () => answerPermission({ value: document.querySelector('#permission-input')?.value || '' })); document.querySelectorAll('[data-option]').forEach((node) => node.addEventListener('click', () => answerPermission({ value: state.permission.options[Number(node.dataset.option)] })))
  }

  function appearanceMarkup() {
    // 预览缩略图的配色与主题令牌同源，写在 styles.css 的 .appearance-card[data-appearance-theme] 里。
    const cards = APPEARANCE_THEMES.map((theme) => {
      const active = theme.id === state.appearanceTheme
      return `<button type="button" class="appearance-card ${active ? 'active' : ''}" data-appearance-theme="${esc(theme.id)}" aria-pressed="${active ? 'true' : 'false'}"><span class="appearance-thumb" aria-hidden="true"><span class="appearance-thumb-side"><span></span><span></span><span></span></span><span class="appearance-thumb-body"><span class="appearance-thumb-line"></span><span class="appearance-thumb-line short"></span><span class="appearance-thumb-bubble"></span><span class="appearance-thumb-bubble user"></span></span><span class="appearance-thumb-check">✓</span></span><span class="appearance-card-name">${esc(theme.name)}</span><span class="appearance-card-hint">${esc(theme.hint)}</span></button>`
    }).join('')
    return `<section class="settings-section"><h2>外观</h2><p class="appearance-legend">选择一套经典配色。外观只改变本机界面配色，不会影响账号、密钥或会话数据。</p><div class="appearance-grid">${cards}</div></section>`
  }

  function settingsMarkup() {
    // 设置导航只展示已经实现的页面，避免空入口干扰用户。
    const section = ['general', 'appearance', 'skills', 'plugins'].includes(state.settingsSection) ? state.settingsSection : 'general'
    const pageTitle = { general: '常规', appearance: '外观', skills: '核心技能', plugins: '插件市场' }[section]
    const generalMarkup = `
      <section class="settings-section"><h2>权限</h2><div class="settings-card"><div class="settings-row"><div><strong>本机访问权限</strong><p>完整访问会启用所有内置和扩展工具；切换权限模式不会重启应用，只有下面单独的管理员授权才会。</p></div><div class="permission-segmented" role="group" aria-label="本机访问权限"><button type="button" class="${state.permissionMode === 'auto' ? 'active' : ''}" data-permission-mode="auto">自动适配</button><button type="button" class="${state.permissionMode === 'confirm' ? 'active' : ''}" data-permission-mode="confirm">受控访问</button><button type="button" class="${state.permissionMode === 'full' ? 'active' : ''}" data-permission-mode="full">完整访问</button></div></div><p class="settings-help">当前模型：${esc(permissionModeLabel())}；权限档案：${state.permissionMode === 'full' ? 'gptFullAccess（全部内置工具和已安装扩展工具）' : '按需确认'}。</p><div class="settings-row"><div><strong>系统授权状态</strong><p>${esc(systemAccessLabel())}</p></div><div class="settings-row-actions">${state.systemAccess?.platform === 'win32' && !state.systemAccess?.administrator ? '<button type="button" class="ghost" id="request-system-elevation">以管理员身份重启</button>' : ''}${state.systemAccess?.platform === 'darwin' ? '<button type="button" class="ghost" id="open-privacy-settings">打开完全磁盘访问</button><button type="button" class="ghost" id="open-accessibility-settings">打开辅助功能</button>' : ''}</div></div></div></section>
      <section class="settings-section"><h2>常规</h2><div class="settings-card"><div class="settings-row"><div><strong>无项目任务文件夹</strong><p>在项目外启动的任务默认存储数据的位置。</p></div><div class="settings-row-actions"><span class="settings-value">${esc(effectiveWorkspace() || '尚未选择')}</span><button type="button" class="ghost" id="settings-cwd">更改</button></div></div><div class="settings-divider"></div><div class="settings-row"><div><strong>账户</strong><p>当前登录的 Anyu 账号。</p></div><span class="settings-value">${esc(state.user?.email || 'Anyu 用户')}</span></div></div></section>
      <section class="settings-section settings-account-actions"><h2>账号操作</h2><div class="settings-card"><div class="settings-row"><div><strong>切换账号</strong><p>退出当前账号并返回登录页面。</p></div><button type="button" class="ghost" id="settings-logout">切换账号</button></div></div></section>`
    const content = section === 'appearance' ? appearanceMarkup() : section === 'skills' ? coreSkillsMarkup() : section === 'plugins' ? pluginMarketMarkup() : generalMarkup
    return `<div class="settings-page-layout">
      <aside class="settings-sidebar">
        <button type="button" class="settings-back" id="settings-back"><span aria-hidden="true">←</span><span>返回应用</span></button>
        <nav class="settings-nav" aria-label="设置分类">
          <button type="button" class="settings-nav-item ${section === 'general' ? 'active' : ''}" data-settings-section="general" ${section === 'general' ? 'aria-current="page"' : ''}><span>⚙</span><span>常规</span></button>
          <button type="button" class="settings-nav-item ${section === 'appearance' ? 'active' : ''}" data-settings-section="appearance" ${section === 'appearance' ? 'aria-current="page"' : ''}><span>◐</span><span>外观</span></button>
          <button type="button" class="settings-nav-item ${section === 'skills' ? 'active' : ''}" data-settings-section="skills" ${section === 'skills' ? 'aria-current="page"' : ''}><span>✦</span><span>核心技能</span></button>
          <button type="button" class="settings-nav-item ${section === 'plugins' ? 'active' : ''}" data-settings-section="plugins" ${section === 'plugins' ? 'aria-current="page"' : ''}><span>◈</span><span>插件市场</span></button>
        </nav>
      </aside>
      <main class="settings-page-main">
        <header class="settings-page-header">
          <div><div class="modal-kicker">AnyuAgent</div><h1>${pageTitle}</h1></div>
          <div class="settings-window-controls" aria-label="窗口控制"><button type="button" data-window-action="minimize" title="最小化">−</button><button type="button" data-window-action="maximize" title="最大化">□</button><button type="button" data-window-action="close" title="关闭">×</button></div>
        </header>
        <div class="settings-page-content">${content}</div>
      </main>
    </div>`
  }

  function groupOptionsMarkup() {
    const query = String(state.groupMenuQuery || '').trim().toLowerCase()
    const poolGroups = state.catalogGroups.filter((group) => (String(group.pool_type || '').toLowerCase() === 'discount' ? 'discount' : 'stable') === state.groupPoolTab)
    const providers = [...new Set(poolGroups.map((group) => {
      const value = `${group.platform || ''} ${group.display_brand || ''}`.toLowerCase()
      if (/anthropic|claude/.test(value)) return 'Claude'
      if (/google|gemini/.test(value)) return 'Gemini'
      if (/openai|gpt/.test(value)) return 'OpenAI / Codex'
      return cleanDisplayText(group.platform || '其他') || '其他'
    }))]
    const providerFiltered = state.groupProviderFilter === 'all' ? poolGroups : poolGroups.filter((group) => {
      const value = `${group.platform || ''} ${group.display_brand || ''}`.toLowerCase()
      return state.groupProviderFilter === 'Claude' ? /anthropic|claude/.test(value) : state.groupProviderFilter === 'Gemini' ? /google|gemini/.test(value) : state.groupProviderFilter === 'OpenAI / Codex' ? /openai|gpt/.test(value) : true
    })
    const filtered = query ? providerFiltered.filter((group) => `${group.name || ''} ${group.display_brand || ''} ${group.platform || ''}`.toLowerCase().includes(query)) : providerFiltered
    const stableCount = state.catalogGroups.filter((group) => String(group.pool_type || '').toLowerCase() !== 'discount').length
    const discountCount = state.catalogGroups.filter((group) => String(group.pool_type || '').toLowerCase() === 'discount').length
    return `<div class="group-catalog-heading"><strong>选择服务分组</strong><small>${state.catalogGroups.length} 个可用分组</small></div><label class="model-search"><span aria-hidden="true">⌕</span><input id="group-search" type="search" value="${esc(state.groupMenuQuery)}" placeholder="搜索分组..." autocomplete="off"></label><div class="group-pool-tabs"><button type="button" class="${state.groupPoolTab === 'stable' ? 'active' : ''}" data-group-pool="stable">稳定号池 <small>${stableCount}</small></button><button type="button" class="${state.groupPoolTab === 'discount' ? 'active' : ''}" data-group-pool="discount">特价号池 <small>${discountCount}</small></button></div><div class="group-provider-tabs"><button type="button" class="${state.groupProviderFilter === 'all' ? 'active' : ''}" data-group-provider="all">全部品牌</button>${providers.map((provider) => `<button type="button" class="${state.groupProviderFilter === provider ? 'active' : ''}" data-group-provider="${esc(provider)}">${esc(provider)}</button>`).join('')}</div><div class="group-table-head"><span>服务分组</span><span>最近 60 次请求</span><span>实际 / 上限&nbsp;&nbsp;倍率</span></div><div class="model-group-list">${filtered.map((group) => {
      const selected = Number(group.id) === Number(state.selectedGroupId)
      const modelCount = state.catalog.filter((item) => Number(item.groupId) === Number(group.id)).length
      const poolLabel = String(group.pool_type || '').toLowerCase() === 'discount' ? '特价号池' : '稳定号池'
      const capacity = groupCapacityLabel(group)
      return `<button type="button" class="model-group-option ${selected ? 'selected' : ''}" data-catalog-group="${esc(group.id)}"><span class="model-group-icon">▣</span><span class="model-group-copy"><strong>${esc(cleanDisplayText(group.display_brand || group.name) || 'Anyu 分组')}${selected ? '<em>当前</em>' : ''}</strong><small>${esc(poolLabel)} · ${esc(group.platform || '多厂家')} · ${modelCount} 个模型${capacity ? ` · ${esc(capacity)}` : ''}</small></span><span class="model-group-rate rate-display">${groupRateMarkup(group)}</span><span class="group-row-arrow">›</span></button>`
    }).join('') || '<div class="muted menu-empty">暂无匹配分组</div>'}</div>`
  }

  function modelOptionsMarkup() {
    // 一步直达：不再"先选分组再选模型"。数据源直接用全量 catalog
    // （后台各分组的模型已拉平在这里），按 provider 分区展示。
    // 38 项以内一次性渲染远快于二级面板的多次交互，无需虚拟化。
    const query = String(state.modelMenuQuery || '').trim().toLowerCase()
    const allModels = state.catalog
    const filteredModels = query ? allModels.filter((item) => `${item.name || ''} ${item.modelId || ''} ${item.groupName || ''} ${modelProviderLabel(item)}`.toLowerCase().includes(query)) : allModels
    const providers = new Map()
    for (const item of filteredModels) {
      const provider = modelProviderLabel(item)
      if (!providers.has(provider)) providers.set(provider, [])
      providers.get(provider).push(item)
    }
    const modelRows = [...providers.entries()].map(([provider, models]) => `<section class="model-provider-group"><h4>${esc(provider)} <span>${models.length}</span></h4>${models.map((item) => `<button type="button" class="model-option ${item.id === state.model ? 'selected' : ''}" data-model-id="${esc(item.id)}" ${state.switching || state.sessionSwitching ? 'disabled' : ''}><span class="model-option-main"><strong>${esc(item.name || item.modelId || item.id)}</strong><small>${esc(cleanDisplayText(item.groupName) || 'Anyu 分组')}</small></span><span class="model-option-rate rate-display">${groupRateMarkup(item)}</span></button>`).join('')}</section>`).join('')
    return `<div class="model-menu-heading"><strong>选择模型</strong><small>全部模型 · ${allModels.length} 个可用</small></div><label class="model-search"><span aria-hidden="true">⌕</span><input id="model-search" type="search" value="${esc(state.modelMenuQuery)}" placeholder="搜索模型…" autocomplete="off"></label><div class="model-model-list">${modelRows || '<div class="muted menu-empty">没有匹配的模型</div>'}</div>`
  }

  function modelGroupKey(model) {
    const groupId = Number(model?.groupId)
    return Number.isSafeInteger(groupId) && groupId > 0 ? `id:${groupId}` : `name:${cleanDisplayText(model?.groupName) || '默认分组'}`
  }

  /**
   * 权限 pill 及其下拉菜单。
   *
   * 切换权限模式只重启 Pi 子进程，不重启应用；系统管理员权限是另一件事，
   * 单独列在菜单下半部分，并且明确标注"会重启应用"。
   */
  function permissionPickerMarkup() {
    const mode = PERMISSION_MODES.some((item) => item.id === state.permissionMode) ? state.permissionMode : 'auto'
    const meta = permissionModeMeta(mode)
    const effective = effectivePermissionMode()
    const access = state.systemAccess
    const elevated = Boolean(access?.administrator)
    const rows = PERMISSION_MODES
      .map((item) => `<button type="button" role="menuitemradio" aria-checked="${item.id === mode}" class="bar-menu-item ${item.id === mode ? 'selected' : ''}" data-permission-mode="${esc(item.id)}"><span class="bar-menu-icon">${esc(item.icon)}</span><span class="bar-menu-copy"><strong>${esc(item.name)}</strong><small>${esc(item.hint)}</small></span><span class="bar-menu-check">${item.id === mode ? '✓' : ''}</span></button>`)
      .join('')
    // Windows 上进程一旦启动就无法自我提权，只能靠 UAC 拉起新实例，所以这一步
    // 必然重启应用。必须把代价写在界面上，用户才知道点它的后果。
    let elevationRow = ''
    if (access?.platform === 'win32') {
      elevationRow = elevated
        ? `<div class="bar-menu-note" role="note"><span class="bar-menu-icon">✓</span><span class="bar-menu-copy"><strong>已具备管理员权限</strong><small>系统保护目录可以正常读写</small></span></div>`
        : `<button type="button" class="bar-menu-item" id="request-elevation"><span class="bar-menu-icon">🛡</span><span class="bar-menu-copy"><strong>以管理员身份重启</strong><small>可选。只有当任务需要写系统保护目录时才用，会重启应用</small></span></button>`
    } else if (access?.platform === 'darwin') {
      elevationRow = `<button type="button" class="bar-menu-item" id="request-privacy-settings"><span class="bar-menu-icon">🛡</span><span class="bar-menu-copy"><strong>打开隐私与安全性设置</strong><small>完全磁盘访问、辅助功能需在系统设置里手动授权</small></span></button>`
    }
    const menu = state.permissionMenuOpen
      ? `<div class="bar-menu permission-menu" role="menu" aria-label="本机访问权限"><div class="bar-menu-heading"><strong>本机访问权限</strong><small>切换后立即生效，不会重启应用</small></div>${rows}<div class="bar-menu-divider"></div><div class="bar-menu-heading"><strong>系统权限</strong><small>${esc(state.systemAccess ? systemAccessLabel() : '正在读取…')}</small></div>${elevationRow}</div>`
      : ''
    // auto 模式下真正生效的是按模型解出来的档位。只写"自动适配"用户无从判断
    // 当前到底会不会弹确认，所以把解析结果一并写在 pill 上。
    const label = mode === 'auto' ? `自动·${permissionModeLabel(effective)}` : meta.name
    return `<div class="bar-picker"><button type="button" id="permission-picker" class="bar-pill ${effective === 'full' ? 'is-warning' : ''}" aria-haspopup="menu" aria-expanded="${state.permissionMenuOpen}" title="${esc(`本机访问权限：${mode === 'auto' ? `自动适配，当前按模型能力为${permissionModeLabel(effective)}` : meta.name}。${meta.hint}`)}"><span class="bar-pill-icon">${esc(meta.icon)}</span><span class="bar-pill-label">${esc(label)}</span><span class="picker-chevron">⌄</span></button>${menu}</div>`
  }

  /**
   * 思考强度 pill。可选档位完全由当前模型决定（模板库判定 + Pi 实际回报），
   * 所以每个模型看到的档位都不一样，且每个模型各自记住上次选择。
   */
  function thinkingPickerMarkup() {
    const levels = state.thinkingLevels
    const level = state.thinkingLevel
    const model = currentModel()
    const template = modelThinkingTemplate(model)
    // 只有一档（例如不支持推理的模型）时没有可选项，直接置灰。
    const disabled = !levels.length || levels.length <= 1
    const rows = levels
      .map((item) => `<button type="button" role="menuitemradio" aria-checked="${item === level}" class="bar-menu-item ${item === level ? 'selected' : ''}" data-thinking-level="${esc(item)}"><span class="bar-menu-icon">${esc(thinkingLevelIcon(item))}</span><span class="bar-menu-copy"><strong>${esc(thinkingLevelLabel(item))}</strong><small>${esc(thinkingPresets.describe(item))}</small></span><span class="bar-menu-check">${item === level ? '✓' : ''}</span></button>`)
      .join('')
    const menu = state.thinkingMenuOpen && !disabled
      ? `<div class="bar-menu thinking-menu" role="menu" aria-label="思考强度"><div class="bar-menu-heading"><strong>思考强度</strong><small>${esc(model ? `${model.name || model.id}${template ? ` · ${template}` : ''}` : '选择模型后可调整')}</small></div>${rows}</div>`
      : ''
    return `<div class="bar-picker"><button type="button" id="thinking-picker" class="bar-pill ${level === 'off' ? 'is-muted' : ''}" aria-haspopup="menu" aria-expanded="${state.thinkingMenuOpen}" ${disabled ? 'disabled' : ''} title="${esc(disabled ? '当前模型不支持调整思考强度' : `思考强度：${thinkingLevelLabel(level)}${template ? `（${template}）` : ''}`)}"><span class="bar-pill-icon">${esc(thinkingLevelIcon(level))}</span><span class="bar-pill-label">${esc(thinkingLevelLabel(level))}</span><span class="picker-chevron">⌄</span></button>${menu}</div>`
  }

  /** 输入栏底部工具条：附件、权限、思考强度、模型、发送。 */
  function composerBarMarkup(model, disabled) {
    return `<div class="composer-bar"><button class="attach-button" id="attach-trigger" title="添加文件或图片" aria-label="添加文件或图片" ${state.sessionSwitching ? 'disabled' : ''}></button>${permissionPickerMarkup()}${thinkingPickerMarkup()}<span class="composer-bar-gap"></span>${modelPickerMarkup(model, disabled)}<button class="send ${state.loading ? 'stop' : ''}" id="send" ${state.sessionSwitching ? 'disabled' : ''} title="${state.loading ? '停止当前任务' : '发送'}" aria-label="${state.loading ? '停止当前任务' : '发送'}">${state.loading ? '■' : '↑'}</button></div>`
  }

  function modelPickerMarkup(model, disabled) {
    const label = model ? model.name || model.modelId || model.id : '选择模型'
    // 一步直达：按钮可用性不再依赖"是否已选分组"；副标题直接展示厂家通道，
    // 分组倍率在模型菜单的每一行右侧展示。
    return `<div class="model-picker-wrap"><button type="button" id="model-picker" class="model-picker-button" aria-haspopup="listbox" aria-expanded="${state.modelMenuOpen}" ${disabled ? 'disabled' : ''}><span class="model-picker-copy"><strong>${esc(label)}</strong><small>${esc(model ? modelProviderLabel(model) : '选择模型')}</small></span><span class="picker-chevron">⌄</span></button>${state.modelMenuOpen ? `<div class="model-menu" role="listbox" aria-label="选择模型">${modelOptionsMarkup()}</div>` : ''}</div>`
  }

  function browserPanelMarkup() {
    if (!state.browser?.open) return ''
    return `<div class="agent-browser-bar"><button type="button" data-browser-back title="返回" ${state.browser.canGoBack ? '' : 'disabled'}>‹</button><button type="button" data-browser-forward title="前进" ${state.browser.canGoForward ? '' : 'disabled'}>›</button><span class="agent-browser-dot"></span><strong>${esc(state.browser.title || '内置浏览器')}</strong><small>${esc(state.browser.loading ? '加载中…' : state.browser.error || state.browser.url)}</small><button type="button" data-browser-reload title="刷新页面">↻</button><button type="button" data-browser-external title="在系统浏览器打开" ${/^https?:\/\//i.test(state.browser.url || '') ? '' : 'hidden'}>↗</button><button type="button" data-browser-close title="关闭浏览器">×</button></div>`
  }

  let browserBoundsFrame = 0
  function scheduleBrowserBoundsSync() {
    if (browserBoundsFrame) cancelAnimationFrame(browserBoundsFrame)
    browserBoundsFrame = requestAnimationFrame(() => {
      browserBoundsFrame = 0
      // 内置浏览器是主进程的原生 BrowserView，永远绘制在所有 HTML 之上，z-index 对它无效。
      // 全屏遮罩（图片灯箱/权限弹窗）打开时必须上报 null 让主进程把它 setVisible(false)，
      // 否则预览和弹窗在浏览器那半边被原生视图盖死。遮罩关闭后 renderApp 会再同步回来。
      if (state.imagePreview || state.permission) {
        window.anyu.browserSetBounds?.(null)
        return
      }
      const host = document.querySelector('#agent-browser-host')
      if (!host) {
        window.anyu.browserSetBounds?.(null)
        return
      }
      // 直接同步右侧占位区的最终布局，避免主进程猜测 CSS 偏移量。
      const rect = host.getBoundingClientRect()
      window.anyu.browserSetBounds?.({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    })
  }
  window.addEventListener('resize', scheduleBrowserBoundsSync)

  function groupPickerMarkup(group, disabled) {
    const label = cleanDisplayText(group?.display_brand || group?.name) || '选择分组'
    const poolLabel = group && String(group.pool_type || '').toLowerCase() === 'discount' ? '特价号池' : '稳定号池'
    return `<div class="group-picker-wrap"><button type="button" id="group-picker" class="group-picker-button" aria-haspopup="listbox" aria-expanded="${state.groupMenuOpen}" ${disabled ? 'disabled' : ''}><span class="group-picker-mark">⌁</span><span class="model-picker-copy"><strong>${esc(label)}</strong><small>${esc(group ? poolLabel : '请选择服务分组')}</small></span><span class="picker-chevron">⌄</span></button>${state.groupMenuOpen ? `<div class="model-menu group-menu" role="listbox" aria-label="选择服务分组">${groupOptionsMarkup()}</div>` : ''}</div>`
  }

  // 返回当前会话的滚动容器；会话切换和异步流式刷新都通过这一处读取位置。
  function conversationScrollBox() {
    return document.querySelector('#messages')
  }

  // 保存每个会话独立的滚动位置，避免切换历史会话时沿用旧会话的视口。
  function saveSessionScroll(sessionPath = state.sessionPath, box = conversationScrollBox()) {
    const path = String(sessionPath || '')
    if (!path || !box) return null
    const position = {
      top: Math.max(0, Number(box.scrollTop || 0)),
      atBottom: Number(box.scrollHeight || 0) - Number(box.scrollTop || 0) - Number(box.clientHeight || 0) < 72
    }
    state.sessionScrollPositions[path] = position
    return position
  }

  function renderApp() {
    if (state.settingsOpen) {
      root.innerHTML = `${settingsMarkup()}${permissionHtml()}`
      bindAppEvents()
      scheduleBrowserBoundsSync()
      return
    }
    const previousBox = conversationScrollBox()
    const sameSession = state.renderedSessionPath === state.sessionPath
    // 先记录旧 DOM 所属会话的位置，再按目标会话恢复；切换会话时不能把旧位置套到新会话。
    const previousScroll = previousBox ? saveSessionScroll(state.renderedSessionPath || (sameSession ? state.sessionPath : ''), previousBox) : null
    const targetScroll = state.sessionScrollPositions?.[state.sessionPath] || null
    const restoreScroll = targetScroll || (sameSession ? previousScroll : null)
    const openDetails = sameSession && previousBox ? [...previousBox.querySelectorAll('.message')].map((node) => [...node.querySelectorAll('details')].map((detail) => detail.open)) : []
    const restorePromptFocus = document.activeElement?.id === 'prompt'
    const restorePromptCursor = restorePromptFocus ? Number(document.activeElement?.selectionStart) : null
    const model = currentModel()
    const controlsBusy = state.switching || state.sessionSwitching
    // 整壳 innerHTML 重建会把侧栏会话列表滚回顶部：点下方的历史会话时列表“往上弹”。
    // 先记下滚动位置，重建后原样还原，列表保持不动。
    const sessionListScroll = Number(document.querySelector('#session-list')?.scrollTop || 0)
    root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="side-brand"><div class="brand-mark">A</div><div><strong>AnyuAgent</strong><span>独立 Pi Agent</span></div></div>
      <div class="nav-section"><div class="nav-title">工作区</div><div class="nav-item active"><span class="nav-icon">✦</span>Agent 对话</div><button class="nav-item nav-button" id="new-chat"><span class="nav-icon">＋</span>新建会话</button></div>
       <div class="nav-section sessions-section"><div class="nav-title">本机会话</div><div id="session-list">${sessionWorkspaceGroupsMarkup()}</div></div>
      <div class="side-footer"><button class="update-link ${state.update.status === 'error' ? 'error' : ''}" id="update-app" ${['checking', 'downloading', 'installing'].includes(state.update.status) ? 'disabled' : ''}><span class="nav-icon update-icon ${['checking', 'downloading', 'installing'].includes(state.update.status) ? 'spinning' : ''}">↻</span><span class="update-label">${esc(updateButtonLabel())}</span></button><button class="settings-link" id="settings-open"><span class="nav-icon">⚙</span>设置</button><div class="balance-summary" title="每 60 秒自动同步"><div class="balance-caption"><span>剩余额度</span><span class="balance-sync-dot"></span></div><strong>${esc(formatBalance())}</strong></div><div class="user-line"><div class="avatar">${initials(state.user?.email)}</div><div class="user-email" title="${esc(state.user?.email)}">${esc(state.user?.email || 'Anyu 用户')}</div></div></div></aside>
      <main class="main ${state.browser?.open ? 'browser-open' : ''}"><header class="topbar"><div class="topbar-title"><h2>Agent 对话</h2><span class="connection-dot ${state.piState || state.pendingNewAgent ? '' : 'offline'}"></span><span class="connection-label" title="${esc(buildStampTitle())}">${state.piState ? '已连接' : state.pendingNewAgent ? '就绪' : '未连接'}</span></div><div class="top-actions"><span class="muted model-count">${state.catalog.length} 个模型</span><button class="icon-button" id="refresh" title="刷新">↻</button><div class="window-controls" aria-label="窗口控制"><button type="button" data-window-action="minimize" title="最小化">−</button><button type="button" data-window-action="maximize" title="最大化">□</button><button type="button" data-window-action="close" title="关闭">×</button></div></div></header>${browserPanelMarkup()}
      ${state.error ? `<div class="app-alert" role="status">${esc(state.error)}</div>` : ''}
      ${state.elevationNotice ? `<div class="app-notice" role="status"><span>${esc(state.elevationNotice)}</span><button type="button" class="app-notice-close" id="elevation-notice-close" title="知道了">知道了</button></div>` : ''}
      <div class="conversation"><section class="chat-panel"><div class="chat-head"><div><div class="chat-title">${esc(state.sessions.find((item) => item.path === state.sessionPath)?.title || '新会话')}</div><div class="chat-subtitle">${esc(model ? `${modelProviderLabel(model)} · ${model.name || model.id}` : '选择模型后开始')}</div></div></div>
         <div class="messages" id="messages">${messagesMarkup()}</div>
           <div class="composer"><div id="live-task-slot" data-task-signature="">${liveTaskBarMarkup(liveTaskState())}</div>${queuedTasksMarkup()}${attachmentsMarkup()}<div class="composer-tools"><div class="auto-route-badge"><span class="picker-icon">⌁</span><span>自动分组</span></div><button class="ghost cwd-button" id="choose-cwd" title="工作目录">⌂ ${esc(state.cwd ? state.cwd.split('\\').pop() || state.cwd : '目录')}</button></div><div class="composer-box"><input id="file-input" type="file" multiple hidden><input id="image-input" type="file" accept="image/*" multiple hidden><input id="folder-input" type="file" webkitdirectory directory multiple hidden><div class="attachment-menu hidden" id="attachment-menu"><button type="button" id="attach-files"><span>▧</span><span><strong>文件</strong><small>添加代码和文档</small></span></button><button type="button" id="attach-folder"><span>□</span><span><strong>文件夹</strong><small>添加一个目录供 Agent 读取</small></span></button></div><div class="image-reference-menu ${state.imageMenuOpen ? '' : 'hidden'}" id="image-reference-menu">${imageReferenceMarkup()}</div>${skillMenuMarkup()}<textarea id="prompt" ${state.sessionSwitching && !state.messages.length ? 'disabled' : ''} placeholder="给 AnyuAgent 一条指令…（输入 @ 调用技能或引用图片，Enter 发送，Shift+Enter 换行）">${esc(state.composerText)}</textarea>${composerBarMarkup(model, controlsBusy)}</div><div class="composer-meta"><span>Pi 可读取、编辑并执行工作目录中的文件</span><span id="busy">${state.retryNotice || (state.loading ? 'Agent 正在工作…' : state.queuedTasks.length ? `${state.queuedTasks.length} 项排队中` : '')}</span></div></div></section></div></main>${state.settingsOpen ? settingsMarkup() : ''}${permissionHtml()}${imagePreviewMarkup()}${sessionContextMenuMarkup()}</div>`
    const browserBar = root.querySelector('.main > .agent-browser-bar')
    const conversation = root.querySelector('.conversation')
    if (browserBar && conversation) {
      conversation.classList.add('browser-layout')
      const panel = document.createElement('aside')
      panel.className = 'agent-browser-panel'
      const frame = document.createElement('div')
      frame.className = 'agent-browser-frame'
      const host = document.createElement('div')
      host.id = 'agent-browser-host'
      frame.append(host)
      panel.append(browserBar, frame)
      conversation.append(panel)
    }
    // 一步直达选模型后，composer 不再放"服务分组"按钮（分组信息在模型行的副标题里展示），
    // 旧的占位徽标直接移除，避免用户回到两步选择的老路径。
    const legacyGroupBadge = document.querySelector('.auto-route-badge')
    if (legacyGroupBadge) legacyGroupBadge.remove()
    bindAppEvents()
    state.renderedSessionPath = state.sessionPath
    const sessionList = document.querySelector('#session-list')
    if (sessionList && sessionListScroll) sessionList.scrollTop = sessionListScroll
    const nextBox = document.querySelector('#messages')
    if (nextBox) {
      [...nextBox.querySelectorAll('.message')].forEach((node, index) => [...node.querySelectorAll('details')].forEach((detail, detailIndex) => {
        if (openDetails[index]?.[detailIndex] !== undefined) detail.open = openDetails[index][detailIndex]
      }))
      if (restoreScroll?.atBottom) {
        settleMessagesAtBottom(nextBox)
      } else if (restoreScroll) {
        // 等待本帧布局完成后恢复，避免 innerHTML 替换造成瞬时跳顶。
        requestAnimationFrame(() => {
          if (document.querySelector('#messages') === nextBox) nextBox.scrollTop = restoreScroll.top
        })
      } else {
        settleMessagesAtBottom(nextBox)
      }
    }
    // 权限 pill 直接按 state.permissionMode 渲染，这里不再需要回填文案。
    const prompt = document.querySelector('#prompt')
    if (prompt) {
      prompt.value = state.composerText
      // 菜单搜索框有焦点时也要恢复输入光标，否则 @ 替换会从位置 0 查找失败。
      const cursor = Number.isFinite(Number(state.composerCursor)) && state.composerCursor !== null
        ? Number(state.composerCursor)
        : Number.isFinite(restorePromptCursor) && restorePromptCursor !== null ? restorePromptCursor : prompt.value.length
      prompt.selectionStart = prompt.selectionEnd = Math.max(0, Math.min(cursor, prompt.value.length))
      if (restorePromptFocus) {
        prompt.focus({ preventScroll: true })
      }
    }
    bindImageReferenceEvents()
    // 完整重绘会生成全新的菜单节点，必须重新绑定，而不能只在输入 @ 时绑定。
    bindSkillEvents()
    document.querySelectorAll('[data-image-preview]').forEach((node) => node.addEventListener('click', (event) => {
      if (event.target.closest('[data-remove-attachment]')) return
      const image = imageCandidates().find((item) => item.id === node.dataset.imagePreview) || state.messages.flatMap((item) => item.attachments || []).find((item) => item.id === node.dataset.imagePreview)
      if (image) void showImagePreview(image)
    }))
    document.querySelectorAll('[data-image-close]').forEach((node) => node.addEventListener('click', (event) => { if (event.target === node || event.currentTarget === node) { state.imagePreview = null; renderApp() } }))
    scheduleBrowserBoundsSync()
  }

  function attachmentId() { return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
  // Codex 风格的全窗口拖放面板：挂在 body 上，避免被 renderApp 的整体重绘移除；指针事件关闭，
  // 拖放事件直接落到 window 上统一处理。
  function ensureDropOverlay() {
    let overlay = document.querySelector('.drop-overlay')
    if (overlay) return overlay
    overlay = document.createElement('div')
    overlay.className = 'drop-overlay'
    overlay.innerHTML = `<div class="drop-overlay-panel">
      <div class="drop-overlay-icon">🖼️</div>
      <div class="drop-overlay-title">松开鼠标，把图片拖进来</div>
      <div class="drop-overlay-hint">图片将作为参考图随下一条消息发送，也支持拖入代码和文档；单张不超过 12 MB</div>
    </div>`
    document.body.appendChild(overlay)
    return overlay
  }
  async function readAsDataUrl(file) {
    const MAX_EDGE = 2048
    const MAX_BYTES = 1.5 * 1024 * 1024
    if (file.size <= MAX_BYTES && !/image\/(?:tiff|bmp)/i.test(file.type || '')) return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(reader.error || new Error('无法读取图片')); reader.readAsDataURL(file) })
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.()
    return canvas.toDataURL('image/jpeg', 0.82)
  }
  async function addFiles(fileList, imageOnly = false) {
    const files = [...(fileList || [])]
    for (const file of files) {
      if (state.attachments.length >= 12) break
      const isImage = file.type.startsWith('image/')
      if (imageOnly && !isImage) continue
      if (isImage) {
        if (file.size > 12 * 1024 * 1024) { state.error = `${file.name} 超过 12 MB，未添加`; continue }
        try {
          const dataUrl = await readAsDataUrl(file)
          const data = dataUrl.split(',')[1] || ''
          if (data.length > 2 * 1024 * 1024) { state.error = `${file.name} 压缩后仍过大，未添加`; continue }
          state.attachments.push({ id: attachmentId(), kind: 'image', name: file.name, path: file.path || '', size: Math.floor(data.length * 0.75), mimeType: dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : (file.type || 'image/png'), dataUrl, data })
        } catch { state.error = `${file.name} 读取失败`; continue }
      } else {
        let text = ''
        const extension = String(file.name || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || ''
        const textLike = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.js', '.ts', '.py', '.sql', '.css'])
        const spreadsheet = new Set(['.xls', '.xlsx', '.xlsm', '.xltx', '.xltm', '.ods'])
        if (spreadsheet.has(extension)) {
          text = `[Excel 附件已添加：${file.name}。请使用 @通用 Excel 表格处理读取或分析，文件内容不会直接展开到对话中。]`
        } else if (textLike.has(extension) && file.size <= 512 * 1024) {
          try { text = await file.text() } catch { text = `[文本附件已添加：${file.name}]` }
        } else {
          text = `[二进制或大文件附件已添加：${file.name}，大小 ${formatBytes(file.size)}。请调用对应技能处理。]`
        }
        state.attachments.push({ id: attachmentId(), kind: 'file', name: file.name, path: file.path || '', size: file.size, mimeType: file.type || 'application/octet-stream', text })
      }
    }
  }
  function addFolder(fileList) {
    const files = [...(fileList || [])]
    if (!files.length || state.attachments.length >= 12) return
    const first = files[0]
    const relativePath = String(first.webkitRelativePath || '').replace(/\//g, '\\')
    const absolutePath = String(first.path || '')
    const folderPath = absolutePath && relativePath && absolutePath.toLowerCase().endsWith(relativePath.toLowerCase())
      ? absolutePath.slice(0, -relativePath.length).replace(/[\\/]$/, '')
      : ''
    const relativeRoot = relativePath.split(/[\\/]/)[0]
    const folderName = relativeRoot || String(first.name || '文件夹')
    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    state.attachments.push({
      id: attachmentId(), kind: 'file', isFolder: true, name: `${folderName}/`, path: folderPath,
      size: totalBytes, mimeType: 'application/x-directory',
      text: `[文件夹附件已添加：${folderName}，包含 ${files.length} 个文件，大小 ${formatBytes(totalBytes)}。目录：${folderPath || folderName}。请按需读取目录内容。]`
    })
  }
  function attachmentContext(attachments) {
    return attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => `\n\n--- 附件：${attachment.name} ---\n${attachment.text || '[附件已添加，请使用对应技能读取]'}\n--- 附件结束 ---`).join('')
  }
  function updateImageReferenceMenu() {
    const prompt = document.querySelector('#prompt')
    const menu = document.querySelector('#image-reference-menu')
    if (!prompt || !menu) return
    const token = mentionToken(prompt.value, prompt.selectionStart)
    const hasCandidates = imageCandidates().length > 0
    // 光标在 prompt 中时，@ 后的文字就是技能搜索词；搜索框本身编辑时保留独立筛选词。
    if (document.activeElement === prompt || !state.skillMenuOpen) state.skillMenuQuery = String(token?.query || '')
    const skillPrefix = String(state.skillMenuQuery || token?.query || '').trim()
    // @ 菜单是本地编辑器能力，不应依赖远端模型目录或另一条会话的运行状态。
    // 远端目录加载失败时仍显示内置/已安装 Skill，模型配置稍后再补齐。
    const skillCandidates = skillMenuEntries()
    const imageQueryMatches = Boolean(token?.query && hasCandidates && imageCandidates().some((item) => String(item.name || '').toLocaleLowerCase().includes(String(token.query).toLocaleLowerCase())))
    const nextSkillMenuOpen = Boolean(token && !imageQueryMatches)
    state.imageMenuOpen = Boolean(token && hasCandidates && (imageQueryMatches || !skillCandidates.length))
    if (nextSkillMenuOpen) state.imageMenuOpen = false
    if (nextSkillMenuOpen !== state.skillMenuOpen) {
      state.skillMenuOpen = nextSkillMenuOpen
      state.skillMenuActiveIndex = 0
      if (!nextSkillMenuOpen) state.skillMenuQuery = ''
      // 输入框事件发生在整壳重绘保护窗口内时，scheduleAppRender 会被延后，
      // 但菜单必须立即出现；直接更新当前 composer DOM，避免等下一帧或丢焦点。
      const composer = prompt.closest('.composer-box')
      const existingSkillMenu = composer?.querySelector('.skill-menu')
      if (nextSkillMenuOpen && composer && !existingSkillMenu) {
        const holder = document.createElement('div')
        holder.innerHTML = skillMenuMarkup()
        const nextMenu = holder.firstElementChild
        if (nextMenu) { composer.insertBefore(nextMenu, prompt); bindSkillEvents() }
      } else if (!nextSkillMenuOpen) {
        existingSkillMenu?.remove()
      }
      scheduleAppRender()
    }
    menu.classList.toggle('hidden', !state.imageMenuOpen)
    if (state.imageMenuOpen) menu.innerHTML = imageReferenceMarkup()
    const skillMenu = document.querySelector('.skill-menu')
    if (skillMenu && state.skillMenuOpen) skillMenu.outerHTML = skillMenuMarkup()
    else if (!state.skillMenuOpen) skillMenu?.remove()
    bindImageReferenceEvents()
    bindSkillEvents()
  }
  function bindImageReferenceEvents() {
    document.querySelectorAll('[data-image-reference]').forEach((node) => node.addEventListener('click', () => {
      const image = imageCandidates().find((item) => item.id === node.dataset.imageReference)
      const prompt = document.querySelector('#prompt')
      if (!image || !prompt) return
      if (!replaceMention(prompt, `@${image.name} `)) return
      if (!state.attachments.some((item) => item.id === image.id)) state.attachments.push(image)
      state.imageMenuOpen = false
      document.querySelector('#image-reference-menu')?.classList.add('hidden')
      prompt.focus(); prompt.selectionStart = prompt.selectionEnd = state.composerCursor
      renderApp()
    }))
  }
  function bindSkillEvents() {
    document.querySelectorAll('[data-skill-insert]').forEach((node) => {
      if (node.dataset.skillBound === '1') return
      node.dataset.skillBound = '1'
      node.addEventListener('click', () => {
        const entry = skillMenuEntries().find((item) => item.id === node.dataset.skillInsert)
        const skill = entry?.label?.replace(/^@/, '')
        const prompt = document.querySelector('#prompt'); if (!prompt) return
        if (!skill || !replaceMention(prompt, `@${skill} `)) return
        state.skillMenuOpen = false; state.skillMenuQuery = ''; state.skillMenuActiveIndex = 0; state.imageMenuOpen = false
        prompt.focus(); prompt.selectionStart = prompt.selectionEnd = state.composerCursor; renderApp()
      })
    })
    const search = document.querySelector('#skill-menu-search')
    if (!search || search.dataset.skillBound === '1') return
    search.dataset.skillBound = '1'
    search?.addEventListener('input', () => {
      state.skillMenuQuery = search.value || ''
      state.skillMenuActiveIndex = 0
      const active = document.activeElement === search
      const menu = document.querySelector('.skill-menu')
      if (menu) menu.outerHTML = skillMenuMarkup()
      bindSkillEvents()
      if (active) requestAnimationFrame(() => { const next = document.querySelector('#skill-menu-search'); next?.focus(); next.selectionStart = next.selectionEnd = next.value.length })
    })
    search?.addEventListener('keydown', (event) => {
      const entries = filteredSkillMenuEntries()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (entries.length) state.skillMenuActiveIndex = (state.skillMenuActiveIndex + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length
        const menu = document.querySelector('.skill-menu')
        if (menu) menu.outerHTML = skillMenuMarkup()
        bindSkillEvents()
        requestAnimationFrame(() => { const next = document.querySelector('#skill-menu-search'); next?.focus(); next.selectionStart = next.selectionEnd = next.value.length })
      } else if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        const entry = entries[state.skillMenuActiveIndex]
        document.querySelectorAll('[data-skill-insert]').forEach((node) => { if (node.dataset.skillInsert === entry?.id) node.click() })
      } else if (event.key === 'Escape') {
        event.preventDefault()
        state.skillMenuOpen = false; state.skillMenuQuery = ''; state.skillMenuActiveIndex = 0
        document.querySelector('.skill-menu')?.remove()
        document.querySelector('#prompt')?.focus()
      }
    })
  }

  function bindAppEvents() {
    const shell = document.querySelector('.app-shell')
    if (shell && shell.dataset.workspaceToggleDelegated !== '1') {
      shell.dataset.workspaceToggleDelegated = '1'
      shell.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-workspace-toggle]')
        if (!toggle || !shell.contains(toggle)) return
        event.preventDefault(); event.stopPropagation()
        const key = toggle.dataset.workspaceToggle || ''
        const items = toggle.parentElement?.querySelector('.session-workspace-items')
        const collapsing = !items?.hidden
        if (items) items.hidden = collapsing
        toggle.classList.toggle('is-collapsed', collapsing)
        toggle.parentElement?.classList.toggle('is-collapsed', collapsing)
        if (collapsing) collapsedWorkspaceGroups.add(key)
        else collapsedWorkspaceGroups.delete(key)
        persistCollapsedWorkspaces()
      })
    }
    document.querySelectorAll('[data-window-action]').forEach((node) => node.addEventListener('click', () => window.anyu.windowAction(node.dataset.windowAction)))
    document.querySelectorAll('[data-browser-close]').forEach((node) => node.addEventListener('click', () => { void window.anyu.browserClose() }))
    document.querySelectorAll('[data-browser-reload]').forEach((node) => node.addEventListener('click', () => { void window.anyu.browserReload() }))
    document.querySelectorAll('[data-browser-back]').forEach((node) => node.addEventListener('click', () => { void window.anyu.browserBack() }))
    document.querySelectorAll('[data-browser-forward]').forEach((node) => node.addEventListener('click', () => { void window.anyu.browserForward() }))
    document.querySelectorAll('[data-browser-external]').forEach((node) => node.addEventListener('click', () => { void window.anyu.openExternal(state.browser.url) }))
    // 模型菜单：打开时定位到当前选中的模型（居中），而不是从列表顶部开始翻找。
    // 只在"刚打开"时执行一次；搜索输入时不受影响，避免打断浏览。
    if (state.modelMenuOpen && state.modelMenuScrollToSelected) {
      state.modelMenuScrollToSelected = false
      requestAnimationFrame(() => {
        const selectedRow = document.querySelector('.model-model-list .model-option.selected')
        if (selectedRow) selectedRow.scrollIntoView({ block: 'center' })
      })
    }
    bindSkillEvents()
    document.querySelector('.topbar')?.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, select, input, textarea')) return
      window.anyu.windowAction('maximize')
    })
    document.querySelector('#group-picker')?.addEventListener('click', (event) => { event.stopPropagation(); state.groupMenuOpen = !state.groupMenuOpen; state.modelMenuOpen = false; state.permissionMenuOpen = false; state.thinkingMenuOpen = false; state.groupMenuQuery = ''; renderApp() })
    document.querySelector('#group-search')?.addEventListener('input', (event) => { state.groupMenuQuery = event.target.value || ''; renderApp(); requestAnimationFrame(() => { const input = document.querySelector('#group-search'); if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length } }) })
    document.querySelectorAll('[data-group-pool]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); state.groupPoolTab = node.dataset.groupPool || 'stable'; state.groupProviderFilter = 'all'; localStorage.setItem('anyu.groupPoolTab', state.groupPoolTab); renderApp() }))
    document.querySelectorAll('[data-group-provider]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); state.groupProviderFilter = node.dataset.groupProvider || 'all'; renderApp() }))
    document.querySelectorAll('[data-catalog-group]').forEach((node) => node.addEventListener('click', () => { void activateGroup(node.dataset.catalogGroup) }))
    document.querySelector('#model-picker')?.addEventListener('click', () => {
      state.modelMenuOpen = !state.modelMenuOpen
      state.groupMenuOpen = false; state.permissionMenuOpen = false; state.thinkingMenuOpen = false; state.modelMenuQuery = ''
      // 菜单打开时不要从头浏览：标记"滚动到当前选中模型"，渲染完成后由 bindAppEvents 定位。
      state.modelMenuScrollToSelected = state.modelMenuOpen
      renderApp()
    })
    document.querySelector('#model-menu-back')?.addEventListener('click', (event) => { event.stopPropagation(); state.modelMenuGroupId = ''; state.modelMenuQuery = ''; renderApp() })
    document.querySelectorAll('[data-model-group]').forEach((node) => node.addEventListener('click', () => { state.modelMenuGroupId = node.dataset.modelGroup || ''; state.modelMenuQuery = ''; renderApp() }))
    document.querySelector('#model-search')?.addEventListener('input', (event) => { state.modelMenuQuery = event.target.value || ''; renderApp(); requestAnimationFrame(() => { const input = document.querySelector('#model-search'); if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length } }) })
    document.querySelectorAll('[data-model-id]').forEach((node) => node.addEventListener('click', () => { void activateModel(node.dataset.modelId) }))
    document.querySelectorAll('.session').forEach((node) => node.addEventListener('click', () => switchSession(node.dataset.path)))
    bindMessageEvents(document.querySelector('#messages') || document)
    // 思考强度 pill：先关闭菜单再落库，档位按模型分别保存。
    document.querySelectorAll('[data-thinking-level]').forEach((node) => node.addEventListener('click', async () => {
      const level = String(node.dataset.thinkingLevel || 'off')
      state.thinkingMenuOpen = false
      if (!state.thinkingLevels.includes(level)) { renderApp(); return }
      state.thinkingLevel = level
      localStorage.setItem(thinkingStorageKey(), level)
      // 关键：先重绘（菜单立刻关闭、档位立即生效显示），再把档位同步给 Pi。
      // 以前这里 await 无超时的 piCommand，Pi 对某些模型（尤其国模）不回应时
      // 回调永远挂起——菜单关不掉、界面不刷新，看起来就是"推理强度卡死"。
      renderApp()
      if (!state.loading) {
        try { await piRequestWithTimeout({ type: 'set_thinking_level', sessionKey: state.sessionPath, level }, MODEL_SWITCH_TIMEOUT_MS) } catch { /* 本地档位仍对下一条消息生效 */ }
      }
    }))
    document.querySelector('#thinking-picker')?.addEventListener('click', (event) => {
      event.stopPropagation()
      state.thinkingMenuOpen = !state.thinkingMenuOpen
      state.permissionMenuOpen = false
      renderApp()
    })
    // 权限 pill：只切换 Pi 的启动参数，不重启应用。
    document.querySelector('#permission-picker')?.addEventListener('click', (event) => {
      event.stopPropagation()
      state.permissionMenuOpen = !state.permissionMenuOpen
      state.thinkingMenuOpen = false
      renderApp()
    })
    document.querySelector('#request-elevation')?.addEventListener('click', (event) => { event.stopPropagation(); void requestElevation() })
    document.querySelector('#request-privacy-settings')?.addEventListener('click', async () => { state.permissionMenuOpen = false; await window.anyu.openSystemPrivacySettings?.('fullDiskAccess'); renderApp() })
    document.querySelector('#settings-logout')?.addEventListener('click', switchAccount)
    document.querySelector('#settings-open')?.addEventListener('click', () => { state.settingsOpen = true; state.settingsSection = 'general'; renderApp() })
    document.querySelector('#update-app')?.addEventListener('click', async () => {
      if (['checking', 'downloading', 'installing'].includes(state.update.status)) return
      if (state.update.status === 'ready') {
        try { await window.anyu.openUpdateInstaller?.() } catch (error) { state.update = { ...state.update, status: 'error', message: errorText(error) || '打开更新安装包失败' }; updateUpdateControl(); scheduleAppRender() }
        return
      }
      state.update = { ...state.update, status: 'checking', message: '', percent: 0 }
      updateUpdateControl()
      try {
        const info = await window.anyu.checkForUpdate()
        state.update = { ...state.update, ...info, status: info.available ? 'available' : 'latest', percent: 0 }
        updateUpdateControl()
        if (!info.available) return
        const result = await window.anyu.downloadAndInstallUpdate()
        state.update = { ...state.update, ...result, status: result.status || 'ready' }
        updateUpdateControl()
      } catch (error) {
        state.update = { ...state.update, status: 'error', message: errorText(error) || '自动更新失败' }
        state.error = state.update.message
        updateUpdateControl()
        scheduleAppRender()
      }
    })
     const leaveSettings = () => { state.settingsOpen = false; state.pluginPublishOpen = false; renderApp() }
     document.querySelector('#settings-back')?.addEventListener('click', leaveSettings)
     document.querySelector('#settings-close')?.addEventListener('click', leaveSettings)
     document.querySelector('#settings-done')?.addEventListener('click', leaveSettings)
    document.querySelectorAll('[data-settings-section]').forEach((node) => node.addEventListener('click', async () => {
      const section = ['general', 'appearance', 'skills', 'plugins'].includes(node.dataset.settingsSection) ? node.dataset.settingsSection : 'general'
      state.settingsSection = section
      state.pluginPublishOpen = false
      if (section === 'skills') state.skillsLoading = true
      renderApp()
      if (section === 'skills') {
        await loadSkillGroups({ silent: false })
        state.skillsLoading = false
        renderApp()
      }
      else if (section === 'plugins') await loadPluginMarket()
    }))
    document.querySelectorAll('[data-appearance-theme]').forEach((node) => node.addEventListener('click', () => {
      state.appearanceTheme = persistAppearanceTheme(node.dataset.appearanceTheme)
      renderApp()
    }))
    document.querySelectorAll('[data-plugin-tab]').forEach((node) => node.addEventListener('click', () => {
      state.pluginMarketTab = node.dataset.pluginTab || 'marketplace'
      renderApp()
    }))
    document.querySelectorAll('[data-plugin-category]').forEach((node) => node.addEventListener('click', () => {
      state.pluginMarketCategory = node.dataset.pluginCategory || 'all'
      renderApp()
    }))
    document.querySelector('#plugin-search')?.addEventListener('input', (event) => {
      state.pluginMarketQuery = event.target.value || ''
      scheduleAppRender()
    })
    document.querySelector('#plugin-import')?.addEventListener('click', () => { void importPluginPackage() })
    document.querySelector('#plugin-import-empty')?.addEventListener('click', () => { void importPluginPackage() })
    document.querySelector('#plugin-publish-close')?.addEventListener('click', () => { state.pluginPublishOpen = false; renderApp() })
    document.querySelector('#plugin-publish-cancel')?.addEventListener('click', () => { state.pluginPublishOpen = false; renderApp() })
    document.querySelector('#plugin-publisher-name')?.addEventListener('input', (event) => { state.pluginPublishName = event.target.value || '' })
    document.querySelector('#plugin-publish-visibility')?.addEventListener('change', (event) => { state.pluginPublishVisibility = event.target.value === 'private' ? 'private' : 'public' })
    document.querySelector('#plugin-publish-submit')?.addEventListener('click', () => { void publishPlugin() })
    document.querySelectorAll('[data-plugin-action]').forEach((node) => node.addEventListener('click', () => {
      void handlePluginAction(node.dataset.pluginAction, node.dataset.pluginId, node.dataset.pluginVersion || '')
    }))
    document.querySelector('#skills-refresh')?.addEventListener('click', async () => { state.skillsLoading = true; renderApp(); await loadSkillGroups({ silent: false }); state.skillsLoading = false; renderApp() })
    document.querySelectorAll('[data-skill-toggle]').forEach((node) => node.addEventListener('click', () => { const kind = node.dataset.skillToggle; if (kind === 'image' || kind === 'video') state.skillEnabled[kind] = !state.skillEnabled[kind]; renderApp() }))
    document.querySelector('#skill-image-group')?.addEventListener('change', (event) => { state.skillConfigs.image.groupId = Number(event.target.value); ensureSkillSelection(); renderApp() })
    document.querySelector('#skill-image-model')?.addEventListener('change', (event) => { state.skillConfigs.image.model = event.target.value; renderApp() })
    document.querySelector('#skill-video-group')?.addEventListener('change', (event) => { state.skillConfigs.video.groupId = Number(event.target.value); ensureSkillSelection(); renderApp() })
    document.querySelector('#skill-video-model')?.addEventListener('change', (event) => { state.skillConfigs.video.model = event.target.value; renderApp() })
    document.querySelectorAll('[data-permission-mode]').forEach((node) => node.addEventListener('click', () => { void choosePermissionMode(node.dataset.permissionMode) }))
    // 设置页的提权按钮与输入栏走同一个入口，避免两处行为不一致。
    document.querySelector('#request-system-elevation')?.addEventListener('click', () => { void requestElevation() })
    document.querySelector('#elevation-notice-close')?.addEventListener('click', () => { state.elevationNotice = ''; renderApp() })
    document.querySelector('#open-privacy-settings')?.addEventListener('click', async () => { const result = await window.anyu.openSystemPrivacySettings?.('fullDiskAccess'); if (result?.state) state.systemAccess = result.state; renderApp() })
    document.querySelector('#open-accessibility-settings')?.addEventListener('click', async () => { const result = await window.anyu.openSystemPrivacySettings?.('accessibility'); if (result?.state) state.systemAccess = result.state; renderApp() })
    document.querySelector('#settings-cwd')?.addEventListener('click', async () => { if (state.loading) { state.error = '当前任务完成后再切换工作目录'; renderApp(); return }; const directory = await window.anyu.chooseDirectory(); if (!directory) return; state.sessionCwd = null; state.cwd = directory; localStorage.setItem('anyu.cwd', directory); try { if (state.sessionPath && window.anyu.piMaterializeSession) await window.anyu.piMaterializeSession({ sessionPath: state.sessionPath, cwd: directory }); await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '工作目录切换失败' }; renderApp() })
    document.querySelector('#refresh')?.addEventListener('click', async () => { if (state.loading) { state.error = '当前任务完成后再刷新 Agent'; renderApp(); return }; state.error = ''; try { await loadRouteData(); chooseModel(); await startAgent(state.sessionPath) } catch (error) { state.error = errorText(error) || '刷新失败' }; renderApp() })
    document.querySelector('#choose-cwd')?.addEventListener('click', async () => { if (state.loading) { state.error = '当前任务完成后再切换工作目录'; renderApp(); return }; const directory = await window.anyu.chooseDirectory(); if (!directory) return; state.sessionCwd = null; state.cwd = directory; localStorage.setItem('anyu.cwd', directory); try { if (state.sessionPath && window.anyu.piMaterializeSession) await window.anyu.piMaterializeSession({ sessionPath: state.sessionPath, cwd: directory }); await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '工作目录切换失败' }; renderApp() })
    document.querySelector('#new-chat')?.addEventListener('click', newConversation)
    document.querySelector('#attach-trigger')?.addEventListener('click', (event) => { event.stopPropagation(); document.querySelector('#attachment-menu')?.classList.toggle('hidden') })
    document.querySelector('#attach-files')?.addEventListener('click', () => { document.querySelector('#attachment-menu')?.classList.add('hidden'); document.querySelector('#file-input')?.click() })
    document.querySelector('#attach-folder')?.addEventListener('click', () => { document.querySelector('#attachment-menu')?.classList.add('hidden'); document.querySelector('#folder-input')?.click() })
    document.querySelector('#attach-images')?.addEventListener('click', () => { document.querySelector('#image-input')?.click() })
    document.querySelector('#file-input')?.addEventListener('change', async (event) => { await addFiles(event.target.files); event.target.value = ''; renderApp() })
    document.querySelector('#image-input')?.addEventListener('change', async (event) => { await addFiles(event.target.files, true); event.target.value = ''; renderApp() })
    document.querySelector('#folder-input')?.addEventListener('change', (event) => { addFolder(event.target.files); event.target.value = ''; renderApp() })
    document.querySelector('.app-shell')?.addEventListener('click', (event) => {
      const menu = document.querySelector('#attachment-menu')
      if (menu && !event.target.closest('#attachment-menu, #attach-trigger')) menu.classList.add('hidden')
    })
    document.querySelectorAll('[data-remove-attachment]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); state.attachments = state.attachments.filter((attachment) => attachment.id !== node.dataset.removeAttachment); renderApp() }))
    document.querySelectorAll('[data-download-image]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation()
      const attachment = imageCandidates().find((item) => item.id === node.dataset.downloadImage) || state.messages.flatMap((item) => item.attachments || []).find((item) => item.id === node.dataset.downloadImage)
      void downloadMedia(attachment, 'image')
    }))
    document.querySelectorAll('[data-download-video]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation()
      const message = state.messages.find((item) => String(item.id || '') === String(node.dataset.downloadVideo || ''))
      if (message?.media) void downloadMedia(message.media, 'video')
    }))
    document.querySelector('[data-queue-clear]')?.addEventListener('click', clearQueuedTasks)
    document.querySelectorAll('[data-queue-menu]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); state.queueMenuId = state.queueMenuId === node.dataset.queueMenu ? null : node.dataset.queueMenu; renderApp() }))
    document.querySelectorAll('[data-queue-steer]').forEach((node) => node.addEventListener('click', () => { void steerQueuedTask(node.dataset.queueSteer) }))
    document.querySelectorAll('[data-queue-remove]').forEach((node) => node.addEventListener('click', () => removeQueuedTask(node.dataset.queueRemove)))
    document.querySelectorAll('[data-queue-edit]').forEach((node) => node.addEventListener('click', () => editQueuedTask(node.dataset.queueEdit)))
    document.querySelectorAll('[data-queue-open]').forEach((node) => node.addEventListener('click', () => openQueuedTask(node.dataset.queueOpen)))
    document.querySelectorAll('[data-queue-close]').forEach((node) => node.addEventListener('click', () => removeQueuedTask(node.dataset.queueClose)))
    // 全窗口拖放（对齐 Codex 体验）：把文件或图片拖到窗口任意位置都会出现大区域投放面板，
    // 松手后统一走 addFiles。注意事件会冒泡，旧的 composer 局部监听必须移除，否则会重复添加附件。
    // 关键：window 是持久对象，不会随 renderApp 的 innerHTML 重建而销毁；
    // 若每次 bindAppEvents 都重新注册，拖一张图会被 N 个 drop 监听各处理一次
    // （一张变多张，且 N 次 render 又追加 4N 个监听器，指数级卡死）。
    // 因此全局拖放监听整个会话只注册一次，overlay 每次动态获取（ensureDropOverlay 挂在 body 下，跨 render 存活）。
    if (!window.__anyuGlobalDropBound) {
      window.__anyuGlobalDropBound = true
      let dragDepth = 0
      const dragHasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files')
      const showDropOverlay = (visible) => ensureDropOverlay().classList.toggle('active', Boolean(visible))
      const resetDrag = () => { dragDepth = 0; showDropOverlay(false) }
      window.addEventListener('dragenter', (event) => {
        if (!dragHasFiles(event)) return
        event.preventDefault()
        dragDepth += 1
        showDropOverlay(true)
      })
      window.addEventListener('dragover', (event) => {
        if (!dragHasFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      })
      window.addEventListener('dragleave', (event) => {
        if (!dragHasFiles(event)) return
        dragDepth = Math.max(0, dragDepth - 1)
        if (!dragDepth) resetDrag()
      })
      window.addEventListener('drop', async (event) => {
        if (!dragHasFiles(event)) return
        event.preventDefault()
        resetDrag()
        await addFiles(event.dataTransfer?.files)
        renderApp()
      })
      window.addEventListener('dragend', resetDrag)
      window.addEventListener('blur', resetDrag)
    }
    const prompt = document.querySelector('#prompt')
    prompt?.addEventListener('input', () => { state.composerText = prompt.value; state.composerCursor = prompt.selectionStart; state.promptInteractionAt = Date.now(); updateImageReferenceMenu() })
    prompt?.addEventListener('click', () => { state.composerCursor = prompt.selectionStart; state.promptInteractionAt = Date.now(); updateImageReferenceMenu() })
    prompt?.addEventListener('focus', () => { state.promptInteractionAt = Date.now() })
    prompt?.addEventListener('pointerdown', () => { state.promptInteractionAt = Date.now() })
    prompt?.addEventListener('keyup', () => { state.composerCursor = prompt.selectionStart; state.promptInteractionAt = Date.now(); updateImageReferenceMenu() })
    prompt?.addEventListener('keydown', (event) => {
      if (state.skillMenuOpen && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault()
        const count = filteredSkillMenuEntries().length
        if (count) state.skillMenuActiveIndex = (state.skillMenuActiveIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
        const menu = document.querySelector('.skill-menu')
        if (menu) menu.outerHTML = skillMenuMarkup()
        bindSkillEvents()
        return
      }
      if (state.skillMenuOpen && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const entry = filteredSkillMenuEntries()[state.skillMenuActiveIndex]
        document.querySelectorAll('[data-skill-insert]').forEach((node) => { if (node.dataset.skillInsert === entry?.id) node.click() })
        return
      }
      if (event.key === 'Escape' && state.skillMenuOpen) { event.preventDefault(); state.skillMenuOpen = false; state.skillMenuQuery = ''; state.skillMenuActiveIndex = 0; document.querySelector('.skill-menu')?.remove(); return }
      if (event.key === 'Escape' && state.imageMenuOpen) { event.preventDefault(); state.imageMenuOpen = false; document.querySelector('#image-reference-menu')?.classList.add('hidden'); return }
      if (event.key === 'Escape' && state.loading) { event.preventDefault(); abortRun(); return }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage() }
    })
    prompt?.addEventListener('paste', async (event) => {
      const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'))
      if (!files.length) return
       event.preventDefault(); await addFiles(files, true); renderApp()
    })
    document.querySelector('#send')?.addEventListener('click', () => { if (state.loading) abortRun(); else sendMessage() })
    document.querySelector('#permission-allow')?.addEventListener('click', () => answerPermission({ confirmed: true })); document.querySelector('#permission-deny')?.addEventListener('click', () => answerPermission({ confirmed: false })); document.querySelector('#permission-submit')?.addEventListener('click', () => answerPermission({ value: document.querySelector('#permission-input')?.value || '' })); document.querySelectorAll('[data-option]').forEach((node) => node.addEventListener('click', () => answerPermission({ value: state.permission.options[Number(node.dataset.option)] })))
  }
  function clearQueuedTasks() {
    for (const task of state.queuedTasks) removeTimelineMessageById(task.id)
    state.queuedTasks = []
    state.queueMenuId = null
    renderApp()
  }
  function removeQueuedTask(id) {
    state.queuedTasks = state.queuedTasks.filter((task) => task.id !== id)
    removeTimelineMessageById(id)
    if (state.queueMenuId === id) state.queueMenuId = null
    renderApp()
  }
  function loadTaskIntoComposer(task) {
    state.attachments = [...(task.attachments || [])]
    state.composerText = task.content || ''
    state.queueMenuId = null
    renderApp()
    requestAnimationFrame(() => {
      const prompt = document.querySelector('#prompt')
      if (!prompt) return
       prompt.value = state.composerText
      prompt.focus()
      prompt.selectionStart = prompt.selectionEnd = prompt.value.length
    })
  }
  function editQueuedTask(id) {
    const task = state.queuedTasks.find((item) => item.id === id)
    if (!task) return
    state.queuedTasks = state.queuedTasks.filter((item) => item.id !== id)
    loadTaskIntoComposer(task)
  }
  function openQueuedTask(id) {
    const task = state.queuedTasks.find((item) => item.id === id)
    if (!task) return
    state.queuedTasks = state.queuedTasks.filter((item) => item.id !== id)
    loadTaskIntoComposer(task)
  }
  async function steerQueuedTask(id) {
    const index = state.queuedTasks.findIndex((task) => task.id === id)
    if (index < 0) return
    const task = state.queuedTasks[index]
    state.queuedTasks.splice(index, 1)
    removeTimelineMessageById(task.id)
    state.queueMenuId = null
    if (!state.loading) {
      await runTask(task)
      return
    }
    const payload = taskPayload(task)
    if (mediaSkillForPrompt(task.content)) {
      state.queuedTasks.splice(index, 0, task)
      state.error = '媒体技能正在执行，完成后可调整方向到对话模型'
      renderApp()
      return
    }
    insertTimelineMessage({ id: task.id, role: 'user', content: payload.content, attachments: payload.attachments, createdAt: Number(task.createdAt || Date.now()) })
    state.error = ''
    renderApp()
    try {
      await persistImageAttachments(payload, payload.content + payload.attachmentText)
      await window.anyu.piCommand({ type: 'steer', sessionKey: state.sessionPath, message: payload.content + payload.attachmentText, images: payload.images.length ? payload.images : undefined })
    } catch (error) {
      state.queuedTasks.splice(Math.min(index, state.queuedTasks.length), 0, task)
      const localMessageIndex = state.messages.findIndex((message) => message.role === 'user' && message.content === payload.content && message.attachments === payload.attachments)
      if (localMessageIndex >= 0) state.messages.splice(localMessageIndex, 1)
      state.error = errorText(error) || '调整方向失败'
      renderApp()
    }
  }
  async function answerPermission(answer) { if (!state.permission) return; const request = state.permission; state.permission = null; renderApp(); await window.anyu.piUiResponse({ id: request.id, sessionKey: state.sessionPath, ...answer }) }
  function stopRunMonitor() {
    if (state.runPoll) window.clearInterval(state.runPoll)
    state.runPoll = null
  }
  function clearActiveRequest() {
    stopRunMonitor()
    state.activeRequest = null; state.retryNotice = ''; state.runInProgress = false
  }
  async function reconcileRunState() {
    if (!state.loading) return
    try {
      const result = await window.anyu.piCommand({ type: 'get_state', sessionKey: state.sessionPath })
      const piState = result?.data || null
      state.piState = piState || state.piState
      // 轮询只同步观察状态，不能把瞬时的 isStreaming=false 当成任务结束。
      // 任务生命周期必须由 Pi 的明确结束事件驱动，避免长输出被客户端截断。
      if (piState?.isStreaming === true) state.runInProgress = true
    } catch {
      // The main process reports process exits separately. A transient state read
      // must not interrupt an active local run.
    }
  }
  function startRunMonitor() {
    stopRunMonitor()
    state.runPoll = window.setInterval(() => { void reconcileRunState(); scheduleLiveUi(false) }, 1500)
  }
  function finishAgentRun() {
    if (!state.loading && !state.activeRequest) return
    const finishedSessionPath = state.sessionPath
    clearActiveRequest()
    state.loading = false
    // 任务正常收尾：当前会话正在被看，不算未读。
    markSessionRun(finishedSessionPath, { running: false, unread: false })
    if (state.sessionLoadingPath === finishedSessionPath) state.sessionLoadingPath = null
    for (const message of state.messages) if (message.isStreaming) finishStreamingMessage(message)
    // Flush the terminal state immediately. A queued animation frame may have
    // already rendered the previous loading state, so coalescing another frame
    // here could leave the stop button and activity indicator stale.
    state.renderQueued = false
    updateLiveUi(false)
    Promise.all([refreshMessages(), refreshSessions()]).then(() => { scheduleSessionListRender(); scheduleAppRender(); scheduleQueueDrain() }).catch(() => { scheduleSessionListRender(); scheduleAppRender(); scheduleQueueDrain() })
  }
  function finishRequestWithError(error, fallback = '发送失败，请稍后重试') {
    const failedSessionPath = state.sessionPath
    const detail = errorText(error)
    clearActiveRequest(); state.loading = false; if (state.sessionLoadingPath === failedSessionPath) state.sessionLoadingPath = null; state.error = detail || fallback
    markSessionRun(failedSessionPath, { running: false, unread: true })
    scheduleSessionListRender()
    for (const message of state.messages) if (message.isStreaming) finishStreamingMessage(message)
    scheduleAppRender(); scheduleQueueDrain()
  }
  async function abortRun() {
    if (!state.loading) return
    const abortedSessionPath = state.sessionPath
    clearActiveRequest(); state.loading = false; if (state.sessionLoadingPath === abortedSessionPath) state.sessionLoadingPath = null; state.error = '已停止当前任务'
    markSessionRun(abortedSessionPath, { running: false, unread: false })
    scheduleSessionListRender()
    for (const message of state.messages) if (message.isStreaming) finishStreamingMessage(message)
    scheduleLiveUi(false)
    try { await window.anyu.piCommand({ type: 'abort', sessionKey: abortedSessionPath }) } catch (error) { state.error = error.message || '停止任务失败' }
    scheduleAppRender()
  }
  function scheduleQueueDrain() {
    // 排队任务只属于它所在的会话：记录归属，用户切走后这里不再跨会话执行，
    // 等用户回到该会话（switchSession 会再触发一次 drain）才继续消耗队列。
    if (state.queueDraining || state.loading || state.skillBusy) return
    const owner = state.sessionPath
    if (!state.queuedTasks.length) return
    state.queueDraining = true
    scheduleAppRender()
    window.setTimeout(async () => {
      state.queueDraining = false
      if (state.sessionPath !== owner) return
      if (state.loading || state.skillBusy || !state.queuedTasks.length) return
      const task = state.queuedTasks.shift()
      state.queueMenuId = null
      await runTask(task)
    }, 0)
  }
  async function newConversation() {
    // 新建对话只停掉当前会话的进程，其它会话的后台任务继续跑。
    // 新建对话不再杀掉上一个会话的进程：它的任务继续在后台跑，
    // 完成后在左侧列表标记“已完成未读”，这就是多会话并行。
    const previousPath = state.sessionPath
    if (previousPath) markSessionRun(previousPath, { running: Boolean(state.loading || state.runInProgress || state.activeRequest), unread: false })
    clearActiveRequest(); state.loading = false; state.queueMenuId = null; state.queueDraining = false
    state.streamingMessage = null
    state.sessionPath = null; state.piState = null; state.sessionCwd = null; state.cwd = localStorage.getItem('anyu.cwd') || ''; state.messages = []; state.imageLibrary = []; state.error = ''
    // 清除旧菜单的筛选与选中状态，保留草稿并基于新输入框重新计算 @ 菜单。
    state.skillMenuOpen = false; state.skillMenuQuery = ''; state.skillMenuActiveIndex = 0; state.imageMenuOpen = false
    state.composerCursor = String(state.composerText || '').length
    // 新会话必须瞬时呈现：以前在这里 await startAgent(null)，等于让用户盯着旧界面
    // 等完 Pi 子进程整个冷启动（spawn + 浏览器桥 + get_state，1~2 秒以上）。
    // 现在先画空会话，进程转后台拉起；用户立刻就能打字，第一条消息发出时
    // runTask 会汇入同一个启动入口等待，不会出现双进程。
    state.pendingNewAgent = true
    scheduleSessionListRender()
    renderApp()
    updateImageReferenceMenu()
    ensureAgentStarted().catch(() => { /* 失败已写入 state.error 并渲染 */ })
  }
  function feedbackArtifactFiles(result, url) {
    const payload = businessPayload(result)
    const reviews = businessRows(payload, ['reviews', 'reviewList', 'review_list', 'items', 'data'])
    const questions = businessRows(payload, ['questions', 'questionList', 'question_list', 'qa', 'askEveryone'])
    const reviewColumns = [
      { key: 'content', label: '评价内容' }, { key: 'merchantReply', label: '商家回复' }, { key: 'user', label: '用户' },
      { key: 'date', label: '时间' }, { key: 'sku', label: '规格' }
    ]
    const questionColumns = [{ key: 'question', label: '问题' }, { key: 'answer', label: '回答' }, { key: 'time', label: '时间' }]
    const { analysisHtml, ...rawResult } = payload
    return [
      ...(analysisHtml ? [{ name: 'tmall-feedback-report.html', content: analysisHtml }] : []),
      { name: 'tmall-feedback.json', content: businessSecretSafeJson({ url, collectedAt: payload.collectedAt || new Date().toISOString(), reviews, questions, result: rawResult }) },
      { name: 'tmall-feedback.csv', content: businessCsv(reviews, reviewColumns) }
    ]
  }

  function feedbackCoverage(coverage) {
    if (!coverage || typeof coverage !== 'object') return String(coverage || '仅包含当前公开界面可读取的数据')
    const reviews = coverage.reviews || {}, questions = coverage.questions || {}
    return `公开页面评价 ${reviews.visibleCollected || 0} 条，平台标示 ${reviews.platformLabel || '未知'}，折叠 ${reviews.platformFolded || 0} 条；问大家 ${questions.visibleCollected || 0}/${questions.platformTotal ?? '未知'}。${reviews.limitation || ''}`
  }

  // 重试只读取已保存的本机采集任务，不再次抓取商品页面。
  async function finishFeedbackAnalysis(message, sessionPath) {
    message.businessStatus = 'ANALYZING'; message.businessPhase = '分析中'; message.businessProgress = '正在结合评价与问大家分析…'; message.content = '采集完成，正在结合评价与问大家分析…'
    message.isError = false; message.feedbackRetry = false
    await persistBusinessMessage(sessionPath, message)
    let preview = ''
    const stopProgress = window.anyu.onLetaAgentFeedbackAnalysisProgress?.((progress) => {
      if (progress?.taskId !== message.feedbackTaskId || !message.businessPending) return
      preview = String(progress.text || '').slice(0, 12000)
      if (progress.stage === 'report') {
        message.businessPhase = '生成报告'
        message.businessProgress = preview || '正在整理完整可视化报告…'
      } else {
        message.businessProgress = '正在分析采集结果…'
        if (preview) message.content = preview
      }
      // 进度回调每秒好几次：内存里的消息立刻更新（界面才有动画），
      // 落盘走节流补写，避免整条时间线被反复序列化写盘把界面拖卡。
      updateBusinessMessage(sessionPath, message)
      scheduleMediaTimelinePersist(sessionPath)
      if (state.sessionPath === sessionPath) scheduleLiveUi(false)
    })
    try {
      const analysis = await window.anyu.letaAgentFeedbackAnalysisStarted(message.feedbackTaskId, message.feedbackPrompt)
      const files = await writeBusinessArtifacts(message.artifactCwd, feedbackArtifactFiles(analysis, message.feedbackUrl))
      const reviews = businessRows(analysis, ['reviews']), questions = businessRows(analysis, ['questions'])
      message.businessPending = false; message.businessPhase = '已完成'; message.businessStatus = 'OK'; message.businessProgress = '报告已生成，已打开右侧预览。'
      message.businessResult = { reviewCount: reviews.length, questionCount: questions.length, coverage: feedbackCoverage(analysis.coverage) }
      message.artifacts = files
      message.content = `${analysis.analysisSummary || preview || '分析完成。'}\n\n可在右侧查看完整可视化报告。${analysis.analysisCompatibilityFallback ? '\n报告已使用兼容排版生成。' : ''}`
      await persistBusinessMessage(sessionPath, message)
      await openBusinessArtifact(files.find((file) => /\.html?$/i.test(String(file?.name || ''))), message.artifactCwd)
    } finally { stopProgress?.() }
  }

  async function retryFeedbackAnalysis(message) {
    if (state.loading || state.skillBusy || !businessPlugin('feedback')) return
    const sessionPath = state.sessionPath || '__pending__'
    const retryActivityId = message.feedbackTaskId || message.id
    beginMediaActivity(sessionPath, retryActivityId, 'feedback')
    state.skillBusy = 'feedback'; state.sessionLoadingPath = state.sessionPath || null; message.businessPending = true; message.businessProgress = '正在重新生成可视化报告…'
    try {
      await ensureMediaSession()
      // 原始数据已经由主进程保存；重试只导出文件并分析，不再次导航或采集。
      const collected = await window.anyu.letaAgentFeedbackStatus(message.feedbackTaskId)
      if (businessStatus(collected) !== 'OK') throw new Error('本机采集尚未完成，请重新运行评价分析')
      message.artifacts = await writeBusinessArtifacts(message.artifactCwd, feedbackArtifactFiles(collected, message.feedbackUrl))
      await persistBusinessMessage(sessionPath, message)
      await finishFeedbackAnalysis(message, sessionPath)
    } catch (error) {
      const analysisText = message.businessPhase === '生成报告' ? String(message.content || '').trim() : ''
      message.businessPending = false; message.businessPhase = '分析失败'; message.businessStatus = 'FAILED'; message.businessProgress = '本次分析未完成，可再次重试。'; message.isError = true; message.feedbackRetry = true
      message.content = `${analysisText ? `${analysisText}\n\n` : ''}原始采集已保留，可重试分析。${errorText(error)}`
      await persistBusinessMessage(sessionPath, message)
    } finally { endMediaActivity(sessionPath, retryActivityId); setSessionSkill(sessionPath, null); if (state.sessionLoadingPath === sessionPath) state.sessionLoadingPath = null; scheduleSessionListRender(); scheduleQueueDrain() }
  }

  async function runShopMonitorSkillLegacy(task) {
    const promptText = businessPrompt(task.content, 'shop-monitor')
    const url = String(promptText || task.content || '').match(/https:\/\/(?:[^\s/]+\.)?(?:taobao\.com|tmall\.com)\/[^\s]+/i)?.[0] || ''
    const pendingKey = state.sessionPath || '__pending__'
    let sessionPath = pendingKey
    const userMessage = { id: task.id, role: 'user', content: task.content, createdAt: Number(task.createdAt || Date.now()) }
    const resultMessage = { id: `${task.id}:result`, role: 'assistant', content: '正在启动店铺商品采集…', createdAt: userMessage.createdAt + 0.5, businessSkill: 'shop-monitor', businessPending: true, businessPhase: '准备中', businessStatus: 'SUBMITTED', businessProgress: '正在打开店铺页面并提取商品链接…' }
    insertTimelineMessage(userMessage); upsertMediaTimelineMessage(sessionPath, userMessage)
    insertTimelineMessage(resultMessage); upsertMediaTimelineMessage(sessionPath, resultMessage)
    state.skillBusy = 'shop-monitor'; renderApp(); updateLiveUi(true)
    try {
      if (!url) throw new Error('请在 @店铺分析 后提供淘宝或天猫店铺链接')
      await openBusinessUrl(url)
      await ensureMediaSession(); sessionPath = state.sessionPath
      const created = await window.anyu.letaAgentShopMonitorCollect({ url, maxRounds: 120 })
      const taskId = businessTaskId(created)
      let payload = created
      if (taskId) {
        const started = Date.now()
        while (Date.now() - started < 10 * 60 * 1000) {
          payload = await window.anyu.letaAgentShopMonitorStatus(taskId)
          const status = businessStatus(payload)
          resultMessage.businessStatus = status
          resultMessage.businessPhase = status === 'COLLECTING' ? '采集中' : ['WAITING_LOGIN', 'CHALLENGE_REQUIRED'].includes(status) ? '等待浏览器操作' : '处理中'
          resultMessage.businessProgress = status === 'COLLECTING' ? `正在滚动店铺页面，已发现 ${businessPayload(payload).products?.length || 0} 个商品` : status === 'WAITING_LOGIN' ? '请在右侧浏览器完成登录后继续' : status === 'CHALLENGE_REQUIRED' ? '请在右侧浏览器完成安全验证后继续' : '正在等待采集结果…'
          await persistBusinessMessage(sessionPath, resultMessage)
          if (status === 'OK') break
          if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) throw new Error(businessText(businessPayload(payload).message || payload.message, '店铺商品采集失败'))
          await new Promise((resolve) => window.setTimeout(resolve, 1800))
        }
      }
      const result = businessPayload(payload)
      if (businessStatus(payload) !== 'OK' && result.ok === false) throw new Error(businessText(result.message || payload.message, '未找到公开商品链接'))
      const products = Array.isArray(result.products) ? result.products : []
      let trendAnalysis = ''
      try {
        const trendPrompt = `请分析这个淘宝/天猫店铺近期公开商品动向。只根据提供的店铺画像和商品列表判断，不要编造销量。输出：1.主要产品方向；2.近期铺设/上新的品类；3.价格带；4.可能的销售动向；5.证据不足处。店铺画像：${JSON.stringify(result.shopProfile || {}).slice(0, 6000)} 商品：${JSON.stringify(products).slice(0, 24000)}`
        trendAnalysis = String(await window.anyu.apiRequest('/groups/available').then(() => '').catch(() => '') || '')
        if (selectedModel && window.anyu.apiStream) trendAnalysis = String(await window.anyu.apiStream(`店铺分析：${trendPrompt}`, { model: selectedModel.modelId || selectedModel.id }).catch(() => ''))
      } catch {}
      const snapshot = { shopUrl: url, collectedAt: result.collectedAt || new Date().toISOString(), shopProfile: result.shopProfile || {}, trendHints: result.trendHints || [], products, trendAnalysis }
      const files = await writeBusinessArtifacts(effectiveWorkspace(), [{ name: 'shop-monitor-snapshot.json', content: businessSecretSafeJson(snapshot) }, ...(trendAnalysis ? [{ name: 'shop-monitor-analysis.md', content: trendAnalysis }] : [])])
      resultMessage.businessPending = false; resultMessage.businessPhase = '已完成'; resultMessage.businessStatus = 'OK'; resultMessage.businessProgress = `已滚动到底部并提取 ${products.length} 个商品，已生成店铺结构分析。`; resultMessage.businessResult = { count: products.length, shopUrl: url, trendAnalysis }; resultMessage.artifacts = files; resultMessage.content = `店铺分析完成：已提取 ${products.length} 个公开商品，并分析商品结构、上架走向和风格方向。${trendAnalysis ? `\n\n店铺分析：\n${trendAnalysis}` : ''}`
      await persistBusinessMessage(sessionPath, resultMessage); renderApp()
    } catch (error) {
      resultMessage.businessPending = false; resultMessage.businessPhase = '失败'; resultMessage.businessStatus = 'FAILED'; resultMessage.isError = true; resultMessage.content = errorText(error) || '店铺监控失败'; resultMessage.businessProgress = '本次采集未完成，请检查右侧浏览器页面后重试'; await persistBusinessMessage(sessionPath, resultMessage); renderApp()
    } finally { releaseSessionSkill(pendingKey, sessionPath); scheduleQueueDrain() }
  }

  async function runFeedbackSkill(task) {
    const promptText = businessPrompt(task.content, 'feedback')
    const urlMatch = String(promptText || task.content || '').match(/https:\/\/(?:[^\s/]+\.)?(?:taobao\.com|tmall\.com)\/[^\s]+/i)
    const url = urlMatch?.[0] || ''
    const pendingKey = state.sessionPath || '__pending__'
    let sessionPath = pendingKey
    let oldSessionKey = pendingKey
    let resultMessage = null
    // 侧栏“运行中”的数据源：登记后即使切到别的会话，这个会话也持续显示加载动画。
    beginMediaActivity(pendingKey, task.id, 'feedback')
    state.skillBusy = 'feedback'; state.mediaBusyCount = Number(state.mediaBusyCount || 0) + 1; state.sessionLoadingPath = state.sessionPath || null; state.error = ''
    const userMessage = { id: task.id, role: 'user', content: task.content, attachments: task.attachments, createdAt: Number(task.createdAt || Date.now()) }
    resultMessage = { id: `${task.id}:result`, role: 'assistant', content: '正在准备评价采集…', createdAt: userMessage.createdAt + 0.5, businessSkill: 'feedback', businessPending: true, businessPhase: '准备中', businessStatus: 'SUBMITTED' }
    insertTimelineMessage(userMessage)
    upsertMediaTimelineMessage(sessionPath, userMessage)
    upsertTimelineMessage(resultMessage)
    upsertMediaTimelineMessage(sessionPath, resultMessage)
    updateSessionTitle(task.content, userMessage.createdAt)
    renderApp(); updateLiveUi(true)
    try {
      if (!url) throw new Error('请在 @评价分析 后提供淘宝或天猫商品链接')
      oldSessionKey = sessionPath
      await ensureMediaSession()
      sessionPath = state.sessionPath
      state.sessionLoadingPath = sessionPath
      if (oldSessionKey !== sessionPath) {
        moveMediaActivity(oldSessionKey, sessionPath, task.id)
        const pendingMessages = state.mediaMessages[oldSessionKey] || []
        const currentMessages = state.mediaMessages[sessionPath] || []
        state.mediaMessages[sessionPath] = [...currentMessages, ...pendingMessages].slice(-100)
        delete state.mediaMessages[oldSessionKey]
      }
      if (!containsTimelineMessage(state.messages, userMessage)) insertTimelineMessage(userMessage)
      await persistBusinessMessage(sessionPath, resultMessage)
      const created = await window.anyu.letaAgentFeedbackCollect({ url, prompt: promptText, maxReviewPages: 200, maxQuestionPages: 80 })
      const collectTaskId = businessTaskId(created)
      if (!collectTaskId) throw new Error('评价采集服务未返回任务编号')
      resultMessage.feedbackTaskId = collectTaskId; resultMessage.feedbackUrl = url; resultMessage.feedbackPrompt = promptText; resultMessage.artifactCwd = effectiveWorkspace()
      resultMessage.businessStatus = businessStatus(created) || 'SUBMITTED'; resultMessage.businessPhase = '等待采集'; resultMessage.businessProgress = '正在打开商品页面并准备采集…'; resultMessage.content = '已提交评价采集，正在获取公开评价与问大家…'
      await persistBusinessMessage(sessionPath, resultMessage)
      const collected = await pollFeedbackTask(collectTaskId, async (status, payload, browser) => {
        resultMessage.businessStatus = status || resultMessage.businessStatus
        if (status === 'WAITING_LOGIN' || status === 'CHALLENGE_REQUIRED') {
          resultMessage.businessPhase = status === 'WAITING_LOGIN' ? '等待淘宝登录' : '等待完成验证'
          resultMessage.businessProgress = status === 'WAITING_LOGIN' ? '等待在右侧内置浏览器完成登录…' : '等待在右侧内置浏览器完成验证…'
          resultMessage.content = status === 'WAITING_LOGIN' ? '请在右侧内置浏览器完成淘宝登录，完成后会自动继续。' : '请在右侧内置浏览器完成页面验证，完成后会自动继续。'
          // 主进程已打开真实采集页面，等待时不能重新导航或切换登录会话。
          browser.markBrowserOpened()
        } else if (status === 'COLLECTING') {
          resultMessage.businessPhase = '采集中'; resultMessage.businessProgress = '正在按页面节奏读取评价和问大家…'; resultMessage.content = `正在采集公开评价${payload.reviewCount ? `（已获取 ${payload.reviewCount} 条）` : ''}…`
        }
        await persistBusinessMessage(sessionPath, resultMessage)
      })
      resultMessage.feedbackCollected = true
      resultMessage.feedbackRetry = true
      await persistBusinessMessage(sessionPath, resultMessage)
      resultMessage.artifacts = await writeBusinessArtifacts(resultMessage.artifactCwd, feedbackArtifactFiles(collected, url))
      await finishFeedbackAnalysis(resultMessage, sessionPath)
    } catch (error) {
      if (!resultMessage) {
        resultMessage = { id: `${task.id}:result`, role: 'assistant', createdAt: Number(task.createdAt || Date.now()) + 0.5, businessSkill: 'feedback' }
      }
      resultMessage.feedbackRetry = Boolean(resultMessage.feedbackTaskId && (resultMessage.feedbackCollected || resultMessage.artifacts?.length))
      const analysisText = resultMessage.businessPhase === '生成报告' ? String(resultMessage.content || '').trim() : ''
      resultMessage.businessPending = false; resultMessage.businessPhase = resultMessage.feedbackRetry ? '分析失败' : '失败'; resultMessage.businessStatus = 'FAILED'; resultMessage.businessProgress = '本次任务未完成，可从当前阶段重试。'; resultMessage.isError = true; resultMessage.content = `${analysisText ? `${analysisText}\n\n` : ''}${resultMessage.feedbackRetry ? '原始采集已保留，可重试分析。' : ''}${errorText(error) || '评价分析失败'}`
      await persistBusinessMessage(sessionPath, resultMessage)
    } finally {
      state.mediaBusyCount = Math.max(0, Number(state.mediaBusyCount || 1) - 1); endMediaActivity(sessionPath, task.id); releaseSessionSkill(pendingKey, sessionPath); if (!state.mediaBusyCount && state.sessionLoadingPath === sessionPath) state.sessionLoadingPath = null; scheduleSessionListRender(); scheduleQueueDrain()
    }
  }

  function imageAnalysisSummary(payload) {
    const response = payload?.response
    if (response && typeof response === 'object') return response
    if (typeof response === 'string') { try { return JSON.parse(response) } catch { return { text: response } } }
    return { text: payload?.responseText || payload?.response_text || payload?.outputText || payload?.output_text || payload?.content || '' }
  }

  // 测图的定位是"排行 + 打分"，不是自由格式长报告。提示词要求模型返回固定结构，
  // 这里只负责解析、归一化与排序：总分一律按权重重算，名次不并列，缺失图片补位，
  // 保证展示顺序完全由分数决定，不受模型输出顺序影响。
  const IMAGE_ANALYSIS_DIMENSIONS = [
    { key: 'hook', label: '首屏吸引力', weight: 0.25 },
    { key: 'subject', label: '主体清晰度', weight: 0.2 },
    { key: 'selling', label: '卖点表达', weight: 0.2 },
    { key: 'text', label: '文字可读性', weight: 0.15 },
    { key: 'trust', label: '信任与合规', weight: 0.1 },
    { key: 'scene', label: '场景与调性', weight: 0.1 }
  ]

  function imageAnalysisScore(value) {
    const num = Number(value)
    if (!Number.isFinite(num)) return null
    return Math.round(Math.min(10, Math.max(0, num)) * 10) / 10
  }

  function imageAnalysisJson(text) {
    const raw = String(text || '')
    // 模型可能带 ```json 围栏，也可能直接裸写，两种都试；取第一个能解析的对象。
    for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      try { const parsed = JSON.parse(String(match[1] || '').trim()); if (parsed && typeof parsed === 'object') return parsed } catch { /* 继续尝试下一个代码块 */ }
    }
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { const parsed = JSON.parse(raw.slice(start, end + 1)); if (parsed && typeof parsed === 'object') return parsed } catch { /* 结构不可解析 */ }
    }
    return null
  }

  function imageAnalysisReport(text, imageCount = 0) {
    const raw = String(text || '')
    const data = imageAnalysisJson(raw)
    const list = Array.isArray(data?.ranking) ? data.ranking : Array.isArray(data) ? data : []
    if (!list.length) return null
    const seen = new Set()
    const rows = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const index = Math.trunc(Number(item.index ?? item.image ?? item.no))
      if (!Number.isFinite(index) || index < 1) continue
      if (seen.has(index)) continue
      seen.add(index)
      const scores = {}
      let weighted = 0; let weightSum = 0
      for (const dimension of IMAGE_ANALYSIS_DIMENSIONS) {
        const score = imageAnalysisScore(item.scores?.[dimension.key] ?? item[dimension.key])
        if (score == null) continue
        scores[dimension.key] = score
        weighted += score * dimension.weight
        weightSum += dimension.weight
      }
      rows.push({
        index,
        name: String(item.name || `第 ${index} 张`).slice(0, 120),
        scores,
        // 总分由权重算出；维度缺失时退回模型自报的 total，仍无法判定则记为 null 排在最后。
        total: weightSum ? Math.round((weighted / weightSum) * 10) / 10 : imageAnalysisScore(item.total ?? item.score),
        hook: scores.hook ?? 0,
        comment: String(item.comment || item.verdict || '').slice(0, 120),
        reason: String(item.reason || item.why || '').slice(0, 240),
        fixes: (Array.isArray(item.fixes) ? item.fixes : item.fix ? [item.fix] : []).map((value) => String(value).slice(0, 200)).filter(Boolean).slice(0, 3),
        risks: (Array.isArray(item.risks) ? item.risks : item.risk ? [item.risk] : []).map((value) => String(value).slice(0, 200)).filter(Boolean).slice(0, 2)
      })
    }
    if (!rows.length) return null
    const total = Math.trunc(Number(imageCount) || 0)
    if (total > 0) for (let index = 1; index <= total; index++) {
      if (seen.has(index)) continue
      rows.push({ index, name: `第 ${index} 张`, scores: {}, total: null, hook: 0, comment: '模型未返回该图评分', reason: '', fixes: [], risks: [] })
    }
    // 分数降序；同分比首屏吸引力；再同分按输入顺序，保证名次稳定可复现。
    rows.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || b.hook - a.hook || a.index - b.index)
    rows.forEach((row, position) => { row.rank = position + 1 })
    const summary = String(data?.summary || data?.verdict || '').slice(0, 200)
      || raw.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('```') && !line.startsWith('{') && !/^首选[:：]/.test(line))?.slice(0, 200) || ''
    return { summary, best: rows[0].index, total: rows.length, ranking: rows }
  }

  function imageAnalysisHeadline(report) {
    if (!report) return ''
    const top = report.ranking.filter((row) => row.total != null).slice(0, 3)
    if (!top.length) return ''
    const lines = top.map((row) => `第 ${row.rank} 名：${row.name}（${row.total.toFixed(1)} 分）${row.comment ? ` — ${row.comment}` : ''}`)
    const best = report.ranking[0]
    const weak = report.ranking.filter((row) => row.total != null).slice(-1)[0]
    return [`${lines.join('\n')}`, `首选：${best.name}。`, weak && weak !== best ? `最需要改：${weak.name}（${weak.total.toFixed(1)} 分）。` : ''].filter(Boolean).join('')
  }

  function imageAnalysisLevel(total) {
    if (total == null) return { label: '未评分', tone: 'muted' }
    if (total >= 8.5) return { label: '主推', tone: 'good' }
    if (total >= 7) return { label: '可用', tone: 'ok' }
    return { label: '待改', tone: 'bad' }
  }

  function imageAnalysisThumb(assets, index) {
    const url = String(assets?.[index - 1]?.url || assets?.[index - 1]?.imageUrl || assets?.[index - 1]?.src || '').trim()
    return /^data:image\//i.test(url) || /^https?:\/\//i.test(url) ? url : ''
  }

  function imageAnalysisBar(score) {
    const value = Math.max(0, Math.min(10, Number(score) || 0))
    return `<span class="ia-bar" aria-hidden="true"><i style="width:${Math.round(value * 10)}%"></i></span>`
  }

  function imageAnalysisHtml(report, assets = []) {
    const rows = report.ranking || []
    const best = rows[0]
    const legend = IMAGE_ANALYSIS_DIMENSIONS.map((dimension) => `${esc(dimension.label)} ${Math.round(dimension.weight * 100)}%`).join(' · ')
    const board = rows.map((row) => {
      const level = imageAnalysisLevel(row.total)
      return `<tr class="ia-row ia-${level.tone}">
        <td class="ia-rank">${row.rank}</td>
        <td class="ia-thumb">${imageAnalysisThumb(assets, row.index) ? `<img src="${esc(imageAnalysisThumb(assets, row.index))}" alt="${esc(row.name)}" loading="lazy">` : `<span class="ia-empty">图 ${row.index}</span>`}</td>
        <td class="ia-name">${esc(row.name)}</td>
        <td class="ia-total"><b>${row.total == null ? '—' : row.total.toFixed(1)}</b><span class="ia-tag ia-${level.tone}">${esc(level.label)}</span></td>
        <td class="ia-dims">${IMAGE_ANALYSIS_DIMENSIONS.map((dimension) => `<span class="ia-dim"><em>${esc(dimension.label)}</em>${row.scores[dimension.key] == null ? '—' : row.scores[dimension.key].toFixed(1)}${imageAnalysisBar(row.scores[dimension.key])}</span>`).join('')}</td>
        <td class="ia-comment">${esc(row.comment || '—')}</td>
      </tr>`
    }).join('')
    const cards = rows.map((row) => {
      const level = imageAnalysisLevel(row.total)
      const thumb = imageAnalysisThumb(assets, row.index)
      return `<article class="ia-card ia-${level.tone}">
        <header><span class="ia-rank">#${row.rank}</span>${thumb ? `<img src="${esc(thumb)}" alt="${esc(row.name)}" loading="lazy">` : ''}<div><h3>${esc(row.name)}</h3><p class="ia-score">${row.total == null ? '未评分' : `${row.total.toFixed(1)} 分 · ${esc(level.label)}`}</p></div></header>
        ${row.comment ? `<p class="ia-comment">${esc(row.comment)}</p>` : ''}
        ${row.reason ? `<p class="ia-reason"><em>排名依据</em>${esc(row.reason)}</p>` : ''}
        ${row.fixes.length ? `<div class="ia-block"><em>改图建议</em><ol>${row.fixes.map((fix) => `<li>${esc(fix)}</li>`).join('')}</ol></div>` : ''}
        ${row.risks.length ? `<div class="ia-block ia-risk"><em>风险提示</em><ul>${row.risks.map((risk) => `<li>${esc(risk)}</li>`).join('')}</ul></div>` : ''}
      </article>`
    }).join('')
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 测图排行</title><style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e5e7eb;--ink:#1f2328;--muted:#6b7280;--good:#0f9d58;--ok:#e08b1f;--bad:#d64545}
*{box-sizing:border-box}body{margin:0;padding:28px 20px 48px;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1120px;margin:0 auto}h1{margin:0 0 6px;font-size:22px}.meta{margin:0 0 18px;color:var(--muted);font-size:12.5px}
.verdict{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--good);border-radius:10px;padding:14px 16px;margin-bottom:20px}
.verdict b{color:var(--good)}.verdict p{margin:6px 0 0}
h2{margin:26px 0 12px;font-size:16px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}
th{background:#f0f2f5;font-size:12.5px;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:none}
.ia-rank{font-weight:700;font-size:15px;width:52px}
.ia-thumb img{width:64px;height:64px;object-fit:cover;border-radius:8px;display:block;border:1px solid var(--line)}
.ia-empty{display:inline-block;width:64px;height:64px;line-height:64px;text-align:center;color:var(--muted);background:#f0f2f5;border-radius:8px;font-size:12px}
.ia-name{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ia-total{width:104px;white-space:nowrap}.ia-total b{font-size:16px}
.ia-tag{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:11.5px;font-weight:600}
.ia-good .ia-tag,.ia-tag.ia-good{background:#e6f6ec;color:var(--good)}
.ia-ok .ia-tag,.ia-tag.ia-ok{background:#fdf1de;color:var(--ok)}
.ia-bad .ia-tag,.ia-tag.ia-bad{background:#fbeaea;color:var(--bad)}
.ia-muted .ia-tag,.ia-tag.ia-muted{background:#eef0f2;color:var(--muted)}
.ia-dims{width:330px}.ia-dim{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);width:50%;float:left;padding-right:10px}
.ia-dim em{font-style:normal;min-width:64px}
.ia-bar{flex:1;height:5px;background:#eceff2;border-radius:3px;overflow:hidden;min-width:26px}
.ia-bar i{display:block;height:100%;background:#8aa0b8;border-radius:3px}
.ia-good .ia-bar i{background:var(--good)}.ia-ok .ia-bar i{background:var(--ok)}.ia-bad .ia-bar i{background:var(--bad)}
.ia-comment{color:#374151}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.ia-card{background:var(--card);border:1px solid var(--line);border-top:3px solid #8aa0b8;border-radius:12px;padding:14px 16px}
.ia-card.ia-good{border-top-color:var(--good)}.ia-card.ia-ok{border-top-color:var(--ok)}.ia-card.ia-bad{border-top-color:var(--bad)}
.ia-card header{display:flex;align-items:center;gap:12px}
.ia-card header img{width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
.ia-card h3{margin:0;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ia-score{margin:2px 0 0;color:var(--muted);font-size:12.5px}
.ia-card>p{margin:10px 0 0}
.ia-reason{color:#4b5563;font-size:13px}
.ia-block{margin:10px 0 0;font-size:13px}
.ia-block em{display:block;font-style:normal;color:var(--muted);font-size:12px;margin-bottom:4px}
.ia-block ol,.ia-block ul{margin:0;padding-left:20px}
.ia-risk{color:#8a3b3b}
</style></head><body><div class="wrap">
<h1>AI 测图排行</h1>
<p class="meta">共 ${rows.length} 张 · 权重：${esc(legend)} · 总分由客户端按权重计算，名次不并列</p>
${report.summary ? `<div class="verdict"><b>首选：${esc(report.ranking[0] ? report.ranking[0].name : '')}</b><p>${esc(report.summary)}</p></div>` : ''}
<h2>排行榜</h2>
<table><thead><tr><th>名次</th><th>图</th><th>文件</th><th>总分</th><th>维度得分</th><th>一句话点评</th></tr></thead><tbody>${board}</tbody></table>
<h2>逐图分析</h2>
<div class="cards">${cards}</div>
</div></body></html>`
  }

  function imageAnalysisFallbackHtml(text, assets = []) {
    const thumbs = (Array.isArray(assets) ? assets : []).map((asset) => String(asset?.url || '')).filter((url) => /^data:image\//i.test(url) || /^https?:\/\//i.test(url)).slice(0, 12)
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AI 测图结果</title><style>body{font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:900px;margin:32px auto;padding:0 20px;color:#1f2328}pre{white-space:pre-wrap;word-break:break-word;background:#f6f7f9;border:1px solid #e5e7eb;border-radius:10px;padding:16px}img{max-width:150px;max-height:150px;object-fit:cover;margin:6px;border-radius:8px}</style></head><body><h1>AI 测图结果</h1><p class="meta">模型未返回可解析的评分结构，以下为原始输出。</p><pre>${esc(String(text || '本次没有返回分析内容'))}</pre>${thumbs.length ? `<div>${thumbs.map((url) => `<img src="${esc(url)}" alt="分析图片" loading="lazy">`).join('')}</div>` : ''}</body></html>`
  }

  function imageAnalysisArtifactFiles({ report, text = '', assets = [], imageCount = 0 }) {
    return [
      { name: 'ai-image-analysis.html', content: report ? imageAnalysisHtml(report, assets) : imageAnalysisFallbackHtml(text, assets) },
      { name: 'ai-image-analysis.json', content: businessSecretSafeJson({ analyzedAt: new Date().toISOString(), imageCount, report, text }) }
    ]
  }

  function attachmentBase64Data(attachment) {
    const direct = String(attachment?.data || '').trim()
    if (direct) return direct.replace(/^data:[^;,]+;base64,/i, '')
    const dataUrl = String(attachment?.dataUrl || attachment?.url || '').trim()
    if (/^data:[^,]+,/i.test(dataUrl)) return dataUrl.slice(dataUrl.indexOf(',') + 1)
    return ''
  }

  // 不再按目录标注“推断”哪些模型支持识图并自动换模型：目录标注经常滞后，
  // qwen / deepseek 这类新模型常被误判成不能看图，结果用户指定的模型被直接
  // 绕开。测图固定用用户当前选中的模型把请求发出去，能不能识别由模型返回
  // 的结果决定——真不支持时接口报错，原样展示给用户。
  async function finishShopAnalysis(message, sessionPath) {
    const result = message.businessResult || {}
    message.businessStatus = 'ANALYZING'; message.businessPhase = 'AI 分析'
    message.businessProgress = '正在分析商品结构、上新走向和风格定位…'
    message.isError = false; message.shopAnalysisRetry = false
    await persistBusinessMessage(sessionPath, message)
    const stopProgress = window.anyu.onLetaAgentShopAnalysisProgress?.((progress) => {
      if (progress?.taskId !== result.taskId || !message.businessPending) return
      message.content = String(progress.text || '').slice(0, 50000)
      updateBusinessMessage(sessionPath, message)
      if (state.sessionPath === sessionPath) scheduleLiveUi(false)
    })
    try {
      const analysis = await window.anyu.letaAgentShopAnalysisStarted(result.taskId, { prompt: result.prompt, model: result.model, sessionKey: sessionPath })
      const { analysisHtml, ...snapshot } = analysis
      const files = await writeBusinessArtifacts(message.artifactCwd, [
        { name: 'shop-analysis-' + result.taskId + '.json', content: businessSecretSafeJson(snapshot) },
        { name: 'shop-analysis-' + result.taskId + '.md', content: analysis.analysisSummary },
        { name: 'shop-analysis-' + result.taskId + '.html', content: analysisHtml }
      ])
      message.businessPending = false; message.businessPhase = '已完成'; message.businessStatus = 'OK'
      message.businessProgress = '已完成 AI 分析：商品结构、上新方向、风格及证据限制。'
      message.businessResult = { ...result, count: analysis.products.length, coverage: analysis.coverage }
      message.content = analysis.analysisSummary
      message.artifacts = files; message.finishedAt = Date.now()
      await persistBusinessMessage(sessionPath, message)
      if (state.sessionPath === sessionPath) await openBusinessArtifact(files.find((file) => file.name.endsWith('.html')), message.artifactCwd)
    } finally { stopProgress?.() }
  }

  async function retryShopAnalysis(message) {
    if (state.loading || state.skillBusy || !businessPlugin('shop-monitor')) return
    const sessionPath = state.sessionPath
    setSessionSkill(sessionPath, 'shop-monitor'); beginMediaActivity(sessionPath, message.id, 'shop-monitor')
    message.businessPending = true
    try {
      await ensureAgentStarted()
      await finishShopAnalysis(message, sessionPath)
    } catch (error) {
      message.businessPending = false; message.businessPhase = '分析失败'; message.businessStatus = 'FAILED'
      message.isError = true; message.shopAnalysisRetry = true
      message.businessProgress = '采集结果已保留，可只重试 AI 分析，无需重新抓取。'
      message.content = errorText(error)
      await persistBusinessMessage(sessionPath, message)
    } finally {
      endMediaActivity(sessionPath, message.id); releaseSessionSkill(sessionPath); scheduleQueueDrain()
    }
  }

  async function runShopMonitorSkill(task) {
    const promptText = businessPrompt(task.content, 'shop-monitor')
    const url = String(promptText || task.content || '').match(/https:\/\/(?:[^\s/]+\.)?(?:taobao\.com|tmall\.com)\/[^\s]+/i)?.[0] || ''
    const selectedModel = currentModel()
    const pendingKey = task.sessionPath || state.sessionPath || '__pending__'
    let sessionPath = pendingKey
    const workspace = effectiveWorkspace()
    const userMessage = { id: task.id, role: 'user', content: task.content, createdAt: Number(task.createdAt || Date.now()) }
    const resultMessage = { id: task.id + ':result', role: 'assistant', content: '正在启动店铺分析…', createdAt: userMessage.createdAt + 0.5, businessSkill: 'shop-monitor', businessPending: true, businessPhase: '准备中', businessStatus: 'SUBMITTED', businessProgress: '打开内置浏览器，慢速滚动并等待商品列表加载…', artifactCwd: workspace }
    insertTimelineMessage(userMessage); upsertMediaTimelineMessage(sessionPath, userMessage)
    insertTimelineMessage(resultMessage); upsertMediaTimelineMessage(sessionPath, resultMessage)
    setSessionSkill(pendingKey, 'shop-monitor'); beginMediaActivity(pendingKey, task.id, 'shop-monitor')
    renderApp(); updateLiveUi(true)
    try {
      if (!url) throw new Error('请在 @店铺分析 后提供淘宝或天猫店铺链接')
      await openBusinessUrl(url)
      // 浏览器面板是任务必需界面，立即布局，不等待输入框的延迟整页刷新。
      if (state.sessionPath === task.sessionPath || !task.sessionPath) renderApp()
      await ensureMediaSession(); sessionPath = state.sessionPath
      if (pendingKey !== sessionPath) {
        for (const message of [userMessage, resultMessage]) upsertMediaTimelineMessage(sessionPath, message)
        state.mediaMessages[pendingKey] = (state.mediaMessages[pendingKey] || []).filter((message) => ![userMessage.id, resultMessage.id].includes(message.id))
        moveMediaActivity(pendingKey, sessionPath, task.id)
        releaseSessionSkill(pendingKey); setSessionSkill(sessionPath, 'shop-monitor')
      }
      resultMessage.artifactCwd = workspace || effectiveWorkspace()
      await persistBusinessMessage(sessionPath, resultMessage)
      const created = await window.anyu.letaAgentShopMonitorCollect({ url, maxRounds: 240 })
      const taskId = businessTaskId(created)
      if (!taskId) throw new Error('店铺采集任务未创建')
      resultMessage.businessResult = { taskId, count: 0, shopUrl: url, prompt: promptText, model: selectedModel ? { provider: selectedModel.provider, model: selectedModel.modelId || selectedModel.id } : null }
      let payload
      const started = Date.now()
      while (Date.now() - started < 10 * 60 * 1000) {
        payload = await window.anyu.letaAgentShopMonitorStatus(taskId)
        const status = businessStatus(payload), data = businessPayload(payload)
        resultMessage.businessStatus = status
        resultMessage.businessResult.count = Number(data.productCount || data.products?.length || 0)
        resultMessage.businessPhase = status === 'COLLECTING' ? '采集中' : ['WAITING_LOGIN', 'CHALLENGE_REQUIRED'].includes(status) ? '等待浏览器操作' : '处理中'
        resultMessage.businessProgress = status === 'COLLECTING' ? (data.phase || '慢速滚动加载') + '，已累计 ' + resultMessage.businessResult.count + ' 条商品样本'
          : status === 'WAITING_LOGIN' ? '请在右侧内置浏览器登录，完成后继续' : status === 'CHALLENGE_REQUIRED' ? '请在右侧完成安全验证' : '正在准备采集…'
        // 等待登录只重新显示面板，不 loadURL，否则用户扫码/验证码会反复被刷新。
        if (['WAITING_LOGIN', 'CHALLENGE_REQUIRED'].includes(status) && !state.browser.open && state.sessionPath === sessionPath) {
          state.browser = { ...await window.anyu.browserState(), open: true }; renderApp(); scheduleBrowserBoundsSync()
        }
        await persistBusinessMessage(sessionPath, resultMessage)
        if (status === 'OK') break
        if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) throw new Error(businessText(data.message, '店铺采集失败'))
        await new Promise((resolve) => window.setTimeout(resolve, 1800))
      }
      if (businessStatus(payload) !== 'OK') throw new Error('店铺采集等待超时，已采集数据仍保留在本机')
      const result = businessPayload(payload)
      if (!result.products?.length) throw new Error('没有可分析的商品样本')
      resultMessage.businessResult.count = result.products.length
      resultMessage.businessResult.coverage = result.coverage
      resultMessage.shopAnalysisRetry = true
      resultMessage.artifacts = await writeBusinessArtifacts(resultMessage.artifactCwd, [{
        name: 'shop-analysis-' + taskId + '.json', content: businessSecretSafeJson(result)
      }])
      await finishShopAnalysis(resultMessage, sessionPath)
    } catch (error) {
      resultMessage.businessPending = false; resultMessage.businessPhase = resultMessage.shopAnalysisRetry ? '分析失败' : '采集失败'
      resultMessage.businessStatus = 'FAILED'; resultMessage.isError = true; resultMessage.content = errorText(error) || '店铺分析失败'
      resultMessage.businessProgress = resultMessage.shopAnalysisRetry ? '原始采集已保留，可重试 AI 分析。' : '请检查右侧页面的登录和加载状态后重试。'
      await persistBusinessMessage(sessionPath, resultMessage)
    } finally {
      endMediaActivity(sessionPath, task.id); endMediaActivity(pendingKey, task.id)
      releaseSessionSkill(pendingKey, sessionPath); scheduleSessionListRender(); scheduleQueueDrain()
    }
  }

  async function finishOneClickDetailPage({ task, resultMessage, sessionPath, url, promptText, productRefs, detailResult, detailTaskId }) {
    const images = Array.isArray(detailResult?.images) ? detailResult.images.slice(0, 24) : []
    const referenceAssets = compactOneClickReferenceAssets(images)
    resultMessage.businessAssets = referenceAssets
    resultMessage.businessResult = {
      ...(resultMessage.businessResult || {}),
      referenceCount: images.length,
      detailTaskId: String(detailTaskId || resultMessage.businessResult?.detailTaskId || ''),
      detailPrompt: String(promptText || resultMessage.businessResult?.detailPrompt || ''),
      detailUrl: String(url || resultMessage.businessResult?.detailUrl || ''),
      sourceUrls: Array.isArray(detailResult?.sourceUrls) ? detailResult.sourceUrls.slice(0, 24) : referenceAssets.map((item) => item.sourceUrl)
    }
    if (!referenceAssets.length) throw new Error('详情页没有可采集的公开图片，请在右侧浏览器完成登录或验证后重试')
    if (!productRefs.length) {
      resultMessage.businessPending = false
      resultMessage.finishedAt = Date.now()
      resultMessage.businessPhase = '等待客户素材'
      resultMessage.businessStatus = 'WAITING_INPUT'
      resultMessage.businessProgress = `已提取 ${resultMessage.businessResult.referenceCount} 张参考图。请上传客户自己的产品图并说明产品名称或核心要求，收到后会自动继续生图。`
      resultMessage.content = '竞品详情页已采集完成。请直接在本条对话上传客户产品图并补充产品名称/要求，不必重新发送商品链接或再次输入技能名。'
      await persistBusinessMessage(sessionPath, resultMessage)
      renderApp()
      return
    }

    const config = state.skillConfigs.image
    const models = skillModels('image')
    const savedModel = String(resultMessage.businessResult?.imageModel || '')
    const savedGroupId = Number(resultMessage.businessResult?.imageGroupId || 0)
    const model = models.find((item) => item.name === savedModel && Number(item.groupId) === savedGroupId)
      || models.find((item) => item.name === config.model && Number(item.groupId) === Number(config.groupId))
    if (!model || !Number(model.groupId)) throw new Error('请先在设置中选择可用的生图分组和模型')
    const maxFromModel = Number(model.max_reference_images ?? model.maxReferenceImages)
    const referenceLimit = Number.isFinite(maxFromModel) && maxFromModel > 0 ? Math.min(8, maxFromModel) : 5
    if (referenceLimit < 2) throw new Error('当前生图模型至少需要支持 2 张参考图，才能同时锁定客户产品和详情页版式')
    const products = productRefs.filter((item) => item.data).slice(0, Math.min(3, referenceLimit - 1))
    if (!products.length) throw new Error('没有有效的客户产品图片，请重新上传清晰产品图')
    const originalRequest = [promptText, task.content].map((value) => String(value || '').trim()).filter(Boolean).join('\n')
    const layoutSources = referenceAssets.map((item, index) => `P${index + 1}: ${item.sourceUrl}`).join('\n')
    const previousPages = Array.isArray(resultMessage.businessResult.pages) ? resultMessage.businessResult.pages : []
    const pages = images.map((image, index) => {
      const sourceUrl = String(image.sourceUrl || image.url || '')
      const prior = previousPages.find((page) => page.index === index + 1 && page.sourceUrl === sourceUrl)
      return prior ? { ...prior } : { index: index + 1, sourceUrl, status: 'pending', imageTaskId: '', prompt: '' }
    })
    const generatedAssets = (resultMessage.attachments || []).filter((item) => pages.some((page) => page.status === 'completed' && page.attachmentId === item.id))
    const productLock = `前 ${products.length} 张图片是同一件客户产品的身份锚点，最后一张才是本页竞品版式图。所有页面中的产品只允许使用客户产品：保持轮廓、比例、厚度、颜色、材质、纹理、品牌标志、包装、缝线和零部件数量、位置不变，不增加、删除、拼接或替换成竞品款式。`
    const layoutLock = '逐项保持对应参考图的构图骨架、人物姿势、动作方向、人物与产品相对位置、产品展示角度、镜头高度、裁切边界、主体占比；对齐标题、副标题、说明文字的区域、行数、字数密度、字号层级、字体风格、字重和留白。文案使用客户已确认的中文信息，保持原有表达结构和阅读节奏，只替换品牌和产品事实；不得虚构参数、功效、认证或照抄竞品品牌、水印及专属文案。保留可读的文案，不要擅自删掉整个文字层。'
    resultMessage.artifactCwd = resultMessage.artifactCwd || effectiveWorkspace()
    resultMessage.attachments = generatedAssets
    resultMessage.businessResult = { ...resultMessage.businessResult, pages, totalCount: images.length, generatedCount: generatedAssets.length, imageModel: model.name, imageGroupId: Number(model.groupId), workflowVersion: 2 }
    resultMessage.content = `按参考图顺序生成 P1–P${images.length}，每张参考图对应一张我方产品详情页。`

    // 串行规划、生成并逐页落盘，避免整批长图并发占用内存；重试只续接未完成页。
    for (let index = 0; index < images.length; index += 1) {
      const page = pages[index]
      if (page.status === 'completed' && generatedAssets.some((item) => item.id === page.attachmentId)) continue
      try {
        const layout = oneClickImageReferences([], [images[index]], 1)[0]
        if (!layout?.data) throw new Error('该参考图未下载成功或图片格式无法上传，请先重新采集此图')
        const references = [...products, layout]
        const width = Number(images[index].width || 0), height = Number(images[index].height || 0)
        page.size = page.size || (width > 0 && height > 0 ? height / width > 1.15 ? '1024x1536' : width / height > 1.15 ? '1536x1024' : '1024x1024' : config.size || '1024x1536')
        if (!page.prompt) {
          page.status = 'planning'
          resultMessage.businessPhase = '逐图反推'
          resultMessage.businessStatus = 'PLANNING'
          resultMessage.businessProgress = `正在分析 P${page.index}/${pages.length} 的版式、字体和产品位置…`
          await persistBusinessMessage(sessionPath, resultMessage)
          renderApp()
          const visualStyle = pages.find((item) => item.prompt)?.prompt?.slice(0, 1200) || ''
          const request = `你是天猫详情页视觉总监和图片反推专家。为整套详情页的 P${page.index}/${pages.length} 单独生成一张图片的完整提示词，不是只生成首屏，不是多图拼贴。\n用户要求：${originalRequest}\n${productLock}\n${layoutLock}\n源图画幅：${width || '未知'}×${height || '未知'}，保持原图横竖方向和比例关系。\n整套统一视觉依据：${visualStyle || '以当前版式为基准；后续页面保持专业商业质感、色彩协调、字体系统与留白节奏一致。'}\n分析本次上传的最后一张参考图，准确记录其页面模块、文案层级、主体角度、姿势与光线，随后用客户产品替换主体，输出本页专属生图提示词。`
          const plan = await buildImagePrompt(request, references)
          page.prompt = `${plan.prompt}\n${productLock}\n${layoutLock}\n只输出 P${page.index} 的一张独立成图，保持本页参考图的画幅和完整信息模块，不混入其他页。`
          page.planSource = plan.source
          resultMessage.businessResult.planSource = plan.source
          resultMessage.businessResult.planPrompt = page.prompt
        }
        page.status = 'generating'
        page.error = ''
        resultMessage.businessPhase = '逐页生图'
        resultMessage.businessStatus = 'PROCESSING'
        resultMessage.businessProgress = `P${page.index}/${pages.length} 正在生成，已完成 ${generatedAssets.length} 张${page.planSource === 'local' ? '；辅助规划暂不可用，生图模型直接读取产品和版式参考图' : ''}…`
        await persistBusinessMessage(sessionPath, resultMessage)
        renderApp()
        if (!page.imageTaskId) {
          const created = await window.anyu.imageCreate({ prompt: page.prompt, groupId: Number(model.groupId), model: model.name, size: page.size, quality: config.quality || 'auto', count: 1, references })
          page.imageTaskId = businessTaskId(created)
          if (!page.imageTaskId) throw new Error('生图服务没有返回任务编号')
          await persistBusinessMessage(sessionPath, resultMessage)
        }
        const done = await pollMediaTask('image', page.imageTaskId)
        const mediaResult = done.results?.[0] || done.result
        const preview = await compactGeneratedImagePreview(mediaDataUrl(mediaResult, 'image'))
        const mimeType = mediaMimeType(mediaResult, 'image')
        const attachment = { id: `one-click-detail-${page.imageTaskId}-0`, kind: 'image', name: `一键详情页-P${String(page.index).padStart(2, '0')}${mediaExtension(mimeType, '.png')}`, mimeType, ...preview, downloadTaskId: page.imageTaskId, downloadIndex: 0 }
        generatedAssets.push(attachment)
        page.attachmentId = attachment.id
        page.status = 'completed'
        generatedAssets.sort((left, right) => pages.findIndex((item) => item.attachmentId === left.id) - pages.findIndex((item) => item.attachmentId === right.id))
        resultMessage.attachments = generatedAssets
        resultMessage.businessResult.generatedCount = generatedAssets.length
      } catch (error) {
        page.status = 'failed'
        page.error = errorText(error) || '该页生成失败'
        if (error.taskTerminal) page.imageTaskId = ''
      }
      await persistBusinessMessage(sessionPath, resultMessage)
      renderApp()
    }
    const failedPages = pages.filter((page) => page.status !== 'completed')
    const files = await writeBusinessArtifacts(resultMessage.artifactCwd, [
      { name: 'one-click-detail-page.md', content: `# 一键详情页\n\n## 参考来源\n${layoutSources}\n\n${pages.map((page) => `## P${page.index} · ${page.status}\n${page.prompt}\n${page.error || ''}`).join('\n\n')}\n` },
      { name: 'one-click-detail-page.json', content: businessSecretSafeJson({ url, referenceCount: images.length, generatedCount: generatedAssets.length, productReferenceCount: products.length, pages, sourceUrls: resultMessage.businessResult.sourceUrls || [] }) }
    ])
    resultMessage.businessPending = false
    resultMessage.finishedAt = Date.now()
    resultMessage.businessPhase = failedPages.length ? '部分未完成' : '已完成'
    resultMessage.businessStatus = failedPages.length ? generatedAssets.length ? 'PARTIAL' : 'FAILED' : 'OK'
    resultMessage.isError = failedPages.length > 0
    resultMessage.businessProgress = `已生成 ${generatedAssets.length}/${images.length} 张详情页${failedPages.length ? `，${failedPages.length} 张未完成；发送“继续”即可重试缺失页。` : '，每张均可点击查看大图并下载原图。'}`
    resultMessage.businessAssets = []
    resultMessage.artifacts = files
    resultMessage.content = failedPages.length ? resultMessage.businessProgress : `一键详情页完成：${images.length} 张参考图对应 ${generatedAssets.length} 张我方产品详情页，按 P1–P${pages.length} 顺序排列。`
    await persistBusinessMessage(sessionPath, resultMessage)
    renderApp()
  }

  async function runOneClickDetailPageSkill(task) {
    const promptText = businessPrompt(task.content, 'detail-reference')
    const url = String(promptText || task.content || '').match(/https:\/\/(?:[^\s/]+\.)?(?:taobao\.com|tmall\.com)\/[^\s]+/i)?.[0] || ''
    const productRefs = (task.attachments || []).filter((item) => item?.kind === 'image' && attachmentBase64Data(item)).slice(0, 3).map((item) => ({ data: attachmentBase64Data(item), name: item.name, mimeType: item.mimeType || 'image/png' }))
    const pendingKey = state.sessionPath || '__pending__'
    let sessionPath = pendingKey
    const userMessage = { id: task.id, role: 'user', content: task.content, attachments: task.attachments, createdAt: Number(task.createdAt || Date.now()) }
    const resultMessage = { id: `${task.id}:result`, role: 'assistant', content: 'AI 正在打开详情页并整理参考结构…', createdAt: userMessage.createdAt + 0.5, businessSkill: 'detail-reference', businessPending: true, businessPhase: '采集详情页', businessStatus: 'SUBMITTED', businessProgress: '正在提取详情图、标题和公开卖点…', businessResult: { detailUrl: url, detailPrompt: promptText } }
    insertTimelineMessage(userMessage); upsertMediaTimelineMessage(sessionPath, userMessage)
    insertTimelineMessage(resultMessage); upsertMediaTimelineMessage(sessionPath, resultMessage)
    state.skillBusy = 'detail-reference'; renderApp(); updateLiveUi(true)
    try {
      if (!url) throw new Error('请在 @一键详情页 后提供淘宝或天猫商品详情链接')
      const priorSessionKey = sessionPath
      await ensureMediaSession({ startAgent: false }); sessionPath = state.sessionPath
      setSessionSkill(sessionPath, 'detail-reference')
      if (priorSessionKey !== sessionPath) {
        const pendingMessages = state.mediaMessages[priorSessionKey] || []
        const currentMessages = state.mediaMessages[sessionPath] || []
        state.mediaMessages[sessionPath] = timelineMessagesUnique([...currentMessages, ...pendingMessages]).slice(-100)
        delete state.mediaMessages[priorSessionKey]
      }
      if (!containsTimelineMessage(state.messages, userMessage)) insertTimelineMessage(userMessage)
      upsertMediaTimelineMessage(sessionPath, userMessage)
      const created = await window.anyu.letaAgentDetailCollect({ url, maxImages: 24, includeData: true, maxImageBytes: 8 * 1024 * 1024 })
      const taskId = businessTaskId(created)
      let payload = created
      if (taskId) {
        const started = Date.now()
        while (Date.now() - started < 10 * 60 * 1000) {
          payload = await window.anyu.letaAgentDetailStatus(taskId)
          const status = businessStatus(payload)
          resultMessage.businessStatus = status
          resultMessage.businessPhase = ['WAITING_LOGIN', 'CHALLENGE_REQUIRED'].includes(status) ? '等待浏览器操作' : status === 'COLLECTING' ? '采集中' : '处理中'
          resultMessage.businessProgress = status === 'WAITING_LOGIN' ? '请在右侧浏览器完成淘宝登录后继续' : status === 'CHALLENGE_REQUIRED' ? '请在右侧浏览器完成安全验证后继续' : `AI 正在整理详情页候选图（${businessPayload(payload).imageCount || 0} 张）`
          await persistBusinessMessage(sessionPath, resultMessage)
          if (status === 'OK') break
          if (['FAILED', 'CANCELLED', 'ERROR'].includes(status)) throw new Error(businessText(payload?.result?.message || payload?.message, '详情页采集失败'))
          await new Promise((resolve) => window.setTimeout(resolve, 1800))
        }
      }
      const result = businessPayload(payload)
      resultMessage.businessResult = { ...resultMessage.businessResult, detailTaskId: taskId }
      await finishOneClickDetailPage({ task, resultMessage, sessionPath, url, promptText, productRefs, detailResult: result, detailTaskId: taskId })
    } catch (error) {
      resultMessage.businessPending = false; resultMessage.businessPhase = '失败'; resultMessage.businessStatus = 'FAILED'; resultMessage.isError = true; resultMessage.content = errorText(error) || '一键详情页失败'; resultMessage.businessProgress = '本次任务未完成，可修正素材或登录状态后重新发送'; await persistBusinessMessage(sessionPath, resultMessage); renderApp()
    } finally { releaseSessionSkill(pendingKey, sessionPath); scheduleQueueDrain() }
  }

  async function continueOneClickDetailPageSkill(task, previousMessage) {
    const pendingKey = state.sessionPath || '__pending__'
    let sessionPath = pendingKey
    const userMessage = { id: task.id, role: 'user', content: task.content, attachments: task.attachments, createdAt: Number(task.createdAt || Date.now()) }
    insertTimelineMessage(userMessage); upsertMediaTimelineMessage(pendingKey, userMessage)
    // 续作属于本次用户回合；只继承任务数据，不改写上一轮卡片或沿用旧计时。
    const inheritedResult = JSON.parse(JSON.stringify(previousMessage.businessResult || {}))
    delete inheritedResult.continuedBy
    const pendingMessage = {
      id: `${task.id}:result`, role: 'assistant', createdAt: userMessage.createdAt + 0.5, startedAt: Date.now(),
      businessSkill: 'detail-reference', businessPending: true, businessPhase: '整理客户素材', businessStatus: 'PROCESSING', isError: false,
      businessProgress: '正在读取客户产品图片并继续详情页生成…', content: '正在读取产品参考图并继续生成…',
      businessResult: { ...inheritedResult, originalRequestId: inheritedResult.originalRequestId || String(previousMessage.id || '').replace(/:result$/, '') },
      businessAssets: (previousMessage.businessAssets || []).map((item) => ({ ...item })),
      attachments: (previousMessage.attachments || []).map((item) => ({ ...item })),
      artifactCwd: previousMessage.artifactCwd || effectiveWorkspace()
    }
    upsertTimelineMessage(pendingMessage); upsertMediaTimelineMessage(pendingKey, pendingMessage)
    state.skillBusy = 'detail-reference'; renderApp(); updateLiveUi(true)
    try {
      await ensureMediaSession({ startAgent: false }); sessionPath = state.sessionPath
      setSessionSkill(sessionPath, 'detail-reference')
      await persistBusinessMessage(sessionPath, pendingMessage)
      previousMessage.businessResult = { ...previousMessage.businessResult, continuedBy: pendingMessage.id }
      await persistBusinessMessage(sessionPath, previousMessage)
      let productAttachments = (task.attachments || []).filter((item) => item?.kind === 'image' && attachmentBase64Data(item))
      if (productAttachments.length) pendingMessage.businessResult.productMessageId = task.id
      if (!productAttachments.length) {
        const rows = state.mediaMessages[sessionPath] || []
        const originalId = pendingMessage.businessResult.originalRequestId
        const originalIndex = rows.findIndex((item) => item.role === 'user' && item.id === originalId)
        const priorProduct = rows.find((item) => item.id === pendingMessage.businessResult.productMessageId)
          || rows.slice(Math.max(0, originalIndex)).filter((item) => item.role === 'user').reverse().find((item) => item.attachments?.some((image) => image.kind === 'image' && attachmentBase64Data(image)))
        productAttachments = priorProduct?.attachments || []
        if (priorProduct) pendingMessage.businessResult.productMessageId = priorProduct.id
      }
      const productRefs = productAttachments.filter((item) => item?.kind === 'image' && attachmentBase64Data(item)).slice(0, 3).map((item) => ({ data: attachmentBase64Data(item), name: item.name, mimeType: item.mimeType || 'image/png' }))
      if (!productRefs.length) {
        pendingMessage.businessPending = false
        pendingMessage.finishedAt = Date.now()
        pendingMessage.businessPhase = '等待客户素材'
        pendingMessage.businessStatus = 'WAITING_INPUT'
        pendingMessage.businessProgress = '当前消息没有图片附件，请用左下角“+”添加客户产品图片后直接发送。'
        pendingMessage.content = '我没有收到产品图片附件。请把产品图片作为图片上传后直接发送，不需要重新贴商品链接或再次输入技能名。'
        await persistBusinessMessage(sessionPath, pendingMessage); renderApp(); return
      }

      const detailTaskId = String(pendingMessage.businessResult?.detailTaskId || '')
      let detailResult = null
      let url = String(pendingMessage.businessResult?.detailUrl || '')
      let promptText = String(pendingMessage.businessResult?.detailPrompt || '')
      if (detailTaskId) {
        const saved = await window.anyu.letaAgentDetailStatus(detailTaskId)
        if (businessStatus(saved) !== 'OK') throw new Error(businessText(businessPayload(saved).message, '之前的详情页采集已失效，请重新发送商品链接'))
        detailResult = businessPayload(saved)
      } else {
        const savedAssets = Array.isArray(pendingMessage.businessAssets) ? pendingMessage.businessAssets : []
        if (savedAssets.some((asset) => attachmentBase64Data(asset))) {
          detailResult = {
            ok: true,
            code: 'OK',
            imageCount: Number(pendingMessage.businessResult?.referenceCount || savedAssets.length),
            images: savedAssets.map((asset, index) => ({
              id: asset.id || `tmall-detail-${index + 1}`,
              name: asset.name || `淘宝详情图 ${index + 1}`,
              sourceUrl: asset.sourceUrl || asset.url,
              mimeType: asset.mimeType || 'image/jpeg',
              dataUrl: asset.dataUrl || asset.data
            })),
            sourceUrls: pendingMessage.businessResult?.sourceUrls || savedAssets.map((asset) => asset.sourceUrl || asset.url).filter(Boolean)
          }
        } else {
          const rows = state.mediaMessages[sessionPath] || []
          const originalId = pendingMessage.businessResult.originalRequestId
          const original = rows.find((item) => item?.role === 'user' && item.id === originalId)
          const originalText = String(original?.content || '')
          url = url || originalText.match(/https:\/\/(?:[^\s/]+\.)?(?:taobao\.com|tmall\.com)\/[^\s]+/i)?.[0] || ''
          promptText = promptText || businessPrompt(originalText, 'detail-reference')
          if (!url) throw new Error('找不到原商品链接，请重新发送 @一键详情页 和商品链接')
          const created = await window.anyu.letaAgentDetailCollect({ url, maxImages: 24, includeData: true, maxImageBytes: 8 * 1024 * 1024 })
          const restoredTaskId = businessTaskId(created)
          let status = created
          const started = Date.now()
          while (restoredTaskId && Date.now() - started < 10 * 60 * 1000) {
            status = await window.anyu.letaAgentDetailStatus(restoredTaskId)
            if (businessStatus(status) === 'OK') break
            if (['FAILED', 'CANCELLED', 'ERROR'].includes(businessStatus(status))) throw new Error(businessText(businessPayload(status).message, '详情页参考图恢复失败'))
            await new Promise((resolve) => window.setTimeout(resolve, 1800))
          }
          if (businessStatus(status) !== 'OK') throw new Error('详情页参考图恢复超时，请重试商品链接采集')
          detailResult = businessPayload(status)
          pendingMessage.businessResult = { ...pendingMessage.businessResult, detailTaskId: restoredTaskId, detailUrl: url, detailPrompt: promptText }
        }
      }
      await finishOneClickDetailPage({ task, resultMessage: pendingMessage, sessionPath, url, promptText, productRefs, detailResult, detailTaskId })
    } catch (error) {
      pendingMessage.businessPending = false
      pendingMessage.finishedAt = Date.now()
      pendingMessage.businessPhase = '生成失败'
      pendingMessage.businessStatus = 'FAILED'
      pendingMessage.isError = true
      pendingMessage.businessProgress = '本次生图未完成，已保留详情参考图；直接重新发送产品图即可重试，不必重抓链接。'
      pendingMessage.content = errorText(error) || '一键详情页生成失败'
      if (error.taskTerminal && pendingMessage.businessResult) pendingMessage.businessResult = { ...pendingMessage.businessResult, imageTaskId: '' }
      await persistBusinessMessage(sessionPath, pendingMessage); renderApp()
    } finally { releaseSessionSkill(pendingKey, sessionPath); scheduleQueueDrain() }
  }

  async function runDetailReferenceSkill(task) {
    const promptText = businessPrompt(task.content, 'detail-reference')
    const url = String(promptText || task.content || '').match(/https:\/\/(?:[^\s/]+\.)?(?:taobao\.com|tmall\.com)\/[^\s]+/i)?.[0] || ''
    const pendingKey = state.sessionPath || '__pending__'
    let sessionPath = pendingKey
    const userMessage = { id: task.id, role: 'user', content: task.content, createdAt: Number(task.createdAt || Date.now()) }
    const resultMessage = { id: `${task.id}:result`, role: 'assistant', content: '正在准备淘宝详情图采集…', createdAt: userMessage.createdAt + 0.5, businessSkill: 'detail-reference', businessPending: true, businessPhase: '准备中', businessStatus: 'SUBMITTED', businessProgress: '正在打开商品详情页…' }
    insertTimelineMessage(userMessage); upsertMediaTimelineMessage(sessionPath, userMessage)
    insertTimelineMessage(resultMessage); upsertMediaTimelineMessage(sessionPath, resultMessage)
    state.skillBusy = 'detail-reference'; renderApp(); updateLiveUi(true)
    try {
      if (!url) throw new Error('请在 @淘宝详情 后提供淘宝或天猫商品详情链接')
      await ensureMediaSession(); sessionPath = state.sessionPath
      const created = await window.anyu.letaAgentDetailCollect({ url, maxImages: 24, includeData: true, maxImageBytes: 8 * 1024 * 1024 })
      const taskId = businessTaskId(created)
      let payload = created
      if (taskId) {
        const started = Date.now()
        while (Date.now() - started < 10 * 60 * 1000) {
          payload = await window.anyu.letaAgentDetailStatus(taskId)
          const status = businessStatus(payload)
          resultMessage.businessStatus = status
          resultMessage.businessPhase = ['WAITING_LOGIN', 'CHALLENGE_REQUIRED'].includes(status) ? '等待浏览器操作' : status === 'COLLECTING' ? '采集中' : '处理中'
          resultMessage.businessProgress = status === 'WAITING_LOGIN' ? '请在右侧浏览器完成淘宝登录后继续' : status === 'CHALLENGE_REQUIRED' ? '请在右侧浏览器完成安全验证后继续' : `已处理详情采集任务 ${status}`
          await persistBusinessMessage(sessionPath, resultMessage)
          if (status === 'OK') break
          if (['FAILED', 'CANCELLED', 'ERROR'].includes(status)) throw new Error(businessText(payload?.result?.message || payload?.message, '详情图片采集失败'))
          await new Promise((resolve) => window.setTimeout(resolve, 1800))
        }
      }
      const result = businessPayload(payload)
      const assets = Array.isArray(result.images) ? result.images.map((item) => ({ id: item.id, name: item.name, url: item.dataUrl || item.sourceUrl || item.url, sourceUrl: item.sourceUrl, mimeType: item.mimeType, data: item.dataUrl })) : []
      resultMessage.businessPending = false; resultMessage.businessPhase = '已完成'; resultMessage.businessStatus = 'OK'; resultMessage.businessProgress = `已抓取 ${assets.length} 张详情参考图，可继续用于我方详情页生成`; resultMessage.businessResult = { count: assets.length, sourceUrls: result.sourceUrls || assets.map((item) => item.sourceUrl) }; resultMessage.businessAssets = assets; resultMessage.content = `淘宝详情参考采集完成：${assets.length} 张。已保留公共 CDN 地址，可逐张上传到通用一键详情页.`
      await persistBusinessMessage(sessionPath, resultMessage); renderApp()
    } catch (error) {
      resultMessage.businessPending = false; resultMessage.businessPhase = '失败'; resultMessage.businessStatus = 'FAILED'; resultMessage.isError = true; resultMessage.content = errorText(error) || '淘宝详情参考采集失败'; resultMessage.businessProgress = '本次采集未完成，可检查右侧浏览器状态后重试'; await persistBusinessMessage(sessionPath, resultMessage); renderApp()
    } finally { releaseSessionSkill(pendingKey, sessionPath); scheduleQueueDrain() }
  }

  async function runImageAnalysisSkill(task) {
    const images = (task.attachments || []).filter((item) => item?.kind === 'image' && attachmentBase64Data(item)).slice(0, 50)
    const selectedModel = currentModel()
    const pendingKey = state.sessionPath || '__pending__'
    let sessionPath = pendingKey
    let resultMessage = null
    beginMediaActivity(pendingKey, task.id, 'image-analysis')
    state.skillBusy = 'image-analysis'; state.mediaBusyCount = Number(state.mediaBusyCount || 0) + 1; state.sessionLoadingPath = state.sessionPath || null; state.error = ''
    const userMessage = { id: task.id, role: 'user', content: task.content, attachments: task.attachments, createdAt: Number(task.createdAt || Date.now()) }
    resultMessage = { id: `${task.id}:result`, role: 'assistant', content: selectedModel ? `正在使用 ${selectedModel.name || selectedModel.modelId || selectedModel.id} 逐图分析…` : '正在准备图片…', createdAt: userMessage.createdAt + 0.5, businessSkill: 'image-analysis', businessPending: true, businessPhase: '准备中', businessProgress: '正在准备图片…' }
    insertTimelineMessage(userMessage)
    upsertMediaTimelineMessage(sessionPath, userMessage)
    upsertTimelineMessage(resultMessage)
    upsertMediaTimelineMessage(sessionPath, resultMessage)
    updateSessionTitle(task.content, userMessage.createdAt)
    renderApp(); updateLiveUi(true)
    try {
      if (!images.length) throw new Error('请先上传至少一张图片，再使用 @测图')
      const oldSessionKey = sessionPath
      await ensureMediaSession(); sessionPath = state.sessionPath
      state.sessionLoadingPath = sessionPath
      if (oldSessionKey !== sessionPath) {
        moveMediaActivity(oldSessionKey, sessionPath, task.id)
        const pendingMessages = state.mediaMessages[oldSessionKey] || []
        const currentMessages = state.mediaMessages[sessionPath] || []
        state.mediaMessages[sessionPath] = [...currentMessages, ...pendingMessages].slice(-100)
        delete state.mediaMessages[oldSessionKey]
      }
      if (!containsTimelineMessage(state.messages, userMessage)) insertTimelineMessage(userMessage)
      await persistBusinessMessage(sessionPath, resultMessage)
      if (!selectedModel) throw new Error('请先在模型目录里选择一个模型，再使用 @测图')
      const created = await window.anyu.letaAgentImageAnalysis({ prompt: businessPrompt(task.content, 'image-analysis'), model: { provider: selectedModel.provider, model: selectedModel.modelId || selectedModel.id }, images: images.map((item) => ({ name: item.name, mimeType: item.mimeType, data: attachmentBase64Data(item) })) })
      const createdId = businessTaskId(created)
      let analysis = createdId ? await pollLetaAgentTask(createdId, async (status) => { resultMessage.businessStatus = status; resultMessage.businessPhase = status === 'PROCESSING' ? '分析中' : '排队中'; resultMessage.businessProgress = status === 'PROCESSING' ? 'AI 正在逐图分析图片内容…' : '视觉任务排队中…'; resultMessage.content = 'AI 正在逐图分析，请稍候…'; await persistBusinessMessage(sessionPath, resultMessage) }) : businessPayload(created)
      const summary = imageAnalysisSummary(analysis)
      const raw = businessText(summary, '')
      const assets = analysis.assets || analysis.images || analysis.results || []
      // 解析成结构化排行；解析不了就退回原始文本，保证结果一定出得来。
      const report = imageAnalysisReport(raw, images.length)
      const text = report ? imageAnalysisHeadline(report) : businessText(summary, 'AI 测图已完成')
      const files = await writeBusinessArtifacts(effectiveWorkspace(), imageAnalysisArtifactFiles({ report, text: raw, assets, imageCount: images.length }))
      await openBusinessArtifact(files.find((file) => /\.html?$/i.test(String(file?.name || file?.path || ''))), effectiveWorkspace())
      resultMessage.businessPending = false; resultMessage.businessPhase = '已完成'; resultMessage.businessStatus = 'OK'; resultMessage.businessProgress = report ? '分析完成，排行榜已在右侧打开。' : '分析完成，结果已打开右侧预览。'; resultMessage.businessResult = { text, count: images.length, best: report?.best || 0, model: selectedModel.name || selectedModel.modelId || selectedModel.id }; resultMessage.businessAssets = assets; resultMessage.artifacts = files; resultMessage.content = `AI 测图完成：共 ${images.length} 张，已按六维加权打分生成排行。${text ? `\n${text}` : ''}`
      await persistBusinessMessage(sessionPath, resultMessage)
      if (state.sessionPath === sessionPath) { renderApp(); updateLiveUi(true) }
    } catch (error) {
      if (!resultMessage) resultMessage = { id: `${task.id}:result`, role: 'assistant', createdAt: Number(task.createdAt || Date.now()) + 0.5, businessSkill: 'image-analysis' }
      resultMessage.businessPending = false; resultMessage.businessPhase = '失败'; resultMessage.businessStatus = 'FAILED'; resultMessage.businessProgress = '本次测图未完成，可重新提交。'; resultMessage.isError = true; resultMessage.content = errorText(error) || 'AI 测图失败'
      await persistBusinessMessage(sessionPath, resultMessage)
      if (state.sessionPath === sessionPath) { renderApp(); updateLiveUi(true) }
    } finally {
      state.mediaBusyCount = Math.max(0, Number(state.mediaBusyCount || 1) - 1); endMediaActivity(sessionPath, task.id); releaseSessionSkill(pendingKey, sessionPath); if (!state.mediaBusyCount && state.sessionLoadingPath === sessionPath) state.sessionLoadingPath = null; scheduleSessionListRender(); scheduleQueueDrain()
    }
  }

  // 技能入口统一兜底：技能内部负责把可预期的工具错误写入结果卡，
  // 这里只处理意外的编程/IPC 异常，释放会话锁并恢复普通对话队列。
  function launchSkillTask(task, runner, fallback) {
    void Promise.resolve().then(() => runner(task)).catch((error) => {
      releaseSessionSkill(task?.sessionPath || state.sessionPath || '__pending__')
      state.error = errorText(error) || fallback
      renderApp()
      scheduleQueueDrain()
    })
  }

  async function runTask(task) {
    // 任务创建时固定会话归属；切换会话期间不得把旧任务投递到新会话。
    const requestedTaskSession = String(task?.sessionPath || '')
    const taskSessionPath = requestedTaskSession && requestedTaskSession !== '__pending__' ? requestedTaskSession : String(state.sessionPath || '')
    if (task && taskSessionPath && state.sessionPath !== taskSessionPath) {
      const key = queueSessionKey(taskSessionPath)
      const list = Array.isArray(state.sessionQueues[key]) ? state.sessionQueues[key] : []
      if (!list.some((item) => item?.id === task.id)) list.unshift(task)
      state.sessionQueues[key] = list
      return
    }
    // 普通 Agent 和业务技能共用同一条队列，技能运行时不得并发启动第二个任务。
    if (!task || state.loading || state.skillBusy) {
      if (task) {
        state.queuedTasks.unshift(task)
        // 入队必须立刻可见，否则用户会觉得“发送没反应”。
        renderApp()
        scheduleQueueDrain()
      }
      return
    }
    // 队列中的气泡仅在队列面板展示。进入真正执行阶段后，先移除可能由
    // 恢复/旧版本留下的队列占位，再由业务技能或普通消息入口插入唯一正式气泡。
    removeTimelineMessageById(task.id)
    const prompt = document.querySelector('#prompt')
    const payload = taskPayload(task)
    // 任务可能在等待 Pi 启动期间切换会话，先固定本任务的工作目录，避免回调读取到新会话上下文。
    const taskCwd = String(state.sessionCwd || state.cwd || effectiveWorkspace() || '')
    const businessSkill = businessSkillForPrompt(task.content)
    const oneClickTimeline = timelineMessagesUnique([
      ...(state.mediaMessages[taskSessionPath] || []),
      ...(state.sessionPath === taskSessionPath ? state.messages : [])
    ])
    const pendingOneClick = findPendingOneClickDetail(oneClickTimeline)
    const isOneClickContinuation = !businessSkill && pendingOneClick && isOneClickDetailFollowup(task)
    // 技能依赖主进程的活动运行时（模型默认值 / 启动环境）：新会话的后台懒启动
    // 没落地前先汇入同一个启动入口等它；并发调用共享 Promise，不会双开进程。
    // 普通消息不走这里——消息要先上屏，进程等待放在下面 try 里。
    let startedResult = null
    const requiresPiStartup = businessSkill !== 'detail-reference' && !isOneClickContinuation
    if (!requiresPiStartup && agentStartPromise) await agentStartPromise.catch(() => null)
    if (requiresPiStartup && (state.pendingNewAgent || agentStartPromise)) {
      try { startedResult = await ensureAgentStarted() } catch (error) {
        // 启动故障不能进入 Pi 上下文，也不能让技能 Promise 变成未处理异常。
        // 原任务保留在当前会话队列，用户修复登录/进程后可以继续发送。
        state.queuedTasks.unshift(task)
        state.error = errorText(error) || 'Agent 启动失败，任务已保留在队列'
        state.composerText = ''
        renderApp()
        return
      }
    }
    if (businessSkill && !businessPlugin(businessSkill)) {
      state.attachments = [...payload.attachments, ...state.attachments]
      const names = { feedback: '淘宝评价分析', 'image-analysis': 'AI 测图', 'detail-reference': '一键详情页', 'shop-monitor': '店铺分析' }
      state.error = `请先在插件市场安装并启用${names[businessSkill] || businessSkill}。`
      renderApp()
      return
    }
    if (businessSkill === 'detail-reference') {
      const detailUrl = String(businessPrompt(task.content, 'detail-reference') || task.content || '').match(/https:\/\/(?:[^\s/]+\.)?(?:taobao\.com|tmall\.com)\/[^\s]+/i)?.[0]
      if (pendingOneClick && !detailUrl && isOneClickDetailFollowup(task)) {
        launchSkillTask(task, (value) => continueOneClickDetailPageSkill(value, pendingOneClick), '一键详情页继续执行失败')
        return
      }
      launchSkillTask(task, runOneClickDetailPageSkill, '一键详情页执行失败')
      return
    }
    if (businessSkill === 'feedback') {
      launchSkillTask(task, runFeedbackSkill, '评价分析执行失败')
      return
    }
    if (businessSkill === 'shop-monitor') {
      launchSkillTask(task, runShopMonitorSkill, '店铺监控执行失败')
      return
    }
    if (businessSkill === 'image-analysis') {
      launchSkillTask(task, runImageAnalysisSkill, 'AI 测图执行失败')
      return
    }
    if (pendingOneClick && isOneClickDetailFollowup(task)) {
      launchSkillTask(task, (value) => continueOneClickDetailPageSkill(value, pendingOneClick), '一键详情页继续执行失败')
      return
    }
    if (autoEditForPrompt(task.content)) {
      void runAutoEditSkill(task).catch((error) => { state.error = errorText(error) || '自动剪辑失败'; renderApp() })
      return
    }
    const mediaSkill = mediaSkillForPrompt(task.content)
    if (mediaSkill) {
      void runMediaSkill(task, mediaSkill).catch((error) => { state.error = errorText(error) || '技能执行失败'; renderApp() })
      return
    }
    // 新会话可能还在后台拉起进程：这里先让用户消息立刻上屏（下面 insertTimelineMessage），
    // 进程就绪后再发 prompt。sessionPath 用 let：启动落地后要重新对齐。
    let sessionPath = taskSessionPath || state.sessionPath
    const message = { id: task.id, role: 'user', content: payload.content, attachments: payload.attachments }
    state.activeRequest = { ...payload, taskId: task.id }; state.retryNotice = ''; state.runInProgress = false
    message.createdAt = Number(task.createdAt || Date.now())
    state.loading = true; state.sessionLoadingPath = sessionPath || null; state.runStartedAt = Date.now(); state.error = ''; insertTimelineMessage(message); updateSessionTitle(payload.content, message.createdAt); state.composerText = ''; if (prompt) prompt.value = ''
    // 发送后左侧立刻出现该会话并标记为运行中，不用等任务结束才刷新列表。
    markSessionRun(sessionPath, { running: true, unread: false })
    // Pi 进程已常驻时，发送只需刷新消息区和发送按钮；完整重建应用 DOM
    // 会阻塞主线程并延迟 prompt 写入，影响首个增量到达时间。
    updateLiveUi(true); startRunMonitor(); scheduleSessionListRender()
    try {
      // 新建会话的后台启动可能还在路上：先汇入同一个入口等它落地，
      // 否则 prompt 带着 sessionKey=null 会被路由到别的会话进程上。
      if (agentStartPromise) startedResult = await agentStartPromise
      if (state.pendingAgentRestart) {
        // 在上一条任务结束后才重启 Pi，让新模型和分组从本条任务生效。
        state.piState = null
        await startAgent(state.sessionPath)
      } else if (!state.piState) startedResult = await ensureAgentStarted()
      // 后台启动会把匿名会话对齐到真实 sessionFile，这里必须取对齐后的路径。
      sessionPath = startedResult?.sessionPath || state.sessionPath || taskSessionPath || sessionPath
      // 新会话的首条消息可能还没进入 Pi 的 .jsonl；先把真实路径和标题登记到
      // 侧栏，再保存乐观消息侧车，切换会话时不会等模型首个回复才出现。
      upsertSessionListEntry(sessionPath, payload.content, message.createdAt, taskCwd)
      markSessionRun(sessionPath, { running: true, unread: false })
      if (state.sessionPath === sessionPath) state.sessionLoadingPath = sessionPath
      state.optimisticMessages[sessionPath] = message
      await window.anyu.piSaveOptimisticMessage?.({ sessionPath, cwd: taskCwd || undefined, message })
      scheduleSessionListRender()
      // 主进程列表在读到 sidecar 后会返回正式条目；即使这次刷新撞在 Pi
      // 写入窗口之前，也用本地条目兜底，避免刷新把刚发送的会话抹掉。
      void refreshSessions().then(() => {
        upsertSessionListEntry(sessionPath, payload.content, message.createdAt, taskCwd)
        markSessionRun(sessionPath, { running: true, unread: false })
        scheduleSessionListRender()
      }).catch(() => {})
      await persistImageAttachments(payload, payload.content + payload.attachmentText)
      await window.anyu.piCommand({ type: 'prompt', sessionKey: sessionPath, message: payload.content + payload.attachmentText, images: payload.images.length ? payload.images : undefined })
    } catch (error) { finishRequestWithError(error) }
  }
  async function sendMessage() {
    const prompt = document.querySelector('#prompt'); const typed = prompt?.value.trim() || state.composerText.trim() || ''
    if ((!typed && !state.attachments.length)) return
    const submittedAttachments = state.attachments.splice(0)
    const task = { id: taskId(), content: typed, attachments: submittedAttachments, createdAt: Date.now(), sessionPath: state.sessionPath || null }
    if (state.loading || state.skillBusy) {
      // 会话正在跑任务或技能：进这个会话自己的队列，并且立刻显示出来。
      // 之前只有 state.loading 会走这里，技能（测图）运行时走到 runTask
      // 才静默 unshift，既不清输入框也不渲染，看起来就是“发了没反应”。
      state.queuedTasks.push(task); state.queueMenuId = null; state.error = ''
      state.composerText = ''; if (prompt) prompt.value = ''
      renderApp()
      scheduleQueueDrain()
      requestAnimationFrame(() => document.querySelector('#prompt')?.focus())
      return
    }
    await runTask(task)
  }

  // 后台会话的事件不进当前视图：只更新左侧列表的“运行中 / 已完成未读”状态，
  // 这样多个会话可以同时跑，切走再切回来也不会被别人的输出串屏。
  function handleBackgroundSessionEvent(event, sessionPath) {
    const type = event?.type
    if (type === 'agent_start' || type === 'turn_start' || type === 'auto_retry_start' || type === 'message_update') {
      markSessionRun(sessionPath, { running: true, unread: false })
      scheduleSessionListRender()
      return
    }
    if (type === 'agent_end') {
      // 一个回合结束不等于任务结束，后面可能还有重试或压缩，等 agent_settled。
      markSessionRun(sessionPath, { running: true, unread: false })
      return
    }
    if (type === 'agent_settled') {
      markSessionRun(sessionPath, { running: false, unread: true })
      scheduleSessionListRender()
      return
    }
    if (type === 'session_info_changed') {
      refreshSessions().then(() => scheduleSessionListRender()).catch(() => {})
      return
    }
    if (type === 'extension_ui_request') {
      if (event.method === 'confirm' && effectivePermissionMode() === 'full') { window.anyu.piUiResponse({ id: event.id, confirmed: true, sessionKey: sessionPath }); return }
      markSessionRun(sessionPath, { running: true, unread: true, needsAttention: true })
      scheduleSessionListRender()
      return
    }
  }

  function handlePiEvent(event) {
    if (!event || event.type === 'response') return
    if ((event.type === 'thinking_level_changed' || event.type === 'thinking_level_change') && THINKING_LEVELS.includes(event.level)) {
      state.thinkingLevel = event.level
      localStorage.setItem(thinkingStorageKey(), event.level)
      scheduleAppRender()
      return
    }
    const eventSession = normalizeSessionKey(event.sessionKey)
    if (eventSession && eventSession !== normalizeSessionKey(state.sessionPath)) {
      handleBackgroundSessionEvent(event, eventSession)
      return
    }
    if (state.sessionSwitching) return
    if (event.type === 'message_start') {
      const message = event.message || event.assistantMessage
      if (message?.role === 'assistant') {
        if (state.streamingMessage) finishStreamingMessage(state.streamingMessage)
        state.streamingMessage = { id: message.id || message.messageId || event.messageId || undefined, role: 'assistant', content: '', thinking: thinkingOf(message.content), createdAt: timestampValue(message.timestamp) || Date.now(), isStreaming: true }
        insertTimelineMessage(state.streamingMessage)
        scheduleLiveUi(false)
      }
      return
    }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent || event.messageEvent || event.delta || event.update
      let delta = ''
      if (typeof update === 'string') delta = update
      else if (update?.type === 'thinking_delta') {
        if (state.streamingMessage) state.streamingMessage.thinking = `${state.streamingMessage.thinking || ''}${update.delta || ''}`
        scheduleLiveUi(false); return
      } else if (update?.type === 'text_delta' || update?.type === 'text') delta = update.delta || update.text || ''
      else if (typeof update?.delta === 'string') delta = update.delta
      if (delta && state.streamingMessage) {
        state.streamingMessage.content += delta
        scheduleLiveUi(false)
      }
      return
    }
    if (event.type === 'message_end' && event.message) {
      if (event.message.role === 'assistant') {
        const content = textOf(event.message.content) || event.message.errorMessage || ''
        const hasError = Boolean(event.message.errorMessage)
        if (state.streamingMessage) {
          const stream = state.streamingMessage
          stream.id = stream.id || event.message.id || event.message.messageId
          const finalThinking = thinkingOf(event.message.content)
          if (finalThinking && !stream.thinking) stream.thinking = finalThinking
          stream.content = content || stream.content
          stream.isError = hasError
          finishStreamingMessage(stream)
          void inspectMessageArtifacts(stream).then(() => scheduleLiveUi(false))
        }
        else {
          const completed = { id: event.message.id || event.message.messageId, role: 'assistant', content, thinking: thinkingOf(event.message.content), createdAt: timestampValue(event.message.timestamp) || Date.now(), finishedAt: Date.now(), isError: hasError }
          insertTimelineMessage(completed)
          void inspectMessageArtifacts(completed).then(() => scheduleLiveUi(false))
        }
        // Pi owns retry policy. Re-sending the prompt here would duplicate a user
        // request when Pi retries an overloaded upstream provider. The failure
        // remains visible in the conversation while agent_end decides whether it
        // is final or will be retried.
        scheduleLiveUi(false)
      }
      if (event.message.role === 'user' && event.message.id) {
        const optimistic = state.optimisticMessages[state.sessionPath]
        if (optimistic && (optimistic.id === event.message.id || optimistic.content === textOf(event.message.content))) {
          delete state.optimisticMessages[state.sessionPath]
          void window.anyu.piClearOptimisticMessage?.(state.sessionPath).catch(() => {})
        }
      }
      return
    }
    if (event.type === 'tool_execution_start') {
      const toolCallId = event.toolCallId || event.id
      const existing = toolCallId ? [...state.messages].reverse().find((message) => message.role === 'tool' && message.toolCallId === toolCallId) : null
      if (existing) {
        if (!existing.finishedAt) Object.assign(existing, { toolName: event.toolName || existing.toolName, args: event.args || existing.args, isStreaming: true, startedAt: existing.startedAt || Date.now() })
      } else insertTimelineMessage({ id: toolCallId, role: 'tool', toolName: event.toolName, toolCallId, args: event.args || {}, content: '', createdAt: Date.now(), isStreaming: true, startedAt: Date.now() })
      scheduleLiveUi(false)
      return
    }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const result = event.partialResult || event.result
      const output = textOf(result?.content || result?.output || '') || (typeof result === 'string' ? result : '')
      const toolCallId = event.toolCallId || event.id
      let item = [...state.messages].reverse().find((message) => message.role === 'tool' && ((toolCallId && message.toolCallId === toolCallId) || (!toolCallId && message.isStreaming && message.toolName === event.toolName)))
      if (!item) {
        item = { id: toolCallId, role: 'tool', toolName: event.toolName, toolCallId, args: event.args || {}, content: '', createdAt: Date.now(), startedAt: Date.now(), isStreaming: true }
        insertTimelineMessage(item)
      }
      item.args = event.args || item.args
      if (item.toolName === 'browser_open' && result?.details?.path) item.args = { ...item.args, path: result.details.path }
      item.content = output || item.content
      item.isError = Boolean(event.isError)
      item.isStreaming = event.type !== 'tool_execution_end'
      if (!item.isStreaming) {
        item.finishedAt = Date.now()
        void inspectMessageArtifacts(item).then(() => scheduleLiveUi(false))
      }
      scheduleLiveUi(false)
      return
    }
    if (event.type === 'extension_ui_request') {
      if (event.method === 'confirm' && effectivePermissionMode() === 'full') { window.anyu.piUiResponse({ id: event.id, sessionKey: state.sessionPath, confirmed: true }); return }
      if (['confirm', 'select', 'input'].includes(event.method)) { state.permission = event; renderApp() }
      return
    }
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      state.loading = true
      if (!state.runStartedAt) state.runStartedAt = Date.now()
      state.runInProgress = true
      if (!state.runPoll) startRunMonitor()
      state.retryNotice = ''
      scheduleLiveUi(false)
      return
    }
    if (event.type === 'agent_end') {
      if (event.willRetry) {
        state.retryNotice = '模型服务暂时不可用，Pi 正在自动重试…'
        state.error = ''
      } else {
        state.retryNotice = ''
        const lastAssistant = [...state.messages].reverse().find((message) => message.role === 'assistant')
        if (lastAssistant?.isError) state.error = lastAssistant.content || '模型回复失败，请稍后重试或切换模型'
      }
      // agent_end 只代表一个底层回合结束，后面可能还有重试、压缩或排队消息。
      // 必须等 Pi 发出 agent_settled 才释放任务状态，避免输出被提前截断。
      scheduleLiveUi(false)
      return
    }
    if (event.type === 'auto_retry_start') {
      state.loading = true
      state.retryNotice = `模型服务暂时不可用，Pi 正在自动重试（${event.attempt || 1}/${event.maxAttempts || 3}）…`
      scheduleLiveUi(false)
      return
    }
    if (event.type === 'agent_settled') {
      finishAgentRun()
      return
    }
    if (event.type === 'session_info_changed') { refreshSessions().then(() => scheduleAppRender()); return }
  }
  window.anyu.onPiEvent(handlePiEvent)
  window.anyu.onBrowserState?.((browser) => {
    const wasOpen = Boolean(state.browser?.open)
    state.browser = { ...state.browser, ...(browser || {}) }
    if (wasOpen !== Boolean(state.browser.open) || !document.querySelector('.agent-browser-bar')) { scheduleAppRender(); return }
    const bar = document.querySelector('.agent-browser-bar')
    const title = bar?.querySelector('strong')
    const detail = bar?.querySelector('small')
    if (title) title.textContent = state.browser.title || '内置浏览器'
    if (detail) detail.textContent = state.browser.loading ? '加载中…' : state.browser.error || state.browser.url || ''
    if (bar?.querySelector('[data-browser-back]')) bar.querySelector('[data-browser-back]').disabled = !state.browser.canGoBack
    if (bar?.querySelector('[data-browser-forward]')) bar.querySelector('[data-browser-forward]').disabled = !state.browser.canGoForward
    if (bar?.querySelector('[data-browser-external]')) bar.querySelector('[data-browser-external]').hidden = !/^https?:\/\//i.test(state.browser.url || '')
  })
  window.anyu.onPluginProgress?.((event) => {
    const operation = event || {}
    const operationId = String(operation.operationId || '')
    if (!operationId) return
    state.pluginOperations[operationId] = { ...operation, updatedAt: Date.now() }
    // 安装/依赖进度可能每秒触发数十次；仅在插件页可见时节流刷新，
    // 其他页面保留状态但不重建整个应用壳。
    if (state.settingsOpen && state.settingsSection === 'plugins') {
      state.pluginProgressRenderPending = true
      if (!state.pluginProgressRenderTimer) state.pluginProgressRenderTimer = window.setTimeout(() => { state.pluginProgressRenderTimer = null; state.pluginProgressRenderPending = false; scheduleAppRender() }, 120)
    }
    if (['complete', 'error', 'dependency-ready', 'dependency-manual'].includes(operation.phase)) {
      void window.anyu.pluginState().then((plugins) => {
        state.pluginState = { ...state.pluginState, installed: plugins?.installed || [] }
        if (state.settingsOpen && state.settingsSection === 'plugins') scheduleAppRender()
      }).catch(() => {})
      window.setTimeout(() => {
        if (state.pluginOperations[operationId]?.phase === operation.phase) {
          delete state.pluginOperations[operationId]
          if (state.settingsOpen && state.settingsSection === 'plugins') scheduleAppRender()
        }
      }, 2200)
    }
  })
  window.anyu.onUpdateProgress?.((event) => {
    const update = event || {}
    if (update.phase === 'downloading') state.update = { ...state.update, status: 'downloading', latestVersion: update.version || state.update.latestVersion, percent: Number(update.percent || 0) }
    else if (update.phase === 'installing') state.update = { ...state.update, status: 'ready', latestVersion: update.version || state.update.latestVersion, percent: 100, message: update.message || '安装包已打开，请确认覆盖安装' }
    else if (update.phase === 'ready') state.update = { ...state.update, status: 'ready', latestVersion: update.version || state.update.latestVersion, percent: 100, message: update.message || '安装包已打开，请确认覆盖安装' }
    else if (update.phase === 'error') state.update = { ...state.update, status: 'error', message: update.message || '自动更新失败' }
    updateUpdateControl()
  })
  if (window.anyu.updateState) {
    window.anyu.updateState().then((update) => {
      if (!update || !['error', 'ready'].includes(update.status)) return
      state.update = { ...state.update, ...update, message: update.message || (update.status === 'ready' ? '安装包已下载，请确认覆盖安装' : '上次更新失败') }
      scheduleAppRender()
    }).catch(() => {})
  }
  window.anyu.onPiExit((payload) => {
    const exitedSession = normalizeSessionKey(payload?.sessionKey)
    // 后台会话的进程退出只影响那一条会话，不能清掉当前视图的任务状态。
    if (exitedSession && exitedSession !== normalizeSessionKey(state.sessionPath)) {
      markSessionRun(exitedSession, { running: false })
      scheduleSessionListRender()
      return
    }
    clearActiveRequest(); state.piState = null; state.loading = false
    if (state.sessionPath) markSessionRun(state.sessionPath, { running: false })
    for (const message of state.messages) if (message.isStreaming) finishStreamingMessage(message)
    if (state.sessionSwitching) return
    state.error = 'Pi Agent 进程已退出，请刷新重试'
    if (state.user) renderApp()
  })
  // Pi 启动失败时 stderr 会连续刷同类错误（扩展加载失败、连接被拒等），
  // 以前每一条都改写 state.error 并触发整壳重建。可见窗口下这等于按帧率
  // 上限持续重建整个应用 DOM，界面会被拖到点不动。这里做去重 + 最小间隔：
  // 内容没变不重渲染，内容变了也最多每 700ms 刷新一次错误条。
  let stderrNoticeText = ''
  let stderrNoticeAt = 0
  window.anyu.onPiStderr((message) => {
    if (!/error|failed|exception/i.test(message) || state.loading) return
    const text = message.trim().slice(-500)
    if (!text || text === stderrNoticeText) return
    const now = Date.now()
    if (now - stderrNoticeAt < STDERR_NOTICE_INTERVAL_MS) return
    stderrNoticeText = text
    stderrNoticeAt = now
    state.error = text
    scheduleAppRender()
  })
  render()
  ;(async () => {
    try {
      const current = await window.anyu.authState()
      state.authChecking = false
      if (current.authenticated) {
        state.user = current.user
        await bootstrap()
        try {
          const info = await window.anyu.checkForUpdate()
          state.update = { ...state.update, ...info, status: info.available ? 'available' : 'latest', percent: 0 }
        } catch {}
      }
    } catch (error) { state.authChecking = false; state.error = error.message || '' }
    render()
  })()
})()
