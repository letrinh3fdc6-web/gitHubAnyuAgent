const assert = require('node:assert/strict')
const path = require('node:path')
const { allowedBrowserUrl, workspaceFile } = require('../browser-policy.cjs')

// 普通网页与本机开发服务均可打开，危险协议和 URL 凭据必须拒绝。
for (const url of ['https://example.com/page', 'https://detail.tmall.com/item.htm?id=1', 'http://127.0.0.1:9090/']) assert.equal(allowedBrowserUrl(url), true)
for (const url of ['file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,a', 'https://user:pass@example.com/']) assert.equal(allowedBrowserUrl(url), false)
const root = path.resolve(__dirname, '..')
assert.equal(workspaceFile(root, 'renderer/index.html'), path.join(root, 'renderer', 'index.html'))
assert.throws(() => workspaceFile(root, '../outside.html'))
console.log('browser URL and workspace policy: passed')
