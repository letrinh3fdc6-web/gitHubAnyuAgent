// 诊断：读取媒体时间线，输出 feedback 消息在各时刻的业务状态（只读）
const fs = require('fs')
const path = require('path')
const file = process.argv[2]
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
const list = Array.isArray(data) ? data : data.messages || []
console.log('total messages:', list.length)
for (const m of list) {
  if (!m || (!m.businessSkill && !m.businessPending)) continue
  console.log(JSON.stringify({
    id: String(m.id || '').slice(0, 24),
    skill: m.businessSkill,
    pending: m.businessPending,
    phase: m.businessPhase,
    status: m.businessStatus,
    progress: m.businessProgress ? String(m.businessProgress).slice(0, 80) : '',
    contentTail: m.content ? String(m.content).slice(-60).replace(/\s+/g, ' ') : '',
    artifacts: (m.artifacts || []).map((a) => a.name || a.path),
    isError: m.isError,
    createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : ''
  }))
}
