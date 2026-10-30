const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron } = require(process.env.ANYU_PLAYWRIGHT_MODULE || 'C:/Users/Administrator/AppData/Local/Temp/tokenrouter-source-recovery-browser-20261018/node_modules/playwright')

async function main() {
  const root = process.env.ANYU_SMOKE_ROOT || 'E:/TokenRouter-builds/agent-1.0.77'
  const output = process.env.ANYU_SMOKE_OUTPUT || root
  const report = { version: '1.0.77', errors: [], graphicsWarnings: [], checks: [] }
  const env = { ...process.env, ANYU_USER_DATA_DIR: path.join(root, 'smoke-profile'), ANYU_DISABLE_GPU: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () => _electron.launch({ executablePath: process.env.ANYU_SMOKE_EXECUTABLE || path.join(root, 'artifacts/win-unpacked/AnyuAgent.exe'), args: process.platform === 'win32' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [], env, timeout: 60000 })
  let electron = await launch()
  try {
    let page = await electron.firstWindow()
    page.on('pageerror', error => {
      if (process.platform === 'darwin' && process.env.CI && error.message === 'Error creating WebGL context.') report.graphicsWarnings.push('Hosted macOS runner cannot render the decorative WebGL scene.')
      else report.errors.push(error.message)
    })
    await page.waitForURL(url => url.protocol === 'anyu-app:' && (url.pathname.includes('/login') || url.hash.includes('/login')), { timeout: 60000 })
    await page.locator('input[type="password"]').waitFor({ timeout: 60000 })
    const info = await page.evaluate(async () => ({ build: await window.anyu.appBuildInfo(), api: await window.anyu.apiBase(), settings: await window.anyu.publicSettings(), health: await (await fetch('/api/v1/anyu-agent/health')).json(), manifest: await (await fetch('/api/v1/anyu-agent/manifest')).json(), update: await window.anyu.checkForUpdate() }))
    assert.equal(await electron.evaluate(({ app }) => app.getVersion()), report.version)
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true)
    assert.equal(info.api, 'https://x.ailzd.com')
    assert.equal(info.health.product, 'AnyuAgent')
    assert.equal(info.manifest.code, 0)
    assert.equal(info.update.available, false)
    const assets = await page.evaluate(() => [...document.scripts].filter(s => s.src).map(s => s.src))
    const renderer = JSON.parse(fs.readFileSync(process.env.ANYU_RENDERER_MANIFEST || path.join(__dirname, 'renderer-build.json')))
    assert.ok(assets.some(url => url.endsWith(renderer.entry)))
    const workspaceSha256 = await page.evaluate(async filename => {
      const response = await fetch('/assets/' + filename)
      if (!response.ok) throw new Error('Workspace asset is unavailable')
      const buffer = await response.arrayBuffer()
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(n => n.toString(16).padStart(2, '0')).join('')
    }, renderer.workspace)
    assert.equal(workspaceSha256, renderer.workspaceSha256)
    report.renderer = renderer
    report.updateVersion = info.update.latestVersion
    report.checks.push('packaged Vue login and preload', 'production API health/settings/manifest', 'frozen renderer entry and workspace SHA256')
    await page.locator('#anyu-startup').waitFor({ state: 'detached', timeout: 30000 })
    await page.screenshot({ path: path.join(output, `${process.platform}-${process.arch}-login.png`) })
    const permission = await page.evaluate(() => window.anyu.setAgentPermissionMode('full'))
    assert.equal(permission.ok, true)
    assert.equal(permission.ready, true)
    assert.notEqual(permission.systemAccess.executionHost, 'worker')
    const windowId = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
    await page.evaluate(() => window.anyu.windowAction('close'))
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
    await electron.evaluate(({ app }) => app.emit('second-instance'))
    assert.deepEqual(await electron.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; return { id: win.id, visible: win.isVisible(), count: BrowserWindow.getAllWindows().length } }), { id: windowId, visible: true, count: 1 })
    await electron.evaluate(({ BrowserWindow, app }) => { BrowserWindow.getAllWindows()[0].close(); app.emit('activate') })
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
    report.checks.push('close-to-tray and restore same window', 'native close and activate', 'full access without administrator worker')
    await electron.close()
    electron = await launch()
    page = await electron.firstWindow()
    await page.waitForFunction(() => Boolean(window.anyu?.agentPermissionState))
    const restored = await page.evaluate(() => window.anyu.agentPermissionState())
    assert.equal(restored.mode, 'full')
    assert.equal(restored.ready, true)
    report.checks.push('full access survives process restart')
    assert.deepEqual(report.errors, [])
    report.passed = true
    fs.writeFileSync(path.join(output, `${process.platform}-${process.arch}-smoke.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally { await electron.close().catch(() => {}) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
