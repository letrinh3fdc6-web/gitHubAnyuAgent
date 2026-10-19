const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Worker } = require('node:worker_threads')
const { setTimeout: delay } = require('node:timers/promises')
const { electronPage } = require('./electron-page.cjs')
const { reportAnalysisPrompt, reportPromptWithAnalysis, reportHtml, fallbackReportHtml, reportStreamPreview } = require('./feedback-report.cjs')
const { shopAnalysisRequest, shopAnalysisHtml } = require('./shop-analysis.cjs')

function feedbackUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && /(^|\.)(taobao|tmall)\.com$/i.test(url.hostname)
  } catch { return false }
}

// 登录只检测可见的登录表单/验证界面，不读取 Cookie、密码或验证码。
async function loginGate(page) {
  const url = page.url()
  const state = await page.evaluate(() => {
    const visible = (node) => {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node)
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    return {
      text: (document.body?.innerText || '').slice(0, 16000),
      login: [...document.querySelectorAll('input[type="password"], input[name*="login" i], form[action*="login" i]')].some(visible)
    }
  })
  if (/_____tmd_____\/(?:page\/login_jump|punish)|passport\.taobao\.com\/iv\/|identity_verify|captcha|punish/i.test(url) || /手机验证码|验证身份|安全验证|滑块验证|请完成验证/.test(state.text)) return 'CHALLENGE_REQUIRED'
  if (/(?:^|\.)login\.(?:taobao|tmall)\.com|\/login\//i.test(url) || state.login) return 'WAITING_LOGIN'
  return ''
}

function runCollector(script, page, url, options, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'feedback-worker.cjs'), {
      workerData: { script, url, options }, env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 }
    })
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      void worker.terminate()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(new Error('评价采集已取消'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) return abort()
    worker.on('error', (error) => finish(error))
    worker.on('exit', (code) => { if (!settled) finish(new Error(`采集脚本异常退出 (${code})`)) })
    worker.on('message', async (message) => {
      if (settled) return
      if (message.type === 'result') return finish(null, message.result)
      if (message.type === 'error') return finish(Object.assign(new Error(message.error), { code: message.code }))
      if (message.type === 'progress') { onProgress(message.progress); return }
      if (message.type !== 'page') return
      try {
        const args = message.args || []
        let value
        if (message.method === 'evaluate') value = await page.evaluate(args[0], args[1])
        else if (message.method === 'goto') value = await page.goto(args[0])
        else if (message.method === 'wheel') value = await page.mouse.wheel(...args)
        else if (message.method === 'wheelAt') value = await page.mouse.wheelAt(...args)
        else if (message.method === 'move') value = await page.mouse.move(...args)
        else if (message.method === 'press') value = await page.keyboard.press(args[0])
        else if (message.method === 'locator') {
          const [query, action, source] = args
          if (!['innerText', 'count', 'isVisible', 'evaluateAll', 'scrollIntoViewIfNeeded', 'click'].includes(action)) throw new Error('不支持的采集操作')
          let locator = query.text == null ? page.locator(query.selector) : page.getByText(query.text)
          if (query.index != null) locator = locator.nth(query.index)
          value = await locator[action](source)
        } else throw new Error('不支持的采集操作')
        if (!settled) worker.postMessage({ id: message.id, value, url: page.url() })
      } catch (error) {
        if (error.code === 'PLATFORM_RESTRICTED') return finish(error)
        if (!settled) worker.postMessage({ id: message.id, error: error.message, code: error.code, url: page.url() })
      }
    })
  })
}

class LocalFeedback {
  constructor({ directory, plugin, shopPlugin, openBrowser, analyze }) {
    this.directory = directory; this.plugin = plugin; this.shopPlugin = shopPlugin || plugin; this.openBrowser = openBrowser; this.analyze = analyze
    this.tasks = new Map(); this.active = null; this.shopAnalysisRuns = new Map()
  }
  start(payload) {
    if (this.active) throw new Error('已有评价采集任务正在使用内置浏览器，请等待完成')
    if (!feedbackUrl(payload.url)) throw new Error('请提供 HTTPS 淘宝或天猫商品链接')
    const record = this.plugin()
    const script = path.join(record.installedPath, 'skills', 'tmall-public-feedback-analysis', 'scripts', 'tmallCollector.mjs')
    if (!fs.existsSync(script)) throw new Error('已安装的是旧版技能，请在插件市场更新或重新安装淘宝评价分析')
    if (!fs.existsSync(path.join(record.installedPath, 'skills', 'tmall-public-feedback-analysis', 'prompts', 'report.md')) || !fs.existsSync(path.join(record.installedPath, 'skills', 'tmall-public-feedback-analysis', 'styles', 'report.css'))) throw new Error('当前评价技能缺少报告模板，请先在插件市场更新技能；已采集任务可直接继续分析')
    const realRoot = fs.realpathSync(record.installedPath), realScript = fs.realpathSync(script)
    if (!realScript.startsWith(`${realRoot}${path.sep}`)) throw new Error('采集脚本路径越界')
    const task = { taskId: crypto.randomUUID(), status: 'SUBMITTED', url: payload.url, createdAt: new Date().toISOString(), result: null }
    const controller = new AbortController()
    this.tasks.set(task.taskId, task); this.active = { task, controller }
    void this.collect(task, realScript, payload, controller).finally(() => { if (this.active?.task === task) this.active = null })
    return { taskId: task.taskId, status: task.status, local: true }
  }

  // 店铺监控复用同一浏览器会话，返回原始商品快照给运营系统。
  startShopMonitor(payload) {
    if (this.active) throw new Error('已有浏览器采集任务正在运行，请等待完成')
    if (!feedbackUrl(payload.url)) throw new Error('请提供 HTTPS 淘宝或天猫店铺链接')
    const record = this.shopPlugin()
    const script = path.join(record.installedPath, 'skills', 'tmall-shop-monitor', 'scripts', 'shopCollector.mjs')
    if (!fs.existsSync(script)) throw new Error('店铺分析技能未安装')
    const task = { taskId: crypto.randomUUID(), kind: 'shop-analysis', status: 'SUBMITTED', url: payload.url, createdAt: new Date().toISOString(), result: null }
    const controller = new AbortController()
    this.tasks.set(task.taskId, task); this.active = { task, controller }
    void this.collectShop(task, script, payload, controller).finally(() => { if (this.active?.task === task) this.active = null })
    return { taskId: task.taskId, status: task.status, local: true }
  }

  async collectShop(task, script, payload, controller) {
    const timer = setTimeout(() => controller.abort(), 9 * 60 * 1000)
    try {
      const webContents = await this.openBrowser(task.url)
      const page = electronPage(webContents, feedbackUrl, controller.signal)
      // 采集技能复用内置浏览器，但首次启动时页面可能仍处于空白/加载中；
      // 显式等待目标页面稳定，避免 page.url() 为 unknown 被误判为离开淘宝。
      await page.goto(task.url)
      await delay(1200, undefined, { signal: controller.signal })
      let result = null
      let emptyAttempts = 0
      for (let attempt = 0; attempt < 180; attempt++) {
        task.status = 'COLLECTING'; task.message = '慢速滚动并等待商品列表加载'
        result = await runCollector(script, page, task.url, { maxRounds: Math.min(240, Math.max(30, Number(payload.maxRounds) || 180)), waitMs: 2200, skipGoto: true }, controller.signal, (progress) => Object.assign(task, progress))
        if (!['LOGIN_REQUIRED', 'CHALLENGE_REQUIRED', 'NO_PRODUCTS'].includes(result.code)) break
        if (result.code === 'NO_PRODUCTS') { emptyAttempts += 1; if (emptyAttempts >= 3) break }
        task.status = result.code === 'LOGIN_REQUIRED' ? 'WAITING_LOGIN' : result.code
        task.status = result.code === 'NO_PRODUCTS' ? 'COLLECTING' : task.status
        task.result = result; task.message = result.code === 'NO_PRODUCTS' ? '当前页面暂未发现商品，正在重新加载并滚动店铺内容' : (result.message || '请在右侧浏览器完成登录或安全验证')
        await this.save(task)
        await delay(result.code === 'NO_PRODUCTS' ? 1200 : 3000, undefined, { signal: controller.signal })
      }
      task.result = result; task.status = result?.ok ? 'OK' : 'FAILED'; task.message = result?.ok ? '店铺商品采集完成' : (result?.message || '未找到公开商品链接'); await this.save(task)
    } catch (error) { task.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED'; task.code = error.code || ''; task.message = error.message; await this.save(task) }
    finally { clearTimeout(timer) }
  }
  async save(task) {
    await fs.promises.mkdir(this.directory, { recursive: true })
    await fs.promises.writeFile(path.join(this.directory, `${task.taskId}.json`), JSON.stringify(task), { mode: 0o600 })
  }
  async collect(task, script, payload, controller) {
    const timer = setTimeout(() => controller.abort(), 9 * 60 * 1000)
    try {
      const webContents = await this.openBrowser(task.url)
      const page = electronPage(webContents, feedbackUrl, controller.signal)
      await page.goto(task.url)
      for (let attempt = 0; attempt < 4; attempt++) {
        let gate = await loginGate(page)
        while (gate) {
          task.status = gate; task.message = gate === 'WAITING_LOGIN' ? '请在右侧浏览器完成淘宝登录' : '请在右侧浏览器完成安全验证'
          await this.save(task)
          await delay(1800, undefined, { signal: controller.signal })
          gate = await loginGate(page)
        }
        task.message = '登录或验证已完成，正在继续采集'; await this.save(task)
        if (!sameFeedbackItem(page.url(), task.url)) await page.goto(task.url)
        task.status = 'COLLECTING'; task.message = '本机正在采集公开评价与问大家'
        const result = await runCollector(script, page, task.url, {
          maxReviewRounds: Math.min(300, Number(payload.maxReviewPages) || 200),
          maxQuestionRounds: Math.min(100, Number(payload.maxQuestionPages) || 80)
        }, controller.signal, (progress) => Object.assign(task, progress))
        if (['LOGIN_REQUIRED', 'CHALLENGE_REQUIRED'].includes(result.code)) {
          task.status = result.code === 'LOGIN_REQUIRED' ? 'WAITING_LOGIN' : result.code
          continue
        }
        if (!result.ok) throw new Error(result.message || '页面没有可采集的公开评价')
        task.result = result; task.status = 'OK'; task.message = '本机采集完成'
        await this.save(task)
        return
      }
      throw new Error('页面反复要求登录或验证，请完成后重新运行技能')
    } catch (error) {
      task.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED'
      task.code = error.code || ''
      task.message = controller.signal.aborted ? '采集已取消或等待登录超时，请重新运行技能' : error.message
      try { await this.save(task) } catch {}
    } finally { clearTimeout(timer) }
  }
  async get(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('本地任务编号无效，请重新运行技能')
    let task = this.tasks.get(id)
    if (!task) {
      try { task = JSON.parse(await fs.promises.readFile(path.join(this.directory, `${id}.json`), 'utf8')) } catch { throw new Error('本地任务不存在，请重新运行技能') }
      this.tasks.set(id, task)
    }
    if (task.kind === 'shop-analysis' || Array.isArray(task.result?.products)) this.shopPlugin()
    else this.plugin()
    return { taskId: task.taskId, status: task.status, result: { ...(task.result || {}), code: task.code || task.result?.code, message: task.message, phase: task.phase, productCount: task.result?.products?.length || task.count || 0, reviewCount: task.result?.reviews?.length || task.reviewCount || 0, questionCount: task.result?.questions?.length || 0 } }
  }
  async shopAnalysis(id, options = {}, onProgress) {
    this.shopPlugin()
    if (this.shopAnalysisRuns.has(id)) return this.shopAnalysisRuns.get(id)
    const run = this.analyzeShop(id, options, onProgress)
    this.shopAnalysisRuns.set(id, run)
    try { return await run } finally { this.shopAnalysisRuns.delete(id) }
  }
  async analyzeShop(id, options, onProgress) {
    const snapshot = await this.get(id)
    if (snapshot.status !== 'OK' || !snapshot.result.products?.length) throw new Error('请先完成店铺商品采集')
    const task = this.tasks.get(id)
    if (task.result.analysisSummary) return task.result
    const instructionFile = path.join(this.shopPlugin().installedPath, 'skills', 'tmall-shop-monitor', 'prompts', 'analysis.md')
    if (!fs.existsSync(instructionFile)) throw new Error('请更新店铺分析技能，当前版本缺少 AI 分析提示词')
    const instruction = await fs.promises.readFile(instructionFile, 'utf8')
    const request = shopAnalysisRequest(task.result, instruction, options.prompt)
    task.result.analysisStatus = 'ANALYZING'
    await this.save(task)
    try {
      if (typeof this.analyze !== 'function') throw new Error('当前会话模型未启动，无法进行 AI 分析')
      const summary = String(await this.analyze(request.prompt, [], (text) => {
        task.result.analysisDraft = String(text || '')
        onProgress?.({ taskId: id, stage: 'analysis', text: task.result.analysisDraft })
      }, options.model, options.sessionKey) || '').trim()
      if (!summary) throw new Error('AI 未返回店铺分析内容，采集结果已保留')
      task.result.analysisSummary = summary
      task.result.analyzedSamples = request.analyzedSamples
      task.result.analysisStatus = 'OK'
      task.result.analysisHtml = shopAnalysisHtml(task.result, summary)
      await this.save(task)
      return task.result
    } catch (error) {
      task.result.analysisStatus = 'FAILED'
      task.result.analysisError = String(error?.message || error)
      await this.save(task)
      throw error
    }
  }
  async analysis(id, prompt, onProgress) {
    const snapshot = await this.get(id)
    if (!snapshot.result.reviews && !snapshot.result.questions) throw new Error('请先完成本机采集')
    if (snapshot.result.analysisHtml) {
      onProgress?.({ taskId: id, stage: 'report', text: '报告已生成，正在打开右侧预览…' })
      return snapshot.result
    }
    const result = snapshot.result
    const root = path.join(this.plugin().installedPath, 'skills', 'tmall-public-feedback-analysis')
    const instructionFile = path.join(root, 'prompts', 'report.md')
    const styleFile = path.join(root, 'styles', 'report.css')
    if (!fs.existsSync(instructionFile) || !fs.existsSync(styleFile)) throw new Error('请在插件市场更新评价分析技能，当前版本没有完整报告模板')
    const instruction = await fs.promises.readFile(instructionFile, 'utf8')
    const stylesheet = await fs.promises.readFile(styleFile, 'utf8')
    const analyzeWithRetry = async (requestPrompt, stage, seed = '', onPartial) => {
      let last = String(seed || '')
      let lastError
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const output = await this.analyze(requestPrompt, [], (partial) => {
            if (typeof partial === 'string' && partial.length >= last.length) last = partial
            onPartial?.(last)
            this.emitAnalysisProgress(id, last, stage, onProgress)
          })
          return String(output || last).trim()
        } catch (error) {
          lastError = error
          const message = String(error?.message || error)
          if (!/upstream_stream_read_error|stream.*interrupt|network|timeout|reset/i.test(message) || attempt >= 2) throw error
          this.emitAnalysisProgress(id, `上游流中断，正在保留已生成内容并重试（${attempt + 1}/2）…`, stage, onProgress)
          await delay(1200 * (attempt + 1))
        }
      }
      throw lastError || new Error('分析失败')
    }
    let analysisSummary = String(result.analysisSummary || '').trim()
    if (!analysisSummary) {
      const analysisRequest = reportAnalysisPrompt(result, prompt)
      this.emitAnalysisProgress(id, '', 'analysis', onProgress)
      // 可读分析先流式说完，再单独生成报告；两段执行共用原始采集任务。
      try {
        analysisSummary = await analyzeWithRetry(analysisRequest.prompt, 'analysis', '', async (partial) => {
          if (!partial.trim()) return
          const task = this.tasks.get(id) || { taskId: id, status: 'OK', result }
          task.result = { ...result, analysisDraft: partial }
          this.tasks.set(id, task)
          await this.save(task)
        })
      } catch (error) {
        const saved = this.tasks.get(id)
        if (saved?.result?.analysisDraft) {
          saved.status = 'FAILED'
          saved.message = `AI 流中断，已保存 ${saved.result.analysisDraft.length} 字的阶段结果，可继续分析`
          await this.save(saved)
        }
        throw error
      }
      // 某些模型会误返回 HTML/Markdown，先提取可读正文；只有完全没有内容时才使用明确的兼容提示。
      if (/<\/?(?:html|main|section)\b/i.test(analysisSummary)) analysisSummary = reportStreamPreview(analysisSummary) || analysisSummary.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (!analysisSummary) analysisSummary = '已完成公开评价与问大家的数据整理，正在生成可视化报告。'
      result.analysisSummary = analysisSummary
      delete result.analysisDraft
      const task = this.tasks.get(id) || { taskId: id, status: 'OK', result }
      task.result = result
      this.tasks.set(id, task)
      await this.save(task)
    }
    this.emitAnalysisProgress(id, '正在整理完整可视化报告…', 'report', onProgress)
    const { prompt: modelPrompt, sampled } = reportPromptWithAnalysis(result, prompt, instruction, analysisSummary)
    // 报告阶段也要有进度心跳：完整 HTML 报告要写很久，之前这段没有任何回传，
    // 用户只能对着静止的界面猜。这里报“已输出多少字”，不把 HTML 源码刷进聊天。
    let reportChars = 0
    const generated = await analyzeWithRetry(modelPrompt, 'report', String(result.reportDraft || ''), (partial) => {
      const size = partial.length
      if (!size || size === reportChars) return
      reportChars = size
      this.emitAnalysisProgress(id, `正在撰写完整可视化报告…（已输出 ${reportChars} 字，数据量大时需要几分钟，请勿关闭会话）`, 'report', onProgress)
    })
    let analysisHtml
    let compatibilityFallback = false
    try {
      analysisHtml = reportHtml(result, generated, stylesheet, sampled)
    } catch {
      // 排版格式是非业务错误：保留采集和自然语言分析，使用本地固定模板生成可打开报告。
      compatibilityFallback = true
      analysisHtml = fallbackReportHtml(result, stylesheet, sampled, analysisSummary)
    }
    const task = this.tasks.get(id) || { taskId: id, status: 'OK', result }
    task.result = { ...result, analysisHtml, analysisSample: sampled, analysisCompatibilityFallback: compatibilityFallback }
    this.tasks.set(id, task); await this.save(task)
    return task.result
  }
  emitAnalysisProgress(id, text, stage, onProgress) {
    onProgress?.({ taskId: id, stage, text: String(text || '').slice(0, 12000) })
  }
  cancel() { this.active?.controller.abort() }
}

function sameFeedbackItem(current, requested) {
  try {
    const a = new URL(current), b = new URL(requested)
    return feedbackUrl(current) && a.searchParams.get('id') && a.searchParams.get('id') === b.searchParams.get('id')
  } catch { return false }
}

module.exports = { LocalFeedback, feedbackUrl, loginGate, runCollector, sameFeedbackItem }
