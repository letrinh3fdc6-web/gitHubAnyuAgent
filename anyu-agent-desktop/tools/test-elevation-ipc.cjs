const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-permission-ipc-'))
const handlers = new Map()
let boot
let ready = false
let elevationError = null
let quitCount = 0
let testWindow
const openedFiles = []
class FakeWindow {
  constructor() { testWindow = this; this.webContents = { setWindowOpenHandler() {}, send() {}, on() {}, once() {} } }
  setAppDetails() {}
  loadURL() { return Promise.resolve() }
  loadFile() {}
  on() {}
  once() {}
  isDestroyed() { return false }
  isMaximized() { return false }
  isFullScreen() { return false }
  getSize() { return [1440, 920] }
  setShape() {}
  static getAllWindows() { return [] }
}
class FakeTray { isDestroyed() { return false } setToolTip() {} setContextMenu() {} on() {} }
class FakeBroker {
  on() {}
  state() { return { ready, pid: ready ? 12345 : null } }
  async ensure() { if (elevationError) throw elevationError; ready = true; return this.state() }
  async close() { ready = false }
}
const electron = {
  app: { setAppUserModelId() {}, commandLine: { appendSwitch() {} }, setPath() {}, getPath: () => workDir, on() {}, whenReady: () => ({ then: fn => { boot = fn } }), quit: () => { quitCount++ }, getVersion: () => 'test', isPackaged: true },
  BrowserWindow: FakeWindow, Tray: FakeTray,
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
  safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: async () => {}, openPath: async file => { openedFiles.push(file); return '' } },
  protocol: { handle() {}, registerSchemesAsPrivileged() {} },
  session: { defaultSession: { webRequest: { onHeadersReceived() {} }, protocol: { handle() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  dialog: {}, Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
}

const originalLoad = Module._load
Module._load = function (name, ...args) {
  if (name === 'electron') return electron
  if (name === './execution-broker.cjs') return { ExecutionBroker: FakeBroker }
  if (name === 'child_process') return { spawn: () => { throw new Error('Unexpected Pi spawn') }, execFileSync: () => '', execFile() {} }
  return originalLoad.call(this, name, ...args)
}
process.env.ANYU_USER_DATA_DIR = workDir
process.env.ANYU_ALLOW_LOCAL_API_BASE = '1'
process.env.ANYU_RUNTIME_MODE = 'local'
process.resourcesPath = workDir

async function main() {
  try {
    require('../main.cjs')
    await boot()
    const state = () => handlers.get('agent:permission-state')()
    const setMode = mode => handlers.get('agent:set-permission-mode')(null, mode)
    assert.equal(state().mode, 'auto')
    assert.equal(state().activeMode, null)
    if (process.platform === 'win32') {
      elevationError = Object.assign(new Error('UAC cancelled'), { code: 'UAC_CANCELLED', cancelled: true })
      const cancelled = await setMode('full')
      assert.equal(cancelled.ok, false)
      assert.equal(cancelled.code, 'UAC_CANCELLED')
      assert.equal(state().mode, 'auto')
      assert.equal(fs.existsSync(path.join(workDir, 'anyu-permission.json')), false)
      elevationError = Object.assign(new Error('worker failed'), { code: 'UAC_LAUNCH_FAILED' })
      const failed = await setMode('full')
      assert.equal(failed.cancelled, false)
      assert.equal(failed.code, 'UAC_LAUNCH_FAILED')
      elevationError = null
    }
    const enabled = await setMode('full')
    assert.equal(enabled.ok, true)
    assert.equal(enabled.mode, 'full')
    assert.equal(enabled.activeMode, null, 'No runtime has been started')
    if (process.platform === 'win32') {
      assert.equal(enabled.systemAccess.administrator, false, 'UI token remains standard')
      assert.equal(enabled.systemAccess.executionAdministrator, true)
      assert.equal(enabled.systemAccess.executionHost, 'worker')
      ready = false
      assert.equal(state().ready, false, 'Stored full mode does not imply a live administrator worker')
    }
    const controlled = await setMode('confirm')
    assert.equal(controlled.mode, 'confirm')
    assert.equal(controlled.activeMode, null)
    assert.equal(JSON.parse(fs.readFileSync(path.join(workDir, 'anyu-permission.json'), 'utf8')).mode, 'confirm')
    assert.equal(quitCount, 0, 'Permission changes must keep the UI alive')
    const workspace = path.join(workDir, 'workspace')
    fs.mkdirSync(workspace)
    const outside = path.join(workDir, 'external-file.txt')
    fs.writeFileSync(outside, 'external file')
    const event = { sender: testWindow.webContents }
    for (const channel of ['app:open-file', 'app:open-path']) {
      assert.equal((await handlers.get(channel)(event, { cwd: workspace, path: outside })).path, outside)
      await assert.rejects(async () => handlers.get(channel)({ sender: {} }, { path: outside }), /来源无效/)
    }
    const result = await handlers.get('agent-browser:open-artifact')(event, { path: workspace })
    assert.equal(result.openedExternally, true, 'Directories open with the system file manager')
    assert.deepEqual(openedFiles, [outside, outside, workspace])
    const artifacts = handlers.get('app:inspect-artifacts')(event, { cwd: workspace, paths: [outside] })
    assert.equal(artifacts.artifacts[0].path, outside)
    console.log('Permission IPC: cancellation, failure, actual privilege, persistence and no UI restart passed')
  } finally {
    Module._load = originalLoad
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
