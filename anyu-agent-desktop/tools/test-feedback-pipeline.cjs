const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { LocalFeedback } = require('../local-feedback.cjs')

// 从已保存采集任务验证自然分析、报告格式兜底和恢复，不再次访问商品页面。
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leta-feedback-pipeline-'))
  const id = crypto.randomUUID()
  const task = { taskId: id, status: 'OK', url: 'https://detail.tmall.com/item.htm?id=42', createdAt: '2026-09-29T00:00:00Z', result: { reviews: [{ content: '包装完整，质量不错' }], questions: [], analysis: '旧 Markdown 不作为新版结果' } }
  const summary = '本次采集 1 条评价、0 条问答。\n\n' + '评价证据支持包装与质量体验。'.repeat(160)
  const report = fs.readFileSync(path.join(__dirname, 'fixtures', 'feedback-report.html'), 'utf8')
  const installedPath = path.join(directory, 'plugin')
  const plugin = () => ({ installedPath })
  const progress = []
  const calls = []
  try {
    fs.cpSync(path.resolve(__dirname, '..', 'skills', 'tmall-public-feedback-analysis'), path.join(installedPath, 'skills', 'tmall-public-feedback-analysis'), { recursive: true })
    fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(task))
    const runtime = new LocalFeedback({ directory, plugin, analyze: async (prompt, _, onProgress) => {
      calls.push(prompt)
      if (calls.length === 1) { onProgress(summary.slice(0, 15)); onProgress(summary); return summary }
      return '# 报告格式不完整'
    } })
    const fallback = await runtime.analysis(id, '', (event) => progress.push(event))
    assert.equal(calls.length, 2)
    assert.match(calls[0], /像正常对话一样/)
    assert.match(calls[1], /已展示给用户的分析正文/)
    assert(progress.some((event) => event.stage === 'analysis' && event.text.length > 1800))
    assert.equal(progress.at(-1).stage, 'report')
    const saved = JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8'))
    assert.equal(saved.result.analysisSummary, summary)
    assert.equal(saved.url, task.url)
    assert.equal(saved.createdAt, task.createdAt)
    assert.equal(fallback.analysisCompatibilityFallback, true)
    assert.match(fallback.analysisHtml, /研究限制/)
    const restored = new LocalFeedback({ directory, plugin, analyze: async (prompt) => { calls.push(prompt); return report } })
    const result = await restored.analysis(id, '', (event) => progress.push(event))
    assert.equal(calls.length, 2, '格式兜底后不应再次执行分析或采集')
    assert.match(result.analysisHtml, /<!doctype html>/i)
    assert.equal(result.analysisSummary, summary)
    await restored.analysis(id, '', (event) => progress.push(event))
    assert.equal(calls.length, 2, '完成的报告直接复用')
    assert.match(progress.at(-1).text, /报告已生成/)
    console.log('feedback pipeline: natural stream, retained analysis, report-only retry, cache and task metadata passed')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
