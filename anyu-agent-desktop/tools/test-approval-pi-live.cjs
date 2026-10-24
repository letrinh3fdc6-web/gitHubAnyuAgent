const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

for (const [mode, allowed] of [['auto', false], ['confirm', true], ['full', true]]) {
  test(`bundled Pi ${mode}: ${allowed ? 'approved write succeeds' : 'denied write never reaches disk'}`, { timeout: 30000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-approval-live-'))
    const target = path.join(directory, 'approved.txt')
    let requests = 0
    const upstream = http.createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests++
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'approval-test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      send({ role: 'assistant' })
      if (!body.messages.some(message => message.role === 'tool')) {
        send({ tool_calls: [{ index: 0, id: 'write-one', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: target, content: 'APPROVED_ONLY' }) } }] })
        send({}, 'tool_calls')
      } else { send({ content: 'Finished' }); send({}, 'stop') }
      response.end('data: [DONE]\n\n')
    })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const model = { id: 'approval-test', name: 'Approval test', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    fs.writeFileSync(path.join(directory, 'models.json'), JSON.stringify({ providers: { 'local-test': { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [model] } } }))
    const executable = path.resolve(__dirname, '../pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi')
    const child = spawn(executable, ['--mode', 'rpc', '--provider', 'local-test', '--model', model.id, '--no-session', '--no-context-files', '--no-skills', '--no-extensions', '--extension', path.resolve(__dirname, '../pi-approval-gate.mjs'), '--tools', 'write', '--offline', '--approve'], {
      cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_CODING_AGENT_DIR: directory, ANYU_PERMISSION_MODE: mode, PI_SKIP_VERSION_CHECK: '1' },
    })
    t.after(async () => {
      if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed }
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(resolve))
      fs.rmSync(directory, { recursive: true, force: true })
    })
    let approvals = 0
    let buffer = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', data => { stderr += data.toString() })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Pi exited ${code}: ${stderr}`)))
      child.stdout.on('data', chunk => {
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (event.type === 'extension_ui_request' && event.method === 'confirm') {
            approvals++
            if (fs.existsSync(target)) return reject(new Error('Write occurred before approval'))
            child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, confirmed: allowed }) + '\n')
          }
          if (event.type === 'agent_settled') resolve()
          if (event.type === 'response' && event.success === false) reject(new Error(event.error))
        }
      })
      child.stdin.write(JSON.stringify({ id: 'prompt-one', type: 'prompt', message: 'Write the requested test file.' }) + '\n')
    })
    assert.equal(approvals, mode === 'full' ? 0 : 1)
    assert.equal(requests, 2)
    assert.equal(fs.existsSync(target), allowed)
    if (allowed) assert.equal(fs.readFileSync(target, 'utf8'), 'APPROVED_ONLY')
  })
}
