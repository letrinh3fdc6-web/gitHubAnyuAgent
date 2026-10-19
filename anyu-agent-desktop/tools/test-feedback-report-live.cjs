const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { reportHtml } = require('../feedback-report.cjs')

const root = path.resolve(__dirname, '..')
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'feedback-report.html'), 'utf8')
const style = fs.readFileSync(path.join(root, 'skills', 'tmall-public-feedback-analysis', 'styles', 'report.css'), 'utf8')
const html = reportHtml({ itemId: '42', product: { title: '孕妇压力袜 · 公开评价洞察' }, reviews: [{ content: '包装完整，质量不错' }], questions: [], coverage: { reviews: { platformLabel: '36', platformFolded: 21 }, questions: { platformTotal: 0 } } }, fixture, style)
const output = path.join(os.tmpdir(), 'leta-feedback-report-preview')
const timeout = setTimeout(() => { console.error('report preview timed out'); app.exit(1) }, 20000)
// 测完桌面窗口后仍需继续创建窄屏窗口，不能触发 Electron 默认退出。
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  try {
    await fs.promises.mkdir(output, { recursive: true })
    const previewFile = path.join(output, 'report.html')
    await fs.promises.writeFile(previewFile, html)
    for (const [name, width, height] of [['desktop', 1200, 900], ['mobile', 390, 844]]) {
      const win = new BrowserWindow({ show: false, width, height, webPreferences: { sandbox: true, nodeIntegration: false, offscreen: true } })
      await win.loadFile(previewFile)
      const geometry = await win.webContents.executeJavaScript('({ width: document.documentElement.scrollWidth, viewport: innerWidth, sections: document.querySelectorAll("main > section").length, metrics: document.querySelectorAll(".report-metric").length })')
      assert(geometry.width <= geometry.viewport + 1, `${name} horizontal overflow: ${JSON.stringify(geometry)}`)
      assert.equal(geometry.sections, 12)
      assert.equal(geometry.metrics, 5)
      await new Promise((resolve) => setTimeout(resolve, 250))
      await fs.promises.writeFile(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG())
      win.destroy()
    }
    console.log(`Chromium report preview passed: ${output}`)
    clearTimeout(timeout); app.exit(0)
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1) }
})
