// 输入栏视觉验证：在离屏窗口里用真实的 styles.css 与真实的
// permissionPickerMarkup / thinkingPickerMarkup / composerBarMarkup
// 渲染输入栏底部工具条，逐种状态截图到 tools/.preview/。
//
// 只做结构、配色与溢出/重叠校验，不启动真实应用——开发实例与线上实例
// 共用同一个 %APPDATA% 目录，真启动会打断用户正在用的窗口。
//
// 用法：node_modules/.bin/electron tools/preview-composer.cjs
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { app, BrowserWindow } = require('electron')

const rendererDir = path.join(__dirname, '..', 'renderer')
const outputDir = path.join(__dirname, '.preview')
const styleSource = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8')
const appSource = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8')
const thinkingPresets = require('../thinking-presets.js')

// 从 app.js 切出真实的代码片段，保证截图里的结构与线上完全一致。
function slice(start, end) {
  const from = appSource.indexOf(start)
  const to = appSource.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`无法定位代码片段：${start}`)
  return appSource.slice(from, to)
}

const permissionAndBarSource = slice('  function permissionPickerMarkup()', '  function modelPickerMarkup(')
const modelPickerSource = slice('  function modelPickerMarkup(', '  function groupPickerMarkup(')
const thinkingHelpersSource = slice('  const THINKING_LEVELS = thinkingPresets.LEVELS', '  function modelCapabilities(')
const permissionHelpersSource = slice('  function effectivePermissionMode()', '  async function refreshSystemAccess()')

const sandbox = {
  console,
  document: { documentElement: { dataset: {} } },
  LetaThinkingPresets: thinkingPresets,
  // 下列小工具在 app.js 里各有实现，这里按原样复制，避免为它们拖进大段依赖。
  esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
  cleanDisplayText: (value, maxLength = 80) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
  },
  modelPermissionMode: () => 'full',
  modelProviderLabel: (model) => (model?.api === 'anthropic-messages' ? 'Anthropic' : 'OpenAI 兼容'),
  activeCatalogGroup: () => ({ name: '稳定号池', display_brand: 'Leta 自动分组' }),
  // choosePermissionMode / requestElevation 等只被声明、不会被调用，给空实现即可。
  startAgent: async () => {},
  renderApp: () => {},
  refreshSystemAccess: async () => {},
  window: { anyu: {} },
  localStorage: { getItem: () => null, setItem: () => {} }
}
sandbox.globalThis = sandbox
sandbox.__context = null
// app.js 里 currentModel 是读 state.catalog 的小函数，这里按同样语义提供。
sandbox.currentModel = () => sandbox.state?.catalog?.find((item) => item.id === sandbox.state.model)

vm.runInNewContext(
  `const thinkingPresets = globalThis.LetaThinkingPresets
${permissionHelpersSource}
${thinkingHelpersSource}
${permissionAndBarSource}
${modelPickerSource}
this.__bar = (model) => composerBarMarkup(model, false)
this.__tools = () => '<div class="composer-tools"><div class="auto-route-badge"><span class="picker-icon">⌁</span><span>自动分组</span></div><button class="ghost cwd-button" id="choose-cwd" title="工作目录">⌂ workspace</button></div>'
`,
  sandbox
)
const renderBar = sandbox.__bar
const renderTools = sandbox.__tools

// ── 各场景共用的模型 ────────────────────────────────────────────────────
// 档位与模板名都交给真实的模板库解析，这样截图里显示的就是产品实际会显示的内容。
function model(id, name, api, reasoning) {
  const thinking = thinkingPresets.resolveThinking({ id, name, api, reasoning })
  return {
    id, modelId: id, name, api,
    reasoning: thinking.reasoning,
    thinkingLevels: thinking.levels,
    thinkingDefault: thinking.defaultLevel,
    thinkingTemplate: thinking.templateLabel,
    groupId: 1, groupName: '稳定号池', provider: `anyu-${api}`
  }
}

const DEEPSEEK = model('grp-1024-deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', 'openai-completions', true)
const GPT56 = model('grp-1024-gpt-5.6', 'GPT-5.6', 'openai-responses', true)
const PLAIN = model('grp-1024-anyu-turbo', 'anyu-turbo', 'openai-completions', false)

function baseState(overrides = {}) {
  const base = {
    permissionMode: 'auto', activePermissionMode: null,
    thinkingLevels: DEEPSEEK.thinkingLevels, thinkingLevel: DEEPSEEK.thinkingDefault,
    systemAccess: { platform: 'win32', administrator: false, launchedElevated: false },
    permissionMenuOpen: false, thinkingMenuOpen: false, modelMenuOpen: false,
    sessionSwitching: false, loading: false,
    catalog: [DEEPSEEK, GPT56, PLAIN], model: DEEPSEEK.id
  }
  return Object.assign(base, overrides)
}

const scenarios = [
  { id: 'composer-01-default', note: '默认：自动适配 + 中等强度', state: baseState() },
  { id: 'composer-02-full', note: '完整访问：pill 转为警示色', state: baseState({ permissionMode: 'full' }) },
  { id: 'composer-03-permission-menu', note: '权限菜单展开', state: baseState({ permissionMenuOpen: true }) },
  {
    id: 'composer-04-thinking-menu',
    note: '思考强度菜单展开（GPT-5.6 七档）',
    state: baseState({ model: GPT56.id, thinkingLevels: GPT56.thinkingLevels, thinkingLevel: GPT56.thinkingDefault, thinkingMenuOpen: true })
  },
  {
    id: 'composer-05-thinking-off',
    note: '非推理模型：强度 pill 置灰',
    state: baseState({ model: PLAIN.id, thinkingLevels: PLAIN.thinkingLevels, thinkingLevel: PLAIN.thinkingDefault })
  },
  {
    id: 'composer-06-elevated',
    note: '已具备管理员权限',
    state: baseState({ permissionMenuOpen: true, systemAccess: { platform: 'win32', administrator: true, launchedElevated: true } })
  },
  {
    id: 'composer-07-confirm',
    note: '显式受控访问',
    state: baseState({ permissionMode: 'confirm', activePermissionMode: 'confirm' })
  }
]

function buildDocument(scenario) {
  const state = scenario.state
  const model = state.catalog.find((item) => item.id === state.model)
  // 每次渲染前把新的 state 挂到沙箱上，切出的代码读的是同一个引用。
  sandbox.state = state
  const bar = renderBar(model)
  const tools = renderTools()
  return `<!doctype html><html lang="zh-CN" data-anyu-theme="cloud"><head><meta charset="utf-8"><style>${styleSource}</style>
<style>body { margin: 0; background: #eef0f2; } .app-shell { border-radius: 0; box-shadow: none; }</style></head>
<body><div class="app-shell">
  <aside class="sidebar"></aside>
  <main class="main">
    <div class="conversation"><section class="chat-panel">
      <div class="chat-head"></div>
      <div class="messages"></div>
      <div class="composer">${tools}
        <div class="composer-box">
          <textarea id="prompt" placeholder="给 LetaAgent 一条指令…">帮我重构一下支付模块的幂等校验</textarea>
          ${bar}
        </div>
        <div class="composer-meta"><span>Pi 可读取、编辑并执行工作目录中的文件</span><span id="busy"></span></div>
      </div>
    </section></div>
  </main>
</div></body></html>`
}

async function metrics(win) {
  return win.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector('.composer-bar')
    const box = document.querySelector('.composer-box')
    if (!bar || !box) return { error: 'composer-bar 未渲染' }
    const rect = (node) => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right) } }
    const children = [...bar.children].filter((node) => node.offsetParent !== null || node.classList.contains('composer-bar-gap'))
    // 相邻可见控件是否水平重叠：重叠说明工具条挤爆了。
    let overlaps = 0
    const pills = children.filter((node) => node.classList.contains('bar-picker') || node.classList.contains('attach-button') || node.classList.contains('send') || node.classList.contains('model-picker-wrap'))
    for (let i = 1; i < pills.length; i += 1) {
      if (rect(pills[i]).x < rect(pills[i - 1]).r - 1) overlaps += 1
    }
    const menu = document.querySelector('.bar-menu')
    return {
      boxWidth: rect(box).w,
      barHeight: rect(bar).h,
      children: children.length,
      pills: pills.map((node) => ({ cls: node.className.split(' ').slice(0, 2).join('.'), ...rect(node) })),
      overlaps,
      // 控件是否超出输入框右边界
      overflowRight: Math.max(...pills.map((node) => rect(node).r)) - rect(box).r,
      overflowLeft: rect(box).x - Math.min(...pills.map((node) => rect(node).x)),
      menu: menu ? { w: rect(menu).w, h: rect(menu).h, aboveBar: rect(menu).y < rect(bar).y } : null,
      // 菜单是否顶出窗口
      menuOverflowRight: menu ? rect(menu).r - window.innerWidth : null,
      menuOverflowTop: menu ? rect(menu).y : null,
      permissionPill: (() => { const p = document.querySelector('#permission-picker'); return p ? { text: p.textContent.trim(), warning: p.classList.contains('is-warning'), disabled: p.disabled } : null })(),
      thinkingPill: (() => { const p = document.querySelector('#thinking-picker'); return p ? { text: p.textContent.trim(), muted: p.classList.contains('is-muted'), disabled: p.disabled } : null })()
    }
  })()`)
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const win = new BrowserWindow({
    width: 1080,
    height: 620,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: false, contextIsolation: true, sandbox: true }
  })

  // 先验证真实 index.html 能按 file:// 解析出 ../thinking-presets.js。
  // 这是打包/开发两种布局下都最容易踩的坑，必须在提交前拦住。
  const consoleErrors = []
  // Electron 44 起 console-message 改为事件对象参数，旧的位置参数形式会告警。
  win.webContents.on('console-message', (event) => {
    const level = event?.level ?? 0
    const message = event?.message ?? ''
    if (level >= 2) consoleErrors.push(String(message))
  })
  await win.loadFile(path.join(rendererDir, 'index.html'))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const scriptCheck = await win.webContents.executeJavaScript(`({
    global: typeof globalThis.LetaThinkingPresets,
    templateLabels: typeof globalThis.LetaThinkingPresets === 'object' ? globalThis.LetaThinkingPresets.TEMPLATES.length : 0,
    scripts: [...document.scripts].map((node) => node.getAttribute('src'))
  })`)
  const scriptProblems = []
  if (scriptCheck.global !== 'object') scriptProblems.push(`LetaThinkingPresets 未定义（${scriptCheck.global}）`)
  if (!scriptCheck.templateLabels) scriptProblems.push('模板库为空')
  if (consoleErrors.some((message) => message.includes('思考强度模板库未加载'))) scriptProblems.push('app.js 认为模板库未加载')
  console.log(`index.html 脚本装配  src=${scriptCheck.scripts.join(', ')}  模板数=${scriptCheck.templateLabels}`)
  console.log(`   ${scriptProblems.length ? `问题：${scriptProblems.join('；')}` : '通过'}`)
  let failures = scriptProblems.length ? 1 : 0

  for (const scenario of scenarios) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildDocument(scenario))}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const result = await metrics(win)
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outputDir, `${scenario.id}.png`), image.toPNG())

    const problems = []
    if (result.error) problems.push(result.error)
    if (result.overlaps) problems.push(`控件重叠 ${result.overlaps} 处`)
    if (result.overflowRight > 0) problems.push(`右侧溢出 ${result.overflowRight}px`)
    if (result.overflowLeft > 0) problems.push(`左侧溢出 ${result.overflowLeft}px`)
    if (result.menu && result.menuOverflowRight > 0) problems.push(`菜单右溢出 ${result.menuOverflowRight}px`)
    if (result.menu && result.menuOverflowTop < 0) problems.push(`菜单顶溢出 ${-result.menuOverflowTop}px`)
    if (result.menu && !result.menu.aboveBar) problems.push('菜单未向上展开')
    if (problems.length) failures += 1
    console.log(`${scenario.id.padEnd(28)} ${scenario.note}`)
    console.log(`   bar=${result.barHeight}h/${result.boxWidth}w 权限=${JSON.stringify(result.permissionPill)} 强度=${JSON.stringify(result.thinkingPill)}`)
    console.log(`   pills=${(result.pills || []).map((p) => `${p.cls}(${p.w})`).join(' ')}${result.menu ? ` 菜单=${result.menu.w}x${result.menu.h}` : ''}`)
    console.log(`   ${problems.length ? `问题：${problems.join('；')}` : '通过'}`)
  }
  win.destroy()
  console.log(`\n截图目录：${outputDir}`)
  if (failures) app.exit(1)
  else app.quit()
}

app.whenReady().then(main).catch((error) => {
  console.error(error)
  app.exit(1)
})
