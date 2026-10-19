const assert = require('node:assert/strict')
const fs = require('node:fs')

// 图片灯箱被内置浏览器盖死：
//   右侧内置浏览器不是 DOM，而是主进程的原生 BrowserView（定位到 #agent-browser-host），
//   原生视图永远绘制在所有 HTML 之上，灯箱的 z-index:30 对它无效。
//   修复：全屏遮罩打开时渲染层上报 null → 主进程 browserView.setVisible(false)；
//   遮罩关闭后 renderApp 再同步真实矩形恢复显示。
const renderer = fs.readFileSync('renderer/app.js', 'utf8')
const main = fs.readFileSync('main.cjs', 'utf8')

// ---------- 1) 遮罩优先：必须在读取 host 之前判断 ----------
const syncStart = renderer.indexOf('function scheduleBrowserBoundsSync()')
const syncBody = renderer.slice(syncStart, renderer.indexOf('window.addEventListener(\'resize\'', syncStart))
assert.ok(syncBody.includes('state.imagePreview || state.permission'), '遮罩打开时必须上报 null 隐藏原生 BrowserView')
const overlayIdx = syncBody.indexOf('state.imagePreview || state.permission')
const hostIdx = syncBody.indexOf("document.querySelector('#agent-browser-host')")
assert.ok(overlayIdx >= 0 && hostIdx > overlayIdx, '遮罩判断必须先于 host 查找，避免遮罩下仍上报矩形')

// ---------- 2) 遮罩的开与关都会触发 renderApp（renderApp 末尾同步 bounds） ----------
const previewHandler = renderer.slice(renderer.indexOf("document.querySelectorAll('[data-image-preview]')"), renderer.indexOf('scheduleBrowserBoundsSync()\n  }\n\n', 0) > 0 ? renderer.length : renderer.length)
assert.ok(/state\.imagePreview = image; renderApp\(\)/.test(renderer), '打开图片预览必须走 renderApp 触发布局同步')
assert.ok(/state\.imagePreview = null; renderApp\(\)/.test(renderer), '关闭图片预览必须走 renderApp 恢复浏览器')
assert.ok(/if \(\['confirm', 'select', 'input'\]\.includes\(event\.method\)\) \{ state\.permission = event; renderApp\(\) \}/.test(renderer), '权限弹窗出现必须走 renderApp')
assert.ok(/state\.permission = null; renderApp\(\)/.test(renderer), '权限弹窗关闭必须走 renderApp')
assert.ok(/renderApp\(\)\n    state\.renderedSessionPath|scheduleBrowserBoundsSync\(\)\n  \}/.test(renderer) || /scheduleBrowserBoundsSync\(\)/.test(renderer.slice(renderer.indexOf('function renderApp()'), renderer.indexOf('function attachmentId()'))), 'renderApp 必须调用 scheduleBrowserBoundsSync')

// ---------- 3) 主进程：null 边界 = 隐藏 ----------
const setBounds = main.slice(main.indexOf('function setBrowserBounds('), main.indexOf('function isAllowedBrowserUrl('))
assert.ok(setBounds.includes('if (!bounds) {') && setBounds.includes('browserView.setVisible(false)'), '主进程收到 null 边界必须隐藏 BrowserView')
assert.ok(setBounds.includes('browserView.setVisible(true)'), '恢复边界时必须重新显示')
assert.ok(main.includes("ipcMain.on('agent-browser:set-bounds', (_, bounds) => setBrowserBounds(bounds))"), '渲染层的边界上报必须落到 setBrowserBounds')

// ---------- 4) 灯箱本身在 HTML 层级之上（对其他 DOM 生效） ----------
const css = fs.readFileSync('renderer/styles.css', 'utf8')
assert.ok(/\.image-lightbox \{[^}]*z-index: 30/.test(css), '灯箱 z-index 应高于其它遮罩（对原生视图仍需隐藏浏览器）')

console.log('OK 图片灯箱与内置浏览器层级检查通过')
