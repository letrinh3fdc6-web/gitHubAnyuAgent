'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { safePath, inside } = require('./workspace-checkpoints.cjs')
const { readCreativeDocument, checkedText } = require('./creative-document.cjs')
const { checkedPlan, itemFingerprint, generationPrompt, projectExports, ID } = require('./creative-project.cjs')

const PROJECT_ID = /^creative-[a-f0-9-]{36}$/
const REMOTE_ID = /^[A-Za-z0-9._:-]{1,160}$/
const now = () => new Date().toISOString()
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const TERMINAL = new Set(['completed', 'failed', 'uncertain', 'blocked'])
const CREATIVE_SKILL_IDS = ['anyu-product-photography', 'anyu-detail-campaign', 'anyu-social-cards', 'anyu-visual-audit', 'anyu-script-storyboard', 'anyu-character-bible']

function imageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', ext: 'png' }
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return { mime: 'image/jpeg', ext: 'jpg' }
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return { mime: 'image/gif', ext: 'gif' }
  throw new Error('图片必须为有效的 PNG、JPEG、WebP 或 GIF 文件')
}

async function atomicJSON(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  try { await fs.rename(temporary, file) } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error }
}

// @project-doc docs/interfaces/anyuagent_creative_studio.md#execution
class CreativeStudio {
  constructor(options) {
    this.options = options
    this.root = path.join(options.userData, 'creative-studio')
    this.jobs = new Map()
    this.locks = new Map()
    this.persistence = new Map()
    this.closed = false
    this.slots = 0
    this.waiters = []
  }

  owner(task) {
    if (!task?.owner || String(this.options.getOwner()) !== String(task.owner)) throw new Error('当前账号已变化，请重新打开创作项目')
    return digest(task.owner).slice(0, 32)
  }

  async exclusive(id, operation) {
    const previous = this.locks.get(id) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.locks.set(id, current)
    try { return await current } finally { if (this.locks.get(id) === current) this.locks.delete(id) }
  }

  async projectFile(project, relative) {
    const target = await safePath(project.cwd, path.join(project.relativeRoot, relative))
    if (!inside(project.directory, target)) throw new Error('创作文件路径无效')
    return target
  }

  async persist(project) {
    project.updatedAt = now()
    const snapshot = clone(project)
    const previous = this.persistence.get(project.id) || Promise.resolve()
    const current = previous.catch(() => {}).then(async () => atomicJSON(await this.projectFile(project, 'project.json'), snapshot))
    this.persistence.set(project.id, current)
    try { await current } finally { if (this.persistence.get(project.id) === current) this.persistence.delete(project.id) }
  }

  async load(task, id) {
    const owner = this.owner(task)
    if (!PROJECT_ID.test(id || '')) throw new Error('创作项目编号无效')
    const index = JSON.parse(await fs.readFile(path.join(this.root, owner, `${id}.json`), 'utf8'))
    const cwd = await fs.realpath(task.cwd)
    if (index.id !== id || index.owner !== owner || index.cwd !== cwd) throw new Error('该创作项目不属于当前账号或工作目录')
    const relativeRoot = path.join('anyu-creative', id)
    const directory = await safePath(cwd, relativeRoot)
    const project = JSON.parse(await fs.readFile(await safePath(cwd, path.join(relativeRoot, 'project.json')), 'utf8'))
    if (project.id !== id || project.owner !== owner || project.cwd !== cwd || project.directory !== directory || project.relativeRoot !== relativeRoot || project.schema !== 1 || !['ecommerce', 'comic'].includes(project.kind)) throw new Error('创作项目数据无效')
    if (!Array.isArray(project.references) || project.references.length > 12 || !project.outputs || typeof project.outputs !== 'object') throw new Error('创作项目素材无效')
    for (const ref of project.references) if (!/^ref-[0-9]{3}$/.test(ref.id) || !new RegExp(`^references/${ref.id}\\.(png|jpg|webp|gif)$`).test(ref.file)) throw new Error('参考素材路径无效')
    if (project.plan) project.plan = checkedPlan(project.plan, project)
    for (const [id, output] of Object.entries(project.outputs)) {
      if (!ID.test(id) || !output || !['submitting', 'queued', 'running', 'billing', 'completed', 'failed', 'blocked', 'uncertain'].includes(output.status) || output.remoteTaskId && !REMOTE_ID.test(output.remoteTaskId) || output.file && !new RegExp(`^images/${id}-[0-9]+\\.(png|jpg|webp|gif)$`).test(output.file)) throw new Error('创作结果数据无效')
    }
    return project
  }

  summary(project) {
    return {
      projectId: project.id, sessionId: project.sessionId || '', name: project.name, kind: project.kind, revision: project.revision,
      directory: project.directory, planFile: path.join(project.directory, 'creative-plan.json'),
      scriptFile: project.script ? path.join(project.directory, 'source', 'script.txt') : '',
      scriptInfo: project.scriptInfo || null, references: project.references.map(({ originalPath, ...reference }) => reference),
      items: (project.plan?.items || []).map(item => ({ id: item.id, title: item.title, kind: item.kind, dependsOn: item.dependsOn, ...(project.outputs[item.id] || { status: 'planned' }) })),
      job: this.jobs.has(project.id) ? { status: 'running', id: this.jobs.get(project.id).id, sessionId: this.jobs.get(project.id).sessionId } : null,
      lastError: project.lastError || '',
      updatedAt: project.updatedAt,
    }
  }

  async list(task) {
    const owner = this.owner(task)
    const directory = path.join(this.root, owner)
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const projects = [], unavailable = []
    for (const entry of entries) {
      if (!entry.isFile() || !PROJECT_ID.test(entry.name.slice(0, -5)) || !entry.name.endsWith('.json')) continue
      try {
        const index = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'))
        if (index.sessionId !== task.sessionId) continue
        projects.push(this.summary(await this.load(task, index.id)))
      } catch (error) { unavailable.push({ projectId: entry.name.slice(0, -5), message: String(error.message || error).slice(0, 400) }) }
    }
    return { projects: projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100), unavailable }
  }

  async create(task, input) {
    const owner = this.owner(task)
    if (!['ecommerce', 'comic'].includes(input.kind)) throw new Error('请选择电商或漫剧项目')
    const name = String(input.name || '').trim()
    if (!name || name.length > 120 || String(input.brief || '').length > 12000) throw new Error('项目名称或需求过长')
    const cwd = await fs.realpath(task.cwd)
    const id = `creative-${crypto.randomUUID()}`
    const relativeRoot = path.join('anyu-creative', id)
    const directory = await safePath(cwd, relativeRoot)
    const refs = input.files || []
    if (!Array.isArray(refs) || refs.length > 12) throw new Error('单项目最多导入 12 张商品或角色参考图')
    let script = input.script ? checkedText(input.script) : '', scriptInfo = script ? { format: 'text', characters: script.length } : null
    if (input.scriptFile) {
      const file = await this.inputFile(task, input.scriptFile)
      const parsed = await readCreativeDocument(file)
      script = parsed.text; scriptInfo = { ...parsed }; delete scriptInfo.text
    }
    if (input.kind === 'comic' && !script) throw new Error('请先提供剧本原文或剧本文件')
    let total = 0
    const preparedReferences = []
    for (const [index, source] of refs.entries()) {
      const file = await this.inputFile(task, source)
      const stat = await fs.stat(file)
      total += stat.size
      if (stat.size > 16 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error('参考图单张最大 16 MB，合计最大 64 MB')
      const bytes = await fs.readFile(file)
      const type = imageType(bytes)
      const refID = `ref-${String(index + 1).padStart(3, '0')}`
      const relative = `references/${refID}.${type.ext}`
      preparedReferences.push({ bytes, reference: { id: refID, file: relative, name: path.basename(file), mimeType: type.mime, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, originalPath: file } })
    }
    await fs.mkdir(directory, { recursive: true })
    const project = { schema: 1, id, owner, sessionId: task.sessionId, cwd, relativeRoot, directory, name, kind: input.kind, brief: String(input.brief || '').trim(), script, scriptInfo, references: [], plan: null, revision: 0, outputs: {}, history: [], createdAt: now(), updatedAt: now() }
    for (const { bytes, reference } of preparedReferences) {
      const relative = reference.file
      const target = await this.projectFile(project, relative)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      project.references.push(reference)
    }
    if (script) {
      const file = await this.projectFile(project, 'source/script.txt')
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, script, { flag: 'wx', mode: 0o600 })
    }
    await this.persist(project)
    const indexDirectory = path.join(this.root, owner)
    await fs.mkdir(indexDirectory, { recursive: true })
    await atomicJSON(path.join(indexDirectory, `${id}.json`), { id, owner, cwd, sessionId: task.sessionId })
    this.changed(task, project)
    return { ...this.summary(project), scriptExcerpt: script.slice(0, 16000), next: input.kind === 'ecommerce'
      ? 'Read the references and save a plan with productLock (product identity only), styleLock (shared brand style), and a distinct purpose (decision question and new information) and camera (composition) for each item. Reference originals directly when sufficient; do not chain every image to the hero. No images have been generated.'
      : 'Read the source and references, then save a grounded plan. No images have been generated.' }
  }

  async inputFile(task, file) {
    if (typeof file !== 'string' || !file.trim() || file.includes('\0')) throw new Error('素材文件路径无效')
    const target = path.resolve(task.cwd, file)
    if (task.settings?.policy?.workspaceOnly) {
      if (!inside(task.cwd, target)) throw new Error('当前项目策略只允许工作目录内的素材')
      await safePath(task.cwd, path.relative(task.cwd, target))
    }
    const canonical = await fs.realpath(target)
    if (!(await fs.stat(canonical)).isFile()) throw new Error('请选择具体素材文件，不要传入文件夹')
    return canonical
  }

  async save(task, input) {
    return this.exclusive(input.projectId, async () => {
      if (this.jobs.has(input.projectId)) throw new Error('请先暂停生成，再修改计划')
      const project = await this.load(task, input.projectId)
      if (input.revision !== project.revision) throw new Error('创作计划已被修改，请重新读取后保存')
      let draft = input.plan
      if (input.planFile) {
        const file = await this.inputFile(task, input.planFile)
        if ((await fs.stat(file)).size > 256000) throw new Error('创作计划文件最大 256 KB')
        draft = JSON.parse(await fs.readFile(file, 'utf8'))
      }
      const plan = checkedPlan(draft, project)
      if (project.plan) {
        const previous = await this.projectFile(project, `revisions/plan-${project.revision}.json`)
        await fs.mkdir(path.dirname(previous), { recursive: true })
        await fs.writeFile(previous, JSON.stringify(project.plan, null, 2), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      }
      const byID = new Map(plan.items.map(item => [item.id, item]))
      for (const [id, output] of Object.entries(project.outputs)) {
        const item = byID.get(id)
        if (!item || output.fingerprint !== itemFingerprint(plan, item)) {
          if (output.remoteTaskId && !TERMINAL.has(output.status)) throw new Error(`图片 ${id} 仍有上游任务，请先等待完成或处理后再改动`)
          project.history.push({ itemId: id, ...output, archivedAt: now() })
          delete project.outputs[id]
        }
      }
      project.plan = plan; project.revision++
      await this.persist(project)
      await this.exportProject(project)
      this.changed(task, project)
      return { ...this.summary(project), plan, next: 'Review the plan and requested image count with the user before generation.' }
    })
  }

  async catalog(task) {
    this.owner(task)
    if (task.settings?.policy?.network === false) throw new Error('当前项目已禁用联网工具')
    const groups = await this.options.catalog()
    return { groups: (Array.isArray(groups) ? groups : groups?.items || []).filter(group => ['openai', 'gemini'].includes(group.platform) && group.status === 'active' && group.allow_image_generation && !group.data_sharing_enabled).map(group => ({ id: group.id, name: group.name, rateMultiplier: group.rate_multiplier, models: (group.models || []).filter(model => model.capability === 'image').map(model => ({ name: model.name, pricing: model.pricing || null })) })).filter(group => group.models.length), maxBatch: 20, parallelism: 2 }
  }

  async generate(task, input) {
    return this.exclusive(input.projectId, async () => {
      if (this.closed) throw new Error('客户端正在退出')
      if (this.jobs.has(input.projectId)) return this.summary(await this.load(task, input.projectId))
      const project = await this.load(task, input.projectId)
      if (!project.plan || input.revision !== project.revision) throw new Error('请先读取并确认当前修订的创作计划')
      const catalog = await this.catalog(task)
      const group = catalog.groups.find(item => item.id === input.groupId)
      if (!group?.models.some(model => model.name === input.model)) throw new Error('请从当前账号的生图目录选择分组和模型')
      const requested = input.itemIds || project.plan.items.map(item => item.id)
      if (!Array.isArray(requested) || !requested.length || requested.length > 100) throw new Error('请选择要生成的图片')
      const byID = new Map(project.plan.items.map(item => [item.id, item]))
      if (input.redoCompleted === true) {
        if (!Array.isArray(input.itemIds) || !input.itemIds.length) throw new Error('重做时请明确指定 itemIds，避免重做整套图片')
        const invalidated = new Set(input.itemIds)
        for (const id of invalidated) if (!byID.has(id)) throw new Error(`图片不存在：${id}`)
        let added = true
        while (added) {
          added = false
          for (const item of project.plan.items) {
            if (!invalidated.has(item.id) && item.dependsOn.some(id => invalidated.has(id))) { invalidated.add(item.id); added = true }
          }
        }
        for (const id of invalidated) {
          const output = project.outputs[id]
          if (output && !TERMINAL.has(output.status)) throw new Error('关联图片仍有未完成任务，请先处理已有任务再重做')
          if (output?.status === 'uncertain') throw new Error('关联图片的提交结果不明，请先核对已有任务再重做')
        }
        for (const id of invalidated) {
          const output = project.outputs[id]
          if (!output) continue
          project.history.push({ itemId: id, ...output, archivedAt: now(), reason: 'requested-redo' })
          delete project.outputs[id]
        }
      }
      const selected = new Set()
      function select(id) {
        const item = byID.get(id)
        if (!item) throw new Error(`图片不存在：${id}`)
        if (selected.has(id)) return
        for (const dependency of item.dependsOn) select(dependency)
        selected.add(id)
      }
      requested.forEach(select)
      const pending = [...selected].filter(id => project.outputs[id]?.status !== 'completed')
      if (pending.length > 20) throw new Error('每批最多生成 20 张（包含尚未完成的参考图），请分批选择')
      for (const id of pending) {
        const output = project.outputs[id]
        if (['uncertain', 'submitting'].includes(output?.status)) throw new Error(`图片 ${id} 的提交结果不明，请先核对图片记录，用 reconcile 绑定已有任务，避免重复付费`)
        if (['failed', 'blocked'].includes(output?.status) && input.retryFailed !== true) throw new Error(`图片 ${id} 上次失败；确认后传 retryFailed=true，仅重试失败项`)
        if (output?.remoteTaskId && !TERMINAL.has(output.status) && (output.groupId !== input.groupId || output.model !== input.model)) throw new Error('恢复已有任务时不能切换模型或分组')
      }
      const job = { id: crypto.randomUUID(), sessionId: task.sessionId, projectId: project.id, stopped: false, controller: new AbortController(), promise: null }
      delete project.lastError
      this.jobs.set(project.id, job)
      job.promise = this.run(task, project, pending, { groupId: group.id, model: input.model }, job).catch(async error => {
        project.lastError = String(error.message || error).slice(0, 1500)
        await this.persist(project).catch(() => {})
        this.options.log?.(`creative ${project.id}: ${project.lastError}`)
      }).finally(() => { this.jobs.delete(project.id); this.changed(task, project) })
      this.changed(task, project)
      return { ...this.summary(project), selectedCount: pending.length, message: pending.length ? '已开始生成；使用 status 查看进度，不要重复提交。' : '选中的图片已完成，没有重复生成。' }
    })
  }

  changed(task, project) {
    if (String(this.options.getOwner()) !== String(task.owner)) return
    this.options.changed?.({ ...this.summary(project), sessionId: task.sessionId })
  }

  async slot(signal, operation) {
    while (this.slots >= 4) {
      await new Promise((resolve, reject) => {
        const waiter = { resolve: () => { signal.removeEventListener('abort', abort); resolve() } }
        const abort = () => { this.waiters = this.waiters.filter(item => item !== waiter); reject(new Error('生成已暂停')) }
        signal.addEventListener('abort', abort, { once: true })
        this.waiters.push(waiter)
        if (signal.aborted) abort()
      })
    }
    if (signal.aborted) throw new Error('生成已暂停')
    this.slots++
    try { return await operation() } finally { this.slots--; this.waiters.shift()?.resolve() }
  }

  async run(task, project, pending, selection, job) {
    const waiting = new Set(pending), running = new Map()
    try {
      while ((waiting.size || running.size) && !job.stopped && !this.closed) {
        this.owner(task)
        for (const id of [...waiting]) {
          if (running.size >= 2) break
          const item = project.plan.items.find(item => item.id === id)
          const dependencies = item.dependsOn.map(dependency => project.outputs[dependency])
          if (dependencies.some(output => ['failed', 'blocked', 'uncertain'].includes(output?.status))) {
            project.outputs[id] = { status: 'blocked', error: '参考图未完成，请先处理参考图，再重试本项', fingerprint: itemFingerprint(project.plan, item), updatedAt: now() }
            waiting.delete(id); await this.persist(project); continue
          }
          if (!dependencies.every(output => output?.status === 'completed')) continue
          waiting.delete(id)
          const operation = this.slot(job.controller.signal, () => this.generateItem(task, project, item, selection, job)).catch(error => {
            if (!job.stopped) project.lastError = error.message
          }).finally(() => running.delete(id))
          running.set(id, operation)
        }
        if (running.size) await Promise.race(running.values())
        else if (waiting.size) throw new Error('存在未完成的参考图依赖，请先恢复参考图任务')
      }
    } finally {
      // Keep the job registered until in-flight submissions have saved their remote IDs.
      job.stopped = true
      job.controller.abort()
      await Promise.allSettled(running.values())
      await this.persist(project)
      await this.exportProject(project)
    }
  }

  async referenceBytes(project, relative) {
    if (!/^(references\/ref-[0-9]{3}|images\/[a-z][a-z0-9-]*-\d+)\.(png|jpg|webp|gif)$/.test(relative || '')) throw new Error('参考图片路径无效')
    const file = await this.projectFile(project, relative)
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('参考图片不可用或超过 16 MB')
    const bytes = await fs.readFile(file), type = imageType(bytes)
    const record = project.references.find(reference => reference.file === relative) || Object.values(project.outputs).find(output => output.file === relative)
    if (!record || crypto.createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('参考图在本机已被修改，请重新导入或确认后再生成')
    return { field: 'reference_images', name: path.basename(file), mimeType: type.mime, data: bytes.toString('base64') }
  }

  async generateItem(task, project, item, selection, job) {
    let output = project.outputs[item.id]
    if (!output?.remoteTaskId || TERMINAL.has(output.status)) {
      const previousAttempts = project.history.filter(record => record.itemId === item.id).map(record => record.attempt || 0)
      const attempt = Math.max(output?.attempt || 0, 0, ...previousAttempts) + 1
      const fingerprint = itemFingerprint(project.plan, item)
      const refs = [...item.referenceIds.map(id => project.references.find(ref => ref.id === id).file), ...item.dependsOn.map(id => project.outputs[id].file)]
      const files = []
      try {
        let total = 0
        for (const relative of [...new Set(refs)]) {
          const file = await this.referenceBytes(project, relative)
          total += Buffer.byteLength(file.data, 'base64')
          if (total > 64 * 1024 * 1024) throw new Error('单张生成参考素材合计超过 64 MB')
          files.push(file)
        }
      } catch (error) {
        project.outputs[item.id] = { status: 'failed', error: error.message, attempt, fingerprint, updatedAt: now() }
        await this.persist(project); this.changed(task, project); return
      }
      if (job.stopped || this.closed) return
      this.owner(task)
      if (output) project.history.push({ itemId: item.id, ...output, archivedAt: now(), reason: 'retry' })
      output = project.outputs[item.id] = { status: 'submitting', attempt, fingerprint, ...selection, requestedAt: now(), updatedAt: now() }
      await this.persist(project)
      this.changed(task, project)
      try {
        const remote = await this.options.create({ prompt: generationPrompt(project.plan, item), group_id: selection.groupId, model: selection.model, size: item.size, quality: item.quality, count: 1 }, files)
        if (!REMOTE_ID.test(remote?.id || '')) throw new Error('生图接口没有返回有效任务编号')
        output.remoteTaskId = remote.id; output.status = 'queued'; output.updatedAt = now()
        await this.persist(project)
      } catch (error) {
        output.status = Number(error.status) >= 400 && Number(error.status) < 500 ? 'failed' : 'uncertain'
        output.error = String(error.message || error).slice(0, 1500); output.updatedAt = now()
        await this.persist(project); this.changed(task, project); return
      }
    }
    const deadline = Date.now() + (this.options.pollTimeout || 30 * 60 * 1000)
    while (!job.stopped && !this.closed && Date.now() < deadline) {
      this.owner(task)
      try {
        const remote = await this.options.status(output.remoteTaskId)
        if (remote.id !== output.remoteTaskId || remote.model !== output.model || remote.group_id !== output.groupId) throw new Error('上游任务与当前创作项目不匹配')
        if (remote.status === 'failed') {
          output.status = 'failed'; output.error = String(remote.error_message || '上游生成失败').slice(0, 1500)
        } else if (remote.status === 'completed') {
          const result = await this.options.download(output.remoteTaskId)
          const bytes = Buffer.isBuffer(result) ? result : Buffer.from(result.data, 'base64')
          if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('生成结果为空或超过 32 MB')
          const type = imageType(bytes)
          const relative = `images/${item.id}-${output.attempt}.${type.ext}`
          const target = await this.projectFile(project, relative)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }).catch(async error => {
            if (error.code !== 'EEXIST') throw error
            const existing = await fs.readFile(target)
            if (!existing.equals(bytes)) throw new Error('本机结果文件已被修改，已保留原文件，请另存上游结果')
          })
          output.status = 'completed'; output.file = relative; output.mimeType = type.mime; output.bytes = bytes.length; output.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); delete output.error
        } else {
          if (!['queued', 'queued_output', 'running', 'billing'].includes(remote.status)) throw new Error('生图接口返回未知任务状态')
          output.status = remote.status === 'queued_output' ? 'queued' : remote.status
          delete output.error
        }
        output.updatedAt = now(); await this.persist(project); this.changed(task, project)
        if (TERMINAL.has(output.status)) return
      } catch (error) {
        output.error = `读取已有任务失败，未重复生成：${String(error.message || error).slice(0, 1200)}`
        output.updatedAt = now(); await this.persist(project); this.changed(task, project)
        if ([401, 403, 404].includes(Number(error.status))) return
      }
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); job.controller.signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, this.options.pollInterval || 5000)
        job.controller.signal.addEventListener('abort', done, { once: true })
        if (job.controller.signal.aborted) done()
      })
    }
    if (!job.stopped && !this.closed) output.error = '上游仍在处理，已保存任务编号；稍后恢复会继续查询，不会重新扣费生成。'
    await this.persist(project)
  }

  async reconcile(task, input) {
    return this.exclusive(input.projectId, async () => {
      if (this.jobs.has(input.projectId)) throw new Error('请先暂停生成再绑定已有任务')
      const project = await this.load(task, input.projectId)
      if (input.revision !== project.revision || !REMOTE_ID.test(input.remoteTaskId || '')) throw new Error('修订或远程任务编号无效')
      const item = project.plan?.items.find(item => item.id === input.itemId)
      if (!item) throw new Error('图片不在当前计划中')
      const output = project.outputs[item.id]
      if (!['uncertain', 'submitting'].includes(output?.status)) throw new Error('仅能为提交状态不明的图片绑定任务')
      this.owner(task)
      if (task.settings?.policy?.network === false) throw new Error('当前项目已禁用联网工具')
      const remote = await this.options.status(input.remoteTaskId)
      if (remote.id !== input.remoteTaskId || remote.prompt !== generationPrompt(project.plan, item) || remote.model !== output.model || remote.group_id !== output.groupId) throw new Error('已有任务的提示词、分组或模型不匹配，未绑定')
      output.remoteTaskId = remote.id; output.status = 'queued'; delete output.error
      await this.persist(project)
      return this.summary(project)
    })
  }

  async exportProject(project) {
    for (const [name, content] of Object.entries(projectExports(project))) {
      const target = await this.projectFile(project, name)
      const temporary = `${target}.${crypto.randomUUID()}.tmp`
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, target)
    }
    return { directory: project.directory, files: ['index.html', 'README.md', 'storyboard.csv', 'creative-plan.json'].map(name => path.join(project.directory, name)) }
  }

  async dispatch(task, input) {
    if (this.closed) throw new Error('创作服务正在退出')
    this.owner(task)
    if (task.settings?.policy?.blockedTools?.includes('creative_studio')) throw new Error('当前项目已禁用创作工具')
    if (!['list', 'status', 'inspect', 'export', 'cancel'].includes(input.action) && this.options.installed && !this.options.installed()) throw new Error('请先从技能商店下载安装电商视觉或漫剧创作技能')
    switch (input.action) {
      case 'list': return this.list(task)
      case 'catalog': return this.catalog(task)
      case 'create': return this.create(task, input)
      case 'save': return this.save(task, input)
      case 'generate': return this.generate(task, input)
      case 'reconcile': return this.reconcile(task, input)
      case 'inspect': { const project = await this.load(task, input.projectId); return { ...this.summary(project), brief: project.brief, plan: project.plan, scriptExcerpt: project.script.slice(0, 16000) } }
      case 'status': return this.summary(await this.load(task, input.projectId))
      case 'export': return this.exclusive(input.projectId, async () => this.exportProject(await this.load(task, input.projectId)))
      case 'cancel': {
        await this.load(task, input.projectId)
        const job = this.jobs.get(input.projectId)
        if (job) { job.stopped = true; job.controller.abort(); await job.promise }
        const project = await this.load(task, input.projectId)
        return { ...this.summary(project), message: '已停止本机后续调度；已经提交的上游任务可能仍在处理，恢复时会继续查询已有任务。' }
      }
      default: throw new Error('未知创作操作')
    }
  }

  async close() {
    this.closed = true
    for (const job of this.jobs.values()) { job.stopped = true; job.controller.abort() }
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise))
  }
}

module.exports = { CreativeStudio, imageType, CREATIVE_SKILL_IDS }
