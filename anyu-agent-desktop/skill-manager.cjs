const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i
const TRAINING_FILE = 'ANYU_TRAINING.md'
const MAX_RULE_BYTES = 16000
const DEFAULT_TRAINING_RULES = `# 技能训练法则

1. 先明确目标：收集真实输入、期望结果和失败案例；信息不足时先澄清。
2. 先阅读当前 SKILL.md、关联脚本和参考资料，保留已有能力与用户偏好。
3. 将可复用的方法写成规则，将重复且需要确定执行的步骤写成脚本；只加入本次训练需要的内容。
4. SKILL.md 保留 name、description 元数据；触发条件、输入要求、执行步骤与验收标准必须清楚。
5. 修改前备份受影响文件；在当前技能目录内训练，不修改其他技能或项目。
6. 自定义规则保存在 ANYU_TRAINING.md；训练时同时遵循通用规则和当前技能规则，冲突时先与用户确认。
7. 使用代表性案例实际验证结果，检查失败、缺少输入和重复执行的情况；未执行的测试如实说明。
8. 将验证后的改进写回实际的技能文件、脚本或参考资料，并说明修改、测试结果和剩余限制。`

function readRulesFile(file) {
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RULE_BYTES)) throw new Error('训练规则文件类型或大小无效')
  const content = stat ? fs.readFileSync(file, 'utf8') : ''
  return { content, revision: createHash('sha256').update(content).digest('hex'), updatedAt: stat?.mtime.toISOString() || null }
}

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
  let store = {}
  try { store = JSON.parse(fs.readFileSync(path.join(root, folder, '.anyu-store.json'), 'utf8')) } catch {}
  return {
    id: folder,
    name,
    description,
    path: path.join(root, folder),
    installedAt: fs.statSync(file).mtime.toISOString(),
    storeVersion: store.version,
    storeSha256: store.sha256,
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
        storeVersion: skill.storeVersion,
        storeSha256: skill.storeSha256,
      })
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  read(id) {
    const safe = String(id || '').trim()
    if (!SKILL_ID.test(safe)) throw new Error('技能标识无效')
    this.skillDirectory(safe)
    const skill = readSkillMarkdown(this.root, safe)
    if (!skill) throw new Error('技能未安装')
    return { ...skill, customRules: readRulesFile(path.join(skill.path, TRAINING_FILE)).content,
      globalCustomRules: readRulesFile(path.join(this.root, TRAINING_FILE)).content }
  }

  skillDirectory(id) {
    if (!SKILL_ID.test(String(id || ''))) throw new Error('技能标识无效')
    const candidate = path.join(this.root, id)
    if (!fs.existsSync(candidate)) throw new Error('技能未安装')
    const relative = path.relative(fs.realpathSync(this.root), fs.realpathSync(candidate))
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('技能目录不能指向安装目录外')
    return candidate
  }

  readTraining(id = '') {
    const safe = String(id || '').trim()
    const skill = safe ? this.read(safe) : null
    const workspacePath = skill ? this.skillDirectory(safe) : this.root
    const rulesPath = path.join(workspacePath, TRAINING_FILE)
    const rules = readRulesFile(rulesPath)
    return { id: safe || null, skill, workspacePath, rulesPath, defaultRules: DEFAULT_TRAINING_RULES,
      customRules: rules.content, globalCustomRules: skill?.globalCustomRules || '',
      globalRulesPath: path.join(this.root, TRAINING_FILE), revision: rules.revision, updatedAt: rules.updatedAt }
  }

  saveTraining({ id = '', customRules, revision } = {}) {
    if (typeof customRules !== 'string' || customRules.includes('\0') || customRules.length > 4000 || Buffer.byteLength(customRules, 'utf8') > MAX_RULE_BYTES) throw new Error('自定义训练规则最多 4000 个字符')
    const current = this.readTraining(id)
    if (typeof revision !== 'string' || revision !== current.revision) throw new Error('训练规则已变更，请重新读取后再保存')
    const temporary = `${current.rulesPath}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, customRules, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, current.rulesPath)
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
    return this.readTraining(id)
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

module.exports = { SkillManager, DEFAULT_TRAINING_RULES }
