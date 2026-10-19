const fs = require('fs')
const vm = require('vm')
const assert = require('assert')

const renderer = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8')
const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8')

function sourceSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert(start >= 0 && end > start, `找不到源码片段：${startMarker}`)
  return source.slice(start, end)
}

const ui = {
  state: { messages: [], user: { email: 'test@example.com' }, runStartedAt: 0 },
  esc: (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  initials: () => 'T',
  formatTimestamp: () => '',
  formatDuration: () => '',
  hasRenderableMessageContent: (message) => Boolean(message.content || message.mediaPlanSteps?.length),
  renderMessageContent: (value) => String(value || ''),
  mediaSourceUrl: () => '',
  attachmentMarkup: () => '',
  messageKey: () => 'message-1',
  businessRenderSignature: () => ''
}
vm.runInNewContext(`${sourceSlice(renderer, '  function messageHtml(message, options = {}) {', '  function permissionHtml() {')}; this.messageHtml = messageHtml`, ui)

const pending = ui.messageHtml({
  id: 'plan-1', role: 'assistant', content: '已理解：湖边风景', mediaPending: true, mediaPhase: 'planning',
  mediaPlanSteps: ['识别主体与核心需求', '整理场景、构图和视觉风格'], mediaPlanCompleted: 1,
  mediaPlanSummary: '清晨湖边的宁静风景', mediaPlanSource: 'ai'
})
assert(pending.includes('AI 规划') && pending.includes('分析需求'), '规划中卡片应显示 AI 来源和阶段')
assert(pending.includes('识别主体与核心需求') && pending.includes('清晨湖边的宁静风景'), '规划卡片应显示步骤和摘要')
assert(pending.includes('media-plan-step done') && pending.includes('media-plan-step active'), '规划步骤应显示完成与当前状态')

const failed = ui.messageHtml({
  id: 'plan-2', role: 'assistant', content: '生成失败', isError: true, mediaPending: false, mediaPhase: 'failed',
  mediaPlanSteps: ['识别主体与核心需求'], mediaPlanCompleted: 1, mediaPlanSource: 'local'
})
assert(failed.includes('is-error') && failed.includes('未完成'), '失败卡片应显示失败状态')
assert(failed.includes('规则整理'), '本地规划回退应显示正确来源')

const persistence = {}
vm.runInNewContext(`${sourceSlice(main, 'function mediaRecordSources(item) {', 'async function savePiMediaMessages(payload = {}) {')}; this.mediaMessageRecord = mediaMessageRecord`, persistence)
const restored = persistence.mediaMessageRecord({
  id: 'plan-3', role: 'assistant', content: '已理解', mediaPhase: 'completed', mediaPlanSteps: ['步骤一'],
  mediaPlanCompleted: 1, mediaPlanSummary: '摘要', mediaPlanSource: 'ai', mediaPlanText: '已理解：摘要'
})
for (const field of ['mediaPhase', 'mediaPlanSteps', 'mediaPlanCompleted', 'mediaPlanSummary', 'mediaPlanSource', 'mediaPlanText']) {
  assert.deepStrictEqual(restored[field], ({
    mediaPhase: 'completed', mediaPlanSteps: ['步骤一'], mediaPlanCompleted: 1,
    mediaPlanSummary: '摘要', mediaPlanSource: 'ai', mediaPlanText: '已理解：摘要'
  })[field], `媒体记录必须持久化 ${field}`)
}
const remoteImage = persistence.mediaMessageRecord({
  id: 'image-remote', role: 'assistant', content: '已生成图片',
  attachments: [{ id: 'generated-1', kind: 'image', name: '结果.png', mimeType: 'image/png', dataUrl: 'https://cdn.example.test/result.png', downloadTaskId: 'task-1', downloadIndex: 0 }]
})
assert.equal(remoteImage.attachments[0].data, '', '远程图片结果不应被误当成空 base64')
assert.equal(remoteImage.attachments[0].dataUrl, 'https://cdn.example.test/result.png', '远程图片地址必须可持久化恢复')

console.log('image planning card display and persistence: passed')
