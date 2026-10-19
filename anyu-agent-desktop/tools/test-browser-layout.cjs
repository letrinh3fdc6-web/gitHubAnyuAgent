const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { normalizeBrowserBounds } = require('../browser-layout.cjs')

assert.deepEqual(
  normalizeBrowserBounds({ x: 720, y: 90, width: 420, height: 650 }, { width: 1200, height: 800 }),
  { x: 720, y: 90, width: 420, height: 650 }
)
assert.deepEqual(
  normalizeBrowserBounds({ x: 950, y: 720, width: 400, height: 200 }, { width: 1200, height: 800 }),
  { x: 950, y: 720, width: 250, height: 80 }
)
assert.equal(normalizeBrowserBounds({ x: 10, y: 10, width: 0, height: 100 }, { width: 800, height: 600 }), null)
assert.equal(normalizeBrowserBounds({ x: Number.NaN, y: 10, width: 100, height: 100 }, { width: 800, height: 600 }), null)

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8')
const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8')
assert(main.includes("ipcMain.on('agent-browser:set-bounds'"), '主进程没有接收浏览器区域坐标')
assert(main.includes('browserView.setVisible(false)'), '浏览器区域缺失时原生视图没有隐藏')
assert(!main.includes('return { x: 0, y: 70,'), '浏览器仍使用覆盖窗口左侧的固定坐标')
assert(renderer.includes("host.id = 'agent-browser-host'"), '渲染层缺少浏览器独立区域')
assert(renderer.includes('browserSetBounds'), '渲染层没有同步实际浏览器区域')
assert(styles.includes('.conversation.browser-layout'), '聊天区没有为右侧浏览器预留独立栏位')
console.log('browser layout bounds and renderer contract: passed')
