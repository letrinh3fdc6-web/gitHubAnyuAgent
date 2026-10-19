const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

// @生图 规划阶段：不再展示固化的四步清单（defaultImagePlanSteps），
// 气泡内容改为模型真实输出的流式“吐字”，机器可读的最终提示词放在末尾标记块里。
const renderer = fs.readFileSync('renderer/app.js', 'utf8')
const main = fs.readFileSync('main.cjs', 'utf8')
const preload = fs.readFileSync('preload.cjs', 'utf8')

// ---------- 1) parseImagePlan 行为验证（真实实现） ----------
const start = renderer.indexOf('const IMAGE_PLAN_PROMPT_MARKER')
const end = renderer.indexOf('function imagePlannerModel()', start)
assert.ok(start >= 0 && end > start, 'parseImagePlan 源码片段未找到')
const code = `
  ${renderer.slice(start, end)}
  this.parseImagePlan = parseImagePlan
`
const context = { console }
vm.runInNewContext(code, context)
const { parseImagePlan } = context

// 1a) 新格式：自然语言规划 + 机器可读块
const plan = parseImagePlan([
  '这只金毛犬趴在草地上，主体是狗与人物相依的温馨瞬间。',
  '我会用低角度构图突出亲密感，暖色光线，背景虚化。',
  '@@PROMPT@@{"summary":"金毛犬与主人在草地","prompt":"一只金毛犬与主人坐在草地上，暖色阳光，浅景深"}@@END@@'
].join('\n'))
assert.ok(plan, '新格式必须能解析')
assert.equal(plan.prompt, '一只金毛犬与主人坐在草地上，暖色阳光，浅景深')
assert.equal(plan.summary, '金毛犬与主人在草地')
assert.ok(plan.reasoning.includes('金毛犬趴在草地上'), '必须保留写给用户看的真实推理文本')
assert.ok(!plan.reasoning.includes('@@PROMPT@@') && !plan.reasoning.includes('"summary"'), '推理文本不能混入机器块')

// 1b) 旧格式（纯 JSON / 带 markdown 围栏）仍兼容
const legacy = parseImagePlan('```json\n{"summary":"湖边风景","prompt":"清晨湖面"}\n```')
assert.ok(legacy && legacy.prompt === '清晨湖面' && legacy.reasoning === '', '旧格式必须兼容且 reasoning 为空')

// 1c) 缺 prompt 视为失败
assert.equal(parseImagePlan('只有说明文字，没有机器块'), null)

// ---------- 2) 固化步骤清单必须彻底移除 ----------
assert.ok(!renderer.includes('defaultImagePlanSteps'), 'defaultImagePlanSteps（固定四步）必须删除')
assert.ok(!renderer.includes('imagePlanDisplayText'), 'imagePlanDisplayText 必须删除')
assert.ok(!renderer.includes('正在识别主体与核心需求'), '固化的第一阶段文案必须删除')
assert.ok(/mediaPlanSteps: \[\]/.test(renderer), '生图任务不得再注入预设步骤')

// ---------- 3) 规划请求：流式 + 真实推理 ----------
const planFn = renderer.slice(renderer.indexOf('async function requestImagePlan('), renderer.indexOf('function chineseNumberValue('))
assert.ok(planFn.includes('window.anyu.apiStream'), '规划请求必须优先走流式 apiStream')
assert.ok(planFn.includes('stream: true') === false, 'stream 标志由主进程统一注入')
assert.ok(planFn.includes('IMAGE_PLAN_PROMPT_MARKER'), '规划指令必须约定机器可读块标记')
assert.ok(/先用简短的中文自然段/.test(planFn), '规划指令必须要求先输出给用户看的真实推理')
assert.ok(/function buildImagePrompt\(promptText, references, onDelta\)/.test(renderer), 'buildImagePrompt 必须支持吐字回调')

// ---------- 4) 生图流程：吐字写进气泡并节流落盘 ----------
const imageBranch = renderer.slice(renderer.indexOf('if (kind === \'image\') {'), renderer.indexOf("const plan = planVideoRequest("))
assert.ok(/buildImagePrompt\(promptText, references, \(delta\) =>/.test(imageBranch), '生图流程必须把吐字回调传给规划器')
assert.ok(/resultMessage\.content = planText/.test(imageBranch), '吐字必须写进气泡内容')
assert.ok(/scheduleMediaTimelinePersist\(mediaSessionPath\)/.test(imageBranch), '吐字落盘必须节流，不能逐字写盘')
assert.ok(/scheduleLiveUi\(false\)/.test(imageBranch), '吐字必须触发界面刷新')
assert.ok(!/mediaPlanSteps\.length - 1/.test(imageBranch), '不得再按步骤数推进伪进度')

// ---------- 5) 主进程流式 IPC 与 preload 桥 ----------
assert.ok(main.includes('async function streamApi('), '主进程缺少 streamApi')
assert.ok(main.includes("ipcMain.handle('api:stream'"), '主进程缺少 api:stream 处理器')
assert.ok(main.includes("'api:stream-delta'"), '增量必须通过 api:stream-delta 回传')
assert.ok(main.includes('{ ...(options.body || {}), stream: true }'), '主进程必须统一注入 stream:true')
assert.ok(main.includes("data === '[DONE]'"), '必须处理 SSE 结束标记')
assert.ok(main.includes("payload?.choices?.[0]?.delta?.content"), '必须解析 chat/completions 增量')
assert.ok(main.includes("response.output_text.delta"), '必须解析 responses 增量')
assert.ok(preload.includes('apiStream:'), 'preload 必须暴露 apiStream')
assert.ok(preload.includes("'api:stream-delta'"), 'preload 必须订阅增量事件')

// ---------- 6) 常驻进度条展示气泡最后一行（吐字可见） ----------
const liveTaskBody = renderer.slice(renderer.indexOf('function liveTaskState()'), renderer.indexOf('function liveTaskBarMarkup('))
assert.ok(/String\(message\.content \|\| ''\)\.split\('\\n'\)/.test(liveTaskBody), '进度条应显示气泡最后一行，让吐字在输入区上方可见')

console.log('OK 生图规划流式吐字检查通过')
