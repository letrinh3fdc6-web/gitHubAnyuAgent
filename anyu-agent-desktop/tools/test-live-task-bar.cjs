const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// 报告阶段"没有任何加载动作"的修复：
//   1) 业务卡片的 spinner 在对话流顶部，正文一长就滚出视口 → 输入区上方必须有一条常驻进度条；
//   2) 进度条要同时给出阶段、进度文案和已用时（十几分钟的任务不能显示 "600 秒"）；
//   3) 进度回调每秒好几次，不能每次都 await 整条时间线落盘，否则界面被拖成卡死。
const src = fs.readFileSync('renderer/app.js', 'utf8')

// ---------- 1) 抽出渲染层真实实现跑一遍 ----------
const bodyStart = src.indexOf('const MEDIA_PHASE_LABELS = {')
const bodyEnd = src.indexOf('let liveTaskTicker = null', bodyStart)
assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, 'liveTaskState / liveTaskBarMarkup 源码片段未找到')
const body = src.slice(bodyStart, bodyEnd)

const code = `
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  const formatElapsed = (milliseconds) => {
    const total = Math.max(0, Math.round(Number(milliseconds || 0) / 1000))
    if (total < 60) return total + ' 秒'
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return minutes + ' 分 ' + String(seconds).padStart(2, '0') + ' 秒'
  }
  function timestampValue(value) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number
    const parsed = Date.parse(String(value || ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  const state = { messages: [] }
  ${body}
  this.setMessages = (messages) => { state.messages = messages }
  this.liveTaskState = liveTaskState
  this.liveTaskBarMarkup = liveTaskBarMarkup
`
const context = { console }
vm.runInNewContext(code, context)

// 1a) 报告阶段：必须有 spinner + 标题 + 阶段 + 心跳文案 + 已用时
const now = Date.now()
context.setMessages([
  { id: 'u1', role: 'user', content: '@评价分析 https://detail.tmall.com/x' },
  {
    id: 'u1:result', role: 'assistant', businessSkill: 'feedback', businessPending: true,
    businessPhase: '生成报告', businessStatus: 'ANALYZING',
    businessProgress: '正在撰写完整可视化报告…（已输出 8600 字，数据量大时需要几分钟，请勿关闭会话）',
    content: '第一段分析正文……', startedAt: now - 8 * 60 * 1000 - 5000
  }
])
const task = context.liveTaskState()
assert.ok(task, '报告阶段必须识别出进行中的任务')
assert.equal(task.title, '评价分析')
assert.equal(task.phase, '生成报告')
const html = context.liveTaskBarMarkup(task)
assert.ok(html.includes('class="live-task-bar"'), '缺少常驻进度条容器')
assert.ok(html.includes('class="spinner"'), '进度条必须有 spinner（否则用户看不到任何动画）')
assert.ok(html.includes('评价分析') && html.includes('生成报告'), '进度条要显示技能名与阶段')
assert.ok(html.includes('已输出 8600 字'), '进度条要显示报告撰写心跳')
assert.ok(/8 分 0\d 秒/.test(html), `已用时应按"分/秒"展示，实际：${html}`)

// 1b) 空闲时不渲染进度条
context.setMessages([{ id: 'u1', role: 'user', content: '你好' }])
assert.equal(context.liveTaskState(), null, '无进行中任务时不应显示进度条')
assert.equal(context.liveTaskBarMarkup(null), '')

// 1c) 任务完成后进度条消失
context.setMessages([{
  id: 'u1:result', role: 'assistant', businessSkill: 'feedback', businessPending: false,
  businessPhase: '已完成', businessStatus: 'OK', businessProgress: '报告已生成，已打开右侧预览。'
}])
assert.equal(context.liveTaskState(), null, '任务完成后进度条必须消失')

// 1d) 媒体生成也走同一条进度条
context.setMessages([{ id: 'm1', role: 'assistant', mediaPending: true, mediaPhase: 'generating', startedAt: now - 3000 }])
const mediaTask = context.liveTaskState()
assert.ok(mediaTask, '媒体生成也应出现在常驻进度条')
assert.equal(mediaTask.title, '媒体生成')
assert.equal(mediaTask.phase, '生成中')
assert.ok(context.liveTaskBarMarkup(mediaTask).includes('class="spinner"'))

// ---------- 2) 进度条必须挂在界面上 ----------
assert.ok(/<div id="live-task-slot" data-task-signature="">\$\{liveTaskBarMarkup\(liveTaskState\(\)\)\}<\/div>/.test(src), 'renderApp 必须渲染 #live-task-slot')
assert.ok(/function updateLiveTaskBar\(\)/.test(src), '缺少 updateLiveTaskBar')
const updateLiveUiStart = src.indexOf('function updateLiveUi(forceScroll = false)')
const updateLiveUiBody = src.slice(updateLiveUiStart, src.indexOf('function scheduleLiveUi(', updateLiveUiStart))
assert.ok(updateLiveUiBody.includes('updateLiveTaskBar()'), 'updateLiveUi 必须增量刷新常驻进度条')
assert.ok(/liveTask \? `\$\{liveTask\.title\} · \$\{liveTask\.phase\}`/.test(updateLiveUiBody), '#busy 也要同步显示业务任务阶段')

// 只在标题/阶段/文案变化时重建，计秒走单独更新，避免每秒重建打断 spinner
const barFn = src.slice(src.indexOf('function updateLiveTaskBar()'), src.indexOf('function replaceMessageNode('))
assert.ok(/slot\.dataset\.taskSignature !== signature/.test(barFn), '进度条应按签名重建，不能每帧重建')
assert.ok(/liveTaskTicker === null/.test(barFn) && /clearInterval\(liveTaskTicker\)/.test(barFn), '进行中要有秒级心跳，结束后必须清掉定时器')

// ---------- 3) 进度回调不能每次都全量落盘 ----------
const progressStart = src.indexOf('const stopProgress = window.anyu.onLetaAgentFeedbackAnalysisProgress?.(')
assert.ok(progressStart >= 0, '反馈分析进度回调未找到')
const progressBody = src.slice(progressStart, src.indexOf('try {\n      const analysis = await window.anyu.letaAgentFeedbackAnalysisStarted', progressStart))
assert.ok(!/await persistBusinessMessage\(sessionPath, message\)/.test(progressBody), '进度回调不得逐个 await 全量落盘（会把界面拖卡）')
assert.ok(!/void persistBusinessMessage\(sessionPath, message\)/.test(progressBody), '进度回调不得每次都触发全量落盘')
assert.ok(/scheduleMediaTimelinePersist\(sessionPath\)/.test(progressBody), '进度回调应改为节流补写')
assert.ok(/updateBusinessMessage\(sessionPath, message\)/.test(progressBody), '内存消息仍需立刻更新，界面才有动画')
assert.ok(/scheduleLiveUi\(false\)/.test(progressBody), '进度回调必须触发界面刷新')

const persistStart = src.indexOf('const mediaPersistQueue = new Map()')
assert.ok(persistStart >= 0, '缺少 scheduleMediaTimelinePersist')
const persistBody = src.slice(persistStart, src.indexOf('async function pollMediaTask(', persistStart))
assert.ok(/waitMs = 3000/.test(persistBody), '节流窗口默认应为 3 秒')
assert.ok(/existing\.dirty = true/.test(persistBody), '节流期间的新进度必须标记 dirty')
assert.ok(/if \(entry\.dirty\) \{ entry\.dirty = false; entry\.timer = window\.setTimeout\(flush, waitMs\) \}/.test(persistBody), '节流结束必须尾部补写，保证最终状态落盘')

// ---------- 4) 样式存在 ----------
const css = fs.readFileSync('renderer/styles.css', 'utf8')
assert.ok(/\.live-task-bar \{[^}]*display: flex/.test(css), '缺少 .live-task-bar 样式')
assert.ok(/\.live-task-bar \.spinner \{[^}]*width: 12px/.test(css), '进度条 spinner 需要独立尺寸')
assert.ok(/\.live-task-bar \.live-task-progress \{[^}]*text-overflow: ellipsis/.test(css), '长进度文案需要省略号，不能撑破布局')
assert.ok(/@keyframes spin \{ to \{ transform: rotate\(360deg\); \} \}/.test(css), 'spinner 动画关键帧缺失')

console.log('OK 常驻任务进度条检查通过')
