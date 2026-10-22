/**
 * 思考强度模板库 —— 主进程与渲染进程共用的唯一事实来源。
 *
 * 背景：不同模型族支持的推理强度档位并不一样。GPT-5 系可以一路开到 xhigh，
 * Claude 走 extended thinking，Gemini 只有 low/high 两档，普通对话模型则完全
 * 不支持。过去这套判断在 main.cjs 与 renderer/app.js 里各写了一份正则，两边容易
 * 漂移；现在统一收敛成这份模板库。
 *
 * 加载方式：
 *   主进程   const presets = require('./thinking-presets.js')
 *   渲染进程 <script src="./thinking-presets.js"></script> → globalThis.LetaThinkingPresets
 *
 * 档位解析优先级（高 → 低）：
 *   1. 接口显式声明的 thinkingLevelMap / thinkingLevels（最权威，直接照用）
 *   2. 接口显式声明 reasoning === false（明确否定，不再猜）
 *   3. 本模板库按模型名匹配到的模板
 *   4. 接口只说"支持推理"但没给档位 → 通用四档
 *   5. 兜底：不支持推理强度，只有 off
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.LetaThinkingPresets = factory()
})(typeof globalThis === 'object' ? globalThis : this, function () {
  // 全库统一的档位顺序，由弱到强。任何模板都只能使用这里的档位。
  const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

  const LABELS = {
    off: '关闭',
    minimal: '最小',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最大'
  }

  // 简写图标，用于输入栏的强度 pill。
  // 注意：绝对不要用空心圆/扇形圆（○◔◑◕）当图标——应用里“转圈加载”就是圆圈，
  // 用户会把它们当成一直在加载。这里统一用“档位刻度”：越高越满，一眼是档位不是 loading。
  const ICONS = {
    off: '×',
    minimal: '▁',
    low: '▃',
    medium: '▅',
    high: '▇',
    xhigh: '█',
    max: '★'
  }

  const DESCRIPTIONS = {
    off: '不进行额外推理，响应最快',
    minimal: '极少推理，适合简单改错与格式调整',
    low: '轻度推理，适合日常问答',
    medium: '均衡推理，默认档位',
    high: '深度推理，适合复杂改造与排错',
    xhigh: '极高推理，耗时与消耗明显增加',
    max: '最大推理，仅建议疑难问题使用'
  }

  const NOTE = '模型未声明推理能力时的通用档位'

  /**
   * 模板库本体。按数组顺序匹配，第一条命中的生效，所以更具体的规则必须排在前面。
   *
   * levels       该族模型实际可用的档位
   * map          档位 → 厂商参数名；null 表示厂商不区分级别
   * defaultLevel 首次切换到该模型时的默认档位
   */
  const TEMPLATES = [
    {
      id: 'openai-gpt5-max',
      label: 'GPT-5.5 及以上',
      match: /gpt-5\.(?:[5-9]|\d\d)|gpt-6/i,
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      map: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      defaultLevel: 'medium'
    },
    {
      id: 'openai-gpt5',
      label: 'GPT-5 / o 系列 / Codex',
      match: /gpt-5|gpt-oss|\bo[1-9]\b|\bo[1-9]-|codex/i,
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      map: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
      defaultLevel: 'medium'
    },
    {
      id: 'anthropic-thinking',
      label: 'Claude 扩展思考',
      match: /claude|anthropic/i,
      levels: ['off', 'low', 'medium', 'high'],
      map: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
      defaultLevel: 'medium'
    },
    {
      id: 'google-gemini',
      label: 'Gemini 思考等级',
      match: /gemini|google/i,
      levels: ['off', 'low', 'medium', 'high'],
      map: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
      defaultLevel: 'medium'
    },
    {
      // https://api-docs.deepseek.com/guides/thinking_mode/
      // DeepSeek 思考模式默认开启；OpenAI 格式的 effort 只认 low/high/max
      // （minimal/medium/xhigh/ultra 由服务端映射）。标准 OpenAI 通道传不了
      // thinking.type=disabled，所以不提供 off 档——"关闭思考"留给网关侧协议转换。
      id: 'deepseek-reasoning',
      label: 'DeepSeek 推理模型',
      match: /deepseek-(?:r\d|v[3-9]|.*reasoner|.*thinking)|deepseek-reasoner/i,
      levels: ['low', 'medium', 'high'],
      map: { low: 'low', medium: 'medium', high: 'high' },
      defaultLevel: 'medium'
    },
    {
      // https://docs.bigmodel.cn/cn/guide/start/concept-param/
      // GLM-5.3 / 5.3-FLASH / 5.3-FLASHX 强制开启思考（传 disabled 会报错），
      // reasoning_effort 仅支持 low/high/max；medium 由客户端映射为 high。
      id: 'glm-5.3-thinking',
      label: 'GLM-5.3 强制思考',
      match: /glm-5\.3/i,
      levels: ['low', 'medium', 'high'],
      map: { low: 'low', medium: 'high', high: 'max' },
      defaultLevel: 'medium'
    },
    {
      // GLM-5.2 起支持 reasoning_effort，且 none/minimal 表示放弃思考（等于关闭）；
      // 5.1 及以下不支持该参数，匹配不到模板即不提供档位，避免发非法参数。
      id: 'glm-thinking',
      label: 'GLM 推理模型',
      match: /glm-4\.6|glm-5\.[2-9]|glm-z\d|z1/i,
      levels: ['off', 'low', 'medium', 'high'],
      map: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
      defaultLevel: 'medium'
    },
    {
      // https://platform.moonshot.cn/docs/guide/use-thinking-effort
      // Kimi K3 始终思考且保留式思考恒开，顶层 reasoning_effort 仅 low/high/max
      // （默认 max）；不支持 thinking 参数。medium 由客户端映射为 high。
      id: 'kimi-thinking',
      label: 'Kimi 思考模型',
      match: /kimi-(?:k2.*thinking|k3)/i,
      levels: ['low', 'medium', 'high'],
      map: { low: 'low', medium: 'high', high: 'max' },
      defaultLevel: 'medium'
    },
    {
      id: 'qwen-thinking',
      label: 'Qwen 思考模型',
      match: /qwen3|qwq|qwen.*thinking/i,
      levels: ['off', 'low', 'medium', 'high'],
      map: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
      defaultLevel: 'medium'
    },
    {
      id: 'grok-reasoning',
      label: 'Grok 推理模型',
      match: /grok-[3-9]|grok.*reason|grok-code/i,
      levels: ['off', 'low', 'medium', 'high'],
      map: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
      defaultLevel: 'medium'
    }
  ]

  // 通用档位：接口声明了推理能力但没给出具体档位时使用。
  const GENERIC_TEMPLATE = {
    id: 'generic-reasoning',
    label: '通用推理档位',
    levels: ['off', 'low', 'medium', 'high'],
    map: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
    defaultLevel: 'medium'
  }

  const NONE_TEMPLATE = {
    id: 'none',
    label: '不支持推理强度',
    reasoning: false,
    levels: ['off'],
    map: null,
    defaultLevel: 'off'
  }

  function isLevel(value) {
    return LEVELS.includes(String(value || '').toLowerCase())
  }

  function normalizeLevels(values) {
    if (!Array.isArray(values)) return []
    const mapped = values.map((value) => String(value || '').toLowerCase()).filter(isLevel)
    // 固定按全库顺序输出，避免不同接口给的顺序不一致导致 UI 跳来跳去。
    return LEVELS.filter((level) => mapped.includes(level))
  }

  /**
   * 从厂商映射表反推可用档位。
   * 约定：值为 null / undefined 表示该档位不适用；布尔值按"是否支持"理解。
   */
  function levelsFromMap(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return []
    return LEVELS.filter((level) => {
      if (!Object.prototype.hasOwnProperty.call(map, level)) return false
      const value = map[level]
      return value !== null && value !== undefined && value !== false
    })
  }

  /** 由档位列表生成映射表，值保持同名，交给 Pi 侧翻译成厂商参数。 */
  function mapFromLevels(levels) {
    return Object.fromEntries(LEVELS.map((level) => [level, levels.includes(level) ? level : null]))
  }

  /** 默认档位：优先 medium，其次是中间档，最后退到最后一档。 */
  function pickDefault(levels) {
    if (!levels.length) return 'off'
    if (levels.includes('medium')) return 'medium'
    if (levels.length === 1) return levels[0]
    return levels[Math.floor((levels.length - 1) / 2)]
  }

  /** 按模型 id、展示名与协议一起匹配模板。 */
  function matchTemplate(haystack) {
    const text = String(haystack || '')
    return TEMPLATES.find((template) => template.match.test(text)) || null
  }

  /**
   * 解析一个模型的实际思考强度能力。
   *
   * @param {object} model 形如 { id, name, api, reasoning, thinkingLevels, thinkingLevelMap }
   * @returns {{ reasoning:boolean, levels:string[], map:object|null, defaultLevel:string,
   *             templateId:string, templateLabel:string, source:'api'|'template'|'generic'|'none' }}
   */
  function resolveThinking(model = {}) {
    if (model.thinking && typeof model.thinking === 'object') {
      const capability = model.thinking
      const levels = normalizeLevels((capability.levels || []).map(level => level === 'on' ? 'high' : level))
      if (!levels.length) levels.push(capability.mode === 'fixed' ? 'high' : 'off')
      const defaultLevel = levels.includes(capability.default_level) ? capability.default_level : pickDefault(levels)
      return { reasoning: capability.mode !== 'none', levels, map: mapFromLevels(levels), defaultLevel, templateId: capability.family, templateLabel: '模型能力目录', source: 'api' }
    }
    const id = String(model.id || model.modelId || model.model_id || '')
    const name = String(model.name || model.display_name || model.displayName || '')
    const api = String(model.api || '')
    // 模板匹配同时看 id、展示名与协议：目录里有的模型 id 是代号，真正的名字在展示名里。
    const haystack = `${id} ${name} ${api}`
    const explicitLevels = normalizeLevels(model.thinkingLevels || model.thinking_levels || model.reasoning_levels || model.reasoningLevels)
    const explicitMap = model.thinkingLevelMap || model.thinking_level_map || model.reasoning_effort_map || model.reasoningEffortMap

    // 1. 接口显式声明最权威，直接照用，不再套模板。
    if (explicitMap && typeof explicitMap === 'object' && !Array.isArray(explicitMap)) {
      const levels = levelsFromMap(explicitMap)
      if (levels.length) {
        return { reasoning: true, levels, map: { ...explicitMap }, defaultLevel: pickDefault(levels), templateId: 'explicit-map', templateLabel: '接口声明', source: 'api' }
      }
    }
    if (explicitLevels.length) {
      return { reasoning: true, levels: explicitLevels, map: mapFromLevels(explicitLevels), defaultLevel: pickDefault(explicitLevels), templateId: 'explicit-levels', templateLabel: '接口声明', source: 'api' }
    }

    // 2. 接口明确否定推理能力时不再猜。
    //    例外：后端目录接口曾对国产模型族一律下发 reasoning:false（历史遗留判定只认
    //    gpt-/claude-/gemini-），该字段对国产模型不可信——照单全收会让 DeepSeek/GLM/Kimi
    //    全部失去档位。这里对国产模型族跳过显式否定，交给下面的模板库按官方文档判定。
    const CN_MODEL_FAMILY = /deepseek|glm|kimi|qwen|minimax/i
    if (!CN_MODEL_FAMILY.test(haystack) && (model.reasoning === false || model.supports_reasoning === false || model.supportsReasoning === false)) {
      return { ...NONE_TEMPLATE, levels: ['off'], source: 'api' }
    }

    // 3. 模板库。
    const template = matchTemplate(haystack)
    if (template) {
      return {
        reasoning: true,
        levels: [...template.levels],
        map: { ...template.map },
        defaultLevel: template.defaultLevel,
        templateId: template.id,
        templateLabel: template.label,
        source: 'template'
      }
    }

    // 4. 接口只说支持推理但没给档位。
    if (model.reasoning === true || model.supports_reasoning === true || model.supportsReasoning === true) {
      return { reasoning: true, levels: [...GENERIC_TEMPLATE.levels], map: { ...GENERIC_TEMPLATE.map }, defaultLevel: GENERIC_TEMPLATE.defaultLevel, templateId: GENERIC_TEMPLATE.id, templateLabel: GENERIC_TEMPLATE.label, source: 'generic' }
    }

    // 5. 兜底。
    return { ...NONE_TEMPLATE, levels: ['off'], source: 'none' }
  }

  const indexOf = (level) => {
    const position = LEVELS.indexOf(String(level || '').toLowerCase())
    return position < 0 ? -1 : position
  }

  /** 在给定档位集合里向上/向下循环切换，用于快捷键与点击切换。 */
  function cycle(levels, current, direction = 1) {
    const list = normalizeLevels(levels)
    if (!list.length) return 'off'
    const position = list.indexOf(String(current || '').toLowerCase())
    if (position < 0) return list[0]
    const next = (position + direction + list.length) % list.length
    return list[next]
  }

  return {
    LEVELS,
    LABELS,
    ICONS,
    DESCRIPTIONS,
    NOTE,
    TEMPLATES,
    label: (level) => LABELS[level] || level,
    icon: (level) => ICONS[level] || ICONS.medium,
    describe: (level) => DESCRIPTIONS[level] || '',
    isLevel,
    normalizeLevels,
    levelsFromMap,
    mapFromLevels,
    pickDefault,
    matchTemplate,
    resolveThinking,
    cycle,
    indexOf
  }
})
