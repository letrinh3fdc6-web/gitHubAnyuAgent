const assert = require('node:assert/strict')
const fs = require('node:fs')

// 点击列表下方的历史会话时，侧栏列表会“往上弹”：
//   renderApp 用整壳 innerHTML 重建界面，#session-list 是新节点，scrollTop 归零；
//   旧的 renderSessionList 还会对激活项 scrollIntoView，把它强行拽回视野。
//   要求：列表滚到哪里就停在哪里，任何重绘都不许自动滚动。
const src = fs.readFileSync('renderer/app.js', 'utf8')

// ---------- 1) renderApp 必须先记录再还原会话列表滚动位置 ----------
const renderStart = src.indexOf('  function renderApp() {')
const renderBody = src.slice(renderStart, src.indexOf('  function attachmentId()', renderStart))
const captureIdx = renderBody.indexOf("const sessionListScroll = Number(document.querySelector('#session-list')?.scrollTop || 0)")
const htmlIdx = renderBody.indexOf('root.innerHTML = `<div class="app-shell">')
const restoreIdx = renderBody.indexOf("const sessionList = document.querySelector('#session-list')\n    if (sessionList && sessionListScroll) sessionList.scrollTop = sessionListScroll")
assert.ok(captureIdx >= 0, 'renderApp 必须在重建前记录 #session-list 的 scrollTop')
assert.ok(htmlIdx > captureIdx, '记录必须发生在整壳 innerHTML 重建之前')
assert.ok(restoreIdx > htmlIdx, '重建之后必须原样还原会话列表滚动位置')

// ---------- 2) 会话列表重绘不得自动滚动到激活项 ----------
const listStart = src.indexOf('  function renderSessionList() {')
const listBody = src.slice(listStart, src.indexOf('  function scheduleSessionListRender()', listStart))
assert.ok(!/\.scrollIntoView\(/.test(listBody), 'renderSessionList 不得 scrollIntoView（激活项不在视野时会把列表拽回去）')
assert.ok(/const scrollTop = Number\(list\.scrollTop \|\| 0\)/.test(listBody), '增量重绘仍要保留当前滚动位置')
assert.ok(/list\.scrollTop = scrollTop/.test(listBody), '增量重绘后必须还原滚动位置')

// ---------- 3) 切换会话的多次 renderApp 不应引入其它强制滚动 ----------
assert.ok(!/sessionListNode.*scrollIntoView/.test(src), '不得残留对会话项的 scrollIntoView')

console.log('OK 会话列表滚动位置检查通过')
