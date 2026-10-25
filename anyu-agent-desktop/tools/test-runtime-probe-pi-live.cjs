const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const vm = require('node:vm')
const asar = require('@electron/asar')

async function packagedExtensions(directory) {
  const root = path.resolve(__dirname, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const extensions = ['runtime-probe-extension.mjs', 'pi-approval-gate.mjs']
  const source = path.join(directory, 'package-source')
  const resources = path.join(directory, 'resources')
  fs.mkdirSync(source)
  fs.mkdirSync(resources)
  for (const file of extensions) {
    assert.ok(pkg.build.files.includes(file))
    assert.ok(pkg.build.asarUnpack.includes(file))
    fs.copyFileSync(path.join(root, file), path.join(source, file))
  }
  const archive = path.join(resources, 'app.asar')
  await asar.createPackageWithOptions(source, archive, { unpack: `{${extensions.join(',')}}` })
  const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8')
  const begin = main.indexOf('function externalProcessPath(')
  const end = main.indexOf('function materializePiSession(', begin)
  assert.ok(begin >= 0 && end > begin)
  assert.ok(main.includes("args.push('--tools', 'read,grep,find,ls,runtime_probe')"))
  const resolve = vm.runInNewContext(`${main.slice(begin, end)}; externalProcessPath`, { fs, path, __dirname: archive })
  return extensions.map(file => {
    const resolved = resolve(file)
    assert.equal(asar.statFile(archive, file).unpacked, true)
    assert.equal(resolved, path.join(`${archive}.unpacked`, file))
    assert.deepEqual(fs.readFileSync(resolved), fs.readFileSync(path.join(root, file)))
    return resolved
  })
}

for (const mode of ['confirm', 'full', 'read-only']) {
  test(`bundled Pi ${mode}: environment probe is read-only and optional dependencies do not stop the task`, { timeout: 30000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-runtime-live-'))
    const target = path.join(directory, 'result.txt')
    const errors = []
    let requests = 0, approvals = 0, child
    const upstream = http.createServer(async (request, response) => {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests++
        const tools = body.tools.map(tool => tool.function.name)
        assert.ok(tools.includes('runtime_probe'), 'Pi must expose the custom tool, including under the full profile')
        if (mode === 'read-only') {
          assert.ok(!tools.includes('bash'))
          assert.ok(!tools.includes('write'))
          assert.ok(!tools.includes('edit'))
        }
        const results = body.messages.filter(message => message.role === 'tool')
        if (results.length) {
          const report = JSON.parse(results[0].content)
          assert.equal(report.ok, true)
          assert.equal(report.workspace.readable, true)
          if (process.platform === 'win32') {
            assert.equal(report.executables.node.available, false)
            assert.equal(report.executables.msedge.available, false)
            assert.equal(report.executables.chrome.available, false)
          }
          assert.equal(approvals, results.length > 1 && mode === 'confirm' ? 1 : 0)
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'runtime-probe-test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
        send({ role: 'assistant' })
        if (results.length === 0) {
          send({ tool_calls: [{ index: 0, id: 'probe-one', type: 'function', function: { name: 'runtime_probe', arguments: '{}' } }] })
          send({}, 'tool_calls')
        } else if (results.length === 1 && mode !== 'read-only') {
          send({ tool_calls: [{ index: 0, id: 'write-one', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: target, content: 'PROBE_TASK_CONTINUES' }) } }] })
          send({}, 'tool_calls')
        } else {
          assert.equal(fs.existsSync(target), mode === 'full')
          send({ content: 'Finished after environment inspection.' })
          send({}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      } catch (error) {
        errors.push(error.message)
        if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: error.message } }))
      }
    })
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
      upstream.closeAllConnections()
      await new Promise(resolve => upstream.close(resolve))
      fs.rmSync(directory, { recursive: true, force: true })
    })
    const extensions = await packagedExtensions(directory)
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const model = { id: 'runtime-probe-test', name: 'Runtime probe test', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    fs.writeFileSync(path.join(directory, 'models.json'), JSON.stringify({ providers: { 'local-test': { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [model] } } }))
    const executable = path.resolve(__dirname, '../pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi')
    const args = ['--mode', 'rpc', '--provider', 'local-test', '--model', model.id, '--no-session', '--no-context-files', '--no-skills', '--no-extensions', '--offline', '--approve']
    for (const extension of extensions) args.push('--extension', extension)
    if (mode === 'full') args.push('--permission-profile', 'gptFullAccess')
    else if (mode === 'read-only') args.push('--tools', 'read,grep,find,ls,runtime_probe')
    const env = { ...process.env, PATH: directory, ProgramFiles: directory, 'ProgramFiles(x86)': directory, ProgramW6432: directory, LOCALAPPDATA: directory, PI_CODING_AGENT_DIR: directory, ANYU_PERMISSION_MODE: mode === 'confirm' ? 'confirm' : 'full', PI_SKIP_VERSION_CHECK: '1' }
    delete env.Path
    child = spawn(executable, args, { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = '', stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', data => { stderr += data.toString() })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Pi exited ${code}: ${stderr}`)))
      t.signal.addEventListener('abort', () => reject(t.signal.reason), { once: true })
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
            child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, confirmed: false }) + '\n')
          }
          if (event.type === 'agent_settled') resolve()
          if (event.type === 'response' && event.success === false) reject(new Error(event.error))
        }
      })
      child.stdin.write(JSON.stringify({ id: 'prompt-one', type: 'prompt', message: 'Inspect the environment and continue the requested task.' }) + '\n')
    })
    assert.deepEqual(errors, [])
    assert.equal(requests, mode === 'read-only' ? 2 : 3)
    assert.equal(approvals, mode === 'confirm' ? 1 : 0)
    assert.equal(fs.existsSync(target), mode === 'full')
    if (mode === 'full') assert.equal(fs.readFileSync(target, 'utf8'), 'PROBE_TASK_CONTINUES')
  })
}
