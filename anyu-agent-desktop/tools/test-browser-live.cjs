const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

// 在独立 Electron 实例中验证实际 IPC、受控协议与浏览器视图。
const root = path.resolve(__dirname, '..')
process.env.ANYU_USER_DATA_DIR = path.join(os.tmpdir(), `leta-browser-smoke-${process.pid}`)
process.env.ANYU_RUNTIME_MODE = 'local'
const timeout = setTimeout(() => { console.error('browser smoke timed out'); app.exit(1) }, 20000)
require('../main.cjs')

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Local page</title><h1 id="local">Local page</h1>') })
  try {
    const win = await new Promise((resolve) => {
      const wait = () => {
        const found = BrowserWindow.getAllWindows()[0]
        if (found && !found.webContents.isLoading()) resolve(found)
        else setTimeout(wait, 50)
      }
      wait()
    })
    const opened = await win.webContents.executeJavaScript(`window.anyu.browserOpenArtifact(${JSON.stringify({ cwd: root, path: 'tools/fixtures/browser-preview.html' })})`)
    assert.equal(opened.open, true)
    const view = win.contentView.children.find((child) => child.webContents && child.webContents !== win.webContents)
    assert(view, '右侧原生浏览器没有创建')
    await new Promise((resolve) => view.webContents.once('did-finish-load', resolve))
    const preview = await view.webContents.executeJavaScript('({ text: document.querySelector("#preview")?.textContent, loaded: document.querySelector("#preview")?.dataset.loaded, color: getComputedStyle(document.querySelector("#preview")).color })')
    assert.deepEqual(preview, { text: '预览内容', loaded: 'yes', color: 'rgb(12, 120, 75)' })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    await win.webContents.executeJavaScript(`window.anyu.browserOpenUrl(${JSON.stringify(url)})`)
    await new Promise((resolve) => view.webContents.once('did-finish-load', resolve))
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("#local")?.textContent'), 'Local page')
    assert.equal(await win.webContents.executeJavaScript('window.anyu.browserState().then(s => s.url)'), url)
    await win.webContents.executeJavaScript('window.anyu.browserBack()')
    await new Promise((resolve) => view.webContents.once('did-finish-load', resolve))
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("#preview")?.textContent'), '预览内容')
    assert.match(await win.webContents.executeJavaScript('window.anyu.browserState().then(s => s.url)'), /^artifact:\/\//)
    await win.webContents.executeJavaScript('window.anyu.browserForward()')
    await new Promise((resolve) => view.webContents.once('did-finish-load', resolve))
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("#local")?.textContent'), 'Local page')
    console.log('live Electron browser: workspace resources and HTTP page passed')
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
