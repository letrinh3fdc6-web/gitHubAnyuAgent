'use strict'
const { app, BrowserWindow: ElectronWindow, ipcMain, screen } = require('electron')
class BrowserWindow extends ElectronWindow {
  show() { if (!process.env.ANYU_PET_QA_HIDDEN) super.show() }
  showInactive() { if (!process.env.ANYU_PET_QA_HIDDEN) super.showInactive() }
}
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { SkillManager } = require('../skill-manager.cjs')
const { createHarness, models } = require('./pet-test-harness.cjs')
const { createPets } = require('../pet-integration.cjs')
const h = createHarness()
h.manager.close()
app.setPath('userData', h.directory)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
let pets, server
app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AnyuAgent Desktop Companions QA</title></head><body style="margin:0"><div id="app"></div></body></html>')
      return
    }
    const upstream = http.request({ host: '127.0.0.1', port: 15176, path: request.url, method: request.method }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
    upstream.on('error', error => { response.writeHead(502); response.end(error.message) })
    request.pipe(upstream)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const main = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.cjs'), sandbox: true, contextIsolation: true } })
  const skills = new SkillManager(h.directory)
  for (const [id, name, description] of [['qa-files', '文件整理', '读取参考文件并整理结果'], ['qa-design', '创作设计', '生成图文方案']]) {
    const directory = path.join(skills.root, id); fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nRead the selected files.`)
  }
  const referenceFolder = path.join(h.directory, '参考资料'), referenceFile = path.join(referenceFolder, '项目说明.txt')
  fs.mkdirSync(referenceFolder); fs.writeFileSync(referenceFile, 'Pet reference fixture')
  pets = createPets({ app, BrowserWindow, screen, ipcMain, mainWindow: () => main, sessions: h.sessions, getCatalog: async () => ({ models }), getOwner: h.managerOptions.getOwner, getCwd: () => h.directory, getPermission: () => 'confirm',
    getSkills: () => skills.list(), chooseReferences: async (window, kind) => { global.petQa.dialogParent = window === pets.windows.windows.get(pets.windows.identity(window.webContents).id).chat; return [kind === 'folder' ? referenceFolder : referenceFile] },
    openMemoryDirectory: async directory => { global.petQa.openedMemoryDirectory = directory },
    openMain: payload => { global.petQa.navigation = payload }, openExternal: url => { global.petQa.openedUrl = url } })
  pets.manager.voice = { speak: async text => ({ mode: 'off', text }) }
  global.petQa = {
    pets, h, main, models, skills, referenceFolder, referenceFile, navigation: null, openedUrl: '',
    ingest(id, event) { const sessionId = pets.manager.config(id).sessionId; h.sessions.ingest(h.sessions.sessions.get(sessionId).piSessionPath, event) },
    finish(id, text) {
      this.ingest(id, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } })
      this.ingest(id, { type: 'agent_settled' })
    },
  }
  await main.loadURL(`http://127.0.0.1:${server.address().port}/`)
  main.show()
})
app.on('before-quit', () => { pets?.close(); server?.close(); h.sessions.stopAll() })
