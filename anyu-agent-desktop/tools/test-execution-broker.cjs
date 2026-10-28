const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { once } = require('node:events')
const { ExecutionBroker } = require('../execution-broker.cjs')
const { launchElevated, quoteWindowsArgument } = require('../windows-elevation.cjs')
const { resolvePermissionMode } = require('../agent-permissions.cjs')
const { VERSION, send } = require('../execution-protocol.cjs')

const windows = { skip: process.platform !== 'win32', timeout: 20000 }
const tick = () => new Promise(resolve => setTimeout(resolve, 20))
async function waitFor(check) { for (let n = 0; n < 250; n++) { if (check()) return; await tick() } assert.ok(check()) }
function harness(t, { administrator = true, packaged = true, intruder = false, executables } = {}) {
  const workers = []
  const broker = new ExecutionBroker({
    app: { isPackaged: packaged, getPath: () => process.execPath, getAppPath: () => 'C:\\App with spaces\\AnyuAgent' },
    executable: () => process.execPath,
    executables,
    timeout: 5000,
    launch: async (_executable, argv) => {
      if (!packaged) assert.equal(argv.shift(), 'C:\\App with spaces\\AnyuAgent')
      if (intruder) {
        const socket = net.connect(argv[1])
        socket.on('error', () => {})
        await once(socket, 'connect')
        socket.end(JSON.stringify({ type: 'hello', version: VERSION, token: '0'.repeat(64), administrator: true, pid: process.pid }) + '\n')
      }
      const worker = spawn(process.execPath, [path.join(__dirname, 'execution-worker-fixture.cjs'), ...argv], {
        env: { ...process.env, ANYU_TEST_ADMIN: administrator ? '1' : '0' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      })
      workers.push(worker)
      worker.stderr.on('data', data => { throw new Error(data.toString()) })
      return worker.pid
    },
  })
  broker.testWorkers = workers
  t.after(async () => {
    await broker.close()
    await waitFor(() => workers.every(worker => worker.exitCode !== null))
  })
  return broker
}

test('automatic permission never depends on a model or inherits a stale full runtime', () => {
  assert.equal(resolvePermissionMode('auto', 'full'), 'confirm')
  assert.equal(resolvePermissionMode(undefined, 'full'), 'full')
  assert.equal(resolvePermissionMode('confirm', 'full'), 'confirm')
  assert.equal(resolvePermissionMode('full', 'auto'), 'full')
  assert.equal(resolvePermissionMode('invalid', 'full'), 'confirm')
})

test('UAC cancellation and launch failure have distinct error codes', async () => {
  const run = (_file, _argv, _options, done) => done(new Error('failed'), 'ANYU_UAC:{"code":1223,"message":"cancelled"}')
  await assert.rejects(launchElevated('app.exe', [], { run }), { code: 'UAC_CANCELLED', cancelled: true })
  await assert.rejects(launchElevated('app.exe', [], { run: (_f, _a, _o, done) => done(new Error('missing exe'), '') }), { code: 'UAC_LAUNCH_FAILED', cancelled: false })
})

test('real PowerShell accepts empty launch arguments and preserves Windows quoting', windows, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu launch '))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  // Exercise the production script without requesting UAC in an automated test.
  const run = (file, argv, options, done) => execFile(file, argv.map(value => value.replace("Verb = 'RunAs'; ", '')), options, done)
  assert.ok(await launchElevated(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), [], { run }))
  const output = path.join(directory, 'argv.json')
  const expected = ['path with spaces', '', 'embedded"quote', 'trailing\\', '$HOME $(literal)`', '中文目录']
  const script = 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))'
  await launchElevated(process.execPath, ['-e', script, output, ...expected], { run })
  await waitFor(() => fs.existsSync(output))
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), expected)
  assert.equal(quoteWindowsArgument(''), '""')
})

test('packaged worker verifies identity, rejects an unrelated connection and preserves large Unicode RPC data', windows, async t => {
  const broker = harness(t, { intruder: true })
  const states = await Promise.all([broker.ensure(), broker.ensure()])
  assert.equal(states[0].ready, true)
  assert.equal(states[0].pid, states[1].pid)
  const child = broker.spawn(['-e', 'process.stdin.pipe(process.stdout)'], { cwd: os.tmpdir(), env: process.env })
  const chunks = []
  child.stdout.on('data', chunk => chunks.push(chunk))
  const exited = once(child, 'exit')
  const expected = Buffer.from('中文🙂abc'.repeat(200000))
  child.stdin.end(expected)
  assert.equal((await exited)[0], 0)
  assert.deepEqual(Buffer.concat(chunks), expected)
  assert.equal(broker.children.size, 0)
})

test('source-mode launch includes the application path and reports spawn errors', windows, async t => {
  const broker = harness(t, { packaged: false })
  await broker.ensure()
  const child = broker.spawn([], { cwd: 'Z:\\missing-anyu-test-directory', env: process.env })
  const error = once(child, 'error')
  assert.match((await error)[0].message, /ENOENT|spawn/i)
  await waitFor(() => child.exitCode !== null)
})

test('worker without an administrator token is rejected', windows, async t => {
  const broker = harness(t, { administrator: false })
  await assert.rejects(broker.ensure(), { code: 'ELEVATION_NOT_VERIFIED' })
  assert.equal(broker.state().ready, false)
})

test('both engines share one authorization and only launch registered targets', windows, async t => {
  const broker = harness(t, { executables: () => ({ pi: process.execPath, codex: path.join(process.env.SystemRoot, 'System32', 'whoami.exe') }) })
  const states = []
  broker.on('state', state => states.push(state.ready))
  await Promise.all([broker.ensure(), broker.ensure()])
  const run = async (target, args) => {
    await broker.ensure()
    const child = broker.spawn(args, { target, cwd: os.tmpdir(), env: process.env })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    assert.equal((await once(child, 'exit'))[0], 0)
    return output.trim()
  }
  assert.equal(await run('pi', ['-e', 'process.stdout.write("pi engine")']), 'pi engine')
  assert.match(await run('codex', []), /\\/)
  assert.equal(broker.testWorkers.length, 1, 'Engine switches must reuse the authorized worker')
  assert.throws(() => broker.spawn([], { target: 'powershell', cwd: os.tmpdir(), env: process.env }), /未授权/)
  assert.throws(() => broker.spawn([], { target: 'toString', cwd: os.tmpdir(), env: process.env }), /未授权/)
  await broker.close()
  assert.equal(states[0], true)
  assert.equal(states.at(-1), false)
  await broker.ensure()
  assert.equal(broker.testWorkers.length, 2, 'A closed worker must be verified again')
  send(broker.socket, { type: 'spawn', id: require('node:crypto').randomUUID(), target: 'unregistered', args: [], cwd: os.tmpdir(), env: process.env })
  await waitFor(() => !broker.state().ready)
})

test('disconnect terminates active child processes and invalidates effective privilege', windows, async t => {
  const broker = harness(t)
  await broker.ensure()
  const child = broker.spawn(['-e', 'setInterval(() => {}, 1000)'], { cwd: os.tmpdir(), env: process.env })
  await once(child, 'spawn')
  const pid = child.pid
  child.on('error', () => {})
  broker.socket.destroy()
  await waitFor(() => !broker.state().ready)
  await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } })
  assert.equal(child.exitCode, -1)
})

test('closing during a pending UAC launch cancels the connection without a leaked listener', windows, async () => {
  let release
  const broker = new ExecutionBroker({
    app: { isPackaged: true, getPath: () => process.execPath }, executable: () => process.execPath,
    launch: () => new Promise(resolve => { release = resolve }),
  })
  const result = assert.rejects(broker.ensure(), /已取消/)
  await waitFor(() => Boolean(release))
  await broker.close()
  release(12345)
  await result
  assert.equal(broker.state().ready, false)
})
