'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

function normalizeReferences(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('每条消息最多引用 20 个文件或文件夹')
  const seen = new Set()
  return value.map(item => {
    if (!item || !['file', 'folder'].includes(item.kind) || typeof item.path !== 'string' || !path.isAbsolute(item.path) || /[\0\r\n]/.test(item.path) || item.path.length > 4096) throw new Error('参考文件路径无效')
    const file = path.normalize(item.path)
    return { path: file, kind: item.kind, name: path.basename(file) || file }
  }).filter(item => {
    const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}

async function validateReferences(value) {
  const references = normalizeReferences(value)
  for (const item of references) {
    let stat
    try { stat = await fs.stat(item.path) } catch { throw new Error(`参考路径不存在或无法访问：${item.name}`) }
    if (item.kind === 'folder' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`参考路径类型已改变：${item.name}`)
  }
  return references
}

function referencedSkills(message, skills) {
  const mentions = new Set([...message.matchAll(/(?:^|\s)@([\p{L}\p{N}_-]+)(?=$|[^\p{L}\p{N}_-])/gu)].map(match => match[1].toLowerCase()))
  return skills.filter(skill => mentions.has(String(skill.id).toLowerCase()))
}

function referencePrompt(message, references, skills) {
  const sections = [message]
  if (skills.length) sections.push(`[用户指定的技能]\n${skills.map(skill => `- @${skill.id}: ${JSON.stringify(path.join(skill.path, 'SKILL.md'))}`).join('\n')}\n先读取指定的 SKILL.md，按技能规则执行；若技能目录或上级技能目录有 ANYU_TRAINING.md，一并遵循其中的自定义规则。`)
  if (references.length) sections.push(`[用户附加的本地文件与文件夹]\n${references.map(item => `- ${item.kind === 'folder' ? '[文件夹]' : '[文件]'} ${JSON.stringify(item.path)}`).join('\n')}\n请按需使用现有工具读取这些路径，遵循当前会话的权限与审批。`)
  return sections.filter(Boolean).join('\n\n')
}

module.exports = { normalizeReferences, validateReferences, referencedSkills, referencePrompt }
