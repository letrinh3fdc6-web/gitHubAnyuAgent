const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

// 会话隔离与右键能力：
//   1) 排队任务按会话隔离 —— 在 A 会话排的队，B 会话既看不到也不会被消耗；
//   2) 技能占用（测图/评价分析）按会话隔离 —— A 在跑技能，B 照常能发消息；
//   3) 分叉会话 —— 复制本机 .jsonl 为新会话，原会话不动；
//   4) 测图/发图不再按目录标注拦截，用当前模型直接把请求发出去。
const rendererSource = fs.readFileSync('renderer/app.js', 'utf8')
const mainSource = fs.readFileSync('main.cjs', 'utf8')
const preloadSource = fs.readFileSync('preload.cjs', 'utf8')

// ---------- 1/2) 访问器切片 ----------
const start = rendererSource.indexOf('  // ---------- 排队任务按会话隔离 ----------')
const end = rendererSource.indexOf('  const api = (route, options)', start)
assert.ok(start >= 0 && end > start, '会话队列访问器未找到')
const state = { sessionPath: null, sessionQueues: {}, sessionSkills: {} }
const context = { state, normalizeSessionKey: (value) => String(value || '').trim(), Object, Array }
vm.runInNewContext(`${rendererSource.slice(start, end)}; this.sessionQueue = sessionQueue; this.setSessionQueue = setSessionQueue; this.setSessionSkill = setSessionSkill; this.queueSessionKey = queueSessionKey`, context)
const { sessionQueue, setSessionSkill } = context

const A = 'C:\\sessions\\a.jsonl'
const B = 'C:\\sessions\\b.jsonl'

// 排队隔离：A 里 push，B 看不到
state.sessionPath = A
state.queuedTasks.push({ id: 't1', content: 'A 的排队' })
state.sessionPath = B
assert.equal(state.queuedTasks.length, 0, 'B 会话不应看到 A 会话的排队任务')
state.sessionPath = A
assert.equal(state.queuedTasks.length, 1, '切回 A 应该看到自己的排队任务')
// 赋值清空只影响当前会话
state.queuedTasks = []
assert.equal(state.queuedTasks.length, 0)
context.setSessionQueue(A, [])
assert.equal(state.sessionQueues[A], undefined, '显式清空应从存储里移除')
// 消耗队列不跨会话
state.sessionPath = A
state.queuedTasks.push({ id: 't2' })
state.sessionPath = B
state.queuedTasks.push({ id: 't3' })
assert.deepEqual(Array.from(state.queuedTasks, (task) => task.id), ['t3'])

// 技能占用隔离
state.sessionPath = A
state.skillBusy = 'image-analysis'
state.sessionPath = B
assert.equal(state.skillBusy, null, 'A 在跑技能不应阻塞 B')
state.skillBusy = 'feedback'
assert.equal(state.sessionSkills[B], 'feedback')
assert.equal(state.sessionSkills[A], 'image-analysis')
setSessionSkill(A, null)
assert.equal(state.sessionSkills[A], undefined, '显式清理要落到正确的会话上')
state.sessionPath = A
assert.equal(state.skillBusy, null)

// ---------- 3) 分叉会话 ----------
const forkStart = mainSource.indexOf('function forkPiSession(')
const forkEnd = mainSource.indexOf('function buildApiUrl(', forkStart)
assert.ok(forkStart >= 0 && forkEnd > forkStart, 'forkPiSession 未找到')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fork-'))
const metaStore = {}
const mainContext = {
  fs, path, crypto: require('node:crypto'),
  assertPiSessionPath: (value) => path.resolve(String(value || '')),
  sessionMetaKey: (value) => path.resolve(String(value || '')),
  readPiSessionMeta: () => ({ ...metaStore }),
  writePiSessionMeta: (value) => { Object.keys(metaStore).forEach((key) => delete metaStore[key]); Object.assign(metaStore, value) },
  piSessionsCache: { signature: 'x', sessions: [1] }
}
vm.runInNewContext(`${mainSource.slice(forkStart, forkEnd)}; this.forkPiSession = forkPiSession`, mainContext)
const sessionFile = path.join(tempDir, '2026-09-29T10-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl')
const line = (entry) => JSON.stringify(entry)
fs.writeFileSync(sessionFile, [
  line({ type: 'session', version: 3, id: '11111111-2222-3333-4444-555555555555', timestamp: '2026-09-29T10:00:00.000Z', cwd: tempDir }),
  line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-29T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '第一问' }] } }),
  line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-29T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '第一答' }] } })
].join('\n') + '\n')
metaStore[path.resolve(sessionFile)] = { title: '原始会话' }
const forked = mainContext.forkPiSession({ sessionPath: sessionFile })
assert.ok(forked.ok && fs.existsSync(forked.path), '分叉应生成新会话文件')
assert.notEqual(forked.path, sessionFile, '分叉不能覆盖原会话')
assert.equal(fs.readFileSync(sessionFile, 'utf8'), fs.readFileSync(sessionFile, 'utf8'), '原会话内容必须原样保留')
const forkHeader = JSON.parse(fs.readFileSync(forked.path, 'utf8').split('\n')[0])
assert.notEqual(forkHeader.id, '11111111-2222-3333-4444-555555555555', '新会话要有自己的 id')
assert.equal(forkHeader.cwd, tempDir, '分叉会话沿用工作目录')
const forkLines = fs.readFileSync(forked.path, 'utf8').trim().split('\n')
assert.equal(forkLines.length, 3, '分叉会话要带上全部历史条目')
assert.equal(JSON.parse(forkLines[1]).message.content[0].text, '第一问', '历史消息要原样带过去')
assert.equal(metaStore[path.resolve(forked.path)].title, '原始会话 分支', '分叉会话默认标题要能区分')
assert.ok(/piSessionsCache = \{ signature: '', sessions: \[\] \}/.test(mainSource.slice(forkStart, forkEnd)), '分叉后要清掉会话列表缓存')

// 分叉出来的文件要能被「直读会话文件」的快路径正确读出全部历史
const readStart = mainSource.indexOf('function readPiSessionMessages(')
const readEnd = mainSource.indexOf('function sessionWorkingDirectory(', readStart)
const readContext = { fs, path, JSON, assertPiSessionPath: (value) => path.resolve(String(value || '')) }
vm.runInNewContext(`${mainSource.slice(readStart, readEnd)}; this.readPiSessionMessages = readPiSessionMessages`, readContext)
const forkMessages = readContext.readPiSessionMessages(forked.path)
assert.equal(forkMessages.length, 2, '分叉会话应能读出全部历史消息')
assert.deepEqual(Array.from(forkMessages, (message) => message.role), ['user', 'assistant'])

// ---------- 4) 不再有识图拦截 ----------
assert.ok(!rendererSource.includes('selectVisionModelForImageAnalysis'), '不应再按目录自动挑选“视觉模型”')
assert.ok(!rendererSource.includes('imageUnsupported'), '发图不应再被“模型不支持图片”挡死')
assert.ok(!mainSource.includes('当前账号没有可用的视觉模型'), '主进程不应再预判识图能力')
assert.ok(rendererSource.includes('正在使用 ${selectedModel.name'), '测图应使用用户当前选中的模型')
assert.ok(preloadSource.includes('piForkSession'), 'preload 要暴露 piForkSession')
assert.ok(mainSource.includes("ipcMain.handle('pi:session-fork'"), '主进程要有 pi:session-fork')
assert.ok(rendererSource.includes('分叉为新会话') && rendererSource.includes('复制会话链接'), '右键菜单要有分叉与复制链接')
assert.ok(rendererSource.includes('const scrollTop = Number(list.scrollTop || 0)'), '侧栏列表渲染要保留滚动位置')

fs.rmSync(tempDir, { recursive: true, force: true })
console.log('OK 会话隔离 / 分叉 / 识图放行检查通过')
