const assert = require('assert')
const http = require('http')
const { ANYU_AGENT_GATEWAY_PATH, LocalGatewayBridge, allowedGatewayPath, managedBaseUrl, managedProviderName, parseManagedRoute } = require('../gateway-bridge.cjs')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

async function main() {
  const requests = []
  let rejectFirst = true
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, group: req.headers['x-anyu-group-id'], model: req.headers['x-anyu-model'], body: Buffer.concat(chunks).toString() })
      if (rejectFirst) { rejectFirst = false; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"message":"expired"}'); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: first\n\n')
      setImmediate(() => res.end('data: done\n\n'))
    })
  })
  const upstreamPort = await listen(upstream)
  let accessToken = 'old-jwt'
  let refreshes = 0
  const bridge = new LocalGatewayBridge({
    gatewayBase: `http://127.0.0.1:${upstreamPort}`,
    getAccessToken: () => accessToken,
    refreshAccessToken: async () => { refreshes++; accessToken = 'new-jwt'; return accessToken }
  })
  const local = await bridge.start()
  const baseUrl = managedBaseUrl(local.origin, 'openai-responses', 17)
  assert.strictEqual(managedProviderName('openai-responses', 17), 'anyu-gateway-openai-g17')
  assert.deepStrictEqual(parseManagedRoute(new URL(baseUrl).pathname + '/responses'), { groupId: 17, upstreamPath: '/v1/responses' })
  assert.strictEqual(allowedGatewayPath('/v1/responses/compact'), true)
  assert.strictEqual(allowedGatewayPath('/v1/responses/arbitrary'), false)
  assert.strictEqual(allowedGatewayPath('/responses'), false)
  assert.deepStrictEqual(parseManagedRoute('/anyu/23/v1/messages'), { groupId: 23, upstreamPath: '/v1/messages' })
  assert.deepStrictEqual(parseManagedRoute('/anyu/29/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'), { groupId: 29, upstreamPath: '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse' })

  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6', input: 'hello' })
  })
  assert.strictEqual(response.status, 200)
  assert.strictEqual(await response.text(), 'data: first\n\ndata: done\n\n')
  assert.strictEqual(refreshes, 1)
  assert.strictEqual(requests.length, 2)
  assert.strictEqual(requests[0].url, `${ANYU_AGENT_GATEWAY_PATH}/v1/responses`)
  assert.strictEqual(requests[1].url, `${ANYU_AGENT_GATEWAY_PATH}/v1/responses`)
  assert.strictEqual(requests[0].authorization, 'Bearer old-jwt')
  assert.strictEqual(requests[1].authorization, 'Bearer new-jwt')
  assert.strictEqual(requests[1].group, '17')
  assert.strictEqual(requests[1].model, 'gpt-5.6')

  const rejected = await fetch(`${baseUrl}/responses`, { method: 'POST', headers: { Authorization: 'Bearer invalid' }, body: '{}' })
  assert.strictEqual(rejected.status, 401)
  const rejectedMethod = await fetch(`${baseUrl}/responses`, { method: 'GET', headers: { Authorization: `Bearer ${local.token}` } })
  assert.strictEqual(rejectedMethod.status, 405)
  await bridge.stop()
  await close(upstream)
  console.log('gateway bridge tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
