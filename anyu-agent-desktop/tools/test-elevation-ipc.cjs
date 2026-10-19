const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

// 本测试用桩件替换 electron 与 child_process，直接加载真实的 main.cjs，
// 然后调用它注册的 IPC 处理器。目的是在不启动界面的前提下，
// 验证"提权前同步落盘意图、重启后能读回、确认后清除"这条完整链路。

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-elevation-ipc-'))
const intentPath = path.join(workDir, 'anyu-elevation.json')

const handlers = new Map()
const calls = { quit: 0, elevationEnv: null, spawn: 0, failElevation: false, intentExistedAtLaunch: null }
let resolveQuit
const quitCalled = new Promise((resolve) => { resolveQuit = resolve })

let bootCallback = null

function FakeBrowserWindow() {
  this.webContents = { setWindowOpenHandler: () => {}, send: () => {}, on: () => {} }
  this.loadFile = () => {}
  this.loadURL = () => Promise.resolve()
  this.on = () => {}
  this.close = () => {}
  this.isDestroyed = () => false
  this.isMaximized = () => false
}
FakeBrowserWindow.getAllWindows = () => []

function FakeTray() {}
FakeTray.prototype.isDestroyed = () => false
FakeTray.prototype.setToolTip = () => {}
FakeTray.prototype.setContextMenu = () => {}
FakeTray.prototype.on = () => {}

const electronStub = {
  app: {
    setPath: () => {},
    getPath: () => workDir,
    on: () => {},
    // 捕获启动回调而不立即执行，让测试决定何时跑完注册流程。
    whenReady: () => ({ then: (fn) => { bootCallback = fn } }),
    quit: () => { calls.quit += 1; resolveQuit() },
    getVersion: () => '0.0.0-test',
    isPackaged: false
  },
  BrowserWindow: FakeBrowserWindow,
  Tray: FakeTray,
  ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn) }, on: () => {} },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  protocol: {
    handle: () => {},
    registerSchemesAsPrivileged: () => {}
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: () => {} },
      protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} }
    }
  },
  dialog: {},
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) }
}

const childProcessStub = {
  spawn: () => { calls.spawn += 1; throw new Error('本测试不应启动 Pi 进程') },
  // 既用于管理员判定（返回空串即判定为非管理员），也用于拉起提权实例。
  execFileSync: (file, argv, options) => {
    if (calls.failElevation) throw new Error('UAC 授权被取消')
    calls.elevationEnv = options?.env || null
    // 拉起提权实例的那一刻，意图必须已经在磁盘上。
    // 顺序反了正是"重启后权限没生效、还得手动再点一次"的根因，这里把它钉住。
    if (options?.env?.ANYU_ELEVATED === '1') {
      calls.intentExistedAtLaunch = fs.existsSync(intentPath)
    }
    return ''
  }
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') return electronStub
  if (request === 'child_process') return childProcessStub
  return originalLoad.call(this, request, ...rest)
}

process.env.ANYU_USER_DATA_DIR = workDir
process.env.ANYU_ELEVATED = '1'

function readIntentFile() {
  return fs.existsSync(intentPath) ? JSON.parse(fs.readFileSync(intentPath, 'utf8')) : null
}

async function main() {
  try {
    require('../main.cjs')
    // IPC 处理器是在 whenReady 回调里注册的，必须真的跑一遍才会出现在 handlers 里。
    assert.ok(typeof bootCallback === 'function', '未注册启动回调')
    bootCallback()

    assert.ok(handlers.has('system:request-elevation'), '缺少提权请求入口')
    assert.ok(handlers.has('system:elevation-intent'), '缺少提权意图查询入口')
    assert.ok(handlers.has('system:acknowledge-elevation'), '缺少提权意图确认入口')
    console.log('elevation ipc registration: passed')

    // 首次启动没有意图文件时，必须明确回报"没有待处理意图"
    const initial = handlers.get('system:elevation-intent')()
    assert.strictEqual(initial.pending, false)
    assert.strictEqual(initial.permissionMode, null)
    assert.strictEqual(fs.existsSync(intentPath), false)
    console.log('elevation ipc no pending intent: passed')

    if (process.platform !== 'win32') {
      console.log('elevation ipc windows restart flow: skipped (非 Windows)')
      return
    }

    // 点击"完整访问"：主进程必须先同步落盘意图，再拉起提权实例
    const result = await handlers.get('system:request-elevation')(null, { permissionMode: 'full' })
    assert.strictEqual(result.restarted, true, '非管理员时应触发重启提权')
    assert.ok(fs.existsSync(intentPath), '拉起提权实例之前必须先把意图落盘')
    assert.strictEqual(readIntentFile().permissionMode, 'full')
    assert.strictEqual(calls.elevationEnv?.ANYU_ELEVATED, '1', '提权实例必须带环境标记')
    assert.strictEqual(calls.intentExistedAtLaunch, true, '必须先把意图落盘再拉起提权实例')
    console.log('elevation ipc writes intent before restart: passed')

    // 重启后的新实例要能读回意图，并区分"被拉起"与"已拿到管理员权限"
    const state = handlers.get('system:elevation-intent')()
    assert.strictEqual(state.pending, true, '重启后必须能读到待生效的意图')
    assert.strictEqual(state.permissionMode, 'full', '重启后必须恢复完整访问')
    assert.strictEqual(state.launchedElevated, true)
    assert.strictEqual(state.elevated, false, '桩件下非管理员，不能谎报已提权')
    console.log('elevation ipc reads intent after restart: passed')

    // 旧进程要按时退出，避免两个实例同时占用同一个数据目录
    await Promise.race([
      quitCalled,
      new Promise((_, reject) => setTimeout(() => reject(new Error('提权后未按时退出旧进程')), 3000))
    ])
    console.log('elevation ipc quits previous instance: passed')

    // 渲染进程确认生效后，意图必须被清除，否则下次启动会凭空套用完整访问
    await handlers.get('system:acknowledge-elevation')()
    assert.strictEqual(fs.existsSync(intentPath), false, '确认后必须清除意图文件')
    assert.strictEqual(handlers.get('system:elevation-intent')().pending, false)
    console.log('elevation ipc acknowledge clears intent: passed')

    // 设置页那个单独的"以管理员身份重启"按钮不带权限模式，
    // 此时只能提权，不能顺手把权限模式改成完整访问。
    await handlers.get('system:request-elevation')(null, {})
    assert.strictEqual(readIntentFile().permissionMode, null)
    assert.strictEqual(handlers.get('system:elevation-intent')().permissionMode, null)
    await handlers.get('system:acknowledge-elevation')()
    console.log('elevation ipc elevate only keeps permission mode: passed')

    // UAC 被取消时必须清掉意图，不能留下一个下次启动才生效的"幽灵完整访问"
    calls.failElevation = true
    const failed = await handlers.get('system:request-elevation')(null, { permissionMode: 'full' })
    assert.strictEqual(failed.cancelled, true)
    assert.strictEqual(fs.existsSync(intentPath), false, 'UAC 取消后必须清除意图')
    assert.strictEqual(handlers.get('system:elevation-intent')().pending, false)
    console.log('elevation ipc cancelled uac cleanup: passed')

    assert.strictEqual(calls.spawn, 0, '本测试不应真的启动 Pi 进程')
  } finally {
    Module._load = originalLoad
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

main().then(() => {
  process.exit(process.exitCode || 0)
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
  process.exit(1)
})
