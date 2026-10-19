const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const rendererDir = path.join(__dirname, '..', 'renderer')
const appSource = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8')
const styleSource = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8')

const start = appSource.indexOf('  const APPEARANCE_THEMES = [')
const end = appSource.indexOf('  const state = {', start)
assert(start >= 0 && end > start, '无法在 renderer/app.js 中定位外观主题定义')

// 用桩件承载 localStorage 与 document，直接执行 app.js 里那段真实代码，
// 避免测试复刻一份主题逻辑导致与实现漂移。
const stored = { 'anyu.appearanceTheme': 'rice' }
const documentStub = { documentElement: { dataset: {} } }
const localStorageStub = {
  getItem: (key) => (Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null),
  setItem: (key, value) => { stored[key] = String(value) }
}
const sandbox = { document: documentStub, localStorage: localStorageStub, console }
vm.runInNewContext(
  `${appSource.slice(start, end)}\nthis.APPEARANCE_THEMES = APPEARANCE_THEMES\nthis.normalizeAppearanceTheme = normalizeAppearanceTheme\nthis.persistAppearanceTheme = persistAppearanceTheme\nthis.applyAppearanceTheme = applyAppearanceTheme\n`,
  sandbox
)

const themes = sandbox.APPEARANCE_THEMES
const ids = themes.map((theme) => theme.id)
const fallback = ids[0]
// 默认主题不重复声明令牌，直接复用裸 :root 上的默认值。
const defaultTokensLiveInRoot = /(^|\n):root \{[\s\S]*?--anyu-canvas:/.test(styleSource)

// 主题清单本身必须是可用作选择器与 localStorage 值的稳定标识。
assert(Array.isArray(themes) && themes.length >= 6, `外观主题应不少于 6 个，实际 ${themes.length}`)
assert.strictEqual(new Set(ids).size, ids.length, `主题 id 存在重复：${ids.join(', ')}`)
for (const theme of themes) {
  assert(/^[a-z][a-z0-9-]*$/.test(theme.id), `主题 id 必须是小写短横线标识：${theme.id}`)
  assert(theme.name && theme.hint, `主题 ${theme.id} 缺少名称或说明`)
  const hasTokens = theme.id === fallback
    ? defaultTokensLiveInRoot
    : styleSource.includes(`:root[data-anyu-theme="${theme.id}"]`)
  assert(hasTokens, theme.id === fallback ? ':root 缺少默认主题令牌' : `styles.css 缺少 :root[data-anyu-theme="${theme.id}"] 令牌`)
  assert(styleSource.includes(`.appearance-card[data-appearance-theme="${theme.id}"]`), `styles.css 缺少 ${theme.id} 的预览缩略图配色`)
}
console.log(`theme registry: passed (${ids.join(', ')})`)

// 反向检查：样式表里不能再有 JS 未登记的主题令牌，防止删主题后留下孤儿样式。
// 默认主题走裸 :root，不会出现在 [data-anyu-theme] 选择器里。
const declaredIds = [...styleSource.matchAll(/:root\[data-anyu-theme="([a-z0-9-]+)"\]/g)].map((match) => match[1])
const orphanIds = declaredIds.filter((id) => !ids.includes(id))
assert.strictEqual(orphanIds.length, 0, `styles.css 存在未在 app.js 登记的主题：${orphanIds.join(', ')}`)
assert.strictEqual(new Set(declaredIds).size, declaredIds.length, 'styles.css 中主题令牌重复声明')
assert.strictEqual(declaredIds.length, ids.length - 1, '除默认主题外的每套主题都应有一条 [data-anyu-theme] 令牌')
console.log('theme stylesheet parity: passed')

// 令牌引用与声明必须闭环：拼错变量名 CSS 不会报错，只会静默失效，必须静态拦住。
const usedTokens = new Set([...styleSource.matchAll(/var\((--anyu-[a-z0-9-]+)/g)].map((match) => match[1]))
const declaredTokens = new Set([...styleSource.matchAll(/(--anyu-[a-z0-9-]+)\s*:/g)].map((match) => match[1]))
const missingTokens = [...usedTokens].filter((name) => !declaredTokens.has(name))
assert.strictEqual(missingTokens.length, 0, `styles.css 引用了未声明的令牌：${missingTokens.join(', ')}`)
assert(declaredTokens.has('--anyu-canvas') && declaredTokens.has('--anyu-ink') && declaredTokens.has('--anyu-accent'), '缺少基础外观令牌')
for (const name of ['--anyu-canvas', '--anyu-chrome', '--anyu-ink', '--anyu-accent', '--anyu-primary', '--anyu-bubble', '--anyu-conversation']) {
  const themeBlocks = styleSource.split(/:root\[data-anyu-theme="/).slice(1)
  for (const [index, block] of themeBlocks.entries()) {
    assert(block.includes(`${name}:`), `第 ${index + 1} 套主题令牌缺少 ${name}`)
  }
}
console.log('theme tokens closed loop: passed')

// 启动阶段就应该把已保存的主题写到 <html>，避免首帧闪回默认配色。
assert.strictEqual(documentStub.documentElement.dataset.anyuTheme, 'rice', '启动时应应用 localStorage 中已保存的主题')

// 默认主题也写入 data 属性，保证 DOM 状态始终明确。
sandbox.applyAppearanceTheme('')
assert.strictEqual(documentStub.documentElement.dataset.anyuTheme, fallback, '空值应回落默认主题')

sandbox.applyAppearanceTheme('not-a-theme')
assert.strictEqual(documentStub.documentElement.dataset.anyuTheme, fallback, '未知主题应回落默认主题')

const applied = sandbox.persistAppearanceTheme('navy')
assert.strictEqual(applied, 'navy', 'persistAppearanceTheme 应返回规范化后的主题 id')
assert.strictEqual(stored['anyu.appearanceTheme'], 'navy', '主题应写入 localStorage')
assert.strictEqual(documentStub.documentElement.dataset.anyuTheme, 'navy', '主题应立即生效')

assert.strictEqual(sandbox.persistAppearanceTheme('bogus'), fallback, '未知主题持久化后应回落默认值')
assert.strictEqual(stored['anyu.appearanceTheme'], fallback, '回落结果同样需要落盘')
console.log('theme persistence: passed')

// 设置页必须真的有入口，否则主题无法被用户选择。
assert(appSource.includes('data-settings-section="appearance"'), '设置导航缺少外观入口')
assert(/\[\s*'general',\s*'appearance',\s*'skills',\s*'plugins'\s*\]/.test(appSource), '设置分区白名单未包含 appearance')
assert(/data-appearance-theme="\$\{esc\(theme\.id\)\}"/.test(appSource), '外观卡片未输出主题 id')
console.log('settings entry: passed')

console.log('appearance theme: passed')
