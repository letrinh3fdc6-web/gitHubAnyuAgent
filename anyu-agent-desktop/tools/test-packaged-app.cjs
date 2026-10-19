const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron } = require(process.env.ANYU_PLAYWRIGHT_MODULE || 'C:/Users/Administrator/AppData/Local/Temp/tokenrouter-source-recovery-browser-20261018/node_modules/playwright')

async function main() {
  const root = process.env.ANYU_SMOKE_ROOT || 'E:/TokenRouter-builds/anyuagent-1.0.60-20261019'
  const output = process.env.ANYU_SMOKE_OUTPUT || __dirname
  const report = { version: '1.0.60', errors: [], graphicsWarnings: [], checks: [] }
  const env = { ...process.env, ANYU_USER_DATA_DIR: path.join(root, 'smoke-profile'), ANYU_DISABLE_GPU: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = await _electron.launch({
    executablePath: process.env.ANYU_SMOKE_EXECUTABLE || path.join(root, 'artifacts/win-unpacked/AnyuAgent.exe'),
    args: process.platform === 'win32' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
    env,
    timeout: 60000,
  })
  try {
    const page = await electron.firstWindow()
    page.on('pageerror', error => {
      if (process.platform === 'darwin' && process.env.CI && error.message === 'Error creating WebGL context.') {
        report.graphicsWarnings.push('The hosted macOS runner cannot render the decorative WebGL scene.')
      } else report.errors.push(error.message)
    })
    await page.waitForURL('anyu-app://desktop/login**', { timeout: 60000 })
    await page.locator('input[type="password"]').waitFor({ timeout: 60000 })
    const info = await page.evaluate(async () => ({
      build: await window.anyu.appBuildInfo(),
      api: await window.anyu.apiBase(),
      settings: await window.anyu.publicSettings(),
      health: await (await fetch('/api/v1/anyu-agent/health')).json(),
      manifest: await (await fetch('/api/v1/anyu-agent/manifest')).json(),
      version: await window.anyu.checkForUpdate(),
    }))
    assert.equal(await electron.evaluate(({ app }) => app.getVersion()), '1.0.60')
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true)
    assert.ok(JSON.stringify(info.api).includes('https://x.ailzd.com'))
    assert.equal(info.health.product, 'AnyuAgent')
    assert.equal(info.manifest.code, 0)
    assert.equal(info.version.available, false)
    report.checks.push('packaged Vue login', 'desktop preload bridge', 'production API origin', 'public settings IPC', 'AnyuAgent health and manifest', 'update manifest IPC')
    const assets = await page.evaluate(() => [...document.scripts].filter(s => s.src).map(s => s.src))
    assert.ok(assets.some(url => url.includes('/assets/index-Dq2K_Dz-.js')))
    report.checks.push('current production renderer entry')
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
