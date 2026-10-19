const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { analyzeWithPi } = require('../skill-analysis.cjs')

// 用本机协议夹具运行真实 Pi，避免测试依赖外部模型或用户密钥。

// 构造一个假 spawn：按 256KB 分片把脚本化 stdout 行发给被测代码，模拟真实管道到达节奏。
function fakeSpawnScripted(lines, chunkSize = 256 * 1024) {
  return (executable, args, options) => {
    const { EventEmitter } = require('node:events')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write: () => {}, end: () => {} }
    child.kill = () => {}
    setImmediate(() => {
      for (const line of lines) {
        const payload = Buffer.from(`${line}\n`, 'utf8')
        for (let offset = 0; offset < payload.length; offset += chunkSize) {
          child.stdout.emit('data', payload.subarray(offset, Math.min(offset + chunkSize, payload.length)))
        }
      }
    })
    return child
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leta-analysis-test-'))
  let requestPayload
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      requestPayload = JSON.parse(Buffer.concat(chunks).toString())
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '根据公开评价，优先改善包装。' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const model = { id: 'test-model', name: 'Test', api: 'openai-completions', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }
    fs.writeFileSync(path.join(directory, 'models.json'), JSON.stringify({ providers: { 'local-fixture': { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: '$ANYU_API_KEY', models: [model] } } }))
    const progress = []
    const text = await analyzeWithPi({ executable: path.resolve('pi-runtime/pi.exe'), provider: 'local-fixture', model: 'test-model', cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory, ANYU_API_KEY: 'fixture-only', PI_OFFLINE: '1' }, prompt: '评价：包装有损坏。请分析。', onProgress: (partial) => progress.push(partial) })
    assert.equal(text, '根据公开评价，优先改善包装。')
    assert(progress.some((partial) => partial.includes('优先改善包装')), '分析过程应增量回传正文')
    assert.equal(requestPayload.model, 'test-model')
    assert(!requestPayload.tools?.length, '分析不得加载文件或执行工具')
    assert(!fs.existsSync(path.join(directory, 'sessions')), '分析子会话不得生成聊天历史')
    const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ar8AAAAASUVORK5CYII=' }
    const vision = await analyzeWithPi({ executable: path.resolve('pi-runtime/pi.exe'), provider: 'local-fixture', model: 'test-model', cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory, ANYU_API_KEY: 'fixture-only', PI_OFFLINE: '1' }, prompt: '逐图测图', images: [image] })
    assert.match(vision, /包装/)
    assert.match(JSON.stringify(requestPayload), /data:image\/png;base64/)

    // 回归：多图测图时 Pi 会把携带 base64 的用户消息整行回显到 stdout，超过旧 4MB 缓冲会误报
    // "分析运行时返回的数据过大"。这里用超过 4MB 的图片端到端验证分析仍能完成。
    const bigImage = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(5 * 1024 * 1024) }
    const bigVision = await analyzeWithPi({ executable: path.resolve('pi-runtime/pi.exe'), provider: 'local-fixture', model: 'test-model', cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory, ANYU_API_KEY: 'fixture-only', PI_OFFLINE: '1' }, prompt: '大图测图', images: [bigImage] })
    assert.match(bigVision, /包装/)
    assert(Buffer.byteLength(JSON.stringify(requestPayload)) > 5 * 1024 * 1024, '超过 4MB 的图片应完整进入分析请求')

    // 注入式回归：模拟 Pi 分片回显 6MB 的用户消息事件，跨 chunk 行缓冲不得中断分析。
    const bigImageData = 'A'.repeat(6 * 1024 * 1024)
    const echoedUserMessage = JSON.stringify({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '逐图测图' }, { type: 'image', data: bigImageData, mimeType: 'image/png' }], timestamp: 1 } })
    const bigEcho = await analyzeWithPi({
      executable: 'unused', provider: 'unused', model: 'unused', cwd: directory, env: {}, prompt: '逐图测图',
      spawnProcess: fakeSpawnScripted([
        echoedUserMessage,
        JSON.stringify({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', delta: '根据公开评价，' } }),
        JSON.stringify({ type: 'message_update', usage: {}, assistantMessageEvent: { type: 'text_delta', delta: '优先改善包装。' } }),
        JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '根据公开评价，优先改善包装。' }], stopReason: 'stop' } }),
        JSON.stringify({ type: 'agent_end' })
      ])
    })
    assert.equal(bigEcho, '根据公开评价，优先改善包装。')

    // 防御：单行超过上限且始终没有换行时，仍要按"数据过大"失败，不能无限占用内存。
    await assert.rejects(
      analyzeWithPi({ executable: 'unused', provider: 'unused', model: 'unused', cwd: directory, env: {}, prompt: '失控输出', spawnProcess: fakeSpawnScripted(['x'.repeat(65 * 1024 * 1024)]) }),
      /数据过大/,
      '失控输出仍应触发上限保护'
    )
    console.log('real Pi analysis: text, vision image, big image echo, chunked echo, runaway guard, no tools, no session passed')
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
