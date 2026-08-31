(() => {
  const root = document.querySelector('#app')
  const mediaObjectUrls = new Map()
  const state = {
    user: null, keys: [], catalog: [], catalogSource: '', sessions: [], sessionPath: null,
    messages: [], mediaMessages: {}, mediaBusyCount: 0, mediaActivity: {}, attachments: [], imageLibrary: [], composerText: '', imageMenuOpen: false, imagePreview: null,
    selectedKey: Number(localStorage.getItem('anyu.selectedKey') || 0),
    model: localStorage.getItem('anyu.selectedModel') || '', cwd: localStorage.getItem('anyu.cwd') || '', sessionCwd: null,
    thinkingLevel: localStorage.getItem('anyu.thinkingLevel') || 'medium', thinkingLevels: ['off'],
    loading: false, skillBusy: null, error: '', twoFactor: null, permission: null, piState: null,
    authChecking: true, activeRequest: null, retryNotice: '', runStartedAt: 0, runWatchdog: null, runPoll: null,
    renderQueued: false, streamingMessage: null, forceScroll: false, appRenderQueued: false,
    settingsOpen: false, skillsMarketOpen: false, skillsLoading: false, skillGroups: [], skillMenuOpen: false, skillEnabled: { image: true, video: true },
    skillConfigs: { image: { groupId: 0, model: 'gpt-image-2', size: '1024x1024', quality: 'auto' }, video: { groupId: 0, model: '' } },
    switching: false, sessionSwitching: false, sessionSwitchToken: 0, balanceRefresh: null,
    update: { status: 'idle', currentVersion: '', latestVersion: '', percent: 0, message: '' },
    queuedTasks: [], queueMenuId: null, queueDraining: false, sessionMenu: null, composerCursor: null,
    permissionMode: localStorage.getItem('anyu.permissionMode') || 'confirm'
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
  const providerForApi = (api) => api === 'anthropic-messages' ? 'anyu-gateway-anthropic' : api === 'google-generative-ai' || api === 'google-vertex' ? 'anyu-gateway-gemini' : 'anyu-gateway-openai'
  const canonicalApi = (value, fallback = 'openai-completions') => { const raw = String(value || '').toLowerCase(); if (raw.includes('anthropic') || raw.includes('claude')) return 'anthropic-messages'; if (raw.includes('google') || raw.includes('gemini')) return 'google-generative-ai'; if (raw.includes('response')) return 'openai-responses'; if (raw.includes('openai') || raw.includes('completion') || raw.includes('chat')) return 'openai-completions'; return fallback }
  const selectedKey = () => state.keys.find((key) => Number(key.id) === state.selectedKey)
  const currentModel = () => state.catalog.find((item) => item.id === state.model)
  const effectiveWorkspace = () => state.sessionCwd || state.cwd || ''
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

  function render() { state.user ? renderApp() : renderLogin() }
  function windowControlsMarkup(className = '') {
    return `<div class="window-controls ${className}" aria-label="窗口控制"><button type="button" data-window-action="minimize" title="最小化">−</button><button type="button" data-window-action="maximize" title="最大化">□</button><button type="button" data-window-action="close" title="关闭">×</button></div>`
  }
  function renderLogin() {
    const two = state.twoFactor
    if (state.authChecking) {
      root.innerHTML = `<main class="login">${windowControlsMarkup('login-window-controls')}<section class="login-card auth-checking"><div class="brand"><div class="brand-mark">A</div><div><h1>AnYuAgent</h1><small>独立 Pi Agent 桌面客户端</small></div></div><div class="login-loading"><span class="spinner"></span><span>正在检查登录状态…</span></div><p class="muted" style="font-size:11px;margin-top:24px">正在连接 Anyu 账号服务</p></section></main>`
      document.querySelectorAll('[data-window-action]').forEach((node) => node.addEventListener('click', () => window.anyu.windowAction(node.dataset.windowAction)))
      return
    }
    root.innerHTML = `<main class="login">${windowControlsMarkup('login-window-controls')}<section class="login-card">
      <div class="brand"><div class="brand-mark">A</div><div><h1>AnYuAgent</h1><small>独立 Pi Agent 桌面客户端</small></div></div>
      ${two ? `<h2>完成安全验证</h2><p class="muted">账号 ${esc(two.user_email_masked || '')} 已开启双重验证。</p>
        <div class="field"><label>Authenticator 验证码</label><input id="totp" inputmode="numeric" maxlength="6" placeholder="输入 6 位验证码"></div>
        <button class="primary" id="verify">进入 AnYuAgent</button>` : `<h2>登录 AnYuAgent</h2><p class="muted">登录后同步 Anyu 密钥，在本地 Pi Agent 中对话。</p>
        <div class="field"><label>Anyu 邮箱</label><input id="email" type="email" autocomplete="username" placeholder="name@example.com"></div>
        <div class="field"><label>密码</label><input id="password" type="password" autocomplete="current-password" placeholder="输入 Anyu 密码"></div>
        <button class="primary" id="login">登录并开始</button>`}
      ${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}
      <p class="muted" style="font-size:11px;margin-top:24px">独立桌面客户端 · Pi 会话只保存在本机</p>
    </section></main>`
    document.querySelectorAll('[data-window-action]').forEach((node) => node.addEventListener('click', () => window.anyu.windowAction(node.dataset.windowAction)))
    const button = document.querySelector(two ? '#verify' : '#login')
    button?.addEventListener('click', async () => {
      state.error = ''; button.disabled = true; button.textContent = '正在验证…'
      try {
        if (two) {
          const data = await window.anyu.login2fa({ temp_token: two.temp_token, totp_code: document.querySelector('#totp').value.trim() })
          state.user = data.user; state.twoFactor = null; await bootstrap()
        } else {
          const data = await window.anyu.login({ email: document.querySelector('#email').value.trim(), password: document.querySelector('#password').value, turnstile_token: '' })
          if (data.requires_2fa) state.twoFactor = data
          else { state.user = data.user; await bootstrap() }
        }
        render()
      } catch (error) { state.error = error.message || '登录失败，请检查账号和网络'; render() }
    })
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
    if (!state.selectedKey || !state.keys.some((key) => Number(key.id) === state.selectedKey)) state.selectedKey = Number(state.keys[0]?.id || 0)
    localStorage.setItem('anyu.selectedKey', String(state.selectedKey || ''))
  }
  function keyPlatform(key = selectedKey()) {
    return String(key?.group?.platform || key?.groups?.[0]?.platform || key?.platform || key?.provider || '').trim()
  }
  function normalizeModel(model, platform = '') {
    const id = String(model?.id || model?.name || model?.model_id || '').replace(/^models\//, '').trim()
    if (!id) return null
    const lower = `${id} ${platform} ${model?.api || model?.protocol || ''}`.toLowerCase()
    const apiName = lower.includes('gemini') || lower.includes('google') ? 'google-generative-ai' : lower.includes('claude') || lower.includes('anthropic') ? 'anthropic-messages' : 'openai-completions'
    const api = canonicalApi(model?.api, apiName)
    const capabilities = modelCapabilities(model, id, api)
    const rawMap = model?.thinkingLevelMap || model?.thinking_level_map || model?.reasoning_effort_map || model?.reasoningEffortMap
    const rawLevels = model?.thinkingLevels || model?.thinking_levels || model?.reasoning_levels || model?.reasoningLevels
    const inferredReasoning = inferredReasoningConfig(id, api)
    const reasoning = Boolean(model?.reasoning || rawMap || (Array.isArray(rawLevels) && rawLevels.length) || inferredReasoning.reasoning)
    const thinkingLevels = Array.isArray(rawLevels) ? rawLevels.map((level) => String(level).toLowerCase()).filter((level) => THINKING_LEVELS.includes(level)) : undefined
    const thinkingLevelMap = rawMap && typeof rawMap === 'object' ? rawMap : thinkingLevels?.length ? Object.fromEntries(THINKING_LEVELS.map((level) => [level, thinkingLevels.includes(level) ? level : null])) : inferredReasoning.thinkingLevelMap
    return { id, name: model?.name || model?.display_name || model?.displayName || id, api, provider: providerForApi(api), reasoning, thinkingLevels, thinkingLevelMap, input: capabilities.input, supportsImages: capabilities.supportsImages, contextWindow: model?.context_window || model?.contextWindow || 128000, maxTokens: model?.max_tokens || model?.maxTokens || 16384 }
  }
  async function loadCatalog() {
    try {
      const data = await api('/integrations/pi/catalog')
      const models = (data?.models || data?.items || []).map((item) => normalizeModel(item)).filter(Boolean)
      if (models.length) { state.catalogSource = 'Anyu Pi 目录'; return models }
    } catch {}
    try {
      const data = await api('/groups/available')
      const groups = data?.items || data?.groups || (Array.isArray(data) ? data : [])
      const models = groups.flatMap((group) => {
        return (group.models || group.model_list || group.available_models || []).map((item) => normalizeModel(item, group.platform))
      }).filter(Boolean)
      if (models.length) { state.catalogSource = 'Anyu 模型目录'; return [...new Map(models.map((item) => [item.id, item])).values()] }
    } catch {}
    for (const route of ['/models', '/models/available']) {
      try {
        const data = await api(route)
        const models = (data?.models || data?.items || (Array.isArray(data) ? data : [])).map((item) => normalizeModel(item)).filter(Boolean)
        if (models.length) { state.catalogSource = 'Anyu 模型目录'; return [...new Map(models.map((item) => [item.id, item])).values()] }
      } catch {}
    }
    const fromKeys = state.keys.flatMap((key) => (key.models || key.model_list || []).map((item) => normalizeModel(item))).filter(Boolean)
    if (!fromKeys.length) {
      const perKey = await Promise.all(state.keys.filter((key) => key.status === 'active' || !key.status).slice(0, 20).map(async (key) => {
        for (const route of [`/keys/${key.id}/models?role=chat`, `/codex/keys/${key.id}/models?role=chat`]) {
          try {
            const data = await api(route)
            const models = (data?.items || data?.models || (Array.isArray(data) ? data : [])).map((item) => normalizeModel(item)).filter(Boolean)
            if (models.length) return models
          } catch {}
        }
        return []
      }))
      fromKeys.push(...perKey.flat())
    }
    const usable = fromKeys
    state.catalogSource = usable.length ? '密钥模型目录' : '暂无目录'
    return [...new Map(usable.map((item) => [item.id, item])).values()]
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
      const models = Array.isArray(group.models) ? group.models : []
      return kind === 'image' ? Boolean(group.allow_image_generation) && (String(group.platform || '').toLowerCase() === 'openai' || models.some((model) => String(model.capability || '').toLowerCase() === 'image')) : models.some((model) => String(model.capability || '').toLowerCase() === 'video')
    }))]
  }
  function availableSkillGroups(kind) {
    const groups = state.skillGroups.filter((group) => {
      const active = !group.status || String(group.status).toLowerCase() === 'active'
      const models = Array.isArray(group.models) ? group.models : []
      if (!active || group.data_sharing_enabled) return false
      if (kind === 'image') return Boolean(group.allow_image_generation) && (String(group.platform || '').toLowerCase() === 'openai' || models.some((model) => String(model.capability || '').toLowerCase() === 'image'))
      return models.some((model) => model.capability === 'video') || ['grok', 'xai'].includes(String(group.platform || '').toLowerCase())
    })
    const ids = keyCapabilityGroupIds(kind)
    return ids.length ? groups.filter((group) => ids.includes(Number(group.id))) : groups
  }
  function skillModels(kind) {
    const groups = availableSkillGroups(kind)
    return groups.flatMap((group) => {
      const configured = (group.models || []).filter((model) => kind === 'image' ? String(model.capability || '').toLowerCase() === 'image' : String(model.capability || '').toLowerCase() === 'video')
      const fallback = kind === 'image' && !configured.length && String(group.platform || '').toLowerCase() === 'openai' ? [{ name: 'gpt-image-2', display_name: 'GPT Image 2', capability: 'image' }] : kind === 'video' && !configured.length && ['grok', 'xai'].includes(String(group.platform || '').toLowerCase()) ? [{ name: 'grok-imagine-video-1.5', display_name: 'Grok Imagine Video 1.5', capability: 'video', duration_min: 1, duration_max: 15, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], max_reference_images: 1, uses_grok_fields: true }] : []
      return [...configured, ...fallback].map((model) => ({ ...model, groupId: Number(group.id), groupName: group.name }))
    })
  }
  function ensureSkillSelection() {
    for (const kind of ['image', 'video']) {
      const config = state.skillConfigs[kind]
      const groups = availableSkillGroups(kind); const models = skillModels(kind)
      const preferredGroup = Number(config.groupId)
      const groupModels = preferredGroup ? models.filter((model) => Number(model.groupId) === preferredGroup) : models
      const selectedModel = groupModels.find((model) => model.name === config.model)
      const fallbackModel = selectedModel || groupModels[0] || models[0]
      if (fallbackModel) { config.groupId = Number(fallbackModel.groupId); config.model = fallbackModel.name }
      else if (groups[0]) config.groupId = Number(groups[0].id)
    }
  }
  async function loadSkillGroups() {
    try {
      const data = await window.anyu.skillsGroups()
      state.skillGroups = Array.isArray(data) ? data : data?.items || data?.groups || []
      ensureSkillSelection()
    } catch (error) {
      state.skillGroups = []
      state.error = error.message || '技能目录加载失败'
    }
  }
  function protocolLabel(model) {
    if (model?.api === 'anthropic-messages') return 'Claude / Anthropic'
    if (model?.api === 'google-generative-ai' || model?.api === 'google-vertex') return 'Gemini / Google'
    const name = String(model?.id || '').toLowerCase()
    if (/deepseek|qwen|glm|通义|千问|豆包|doubao|moonshot|kimi|minimax|yi-|zhipu|baichuan|ernie|混元/.test(name)) return '国产模型'
    return 'GPT / OpenAI 兼容'
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
          createdAt: Number(message.timestamp || message.createdAt || message.time || 0) || index,
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
      if (!existing.title || existing.title === '新会话') existing.title = title
      existing.modified = Math.max(Number(existing.modified || 0), Number(createdAt || Date.now()))
    } else state.sessions.unshift({ path, title, modified: Number(createdAt || Date.now()) })
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
    if (!state.selectedKey || !state.model) throw new Error('请先选择可用密钥和模型')
    const result = await window.anyu.piStart({ keyId: state.selectedKey, model: state.model, provider: currentModel()?.provider, models: state.catalog, sessionPath, cwd: effectiveWorkspace() || undefined, permissionMode: state.permissionMode })
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
    startBalanceRefresh()
    await loadKeys(); await loadSkillGroups(); state.catalog = await loadCatalogForKey(state.selectedKey); chooseModel(); ensureSkillSelection(); await refreshSessions()
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
    const config = state.skillConfigs[kind]
    const models = skillModels(kind)
    const model = models.find((item) => item.name === config.model && Number(item.groupId) === Number(config.groupId)) || models[0]
    if (!model || !config.groupId) throw new Error(`当前密钥没有可用的${kind === 'image' ? '生图' : '生视频'}分组或模型`)
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
        created = await window.anyu.imageCreate({ prompt: refinedPrompt, groupId: config.groupId, model: model.name, size: config.size || '1024x1024', quality: config.quality || 'auto', count, references })
      } else {
        const plan = planVideoRequest(promptText, model, references)
        created = await window.anyu.videoCreate({ prompt: promptText, groupId: config.groupId, model: model.name, duration: plan.duration, resolution: plan.resolution, aspectRatio: plan.aspectRatio, references: plan.files })
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
      if (structuralChange) box.innerHTML = messagesMarkup()
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
        renderApp()
      })
  }

  function keyHtml(key) {
    const selected = Number(key.id) === state.selectedKey
    const hint = key.provider || key.billing_mode || 'Anyu 路由密钥'
    return `<div class="key ${selected ? 'selected' : ''}" data-key="${esc(key.id)}"><div class="key-name"><span class="dot ${key.status && key.status !== 'active' ? 'off' : ''}"></span>${esc(keyDisplayName(key))}</div><div class="key-meta"><span>${esc(cleanDisplayText(hint) || 'Anyu 路由密钥')}</span><span>${key.status === 'active' || !key.status ? '可用' : esc(cleanDisplayText(key.status))}</span></div></div>`
  }
  function messageHtml(message) {
    const user = message.role === 'user'; const tool = message.role === 'tool'
    if (tool) {
      const status = message.isStreaming ? '运行中' : message.isError ? '失败' : '已完成'
      const expanded = message.isStreaming ? 'open' : ''
      const duration = message.startedAt ? `<span class="tool-duration">${esc(formatDuration((message.finishedAt || Date.now()) - message.startedAt))}</span>` : ''
      const args = message.args && Object.keys(message.args).length ? `<details class="tool-section" ${expanded}><summary>参数</summary><pre>${esc(JSON.stringify(message.args, null, 2))}</pre></details>` : ''
      const output = message.content ? `<details class="tool-section" ${expanded}><summary>输出</summary><pre>${esc(message.content)}</pre></details>` : ''
      const progress = message.isStreaming && !message.content ? '<div class="tool-progress"><span></span>正在等待工具输出…</div>' : ''
      return `<article class="message tool-message"><div class="avatar tool-avatar">⌘</div><details class="tool-card" ${expanded}><summary><span class="tool-chevron">›</span><span class="message-role">工具 · ${esc(message.toolName || '执行')}</span>${duration}<span class="tool-status ${message.isError ? 'failed' : message.isStreaming ? 'running' : ''}">${status}</span></summary><div class="tool-card-body">${progress}${args}${output}${message.isError ? '<span class="tool-error">执行失败</span>' : ''}</div></details></article>`
    }
    const thinking = message.thinking ? `<details class="thinking-card"><summary><span class="tool-chevron">›</span>思考过程</summary><div>${esc(message.thinking)}</div></details>` : ''
    const streaming = message.isStreaming && !message.content ? '<span class="typing-dots"><i></i><i></i><i></i></span>' : ''
    const bubble = message.content ? esc(message.content) : streaming
    const media = message.media?.kind === 'video' ? `<div class="generated-video"><video src="${esc(mediaSourceUrl(message))}" controls playsinline preload="auto"></video><button type="button" class="media-download" data-download-video="${esc(message.id || '')}" title="下载视频">↓ 下载视频</button></div>` : ''
    return `<article class="message ${user ? 'user' : ''}"><div class="avatar">${user ? initials(state.user?.email) : 'A'}</div><div class="message-body"><div class="message-role">${user ? '你' : 'AnYuAgent'}</div>${thinking}<div class="message-bubble ${message.isError ? 'tool-error' : ''} ${message.isStreaming ? 'streaming-bubble' : ''}">${bubble || '<span class="message-placeholder"> </span>'}</div>${media}${message.attachments?.length ? `<div class="message-attachments">${message.attachments.map((attachment) => attachmentMarkup(attachment, false)).join('')}</div>` : ''}</div></article>`
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
  function skillCapabilityRows(kind, models) {
    if (!models.length) return `<div class="skill-capability-empty">当前密钥暂无${kind === 'image' ? '生图' : '生视频'}模型</div>`
    return models.map((model) => {
      const title = model.display_name || model.name
      const meta = kind === 'video' ? mediaCapabilitySummary(model, kind) : (model.description || '参考图编辑与图片生成')
      return `<details class="skill-capability" ${models.length === 1 ? 'open' : ''}><summary><span>${esc(title)}</span></summary><div>${esc(meta)}</div></details>`
    }).join('')
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
    return `<div class="skills-market"><div class="market-heading"><div><div class="modal-kicker">AnYuAgent Skills</div><h4>技能市场</h4><p>输入 @生图 或 @生视频后，技能会根据描述、参考图和当前模型能力自动选择参数。</p></div><span class="market-status">${state.skillsLoading ? '同步中…' : `${imageModels.length + videoModels.length} 个可用模型`}</span></div><div class="skill-grid"><article class="skill-card"><div class="skill-card-icon image">✦</div><div class="skill-card-copy"><strong>生图 Skill</strong><span>自动处理图片生成与参考图编辑，遵循当前密钥的模型目录。</span><small>${imageModels.length ? `${imageModels.length} 个模型 · ${esc(state.skillConfigs.image.model)}` : '当前密钥暂无生图模型'}</small></div><button class="skill-toggle ${state.skillEnabled.image ? 'enabled' : ''}" data-skill-toggle="image">${state.skillEnabled.image ? '已启用' : '启用'}</button></article><article class="skill-card"><div class="skill-card-icon video">◉</div><div class="skill-card-copy"><strong>生视频 Skill</strong><span>自动理解时长、画幅和画质意图，并适配首帧、首尾帧、多图及厂商协议。</span><small>${videoModels.length ? `${videoModels.length} 个模型 · ${esc(state.skillConfigs.video.model)}` : '当前密钥暂无视频模型'}</small></div><button class="skill-toggle ${state.skillEnabled.video ? 'enabled' : ''}" data-skill-toggle="video">${state.skillEnabled.video ? '已启用' : '启用'}</button></article></div><div class="skill-config"><div class="config-title">技能模型</div><div class="config-row"><label>生图分组<select id="skill-image-group">${skillGroupOptions('image') || '<option value="">暂无可用分组</option>'}</select></label><label>生图模型<select id="skill-image-model">${skillModelOptions('image') || '<option value="">暂无可用模型</option>'}</select></label></div><div class="config-row"><label>视频分组<select id="skill-video-group">${skillGroupOptions('video') || '<option value="">暂无可用分组</option>'}</select></label><label>视频模型<select id="skill-video-model">${skillModelOptions('video') || '<option value="">暂无可用模型</option>'}</select></label></div><div class="skill-capability-heading">当前密钥可用能力</div><div class="skill-capability-list"><div class="skill-capability-kind"><strong>图片</strong>${skillCapabilityRows('image', imageModels)}</div><div class="skill-capability-kind"><strong>视频</strong>${skillCapabilityRows('video', videoModels)}</div></div><p class="skill-auto-note">时长、清晰度、画幅和参考素材不在这里手动配置。发送任务时，AnYuAgent 会根据你的描述和上方能力目录自动规划，并由服务端再次校验。</p></div></div>`
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
    return `<div class="modal-backdrop settings-backdrop"><section class="settings-modal"><div class="settings-head"><div><div class="modal-kicker">AnYuAgent</div><h3>设置</h3></div><button class="icon-button" id="settings-close" title="关闭">×</button></div>
      <div class="setting-block"><label for="permission-mode">本机访问权限</label><select id="permission-mode"><option value="confirm" ${state.permissionMode === 'confirm' ? 'selected' : ''}>受控访问 · 每次操作确认</option><option value="full" ${state.permissionMode === 'full' ? 'selected' : ''}>完整访问 · 自动允许工具操作</option></select><p>完整访问会允许 Pi 读写工作目录并执行终端工具；切换后会重启本地 Agent。</p></div>
      <div class="setting-block skill-market-block"><div class="setting-label-row"><label>技能市场</label><button class="ghost" id="skills-refresh">同步目录</button></div>${skillsMarketMarkup()}</div>
      <div class="setting-block"><label>工作目录</label><div class="setting-value">${esc(effectiveWorkspace() || '尚未选择')}</div><button class="ghost" id="settings-cwd">选择目录</button></div>
      <div class="setting-block"><label>账号</label><div class="setting-value">${esc(state.user?.email || 'Anyu 用户')}</div></div>
      <div class="settings-actions"><button class="ghost" id="settings-logout">切换账号</button><button class="primary modal-primary" id="settings-done">完成</button></div>
    </section></div>`
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

  function renderApp() {
    const restorePromptFocus = document.activeElement?.id === 'prompt'
    const restorePromptCursor = restorePromptFocus ? Number(document.activeElement?.selectionStart) : null
    const key = selectedKey()
    const keyLabel = keyDisplayName(key)
    const model = currentModel()
    const controlsBusy = state.switching || state.sessionSwitching
    root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="side-brand"><div class="brand-mark">A</div><div><strong>AnYuAgent</strong><span>独立 Pi Agent</span></div></div>
      <div class="nav-section"><div class="nav-title">工作区</div><div class="nav-item active"><span class="nav-icon">✦</span>Agent 对话</div><button class="nav-item nav-button" id="new-chat"><span class="nav-icon">＋</span>新建会话</button></div>
       <div class="nav-section sessions-section"><div class="nav-title">本机会话</div><div id="session-list">${state.sessions.slice(0, 30).map((item) => `<button class="nav-item session ${item.path === state.sessionPath ? 'active' : ''}" data-path="${esc(item.path)}"><span class="nav-icon">${item.pinned ? '★' : '○'}</span><span class="session-label">${esc(item.title || '新会话')}</span></button>`).join('') || '<div class="empty-sessions">暂无会话</div>'}</div></div>
      <div class="side-footer"><button class="update-link ${state.update.status === 'error' ? 'error' : ''}" id="update-app" ${['checking', 'downloading', 'installing'].includes(state.update.status) ? 'disabled' : ''}><span class="nav-icon update-icon ${['checking', 'downloading', 'installing'].includes(state.update.status) ? 'spinning' : ''}">↻</span><span class="update-label">${esc(updateButtonLabel())}</span></button><button class="settings-link" id="settings-open"><span class="nav-icon">⚙</span>设置</button><div class="balance-summary" title="每 60 秒自动同步"><div class="balance-caption"><span>剩余额度</span><span class="balance-sync-dot"></span></div><strong>${esc(formatBalance())}</strong></div><div class="user-line"><div class="avatar">${initials(state.user?.email)}</div><div class="user-email" title="${esc(state.user?.email)}">${esc(state.user?.email || 'Anyu 用户')}</div></div></div></aside>
      <main class="main"><header class="topbar"><div class="topbar-title"><h2>Agent 对话</h2><span class="connection-dot ${state.piState ? '' : 'offline'}"></span><span class="connection-label">${state.piState ? '已连接' : '未连接'}</span></div><div class="top-actions"><span class="muted model-count">${state.catalog.length} 个模型</span><button class="icon-button" id="refresh" title="刷新">↻</button><div class="window-controls" aria-label="窗口控制"><button type="button" data-window-action="minimize" title="最小化">−</button><button type="button" data-window-action="maximize" title="最大化">□</button><button type="button" data-window-action="close" title="关闭">×</button></div></div></header>
      ${state.error ? `<div class="app-alert" role="status">${esc(state.error)}</div>` : ''}
      <div class="conversation"><section class="chat-panel"><div class="chat-head"><div><div class="chat-title">${esc(state.sessions.find((item) => item.path === state.sessionPath)?.title || '新会话')}</div><div class="chat-subtitle">${esc(model ? `${protocolLabel(model)} · ${model.name || model.id}` : '选择密钥和模型后开始')}</div></div><button class="ghost" id="new-chat-main">＋ 新会话</button></div>
         <div class="messages" id="messages">${messagesMarkup()}</div>
           <div class="composer">${queuedTasksMarkup()}${attachmentsMarkup()}<div class="composer-tools"><div class="key-picker-wrap"><button class="picker-button" id="key-picker" title="选择 Anyu 密钥" ${controlsBusy ? 'disabled' : ''}><span class="picker-icon">⌁</span><span class="picker-text">${esc(keyLabel)}</span><span class="picker-chevron">⌄</span></button>${state.keyMenuOpen ? `<div class="key-menu"><div class="menu-caption">Anyu 密钥 <span>${state.keys.length}</span></div>${state.keys.map((item) => `<button class="key-option ${Number(item.id) === state.selectedKey ? 'selected' : ''}" data-key="${esc(item.id)}" ${controlsBusy ? 'disabled' : ''}><span class="dot ${item.status && item.status !== 'active' ? 'off' : ''}></span><span class="key-option-label">${esc(item.name || item.title || `密钥 ${item.id}`)}</span><span class="key-option-status">${item.status === 'active' || !item.status ? '可用' : esc(item.status)}</span></button>`).join('') || '<div class="muted menu-empty">暂无密钥</div>'}</div>` : ''}</div><select id="model" class="model-picker" title="选择模型" ${controlsBusy ? 'disabled' : ''}>${modelOptionsMarkup() || '<option value="">暂无模型</option>'}</select><button class="permission-button ${state.permissionMode === 'full' ? 'full' : ''}" id="permission-quick" title="本机访问权限"><span>${state.permissionMode === 'full' ? '⚡ 完整访问' : '✓ 受控访问'}</span></button><button class="ghost cwd-button" id="choose-cwd" title="工作目录">⌂ ${esc(state.cwd ? state.cwd.split('\\').pop() || state.cwd : '目录')}</button></div><div class="composer-box"><button class="attach-button" id="attach-trigger" title="添加文件或图片" ${state.sessionSwitching ? 'disabled' : ''}>＋</button><input id="file-input" type="file" multiple hidden><input id="image-input" type="file" accept="image/*" multiple hidden><div class="attachment-menu hidden" id="attachment-menu"><button id="attach-files"><span>▧</span><span><strong>文件</strong><small>添加代码和文档</small></span></div><div class="image-reference-menu ${state.imageMenuOpen ? '' : 'hidden'}" id="image-reference-menu">${imageReferenceMarkup()}</div>${skillMenuMarkup()}<textarea id="prompt" ${state.sessionSwitching ? 'disabled' : ''} placeholder="给 AnYuAgent 一条指令…（输入 @ 调用技能或引用图片，Enter 发送，Shift+Enter 换行）">${esc(state.composerText)}</textarea><select id="thinking-level" class="thinking-picker" title="${esc(`推理强度：${thinkingLevelLabel(state.thinkingLevel)}`)}" ${state.sessionSwitching ? 'disabled' : ''}>${state.thinkingLevels.map((level) => `<option value="${esc(level)}" ${level === state.thinkingLevel ? 'selected' : ''}>${esc(thinkingLevelLabel(level))}</option>`).join('')}</select><button class="send ${state.loading ? 'stop' : ''}" id="send" ${state.sessionSwitching ? 'disabled' : ''} title="${state.loading ? '停止当前任务' : '发送'}" aria-label="${state.loading ? '停止当前任务' : '发送'}">${state.loading ? '■' : '↑'}</button></div><div class="composer-meta"><span>Pi 可读取、编辑并执行工作目录中的文件</span><span id="busy">${state.retryNotice || (state.loading ? 'Agent 正在工作…' : state.queuedTasks.length ? `${state.queuedTasks.length} 项排队中` : '')}</span></div></div></section></div></main>${state.settingsOpen ? settingsMarkup() : ''}${permissionHtml()}${imagePreviewMarkup()}${sessionContextMenuMarkup()}</div>`
    bindAppEvents(); settleMessagesAtBottom()
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
    document.querySelector('#key-picker')?.addEventListener('click', () => { if (state.switching) return; state.keyMenuOpen = !state.keyMenuOpen; renderApp() })
     document.querySelectorAll('[data-key]').forEach((node) => node.addEventListener('click', async () => {
       if (state.switching) return
       const keyId = Number(node.dataset.key)
       if (!Number.isFinite(keyId) || !state.keys.some((key) => Number(key.id) === keyId)) { state.error = '该密钥编号无效，请刷新密钥列表'; state.keyMenuOpen = false; renderApp(); return }
       state.switching = true
       state.selectedKey = keyId; localStorage.setItem('anyu.selectedKey', String(state.selectedKey)); state.keyMenuOpen = false; state.error = ''; state.catalog = []; state.model = ''
       renderApp()
       try { state.catalog = await loadCatalogForKey(state.selectedKey); ensureSkillSelection(); chooseModel(); await startAgent(state.sessionPath) } catch (error) { state.catalog = []; state.model = ''; state.error = error.message || '切换密钥失败' }
      state.switching = false
      renderApp()
    }))
    document.querySelectorAll('.session').forEach((node) => node.addEventListener('click', () => switchSession(node.dataset.path)))
    document.querySelector('#model')?.addEventListener('change', async (event) => { if (state.switching) return; state.switching = true; state.model = event.target.value; localStorage.setItem('anyu.selectedModel', state.model); try { await window.anyu.piCommand({ type: 'set_model', provider: currentModel()?.provider || providerForApi('openai-completions'), modelId: state.model }); await syncThinkingLevels() } catch (error) { state.error = error.message || '切换模型失败' }; state.switching = false; renderApp() })
    document.querySelector('#thinking-level')?.addEventListener('change', async (event) => {
      const level = String(event.target.value || 'off')
      if (!state.thinkingLevels.includes(level)) return
      state.thinkingLevel = level; localStorage.setItem(thinkingStorageKey(), level)
      try { await window.anyu.piCommand({ type: 'set_thinking_level', level }) } catch (error) { state.error = error.message || '推理强度切换失败' }
      renderApp()
    })
    document.querySelector('#permission-quick')?.addEventListener('click', () => { state.settingsOpen = true; renderApp() })
     const switchAccount = async () => { state.error = ''; state.sessionSwitchToken++; state.sessionSwitching = false; stopBalanceRefresh(); try { await window.anyu.piStop() } catch {}; try { await window.anyu.logout() } catch {}; state.user = null; state.keys = []; state.catalog = []; state.skillGroups = []; state.mediaMessages = {}; state.mediaActivity = {}; state.mediaBusyCount = 0; state.sessions = []; state.sessionPath = null; state.sessionCwd = null; state.messages = []; state.imageLibrary = []; state.attachments = []; state.composerText = ''; state.piState = null; state.loading = false; state.permission = null; state.settingsOpen = false; state.keyMenuOpen = false; state.imageMenuOpen = false; state.skillMenuOpen = false; state.twoFactor = null; state.streamingMessage = null; state.queuedTasks = []; state.queueMenuId = null; state.queueDraining = false; state.authChecking = false; render() }
    document.querySelector('#settings-logout')?.addEventListener('click', switchAccount)
    document.querySelector('#settings-open')?.addEventListener('click', () => { state.settingsOpen = true; renderApp() })
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
    document.querySelector('#settings-close')?.addEventListener('click', () => { state.settingsOpen = false; renderApp() })
    document.querySelector('#settings-done')?.addEventListener('click', () => { state.settingsOpen = false; renderApp() })
    document.querySelector('#skills-refresh')?.addEventListener('click', async () => { state.skillsLoading = true; renderApp(); await loadSkillGroups(); state.skillsLoading = false; renderApp() })
    document.querySelectorAll('[data-skill-toggle]').forEach((node) => node.addEventListener('click', () => { const kind = node.dataset.skillToggle; if (kind === 'image' || kind === 'video') state.skillEnabled[kind] = !state.skillEnabled[kind]; renderApp() }))
    document.querySelector('#skill-image-group')?.addEventListener('change', (event) => { state.skillConfigs.image.groupId = Number(event.target.value); ensureSkillSelection(); renderApp() })
    document.querySelector('#skill-image-model')?.addEventListener('change', (event) => { state.skillConfigs.image.model = event.target.value; renderApp() })
    document.querySelector('#skill-video-group')?.addEventListener('change', (event) => { state.skillConfigs.video.groupId = Number(event.target.value); ensureSkillSelection(); renderApp() })
    document.querySelector('#skill-video-model')?.addEventListener('change', (event) => { state.skillConfigs.video.model = event.target.value; renderApp() })
    document.querySelector('#permission-mode')?.addEventListener('change', async (event) => { state.permissionMode = event.target.value; localStorage.setItem('anyu.permissionMode', state.permissionMode); state.settingsOpen = false; try { await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '权限模式切换失败' }; renderApp() })
    document.querySelector('#settings-cwd')?.addEventListener('click', async () => { const directory = await window.anyu.chooseDirectory(); if (!directory) return; state.sessionCwd = null; state.cwd = directory; localStorage.setItem('anyu.cwd', directory); try { if (state.sessionPath && window.anyu.piMaterializeSession) await window.anyu.piMaterializeSession({ sessionPath: state.sessionPath, cwd: directory }); await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '工作目录切换失败' }; renderApp() })
    document.querySelector('#refresh')?.addEventListener('click', async () => { state.error = ''; try { await loadKeys(); await loadSkillGroups(); state.catalog = await loadCatalogForKey(state.selectedKey); chooseModel(); ensureSkillSelection(); await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '刷新失败' }; renderApp() })
    document.querySelector('#choose-cwd')?.addEventListener('click', async () => { const directory = await window.anyu.chooseDirectory(); if (!directory) return; state.sessionCwd = null; state.cwd = directory; localStorage.setItem('anyu.cwd', directory); try { if (state.sessionPath && window.anyu.piMaterializeSession) await window.anyu.piMaterializeSession({ sessionPath: state.sessionPath, cwd: directory }); await startAgent(state.sessionPath) } catch (error) { state.error = error.message || '工作目录切换失败' }; renderApp() })
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
  function stopRunWatchdog() {
    if (state.runWatchdog) window.clearTimeout(state.runWatchdog)
    if (state.runPoll) window.clearInterval(state.runPoll)
    state.runWatchdog = null
    state.runPoll = null
  }
  function clearActiveRequest() {
    stopRunWatchdog()
    state.activeRequest = null; state.retryNotice = ''; state.runStartedAt = 0
  }
  async function reconcileRunState() {
    if (!state.loading) return
    try {
      const result = await window.anyu.piCommand({ type: 'get_state' })
      const piState = result?.data || null
      state.piState = piState || state.piState
      // Pi clears isStreaming only after the whole run has settled, including
      // queued retries and awaited event handlers. It is the authoritative idle
      // signal; pending message counts are not needed to release the composer.
      if (piState?.isStreaming === false) finishAgentRun()
    } catch {
      // The main process reports process exits separately. A transient state read
      // must not interrupt an active local run.
    }
  }
  function startRunWatchdog() {
    stopRunWatchdog()
    const startedAt = state.runStartedAt || Date.now()
    state.runPoll = window.setInterval(() => { void reconcileRunState() }, 1500)
    state.runWatchdog = window.setTimeout(async () => {
      if (!state.loading || state.runStartedAt !== startedAt) return
      state.retryNotice = ''
      state.error = '模型服务响应超时，已停止当前任务。请重试或切换模型。'
      try { await window.anyu.piCommand({ type: 'abort' }) } catch {}
      finishAgentRun()
    }, 90000)
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
    state.activeRequest = { ...payload, taskId: task.id }; state.retryNotice = ''; state.runStartedAt = Date.now()
    message.createdAt = Number(task.createdAt || Date.now())
    state.loading = true; state.error = ''; insertTimelineMessage(message); updateSessionTitle(payload.content, message.createdAt); state.composerText = ''; if (prompt) prompt.value = ''
    renderApp(); updateLiveUi(true); startRunWatchdog()
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
        state.streamingMessage = { role: 'assistant', content: '', createdAt: Number(message.timestamp || Date.now()), isStreaming: true }
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
        else insertTimelineMessage({ role: 'assistant', content, createdAt: Number(event.message.timestamp || Date.now()), isError: hasError })
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
      if (event.method === 'confirm' && state.permissionMode === 'full') { window.anyu.piUiResponse({ id: event.id, confirmed: true }); return }
      if (['confirm', 'select', 'input'].includes(event.method)) { state.permission = event; renderApp() }
      return
    }
    if (event.type === 'agent_start' || event.type === 'turn_start') {
      state.loading = true
      if (!state.runStartedAt) state.runStartedAt = Date.now()
      if (!state.runPoll) startRunWatchdog()
      state.retryNotice = ''
      scheduleLiveUi(true)
      return
    }
    if (event.type === 'agent_end') {
      if (event.willRetry) {
        state.retryNotice = '模型服务暂时不可用，Pi 正在自动重试…'
        state.error = ''
        scheduleLiveUi(true)
      } else {
        state.retryNotice = ''
        const lastAssistant = [...state.messages].reverse().find((message) => message.role === 'assistant')
        if (lastAssistant?.isError) state.error = lastAssistant.content || '模型回复失败，请稍后重试或切换模型'
        // agent_end is Pi's final event for this run. Do not leave the loading
        // UI waiting for an optional follow-up settlement notification.
        finishAgentRun()
      }
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
  window.anyu.onPiExit(() => { clearActiveRequest(); state.piState = null; state.loading = false; if (state.sessionSwitching) return; state.error = 'Pi Agent 进程已退出，请刷新重试'; if (state.user) renderApp() })
  window.anyu.onPiStderr((message) => { if (/error|failed|exception/i.test(message) && !state.loading) { state.error = message.trim().slice(-500); scheduleAppRender() } })
  render()
  ;(async () => {
    try {
      const current = await window.anyu.authState()
      state.authChecking = false
      if (current.authenticated) { state.user = current.user; await bootstrap() }
    } catch (error) { state.authChecking = false; state.error = error.message || '' }
    render()
  })()
})()
