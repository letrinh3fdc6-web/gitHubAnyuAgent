// 离屏执行真实的消息增量渲染，检查工具插入前后正文节点与展开状态不变。
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { app, BrowserWindow } = require('electron')

const renderer = path.join(__dirname, '..', 'renderer')
const source = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8')
const style = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8')
const output = path.join(__dirname, '.preview')

function slice(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert(from >= 0 && to > from, `找不到源码片段：${start}`)
  return source.slice(from, to)
}

const esc = source.match(/^\s*const esc = .*$/m)?.[0]
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}
body { display: block; padding: 24px; } .messages { height: 440px; width: 100%; }
</style><div id="messages" class="messages"></div><script>
const state = { messages: [], loading: true, streamingMessage: null, runStartedAt: 0, queuedTasks: [], attachments: [], user: { email: 'test' } }
${esc}
${slice('  function renderInlineMessageContent(value) {', '  const formatDuration = ')}
const initials = () => 'T'; const formatTimestamp = () => ''; const formatDuration = () => '1 秒'; const formatBytes = () => '1 KB'
const attachmentMarkup = () => ''; const mediaSourceUrl = () => ''; const businessAssetMarkup = () => ''; const businessArtifactsMarkup = () => ''
const mediaActivityForSession = () => []; const bindMessageEvents = () => {}
const inspectMessageArtifacts = async () => []; const effectiveWorkspace = () => ''
const timestampValue = (value) => Number(value) || 0
const thinkingOf = (parts) => (parts || []).filter((part) => part.type === 'thinking').map((part) => part.thinking).join('')
const textOf = (parts) => (parts || []).filter((part) => part.type === 'text').map((part) => part.text).join('')
const THINKING_LEVELS = []
${slice('  function orderTimeline(messages) {', '  function sameTimelineMessage(')}
${slice('  function insertTimelineMessage(message) {', '  function upsertTimelineMessage(')}
${slice('  function hasRenderableMessageContent(message) {', '  function scheduleLiveUi(')}
const scheduleLiveUi = () => updateLiveUi(false)
${slice('  function finishStreamingMessage(message) {', '  function scheduleAppRender(')}
${slice('  function artifactCardsMarkup(artifacts = []) {', '  function permissionHtml() {')}
${slice('  function handlePiEvent(event) {', '  window.anyu.onPiEvent(handlePiEvent)')}
window.showWaiting = () => {
  const box = document.querySelector('#messages')
  state.messages = [{ role: 'user', content: '检查项目并整理结果' }]
  handlePiEvent({ type: 'message_start', message: { role: 'assistant', content: [] } })
  box.innerHTML = messagesMarkup()
}
window.check = () => {
  window.showWaiting()
  const box = document.querySelector('#messages')
  const waiting = box.querySelectorAll('.turn-status').length
  handlePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '核对项目脚本与入口。' } })
  box.querySelector('.thinking-card').open = true
  handlePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '已检查项目。' } })
  const bubble = box.querySelector('.streaming-bubble')
  handlePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '\\n正在整理验证结果。' } })
  const stableDelta = bubble === box.querySelector('.streaming-bubble')
  handlePiEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '已检查项目。\\n正在整理验证结果。' }] } })
  const thinkingKept = box.querySelector('.thinking-card').open
  const tool = { role: 'tool', toolName: 'read', toolCallId: 'one', args: { path: 'package.json' }, content: '', isStreaming: true }
  state.messages.push(tool)
  updateLiveUi(false)
  const settledBubble = box.querySelector('.message-bubble[data-raw^="已检查"]')
  const card = box.querySelector('.turn-activity')
  card.open = true
  box.querySelector('.tool-args').open = true
  tool.content = '项目脚本已确认'
  updateLiveUi(false)
  const argsKept = box.querySelector('.tool-args').open
  const newOutputCollapsed = !box.querySelector('.tool-output').open
  box.querySelector('.tool-output').open = true
  tool.isStreaming = false
  updateLiveUi(false)
  const stableToolInsert = settledBubble === box.querySelector('.message-bubble[data-raw^="已检查"]')
  const detailsKept = box.querySelector('.turn-activity').open
  const nestedDetailsKept = box.querySelector('.tool-args').open && box.querySelector('.tool-output').open
  const toolSettled = box.querySelector('.tool-status').textContent === '已完成' && !box.querySelector('.tool-progress')
  state.messages.splice(1, 0, { role: 'tool', toolName: 'search', content: '找到相关文件', isStreaming: false })
  updateLiveUi(false)
  const stableReorder = settledBubble === box.querySelector('.message-bubble[data-raw^="已检查"]')
  const detailsKeptAfterReorder = [...box.querySelectorAll('.turn-activity')].some((item) => item.open)
  const longReply = { role: 'assistant', content: '长回答\\n'.repeat(100), isStreaming: true }
  state.messages.push(longReply)
  state.streamingMessage = longReply
  updateLiveUi(false)
  box.scrollTop = 0
  longReply.content += '新的增量'
  updateLiveUi(false)
  const historyScrollKept = box.scrollTop === 0
  state.messages.pop()
  state.streamingMessage = null
  state.loading = false
  state.messages.find((message) => message.role === 'assistant').discoveredArtifacts = [{ path: 'reports/project-verification-result.html', name: 'project-verification-result.html', extension: '.html', lineCount: 304, size: 18742, previewable: true }]
  updateLiveUi(false)
  return { waiting, stableDelta, stableToolInsert, stableReorder, historyScrollKept, detailsKept, detailsKeptAfterReorder, thinkingKept, argsKept, newOutputCollapsed, nestedDetailsKept, toolSettled, duplicate: box.querySelectorAll('.agent-activity, .turn-status').length, text: settledBubble.textContent }
}
</script></html>`

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true })
  const file = path.join(output, '_harness-stream.html')
  fs.writeFileSync(file, html)
  const win = new BrowserWindow({ width: 880, height: 600, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } })
  await win.loadFile(file)
  await win.webContents.executeJavaScript('window.showWaiting()')
  await new Promise((resolve) => setTimeout(resolve, 100))
  fs.writeFileSync(path.join(output, 'stream-waiting-desktop.png'), (await win.webContents.capturePage()).toPNG())
  const result = await win.webContents.executeJavaScript('window.check()')
  console.log(JSON.stringify(result))
  assert.strictEqual(result.waiting, 1)
  assert(result.stableDelta && result.stableToolInsert && result.stableReorder && result.historyScrollKept && result.detailsKept && result.detailsKeptAfterReorder && result.toolSettled)
  assert(result.thinkingKept && result.argsKept && result.newOutputCollapsed && result.nestedDetailsKept, '详情必须按类型保留展开状态')
  assert.strictEqual(result.duplicate, 0)
  // 截图展示默认的折叠状态，展开交互已在上面独立验证。
  await win.webContents.executeJavaScript("document.querySelectorAll('details').forEach((detail) => { detail.open = false })")
  await new Promise((resolve) => setTimeout(resolve, 200))
  const shot = await win.webContents.capturePage()
  fs.writeFileSync(path.join(output, 'stream-stable-desktop.png'), shot.toPNG())
  win.setSize(420, 600)
  await new Promise((resolve) => setTimeout(resolve, 200))
  fs.writeFileSync(path.join(output, 'stream-stable-narrow.png'), (await win.webContents.capturePage()).toPNG())
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8')
  const sanitize = new Function(`${(() => { const start = mainSource.indexOf('function sanitizeArtifactHtml(source) {'); const end = mainSource.indexOf('function escapeArtifactText(', start); return mainSource.slice(start, end) })()}; return sanitizeArtifactHtml`)()
  const preview = new BrowserWindow({ width: 420, height: 320, show: false, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  const previewHtml = sanitize('<!doctype html><button id="demo">打开结果</button><script>document.querySelector("#demo").onclick = () => { document.body.dataset.working = "yes" }; fetch("https://example.com/blocked").catch(() => { document.body.dataset.blocked = "yes" })</script>')
  await preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(previewHtml)}`)
  await preview.webContents.executeJavaScript('document.querySelector("#demo").click()')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const previewState = await preview.webContents.executeJavaScript('({ working: document.body.dataset.working, blocked: document.body.dataset.blocked, mode: document.compatMode })')
  assert.deepStrictEqual(previewState, { working: 'yes', blocked: 'yes', mode: 'CSS1Compat' }, '结果页保持标准模式，页内交互可用且外部请求被 CSP 阻断')
  preview.destroy()
  console.log('真实 DOM 增量、工具插入和展开状态：通过')
  console.log(JSON.stringify(result))
  console.log(`截图目录：${output}`)
  win.destroy()
  app.quit()
}).catch((error) => { console.error(error); app.exit(1) })
