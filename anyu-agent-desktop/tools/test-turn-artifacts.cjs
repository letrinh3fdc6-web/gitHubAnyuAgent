const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8')
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8')

function sourceSlice(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert(from >= 0 && to > from, `找不到源码片段：${start}`)
  return source.slice(from, to)
}

// 长代码必须默认折叠，且模型输出不得穿透 HTML。
const contentContext = {
  esc: (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}
vm.runInNewContext(`${sourceSlice(renderer, '  function renderInlineMessageContent(value) {', '  const formatDuration = ')}; this.render = renderMessageContent`, contentContext)
const rendered = contentContext.render('```html\n<div onclick="boom()">ok</div>\n```')
assert.match(rendered, /<details class="code-result"/)
assert.match(rendered, /HTML|html/)
assert.doesNotMatch(rendered, /<div onclick=/)
assert.match(rendered, /&lt;div onclick=&quot;boom\(\)&quot;&gt;/)
const malicious = contentContext.render('[查看](https://example.com/"onmouseover="alert(1))')
assert.doesNotMatch(malicious, /href="[^"]*"onmouseover="/i, '链接不能注入新属性')
assert.doesNotMatch(malicious, /<[^>]+onmouseover=/i, '非法 URL 必须拒绝，不生成事件属性')
assert.match(contentContext.render('说明 "onmouseover="alert(1)'), /&quot;onmouseover=/)

const candidates = {}
vm.runInNewContext(`${sourceSlice(renderer, '  function artifactCandidates(value) {', '  async function inspectMessageArtifacts(')}; this.find = artifactCandidates`, candidates)
assert.strictEqual(candidates.find('请读取 `existing.html`').length, 0, '引用现存文件不是生成结果')
assert.strictEqual(candidates.find('已生成 `C:\\My Workspace\\result page.html`')[0], 'C:\\My Workspace\\result page.html')
assert.strictEqual(candidates.find('已导出 [预览](reports/my page.html)')[0], 'reports/my page.html')

// 只有工作区内真实存在的文件才能进入产物卡。
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'leta-turn-artifact-'))
const outside = path.join(path.dirname(workspace), `outside-${Date.now()}.html`)
fs.writeFileSync(path.join(workspace, 'result.html'), '<!doctype html>\n<title>result</title>\n<p>ok</p>')
fs.writeFileSync(outside, '<p>outside</p>')
const mainContext = {
  fs,
  path,
  BROWSER_ARTIFACT_MAX_BYTES: 8 * 1024 * 1024,
  isInside: (parent, candidate) => {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate))
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }
}
vm.runInNewContext(`${sourceSlice(main, 'function inspectWorkspaceArtifacts(payload = {}) {', 'function closeBrowserView() {')}; this.inspect = inspectWorkspaceArtifacts`, mainContext)
const inspected = mainContext.inspect({ cwd: workspace, paths: ['result.html', 'missing.html', `../${path.basename(outside)}`] })
assert.strictEqual(inspected.artifacts.length, 1)
assert.strictEqual(inspected.artifacts[0].name, 'result.html')
assert.strictEqual(inspected.artifacts[0].previewable, true)
assert.strictEqual(inspected.artifacts[0].lineCount, 3)
assert(preload.includes("ipcRenderer.invoke('app:inspect-artifacts'"), '渲染进程没有通过最小 IPC 请求产物校验')

fs.rmSync(workspace, { recursive: true, force: true })
fs.rmSync(outside, { force: true })
console.log('turn code folding and verified artifact registry: passed')
