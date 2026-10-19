const assert = require('node:assert/strict')
const fs = require('node:fs')

// 侧栏「运行中」动画丢失：
//   技能任务（生图/生视频/评价分析/测图）不走 Pi 运行状态，此前只靠 sessionLoadingPath，
//   而 switchSession 会把它覆盖成目标会话 → 切走之后后台会话永远不显示加载动画。
//   修复后以 mediaActivity 为每会话活动登记表，isSessionRunning 必须读它。
const src = fs.readFileSync('renderer/app.js', 'utf8')

// ---------- 1) isSessionRunning 必须把技能任务算作运行中 ----------
const runningStart = src.indexOf('function isSessionRunning(sessionPath)')
const runningBody = src.slice(runningStart, src.indexOf('function isSessionUnread', runningStart))
assert.ok(/mediaActivityForSession\(sessionPath\)\.length/.test(runningBody), 'isSessionRunning 必须检查 mediaActivity（技能任务的数据源）')

// ---------- 2) 评价分析：登记 → 会话重对齐时搬迁 → 结束时注销 ----------
const feedbackStart = src.indexOf('async function runFeedbackSkill(task)')
const feedbackEnd = src.indexOf('function imageAnalysisSummary', feedbackStart)
const feedbackBody = src.slice(feedbackStart, feedbackEnd)
assert.ok(/beginMediaActivity\(pendingKey, task\.id, 'feedback'\)/.test(feedbackBody), '评价分析开始时必须登记 mediaActivity')
assert.ok(/moveMediaActivity\(oldSessionKey, sessionPath, task\.id\)/.test(feedbackBody), '会话重对齐后必须把活动搬到真实会话')
assert.ok(/endMediaActivity\(sessionPath, task\.id\)/.test(feedbackBody), '评价分析结束时必须注销 mediaActivity')
assert.ok(/scheduleSessionListRender\(\)/.test(feedbackBody), '结束时必须刷新侧栏，让“运行中”立刻消失')

// ---------- 3) 测图：同样登记 ----------
const imageStart = src.indexOf('async function runImageAnalysisSkill(task)')
const imageEnd = src.indexOf('function imageAnalysisSummary', imageStart) // 不存在则回退到下一个函数
const imageBody = imageEnd > imageStart ? src.slice(imageStart, imageEnd) : src.slice(imageStart, imageStart + 6000)
assert.ok(/beginMediaActivity\(pendingKey, task\.id, 'image-analysis'\)/.test(imageBody), '测图开始时必须登记 mediaActivity')
assert.ok(/moveMediaActivity\(oldSessionKey, sessionPath, task\.id\)/.test(imageBody), '测图会话重对齐后必须搬迁活动')
assert.ok(/endMediaActivity\(sessionPath, task\.id\)/.test(imageBody), '测图结束时必须注销 mediaActivity')

// ---------- 4) 重试路径 ----------
const retryStart = src.indexOf('async function retryFeedbackAnalysis(message)')
const retryBody = src.slice(retryStart, src.indexOf('async function runFeedbackSkill(task)', retryStart))
assert.ok(/beginMediaActivity\(sessionPath, retryActivityId, 'feedback'\)/.test(retryBody), '重试分析必须登记 mediaActivity')
assert.ok(/endMediaActivity\(sessionPath, retryActivityId\)/.test(retryBody), '重试结束必须注销 mediaActivity')
assert.ok(/scheduleSessionListRender\(\)/.test(retryBody), '重试结束必须刷新侧栏')

// ---------- 5) 生图/生视频原有登记不能回退 ----------
const mediaStart = src.indexOf('beginMediaActivity(pendingSessionKey, task.id, kind)')
assert.ok(mediaStart > 0, '生图/生视频的 mediaActivity 登记丢失')
const mediaEnd = src.indexOf('async function persistImageAttachments', mediaStart)
assert.ok(/scheduleSessionListRender\(\)/.test(src.slice(mediaStart, mediaEnd)), '生图/生视频结束时也要刷新侧栏')

// ---------- 6) switchSession 覆盖 sessionLoadingPath 不再影响判定 ----------
assert.ok(/state\.sessionLoadingPath = target/.test(src), 'switchSession 仍会覆盖 sessionLoadingPath（因此 isSessionRunning 不能依赖它）')

console.log('OK 侧栏运行中动画检查通过')
