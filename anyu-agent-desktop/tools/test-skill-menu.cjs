const fs = require('fs')
const vm = require('vm')

const source = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8')
const start = source.indexOf('  function skillMenuEntries(')
const end = source.indexOf('  function skillsMarketMarkup(', start)
if (start < 0 || end < 0) throw new Error('skill menu functions not found')

const state = {
  skillMenuOpen: true,
  skillMenuQuery: '',
  skillMenuActiveIndex: 0,
  skillEnabled: { image: true, video: true },
  skillConfigs: { image: { model: 'gpt-image-2' }, video: { model: 'sora-2' } },
  pluginState: { installed: [{ id: 'comic', displayName: '漫剧工具', keywords: ['分镜'], skills: [{ name: 'storyboard', description: '生成分镜' }] }] }
}
const context = {
  state,
  pluginList: () => state.pluginState.installed,
  skillModels: (kind) => kind === 'image' ? [{ name: 'gpt-image-2' }] : [{ name: 'sora-2' }],
  esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}
vm.runInNewContext(`${source.slice(start, end)}; this.skillMenuEntries = skillMenuEntries; this.filteredSkillMenuEntries = filteredSkillMenuEntries; this.skillMenuMarkup = skillMenuMarkup`, context)

const equal = (actual, expected, label) => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${label}: expected ${right}, got ${left}`)
}

// 覆盖内置媒体技能、插件技能、别名搜索和禁用状态，保证菜单目录可发现性稳定。
equal(context.skillMenuEntries().map((entry) => entry.id), ['image', 'video', 'plugin:comic:storyboard'], 'available skills')
state.pluginState.installed.push({ id: 'ai-image-analysis', displayName: 'AI 测图', enabled: true, skills: [{ name: 'ai-image-analysis' }] })
equal(context.skillMenuEntries().at(-1).label, '@测图', 'installed business skill alias')
state.pluginState.installed.at(-1).enabled = false
equal(context.skillMenuEntries().some((entry) => entry.label === '@测图'), false, 'disabled business skill hidden')
state.pluginState.installed.at(-1).enabled = true
equal(context.skillMenuEntries().at(-1).label, '@测图', 're-enabled business skill alias')
state.pluginState.installed.pop()
equal(context.skillMenuEntries().some((entry) => entry.label === '@测图'), false, 'uninstalled business skill hidden')
state.pluginState.installed.push({ id: 'tmall-public-feedback-analysis', enabled: true, skills: [{ name: 'tmall-public-feedback-analysis' }] })
equal(context.skillMenuEntries().at(-1).label, '@评价分析', 'installed feedback skill alias')
state.pluginState.installed.pop()
state.skillMenuQuery = 'video'
equal(context.filteredSkillMenuEntries().map((entry) => entry.id), ['video'], 'search by alias')
if (!context.skillMenuMarkup().includes('@生视频') || context.skillMenuMarkup().includes('@生图')) throw new Error('filtered menu rendered the wrong entries')
state.skillMenuQuery = '不存在'
equal(context.filteredSkillMenuEntries(), [], 'empty search')
if (!context.skillMenuMarkup().includes('没有匹配的技能')) throw new Error('empty state is missing')
state.skillEnabled.image = false
state.skillMenuQuery = ''
equal(context.skillMenuEntries().map((entry) => entry.id), ['video', 'plugin:comic:storyboard'], 'disabled skills are hidden')
state.pluginState.installed[0].enabled = false
equal(context.skillMenuEntries().map((entry) => entry.id), ['video'], 'disabled plugins are hidden')

console.log('skill menu search and filtering: passed')
