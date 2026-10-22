const assert = require('node:assert/strict')
const http = require('node:http')

async function main() {
  let tool
  const extension = (await import('../pi-browser-extension.mjs')).default
  extension({ registerTool: (definition) => { if (definition.name === 'browser_open') tool = definition } })
  assert.equal(tool.name, 'browser_open')
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ token: request.headers['x-leta-token'], body: JSON.parse(body) })
      response.writeHead(200); response.end('OK')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    process.env.LETA_BROWSER_BRIDGE_PORT = String(server.address().port)
    process.env.LETA_BROWSER_BRIDGE_TOKEN = 'test-secret'
    // 工具只传入当前会话工作区，路径校验在桌面主进程执行。
    const result = await tool.execute('call-1', { path: 'result.html' }, null, null, { cwd: 'C:\\workspace' })
    assert.equal(requests[0].token, 'test-secret')
    assert.deepEqual(requests[0].body, { url: '', path: 'result.html', cwd: 'C:\\workspace' })
    assert.match(result.content[0].text, /result\.html/)
    await assert.rejects(tool.execute('call-2', { path: 'a.html', url: 'https://example.com' }, null, null, { cwd: 'C:\\workspace' }))
    console.log('browser_open extension protocol: passed')
  } finally { server.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
