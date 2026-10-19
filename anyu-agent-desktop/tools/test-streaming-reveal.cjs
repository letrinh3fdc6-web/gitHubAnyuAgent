const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const renderer = path.join(__dirname, '..', 'renderer')
const source = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8')
const styles = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8')

function slice(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert(from >= 0 && to > from, `找不到源码片段：${start}`)
  return source.slice(from, to)
}

// 使用真实事件处理代码验证等待、增量和结束阶段。
const context = {
  state: { messages: [], loading: true, streamingMessage: null, sessionSwitching: false },
  Date, console,
  timestampValue: (value) => Number(value) || 0,
  thinkingOf: (parts) => (parts || []).filter((part) => part.type === 'thinking').map((part) => part.thinking).join(''),
  textOf: (parts) => Array.isArray(parts) ? parts.filter((part) => part.type === 'text').map((part) => part.text).join('') : String(parts || ''),
  scheduleLiveUi: () => { context.updates += 1 },
  startRunMonitor: () => {},
  finishAgentRun: () => {},
  inspectMessageArtifacts: async () => [],
  scheduleAppRender: () => {},
  refreshSessions: async () => {},
  localStorage: { setItem: () => {} },
  THINKING_LEVELS: [],
  window: { anyu: {} },
  scheduleSessionListRender: () => {},
  updates: 0
}
// 事件处理会按 sessionKey 分流前台/后台会话，这里一并提供会话状态的纯函数。
vm.runInNewContext(`${slice('  function orderTimeline(messages) {', '  function sameTimelineMessage(')}\n${slice('  function insertTimelineMessage(message) {', '  function upsertTimelineMessage(')}\n${slice('  function finishStreamingMessage(message) {', '  function scheduleAppRender(')}\n${slice('  function normalizeSessionKey(', '  function renderSessionList(')}\n${slice('  function handlePiEvent(event) {', '  window.anyu.onPiEvent(handlePiEvent)')} this.handle = handlePiEvent`, context)
context.handle({ type: 'message_start', message: { role: 'assistant', content: [] } })
const message = context.state.streamingMessage
assert(message?.isStreaming && context.state.messages.length === 1)
assert.strictEqual(message, context.state.messages[0], '流式指针与时间线必须引用同一个对象')
context.handle({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '检查中' } })
context.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } })
context.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '，世界' } })
assert.strictEqual(message.content, '你好，世界', '文本应立即按事件合并，不等待动画队列')
assert.strictEqual(message.thinking, '检查中')
context.handle({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好，世界！' }] } })
assert.strictEqual(message.content, '你好，世界！')
assert.strictEqual(message.isStreaming, false)
assert.strictEqual(context.state.streamingMessage, null, '结束后必须清除当前流式指针')
assert.strictEqual(context.state.messages.length, 1, '同一回复不得生成重复消息')
assert.strictEqual(context.state.messages[0].content, '你好，世界！', '最终文本必须到达实际时间线')
context.handle({ type: 'tool_execution_start', toolCallId: 'tool-one', toolName: 'read', args: { path: 'package.json' } })
context.handle({ type: 'tool_execution_start', toolCallId: 'tool-one', toolName: 'read', args: { path: 'package.json' } })
assert.strictEqual(context.state.messages.filter((item) => item.role === 'tool').length, 1, '重复 tool start 必须按 toolCallId 幂等合并')
context.handle({ type: 'tool_execution_end', toolCallId: 'tool-one', toolName: 'read', result: { output: '已读取' } })
assert.strictEqual(context.state.messages.find((item) => item.toolCallId === 'tool-one').isStreaming, false, '工具结束必须更新原活动行')
context.handle({ type: 'tool_execution_start', toolCallId: 'tool-one', toolName: 'read' })
assert.strictEqual(context.state.messages.find((item) => item.toolCallId === 'tool-one').isStreaming, false, '迟到的重复 start 不能重新打开已完成工具')
assert.strictEqual(context.state.messages.filter((item) => item.toolCallId === 'tool-one').length, 1, '迟到的重复 start 不能新建工具行')

const esc = source.match(/^\s*const esc = .*$/m)?.[0]
assert(esc)
const markupContext = {
  state: { messages: [], loading: true, streamingMessage: null, runStartedAt: 0, user: { email: 'test@example.com' } },
  Date,
  initials: () => 'T',
  timestampValue: (value) => Number(value) || 0,
  formatTimestamp: () => '',
  formatDuration: () => '1 秒',
  formatBytes: () => '1 KB',
  renderMessageContent: (value) => value,
  mediaSourceUrl: () => '',
  attachmentMarkup: () => '',
  businessAssetMarkup: () => '',
  businessArtifactsMarkup: () => '',
  messageKey: () => 'message-1'
}
vm.runInNewContext(`${esc}\n${slice('  function orderTimeline(messages) {', '  function sameTimelineMessage(')}\n${slice('  function hasRenderableMessageContent(message) {', '  // 只替换结构变化的消息')}\n${slice('  function artifactCardsMarkup(artifacts = []) {', '  function permissionHtml() {')}\nthis.html = messageHtml; this.timeline = messagesMarkup`, markupContext)
const user = { id: 'user-1', role: 'user', content: '请检查项目', createdAt: 1 }
const waiting = { id: 'assistant-1', role: 'assistant', content: '', isStreaming: true, createdAt: 2 }
markupContext.state.messages.push(user, waiting)
assert.match(markupContext.timeline(), /turn-status/)
assert.doesNotMatch(markupContext.timeline(), /agent-activity/, '等待阶段不能同时显示两处状态')
waiting.thinking = '检查项目'
assert.match(markupContext.timeline(), /thinking-card/)
assert.strictEqual((markupContext.timeline().match(/class="turn-status"/g) || []).length, 1, '思考详情不能再增加等待提示')
markupContext.state.messages.push({ id: 'tool-1', role: 'tool', toolCallId: 'tool-1', toolName: 'read', content: '', args: { path: 'package.json' }, isStreaming: true, createdAt: 3 })
assert.strictEqual((markupContext.timeline().match(/assistant-turn/g) || []).length, 1, '同一轮的工具必须收纳到唯一 assistant 回复')
assert.match(markupContext.timeline(), /turn-activity/)
waiting.content = '你好'
assert.match(markupContext.timeline(), /streaming-bubble/)
assert.doesNotMatch(markupContext.timeline(), /turn-status|reply-char/)
waiting.content = ''; waiting.isStreaming = false; markupContext.state.loading = false
assert.doesNotMatch(markupContext.timeline(), /turn-status|agent-activity/, '任务结束后不得残留等待状态')
markupContext.state.messages = [user, { role: 'assistant', content: '模型超时', isError: true, createdAt: 2 }, { role: 'assistant', content: '最终成功', createdAt: 3 }, ...Array.from({ length: 10 }, (_, index) => ({ role: 'tool', toolCallId: `call-${index}`, toolName: 'read', content: 'ok', createdAt: index + 4 }))]
const retried = markupContext.timeline()
assert.strictEqual((retried.match(/class="message assistant-turn/g) || []).length, 1, '重试与十次工具必须收纳在同一回复')
assert.strictEqual((retried.match(/class="turn-activity /g) || []).length, 11, '工具和失败尝试都必须是紧凑活动')
assert.match(retried, /重试 · 1 次失败尝试/)
assert.match(retried, /最终成功/)
assert.doesNotMatch(retried, /模型超时<\/div>/, '失败尝试不得污染最终正文')
markupContext.state.messages = [user, { role: 'tool', toolCallId: 'only', toolName: 'read', content: 'ok', createdAt: 2 }]
assert.strictEqual((markupContext.timeline().match(/assistant-turn/g) || []).length, 1, '无正文工具回合也要保持一条回复')
const historical = [{ role: 'user', content: '你好', createdAt: 100 }, { role: 'assistant', content: '好', createdAt: 110 }]
markupContext.state.messages = historical
const firstKeys = [...markupContext.timeline().matchAll(/data-message-key="([^"]+)"/g)].map((match) => match[1])
markupContext.state.messages = historical.map((message) => ({ ...message }))
const restoredKeys = [...markupContext.timeline().matchAll(/data-message-key="([^"]+)"/g)].map((match) => match[1])
assert.deepStrictEqual(restoredKeys, firstKeys, '无 ID 历史消息刷新后 Turn 身份必须稳定')
assert.doesNotMatch(styles, /reply-char-reveal|stream-caret/, '不再进行逐字淡入和闪烁光标')
assert.match(source, /bubble\.append\(document\.createTextNode\(rawContent\.slice/)
assert.doesNotMatch(slice('  function updateLiveUi(', '  function scheduleLiveUi('), /box\.innerHTML = messagesMarkup\(\); bindMessageEvents/)
console.log('streaming lifecycle and stable markup: passed')
