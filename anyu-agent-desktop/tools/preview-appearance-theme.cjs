// 外观主题视觉验证：在离屏窗口里用真实的 styles.css 与真实的 appearanceMarkup()
// 渲染设置页外观分区，逐套主题截图到 tools/.preview/。
//
// 用法：node_modules/.bin/electron tools/preview-appearance-theme.cjs
// 只是开发期自查工具，不参与打包与运行时。
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { app, BrowserWindow } = require('electron')

const rendererDir = path.join(__dirname, '..', 'renderer')
const outputDir = path.join(__dirname, '.preview')
const styleSource = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8')
const appSource = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8')

// 直接取 app.js 中的真实函数，保证截图里的卡片结构与线上一致。
const registryStart = appSource.indexOf('  const APPEARANCE_THEMES = [')
const registryEnd = appSource.indexOf('  const state = {', registryStart)
const markupStart = appSource.indexOf('  function appearanceMarkup()')
const markupEnd = appSource.indexOf('  function settingsMarkup()', markupStart)
if (registryStart < 0 || registryEnd < 0 || markupStart < 0 || markupEnd < 0) throw new Error('无法定位外观主题定义')

const sandbox = { document: { documentElement: { dataset: {} } }, localStorage: { getItem: () => null, setItem: () => {} }, console }
vm.runInNewContext(
  `${appSource.slice(registryStart, registryEnd)}\n${appSource.slice(markupStart, markupEnd)}\nconst esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))\nconst state = { appearanceTheme: 'cloud' }\nthis.renderAppearance = (activeId) => { state.appearanceTheme = activeId; return appearanceMarkup() }\nthis.THEME_IDS = APPEARANCE_THEMES.map((theme) => theme.id)\n`,
  sandbox
)

const themeIds = sandbox.THEME_IDS

function buildDocument(themeId) {
  // 预览时把当前主题当作已应用主题，便于同时检查选中态描边与角标配色。
  const gridMarkup = sandbox.renderAppearance(themeId)
  return `<!doctype html><html lang="zh-CN" data-anyu-theme="${themeId}"><head><meta charset="utf-8"><style>${styleSource}</style></head>
<body><div class="settings-page-layout">
  <aside class="settings-sidebar">
    <button type="button" class="settings-back"><span aria-hidden="true">←</span><span>返回应用</span></button>
    <nav class="settings-nav" aria-label="设置分类">
      <button type="button" class="settings-nav-item"><span>⚙</span><span>常规</span></button>
      <button type="button" class="settings-nav-item active" aria-current="page"><span>◐</span><span>外观</span></button>
      <button type="button" class="settings-nav-item"><span>✦</span><span>核心技能</span></button>
      <button type="button" class="settings-nav-item"><span>◈</span><span>插件市场</span></button>
    </nav>
  </aside>
  <main class="settings-page-main">
    <header class="settings-page-header"><div><div class="modal-kicker">LetaAgent</div><h1>外观</h1></div>
      <div class="settings-window-controls" aria-label="窗口控制"><button type="button">−</button><button type="button">□</button><button type="button">×</button></div>
    </header>
    <div class="settings-page-content">${gridMarkup}</div>
  </main>
</div></body></html>`
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: false, contextIsolation: true, sandbox: true }
  })
  for (const themeId of themeIds) {
    const html = buildDocument(themeId)
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // 等一帧，确保 data 属性切换后的令牌已经参与布局计算。
    await new Promise((resolve) => setTimeout(resolve, 220))
    const metrics = await win.webContents.executeJavaScript(`(() => {
      const root = getComputedStyle(document.documentElement)
      const main = getComputedStyle(document.querySelector('.settings-page-main'))
      const sidebar = getComputedStyle(document.querySelector('.settings-sidebar'))
      const card = document.querySelector('.appearance-card.active .appearance-thumb')
      return {
        canvas: main.backgroundColor,
        chrome: sidebar.backgroundColor,
        accent: root.getPropertyValue('--anyu-accent').trim(),
        cards: document.querySelectorAll('.appearance-card').length,
        activeThumbBorder: card ? getComputedStyle(card).borderTopColor : null
      }
    })()`)
    const image = await win.webContents.capturePage()
    const file = path.join(outputDir, `${themeId}.png`)
    fs.writeFileSync(file, image.toPNG())
    console.log(`${themeId.padEnd(9)} canvas=${metrics.canvas} chrome=${metrics.chrome} accent=${metrics.accent} cards=${metrics.cards} thumb=${metrics.activeThumbBorder}`)
  }
  win.destroy()
  console.log(`screenshots: ${outputDir}`)
  app.quit()
}

app.whenReady().then(main).catch((error) => {
  console.error(error)
  app.exit(1)
})
