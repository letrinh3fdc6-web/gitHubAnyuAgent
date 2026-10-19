// 回归测试：切换模型在 Pi 不响应时不能把界面锁死，强度 pill 也不能永久置灰。
//
// 背景（线上真实故障）：
//   1. Pi 启动失败后切模型，set_model 的 15 秒主进程超时被直接 await，
//      输入栏连同模型选择器一起冻结十几秒，用户看到的就是"卡死转圈"。
//   2. set_model 与 syncThinkingLevels 共用同一个 try，set_model 一抛错就整体
//      跳过档位同步，state.thinkingLevels 停在初始 ['off']，强度 pill 永久置灰。
//   3. Pi 没起来时 syncThinkingLevels 仍会去发 set_thinking_level，再白等一次超时。
//
// 诊断脚本 tools/diagnose-model-switch.cjs 可以从行为上复现，这里补一层静态断言，
// 保证以后重构时不会把这几处保护删掉。
//
// 断言约定：label 描述"应该成立的事实"，条件为 true 才算通过。
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
const failures = []
const check = (label, condition) => { if (!condition) failures.push(label) }

function sliceBetween(startMarker, endMarker) {
  const from = source.indexOf(startMarker)
  if (from < 0) return ''
  const to = source.indexOf(endMarker, from)
  return to < 0 ? source.slice(from) : source.slice(from, to)
}

// ── 超时工具本身 ──
check('存在 piRequestWithTimeout 超时包装', /const piRequestWithTimeout = \(command, timeoutMs\) => Promise\.race\(/.test(source))
check('存在 MODEL_SWITCH_TIMEOUT_MS 常量', /const MODEL_SWITCH_TIMEOUT_MS = \d+/.test(source))

// ── activateModel：切模型不能长时间占着输入栏的锁 ──
const activateBody = sliceBetween('async function activateModel(', 'async function activateGroup(')
check('能定位到 activateModel', activateBody.length > 0)
check('activateModel 不再直接 await 裸的 set_model 命令', !/await window\.anyu\.piCommand\(\{ type: 'set_model'/.test(activateBody))
check('activateModel 给 set_model 套了超时', /piRequestWithTimeout\(\{[\s\S]{0,200}type: 'set_model'/.test(activateBody))
check('activateModel 给 startAgent 套了超时', /Promise\.race\(\[\s*startAgent\(/.test(activateBody))
check('activateModel 不再把 syncThinkingLevels 和 set_model 塞进同一个 try', !/await syncThinkingLevels\(\)\s*\}\s*catch/.test(activateBody))
check('activateModel 在解锁前用后台方式触发档位同步', /syncThinkingLevels\(\)\.then\(/.test(activateBody))
// 切换到模型的下拉框（备用布局）也必须走同一套超时保护，别漏成第二处裸调用。
check('全文件不再存在裸 await 的 set_model 命令', !/await window\.anyu\.piCommand\(\{ type: 'set_model'/.test(source))

// ── syncThinkingLevels：先用模板定档，Pi 的档位在后台覆盖 ──
const syncBody = sliceBetween('async function syncThinkingLevels()', 'async function refreshSessions(')
check('能定位到 syncThinkingLevels', syncBody.length > 0)
check('存在同步的 applyThinkingLevels 定档函数', /function applyThinkingLevels\(model, levels\)/.test(source))
check('syncThinkingLevels 第一步立刻定档（pill 不会先灰一帧）', /applyThinkingLevels\(model, modelThinkingLevels\(model\)\)/.test(syncBody))
check('syncThinkingLevels 的 get_available_thinking_levels 带超时', /piRequestWithTimeout\(\{ type: 'get_available_thinking_levels'/.test(syncBody))
check('syncThinkingLevels 的 set_thinking_level 带超时', /piRequestWithTimeout\(\{ type: 'set_thinking_level'/.test(syncBody))
check('syncThinkingLevels 对 piState 做了守卫（Pi 没起来就不发命令）', /state\.piState && state\.piState\.thinkingLevel !== state\.thinkingLevel/.test(syncBody))

// ── stderr：刷屏不能把整壳重建打成按帧刷新 ──
const stderrLine = source.split('\n').find((line) => line.includes('onPiStderr((message)'))
check('onPiStderr 不再逐条改 state.error', Boolean(stderrLine) && !/state\.error = message\.trim\(\)\.slice\(-500\)/.test(stderrLine))
check('存在 STDERR_NOTICE_INTERVAL_MS 节流间隔', /const STDERR_NOTICE_INTERVAL_MS = \d+/.test(source))
check('stderr 通知做了内容去重', /text === stderrNoticeText/.test(source))

if (failures.length) {
  console.error(`切换模型健壮性：${failures.length} 项未通过`)
  for (const item of failures) console.error(` - ${item}`)
  process.exit(1)
}
console.log('切换模型健壮性：通过（超时保护 · 档位独立同步 · stderr 节流）')
