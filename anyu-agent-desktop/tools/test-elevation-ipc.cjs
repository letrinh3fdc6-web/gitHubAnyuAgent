const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { spawnSync } = require('node:child_process')

const childMode = process.argv[2]
const workDir = fs.realpathSync(process.env.ANYU_PERMISSION_TEST_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-permission-ipc-')))
const handlers = new Map()
let boot
let ready = false
let elevationError = null
let quitCount = 0
let testWindow
let testTray
let elevationCount = 0
const openedFiles = []
class FakeWindow extends EventEmitter {
  constructor() { super(); testWindow = this; this.visible = true; this.destroyed = false; this.minimized = false; this.webContents = { setWindowOpenHandler() {}, send() {}, on() {}, once() {} } }
  setAppDetails() {}
  loadURL() { return Promise.resolve() }
  loadFile() {}
  close() { const event = { prevented: false, preventDefault() { this.prevented = true } }; this.emit('close', event); if (!event.prevented) { this.destroyed = true; this.emit('closed') } }
  hide() { this.visible = false }
  show() { this.visible = true }
  focus() {}
  restore() { this.minimized = false }
  isMinimized() { return this.minimized }
  isDestroyed() { return this.destroyed }
  isMaximized() { return false }
  isFullScreen() { return false }
  getSize() { return [1440, 920] }
  setShape() {}
  static getAllWindows() { return [] }
}
class FakeTray extends EventEmitter { constructor() { super(); testTray = this } isDestroyed() { return false } setToolTip() {} setContextMenu(menu) { this.menu = menu } }
class FakeBroker {
  on() {}
  state() { return { ready, pid: ready ? 12345 : null } }
  async ensure() { elevationCount++; if (elevationError) throw elevationError; ready = true; return this.state() }
  async close() { ready = false }
}
const electron = {
  app: Object.assign(new EventEmitter(), { setAppUserModelId() {}, commandLine: { appendSwitch() {} }, setPath() {}, getPath: () => workDir, requestSingleInstanceLock: () => childMode !== '--duplicate', isReady: () => true, whenReady: () => ({ then: fn => { boot = fn } }), quit: () => { quitCount++ }, getVersion: () => 'test', isPackaged: true }),
  BrowserWindow: FakeWindow, Tray: FakeTray,
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
  safeStorage: { isEncryptionAvailable: () => false }, shell: { openExternal: async () => {}, openPath: async file => { openedFiles.push(file); return '' } },
  protocol: { handle() {}, registerSchemesAsPrivileged() {} },
  session: { defaultSession: { webRequest: { onHeadersReceived() {} }, protocol: { handle() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  dialog: {}, Menu: { setApplicationMenu() {}, buildFromTemplate: menu => menu },
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
    if (childMode === '--duplicate') {
      assert.equal(quitCount, 1)
      assert.equal(boot, undefined, 'A duplicate process must not initialize sessions or a second tray')
      assert.equal(handlers.size, 0)
      return
    }
    await boot()
    const state = () => handlers.get('agent:permission-state')()
    const setMode = mode => handlers.get('agent:set-permission-mode')(null, mode)
    if (childMode === '--restore-full') {
      assert.equal(state().mode, 'full', 'A fresh process restores the full-access preference')
      assert.equal(state().ready, true)
      assert.equal(elevationCount, 0)
      assert.equal(state().systemAccess.executionAdministrator, process.platform === 'win32' ? false : undefined)
      return
    }
    assert.equal(state().mode, 'auto')
    assert.equal(state().activeMode, null)
    const enabled = await setMode('full')
    assert.equal(enabled.ok, true)
    assert.equal(enabled.mode, 'full')
    assert.equal(enabled.ready, true)
    assert.equal(enabled.activeMode, null, 'No runtime has been started')
    assert.equal(elevationCount, 0, 'Full access must not require administrator elevation')
    for (const mode of ['--restore-full','--duplicate']) {
      const child = spawnSync(process.execPath, [__filename, mode], { env: { ...process.env, ANYU_PERMISSION_TEST_PROFILE: workDir }, encoding: 'utf8', timeout: 30000, windowsHide: true })
      assert.equal(child.status, 0, child.stderr)
    }
    assert.deepEqual(fs.readdirSync(workDir).filter(name => name.endsWith('.tmp')), [], 'Permission persistence leaves no partial files')
    if (process.platform === 'win32') {
      elevationError = Object.assign(new Error('UAC cancelled'), { code: 'UAC_CANCELLED', cancelled: true })
      const cancelled = await handlers.get('system:request-elevation')(null, {})
      assert.equal(cancelled.ok, false)
      assert.equal(cancelled.code, 'UAC_CANCELLED')
      assert.equal(state().mode, 'full', 'Cancelling optional administrator elevation preserves full access')
      assert.equal(state().ready, true)
      elevationError = Object.assign(new Error('worker failed'), { code: 'UAC_LAUNCH_FAILED' })
      const failed = await handlers.get('system:request-elevation')(null, {})
      assert.equal(failed.cancelled, false)
      assert.equal(failed.code, 'UAC_LAUNCH_FAILED')
      elevationError = null
    }
    if (process.platform === 'win32') {
      assert.equal(enabled.systemAccess.administrator, false, 'UI token remains standard')
      assert.equal(enabled.systemAccess.executionAdministrator, false)
      const elevated = await handlers.get('system:request-elevation')(null, {})
      assert.equal(elevated.ok, true)
      assert.equal(elevated.state.executionAdministrator, true)
      assert.equal(elevated.state.executionHost, 'worker')
      ready = false
      assert.equal(state().ready, true, 'Losing the optional worker does not revoke normal full access')
      assert.equal(state().systemAccess.executionAdministrator, false, 'Actual administrator status remains accurate')
    }
    const controlled = await setMode('confirm')
    assert.equal(controlled.mode, 'confirm')
    assert.equal(controlled.activeMode, null)
    assert.equal(JSON.parse(fs.readFileSync(path.join(workDir, 'anyu-permission.json'), 'utf8')).mode, 'confirm')
    assert.equal(quitCount, 0, 'Permission changes must keep the UI alive')
    const originalWindow = testWindow
    const windowAction = handlers.get('window:action')
    windowAction(null, 'close')
    assert.equal(originalWindow.destroyed, false)
    assert.equal(originalWindow.visible, false)
    assert.equal(testTray.isDestroyed(), false)
    assert.equal(quitCount, 0)
    testTray.emit('click')
    assert.equal(originalWindow.visible, true)
    originalWindow.close()
    assert.equal(originalWindow.visible, false, 'Native Alt+F4 also hides the window')
    electron.app.emit('second-instance')
    assert.equal(originalWindow.visible, true)
    assert.equal(testWindow, originalWindow, 'The shortcut reuses the existing window')
    windowAction(null, 'close')
    electron.app.emit('activate')
    assert.equal(originalWindow.visible, true)
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
    testTray.menu.find(item => item.label === '退出 AnyuAgent').click()
    assert.equal(quitCount, 1, 'The explicit tray Quit command still exits')
    originalWindow.close()
    assert.equal(originalWindow.destroyed, true)
    console.log('Desktop IPC: persisted full access, optional UAC, tray close/reopen, single instance and explicit quit passed')
  } finally {
    Module._load = originalLoad
    if (!childMode) fs.rmSync(workDir, { recursive: true, force: true })
  }
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
