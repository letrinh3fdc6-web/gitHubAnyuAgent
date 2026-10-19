const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

// 切换会话的性能优化：
//   1) 秒开——先用内存缓存 / 主进程直读会话文件把历史画出来，不等 pi.exe 冷启动；
//   2) 两阶段——get_messages 一到就上屏，附件/媒体/工件后台补齐；
//   3) 并发——get_state 与会话列表并行、get_messages 与思考强度并行；
//   4) 会话列表缓存——不再每次切换都把全部 .jsonl 读一遍。
async function main() {
const rendererSource = fs.readFileSync('renderer/app.js', 'utf8')
const mainSource = fs.readFileSync('main.cjs', 'utf8')

const sliceStart = rendererSource.indexOf('  const SESSION_MESSAGES_CACHE_LIMIT')
const sliceEnd = rendererSource.indexOf('  function updateSessionTitle(', sliceStart)
assert.ok(sliceStart >= 0 && sliceEnd > sliceStart, '会话消息缓存/两阶段加载函数未找到')

const piMessages = [
  { role: 'user', content: [{ type: 'text', text: '第一条' }], timestamp: 1000 },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '想了一下' }, { type: 'text', text: '回复一' }], timestamp: 2000 },
  { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: '文件内容' }], timestamp: 2500 },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.txt' } }], timestamp: 2200 },
  { role: 'custom', content: [{ type: 'text', text: '不应出现' }], timestamp: 2600 }
]

const state = { messages: [], imageLibrary: [], mediaMessages: {}, sessionMessagesCache: {}, sessionPath: '' }
let attachmentsSettled = false
const windowStub = {
  anyu: {
    piSessionMessages: async () => ({ messages: piMessages }),
    piCommand: async (command) => {
      if (command.type === 'get_messages') return { data: { messages: piMessages } }
      throw new Error('unexpected command ' + command.type)
    },
    // 故意永不落地：第一阶段绝不能等附件/媒体/工件。
    piAttachments: () => new Promise(() => { attachmentsSettled = false }),
    piMedia: () => new Promise(() => {})
  }
}
const context = {
  state,
  window: windowStub,
  textOf: (content) => Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => String(part.text || '')).join('\n') : String(content || ''),
  imageAttachmentsFromContent: () => [],
  timestampValue: (value) => Number(value) || 0,
  thinkingOf: (content) => Array.isArray(content) ? content.filter((part) => part.type === 'thinking').map((part) => String(part.thinking || '')).join('\n') : '',
  toolCallsFromContent: (content) => Array.isArray(content) ? content.filter((part) => ['toolCall', 'tool_call'].includes(part?.type)).map((part) => ({ toolCallId: part.id || part.toolCallId, toolName: part.name || part.toolName, args: part.arguments || part.args || {} })) : [],
  orderTimeline: (messages) => messages,
  timelineMessagesUnique: (messages) => messages,
  inspectMessageArtifacts: async () => []
}
vm.runInNewContext(`${rendererSource.slice(sliceStart, sliceEnd)}; this.saveSessionMessagesCache = saveSessionMessagesCache; this.restoreSessionMessagesCache = restoreSessionMessagesCache; this.normalizePiMessages = normalizePiMessages; this.paintSessionFromDisk = paintSessionFromDisk; this.refreshMessages = refreshMessages`, context)
const { saveSessionMessagesCache, restoreSessionMessagesCache, normalizePiMessages, paintSessionFromDisk, refreshMessages } = context

const A = 'C:\\sessions\\a.jsonl'
const B = 'C:\\sessions\\b.jsonl'

// 1) 归一化：只保留三种角色，toolResult 映射成 tool，自定义消息丢弃
const normalized = normalizePiMessages(piMessages)
assert.equal(normalized.length, 4, '自定义消息不应进入时间线')
assert.equal(normalized[0].role, 'user')
assert.equal(normalized[0].content, '第一条')
assert.equal(normalized[1].thinking, '想了一下', '思考内容要单独抽出来')
assert.equal(normalized[2].role, 'tool', 'toolResult 在界面上渲染为 tool')
// toolResult 的 toolName 缺失时，从同一轮 assistant 的 toolCall 里补齐
assert.equal(normalized[2].toolName, 'read')
assert.deepEqual(normalized[2].args, { path: 'a.txt' })

// 2) 两阶段：refreshMessages 必须只等 get_messages 就上屏，不能卡在附件/媒体
state.sessionPath = A
state.messages = []
await refreshMessages(() => true)
assert.equal(state.messages.length, 4, '第一阶段拿到 get_messages 就该上屏')
assert.equal(attachmentsSettled, false, '第一阶段不应等待附件补齐')
assert.ok(state.sessionMessagesCache[A], '首屏结果要写入缓存，供下次秒开')

// 3) 秒开：内存缓存命中即可直接上屏（同步，无 IPC）
state.messages = []
state.sessionPath = B
assert.equal(restoreSessionMessagesCache(B), false, '没打开过的会话不应命中缓存')
state.sessionPath = A
assert.equal(restoreSessionMessagesCache(A), true, '打开过的会话应命中缓存')
assert.equal(state.messages.length, 4, '命中缓存后历史要立刻回到界面')

// 4) 冷会话秒开：内存没命中时走主进程直读
state.messages = []
assert.equal(await paintSessionFromDisk(A, () => true), true)
assert.equal(state.messages.length, 4, '直读会话文件应立刻画出历史')
assert.equal(await paintSessionFromDisk(B, () => false), false, '切换已被取消时不应再上屏')

// 5) 缓存有上限，避免长会话把内存撑爆
for (let index = 0; index < 20; index++) saveSessionMessagesCache(`C:\\sessions\\${index}.jsonl`, [{ id: String(index) }])
assert.ok(Object.keys(state.sessionMessagesCache).length <= 8, '会话消息缓存必须限长')

// 6) 主进程直读必须按 Pi 的规则还原“当前分支”：父链之外和压缩掉的历史都不能画出来
const fnStart = mainSource.indexOf('function readPiSessionMessages(')
const fnEnd = mainSource.indexOf('function sessionWorkingDirectory(', fnStart)
assert.ok(fnStart >= 0 && fnEnd > fnStart, 'readPiSessionMessages 未找到')
const mainContext = { fs, path, JSON, assertPiSessionPath: (value) => path.resolve(String(value || '')) }
vm.runInNewContext(`${mainSource.slice(fnStart, fnEnd)}; this.readPiSessionMessages = readPiSessionMessages`, mainContext)
const { readPiSessionMessages } = mainContext

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-perf-'))
const sessionFile = path.join(tempDir, 's.jsonl')
const line = (entry) => JSON.stringify(entry)
const messageEntry = (id, parentId, role, text) => line({ type: 'message', id, parentId, timestamp: `2026-01-01T00:00:0${id}.000Z`, message: { role, content: [{ type: 'text', text }] } })
fs.writeFileSync(sessionFile, [
  line({ type: 'session', version: 3, id: 'root', timestamp: '2026-01-01T00:00:00.000Z', cwd: tempDir }),
  messageEntry('1', null, 'user', '主线一'),
  messageEntry('2', '1', 'assistant', '主线回复'),
  // 从 1 分叉出去的支线：不属于当前分支，不能画出来
  messageEntry('3', '1', 'user', '支线提问'),
  messageEntry('4', '3', 'assistant', '支线回复'),
  messageEntry('5', '2', 'user', '主线二'),
  messageEntry('6', '5', 'assistant', '主线二回复'),
  // 压缩点：firstKeptEntryId 之前的历史已被摘要取代
  line({ type: 'compaction', id: '7', parentId: '6', timestamp: '2026-01-01T00:00:07.000Z', summary: '摘要', firstKeptEntryId: '5' }),
  messageEntry('8', '7', 'user', '压缩之后'),
  messageEntry('9', '8', 'assistant', '压缩之后回复')
].join('\n') + '\n')
// Array.from 在外层 realm 里重建数组：vm 里产生的数组原型不同，deepStrictEqual 会误报。
const read = Array.from(readPiSessionMessages(sessionFile), (message) => message.content[0].text)
assert.deepEqual(read, ['主线二', '主线二回复', '压缩之后', '压缩之后回复'], '直读必须还原当前分支并跳过被压缩的历史')
assert.equal(readPiSessionMessages(path.join(tempDir, 'missing.jsonl')).length, 0, '会话文件不存在时返回空')

// 7) 会话列表缓存：签名不变就不再读文件
assert.ok(mainSource.includes('piSessionsCache'), 'listPiSessions 必须带缓存')
assert.ok(/if \(!force && signature && signature === piSessionsCache\.signature\)/.test(mainSource), '命中缓存时应直接返回')
assert.ok(mainSource.includes('piSessionsCache = { signature, sessions'), '解析结果要写回缓存')

// 8) 切换会话要并发而不是四级串行
const startAgent = rendererSource.slice(rendererSource.indexOf('  async function startAgent('), rendererSource.indexOf('  async function bootstrap('))
assert.ok(!/await refreshMessages\(shouldApply\); await refreshSessions\(shouldApply\)/.test(startAgent), 'startAgent 不应再串行等待消息与会话列表')
assert.ok(/Promise\.all\(\[\s*window\.anyu\.piCommand\(\{ type: 'get_state'/.test(startAgent), 'get_state 应与会话列表并行')
assert.ok(startAgent.includes('refreshMessages(shouldApply)') && startAgent.includes('syncThinkingLevels()'), 'get_messages 应与思考强度并行')
const switchSource = rendererSource.slice(rendererSource.indexOf('  function switchSession('), rendererSource.indexOf('  function keyHtml('))
assert.ok(switchSource.includes('restoreSessionMessagesCache(target)'), '切换会话要先用内存缓存秒开')
assert.ok(switchSource.includes('paintSessionFromDisk(target'), '内存没命中时要直读会话文件秒开')

// 9) 新增 IPC 必须三处齐备
assert.ok(mainSource.includes("ipcMain.handle('pi:session-messages'"), '主进程要有 pi:session-messages')
const preloadSource = fs.readFileSync('preload.cjs', 'utf8')
assert.ok(preloadSource.includes("piSessionMessages:"), 'preload 要暴露 piSessionMessages')

fs.rmSync(tempDir, { recursive: true, force: true })
console.log('OK 会话切换性能优化检查通过')
}

main().catch((error) => { console.error(error); process.exit(1) })
