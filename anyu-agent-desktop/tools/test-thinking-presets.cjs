// 思考强度模板库测试。
//
// 覆盖三层：
//   1. 模板库自身的不变量（档位合法、默认档在档位内、顺序稳定）
//   2. 各模型族命中正确的模板
//   3. 优先级：接口显式声明 > 模板 > 通用 > 兜底
//
// 用法：node tools/test-thinking-presets.cjs
const assert = require('node:assert')
const presets = require('../thinking-presets.js')

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`${name}: passed`)
  } catch (error) {
    console.error(`${name}: FAILED`)
    console.error(error?.message || error)
    process.exitCode = 1
  }
}

// ── 1. 模板库自身的不变量 ────────────────────────────────────────────────

check('模板库档位全部合法且顺序稳定', () => {
  assert.deepStrictEqual(presets.LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.strictEqual(presets.TEMPLATES.length > 0, true)
  for (const template of presets.TEMPLATES) {
    assert.ok(template.id && template.label, `模板缺少 id/label: ${JSON.stringify(template)}`)
    assert.ok(template.match instanceof RegExp, `模板 ${template.id} 的 match 必须是正则`)
    assert.ok(template.levels.length > 0, `模板 ${template.id} 没有档位`)
    for (const level of template.levels) {
      assert.ok(presets.isLevel(level), `模板 ${template.id} 出现非法档位 ${level}`)
    }
    // 档位必须按全库顺序排列，否则 UI 顺序会随模板漂移。
    assert.deepStrictEqual(template.levels, presets.LEVELS.filter((level) => template.levels.includes(level)), `模板 ${template.id} 档位顺序不对`)
    assert.ok(template.levels.includes(template.defaultLevel), `模板 ${template.id} 的默认档不在档位内`)
    for (const level of template.levels) {
      assert.ok(Object.prototype.hasOwnProperty.call(template.map, level), `模板 ${template.id} 的 map 缺少 ${level}`)
    }
  }
})

check('模板 id 不重复', () => {
  const ids = presets.TEMPLATES.map((template) => template.id)
  assert.strictEqual(new Set(ids).size, ids.length)
})

// ── 2. 各模型族命中正确模板 ──────────────────────────────────────────────

const cases = [
  ['gpt-5.6-turbo', 'openai-gpt5-max', 7],
  ['gpt-5.5', 'openai-gpt5-max', 7],
  ['gpt-5', 'openai-gpt5', 6],
  ['gpt-5-mini', 'openai-gpt5', 6],
  ['gpt-oss-120b', 'openai-gpt5', 6],
  ['o3-mini', 'openai-gpt5', 6],
  ['o4', 'openai-gpt5', 6],
  ['codex-mini-latest', 'openai-gpt5', 6],
  ['claude-sonnet-4-5', 'anthropic-thinking', 4],
  ['anthropic/claude-3-7-sonnet', 'anthropic-thinking', 4],
  ['gemini-3-pro-preview', 'google-gemini', 4],
  ['gemini-2.5-flash', 'google-gemini', 4],
  ['deepseek-r1', 'deepseek-reasoning', 4],
  ['DeepSeek-V4.1-Flash', 'deepseek-reasoning', 4],
  ['deepseek-v3.2', 'deepseek-reasoning', 4],
  ['qwen3-max', 'qwen-thinking', 4],
  ['qwq-32b', 'qwen-thinking', 4],
  ['glm-4.6', 'glm-thinking', 4],
  ['glm-z1-air', 'glm-thinking', 4],
  ['kimi-k2-thinking', 'kimi-thinking', 3],
  ['grok-4', 'grok-reasoning', 4],
  ['grok-code-fast-1', 'grok-reasoning', 4]
]

for (const [id, templateId, levelCount] of cases) {
  check(`模型 ${id} 命中模板 ${templateId}`, () => {
    const result = presets.resolveThinking({ id, api: 'openai-completions' })
    assert.strictEqual(result.templateId, templateId)
    assert.strictEqual(result.reasoning, true)
    assert.strictEqual(result.levels.length, levelCount)
    assert.strictEqual(result.source, 'template')
  })
}

check('未识别的模型只保留关闭档', () => {
  for (const id of ['anyu-turbo', 'gpt-4o-mini', 'deepseek-chat', 'moonshot-v1-8k', 'internal-llm-1']) {
    const result = presets.resolveThinking({ id, api: 'openai-completions' })
    assert.strictEqual(result.reasoning, false, `${id} 不应被判定为推理模型`)
    assert.deepStrictEqual(result.levels, ['off'])
    assert.strictEqual(result.defaultLevel, 'off')
  }
})

check('模板匹配同时看模型展示名', () => {
  // 目录里的 id 常常是内部代号，真正的模型名在展示名里，必须一起参与匹配。
  const result = presets.resolveThinking({ id: 'grp-1024-route', name: 'DeepSeek-V4.1-Flash', api: 'openai-completions' })
  assert.strictEqual(result.templateId, 'deepseek-reasoning')
})

// ── 3. 优先级 ────────────────────────────────────────────────────────────

check('接口显式 thinkingLevelMap 覆盖模板', () => {
  const result = presets.resolveThinking({
    id: 'claude-sonnet-4-5',
    api: 'anthropic-messages',
    thinkingLevelMap: { off: null, low: 'low', high: 'high' }
  })
  assert.strictEqual(result.source, 'api')
  assert.strictEqual(result.templateId, 'explicit-map')
  // off 在接口里被显式置为 null，表示该档不可用，必须被剔除。
  assert.deepStrictEqual(result.levels, ['low', 'high'])
  assert.deepStrictEqual(result.map, { off: null, low: 'low', high: 'high' })
})

check('接口显式 thinkingLevels 覆盖模板', () => {
  const result = presets.resolveThinking({ id: 'gpt-5', api: 'openai-responses', thinkingLevels: ['off', 'low', 'high'] })
  assert.strictEqual(result.source, 'api')
  assert.deepStrictEqual(result.levels, ['off', 'low', 'high'])
  // 映射表由档位生成，未列出的档必须为 null，否则 Pi 会以为它可用。
  assert.deepStrictEqual(result.map, { off: 'off', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null })
})

check('接口显式否定推理后不再套模板', () => {
  const result = presets.resolveThinking({ id: 'gpt-5-nano-nothink', api: 'openai-completions', reasoning: false })
  assert.strictEqual(result.reasoning, false)
  assert.deepStrictEqual(result.levels, ['off'])
  assert.strictEqual(result.source, 'api')
})

check('接口声明支持推理但未给档位时走通用档位', () => {
  const result = presets.resolveThinking({ id: 'some-new-model', api: 'openai-completions', reasoning: true })
  assert.strictEqual(result.source, 'generic')
  assert.strictEqual(result.templateId, 'generic-reasoning')
  assert.deepStrictEqual(result.levels, ['off', 'low', 'medium', 'high'])
  assert.strictEqual(result.defaultLevel, 'medium')
})

check('接口显式档位优先于 reasoning:false 的矛盾声明', () => {
  // 网关同时给出矛盾信号时，可操作的档位信息更有价值。
  const result = presets.resolveThinking({ id: 'x', reasoning: false, thinkingLevels: ['off', 'high'] })
  assert.deepStrictEqual(result.levels, ['off', 'high'])
  assert.strictEqual(result.source, 'api')
})

check('每个模型族的默认档位都是 medium', () => {
  for (const [id] of cases) {
    const result = presets.resolveThinking({ id })
    assert.strictEqual(result.defaultLevel, 'medium', `${id} 的默认档位应为 medium`)
  }
})

// ── 4. 工具函数 ──────────────────────────────────────────────────────────

check('normalizeLevels 去重并按全库顺序排序', () => {
  assert.deepStrictEqual(presets.normalizeLevels(['high', 'off', 'high', 'low']), ['off', 'low', 'high'])
  assert.deepStrictEqual(presets.normalizeLevels(['bogus', 'medium']), ['medium'])
  assert.deepStrictEqual(presets.normalizeLevels(null), [])
  assert.deepStrictEqual(presets.normalizeLevels('high'), [])
})

check('levelsFromMap 跳过 null 与 false', () => {
  assert.deepStrictEqual(presets.levelsFromMap({ off: 'none', low: null, medium: 'medium', high: false }), ['off', 'medium'])
  assert.deepStrictEqual(presets.levelsFromMap(null), [])
  assert.deepStrictEqual(presets.levelsFromMap(['off']), [])
})

check('pickDefault 优先 medium', () => {
  assert.strictEqual(presets.pickDefault(['off', 'low', 'medium', 'high']), 'medium')
  assert.strictEqual(presets.pickDefault(['off']), 'off')
  assert.strictEqual(presets.pickDefault(['low', 'high']), 'low')
  assert.strictEqual(presets.pickDefault([]), 'off')
})

check('cycle 在给定档位内循环并正确回绕', () => {
  const levels = ['off', 'low', 'medium']
  assert.strictEqual(presets.cycle(levels, 'off', 1), 'low')
  assert.strictEqual(presets.cycle(levels, 'medium', 1), 'off')
  assert.strictEqual(presets.cycle(levels, 'off', -1), 'medium')
  // 当前档不在列表里时回到第一档，避免留下无效状态。
  assert.strictEqual(presets.cycle(levels, 'max', 1), 'off')
  assert.strictEqual(presets.cycle([], 'off', 1), 'off')
})

check('文案与图标对每个合法档位都有定义', () => {
  for (const level of presets.LEVELS) {
    assert.ok(presets.label(level) && presets.label(level) !== level, `档位 ${level} 缺少中文名`)
    assert.ok(presets.icon(level), `档位 ${level} 缺少图标`)
    assert.ok(presets.describe(level), `档位 ${level} 缺少说明`)
  }
})

check('模块可在浏览器环境下挂到全局对象', () => {
  // 渲染层拿不到 module，必须靠 globalThis 挂载；这里模拟浏览器加载路径。
  const vm = require('node:vm')
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'thinking-presets.js'), 'utf8')
  const sandbox = { globalThis: undefined }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox)
  assert.ok(sandbox.LetaThinkingPresets, '浏览器环境下未挂载 LetaThinkingPresets')
  assert.deepStrictEqual(sandbox.LetaThinkingPresets.resolveThinking({ id: 'gpt-5' }).levels.length, 6)
})

console.log(`\n${passed} passed${process.exitCode ? ', 有失败' : ''}`)
