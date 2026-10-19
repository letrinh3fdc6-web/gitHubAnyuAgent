// 渲染诊断：把 renderer 里的业务卡片模板（businessMarkup 构造段）原样执行，看元素顺序
const fs = require('fs')
const vm = require('node:vm')
const src = fs.readFileSync('renderer/app.js', 'utf8')

const bodyStart = src.indexOf('const businessResult = message.businessResult || {}')
const bodyEnd = src.indexOf('const hasText =', bodyStart)
if (bodyStart < 0 || bodyEnd < 0) throw new Error('body slice fail')
const body = src.slice(bodyStart, bodyEnd)

const code = `
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
  const initials = (email) => String(email || 'A').slice(0, 1).toUpperCase()
  // 与真实实现同位置同 class 的忠实桩
  const businessArtifactsMarkup = (files = []) => files.length ? '<div class="business-artifacts">' + files.map((f) => '<div class="artifact-row">' + esc(f.name || f.path || '') + '</div>').join('') + '</div>' : ''
  const businessAssetMarkup = (assets = []) => ''
  const businessRenderSignature = (message) => 'sig'
  const formatTimestamp = (value) => 'HH:MM'
  this.renderBusinessMessage = function(message) {
    ${body}
    return businessMarkup
  }
`
const context = { console }
vm.runInNewContext(code, context)

const midStage2 = {
  id: 'task-1:result', role: 'assistant', businessSkill: 'feedback',
  businessPending: true, businessPhase: '生成报告', businessStatus: 'ANALYZING',
  businessProgress: '正在撰写完整可视化报告…（已输出 8600 字，数据量大时需要几分钟，请勿关闭会话）',
  businessResult: { reviewCount: 344, questionCount: 71 },
  artifacts: [
    { name: 'tmall-feedback.json', path: 'tmall-feedback.json' },
    { name: 'tmall-feedback.csv', path: 'tmall-feedback.csv' }
  ],
  content: '（第一段分析的长文本……）完整可视化报告即将打开。',
  createdAt: Date.now()
}
const html = context.renderBusinessMessage(midStage2)
const order = []
for (const m of html.matchAll(/class="(business-skill-head|business-progress|business-summary|business-artifacts|artifact-row|spinner)"/g)) order.push(m[1])
console.log('卡片内元素顺序:', order.join(' → '))
console.log('含 spinner:', html.includes('class="spinner"'))
console.log('含心跳文案:', html.includes('已输出 8600 字'))
console.log('--- 卡片 HTML ---')
console.log(html)
