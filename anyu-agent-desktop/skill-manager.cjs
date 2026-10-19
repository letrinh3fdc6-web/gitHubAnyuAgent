const fs = require('node:fs')
const path = require('node:path')

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i

function readSkillMarkdown(root, folder) {
  const file = path.join(root, folder, 'SKILL.md')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  const meta = {}
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
      if (!match) continue
      meta[match[1]] = match[2].replace(/^["']|["']$/g, '').trim()
    }
  }
  const name = String(meta.name || folder).toLowerCase()
  const description = String(meta.description || '').replace(/\s+/g, ' ').trim()
  return {
    id: folder,
    name,
    description,
    path: path.join(root, folder),
    installedAt: fs.statSync(file).mtime.toISOString(),
    content: text,
  }
}

class SkillManager {
  constructor(userDataDir) {
    if (!userDataDir) throw new Error('SkillManager requires userDataDir')
    this.root = path.join(userDataDir, 'skills')
    fs.mkdirSync(this.root, { recursive: true })
  }

  ensureBundled(sourceRoot) {
    if (!sourceRoot || !fs.existsSync(sourceRoot)) return
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SKILL_ID.test(entry.name)) continue
      const target = path.join(this.root, entry.name)
      if (!fs.existsSync(path.join(target, 'SKILL.md'))) {
        fs.cpSync(path.join(sourceRoot, entry.name), target, { recursive: true })
      }
    }
  }

  list() {
    const skills = []
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SKILL_ID.test(entry.name)) continue
      const skill = readSkillMarkdown(this.root, entry.name)
      if (!skill) continue
      skills.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        installedAt: skill.installedAt,
      })
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  read(id) {
    const safe = String(id || '').trim()
    if (!SKILL_ID.test(safe)) throw new Error('技能标识无效')
    const skill = readSkillMarkdown(this.root, safe)
    if (!skill) throw new Error('技能未安装')
    return skill
  }

  install(sourcePath) {
    const source = String(sourcePath || '').trim()
    if (!source || !fs.existsSync(source)) throw new Error('技能目录不存在')
    const stat = fs.statSync(source)
    const folder = path.basename(stat.isDirectory() ? source : path.dirname(source))
    if (!SKILL_ID.test(folder)) throw new Error('技能目录名必须为字母、数字或短横线')
    if (!fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error('技能缺少 SKILL.md')
    const target = path.join(this.root, folder)
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(source, target, { recursive: true })
    return this.read(folder)
  }
}

module.exports = { SkillManager }
