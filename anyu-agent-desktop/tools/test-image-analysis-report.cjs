const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// 从渲染层切出测图排行相关纯函数：解析模型输出、归一化打分、生成报告 HTML。
// 不启动 Electron、不调用真实模型。
const file = 'renderer/app.js'
const source = fs.readFileSync(file, 'utf8')
const start = source.indexOf('  const IMAGE_ANALYSIS_DIMENSIONS = [')
const end = source.indexOf('  function attachmentBase64Data(', start)
assert.ok(start >= 0 && end > start, '测图排行函数未找到')

const context = {
  esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
  businessSecretSafeJson: (value) => JSON.stringify(value)
}
vm.runInNewContext(`${source.slice(start, end)}; this.imageAnalysisReport = imageAnalysisReport; this.imageAnalysisHeadline = imageAnalysisHeadline; this.imageAnalysisHtml = imageAnalysisHtml; this.imageAnalysisFallbackHtml = imageAnalysisFallbackHtml; this.imageAnalysisArtifactFiles = imageAnalysisArtifactFiles`, context)
const { imageAnalysisReport, imageAnalysisHeadline, imageAnalysisHtml, imageAnalysisFallbackHtml, imageAnalysisArtifactFiles } = context

const modelOutput = `主推图偏弱，建议改用第 3 张作为主图。
首选：第 3 张（c.jpg）

\`\`\`json
{
  "ranking": [
    { "index": 1, "name": "a.jpg", "scores": { "hook": 6, "subject": 8, "selling": 6, "text": 7, "trust": 9, "scene": 7 }, "comment": "主体清晰但卖点弱", "reason": "白底图主体占比高，无文案支撑卖点", "fixes": ["加一行核心卖点文案，字号不低于画幅 5%"], "risks": [] },
    { "index": 2, "name": "<img src=x onerror=alert(1)>.jpg", "scores": { "hook": 7, "subject": 6, "selling": 7, "text": 5, "trust": 8, "scene": 6 }, "comment": "场景杂乱", "reason": "背景道具抢占主体", "fixes": ["虚化背景"], "risks": ["极限词风险"] },
    { "index": 3, "name": "c.jpg", "scores": { "hook": 9, "subject": 9, "selling": 9, "text": 8, "trust": 9, "scene": 9 }, "comment": "首屏吸引力最强", "reason": "强对比配色，卖点文案醒目", "fixes": [], "risks": [] }
  ]
}
\`\`\``

const report = imageAnalysisReport(modelOutput, 3)
assert.ok(report, '应能解析出结构化排行')
assert.equal(report.total, 3)
// 权重总分：0.25*9+0.2*9+0.2*9+0.15*8+0.1*9+0.1*9 = 8.85 -> 8.9
assert.equal(report.ranking[0].index, 3)
assert.equal(report.ranking[0].total, 8.9)
assert.equal(report.best, 3)
// 注意：函数在 vm 沙箱里构造，数组原型跨 realm，这里一律用字符串比较而不是 deepEqual。
assert.equal(report.ranking.map((row) => row.rank).join(','), '1,2,3')
// 名次严格由分数决定，与模型输出顺序无关
const order = report.ranking.map((row) => row.index).join(',')
assert.equal(order, '3,1,2', `排序应依分数降序，实际 ${order}`)

// 缺失图片补位，且不抢占已评分图片的名次
const partial = imageAnalysisReport('```json\n{"ranking":[{"index":2,"name":"b.jpg","scores":{"hook":8,"subject":8,"selling":8,"text":8,"trust":8,"scene":8}}]}\n```', 3)
assert.equal(partial.ranking.length, 3)
assert.equal(partial.ranking[0].index, 2)
assert.equal(partial.ranking[0].total, 8)
assert.equal(partial.ranking[1].total, null, '未评分图片必须排在最后')

// 总分由权重重算，模型自报的 total 不参与排序决策
const overridden = imageAnalysisReport('```json\n{"ranking":[{"index":1,"name":"x.jpg","total":10,"scores":{"hook":5,"subject":5,"selling":5,"text":5,"trust":5,"scene":5}},{"index":2,"name":"y.jpg","total":1,"scores":{"hook":9,"subject":9,"selling":9,"text":9,"trust":9,"scene":9}}]}\n```', 2)
assert.equal(overridden.ranking[0].index, 2, '自报 total 不能覆盖权重计算')

// 非法分数截断到 0-10
const clamped = imageAnalysisReport('```json\n{"ranking":[{"index":1,"scores":{"hook":99,"subject":-3}}]}\n```', 1)
assert.equal(clamped.ranking[0].scores.hook, 10)
assert.equal(clamped.ranking[0].scores.subject, 0)

// 无围栏裸 JSON 也要能解析
assert.ok(imageAnalysisReport('{"ranking":[{"index":1,"scores":{"hook":8}}]}', 1), '裸 JSON 应可解析')

// 非结构化输出降级，不抛错
assert.equal(imageAnalysisReport('这是一段普通文字，没有 JSON', 2), null)

const html = imageAnalysisHtml(report, [{ url: 'data:image/png;base64,AAA' }, { url: 'data:image/png;base64,BBB' }, { url: 'data:image/png;base64,CCC' }])
assert.match(html, /AI 测图排行/)
assert.match(html, /<table>/, '应输出排行榜表格')
assert.match(html, /逐图分析/)
// 只拦截真正可被解析成标签/协议的内容；转义后的纯文本必须原样保留展示。
assert.doesNotMatch(html, /<img\s+src=x|<script|javascript:/i, '图片名与建议必须转义，不能注入可执行内容')
assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, '模型返回的图片名应转义后原样显示')
assert.doesNotMatch(html, /white-space:pre-wrap/, '不能再把模型原文当成等宽文本直接铺出来')
assert.match(html, /c\.jpg/)

const headline = imageAnalysisHeadline(report)
assert.match(headline, /第 1 名：c\.jpg/)
assert.match(headline, /首选：c\.jpg/)

// 降级产物：仍产出两个文件且不含脚本
const fallbackFiles = imageAnalysisArtifactFiles({ report: null, text: '<script>alert(1)</script>原始输出', assets: [], imageCount: 2 })
assert.equal(fallbackFiles.length, 2)
assert.equal(fallbackFiles[0].name, 'ai-image-analysis.html')
assert.doesNotMatch(fallbackFiles[0].content, /<script>alert/i)
assert.match(fallbackFiles[0].content, /&lt;script&gt;/)

const files = imageAnalysisArtifactFiles({ report, text: modelOutput, assets: [{ url: 'data:image/png;base64,AAA' }], imageCount: 3 })
assert.equal(files.length, 2)
assert.equal(files[1].name, 'ai-image-analysis.json')
assert.equal(JSON.parse(files[1].content).report.best, 3)

console.log('image analysis: ranking parse, weighted score, ordering, missing fill, escaping and fallback passed')
