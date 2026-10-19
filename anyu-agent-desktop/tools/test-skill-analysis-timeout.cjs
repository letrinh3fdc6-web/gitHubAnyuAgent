const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')

// 技能分析超时策略（评价分析 HTML 报告丢失的根因修复）：
//   旧实现：固定 5 分钟总时长超时 —— 慢模型写长 HTML 报告必然被杀，
//           analysisHtml 存不进去，HTML 产物和右侧预览“消失”。
//   新实现：哑火检测（连续无输出才掐）+ 总时长上限兜底。
//   1) 源码层面不允许再出现“固定总时长 5 分钟”；
//   2) 只要持续有 stdout 输出，即使超过哑火窗口也不得中断（行为验证）；
//   3) 输出停滞后按哑火窗口超时（行为验证）；
//   4) 正常流式完成后 resolve 全文（行为验证）。
const source = fs.readFileSync('skill-analysis.cjs', 'utf8')
const localFeedbackSource = fs.readFileSync('local-feedback.cjs', 'utf8')

assert.ok(!/5 \* 60 \* 1000/.test(source), '不得再出现固定 5 分钟总时长超时')
assert.ok(/ANALYSIS_STALL_TIMEOUT_MS/.test(source) && /ANALYSIS_MAX_TOTAL_MS/.test(source), '缺少哑火/总时长常量')
assert.ok(/armStallTimer\(\)/.test(source), '缺少哑火计时器重置调用')
assert.ok(/child\.stderr\.on\('data', \(\) => \{ armStallTimer\(\) \}\)/.test(source), 'stderr 输出也必须重置哑火计时器')
// 报告阶段必须有进度心跳（否则长时间无反馈，用户以为“加载没有了”）
assert.ok(/正在撰写完整可视化报告…/.test(localFeedbackSource), '报告阶段缺少进度心跳')
assert.ok(/this\.analyze\(modelPrompt, \[\], \(partial\) =>/.test(localFeedbackSource), '报告阶段未传进度回调')

// ---------- 行为验证：假子进程 ----------
function makeFakeSpawn(script) {
  return function fakeSpawn() {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write: () => {}, end: () => {} }
    child.kill = () => { child.killed = true }
    const line = (event) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`))
    const assistantEnd = (text) => line({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } })
    queueMicrotask(() => script(line, assistantEnd, child))
    return child
  }
}

async function run(script, options = {}) {
  const { analyzeWithPi } = require('../skill-analysis.cjs')
  return analyzeWithPi({ executable: 'pi', provider: 'p', model: 'm', cwd: '.', env: {}, prompt: 'x', spawnProcess: makeFakeSpawn(script), stallTimeoutMs: 250, maxTotalMs: 5000, ...options })
}

async function main() {
  // 1) 正常完成：message_end + agent_end → resolve 全文
  const text = await run((line, assistantEnd) => { assistantEnd('# 报告正文'); line({ type: 'agent_end' }) })
  assert.equal(text, '# 报告正文')

  // 2) 持续有输出就绝不被掐：输出频率低于哑火窗口的一半也不行——这里刻意让
  //    每次输出间隔 > 哑火窗口的一半，但 < 窗口本身，验证“有输出就续命”。
  let ticks = 0
  const slow = await run((line, assistantEnd, child) => {
    const pump = setInterval(() => {
      ticks += 1
      child.stdout.emit('data', Buffer.from(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"第${ticks}段"}}\n`))
      if (ticks >= 4) { clearInterval(pump); assistantEnd('慢但没死'); line({ type: 'agent_end' }) }
    }, 180) // 间隔 180ms > 250ms/2，但 < 250ms 哑火窗口
  })
  assert.equal(slow, '慢但没死')
  assert.ok(ticks >= 4)

  // 3) 哑火超时：输出一点正文（不发 agent_end），然后彻底沉默 → 按 250ms 哑火窗口判死
  await assert.rejects(
    run((line, assistantEnd) => { assistantEnd('开头') }, { stallTimeoutMs: 250 }).then(() => { throw new Error('不应成功') }),
    (error) => /没有任何输出/.test(error.message)
  )

  // 4) 总时长兜底：持续输出但永远不给 agent_end → maxTotalMs 兜底
  await assert.rejects(
    run((line, assistantEnd, child) => {
      const pump = setInterval(() => {
        // finish() 会 kill 假子进程：见 killed 就停泵，否则事件循环被 interval 挂住，测试进程永不退出。
        if (child.killed) { clearInterval(pump); return }
        child.stdout.emit('data', Buffer.from(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"x"}}\n`))
      }, 50)
    }, { maxTotalMs: 400 }).then(() => { throw new Error('不应成功') }),
    (error) => /总时长超过/.test(error.message)
  )

  console.log('OK 技能分析超时策略检查通过')
}

main().catch((error) => { console.error(error); process.exit(1) })
