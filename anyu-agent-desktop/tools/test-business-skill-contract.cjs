const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')

const file = 'renderer/app.js'
const source = fs.readFileSync(file, 'utf8')
// 从渲染层切出纯函数，验证触发门控和后端响应兼容性，不启动 Electron 或真实网络。
const start = source.indexOf('  function businessSkillForPrompt(')
const end = source.indexOf('  function businessSecretSafeJson(', start)
if (start < 0 || end < 0) throw new Error('business skill functions not found')

const context = { state: { skillEnabled: { image: true, video: true } } }
vm.runInNewContext(`${source.slice(start, end)}; this.businessSkillForPrompt = businessSkillForPrompt; this.businessPrompt = businessPrompt; this.businessTaskId = businessTaskId; this.businessStatus = businessStatus`, context)

assert.equal(context.businessSkillForPrompt('@评价分析 https://item.taobao.com/x'), 'feedback')
assert.equal(context.businessSkillForPrompt('请评价分析这个商品'), '')
assert.equal(context.businessSkillForPrompt('@测图'), 'image-analysis')
assert.equal(context.businessSkillForPrompt('测图一下这几张图片'), '')
// @ 在消息任意位置都要能触发（中文没有空格，前面是汉字也算）。
assert.equal(context.businessSkillForPrompt('帮我看看 电商鞋子高级感@评价分析 https://item.taobao.com/x'), 'feedback')
assert.equal(context.businessSkillForPrompt('这款衣服@评价分析https://item.taobao.com/x 行不行'), 'feedback')
assert.equal(context.businessSkillForPrompt('第三张图@测图 重点是模特姿态'), 'image-analysis')
// 触发后标记要从提示词里剥掉，用户自己的文字保留（URL 由技能自己从全文里提取）。
assert.equal(context.businessPrompt('帮我看看 电商鞋子高级感@评价分析 https://item.taobao.com/x', 'feedback'), '帮我看看 电商鞋子高级感 https://item.taobao.com/x')
assert.equal(context.businessPrompt('第三张图@测图 重点是模特姿态', 'image-analysis'), '第三张图 重点是模特姿态')
assert.match(source, /if \(businessSkill && !businessPlugin\(businessSkill\)\)/, '未安装或禁用时不能执行')
assert.doesNotMatch(source, /builtinSkills:/, '业务技能不能作为内置菜单项')
const gateStart = source.indexOf('  function businessPlugin(')
const gateEnd = source.indexOf('  function pluginPublishStatusLabel(', gateStart)
const installed = []
const gate = { installedPlugin: (id) => installed.find((item) => item.id === id) }
vm.runInNewContext(`${source.slice(gateStart, gateEnd)}; this.businessPlugin = businessPlugin`, gate)
assert.equal(gate.businessPlugin('feedback'), null)
assert.equal(gate.businessPlugin('image-analysis'), null)
installed.push({ id: 'ai-image-analysis', enabled: true })
assert.equal(gate.businessPlugin('image-analysis'), installed[0])
installed[0].enabled = false
assert.equal(gate.businessPlugin('image-analysis'), null)
installed.pop()
assert.equal(gate.businessPlugin('image-analysis'), null)
const main = fs.readFileSync('main.cjs', 'utf8')
assert.doesNotMatch(main, /BUILTIN_SKILL_(ROOT|IDS)/, '运行时不能加载随客户端附带的业务技能')
assert.match(main, /requireBusinessPlugin\(BUSINESS_PLUGIN_IDS\.feedback\)/)
assert.match(main, /requireBusinessPlugin\(BUSINESS_PLUGIN_IDS\.imageAnalysis\)/)
const packaging = JSON.parse(fs.readFileSync('package.json', 'utf8'))
assert.ok(!packaging.build.files.some((entry) => entry.startsWith('skills/')), '桌面安装包不应携带技能文件')
assert.equal(context.businessPrompt('@评价分析 https://item.taobao.com/x', 'feedback'), 'https://item.taobao.com/x')

assert.equal(context.businessTaskId({ task: { id: 'nested-task' }, status: 'SUBMITTED' }), 'nested-task')
assert.equal(context.businessTaskId({ result: { task: { taskId: 'result-task' } } }), 'result-task')
assert.equal(context.businessStatus({ task: { status: 'PROCESSING' } }), 'PROCESSING')
assert.equal(context.businessStatus({ result: { status: 'OK' } }), 'OK')

assert.match(source, /data-business-signature=\"\$\{esc\(businessRenderSignature\(message\)\)\}/)
assert.match(source, /if \(!task \|\| state\.loading \|\| state\.skillBusy\)/, '技能运行期间必须进入同一发送队列')
assert.match(source, /state\.queueDraining \|\| state\.loading \|\| state\.skillBusy/, '队列排空必须等待技能结束')
const reportStart = source.indexOf('  function feedbackArtifactFiles(')
const reportEnd = source.indexOf('  // 重试只读取已保存的本机采集任务', reportStart)
assert(reportStart >= 0 && reportEnd > reportStart)
const report = {
  esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
  businessPayload: (value) => value.result || value,
  businessRows: (value, keys) => keys.map((key) => value[key]).find(Array.isArray) || [],
  businessSecretSafeJson: JSON.stringify,
  businessCsv: () => 'csv'
}
vm.runInNewContext(`${source.slice(reportStart, reportEnd)}; this.feedbackArtifactFiles = feedbackArtifactFiles`, report)
const files = report.feedbackArtifactFiles({ result: { reviews: [{ content: '<script>alert(1)</script>', merchantReply: '', user: '用户' }], questions: [{ question: '<img src=x>', answer: '可手洗' }], analysisHtml: '<!doctype html><html><main><section>完整报告</section></main></html>' } }, 'https://detail.tmall.com/item.htm?id=1')
assert.match(files[0].content, /完整报告/)
assert.doesNotMatch(files[0].content, /<table>|white-space:pre-wrap/, '对话不应重新拼原始评价表')
assert.match(files[1].content, /<script>alert\(1\)<\/script>/, '原始数据保留在 JSON 中，不作为 HTML 插入')
assert.doesNotMatch(files[1].content, /analysisHtml/, '原始 JSON 不重复存储完整报告')
assert.match(source, /letaAgentFeedbackStatus\(message\.feedbackTaskId\)/, '重试必须复用本机采集任务')
assert.match(source, /message\.feedbackTaskId && \(message\.feedbackRetry \|\| message\.isError\)/, '旧失败记录应显示继续分析')
// 同一进度不应反复写盘或重绘整个界面，滚动位置由增量渲染保留。
const progressStart = source.indexOf('  const businessSnapshots = ')
const progressEnd = source.indexOf('  async function writeBusinessArtifacts(', progressStart)
let saves = 0, liveUpdates = 0
const progress = {
  state: { sessionPath: 'fixture' },
  updateBusinessMessage: () => {},
  persistMediaTimeline: async () => { saves++ },
  businessRenderSignature: (message) => JSON.stringify([message.businessStatus, message.businessPending]),
  scheduleLiveUi: (force) => { assert.equal(force, false); liveUpdates++ }
}
vm.runInNewContext(`${source.slice(progressStart, progressEnd)}; this.persist = persistBusinessMessage`, progress)

async function persistenceContract() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leta-business-record-'))
  try {
    const sessions = path.join(directory, 'pi', 'sessions')
    fs.mkdirSync(sessions, { recursive: true })
    const mediaDirectory = path.join(directory, 'pi', 'media')
    fs.mkdirSync(mediaDirectory, { recursive: true })
    const mediaStart = main.indexOf('function readMediaIndex() {')
    const mediaEnd = main.indexOf('function piExecutable()', mediaStart)
    const media = {
      fs, path, crypto, process,
      piSessionDir: () => sessions,
      piMediaDir: () => mediaDirectory,
      piMediaIndexFile: () => path.join(mediaDirectory, 'index.json'),
      attachmentSessionKey: (value) => crypto.createHash('sha256').update(value).digest('hex'),
      isInside: (parent, file) => file.startsWith(`${parent}${path.sep}`),
      app: { getPath: (name) => name === 'userData' ? directory : os.homedir() }
    }
    vm.runInNewContext(`${main.slice(mediaStart, mediaEnd)}; this.save = savePiMediaMessages; this.load = loadPiMediaMessages; this.recover = recoverLegacyFeedback`, media)
    const sessionPath = path.join(sessions, 'fixture.jsonl')
    const record = {
      id: 'task:result', role: 'assistant', content: '采集完成', businessSkill: 'feedback', businessPending: false,
      businessPhase: '分析失败', businessStatus: 'FAILED', businessResult: { reviewCount: 15 },
      businessAssets: [{ url: 'https://example.com/image.png' }], feedbackTaskId: crypto.randomUUID(),
      feedbackUrl: 'https://detail.tmall.com/item.htm?id=1', feedbackPrompt: '分析',
      feedbackCollected: true, feedbackRetry: true, artifactCwd: directory,
      artifacts: [{ name: 'report.html', path: path.join(directory, 'report.html'), previewable: true }]
    }
    const legacyFile = path.join(mediaDirectory, 'index.json')
    const legacy = JSON.stringify({ existing: { messages: [{ content: '历史保留' }] } })
    fs.writeFileSync(legacyFile, legacy)
    await media.save({ sessionPath, cwd: directory, messages: [record] })
    const restored = media.load(sessionPath)[0]
    for (const key of Object.keys(record)) assert.equal(JSON.stringify(restored[key]), JSON.stringify(record[key]), `业务字段丢失：${key}`)
    await Promise.all(['进度一', '进度二', '完成'].map((content) => media.save({ sessionPath, messages: [{ ...record, content }] })))
    assert.equal(media.load(sessionPath)[0].content, '完成', '异步保存必须按调用顺序提交')
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacy, '进度不能改写整个历史索引')
    const taskDirectory = path.join(directory, 'local-skill-tasks', 'feedback')
    fs.mkdirSync(taskDirectory, { recursive: true })
    const url = 'https://detail.tmall.com/item.htm?id=1'
    const taskId = crypto.randomUUID()
    const now = Date.now()
    fs.writeFileSync(path.join(taskDirectory, `${taskId}.json`), JSON.stringify({ taskId, status: 'OK', url, createdAt: new Date(now + 5000).toISOString() }))
    const recovered = media.recover([
      { id: 'old', role: 'user', content: `@评价分析 ${url}`, createdAt: now },
      { id: 'old:result', role: 'assistant', content: 'businessHtml is not defined' }
    ], directory)[1]
    assert.equal(recovered.feedbackTaskId, taskId)
    assert.equal(recovered.feedbackRetry, true)
    assert.equal(recovered.artifactCwd, directory)
    await assert.rejects(() => media.save({ sessionPath: path.join(directory, 'outside.jsonl'), messages: [] }), /会话/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

async function run() {
  const message = { content: '采集中', businessStatus: 'COLLECTING', businessPending: true }
  await progress.persist('fixture', message)
  for (let i = 0; i < 10; i++) await progress.persist('fixture', message)
  assert.equal(saves, 1); assert.equal(liveUpdates, 1)
  message.content = '已采集 15 条'
  await progress.persist('fixture', message)
  assert.equal(saves, 2); assert.equal(liveUpdates, 2)
  await persistenceContract()
  console.log('business skill: report escaping, progress deduplication, per-session atomic persistence and restore passed')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
