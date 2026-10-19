const assert = require('node:assert/strict')
const fs = require('node:fs')

// 新建会话懒启动：
//   1) newConversation 必须先画空会话再后台拉起 Pi——不允许 await startAgent(null) 阻塞渲染；
//   2) 所有"拉起 Agent"的路径必须汇入 ensureAgentStarted 单一入口（共享 Promise 防双开进程）；
//   3) runTask 发 prompt 前必须用启动落地后对齐的 sessionFile，不能拿启动前的空路径；
//   4) 待启动的新会话在顶部显示"就绪"而不是"未连接"。
const rendererSource = fs.readFileSync('renderer/app.js', 'utf8')

// ---------- 1) newConversation 瞬时呈现 ----------
const newConvStart = rendererSource.indexOf('async function newConversation()')
assert.ok(newConvStart >= 0, 'newConversation 未找到')
const newConvEnd = rendererSource.indexOf('}', rendererSource.indexOf('ensureAgentStarted().catch', newConvStart))
const newConvBody = rendererSource.slice(newConvStart, newConvEnd)
assert.ok(!/try \{ await startAgent\(null\) \} catch/.test(newConvBody), 'newConversation 不得再同步等待 startAgent(null)（冷启动 1~2 秒阻塞渲染）')
assert.ok(/state\.pendingNewAgent = true/.test(newConvBody), 'newConversation 应标记 pendingNewAgent')
assert.ok(/renderApp\(\)/.test(newConvBody) && newConvBody.indexOf('renderApp()') < newConvBody.indexOf('ensureAgentStarted()'), 'newConversation 必须先渲染再触发后台启动')

// ---------- 2) 单一启动入口 ----------
assert.ok(/let agentStartPromise = null/.test(rendererSource), '缺少 agentStartPromise 去重状态')
assert.ok(/function ensureAgentStarted\(\)/.test(rendererSource), '缺少 ensureAgentStarted 入口')
const ensureStart = rendererSource.indexOf('function ensureAgentStarted()')
const ensureBody = rendererSource.slice(ensureStart, rendererSource.indexOf('}', rendererSource.indexOf('agentStartPromise = run', ensureStart)))
assert.ok(/if \(agentStartPromise\) return agentStartPromise/.test(ensureBody), 'ensureAgentStarted 必须复用进行中的启动 Promise')
assert.ok(/startAgent\(state\.sessionPath, \(\) => state\.sessionPath === owner/.test(ensureBody), '后台启动必须带 shouldApply 守卫，用户切走时不得回写状态')

// ---------- 3) runTask：先上屏、后等进程、prompt 用对齐后的路径 ----------
const runTaskStart = rendererSource.indexOf('async function runTask(task)')
assert.ok(runTaskStart >= 0, 'runTask 未找到')
const runTaskEnd = rendererSource.indexOf('async function sendMessage()', runTaskStart)
const runTaskBody = rendererSource.slice(runTaskStart, runTaskEnd)
assert.ok(/let sessionPath = taskSessionPath \|\| state\.sessionPath/.test(runTaskBody), 'runTask 的 sessionPath 必须是 let（启动后重新对齐）')
const insertIdx = runTaskBody.indexOf('insertTimelineMessage(message)')
const promptIdx = runTaskBody.indexOf("type: 'prompt'")
assert.ok(insertIdx > 0 && promptIdx > insertIdx, '用户消息必须先上屏再发 prompt')
assert.ok(/if \(agentStartPromise\) await agentStartPromise/.test(runTaskBody), '发送时必须等待进行中的后台启动')
assert.ok(/sessionPath = taskSessionPath \|\| state\.sessionPath \|\| sessionPath/.test(runTaskBody), 'prompt 前必须用对齐后的 sessionFile')
assert.ok(/if \(state\.pendingNewAgent \|\| agentStartPromise\) \{ try \{ await ensureAgentStarted\(\) \} catch \{\} \}/.test(runTaskBody), '技能分发前必须等运行时就绪')

// ---------- 4) 连接状态标签 ----------
assert.ok(/state\.pendingNewAgent \? '就绪' : '未连接'/.test(rendererSource), '待启动新会话应显示"就绪"')
assert.ok(/state\.piState \|\| state\.pendingNewAgent \? '' : 'offline'/.test(rendererSource), '就绪状态连接点不应显示离线灰')

// ---------- 5) 状态清理 ----------
assert.ok(/state\.pendingNewAgent = false/.test(rendererSource.slice(rendererSource.indexOf('function switchSession'), rendererSource.indexOf('function switchSession') + 800)), 'switchSession 应清掉 pendingNewAgent')
assert.ok(/state\.pendingNewAgent = false; state\.authChecking/.test(rendererSource), '登出重置应清掉 pendingNewAgent')

console.log('OK 新建会话懒启动检查通过')
