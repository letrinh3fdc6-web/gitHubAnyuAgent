// 全窗口拖放回归测试：拖拽必须先出现大区域面板，且只能由 window 统一处理一次。
// 之前 composer-box 上的局部 drop 监听会和新的 window 监听同时触发，导致同一张图被添加两次。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8')

assert.match(app, /function ensureDropOverlay/, '渲染层需要创建拖放面板')
assert.match(app, /drop-overlay-panel/, '拖放面板需要大区域内容容器')
assert.match(css, /\.drop-overlay\.active\s*\{/, 'CSS 需要提供拖放面板的显示状态')
assert.match(css, /\.drop-overlay\s*\{[^}]*pointer-events:\s*none/, '拖放面板必须 pointer-events:none，事件才能落到 window')

// 只允许一套 drag/drop 监听，且必须挂在 window 上。
const dropListeners = app.match(/addEventListener\('(?:drop|dragover|dragenter|dragleave)'/g) || []
assert.strictEqual(dropListeners.length, 4, `drag/drop 监听数量应为 4，实际 ${dropListeners.length}`)
assert.ok(!/composerBox\?\.addEventListener\('drop'/.test(app), '不得保留 composer-box 上的局部 drop 监听')

console.log('drop overlay tests passed')
