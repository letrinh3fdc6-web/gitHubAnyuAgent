const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '..')
process.env.ANYU_USER_DATA_DIR = path.join(os.tmpdir(), `anyu-browser-fit-${process.pid}`)
process.env.ANYU_RUNTIME_MODE = 'local'
const timeout = setTimeout(() => { console.error('browser fit timed out'); app.exit(1) }, 60000)
require('../main.cjs')

async function until(read, accept, label) {
  const deadline = Date.now() + 10000
  let last
  while (Date.now() < deadline) {
    const result = await read()
    last = result
    if (accept(result)) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}: ${JSON.stringify(last)}`)
}

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Browser fit test</title><style>body{margin:0;background:#fff}.sheet{width:1400px;height:2400px;position:relative;background:#edf8f3}h1{margin:0;padding:30px;color:#075c42}.edge{position:absolute;right:0;bottom:0;width:180px;height:100px;background:#d84867;color:white}</style><div class="sheet"><h1>Browser preview</h1><div class="edge">Right and bottom edge</div></div>')
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const win = await until(async () => BrowserWindow.getAllWindows()[0], value => value && !value.webContents.isLoading(), 'main window')
    const invoke = code => win.webContents.executeJavaScript(code)
    await invoke(`window.anyu.browserOpenUrl('http://127.0.0.1:${server.address().port}/')`)
    await invoke('window.anyu.browserSetBounds({x:20,y:100,width:420,height:500})')
    const view = win.contentView.children.find(child => child.webContents && child.webContents !== win.webContents)
    const executeIsolated = view.webContents.executeJavaScriptInIsolatedWorld.bind(view.webContents)
    view.webContents.executeJavaScriptInIsolatedWorld = async (...args) => {
      try { return await executeIsolated(...args) }
      catch (error) { console.error('isolated layout read:', error); throw error }
    }
    const metrics = async () => ({ ...await view.webContents.executeJavaScript('({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight, zoom: devicePixelRatio })'), factor: view.webContents.getZoomFactor(), bounds: view.getBounds(), state: await invoke('window.anyu.browserState()') })
    const widthFit = await until(metrics, m => m.width <= m.viewportWidth + 1 && m.width >= 1400, 'fit width')
    assert(widthFit.height > widthFit.viewportHeight, 'long pages should keep vertical scrolling in fit-width mode')
    const zoomBefore = (await invoke('window.anyu.browserState()')).zoomFactor
    await new Promise(resolve => setTimeout(resolve, 2300))
    assert.equal((await invoke('window.anyu.browserState()')).zoomFactor, zoomBefore, 'automatic fit must stabilize instead of shrinking on every poll')
    await invoke("window.anyu.browserSetZoomMode('fit-page')")
    const pageFit = await until(metrics, m => m.height <= m.viewportHeight + 2 && m.width <= m.viewportWidth + 1, 'fit full page')
    const edge = await view.webContents.executeJavaScript('(() => { const r = document.querySelector(".edge").getBoundingClientRect(); return { right:r.right,bottom:r.bottom } })()')
    assert(edge.bottom <= pageFit.viewportHeight + 2 && edge.right <= pageFit.viewportWidth + 1)
    const screenshot = await view.webContents.capturePage()
    assert(screenshot.getSize().width >= 400)
    assert(new Set(screenshot.toBitmap()).size > 10, 'preview pixels must be nonblank')
    const output = path.resolve(root, '../../../.local/browser-preview-qa')
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, 'native-fit-page.png'), screenshot.toPNG())
    await invoke("window.anyu.browserSetZoomMode('fit-width')")
    await invoke('window.anyu.browserSetBounds({x:20,y:100,width:800,height:500})')
    await until(() => invoke('window.anyu.browserState().then(s=>s.zoomFactor)'), factor => factor > zoomBefore + 0.15, 'fit after widening')
    await invoke('window.anyu.browserSetZoomFactor(0.75)')
    await invoke('window.anyu.browserSetBounds({x:20,y:100,width:350,height:500})')
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.equal(view.webContents.getZoomFactor(), 0.75, 'manual zoom must survive resizing')
    await invoke("window.anyu.browserSetZoomMode('fit-width')")
    await until(metrics, m => m.width <= m.viewportWidth + 1, 'fit narrow sidebar')
    await view.webContents.executeJavaScript('document.querySelector(".sheet").style.width="2000px"')
    await until(metrics, m => m.width >= 2000 && m.width <= m.viewportWidth + 1, 'fit delayed content')
    await invoke('window.anyu.browserSetBounds(null)')
    assert.equal(view.getVisible(), false)
    await invoke('window.anyu.browserSetBounds({x:20,y:100,width:350,height:500})')
    await until(metrics, m => m.width <= m.viewportWidth + 1, 'restore hidden preview')
    await view.webContents.executeJavaScript('document.querySelector(".sheet").style.height="20000px"')
    await invoke("window.anyu.browserSetZoomMode('fit-page')")
    const bounded = await until(metrics, m => m.height >= 20000 && m.state.zoomMode === 'fit-page', 'huge page bounded fit')
    assert(bounded.viewportWidth <= 4096 && bounded.viewportHeight <= 4096, JSON.stringify(bounded))
    assert(bounded.viewportWidth * bounded.viewportHeight <= 8 * 1024 * 1024, 'virtual surface exceeds budget')
    assert(bounded.height > bounded.viewportHeight, 'huge content remains scrollable')
    await invoke('window.anyu.browserSetZoomFactor(0.05)')
    const manualBounded = await metrics()
    assert(manualBounded.viewportWidth <= 4096 && manualBounded.viewportHeight <= 4096)
    view.webContents.forcefullyCrashRenderer()
    await until(() => invoke('window.anyu.browserState()'), state => state.error.includes('页面进程已退出'), 'crash state')
    await invoke('window.anyu.browserReload()')
    await until(() => invoke('window.anyu.browserState()'), state => !state.loading && !state.error, 'reload after crash')
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("h1")?.textContent'), 'Browser preview')
    assert(new Set((await view.webContents.capturePage()).toBitmap()).size > 10, 'recovered preview must render')
    await invoke('window.anyu.browserClose()')
    console.log('live browser fit: width, full page, stable zoom, resize, manual override, delayed content, overlay hiding, bounded huge pages, crash recovery and pixels passed')
    clearTimeout(timeout)
    server.close()
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    server.close()
    app.exit(1)
  }
})
