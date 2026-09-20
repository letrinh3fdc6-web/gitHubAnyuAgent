(() => {
  const root = document.querySelector('#app')
  const mediaObjectUrls = new Map()
  const savedPermissionMode = localStorage.getItem('anyu.permissionMode')
  const permissionModeWasSelected = localStorage.getItem('anyu.permissionMode.userSelected') === '1'
  const savedSelectedKey = Number(localStorage.getItem('anyu.selectedKey') || 0)
  const savedAccessMode = localStorage.getItem('anyu.accessMode')
  // 旧版本默认保存的是 confirm，新版本将其视为未主动选择，交给模型能力自动适配。
  const initialPermissionMode = permissionModeWasSelected && ['auto', 'confirm', 'full'].includes(savedPermissionMode) ? savedPermissionMode : 'auto'
  const state = {
    user: null, keys: [], keysLoaded: false, catalog: [], catalogSource: '', sessions: [], sessionPath: null,
    messages: [], mediaMessages: {}, mediaBusyCount: 0, mediaActivity: {}, attachments: [], imageLibrary: [], composerText: '', imageMenuOpen: false, imagePreview: null,
    selectedKey: savedSelectedKey,
    accessMode: ['auto', 'key'].includes(savedAccessMode) ? savedAccessMode : savedSelectedKey > 0 ? 'key' : 'auto',
    model: localStorage.getItem('anyu.selectedModel') || '', cwd: localStorage.getItem('anyu.cwd') || '', sessionCwd: null,
    thinkingLevel: localStorage.getItem('anyu.thinkingLevel') || 'medium', thinkingLevels: ['off'],
    loading: false, skillBusy: null, error: '', twoFactor: null, permission: null, piState: null,
    authChecking: true, authView: 'login', authBusy: false, authNotice: '', authSettings: null, authSettingsLoading: false,
    authCodeCooldownUntil: 0, authForm: { email: '', password: '', verifyCode: '', promoCode: '', invitationCode: '', resetEmail: '', resetToken: '', newPassword: '', confirmPassword: '' },
    activeRequest: null, retryNotice: '', runInProgress: false, runPoll: null,
    renderQueued: false, streamingMessage: null, forceScroll: false, appRenderQueued: false,
    settingsOpen: false, settingsSection: 'general', pluginMarketLoading: false, pluginMarketTab: 'marketplace', pluginMarketQuery: '', pluginMarketError: '', pluginPublishOpen: false, pluginPublishId: '', pluginPublishName: '', pluginPublishVisibility: 'public', pluginPublishLoading: false, pluginState: { installed: [], marketplace: [] },
    skillsMarketOpen: false, skillsLoading: false, skillGroups: [], skillMenuOpen: false, skillEnabled: { image: true, video: true },
    skillConfigs: { image: { groupId: 0, model: '', size: '1024x1024', quality: 'auto' }, video: { groupId: 0, model: '' } },
    switching: false, sessionSwitching: false, sessionLoadingPath: null, sessionSwitchToken: 0, balanceRefresh: null,
    update: { status: 'idle', currentVersion: '', latestVersion: '', percent: 0, message: '' },
    queuedTasks: [], queueMenuId: null, queueDraining: false, sessionMenu: null, composerCursor: null,
    permissionMode: initialPermissionMode, activePermissionMode: null
  }
  const api = (route, options) => window.anyu.request(route, options)
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  const initials = (email) => String(email || 'A').slice(0, 1).toUpperCase()
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
  const formatDuration = (milliseconds) => { const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 100) / 10); return seconds < 1 ? '< 1 秒' : `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒` }
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
    // Anyu 主流模型用于编码 Agent 时默认开放本机工具，未知模型仍保留确认。
    return /gpt|codex|openai|claude|anthropic|gemini|google|grok|qwen|deepseek|glm|kimi|mistral|moonshot|doubao|llama/.test(lower) ? 'full' : 'confirm'
  }
  function effectivePermissionMode() {
    return state.permissionMode === 'auto' ? (state.activePermissionMode || modelPermissionMode()) : state.permissionMode
  }
  function permissionModeLabel(mode = effectivePermissionMode()) {
    return mode === 'full' ? '⚡ 完整访问' : '✓ 受控访问'
  }
  const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const thinkingLevelLabel = (level) => ({ off: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' }[level] || level)
  function modelThinkingLevels(model = currentModel()) {
    if (!model?.reasoning) return ['off']
    const listed = Array.isArray(model.thinkingLevels) ? model.thinkingLevels.filter((level) => THINKING_LEVELS.includes(level)) : []
    if (listed.length) return [...new Set(listed)]
    const map = model.thinkingLevelMap
    if (map && typeof map === 'object') return THINKING_LEVELS.filter((level) => map[level] !== null && (level !== 'xhigh' && level !== 'max' || map[level] !== undefined))
    return ['off', 'minimal', 'low', 'medium', 'high']
  }
  function inferredReasoningConfig(id, api) {
    const lower = `${id || ''} ${api || ''}`.toLowerCase()
    const reasoning = /gpt-5|gpt-oss|\bo[134]\b|codex|claude-(?:3[-.]?7|4|fable)|gemini-(?:2\.5|3)|deepseek-(?:r1|v3\.2)|qwen3|glm-(?:4\.5|z1)|kimi-k2-thinking/.test(lower)
    if (!reasoning) return { reasoning: false, thinkingLevelMap: undefined }
    if (/gpt-5\.6|gpt-5\.5/.test(lower)) return { reasoning: true, thinkingLevelMap: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }
    if (/gpt-5|gpt-oss|\bo[134]\b|codex/.test(lower)) return { reasoning: true, thinkingLevelMap: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' } }
    return { reasoning: true, thinkingLevelMap: undefined }
  }
  function modelCapabilities(model, id = model?.id, api = model?.api) {
    const inputValues = [model?.input, model?.input_modalities, model?.modalities, model?.capabilities?.input, model?.capabilities?.input_modalities]
      .flatMap((value) => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,|]+/) : [])
      .map((value) => String(value).toLowerCase().trim()).filter(Boolean)
    const explicitFalse = [model?.supports_images, model?.supportsImages, model?.vision, model?.capabilities?.vision].some((value) => value === false)
    const hasImageValue = inputValues.some((value) => /image|vision|multimodal|photo|picture/.test(value))
    const lower = `${id || ''} ${model?.name || ''} ${api || ''}`.toLowerCase()
    const inferred = !explicitFalse && !/image-generation|image-edit|embedding|audio/.test(lower) && (
      /gemini|claude|anthropic|gpt-4o|gpt-4\.1|gpt-5|o[1-9]|vision|multimodal|vl|qwen2?\.5-vl|qwen3-vl|qvq|glm-4v|doubao-vision|kimi-vl|moonshot-v1-vision|internvl|pixtral|llava|ernie-4\.5/.test(lower)
    )
    const supportsImages = !explicitFalse && (hasImageValue || inferred)
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
    if (update.status === 'installing') return '正在安装并重启…'
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
    state.user = null; state.keys = []; state.keysLoaded = false; state.catalog = []; state.skillGroups = []; state.mediaMessages = {}; state.mediaActivity = {}; state.mediaBusyCount = 0; state.sessions = []; state.sessionPath = null; state.sessionCwd = null; state.messages = []; state.imageLibrary = []; state.attachments = []; state.composerText = ''; state.piState = null; state.loading = false; state.permission = null; state.settingsOpen = false; state.settingsSection = 'general'; state.keyMenuOpen = false; state.imageMenuOpen = false; state.skillMenuOpen = false; state.twoFactor = null; state.streamingMessage = null; state.queuedTasks = []; state.queueMenuId = null; state.queueDraining = false; state.authChecking = false; state.authView = 'login'; state.authNotice = ''; state.authBusy = false; state.authForm.password = ''
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
    root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="side-brand"><div class="brand-mark">A</div><div><strong>AnYuAgent</strong><span>独立 Pi Agent</span></div></div><div class="nav-section"><div class="nav-title">工作区</div><div class="nav-item active"><span class="nav-icon">✦</span>Agent 对话</div></div><div class="side-footer"><button class="settings-link" id="settings-open"><span class="nav-icon">⚙</span>设置</button><div class="user-line"><div class="avatar">${initials(state.user?.email)}</div><div class="user-email" title="${esc(state.user?.email)}">${esc(state.user?.email || 'Anyu 用户')}</div></div><button class="logout" id="logout">切换账号</button></div></aside><main class="main"><header class="topbar"><div class="topbar-title"><h2>Agent 对话</h2><span class="connection-dot offline"></span><span class="connection-label">等待密钥</span></div><div class="top-actions"><button class="icon-button" id="refresh" title="刷新密钥列表">↻</button>${windowControlsMarkup()}</div></header>${state.error ? `<div class="app-alert" role="status">${esc(state.error)}</div>` : ''}<section class="no-key-panel"><div class="no-key-icon">⌁</div><h2>还没有 API 密钥</h2><p>请先前往 Anyu 网站创建 API 密钥，创建后回到这里点击刷新。</p><div class="no-key-actions"><button class="primary no-key-primary" id="open-key-site">去 x.ailzd.com 创建密钥</button><button class="ghost" id="refresh-keys">我已创建，刷新密钥</button></div><p class="muted no-key-note">桌面端不会保存或展示你的密钥明文。</p></section></main></div>`
    document.querySelectorAll('[data-window-action]').forEach((node) => node.addEventListener('click', () => window.anyu.windowAction(node.dataset.windowAction)))
    document.querySelector('#open-key-site')?.addEventListener('click', () => window.anyu.openExternal('https://x.ailzd.com'))
    document.querySelector('#refresh-keys')?.addEventListener('click', async () => { await refreshKeysAndStart() })
    document.querySelector('#refresh')?.addEventListener('click', async () => { await refreshKeysAndStart() })
    document.querySelector('#logout')?.addEventListener('click', switchAccount)
    document.querySelector('#settings-open')?.addEventListener('click', () => { state.settingsOpen = true; state.settingsSection = 'general'; renderApp() })
  }
  async function refreshKeysAndStart() {
    state.error = ''; state.switching = true; renderApp()
    try {
      await loadKeys()
      if (!state.keys.length) return
      await loadSkillGroups(); state.catalog = await loadCatalogForKey(state.selectedKey); chooseModel(); ensureSkillSelection(); await startAgent(state.sessionPath)
    } catch (error) { state.error = errorText(error) || '密钥刷新失败' }
    finally { state.switching = false; renderApp() }
  }
  function renderLogin() {
    captureAuthForm()
    void loadAuthSettings()
    const two = state.twoFactor
    if (state.authChecking) {
      root.innerHTML = `<main class="login">${windowControlsMarkup('login-window-controls')}<section class="login-card auth-checking"><div class="brand"><div class="brand-mark">A</div><div><h1>AnYuAgent</h1><small>独立 Pi Agent 桌面客户端</small></div></div><div class="login-loading"><span class="spinner"></span><span>正在检查登录状态…</span></div><p class="muted" style="font-size:11px;margin-top:24px">正在连接 Anyu 账号服务</p></section></main>`
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
      content = `<h2>完成安全验证</h2><p class="muted">账号 ${esc(two.user_email_masked || '')} 已开启双重验证。</p><div class="field"><label for="totp">Authenticator 验证码</label><input id="totp" inputmode="numeric" maxlength="6" placeholder="输入 6 位验证码"></div><button class="primary" id="verify">进入 AnYuAgent</button>`
    } else if (view === 'register') {
      content = `<h2>注册 Anyu 账号</h2><p class="muted">注册后即可在桌面端登录并同步你的 API 密钥。</p>${registrationEnabled ? `<form id="auth-form">${authInput('email', 'email', form.email, 'Anyu 邮箱', 'name@example.com', 'email')}${authInput('password', 'password', form.password, '密码', '至少 6 位密码', 'new-password')}${authInput('confirm-password', 'password', form.confirmPassword, '确认密码', '再次输入密码', 'new-password')}${emailVerifyEnabled ? `<div class="field"><label for="verify-code">邮箱验证码</label><div class="inline-field"><input id="verify-code" inputmode="numeric" value="${esc(form.verifyCode)}" placeholder="输入邮箱验证码"><button type="button" class="ghost inline-action" id="send-code" ${cooldown ? 'disabled' : ''}>${cooldown ? `${cooldown}s 后重试` : '发送验证码'}</button></div></div>` : ''}${invitationEnabled ? authInput('invitation-code', 'text', form.invitationCode, '邀请码', '如网站要求，请填写邀请码') : ''}${promoEnabled ? authInput('promo-code', 'text', form.promoCode, '优惠码（可选）', '输入优惠码') : ''}<button class="primary" id="register" type="submit">注册并开始</button></form>` : `<div class="auth-notice">当前网站暂未开放注册，请前往 x.ailzd.com 完成注册。</div><button class="primary" id="open-site">打开网站注册</button>`}`
    } else if (view === 'forgot') {
      content = `<h2>找回密码</h2><p class="muted">输入注册邮箱，我们会发送密码重置链接。</p>${passwordResetEnabled && !passwordResetNeedsWebVerification ? `<form id="auth-form">${authInput('reset-email', 'email', form.resetEmail, '注册邮箱', 'name@example.com', 'email')}<button class="primary" id="forgot" type="submit">发送重置邮件</button></form>` : `<div class="auth-notice">${passwordResetNeedsWebVerification ? '网站已开启安全验证，请前往 x.ailzd.com 完成密码找回。' : '当前网站未开启密码找回，请前往 x.ailzd.com 操作。'}</div><button class="primary" id="open-site">打开网站找回密码</button>`}`
    } else if (view === 'reset') {
      content = `<h2>重置密码</h2><p class="muted">粘贴邮件中的重置令牌并设置新密码。</p><form id="auth-form">${authInput('reset-email', 'email', form.resetEmail, '注册邮箱', 'name@example.com', 'email')}${authInput('reset-token', 'text', form.resetToken, '重置令牌', '粘贴邮件中的 token')}${authInput('new-password', 'password', form.newPassword, '新密码', '至少 6 位密码', 'new-password')}${authInput('confirm-new-password', 'password', form.confirmPassword, '确认新密码', '再次输入新密码', 'new-password')}<button class="primary" id="reset" type="submit">更新密码</button></form>`
    } else {
      content = `<h2>登录 AnYuAgent</h2><p class="muted">登录后同步 Anyu 密钥，在本地 Pi Agent 中对话。</p><form id="auth-form">${authInput('email', 'email', form.email, 'Anyu 邮箱', 'name@example.com', 'username')}${authInput('password', 'password', form.password, '密码', '输入 Anyu 密码', 'current-password')}<button class="primary" id="login" type="submit">登录并开始</button></form>`
    }
    const links = two ? '' : `<div class="auth-links">${view !== 'login' ? '<button type="button" class="link-button" id="show-login">返回登录</button>' : ''}${view === 'login' && registrationEnabled ? '<button type="button" class="link-button" id="show-register">立即注册</button>' : ''}${view === 'login' && passwordResetEnabled ? '<button type="button" class="link-button" id="show-forgot">忘记密码？</button>' : ''}${view === 'forgot' ? '<button type="button" class="link-button" id="show-reset">已有重置令牌</button>' : ''}</div>`
    root.innerHTML = `<main class="login">${windowControlsMarkup('login-window-controls')}<section class="login-card"><div class="brand"><div class="brand-mark">A</div><div><h1>AnYuAgent</h1><small>独立 Pi Agent 桌面客户端</small></div></div>${content}${state.authNotice ? `<div class="auth-notice success">${esc(state.authNotice)}</div>` : ''}${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}${links}<p class="muted" style="font-size:11px;margin-top:24px">账号认证与网站一致 · Pi 会话只保存在本机</p></section></main>`
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
    document.querySelector('#open-site')?.addEventListener('click', () => window.anyu.openExternal(view === 'register' ? 'https://x.ailzd.com/register' : 'https://x.ailzd.com/forgot-password'))
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
  async function loadRouteData({ refreshPublicKeys = false } = {}) {
    // 自动分组只依赖 AnYuAgent 专用目录；公开密钥仅在密钥模式下按需读取。
    if (state.accessMode === 'key' && (refreshPublicKeys || !state.keysLoaded)) {
      await loadKeys()
      if (!state.keys.length) {
        state.accessMode = 'auto'
        state.selectedKey = 0
        localStorage.setItem('anyu.accessMode', state.accessMode)
        localStorage.setItem('anyu.selectedKey', '')
      }
    }
    await loadSkillGroups()
    state.catalog = state.accessMode === 'key'
      ? await loadCatalogForKey(state.selectedKey)
      : (await loadCatalog()).filter((model) => model.groupId > 0)
    if (!state.catalog.length) throw new Error('当前账号没有可用于 AnYuAgent 的聊天分组和模型')
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
    const rawMap = model?.thinkingLevelMap || model?.thinking_level_map || model?.reasoning_effort_map || model?.reasoningEffortMap
    const rawLevels = model?.thinkingLevels || model?.thinking_levels || model?.reasoning_levels || model?.reasoningLevels
    const inferredReasoning = inferredReasoningConfig(modelId, api)
    const reasoning = Boolean(model?.reasoning || rawMap || (Array.isArray(rawLevels) && rawLevels.length) || inferredReasoning.reasoning)
    const thinkingLevels = Array.isArray(rawLevels) ? rawLevels.map((level) => String(level).toLowerCase()).filter((level) => THINKING_LEVELS.includes(level)) : undefined
    const thinkingLevelMap = rawMap && typeof rawMap === 'object' ? rawMap : thinkingLevels?.length ? Object.fromEntries(THINKING_LEVELS.map((level) => [level, thinkingLevels.includes(level) ? level : null])) : inferredReasoning.thinkingLevelMap
    return {
      id: routeId, modelId, groupId, groupName: model?.group_name || model?.groupName || '',
      name: model?.display_name || model?.displayName || model?.name || modelId, api,
      provider: providerForApi(api, groupId), reasoning, thinkingLevels, thinkingLevelMap,
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
    if (!models.length) throw new Error('当前账号没有可用于 AnYuAgent 的文本模型，请联系管理员检查分组和协议权限')
    state.catalogSource = 'AnYuAgent 自动目录'
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
    const names = kind === 'video' ? ['video_group_ids', 'videoGroupIDs', 'videoGroupIds'] : ['image_group_ids', 'imageGroupIDs', 'imageGroupIds']
    const direct = names.flatMap((name) => Array.isArray(key[name]) ? key[name] : [])
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
  function skillModelsForGroup(group, kind) {
    const models = Array.isArray(group?.models) ? group.models : []
    return models.filter((model) => String(model?.name || '').trim() && String(model?.capability || '').trim().toLowerCase() === kind)
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
    return groups.flatMap((group) => skillModelsForGroup(group, kind).map((model) => ({ ...model, name: String(model.name).trim(), groupId: Number(group.id), groupName: group.name })))
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
  async function loadSkillGroups() {
    try {
      const data = await window.anyu.skillsGroups()
      const groups = Array.isArray(data) ? data : data?.items || data?.groups || []
      state.skillGroups = Array.isArray(groups) ? groups : []
      ensureSkillSelection()
      return true
    } catch (error) {
      state.skillGroups = []
      ensureSkillSelection()
      state.error = error.message || '技能目录加载失败'
      return false
    }
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
  function pluginDescription(item) { return String(item?.description || '面向 AnYuAgent 的可复用 Skill 能力。') }
  function pluginPublisher(item) {
    const publisher = item?.publisher
    return typeof publisher === 'object' ? String(publisher.name || publisher.id || '未知发布者') : String(publisher || '未知发布者')
  }
  function pluginMatches(item, query) {
    if (!query) return true
    const haystack = [pluginTitle(item), pluginDescription(item), pluginPublisher(item), ...(item?.keywords || []), ...(item?.categories || [])].join(' ').toLowerCase()
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
  function pluginPublishStatusLabel(item) {
    const status = String(item?.publishStatus || '').toLowerCase()
    if (status === 'submitted' || status === 'pending' || status === 'review') return '审核中'
    if (status === 'approved' || status === 'published' || item?.visibility === 'public') return '已发布'
    if (status === 'rejected') return '需修改'
    return '仅自己可用'
  }
  function pluginCardMarkup(item, mode) {
    const id = pluginId(item)
    if (!id) return ''
    const installed = mode === 'installed' || installedPlugin(id)
    const record = installedPlugin(id)
    const display = mode === 'marketplace' ? item : (record || item)
    const version = String(display?.version || '—')
    const categories = Array.isArray(display?.categories) ? display.categories.slice(0, 3).map((value) => `<span class="plugin-chip">${esc(value)}</span>`).join('') : ''
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
      ? `${updateAction}<button class="plugin-action ${record?.enabled === false ? '' : 'active'}" data-plugin-action="toggle" data-plugin-id="${esc(id)}">${record?.enabled === false ? '启用' : '已启用'}</button>${rollbackAction}${publishAction}<button class="plugin-text-action" data-plugin-action="uninstall" data-plugin-id="${esc(id)}">卸载</button>`
      : `<button class="plugin-action active" data-plugin-action="install" data-plugin-id="${esc(id)}">安装</button>`
    const trust = (record || item)?.verified || (record || item)?.publisher?.verified ? '<span class="plugin-badge verified">已验证</span>' : '<span class="plugin-badge">社区</span>'
    return `<article class="plugin-card"><div class="plugin-card-top"><div class="plugin-icon">${esc(pluginTitle(item).slice(0, 1).toUpperCase())}</div><div class="plugin-card-main"><div class="plugin-card-title"><strong>${esc(pluginTitle(item))}</strong>${trust}</div><p>${esc(pluginDescription(item))}</p><div class="plugin-meta"><span>${esc(pluginPublisher(item))}</span><span>v${esc(version)}</span>${categories}</div></div></div><div class="plugin-card-actions">${action}</div></article>`
  }
  function pluginMarketMarkup() {
    const tab = state.pluginMarketTab
    const query = String(state.pluginMarketQuery || '').trim()
    const installed = pluginList()
    const marketplace = pluginMarketplaceList().filter((item) => pluginMatches(item, query))
    const uploads = installed.filter((item) => item.visibility !== 'public' || item.source === 'local')
    const items = tab === 'installed' ? installed.filter((item) => pluginMatches(item, query)) : tab === 'uploads' ? uploads.filter((item) => pluginMatches(item, query)) : marketplace
    const empty = tab === 'marketplace' ? '市场暂时没有可用目录。你可以导入自己的 .anyu-plugin.zip，安装后立即使用。' : tab === 'installed' ? '还没有安装插件。' : '还没有本地上传的插件。'
    const publish = state.pluginPublishOpen ? `<div class="modal-backdrop plugin-publish-backdrop"><section class="permission-modal plugin-publish-modal"><div class="settings-head"><div><div class="modal-kicker">Publish Plugin</div><h3>发布自定义插件</h3></div><button class="icon-button" id="plugin-publish-close" title="关闭">×</button></div><p>发布前会再次扫描插件包。公开插件将进入审核队列；私有插件仅对你的账号可见。</p><label class="plugin-form-label" for="plugin-publisher-name">发布者</label><input class="modal-input" id="plugin-publisher-name" value="${esc(state.pluginPublishName)}" placeholder="例如：AnYu Community"><label class="plugin-form-label" for="plugin-publish-visibility">可见性</label><select class="modal-input" id="plugin-publish-visibility"><option value="public" ${state.pluginPublishVisibility === 'public' ? 'selected' : ''}>公开发布 · 提交审核</option><option value="private" ${state.pluginPublishVisibility === 'private' ? 'selected' : ''}>私有自定义插件 · 仅自己使用</option></select><div class="modal-actions"><button class="ghost" id="plugin-publish-cancel">取消</button><button class="primary modal-primary" id="plugin-publish-submit" ${state.pluginPublishLoading ? 'disabled' : ''}>${state.pluginPublishLoading ? '发布中…' : '确认发布'}</button></div></section></div>` : ''
    return `<section class="settings-section settings-plugin-market-section"><div class="plugin-market-panel"><header class="plugin-market-head"><div><h2>发现和管理插件</h2><p>安装社区插件，或导入你自己制作的 Agent Skill。</p></div></header><div class="plugin-market-toolbar"><div class="plugin-tabs"><button class="plugin-tab ${tab === 'marketplace' ? 'active' : ''}" data-plugin-tab="marketplace">发现市场</button><button class="plugin-tab ${tab === 'installed' ? 'active' : ''}" data-plugin-tab="installed">已安装 <span>${installed.length}</span></button><button class="plugin-tab ${tab === 'uploads' ? 'active' : ''}" data-plugin-tab="uploads">我的上传 <span>${uploads.length}</span></button></div><div class="plugin-tools"><input id="plugin-search" value="${esc(state.pluginMarketQuery)}" placeholder="搜索插件、Skill 或发布者" aria-label="搜索插件"><button class="ghost" id="plugin-import">导入插件</button></div></div>${state.pluginMarketError ? `<div class="plugin-market-error">${esc(state.pluginMarketError)}</div>` : ''}<div class="plugin-market-content">${state.pluginMarketLoading ? '<div class="plugin-market-empty">正在同步插件目录…</div>' : items.length ? `<div class="plugin-grid">${items.map((item) => pluginCardMarkup(item, tab === 'installed' || tab === 'uploads' ? 'installed' : 'marketplace')).join('')}</div>` : `<div class="plugin-market-empty"><strong>${esc(empty)}</strong><span>插件会以版本目录安装，更新失败时可以回滚到上一版本。</span>${tab === 'marketplace' ? '<button class="primary" id="plugin-import-empty">导入本地插件</button>' : ''}</div>`}</div><footer class="plugin-market-foot"><span>${installed.length} 个已安装插件 · 本地注册表已保护</span><span>v1 仅支持 skills-only 插件</span></footer></div></section>${publish}`
  }
  async function loadPluginMarket() {
    state.pluginMarketLoading = true; state.pluginMarketError = ''; scheduleAppRender()
    try {
      const [installed, marketplace] = await Promise.all([window.anyu.pluginState(), window.anyu.pluginMarketplace()])
      state.pluginState = { installed: installed?.installed || [], marketplace: Array.isArray(marketplace) ? marketplace : marketplace?.items || [] }
    } catch (error) { state.pluginMarketError = errorText(error) || '插件目录加载失败' }
    state.pluginMarketLoading = false; scheduleAppRender()
  }
  async function restartAgentWithPlugins() {
    if (!state.selectedKey || !state.model) {
      state.error = '插件已更新；选择可用密钥和模型后启动 Agent 即可生效'
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
        await window.anyu.pluginInstallMarketplace({ downloadUrl: item.downloadUrl || item.download_url, scope: 'user' })
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
      await restartAgentWithPlugins()
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
  function chooseModel() {
    if (!state.model || !state.catalog.some((item) => item.id === state.model)) state.model = state.catalog[0]?.id || ''
    localStorage.setItem('anyu.selectedModel', state.model)
  }
  function thinkingStorageKey(model = currentModel()) {
    return model ? `anyu.thinking.${model.provider || model.api || 'model'}.${model.id}` : 'anyu.thinking.default'
  }
  async function syncThinkingLevels() {
    const model = currentModel()
    let levels = modelThinkingLevels(model)
    try {
      const result = await window.anyu.piCommand({ type: 'get_available_thinking_levels' })
      if (Array.isArray(result?.data?.levels) && result.data.levels.length) levels = result.data.levels.filter((level) => THINKING_LEVELS.includes(level))
    } catch {}
    if (!levels.length) levels = ['off']
    state.thinkingLevels = [...new Set(levels)]
    const saved = localStorage.getItem(thinkingStorageKey(model)) || state.thinkingLevel
    state.thinkingLevel = state.thinkingLevels.includes(saved) ? saved : state.thinkingLevels[state.thinkingLevels.length - 1]
    localStorage.setItem(thinkingStorageKey(model), state.thinkingLevel)
    if (state.piState?.thinkingLevel !== state.thinkingLevel) {
      try { await window.anyu.piCommand({ type: 'set_thinking_level', level: state.thinkingLevel }) } catch {}
    }
  }
  async function refreshSessions(shouldApply = () => true) {
    const sessions = await window.anyu.piListSessions()
    if (shouldApply()) state.sessions = sessions
    return sessions
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
    const merged = (Array.isArray(messages) ? messages : []).map((message, index) => ({ ...message, _timelineIndex: index }))
    merged.sort((left, right) => {
      const leftTime = Number(left.createdAt || left.timestamp || 0); const rightTime = Number(right.createdAt || right.timestamp || 0)
      if (leftTime !== rightTime) return leftTime - rightTime
      return left._timelineIndex - right._timelineIndex
    })
    return merged.map(({ _timelineIndex, ...message }) => message)
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
      if (!containsTimelineMessage(unique, message)) unique.push(message)
    }
    return unique
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
  async function refreshMessages(shouldApply = () => true) {
    try {
      const result = await window.anyu.piCommand({ type: 'get_messages' })
      const messages = result?.data?.messages || []
      const stored = await storedAttachmentsForSession()
      const storedMedia = window.anyu.piMedia ? await window.anyu.piMedia(state.sessionPath) : []
      const normalized = messages.filter((message) => ['user', 'assistant', 'toolResult'].includes(message.role)).map((message, index) => {
        const messageText = textOf(message.content) || message.errorMessage || ''
        const inlineImages = imageAttachmentsFromContent(message.content)
        const matching = message.role === 'user' ? stored.filter((item) => item.messageText === messageText) : []
        return {
          id: message.id || message.messageId || undefined,
          role: message.role === 'toolResult' ? 'tool' : message.role,
          // Pi persists the message timestamp inside the message object. Keep
          // it so locally-rendered media can be merged into the same timeline.
          createdAt: timestampValue(message.timestamp || message.createdAt || message.time),
          content: messageText,
          thinking: thinkingOf(message.content),
          toolName: message.toolName,
          toolCallId: message.toolCallId,
          isError: message.isError || Boolean(message.errorMessage),
          attachments: inlineImages.length ? inlineImages : matching.map((item) => ({ ...item, data: item.dataUrl?.split(',')[1] || '', dataUrl: item.dataUrl }))
        }
      })
      const localMedia = timelineMessagesUnique([...(state.mediaMessages[state.sessionPath] || []), ...(storedMedia || [])])
      if (state.sessionPath) state.mediaMessages[state.sessionPath] = localMedia.slice(-100)
      // Media skill messages are local-only, so use their creation timestamp
      // and stable insertion index instead of always appending them last.
      const ordered = orderTimeline(timelineMessagesUnique([...normalized, ...localMedia]))
      const library = [...new Map(ordered.flatMap((message) => message.attachments || []).map((item) => [item.id, item])).values()]
      if (shouldApply()) { state.messages = ordered; state.imageLibrary = library }
      return normalized
    } catch {}
  }
  function updateSessionTitle(content, createdAt = Date.now()) {
    const path = state.sessionPath
    if (!path) return
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
    } else state.sessions.push({ path, title, createdAt: Number(createdAt || Date.now()), firstMessageAt: Number(createdAt || Date.now()), modified: Number(createdAt || Date.now()) })
    state.sessions.sort((a, b) => Number(b.createdAt || b.firstMessageAt || b.modified || 0) - Number(a.createdAt || a.firstMessageAt || a.modified || 0) || String(a.path).localeCompare(String(b.path)))
  }
  function sessionContextMenuMarkup() {
    const menu = state.sessionMenu
    if (!menu?.path) return ''
    const session = state.sessions.find((item) => item.path === menu.path)
    const viewportWidth = Math.max(240, Number(window.innerWidth || 1200))
    const viewportHeight = Math.max(180, Number(window.innerHeight || 800))
    const x = Math.max(8, Math.min(Number(menu.x || 0), viewportWidth - 180))
    const y = Math.max(8, Math.min(Number(menu.y || 0), viewportHeight - 142))
    return `<div class="session-context-menu" style="left:${x}px;top:${y}px" data-session-menu><button type="button" data-session-action="pin" data-session-path="${esc(menu.path)}"><span>${session?.pinned ? '★' : '☆'}</span>${session?.pinned ? '取消置顶' : '置顶'}</button><button type="button" data-session-action="rename" data-session-path="${esc(menu.path)}"><span>✎</span>重命名</button><button type="button" class="danger" data-session-action="delete" data-session-path="${esc(menu.path)}"><span>⌫</span>删除</button></div>`
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
    if (action === 'delete') {
      if (!window.confirm(`确定删除会话“${session?.title || '新会话'}”吗？\n会话消息和本地附件将一并删除。`)) return
      const deletingCurrent = target === state.sessionPath
      try {
        if (deletingCurrent) { clearActiveRequest(); state.loading = false; await window.anyu.piStop(); state.piState = null }
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
    if (!state.model || (state.accessMode === 'key' && !state.selectedKey)) throw new Error('请先选择可用路由和模型')
    const result = await window.anyu.piStart({ accessMode: state.accessMode, keyId: state.selectedKey, model: state.model, provider: currentModel()?.provider, models: state.catalog, sessionPath, cwd: effectiveWorkspace() || undefined, permissionMode: state.permissionMode })
    state.activePermissionMode = result?.permissionMode || effectivePermissionMode()
    if (shouldApply()) {
      if (state.sessionCwd) state.sessionCwd = result.cwd || state.sessionCwd
      else state.cwd = result.cwd || state.cwd
      if (!state.sessionCwd) localStorage.setItem('anyu.cwd', state.cwd)
    }
    const current = await window.anyu.piCommand({ type: 'get_state' })
    if (shouldApply()) {
      state.piState = current?.data || null
      state.sessionPath = state.piState?.sessionFile || sessionPath || null
    }
    if (shouldApply()) await syncThinkingLevels()
    await refreshMessages(shouldApply); await refreshSessions(shouldApply)
  }
  async function bootstrap() {
    const me = await api('/auth/me'); state.user = me?.user || me
    try {
      const plugins = await window.anyu.pluginState()
      state.pluginState = { ...state.pluginState, installed: plugins?.installed || [] }
    } catch {}
    startBalanceRefresh()
    state.keysLoaded = false
    await loadRouteData({ refreshPublicKeys: true })
    localStorage.setItem('anyu.accessMode', state.accessMode)
    chooseModel(); ensureSkillSelection(); await refreshSessions()
    if (state.sessions[0]) { state.sessionPath = state.sessions[0].path; state.sessionCwd = state.sessions[0].cwd || null; if (state.sessionCwd) state.cwd = state.sessionCwd }
    try { await startAgent(state.sessionPath) } catch (error) { state.error = error.message || 'Pi Agent 启动失败' }
  }

  function attachmentObjectUrl(attachment) {
    const dataUrl = String(attachment?.dataUrl || '')
    if (!dataUrl.startsWith('data:')) return dataUrl
    const key = String(attachment?.id || '') || dataUrl.slice(0, 120)
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
          if (!data && !String(attachment.dataUrl || '').startsWith('data:')) throw error
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
    const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image')
    const imageUnsupported = imageAttachments.length > 0 && !currentModel()?.supportsImages
    return {
      content: content + imageText,
      attachments,
      attachmentText: attachmentContext(attachments),
      images: imageUnsupported ? [] : imageAttachments.map((attachment) => ({ type: 'image', data: attachment.data, mimeType: attachment.mimeType })),
      imageUnsupported
    }
  }
  function mediaSkillForPrompt(value) {
    const text = String(value || '')
    if (state.skillEnabled.image && /@(生图|image)(?=\s|$)/i.test(text)) return 'image'
    if (state.skillEnabled.video && /@(生视频|视频|video)(?=\s|$)/i.test(text)) return 'video'
    // Keep explicit @ mentions authoritative, then recognize the natural
    // language requests users expect from a visual assistant. Questions about
    // an existing image/video must remain normal chat turns.
    const lower = text.toLowerCase()
    const isQuestion = /为什么|怎么|如何|能不能|是否|支持吗|失败|报错|问题|what|why|how|support/.test(lower)
    const videoIntent = /生成|制作|创建|做|拍|让.+动起来|动画|视频|video|animate/.test(lower) && /视频|动画|动起来|video|animate/.test(lower)
    const imageDirectVerb = /画|绘制|出图|生图|draw|paint/.test(lower)
    const imageNoun = /图片|图像|照片|插画|海报|头像|壁纸|图标|logo|image|picture|photo|illustration|poster|wallpaper/.test(lower)
    const requestedVisual = /(?:给我|请|来|需要|想要|帮我).{0,20}(?:\d+|[一两二三四五六七八九十])\s*(?:张|幅|个|种).{0,12}(?:图|图片|照片|image|picture)/i.test(lower)
    const imageIntent = imageDirectVerb || (/生成|制作|创建|设计|做|generate|create|render/.test(lower) && imageNoun) || requestedVisual
    if (!isQuestion && state.skillEnabled.video && videoIntent) return 'video'
    if (!isQuestion && state.skillEnabled.image && imageIntent) return 'image'
    return ''
  }
  function mediaPrompt(value, skill) {
    return String(value || '').replace(skill === 'image' ? /@(生图|image)(?=\s|$)/ig : /@(生视频|视频|video)(?=\s|$)/ig, '').trim()
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
    const declared = String(result?.mimeType || '').toLowerCase().split(';')[0].trim()
    if (kind !== 'video') return declared || 'image/png'
    if (declared.startsWith('video/')) return declared
    const data = String(result?.data || '')
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
  function mediaDataUrl(result, kind = 'image') { return result?.data ? `data:${mediaMimeType(result, kind)};base64,${result.data}` : '' }
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
  async function ensureMediaSession() {
    if (!state.piState) await startAgent(state.sessionPath)
    if (!state.sessionPath) {
      const current = await window.anyu.piCommand({ type: 'get_state' })
      state.sessionPath = current?.data?.sessionFile || null
    }
    if (!state.sessionPath) throw new Error('无法创建当前会话，请点击“新会话”后重试')
    if (window.anyu.piMaterializeSession) {
      const materialized = await window.anyu.piMaterializeSession({ sessionPath: state.sessionPath, cwd: effectiveWorkspace() || undefined })
      if (materialized?.created) await startAgent(state.sessionPath)
    }
  }
  async function persistMediaTimeline(sessionPath = state.sessionPath) {
    if (!sessionPath || !window.anyu.piSaveMedia) return
    try { await window.anyu.piSaveMedia({ sessionPath, cwd: sessionPath === state.sessionPath ? effectiveWorkspace() : '', messages: state.mediaMessages[sessionPath] || [] }) } catch {}
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
      if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(status)) throw new Error(task?.error_message || '技能任务执行失败')
      await new Promise((resolve) => window.setTimeout(resolve, kind === 'video' ? 2500 : 1400))
    }
    throw new Error('技能任务等待超时，请稍后在 Anyu 中查看任务状态')
  }
  async function runMediaSkill(task, kind) {
    const directoryLoaded = await loadSkillGroups()
    if (!directoryLoaded) throw new Error(state.error || '技能目录加载失败')
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
    state.skillBusy = kind; state.mediaBusyCount = Number(state.mediaBusyCount || 0) + 1; state.error = ''
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
      let created
      if (kind === 'image') {
        const count = requestedImageCount(promptText)
        const refinedPrompt = refineImagePrompt(promptText, references)
        task._imageCount = count
        task._imagePrompt = { original: promptText, refined: refinedPrompt, referenceCount: references.length }
        created = await window.anyu.imageCreate({ prompt: refinedPrompt, groupId, model: model.name, size: config.size || '1024x1024', quality: config.quality || 'auto', count, references })
      } else {
        const plan = planVideoRequest(promptText, model, references)
        created = await window.anyu.videoCreate({ prompt: promptText, groupId, model: model.name, duration: plan.duration, resolution: plan.resolution, aspectRatio: plan.aspectRatio, references: plan.files })
        task._mediaPlan = plan
      }
      const createdId = created?.id || created?.task_id || created?.taskId
      if (!createdId) throw new Error('技能服务没有返回任务编号')
      const resultCreatedAt = Number(task.createdAt || Date.now()) + 0.5
      resultMessage = { id: `${task.id}:result`, role: 'assistant', content: `已提交 ${model.display_name || model.name}，正在生成${kind === 'image' ? '图片' : '视频'}…`, createdAt: resultCreatedAt, mediaPending: true }
      if (kind === 'video') resultMessage.mediaPlan = task._mediaPlan
      if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
      upsertMediaTimelineMessage(mediaSessionPath, resultMessage)
      await persistMediaTimeline(mediaSessionPath)
      if (state.sessionPath === mediaSessionPath) { renderApp(); updateLiveUi(true) }
      const done = await pollMediaTask(kind, createdId)
      const mediaResults = kind === 'image' ? (done.results || [done.result]) : [done.result]
      const dataUrls = mediaResults.map((item) => mediaDataUrl(item, kind))
      if (!dataUrls.length || dataUrls.some((url) => !url)) throw new Error('技能返回了空的媒体结果')
      // Keep the generated result immediately after its request in the
      // conversation timeline, even if the provider finishes later.
      resultMessage.content = kind === 'image' ? `已通过 ${model.display_name || model.name} 生成 ${dataUrls.length} 张图片` : `已通过 ${model.display_name || model.name} 生成视频\n${mediaPlanLabel(task._mediaPlan)}`
      resultMessage.mediaPending = false
      if (kind === 'image') resultMessage.attachments = mediaResults.map((item, index) => ({ id: `generated-${createdId}-${index}`, kind: 'image', name: `Anyu 生图 ${index + 1}.png`, mimeType: mediaMimeType(item, kind), data: item.data, dataUrl: dataUrls[index], downloadTaskId: createdId, downloadIndex: index }))
      else resultMessage.media = { kind: 'video', name: 'Anyu 生视频.mp4', mimeType: mediaMimeType(done.result, kind), data: done.result.data, dataUrl: dataUrls[0], downloadTaskId: createdId }
      if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
      await persistMediaTimeline(mediaSessionPath)
    } catch (error) {
      if (resultMessage) {
        resultMessage.mediaPending = false; resultMessage.isError = true; resultMessage.content = errorText(error) || '技能执行失败'
        if (state.sessionPath === mediaSessionPath) upsertTimelineMessage(resultMessage)
      }
      else {
        const failed = { id: `${task.id}:result`, role: 'assistant', content: errorText(error) || '技能执行失败', createdAt: Number(task.createdAt || Date.now()) + 0.5, isError: true }
        state.mediaMessages[mediaSessionPath || state.sessionPath]?.push(failed)
        if (state.sessionPath === mediaSessionPath) insertTimelineMessage(failed)
      }
      if (state.sessionPath === mediaSessionPath) state.error = errorText(error) || '技能执行失败'
    } finally {
      endMediaActivity(mediaSessionPath || pendingSessionKey, task.id)
      state.mediaBusyCount = Math.max(0, Number(state.mediaBusyCount || 1) - 1)
      const currentActivity = mediaActivityForSession()
      state.skillBusy = currentActivity[0]?.kind || null
      await persistMediaTimeline(typeof mediaSessionPath === 'string' ? mediaSessionPath : state.sessionPath); if (state.sessionPath === mediaSessionPath) renderApp(); scheduleQueueDrain()
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
  function messagesMarkup() {
    const messages = state.messages.map(messageHtml).join('')
    const showActivity = state.loading || mediaActivityForSession().length > 0
    const empty = !messages && !showActivity ? `<div class="empty"><div><strong>准备好开始工作</strong><span>选择密钥和模型，向 AnYuAgent 描述任务。</span></div></div>` : ''
    const tool = [...state.messages].reverse().find((item) => item.role === 'tool' && item.isStreaming)
    const retrying = Boolean(state.retryNotice)
    const phase = skillActivityLabel() || (retrying ? '正在恢复连接' : tool ? `正在执行 ${tool.toolName || '工具'}` : state.streamingMessage?.content ? '正在生成回复' : '正在思考任务')
    const detail = skillActivityLabel() ? 'Anyu 正在按当前模型能力处理媒体任务' : retrying ? state.retryNotice || '正在重新连接模型服务' : tool ? 'Pi Agent 正在处理本机工作区' : state.streamingMessage?.content ? '回复会持续显示在这里' : '正在连接模型并准备下一步'
    const activity = showActivity ? `<div class="agent-activity ${retrying ? 'retrying' : ''}" role="status" aria-live="polite"><span class="activity-orbit"><i></i></span><span class="activity-copy"><strong>${esc(phase)}</strong><small>${esc(detail)}</small></span><span class="activity-bars"><i></i><i></i><i></i></span></div>` : ''
    return `${messages}${empty}${activity}`
  }

  function pinMessagesToBottom(box = document.querySelector('#messages')) {
    if (!box) return
    const previousBehavior = box.style.scrollBehavior
    box.style.scrollBehavior = 'auto'
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight)
    box.style.scrollBehavior = previousBehavior
  }

  function settleMessagesAtBottom(box = document.querySelector('#messages')) {
    if (!box) return
    pinMessagesToBottom(box)
    requestAnimationFrame(() => {
      if (box.isConnected) pinMessagesToBottom(box)
    })
    window.setTimeout(() => {
      if (box.isConnected) pinMessagesToBottom(box)
    }, 90)
  }

  function updateLiveUi(forceScroll = false) {
    const box = document.querySelector('#messages')
    const wasAtBottom = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 72 : true
    if (box) {
      const nodes = [...box.querySelectorAll('.message')]
      const needsActivity = state.loading || mediaActivityForSession().length > 0
      const hasActivity = Boolean(box.querySelector('.agent-activity'))
      const structuralChange = nodes.length !== state.messages.length || needsActivity !== hasActivity || state.messages.some((message, index) => {
        const node = nodes[index]
        if (!node) return true
        const roleMismatch = (message.role === 'user') !== node.classList.contains('user') || (message.role === 'tool') !== node.classList.contains('tool-message')
        const bubble = node.querySelector('.message-bubble')
        const errorMismatch = message.role === 'tool'
          ? Boolean(message.isError) !== Boolean(node.querySelector('.tool-error'))
          : Boolean(message.isError) !== Boolean(bubble?.classList.contains('tool-error'))
        const streamingMismatch = Boolean(message.isStreaming) !== Boolean(node.querySelector('.streaming-bubble, .tool-status.running'))
        const thinkingMismatch = Boolean(message.thinking) !== Boolean(node.querySelector('.thinking-card'))
        return roleMismatch || errorMismatch || streamingMismatch || thinkingMismatch
      })
      if (structuralChange) { box.innerHTML = messagesMarkup(); bindMessageEvents(box) }
      else state.messages.forEach((message, index) => {
        const node = nodes[index]
        if (!node) return
        if (message.role === 'tool') {
          const pre = [...node.querySelectorAll('.tool-section pre')].pop() || node.querySelector('pre')
          if (pre && pre.textContent !== String(message.content || '')) pre.textContent = String(message.content || '')
        } else {
          const bubble = node.querySelector('.message-bubble')
          if (bubble) {
            bubble.classList.toggle('tool-error', Boolean(message.isError))
            if (bubble.textContent !== String(message.content || '')) bubble.innerHTML = message.content ? esc(message.content) : '<span class="typing-dots"><i></i><i></i><i></i></span>'
          }
          const thinking = node.querySelector('.thinking-card div')
          if (thinking && thinking.textContent !== String(message.thinking || '')) thinking.textContent = String(message.thinking || '')
        }
      })
    }
    const busy = document.querySelector('#busy')
    const currentMediaActivity = mediaActivityForSession()
    if (busy) busy.textContent = state.loading ? 'Agent 正在工作…' : currentMediaActivity.length > 0 ? `${currentMediaActivity.length} 个媒体任务生成中` : state.queuedTasks.length ? `${state.queuedTasks.length} 项排队中` : ''
    const send = document.querySelector('#send')
    if (send) {
      send.disabled = state.sessionSwitching
      send.classList.toggle('stop', state.loading)
      send.textContent = state.loading ? '■' : '↑'
      send.title = state.loading ? '停止当前任务' : '发送'
      send.setAttribute('aria-label', send.title)
    }
    if (box && (forceScroll || state.loading || wasAtBottom)) {
      settleMessagesAtBottom(box)
    }
  }

  function scheduleLiveUi(forceScroll = false) {
    if (forceScroll) state.forceScroll = true
    if (state.renderQueued) return
    state.renderQueued = true
    requestAnimationFrame(() => {
      state.renderQueued = false
      const shouldScroll = Boolean(state.forceScroll)
      state.forceScroll = false
      updateLiveUi(shouldScroll)
    })
  }

  function scheduleAppRender() {
    if (state.appRenderQueued) return
    state.appRenderQueued = true
    requestAnimationFrame(() => { state.appRenderQueued = false; if (state.user) renderApp() })
  }

  function switchSession(path) {
    const target = String(path || '')
    if (!target) return
    const selectedSession = state.sessions.find((item) => item.path === target)
    state.sessionCwd = selectedSession?.cwd || null
    state.cwd = state.sessionCwd || localStorage.getItem('anyu.cwd') || ''
    const token = ++state.sessionSwitchToken
    const previousPath = state.sessionPath
    const canSwitchInProcess = Boolean(state.piState && previousPath && previousPath !== target)
    clearActiveRequest()
    state.loading = false
    state.streamingMessage = null
    state.sessionPath = target
    state.error = ''
    state.sessionSwitching = true
    state.sessionLoadingPath = target
    renderApp()
    const switchInProcess = async () => {
      const result = await window.anyu.piCommand({ type: 'switch_session', sessionPath: target })
      if (result?.data?.cancelled) throw new Error('会话切换被取消')
      if (token !== state.sessionSwitchToken) return
      const [current] = await Promise.all([
        window.anyu.piCommand({ type: 'get_state' }),
        refreshMessages(() => token === state.sessionSwitchToken)
      ])
      if (token !== state.sessionSwitchToken) return
      state.piState = current?.data || null
      state.sessionPath = state.piState?.sessionFile || target
      await syncThinkingLevels()
      await refreshSessions(() => token === state.sessionSwitchToken)
    }
    const loadSession = async () => {
      try {
        if (canSwitchInProcess) await switchInProcess()
        else await startAgent(target, () => token === state.sessionSwitchToken)
      } catch (error) {
        if (!canSwitchInProcess || token !== state.sessionSwitchToken) throw error
        // A stale or older Pi runtime may not implement switch_session. Keep
        // the fast path, but recover by starting the selected session normally.
        state.piState = null
        await startAgent(target, () => token === state.sessionSwitchToken)
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
      })
  }

  function keyHtml(key) {
    const selected = Number(key.id) === state.selectedKey
    const hint = key.provider || key.billing_mode || 'Anyu 路由密钥'
    return `<div class="key ${selected ? 'selected' : ''}" data-key="${esc(key.id)}"><div class="key-name"><span class="dot ${key.status && key.status !== 'active' ? 'off' : ''}"></span>${esc(keyDisplayName(key))}</div><div class="key-meta"><span>${esc(cleanDisplayText(hint) || 'Anyu 路由密钥')}</span><span>${key.status === 'active' || !key.status ? '可用' : esc(cleanDisplayText(key.status))}</span></div></div>`
  }
  async function copyText(value) {
    const text = String(value || '')
    try { await navigator.clipboard.writeText(text); return } catch {}
    const input = document.createElement('textarea')
    input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select()
    try { document.execCommand('copy') } catch {}
    input.remove()
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
    container.querySelectorAll('[data-message-copy]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); const message = historyMessage(node.closest('[data-message-index]')?.dataset.messageIndex); if (message) void copyText(message.content || '') }))
    container.querySelectorAll('[data-message-edit]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); editHistoryMessage(node.closest('[data-message-index]')?.dataset.messageIndex) }))
    container.querySelectorAll('[data-message-resend]').forEach((node) => node.addEventListener('click', (event) => { event.stopPropagation(); resendHistoryMessage(node.closest('[data-message-index]')?.dataset.messageIndex) }))
  }
  function messageHtml(message) {
    const user = message.role === 'user'; const tool = message.role === 'tool'; const index = state.messages.indexOf(message)
    const time = message.createdAt ? `<time class="message-time">${esc(formatTimestamp(message.createdAt))}</time>` : ''
    if (tool) {
      const status = message.isStreaming ? '运行中' : message.isError ? '失败' : '已完成'
      const expanded = message.isStreaming ? 'open' : ''
      const duration = message.startedAt ? `<span class="tool-duration">${esc(formatDuration((message.finishedAt || Date.now()) - message.startedAt))}</span>` : ''
      const args = message.args && Object.keys(message.args).length ? `<details class="tool-section" ${expanded}><summary>参数</summary><pre>${esc(JSON.stringify(message.args, null, 2))}</pre></details>` : ''
      const output = message.content ? `<details class="tool-section" ${expanded}><summary>输出</summary><pre>${esc(message.content)}</pre></details>` : ''
      const progress = message.isStreaming && !message.content ? '<div class="tool-progress"><span></span>正在等待工具输出…</div>' : ''
      return `<article class="message tool-message" data-message-index="${index}"><div class="avatar tool-avatar">⌘</div><details class="tool-card" ${expanded}><summary><span class="tool-chevron">›</span><span class="message-role">工具 · ${esc(message.toolName || '执行')}</span>${duration}<span class="tool-status ${message.isError ? 'failed' : message.isStreaming ? 'running' : ''}">${status}</span></summary><div class="tool-card-body">${progress}${args}${output}${message.isError ? '<span class="tool-error">执行失败</span>' : ''}</div></details><time class="message-time">${esc(formatTimestamp(message.createdAt))}</time></article>`
    }
    const thinking = message.thinking ? `<details class="thinking-card"><summary><span class="tool-chevron">›</span>思考过程</summary><div>${esc(message.thinking)}</div></details>` : ''
    const streaming = message.isStreaming && !message.content ? '<span class="typing-dots"><i></i><i></i><i></i></span>' : ''
    const bubble = message.content ? esc(message.content) : streaming
    const media = message.media?.kind === 'video' ? `<div class="generated-video"><video src="${esc(mediaSourceUrl(message))}" controls playsinline preload="auto"></video><button type="button" class="media-download" data-download-video="${esc(message.id || '')}" title="下载视频">↓ 下载视频</button></div>` : ''
    const actions = user ? `<button type="button" data-message-copy title="复制消息">复制</button><button type="button" data-message-edit title="编辑消息">编辑</button><button type="button" data-message-resend title="重发消息">重发</button>` : '<button type="button" data-message-copy title="复制消息">复制</button>'
    return `<article class="message ${user ? 'user' : ''}" data-message-index="${index}"><div class="avatar">${user ? initials(state.user?.email) : 'A'}</div><div class="message-body"><div class="message-role">${user ? '你' : 'AnYuAgent'}</div>${thinking}<div class="message-bubble ${message.isError ? 'tool-error' : ''} ${message.isStreaming ? 'streaming-bubble' : ''}">${bubble || '<span class="message-placeholder"> </span>'}</div>${media}${message.attachments?.length ? `<div class="message-attachments">${message.attachments.map((attachment) => attachmentMarkup(attachment, false)).join('')}</div>` : ''}<div class="message-meta">${time}<span class="message-actions">${actions}</span></div></div></article>`
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
  function skillMenuMarkup() {
    if (!state.skillMenuOpen) return ''
    const image = state.skillConfigs.image; const video = state.skillConfigs.video
    const token = currentMentionToken()
    const filter = String(token?.query || '').toLowerCase()
    const showImage = state.skillEnabled.image && (!filter || '生图 image'.includes(filter))
    const showVideo = state.skillEnabled.video && (!filter || '生视频 视频 video'.includes(filter))
    return `<div class="skill-menu"><div class="menu-caption">插入技能 <span>当前密钥</span></div>${showImage ? `<button type="button" data-skill-insert="image"><span class="skill-menu-icon">✦</span><span><strong>@生图</strong><small>${esc(image.model || '未选择模型')}</small></span></button>` : ''}${showVideo ? `<button type="button" data-skill-insert="video"><span class="skill-menu-icon">◉</span><span><strong>@生视频</strong><small>${esc(video.model || '未选择模型')}</small></span></button>` : ''}${!showImage && !showVideo ? '<div class="muted menu-empty">没有匹配的技能</div>' : ''}</div>`
  }
  function skillsMarketMarkup() {
    const imageModels = skillModels('image'); const videoModels = skillModels('video')
    return `<div class="skills-market"><div class="market-heading"><div><div class="modal-kicker">AnYuAgent Skills</div><h4>技能市场</h4><p>输入 @生图 或 @生视频后，技能会根据描述、参考图和当前模型能力自动选择参数。</p></div><span class="market-status">${state.skillsLoading ? '同步中…' : `${imageModels.length + videoModels.length} 个可用模型`}</span></div><div class="skill-grid"><article class="skill-card"><div class="skill-card-icon image">✦</div><div class="skill-card-copy"><strong>生图 Skill</strong><span>自动处理图片生成与参考图编辑，遵循当前密钥的模型目录。</span><small>${imageModels.length ? `${imageModels.length} 个模型 · ${esc(state.skillConfigs.image.model)}` : '当前密钥暂无生图模型'}</small></div><button class="skill-toggle ${state.skillEnabled.image ? 'enabled' : ''}" data-skill-toggle="image">${state.skillEnabled.image ? '已启用' : '启用'}</button></article><article class="skill-card"><div class="skill-card-icon video">◉</div><div class="skill-card-copy"><strong>生视频 Skill</strong><span>自动理解时长、画幅和画质意图，并适配首帧、首尾帧、多图及厂商协议。</span><small>${videoModels.length ? `${videoModels.length} 个模型 · ${esc(state.skillConfigs.video.model)}` : '当前密钥暂无视频模型'}</small></div><button class="skill-toggle ${state.skillEnabled.video ? 'enabled' : ''}" data-skill-toggle="video">${state.skillEnabled.video ? '已启用' : '启用'}</button></article></div><div class="skill-config"><div class="config-title">技能模型</div><div class="config-row"><label>生图分组<select id="skill-image-group">${skillGroupOptions('image') || '<option value="">暂无可用分组</option>'}</select></label><label>生图模型<select id="skill-image-model">${skillModelOptions('image') || '<option value="">暂无可用模型</option>'}</select></label></div><div class="config-row"><label>视频分组<select id="skill-video-group">${skillGroupOptions('video') || '<option value="">暂无可用分组</option>'}</select></label><label>视频模型<select id="skill-video-model">${skillModelOptions('video') || '<option value="">暂无可用模型</option>'}</select></label></div></div></div>`
  }
  function coreSkillsMarkup() {
    return `<section class="settings-section settings-core-skills"><div class="setting-label-row"><div><h2>核心技能</h2><p class="settings-section-copy">管理内置图片与视频技能，它们不会被插件卸载影响。</p></div><button type="button" class="ghost" id="skills-refresh">同步目录</button></div><div class="setting-block skill-market-block">${skillsMarketMarkup()}</div></section>`
  }
  function legacyRenderApp() {
    const key = selectedKey(); const model = currentModel()
     root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="side-brand"><div class="brand-mark">A</div><div><strong>AnYuAgent</strong><span>独立 Pi Agent</span></div></div>
      <div class="nav-title">Workspace</div><div class="nav-item active"><span class="nav-icon">✦</span>Agent 对话</div><div class="nav-item" id="new-chat"><span class="nav-icon">＋</span>新建会话</div>
      <div class="nav-title">本机会话</div><div id="session-list">${state.sessions.slice(0, 20).map((item) => `<div class="nav-item session ${item.path === state.sessionPath ? 'active' : ''}" data-path="${esc(item.path)}"><span class="nav-icon">○</span>${esc(item.title || '新会话')}</div>`).join('')}</div>
      <div class="side-footer"><div class="user-line"><div class="avatar">${initials(state.user?.email)}</div><div class="user-email" title="${esc(state.user?.email)}">${esc(state.user?.email || 'Anyu 用户')}</div></div><button class="logout" id="logout">切换账号</button></div></aside>
      <main class="main"><header class="topbar"><h2>Agent 对话</h2><div class="top-actions"><span class="muted" style="font-size:12px">${state.catalog.length} 个模型</span><button class="ghost" id="choose-cwd">工作目录</button><button class="ghost" id="refresh">刷新</button><button class="ghost" id="switch-account">切换账号</button></div></header>
      ${state.error ? `<div class="app-alert" role="status">${esc(state.error)}</div>` : ''}
      <div class="workspace"><section class="chat-panel"><div class="chat-head"><div><div class="chat-title">${esc(state.sessions.find((item) => item.path === state.sessionPath)?.title || '新会话')}</div><div class="chat-subtitle">Pi Agent Core · Anyu Gateway · ${esc(effectiveWorkspace() || '未选择工作目录')}</div></div><button class="ghost" id="new-chat-main">＋ 新会话</button></div>
        <div class="messages" id="messages">${messagesMarkup()}</div>
        <div class="composer"><div class="composer-box"><textarea id="prompt" placeholder="给 AnYuAgent 一条指令…（Enter 发送，Shift+Enter 换行）"></textarea><button class="send" id="send" title="发送">↑</button></div><div class="composer-meta"><span>本地 Pi 可读取、编辑并执行项目文件</span><span id="busy">${state.loading ? 'Agent 正在工作…' : ''}</span></div></div></section>
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
       if (state.keyMenuOpen && !event.target.closest('.key-picker-wrap')) { state.keyMenuOpen = false; renderApp(); return }
       if ((state.skillMenuOpen || state.imageMenuOpen) && !event.target.closest('.skill-menu, .image-reference-menu, #prompt, #attach-trigger')) {
        state.skillMenuOpen = false; state.imageMenuOpen = false; renderApp()
      }
    })
    document.querySelector('#model')?.addEventListener('change', async (event) => { state.model = event.target.value; localStorage.setItem('anyu.selectedModel', state.model); try { await window.anyu.piCommand({ type: 'set_model', provider: currentModel()?.provider || providerForApi('openai-completions'), modelId: state.model }) } catch (error) { state.error = error.message || '切换模型失败' }; renderApp() })
    const switchAccount = async () => {
      state.error = ''
      try { await window.anyu.piStop() } catch {}
      try { await window.anyu.logout() } catch {}
      state.user = null; state.keys = []; state.catalog = []; state.catalogSource = ''; state.sessions = []; state.sessionPath = null; state.messages = []; state.piState = null; state.loading = false; state.permission = null; state.twoFactor = null; state.streamingMessage = null
      render()
    }
    document.querySelector('#logout')?.addEventListener('click', switchAccount)
    document.querySelector('#switch-account')?.addEventListener('click', switchAccount)
    document.querySelector('#refresh')?.addEventListener('click', async () => { state.error = ''; try { await loadKeys(); state.catalog = await loadCatalogForKey(state.selectedKey); chooseModel(); await startAgent(state.sessionPath) } catch (error) { state.error = error.message }; renderApp() })
    document.querySelector('#choose-cwd')?.addEventListener('click', async () => { const directory = await window.anyu.chooseDirectory(); if (!directory) return; state.cwd = directory; localStorage.setItem('anyu.cwd', directory); try { await startAgent(state.sessionPath) } catch (error) { state.error = error.message }; renderApp() })
    document.querySelector('#new-chat')?.addEventListener('click', newConversation); document.querySelector('#new-chat-main')?.addEventListener('click', newConversation)
    const prompt = document.querySelector('#prompt'); prompt?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage() } }); document.querySelector('#send')?.addEventListener('click', sendMessage)
    document.querySelector('#permission-allow')?.addEventListener('click', () => answerPermission({ confirmed: true })); document.querySelector('#permission-deny')?.addEventListener('click', () => answerPermission({ confirmed: false })); document.querySelector('#permission-submit')?.addEventListener('click', () => answerPermission({ value: document.querySelector('#permission-input')?.value || '' })); document.querySelectorAll('[data-option]').forEach((node) => node.addEventListener('click', () => answerPermission({ value: state.permission.options[Number(node.dataset.option)] })))
  }

  function settingsMarkup() {
    // 设置导航只展示已经实现的页面，避免空入口干扰用户。
    const section = ['general', 'skills', 'plugins'].includes(state.settingsSection) ? state.settingsSection : 'general'
    const pageTitle = { general: '常规', skills: '核心技能', plugins: '插件市场' }[section]
    const generalMarkup = `
      <section class="settings-section"><h2>权限</h2><div class="settings-card"><div class="settings-row"><div><strong>本机访问权限</strong><p>智能适配会根据当前模型的工具能力选择访问级别。</p></div><select id="permission-mode" aria-label="本机访问权限"><option value="auto" ${state.permissionMode === 'auto' ? 'selected' : ''}>智能适配 · ${esc(permissionModeLabel())}</option><option value="confirm" ${state.permissionMode === 'confirm' ? 'selected' : ''}>受控访问 · 每次操作确认</option><option value="full" ${state.permissionMode === 'full' ? 'selected' : ''}>完整访问 · 自动允许工具操作</option></select></div><p class="settings-help">当前模型：${esc(permissionModeLabel())}。切换后会重启本地 Agent 以应用权限。</p></div></section>
      <section class="settings-section"><h2>常规</h2><div class="settings-card"><div class="settings-row"><div><strong>无项目任务文件夹</strong><p>在项目外启动的任务默认存储数据的位置。</p></div><div class="settings-row-actions"><span class="settings-value">${esc(effectiveWorkspace() || '尚未选择')}</span><button type="button" class="ghost" id="settings-cwd">更改</button></div></div><div class="settings-divider"></div><div class="settings-row"><div><strong>账户</strong><p>当前登录的 Anyu 账号。</p></div><span class="settings-value">${esc(state.user?.email || 'Anyu 用户')}</span></div></div></section>
      <section class="settings-section settings-account-actions"><h2>账号操作</h2><div class="settings-card"><div class="settings-row"><div><strong>切换账号</strong><p>退出当前账号并返回登录页面。</p></div><button type="button" class="ghost" id="settings-logout">切换账号</button></div></div></section>`
    const content = section === 'skills' ? coreSkillsMarkup() : section === 'plugins' ? pluginMarketMarkup() : generalMarkup
    return `<div class="settings-page-layout">
      <aside class="settings-sidebar">
        <button type="button" class="settings-back" id="settings-back"><span aria-hidden="true">←</span><span>返回应用</span></button>
        <nav class="settings-nav" aria-label="设置分类">
          <button type="button" class="settings-nav-item ${section === 'general' ? 'active' : ''}" data-settings-section="general" ${section === 'general' ? 'aria-current="page"' : ''}><span>⚙</span><span>常规</span></button>
          <button type="button" class="settings-nav-item ${section === 'skills' ? 'active' : ''}" data-settings-section="skills" ${section === 'skills' ? 'aria-current="page"' : ''}><span>✦</span><span>核心技能</span></button>
          <button type="button" class="settings-nav-item ${section === 'plugins' ? 'active' : ''}" data-settings-section="plugins" ${section === 'plugins' ? 'aria-current="page"' : ''}><span>◈</span><span>插件市场</span></button>
        </nav>
      </aside>
      <main class="settings-page-main">
        <header class="settings-page-header">
          <div><div class="modal-kicker">AnYuAgent</div><h1>${pageTitle}</h1></div>
          <div class="settings-window-controls" aria-label="窗口控制"><button type="button" data-window-action="minimize" title="最小化">−</button><button type="button" data-window-action="maximize" title="最大化">□</button><button type="button" data-window-action="close" title="关闭">×</button></div>
        </header>
        <div class="settings-page-content">${content}</div>
      </main>
    </div>`
  }

  function modelOptionsMarkup() {
    const groups = new Map()
    for (const item of state.catalog) {
      const group = protocolLabel(item)
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(item)
    }
    return [...groups.entries()].map(([group, models]) => `<optgroup label="${esc(group)}">${models.map((item) => `<option value="${esc(item.id)}" ${item.id === state.model ? 'selected' : ''}>${esc(item.name || item.id)}</option>`).join('')}</optgroup>`).join('')
  }

  function routePickerMarkup(controlsBusy, keyLabel) {
    const disabled = controlsBusy ? 'disabled' : ''
    const autoOption = `<button class="key-option ${state.accessMode === 'auto' ? 'selected' : ''}" data-route-mode="auto" ${disabled}><span class="dot"></span><span class="key-option-label">自动分组</span><span class="key-option-status">推荐</span></button>`
    const keyOptions = state.keys.map((item) => `<button class="key-option ${state.accessMode === 'key' && Number(item.id) === state.selectedKey ? 'selected' : ''}" data-route-mode="key" data-key="${esc(item.id)}" ${disabled}><span class="dot ${item.status && item.status !== 'active' ? 'off' : ''}"></span><span class="key-option-label">${esc(item.name || item.title || `密钥 ${item.id}`)}</span><span class="key-option-status">${item.status === 'active' || !item.status ? '可用' : esc(item.status)}</span></button>`).join('')
    return `<button class="picker-button" id="key-picker" title="选择自动分组或我的密钥" ${disabled}><span class="picker-icon">⌁</span><span class="picker-text">${esc(keyLabel)}</span><span class="picker-chevron">⌄</span></button>${state.keyMenuOpen ? `<div class="key-menu"><div class="menu-caption">对话路由 <span>${state.keys.length + 1}</span></div>${autoOption}${keyOptions}</div>` : ''}`
  }

  function renderApp() {
    if (state.settingsOpen) {
      root.innerHTML = `${settingsMarkup()}${permissionHtml()}`
      bindAppEvents()
      return
    }
    const restorePromptFocus = document.activeElement?.id === 'prompt'
    const restorePromptCursor = restorePromptFocus ? Number(document.activeElement?.selectionStart) : null
    const key = selectedKey()
    const keyLabel = state.accessMode === 'auto' ? '自动分组' : keyDisplayName(key)
    const model = currentModel()
    const controlsBusy = state.switching || state.sessionSwitching || state.loading
    root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="side-brand"><div class="brand-mark">A</div><div><strong>AnYuAgent</strong><span>独立 Pi Agent</span></div></div>
      <div class="nav-section"><div class="nav-title">工作区</div><div class="nav-item active"><span class="nav-icon">✦</span>Agent 对话</div><button class="nav-item nav-button" id="new-chat"><span class="nav-icon">＋</span>新建会话</button></div>
       <div class="nav-section sessions-section"><div class="nav-title">本机会话</div><div id="session-list">${state.sessions.slice(0, 30).map((item) => { const loading = state.sessionLoadingPath === item.path; return `<button class="nav-item session ${item.path === state.sessionPath ? 'active' : ''}" data-path="${esc(item.path)}" aria-busy="${loading ? 'true' : 'false'}"><span class="nav-icon">${loading ? '<span class="spinner session-spinner"></span>' : item.pinned ? '★' : '○'}</span><span class="session-copy"><span class="session-label">${esc(item.title || '新会话')}</span><small class="session-time">${esc(formatTimestamp(item.firstMessageAt || item.createdAt || item.modified))}</small></span></button>` }).join('') || '<div class="empty-sessions">暂无会话</div>'}</div></div>
      <div class="side-footer"><button class="update-link ${state.update.status === 'error' ? 'error' : ''}" id="update-app" ${['checking', 'downloading', 'installing'].includes(state.update.status) ? 'disabled' : ''}><span class="nav-icon update-icon ${['checking', 'downloading', 'installing'].includes(state.update.status) ? 'spinning' : ''}">↻</span><span class="update-label">${esc(updateButtonLabel())}</span></button><button class="settings-link" id="settings-open"><span class="nav-icon">⚙</span>设置</button><div class="balance-summary" title="每 60 秒自动同步"><div class="balance-caption"><span>剩余额度</span><span class="balance-sync-dot"></span></div><strong>${esc(formatBalance())}</strong></div><div class="user-line"><div class="avatar">${initials(state.user?.email)}</div><div class="user-email" title="${esc(state.user?.email)}">${esc(state.user?.email || 'Anyu 用户')}</div></div></div></aside>
      <main class="main"><header class="topbar"><div class="topbar-title"><h2>Agent 对话</h2><span class="connection-dot ${state.piState ? '' : 'offline'}"></span><span class="connection-label">${state.piState ? '已连接' : '未连接'}</span></div><div class="top-actions"><span class="muted model-count">${state.catalog.length} 个模型</span><button class="icon-button" id="refresh" title="刷新">↻</button><div class="window-controls" aria-label="窗口控制"><button type="button" data-window-action="minimize" title="最小化">−</button><button type="button" data-window-action="maximize" title="最大化">□</button><button type="button" data-window-action="close" title="关闭">×</button></div></div></header>
      ${state.error ? `<div class="app-alert" role="status">${esc(state.error)}</div>` : ''}
      <div class="conversation"><section class="chat-panel"><div class="chat-head"><div><div class="chat-title">${esc(state.sessions.find((item) => item.path === state.sessionPath)?.title || '新会话')}</div><div class="chat-subtitle">${esc(model ? `${protocolLabel(model)} · ${model.name || model.id}` : '选择密钥和模型后开始')}</div></div><button class="ghost" id="new-chat-main">＋ 新会话</button></div>
         <div class="messages" id="messages">${messagesMarkup()}</div>
           <div class="composer">${queuedTasksMarkup()}${attachmentsMarkup()}<div class="composer-tools"><div class="key-picker-wrap"><button class="picker-button" id="key-picker" title="选择 Anyu 密钥" ${controlsBusy ? 'disabled' : ''}><span class="picker-icon">⌁</span><span class="picker-text">${esc(keyLabel)}</span><span class="picker-chevron">⌄</span></button>${state.keyMenuOpen ? `<div class="key-menu"><div class="menu-caption">Anyu 密钥 <span>${state.keys.length}</span></div>${state.keys.map((item) => `<button class="key-option ${Number(item.id) === state.selectedKey ? 'selected' : ''}" data-key="${esc(item.id)}" ${controlsBusy ? 'disabled' : ''}><span class="dot ${item.status && item.status !== 'active' ? 'off' : ''}></span><span class="key-option-label">${esc(item.name || item.title || `密钥 ${item.id}`)}</span><span class="key-option-status">${item.status === 'active' || !item.status ? '可用' : esc(item.status)}</span></button>`).join('') || '<div class="muted menu-empty">暂无密钥</div>'}</div>` : ''}</div><select id="model" class="model-picker" title="选择模型" ${controlsBusy ? 'disabled' : ''}>${modelOptionsMarkup() || '<option value="">暂无模型</option>'}</select><button class="permission-button ${state.permissionMode === 'full' ? 'full' : ''}" id="permission-quick" title="本机访问权限"><span>${state.permissionMode === 'full' ? '⚡ 完整访问' : '✓ 受控访问'}</span></button><button class="ghost cwd-button" id="choose-cwd" title="工作目录">⌂ ${esc(state.cwd ? state.cwd.split('\\').pop() || state.cwd : '目录')}</button></div><div class="composer-box"><button class="attach-button" id="attach-trigger" title="添加文件或图片" ${state.sessionSwitching ? 'disabled' : ''}>＋</button><input id="file-input" type="file" multiple hidden><input id="image-input" type="file" accept="image/*" multiple hidden><div class="attachment-menu hidden" id="attachment-menu"><button id="attach-files"><span>▧</span><span><strong>文件</strong><small>添加代码和文档</small></span></div><div class="image-reference-menu ${state.imageMenuOpen ? '' : 'hidden'}" id="image-reference-menu">${imageReferenceMarkup()}</div>${skillMenuMarkup()}<textarea id="prompt" ${state.sessionSwitching ? 'disabled' : ''} placeholder="给 AnYuAgent 一条指令…（输入 @ 调用技能或引用图片，Enter 发送，Shift+Enter 换行）">${esc(state.composerText)}</textarea><select id="thinking-level" class="thinking-picker" title="${esc(`推理强度：${thinkingLevelLabel(state.thinkingLevel)}`)}" ${state.sessionSwitching ? 'disabled' : ''}>${state.thinkingLevels.map((level) => `<option value="${esc(level)}" ${level === state.thinkingLevel ? 'selected' : ''}>${esc(thinkingLevelLabel(level))}</option>`).join('')}</select><button class="send ${state.loading ? 'stop' : ''}" id="send" ${state.sessionSwitching ? 'disabled' : ''} title="${state.loading ? '停止当前任务' : '发送'}" aria-label="${state.loading ? '停止当前任务' : '发送'}">${state.loading ? '■' : '↑'}</button></div><div class="composer-meta"><span>Pi 可读取、编辑并执行工作目录中的文件</span><span id="busy">${state.retryNotice || (state.loading ? 'Agent 正在工作…' : state.queuedTasks.length ? `${state.queuedTasks.length} 项排队中` : '')}</span></div></div></section></div></main>${state.settingsOpen ? settingsMarkup() : ''}${permissionHtml()}${imagePreviewMarkup()}${sessionContextMenuMarkup()}</div>`
    const routePicker = document.querySelector('.key-picker-wrap')
    if (routePicker) routePicker.innerHTML = routePickerMarkup(controlsBusy, keyLabel)
     // Normalize labels after rendering as a final guard for legacy markup or
    // API payloads that put the credential itself in `name`.
    document.querySelectorAll('.key-option[data-key]').forEach((node) => {
      const item = state.keys.find((key) => String(key.id) === String(node.dataset.key))
      const label = node.querySelector('.key-option-label')
      if (item && label) {
        const displayName = keyDisplayName(item)
        label.textContent = displayName
        node.title = displayName
        node.setAttribute('aria-label', displayName)
      }
    })
    bindAppEvents(); settleMessagesAtBottom()
    const permissionButton = document.querySelector('#permission-quick')
    if (permissionButton) {
      const activeMode = effectivePermissionMode()
      permissionButton.classList.toggle('full', activeMode === 'full')
      permissionButton.querySelector('span')?.replaceChildren(document.createTextNode(permissionModeLabel(activeMode)))
    }
    const prompt = document.querySelector('#prompt')
    if (prompt) {
      prompt.value = state.composerText
      if (restorePromptFocus) {
        prompt.focus({ preventScroll: true })
        const cursor = Number.isFinite(Number(state.composerCursor)) ? Number(state.composerCursor) : Number.isFinite(restorePromptCursor) ? restorePromptCursor : prompt.value.length
        prompt.selectionStart = prompt.selectionEnd = Math.max(0, Math.min(cursor, prompt.value.length))
      }
    }
    bindImageReferenceEvents()
    document.querySelectorAll('[data-image-preview]').forEach((node) => node.addEventListener('click', (event) => {
      if (event.target.closest('[data-remove-attachment]')) return
      const image = imageCandidates().find((item) => item.id === node.dataset.imagePreview) || state.messages.flatMap((item) => item.attachments || []).find((item) => item.id === node.dataset.imagePreview)
      if (image) { state.imagePreview = image; renderApp() }
    }))
    document.querySelectorAll('[data-image-close]').forEach((node) => node.addEventListener('click', (event) => { if (event.target === node || event.currentTarget === node) { state.imagePreview = null; renderApp() } }))
  }

  function attachmentId() { return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('无法读取图片'))
      reader.readAsDataURL(file)
    })
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
          state.attachments.push({ id: attachmentId(), kind: 'image', name: file.name, size: file.size, mimeType: file.type || 'image/png', dataUrl, data: dataUrl.split(',')[1] || '' })
        } catch { state.error = `${file.name} 读取失败`; continue }
      } else {
        let text = ''
        try { text = file.size <= 512 * 1024 ? await file.text() : `[文件过大，未读取内容：${formatBytes(file.size)}]` } catch { text = '[二进制文件，未读取内容]' }
        state.attachments.push({ id: attachmentId(), kind: 'file', name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream', text })
      }
    }
  }
  function attachmentContext(attachments) {
    return attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => `\n\n--- 文件：${attachment.name} ---\n${attachment.text || ''}\n--- 文件结束 ---`).join('')
  }
  function updateImageReferenceMenu() {
    const prompt = document.querySelector('#prompt')
    const menu = document.querySelector('#image-reference-menu')
    if (!prompt || !menu) return
    const token = mentionToken(prompt.value, prompt.selectionStart)
    const hasCandidates = imageCandidates().length > 0
    state.imageMenuOpen = Boolean(token && hasCandidates)
    const skillPrefix = String(token?.query || '').toLowerCase()
    const skillPrefixMatch = !skillPrefix || ['生', '图', 'image', '视频', 'video'].some((value) => value.startsWith(skillPrefix) || skillPrefix.startsWith(value))
    const nextSkillMenuOpen = Boolean(token && skillPrefixMatch && (skillModels('image').length || skillModels('video').length))
    if (nextSkillMenuOpen) state.imageMenuOpen = false
    if (nextSkillMenuOpen !== state.skillMenuOpen) { state.skillMenuOpen = nextSkillMenuOpen; scheduleAppRender() }
    menu.classList.toggle('hidden', !state.imageMenuOpen)
    if (state.imageMenuOpen) menu.innerHTML = imageReferenceMarkup()
    const skillSlot = document.querySelector('#skill-menu-slot')
    if (skillSlot) skillSlot.innerHTML = skillMenuMarkup()
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
    document.querySelectorAll('[data-skill-insert]').forEach((node) => node.addEventListener('click', () => {
      const skill = node.dataset.skillInsert === 'video' ? '生视频' : '生图'
      const prompt = document.querySelector('#prompt'); if (!prompt) return
      if (!replaceMention(prompt, `@${skill} `)) return
      state.skillMenuOpen = false; state.imageMenuOpen = false
      prompt.focus(); prompt.selectionStart = prompt.selectionEnd = state.composerCursor; renderApp()
    }))
  }

  function bindAppEvents() {
    document.querySelectorAll('[data-window-action]').forEach((node) => node.addEventListener('click', () => window.anyu.windowAction(node.dataset.windowAction)))
    bindSkillEvents()
    document.querySelector('.topbar')?.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, select, input, textarea')) return
      window.anyu.windowAction('maximize')
    })
    document.querySelector('#key-picker')?.addEventListener('click', async () => {
      if (state.switching) return
      state.keyMenuOpen = !state.keyMenuOpen
      if (!state.keyMenuOpen || state.keysLoaded) { renderApp(); return }
      state.switching = true
      renderApp()
      try { await loadKeys() } catch (error) { state.error = error.message || '密钥列表加载失败，自动分组仍可正常使用' }
      state.switching = false
      renderApp()
    })
     document.querySelectorAll('[data-route-mode]').forEach((node) => node.addEventListener('click', async () => {
       if (state.switching) return
       const mode = node.dataset.routeMode === 'key' ? 'key' : 'auto'
       const keyId = mode === 'key' ? Number(node.dataset.key) : state.selectedKey
       if (mode === 'key' && (!Number.isFinite(keyId) || !state.keys.some((key) => Number(key.id) === keyId))) { state.error = '该密钥编号无效，请刷新密钥列表'; state.keyMenuOpen = false; renderApp(); return }
       state.switching = true
       state.accessMode = mode; state.selectedKey = keyId; localStorage.setItem('anyu.accessMode', mode); localStorage.setItem('anyu.selectedKey', String(state.selectedKey || '')); state.keyMenuOpen = false; state.error = ''; state.catalog = []; state.model = ''
       renderApp()
       try { await loadRouteData(); ensureSkillSelection(); chooseModel(); await startAgent(state.sessionPath) } catch (error) { state.catalog = []; state.model = ''; state.error = error.message || '切换对话路由失败' }
      state.switching = false
      renderApp()
    }))
    document.querySelectorAll('.session').forEach((node) => node.addEventListener('click', () => switchSession(node.dataset.path)))
    bindMessageEvents(document.querySelector('#messages') || document)
    document.querySelector('#model')?.addEventListener('change', async (event) => {
      if (state.switching) return
      state.switching = true
      const previousPermissionMode = effectivePermissionMode()
      state.model = event.target.value
      localStorage.setItem('anyu.selectedModel', state.model)
      try {
        const nextPermissionMode = state.permissionMode === 'auto' ? modelPermissionMode() : state.permissionMode
        // 自适配模型跨越权限档位时重启 Pi，使 --approve 与当前模型保持一致。
        if (state.permissionMode === 'auto' && previousPermissionMode !== nextPermissionMode) await startAgent(state.sessionPath)
        else await window.anyu.piCommand({ type: 'set_model', provider: currentModel()?.provider || providerForApi('openai-completions'), modelId: currentModel()?.modelId || state.model })
        await syncThinkingLevels()
      } catch (error) { state.error = error.message || '切换模型失败' }
      state.switching = false
      renderApp()
    })
    document.querySelector('#thinking-level')?.addEventListener('change', async (event) => {
      const level = String(event.target.value || 'off')
      if (!state.thinkingLevels.includes(level)) return
      state.thinkingLevel = level; localStorage.setItem(thinkingStorageKey(), level)
      try { await window.anyu.piCommand({ type: 'set_thinking_level', level }) } catch (error) { state.error = error.message || '推理强度切换失败' }
      renderApp()
    })
    document.querySelector('#permission-quick')?.addEventListener('click', () => { state.settingsOpen = true; state.settingsSection = 'general'; renderApp() })
    document.querySelector('#settings-logout')?.addEventListener('click', switchAccount)
    document.querySelector('#settings-open')?.addEventListener('click', () => { state.settingsOpen = true; state.settingsSection = 'general'; renderApp() })
    document.querySelector('#update-app')?.addEventListener('click', async () => {
      if (['checking', 'downloading', 'installing'].includes(state.update.status)) return
      state.update = { ...state.update, status: 'checking', message: '', percent: 0 }
      updateUpdateControl()
      try {
        const info = await window.anyu.checkForUpdate()
        state.update = { ...state.update, ...info, status: info.available ? 'available' : 'latest', percent: 0 }
        updateUpdateControl()
        if (!info.available) return
        const result = await window.anyu.downloadAndInstallUpdate()
        state.update = { ...state.update, ...result, status: result.status || 'installing' }
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
      const section = ['general', 'skills', 'plugins'].includes(node.dataset.settingsSection) ? node.dataset.settingsSection : 'general'
      state.settingsSection = section
      state.pluginPublishOpen = false
      if (section === 'skills') state.skillsLoading = true
      renderApp()
      if (section === 'skills') {
        await loadSkillGroups()
        state.skillsLoading = false
        renderApp()
      }
      else if (section === 'plugins') await loadPluginMarket()
    }))
    document.querySelectorAll('[data-plugin-tab]').forEach((node) => node.addEventListener('click', () => {
      state.pluginMarketTab = node.dataset.pluginTab || 'marketplace'
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
    document.querySelector('#skills-refresh')?.addEventListener('click', async () => { state.skillsLoading = true; renderApp(); await loadSkillGroups(); state.skillsLoading = false; renderApp() })
    document.querySelectorAll('[data-skill-toggle]').forEach((node) => node.addEventListener('click', () => { const kind = node.dataset.skillToggle; if (kind === 'image' || kind === 'video') state.skillEnabled[kind] = !state.skillEnabled[kind]; renderApp() }))
    document.querySelector('#skill-image-group')?.addEventListener('change', (event) => { state.skillConfigs.image.groupId = Number(event.target.value); ensureSkillSelection(); renderApp() })
    document.querySelector('#skill-image-model')?.addEventListener('change', (event) => { state.skillConfigs.image.model = event.target.value; renderApp() })
    document.querySelector('#skill-video-group')?.addEventListener('change', (event) => { state.skillConfigs.video.groupId = Number(event.target.value); ensureSkillSelection(); renderApp() })
    document.querySelector('#skill-video-model')?.addEventListener('change', (event) => { state.skillConfigs.video.model = event.target.value; renderApp() })
     document.querySelector('#permission-mode')?.addEventListener('change', async (event) => { if (state.loading) { state.error = '当前任务完成后再切换权限'; renderApp(); return }; state.permissionMode = ['auto', 'confirm', 'full'].includes(event.target.value) ? event.target.value : 'auto'; localStorage.setItem('anyu.permissionMode', state.permissionMode); localStorage.setItem('anyu.permissionMode.userSelected', '1'); try { await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '权限模式切换失败' }; renderApp() })
    document.querySelector('#settings-cwd')?.addEventListener('click', async () => { if (state.loading) { state.error = '当前任务完成后再切换工作目录'; renderApp(); return }; const directory = await window.anyu.chooseDirectory(); if (!directory) return; state.sessionCwd = null; state.cwd = directory; localStorage.setItem('anyu.cwd', directory); try { if (state.sessionPath && window.anyu.piMaterializeSession) await window.anyu.piMaterializeSession({ sessionPath: state.sessionPath, cwd: directory }); await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '工作目录切换失败' }; renderApp() })
    document.querySelector('#refresh')?.addEventListener('click', async () => { if (state.loading) { state.error = '当前任务完成后再刷新 Agent'; renderApp(); return }; state.error = ''; try { await loadRouteData({ refreshPublicKeys: true }); chooseModel(); ensureSkillSelection(); await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '刷新失败' }; renderApp() })
    document.querySelector('#choose-cwd')?.addEventListener('click', async () => { if (state.loading) { state.error = '当前任务完成后再切换工作目录'; renderApp(); return }; const directory = await window.anyu.chooseDirectory(); if (!directory) return; state.sessionCwd = null; state.cwd = directory; localStorage.setItem('anyu.cwd', directory); try { if (state.sessionPath && window.anyu.piMaterializeSession) await window.anyu.piMaterializeSession({ sessionPath: state.sessionPath, cwd: directory }); await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '工作目录切换失败' }; renderApp() })
    document.querySelector('#new-chat')?.addEventListener('click', newConversation); document.querySelector('#new-chat-main')?.addEventListener('click', newConversation)
    document.querySelector('#attach-trigger')?.addEventListener('click', () => { document.querySelector('#attachment-menu')?.classList.toggle('hidden') })
    document.querySelector('#attach-files')?.addEventListener('click', () => { document.querySelector('#file-input')?.click() })
    document.querySelector('#attach-images')?.addEventListener('click', () => { document.querySelector('#image-input')?.click() })
    document.querySelector('#file-input')?.addEventListener('change', async (event) => { await addFiles(event.target.files); event.target.value = ''; renderApp() })
    document.querySelector('#image-input')?.addEventListener('change', async (event) => { await addFiles(event.target.files, true); event.target.value = ''; renderApp() })
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
    const composerBox = document.querySelector('.composer-box')
    composerBox?.addEventListener('dragover', (event) => { event.preventDefault(); composerBox.classList.add('is-dragging') })
    composerBox?.addEventListener('dragleave', (event) => { if (!composerBox.contains(event.relatedTarget)) composerBox.classList.remove('is-dragging') })
    composerBox?.addEventListener('drop', async (event) => { event.preventDefault(); composerBox.classList.remove('is-dragging'); await addFiles(event.dataTransfer?.files); renderApp() })
    const prompt = document.querySelector('#prompt')
    prompt?.addEventListener('input', () => { state.composerText = prompt.value; state.composerCursor = prompt.selectionStart; updateImageReferenceMenu() })
    prompt?.addEventListener('click', () => { state.composerCursor = prompt.selectionStart; updateImageReferenceMenu() })
    prompt?.addEventListener('keyup', () => { state.composerCursor = prompt.selectionStart; updateImageReferenceMenu() })
    prompt?.addEventListener('keydown', (event) => {
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
    state.queuedTasks = []
    state.queueMenuId = null
    renderApp()
  }
  function removeQueuedTask(id) {
    state.queuedTasks = state.queuedTasks.filter((task) => task.id !== id)
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
    if (payload.imageUnsupported) {
      state.queuedTasks.splice(index, 0, task)
      state.error = `当前模型 ${currentModel()?.name || state.model} 不支持图片输入，请切换到带视觉能力的模型后再发送`
      renderApp()
      return
    }
    insertTimelineMessage({ role: 'user', content: payload.content, attachments: payload.attachments, createdAt: Number(task.createdAt || Date.now()) })
    state.error = ''
    renderApp()
    try {
      await persistImageAttachments(payload, payload.content + payload.attachmentText)
      await window.anyu.piCommand({ type: 'steer', message: payload.content + payload.attachmentText, images: payload.images.length ? payload.images : undefined })
    } catch (error) {
      state.queuedTasks.splice(Math.min(index, state.queuedTasks.length), 0, task)
      const localMessageIndex = state.messages.findIndex((message) => message.role === 'user' && message.content === payload.content && message.attachments === payload.attachments)
      if (localMessageIndex >= 0) state.messages.splice(localMessageIndex, 1)
      state.error = errorText(error) || '调整方向失败'
      renderApp()
    }
  }
  async function answerPermission(answer) { if (!state.permission) return; const request = state.permission; state.permission = null; renderApp(); await window.anyu.piUiResponse({ id: request.id, ...answer }) }
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
      const result = await window.anyu.piCommand({ type: 'get_state' })
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
    state.runPoll = window.setInterval(() => { void reconcileRunState() }, 1500)
  }
  function finishAgentRun() {
    if (!state.loading && !state.activeRequest) return
    clearActiveRequest()
    state.loading = false
    state.streamingMessage = null
    for (const message of state.messages) {
      if (message.isStreaming) {
        message.isStreaming = false
        message.finishedAt = message.finishedAt || Date.now()
      }
    }
    // Flush the terminal state immediately. A queued animation frame may have
    // already rendered the previous loading state, so coalescing another frame
    // here could leave the stop button and activity indicator stale.
    state.renderQueued = false
    updateLiveUi(true)
    Promise.all([refreshMessages(), refreshSessions()]).then(() => { scheduleAppRender(); scheduleQueueDrain() }).catch(() => { scheduleAppRender(); scheduleQueueDrain() })
  }
  function finishRequestWithError(error, fallback = '发送失败，请稍后重试') {
    const detail = errorText(error)
    clearActiveRequest(); state.loading = false; state.error = detail || fallback; scheduleAppRender(); scheduleQueueDrain()
  }
  async function abortRun() {
    if (!state.loading) return
    clearActiveRequest(); state.loading = false; state.error = '已停止当前任务'
    scheduleLiveUi(true)
    try { await window.anyu.piCommand({ type: 'abort' }) } catch (error) { state.error = error.message || '停止任务失败' }
    scheduleAppRender()
  }
  function scheduleQueueDrain() {
    if (state.queueDraining || state.loading || !state.queuedTasks.length) return
    state.queueDraining = true
    scheduleAppRender()
    window.setTimeout(async () => {
      state.queueDraining = false
      if (state.loading || !state.queuedTasks.length) return
      const task = state.queuedTasks.shift()
      state.queueMenuId = null
      await runTask(task)
    }, 0)
  }
  async function newConversation() {
    clearActiveRequest(); state.loading = false; state.queuedTasks = []; state.queueMenuId = null; state.queueDraining = false
    await window.anyu.piStop(); state.sessionPath = null; state.sessionCwd = null; state.cwd = localStorage.getItem('anyu.cwd') || ''; state.messages = []; state.imageLibrary = []; state.error = ''
    try { await startAgent(null) } catch (error) { state.error = error.message || '创建会话失败' }
    renderApp()
  }
  async function runTask(task) {
    if (!task || state.loading) {
      if (task) state.queuedTasks.unshift(task)
      return
    }
    const prompt = document.querySelector('#prompt')
    const payload = taskPayload(task)
    const mediaSkill = mediaSkillForPrompt(task.content)
    if (mediaSkill) {
      void runMediaSkill(task, mediaSkill).catch((error) => { state.error = errorText(error) || '技能执行失败'; renderApp() })
      return
    }
    if (payload.imageUnsupported) {
      state.attachments = [...payload.attachments, ...state.attachments]
      state.error = `当前模型 ${currentModel()?.name || state.model} 不支持图片输入，请切换到带视觉能力的模型后再发送`
      renderApp()
      return
    }
    const message = { role: 'user', content: payload.content, attachments: payload.attachments }
    state.activeRequest = { ...payload, taskId: task.id }; state.retryNotice = ''; state.runInProgress = false
    message.createdAt = Number(task.createdAt || Date.now())
    state.loading = true; state.error = ''; insertTimelineMessage(message); updateSessionTitle(payload.content, message.createdAt); state.composerText = ''; if (prompt) prompt.value = ''
    renderApp(); updateLiveUi(true); startRunMonitor()
    try {
      if (!state.piState) await startAgent(state.sessionPath)
      await persistImageAttachments(payload, payload.content + payload.attachmentText)
      await window.anyu.piCommand({ type: 'prompt', message: payload.content + payload.attachmentText, images: payload.images.length ? payload.images : undefined })
    } catch (error) { finishRequestWithError(error) }
  }
  async function sendMessage() {
    const prompt = document.querySelector('#prompt'); const typed = prompt?.value.trim() || state.composerText.trim() || ''
    if ((!typed && !state.attachments.length)) return
    const submittedAttachments = state.attachments.splice(0)
    const task = { id: taskId(), content: typed, attachments: submittedAttachments, createdAt: Date.now() }
    if (state.loading) {
      state.queuedTasks.push(task); state.queueMenuId = null; state.error = ''
      state.composerText = ''; if (prompt) prompt.value = ''
      renderApp()
      requestAnimationFrame(() => document.querySelector('#prompt')?.focus())
      return
    }
    await runTask(task)
  }

  function handlePiEvent(event) {
    if (!event || event.type === 'response') return
    if ((event.type === 'thinking_level_changed' || event.type === 'thinking_level_change') && THINKING_LEVELS.includes(event.level)) {
      state.thinkingLevel = event.level
      localStorage.setItem(thinkingStorageKey(), event.level)
      scheduleAppRender()
      return
    }
    if (state.sessionSwitching) return
    if (event.type === 'message_start') {
      const message = event.message || event.assistantMessage
      if (message?.role === 'assistant') {
        state.streamingMessage = { role: 'assistant', content: '', createdAt: timestampValue(message.timestamp) || Date.now(), isStreaming: true }
        insertTimelineMessage(state.streamingMessage)
        scheduleLiveUi(true)
      }
      return
    }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent || event.messageEvent || event.delta || event.update
      let delta = ''
      if (typeof update === 'string') delta = update
      else if (update?.type === 'thinking_delta') {
        if (state.streamingMessage) state.streamingMessage.thinking = `${state.streamingMessage.thinking || ''}${update.delta || ''}`
        scheduleLiveUi(true); return
      } else if (update?.type === 'text_delta' || update?.type === 'text') delta = update.delta || update.text || ''
      else if (typeof update?.delta === 'string') delta = update.delta
      if (delta && state.streamingMessage) { state.streamingMessage.content += delta; scheduleLiveUi(true) }
      return
    }
    if (event.type === 'message_end' && event.message) {
      if (event.message.role === 'assistant') {
        const content = textOf(event.message.content) || event.message.errorMessage || ''
        const hasError = Boolean(event.message.errorMessage)
        if (state.streamingMessage) { state.streamingMessage.content = content || state.streamingMessage.content; state.streamingMessage.isError = hasError; state.streamingMessage.isStreaming = false; state.streamingMessage = null }
        else insertTimelineMessage({ role: 'assistant', content, createdAt: timestampValue(event.message.timestamp) || Date.now(), isError: hasError })
        // Pi owns retry policy. Re-sending the prompt here would duplicate a user
        // request when Pi retries an overloaded upstream provider. The failure
        // remains visible in the conversation while agent_end decides whether it
        // is final or will be retried.
        scheduleLiveUi(true)
      }
      return
    }
    if (event.type === 'tool_execution_start') { insertTimelineMessage({ role: 'tool', toolName: event.toolName, toolCallId: event.toolCallId || event.id, args: event.args || {}, content: '', createdAt: Date.now(), isStreaming: true, startedAt: Date.now() }); scheduleLiveUi(true); return }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') { const result = event.partialResult || event.result; const output = textOf(result?.content || result?.output || '') || (typeof result === 'string' ? result : ''); const item = [...state.messages].reverse().find((message) => message.role === 'tool' && ((event.toolCallId && message.toolCallId === event.toolCallId) || message.toolName === event.toolName)); if (item) { item.args = event.args || item.args; item.content = output || item.content; item.isError = Boolean(event.isError); item.isStreaming = event.type !== 'tool_execution_end'; if (!item.isStreaming) item.finishedAt = Date.now(); scheduleLiveUi(true) }; return }
    if (event.type === 'extension_ui_request') {
      if (event.method === 'confirm' && effectivePermissionMode() === 'full') { window.anyu.piUiResponse({ id: event.id, confirmed: true }); return }
      if (['confirm', 'select', 'input'].includes(event.method)) { state.permission = event; renderApp() }
      return
    }
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      state.loading = true
      state.runInProgress = true
      if (!state.runPoll) startRunMonitor()
      state.retryNotice = ''
      scheduleLiveUi(true)
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
      scheduleLiveUi(true)
      return
    }
    if (event.type === 'auto_retry_start') {
      state.loading = true
      state.retryNotice = `模型服务暂时不可用，Pi 正在自动重试（${event.attempt || 1}/${event.maxAttempts || 3}）…`
      scheduleLiveUi(true)
      return
    }
    if (event.type === 'agent_settled') {
      finishAgentRun()
      return
    }
    if (event.type === 'session_info_changed') { refreshSessions().then(() => scheduleAppRender()); return }
  }
  window.anyu.onPiEvent(handlePiEvent)
  window.anyu.onUpdateProgress?.((event) => {
    const update = event || {}
    if (update.phase === 'downloading') state.update = { ...state.update, status: 'downloading', latestVersion: update.version || state.update.latestVersion, percent: Number(update.percent || 0) }
    else if (update.phase === 'installing') state.update = { ...state.update, status: 'installing', latestVersion: update.version || state.update.latestVersion, percent: 100 }
    else if (update.phase === 'error') state.update = { ...state.update, status: 'error', message: update.message || '自动更新失败' }
    updateUpdateControl()
  })
  if (window.anyu.updateState) {
    window.anyu.updateState().then((update) => {
      if (!update || update.status !== 'error') return
      state.update = { ...state.update, status: 'error', message: update.message || '上次自动更新失败' }
      scheduleAppRender()
    }).catch(() => {})
  }
  window.anyu.onPiExit(() => { clearActiveRequest(); state.piState = null; state.loading = false; if (state.sessionSwitching) return; state.error = 'Pi Agent 进程已退出，请刷新重试'; if (state.user) renderApp() })
  window.anyu.onPiStderr((message) => { if (/error|failed|exception/i.test(message) && !state.loading) { state.error = message.trim().slice(-500); scheduleAppRender() } })
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
