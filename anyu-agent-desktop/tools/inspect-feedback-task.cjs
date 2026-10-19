// 诊断：读取本机反馈任务文件，输出分析各阶段落盘状态（只读，不改任何数据）
const fs = require('fs')
const path = require('path')
const dir = process.argv[2]
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({
  f, stat: fs.statSync(path.join(dir, f))
})).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 6)
for (const { f, stat } of files) {
  let t
  try { t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch (e) { console.log(f, 'PARSE FAIL', e.message); continue }
  const r = t.result || {}
  console.log(JSON.stringify({
    file: f.slice(0, 8),
    createdAt: t.createdAt,
    savedAt: stat.mtime.toISOString(),
    status: t.status,
    reviews: (r.reviews || []).length,
    questions: (r.questions || []).length,
    hasSummary: !!r.analysisSummary,
    summaryLen: r.analysisSummary ? r.analysisSummary.length : 0,
    hasHtml: !!r.analysisHtml,
    htmlLen: r.analysisHtml ? r.analysisHtml.length : 0,
    fallback: !!r.analysisCompatibilityFallback
  }))
}
