const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// 多会话并行的会话状态机：切走不中止、后台完成标未读、打开即已读。
// 直接从渲染层切出这几个纯函数验证，不启动 Electron，也不拉起 Pi。
const file = 'renderer/app.js'
const source = fs.readFileSync(file, 'utf8')
const start = source.indexOf('  function normalizeSessionKey(')
const end = source.indexOf('  function sessionWorkspaceKey(', start)
assert.ok(start >= 0 && end > start, '会话运行状态函数未找到')

const state = { sessionPath: null, sessionRuns: {}, mediaActivity: {}, loading: false, runInProgress: false, activeRequest: null }
// 技能任务（生图/生视频/评价分析/测图）登记在 mediaActivity；真实实现按会话键取列表。
const context = {
  state,
  mediaActivityForSession: (sessionPath) => {
    const list = state.mediaActivity[String(sessionPath || '')]
    return Array.isArray(list) ? list : []
  }
}
vm.runInNewContext(`${source.slice(start, end)}; this.markSessionRun = markSessionRun; this.forgetSessionRun = forgetSessionRun; this.isSessionRunning = isSessionRunning; this.isSessionUnread = isSessionUnread`, context)
const { markSessionRun, forgetSessionRun, isSessionRunning, isSessionUnread } = context

const A = 'C:\\sessions\\a.jsonl'
const B = 'C:\\sessions\\b.jsonl'

// 1) 当前会话的运行状态由视图状态决定
state.sessionPath = A
state.loading = true
assert.equal(isSessionRunning(A), true, '当前会话加载中应显示运行中')
assert.equal(isSessionUnread(A), false, '正在看的会话永远不算未读')

// 2) 切走：把运行状态存档，后台会话继续显示“运行中”
markSessionRun(A, { running: true, unread: false })
state.sessionPath = B
state.loading = false
assert.equal(isSessionRunning(A), true, '切走后后台会话仍应显示运行中')
assert.equal(isSessionRunning(B), false, '新的前台会话尚未发起任务')

// 2b) 技能任务：切走会话后（sessionLoadingPath 已被 switchSession 覆盖），
//     只要 mediaActivity 里还有登记，侧栏就必须继续显示“运行中”。
markSessionRun(A, { running: false, unread: false })
state.mediaActivity[A] = [{ id: 'task-1', kind: 'feedback' }]
assert.equal(isSessionRunning(A), true, '后台会话跑技能任务时必须显示运行中')
state.mediaActivity[B] = [{ id: 'task-2', kind: 'image' }]
assert.equal(isSessionRunning(B), true, '前台会话跑技能任务时也必须显示运行中')
state.mediaActivity[B] = []
assert.equal(isSessionRunning(B), false, '技能任务结束后不应再显示运行中')
state.mediaActivity[A] = []
assert.equal(isSessionRunning(A), false, '登记清空后回退到存档状态')

// 3) 后台任务完成 -> 标记未读；切回来 -> 已读
markSessionRun(A, { running: false, unread: true })
assert.equal(isSessionRunning(A), false, '任务结束后不应再显示运行中')
assert.equal(isSessionUnread(A), true, '后台完成后应点亮未读')
state.sessionPath = A
markSessionRun(A, { unread: false })
assert.equal(isSessionUnread(A), false, '打开会话即已读')
assert.equal(isSessionRunning(A), false, '打开空闲会话不应显示运行中')

// 4) 之前“打开过”的会话切走后不能被误标未读
state.sessionPath = A
markSessionRun(A, { unread: false })
state.sessionPath = B
markSessionRun(A, { running: false })
assert.equal(isSessionUnread(A), false, '已读会话切走后不应重新变绿点')

// 5) 空路径与未记录会话不产生状态
assert.equal(isSessionRunning(''), false)
assert.equal(isSessionUnread(''), false)
assert.equal(isSessionRunning('C:\\sessions\\missing.jsonl'), false)
assert.equal(isSessionUnread('C:\\sessions\\missing.jsonl'), false)
assert.equal(markSessionRun('', { running: true }), null, '空路径不应写入状态')

// 6) 删除会话后状态一并清理（B 当前是后台会话）
state.sessionPath = A
markSessionRun(B, { running: true, unread: true })
assert.equal(isSessionRunning(B), true)
assert.equal(isSessionUnread(B), true)
forgetSessionRun(B)
assert.equal(isSessionRunning(B), false)
assert.equal(isSessionUnread(B), false)

// 7) 状态写入保留未指定的字段
markSessionRun(B, { running: true, unread: false })
markSessionRun(B, { unread: true })
assert.equal(state.sessionRuns[B].running, true, '局部更新不应丢掉 running')
assert.equal(state.sessionRuns[B].unread, true)

// 8) 主进程按会话路由命令：pi:command / pi:stop 必须带 sessionKey，
//    否则多会话并行时会把 abort/prompt 打到别的会话上。
const mainSource = fs.readFileSync('main.cjs', 'utf8')
const commandHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('pi:command'"), mainSource.indexOf("ipcMain.handle('pi:ui-response'"))
assert.ok(commandHandler.includes('resolvePiRuntime(command.sessionKey'), 'pi:command 必须按 sessionKey 路由')
const stopHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('pi:stop'"), mainSource.indexOf("ipcMain.handle('pi:command'"))
assert.ok(stopHandler.includes('options?.sessionKey'), 'pi:stop 必须支持只停单个会话')
assert.ok(stopHandler.includes('if (!requested) return stopPi()'), '只有不指定会话时才整体退出')
assert.ok(stopHandler.includes('if (!target) return { ok: true }'), '指定会话但进程不存在时不能误停其它会话')

// 10) 启动状态响应必须跨 try/catch 可用，避免新会话首发直接 ReferenceError。
const startPiSource = mainSource.slice(mainSource.indexOf('async function startPiUnsafe'), mainSource.indexOf('async function analyzeLocalSkill'))
assert.ok(startPiSource.includes('let stateResponse = null'), 'stateResponse 必须在 try 外声明')
assert.ok(!startPiSource.includes('const stateResponse = await sendPi'), '禁止在 try 内用块级 const 隐藏 stateResponse')
// 11) 发送任务固定会话键；新会话 pending 不得写入伪造路径。
assert.ok(source.includes('sessionPath: state.sessionPath || null'), '任务必须记录创建时的真实会话路径')
assert.ok(source.includes('requestedTaskSession') && source.includes("!== '__pending__'"), 'pending 任务必须允许首次初始化')

// 9) 切换会话不再发起 switch_session，也不再中止请求
const switchSource = source.slice(source.indexOf('  function switchSession('), source.indexOf('  function keyHtml('))
assert.ok(!switchSource.includes("type: 'switch_session'"), '切换会话不应再调用 switch_session（会 teardown 正在生成的任务）')
assert.ok(switchSource.includes('stopRunMonitor()'), '切换会话只停轮询，不发 abort')
assert.ok(!switchSource.includes("type: 'abort'"), '切换会话绝不能向 Pi 发 abort')
assert.ok(switchSource.includes('markSessionRun(previousPath'), '切换会话必须把旧会话的任务状态存档')

console.log('OK 多会话并行状态与路由检查通过')
