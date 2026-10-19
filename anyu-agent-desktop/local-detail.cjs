const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { electronPage } = require('./electron-page.cjs')
const { loginGate, runCollector, feedbackUrl } = require('./local-feedback.cjs')

class LocalDetail {
  constructor({ directory, plugin, openBrowser, createThumbnail }) {
    this.directory = directory
    this.plugin = plugin
    this.openBrowser = openBrowser
    this.createThumbnail = createThumbnail
    this.previewJobs = new Map()
    this.tasks = new Map()
    this.active = null
  }

  start(payload = {}) {
    if (this.active) throw new Error('已有详情图采集任务正在使用内置浏览器，请等待完成')
    if (!feedbackUrl(payload.url)) throw new Error('请提供 HTTPS 淘宝或天猫商品详情链接')
    const record = this.plugin()
    const script = path.join(record.installedPath, 'skills', 'tmall-detail-reference', 'scripts', 'tmallDetailCollector.mjs')
    if (!fs.existsSync(script)) throw new Error('详情参考技能文件缺失，请在插件市场更新或重新安装')
    const task = { taskId: crypto.randomUUID(), status: 'SUBMITTED', url: payload.url, createdAt: new Date().toISOString(), result: null }
    const controller = new AbortController()
    this.tasks.set(task.taskId, task)
    this.active = { task, controller }
    void this.collect(task, script, payload, controller).finally(() => { if (this.active?.task === task) this.active = null })
    return { taskId: task.taskId, status: task.status, local: true }
  }

  async collect(task, script, payload, controller) {
    const timer = setTimeout(() => controller.abort(), 9 * 60 * 1000)
    try {
      const webContents = await this.openBrowser(task.url)
      const page = electronPage(webContents, feedbackUrl, controller.signal)
      await page.goto(task.url)
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let gate = await loginGate(page)
        while (gate) {
          task.status = gate
          task.message = gate === 'WAITING_LOGIN' ? '请在右侧内置浏览器完成淘宝登录' : '请在右侧内置浏览器完成安全验证'
          await this.save(task)
          await delay(1800, undefined, { signal: controller.signal })
          gate = await loginGate(page)
        }
        task.status = 'COLLECTING'
        task.message = '正在逐张采集详情图片'
        await this.save(task)
        const result = await runCollector(script, page, task.url, {
          maxImages: Math.min(24, Math.max(1, Number(payload.maxImages) || 12)),
          includeData: payload.includeData !== false,
          maxImageBytes: Math.min(12 * 1024 * 1024, Math.max(1024 * 1024, Number(payload.maxImageBytes) || 8 * 1024 * 1024))
        }, controller.signal, (progress) => Object.assign(task, progress))
        if (['LOGIN_REQUIRED', 'CHALLENGE_REQUIRED'].includes(result.code)) { task.status = result.code; continue }
        if (!result.ok) throw new Error(result.message || '详情页没有可采集的图片')
        task.result = result
        await this.preparePreviews(task)
        task.status = 'OK'
        task.message = '详情图片采集完成'
        await this.save(task)
        return
      }
      throw new Error('页面反复要求登录或验证，请完成后重新运行技能')
    } catch (error) {
      task.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED'
      task.code = error.code || ''
      task.message = error.message || '详情图片采集失败'
      try { await this.save(task) } catch {}
    } finally { clearTimeout(timer) }
  }

  async save(task) {
    await fs.promises.mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, `${task.taskId}.json`)
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(task), { mode: 0o600 })
      await fs.promises.rename(temporary, file)
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async preparePreviews(task) {
    if (!this.createThumbnail || !Array.isArray(task.result?.images)) return
    if (this.previewJobs.has(task.taskId)) return this.previewJobs.get(task.taskId)
    const job = (async () => {
      let changed = false
      for (const image of task.result.images) {
        const needsConversion = /^data:image\/avif;/i.test(String(image.dataUrl || '')) && !image.generationDataUrl
        if (image.previewUnavailable || !image.dataUrl || image.thumbnailDataUrl && !needsConversion) continue
        try {
          const preview = await this.createThumbnail(image)
          if (preview?.thumbnailDataUrl) Object.assign(image, preview)
          else image.previewUnavailable = true
        } catch { image.previewUnavailable = true }
        changed = true
        // 顺序解码并让出事件循环，避免多张长图同时占用主进程。
        await delay(0)
      }
      if (changed) await this.save(task)
    })()
    this.previewJobs.set(task.taskId, job)
    try { await job } finally { this.previewJobs.delete(task.taskId) }
  }

  async get(taskId, { includeData = true } = {}) {
    this.plugin()
    if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error('本地任务编号无效，请重新运行技能')
    let task = this.tasks.get(taskId)
    if (!task) {
      try {
        const raw = await fs.promises.readFile(path.join(this.directory, `${taskId}.json`), 'utf8')
        task = this.tasks.get(taskId) || JSON.parse(raw)
      } catch { throw new Error('本地任务不存在，请重新运行技能') }
      this.tasks.set(taskId, task)
    }
    if (task.status === 'OK') await this.preparePreviews(task)
    const result = { ...(task.result || {}), code: task.code || task.result?.code, message: task.message }
    if (!includeData && Array.isArray(result.images)) {
      result.images = result.images.map(({ dataUrl, data, generationDataUrl, ...image }) => image)
    }
    return { taskId: task.taskId, status: task.status, result }
  }

  cancel() { this.active?.controller.abort() }
}

module.exports = { LocalDetail }
