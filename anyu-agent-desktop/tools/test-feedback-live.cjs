const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, session } = require('electron')
const { LocalFeedback, feedbackUrl, loginGate } = require('../local-feedback.cjs')
const { electronPage } = require('../electron-page.cjs')
const { PluginManager } = require('../plugin-manager.cjs')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leta-feedback-live-'))
app.setPath('userData', directory)
let runtime
const timer = setTimeout(() => { runtime?.cancel(); console.error('feedback live timed out'); app.exit(1) }, 60000)
app.whenReady().then(async () => {
  let win
  try {
    const manager = new PluginManager(directory)
    const root = path.resolve(__dirname, '..')
    await manager.install(path.join(root, 'dist/skills/tmall-public-feedback-analysis-1.3.0.anyu-plugin.zip'))
    const browserSession = session.fromPartition('feedback-fixture')
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/browser-feedback.html'))
    let needLogin = true
    browserSession.protocol.handle('https', () => new Response(needLogin ? '<html><body><input type="password"><p>登录</p></body></html>' : html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    win = new BrowserWindow({ show: false, webPreferences: { session: browserSession, contextIsolation: true, sandbox: true } })
    const url = 'https://detail.tmall.com/item.htm?id=fixture'
    const report = fs.readFileSync(path.join(__dirname, 'fixtures/feedback-report.html'), 'utf8')
    let analysisCalls = 0
    runtime = new LocalFeedback({ directory: path.join(directory, 'tasks'), plugin: () => { const record = manager.get('tmall-public-feedback-analysis'); if (!record?.enabled) throw new Error('未安装'); return record }, openBrowser: async () => win.webContents, analyze: async (_, __, onProgress) => {
      analysisCalls++
      if (analysisCalls === 1) { onProgress('公开评价'); onProgress('公开评价显示包装完整，质量不错。'); return '公开评价显示包装完整，质量不错。' }
      return report
    } })
    const submitted = runtime.start({ url })
    assert.equal(submitted.local, true)
    assert.throws(() => runtime.start({ url }), /已有评价采集/)
    let waiting
    for (let i = 0; i < 30; i++) {
      waiting = await runtime.get(submitted.taskId)
      if (waiting.status === 'WAITING_LOGIN') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(waiting.status, 'WAITING_LOGIN')
    assert.equal(await loginGate(electronPage(win.webContents, feedbackUrl)), 'WAITING_LOGIN')
    needLogin = false
    await win.webContents.loadURL(url)
    let result
    for (let i = 0; i < 200; i++) {
      result = await runtime.get(submitted.taskId)
      if (['OK', 'FAILED', 'CANCELLED'].includes(result.status)) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(result.status, 'OK', result.result.message)
    assert.equal(result.result.reviews.length, 1)
    assert.equal(result.result.reviews[0].content, '包装完整，质量不错')
    assert.equal(result.result.questions[0].answer, '可以手洗')
    assert.equal(result.result.coverage.reviews.platformFolded, 2)
    assert.equal(result.result.coverage.reviews.platformLabel, '2000+')
    const progress = []
    const analyzed = await runtime.analysis(submitted.taskId, '', (event) => progress.push(event))
    assert.match(analyzed.analysisHtml, /包装/)
    assert.equal(analyzed.analysisSummary, '公开评价显示包装完整，质量不错。')
    assert(progress.some((event) => event.stage === 'analysis' && event.text.includes('包装完整')))
    assert(progress.some((event) => event.stage === 'report' && event.text.includes('包装完整')))
    assert.equal(analysisCalls, 2)
    const restored = new LocalFeedback({ directory: path.join(directory, 'tasks'), plugin: () => manager.get('tmall-public-feedback-analysis') })
    assert.equal((await restored.get(submitted.taskId)).result.analysisHtml, analyzed.analysisHtml)
    await win.webContents.executeJavaScript('document.body.innerHTML = "<p>请完成验证</p>"')
    assert.equal(await loginGate(electronPage(win.webContents, feedbackUrl)), 'CHALLENGE_REQUIRED')
    assert(!feedbackUrl('https://user:pass@detail.tmall.com/'))
    assert(!feedbackUrl('https://tmall.com.example.com/'))
    console.log('local downloadable feedback: ZIP install, login resume, real browser DOM, worker, coverage, analysis and restore passed')
    clearTimeout(timer); win.destroy(); app.exit(0)
  } catch (error) {
    console.error(error); runtime?.cancel(); clearTimeout(timer); win?.destroy(); app.exit(1)
  }
})
