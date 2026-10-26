const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron } = require(process.env.ANYU_PLAYWRIGHT_MODULE || 'C:/Users/Administrator/AppData/Local/Temp/tokenrouter-source-recovery-browser-20261018/node_modules/playwright')

async function main() {
  const root = process.env.ANYU_SMOKE_ROOT || 'E:/TokenRouter-builds/full-1.0.70'
  const output = process.env.ANYU_SMOKE_OUTPUT || root
  const report = { version: '1.0.70', errors: [], graphicsWarnings: [], checks: [] }
  const env = { ...process.env, ANYU_USER_DATA_DIR: path.join(root, 'smoke-profile'), ANYU_DISABLE_GPU: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = await _electron.launch({
    executablePath: process.env.ANYU_SMOKE_EXECUTABLE || path.join(root, 'artifacts/win-unpacked/AnyuAgent.exe'),
    args: process.platform === 'win32' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
    env, timeout: 60000,
  })
  try {
    const page = await electron.firstWindow()
    page.on('pageerror', error => {
      if (process.platform === 'darwin' && process.env.CI && error.message === 'Error creating WebGL context.') report.graphicsWarnings.push('Hosted macOS runner cannot render the decorative WebGL scene.')
      else report.errors.push(error.message)
    })
    await page.waitForURL('anyu-app://desktop/login**', { timeout: 60000 })
    await page.locator('input[type="password"]').waitFor({ timeout: 60000 })
    const info = await page.evaluate(async () => ({
      build: await window.anyu.appBuildInfo(),
      api: await window.anyu.apiBase(),
      settings: await window.anyu.publicSettings(),
      health: await (await fetch('/api/v1/anyu-agent/health')).json(),
      manifest: await (await fetch('/api/v1/anyu-agent/manifest')).json(),
      update: await window.anyu.checkForUpdate(),
    }))
    assert.equal(await electron.evaluate(({ app }) => app.getVersion()), '1.0.70')
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true)
    assert.ok(JSON.stringify(info.api).includes('https://x.ailzd.com'))
    assert.equal(info.health.product, 'AnyuAgent')
    assert.equal(info.manifest.code, 0)
    assert.equal(info.update.available, false)
    const assets = await page.evaluate(() => [...document.scripts].filter(s => s.src).map(s => s.src))
    const renderer = JSON.parse(fs.readFileSync(path.join(__dirname, 'renderer-build.json')))
    assert.ok(assets.some(url => url.endsWith(renderer.entry)))
    const packagedWorkspace = await page.evaluate(async filename => {
      const response = await fetch('/assets/' + filename)
      if (!response.ok) throw new Error('Workspace asset is unavailable')
      const buffer = await response.arrayBuffer()
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(n => n.toString(16).padStart(2, '0')).join('')
    }, renderer.workspace)
    assert.equal(packagedWorkspace, renderer.workspaceSha256)
    report.checks.push('packaged Vue login', 'desktop preload bridge', 'production API origin', 'public settings IPC', 'AnyuAgent health and manifest', 'update manifest IPC', 'frozen renderer entry and workspace SHA256')
    report.renderer = renderer
    report.updateVersion = info.update.latestVersion
    if (process.env.ANYU_SMOKE_PUBLISHED === '1') {
      assert.equal(info.update.latestVersion, '1.0.70')
      if (process.platform === 'win32') {
        assert.equal(info.update.artifact.name, 'AnyuAgent-Setup-1.0.70.exe')
        assert.equal(info.update.artifact.sha256, process.env.ANYU_SMOKE_WINDOWS_SHA256)
      }
      report.checks.push('published update manifest')
    }
    await page.screenshot({ path: path.join(output, `${process.platform}-${process.arch}-login.png`) })
    assert.deepEqual(report.errors, [])
    report.passed = true
    fs.writeFileSync(path.join(output, `${process.platform}-${process.arch}-smoke.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    await electron.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await electron.close().catch(() => {})
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
