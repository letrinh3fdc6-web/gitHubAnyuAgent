const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const extension = import('../runtime-probe-extension.mjs')
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-runtime-probe-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = { PATH: directory, ProgramFiles: directory, 'ProgramFiles(x86)': directory, ProgramW6432: directory, LOCALAPPDATA: directory }
  return { directory, env }
}
function executable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '', { mode: 0o755 })
  return file
}

test('a fresh Windows machine does not require external browsers or system Node to run Pi', { skip: process.platform !== 'win32' }, async t => {
  const { probeEnvironment } = await extension
  const { directory, env } = fixture(t)
  const report = probeEnvironment(directory, env)
  assert.equal(report.ok, true)
  for (const id of ['node', 'python', 'msedge', 'chrome']) {
    assert.equal(report.executables[id].available, false)
    assert.equal(report.executables[id].required, false)
    assert.ok(report.optionalMissing.includes(id))
  }
  assert.equal(report.builtinBrowserConfigured, false)
  assert.equal(report.workspace.writable, null, 'read-only detection must not claim Windows write ACL verification')
  assert.equal(report.workspace.writeCheck, 'not-tested')
})

test('PATH entries with spaces and quotes are searched independently of missing commands', async t => {
  const { probeEnvironment } = await extension
  const { directory, env } = fixture(t)
  const bin = path.join(directory, 'tools with spaces')
  const node = executable(path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'))
  env.PATH = `"${bin}"${path.delimiter}${path.join(directory, 'missing')}`
  const report = probeEnvironment(directory, env)
  assert.equal(report.ok, true)
  assert.equal(report.executables.node.path, node)
  assert.equal(report.executables.node.status, 'located-unverified')
  assert.equal(report.executables.ffmpeg.status, 'missing')
  assert.equal(report.executables.ffprobe.status, 'missing')
})

test('managed Python and Bash paths take precedence over PATH', async t => {
  const { probeEnvironment } = await extension
  const { directory, env } = fixture(t)
  const suffix = process.platform === 'win32' ? '.exe' : ''
  env.PYTHON = executable(path.join(directory, 'managed', `python${suffix}`))
  env.PI_BASH_PATH = executable(path.join(directory, 'managed', `bash${suffix}`))
  executable(path.join(directory, `python3${suffix}`))
  executable(path.join(directory, `bash${suffix}`))
  const report = probeEnvironment(directory, env)
  assert.equal(report.executables.python.path, env.PYTHON)
  assert.equal(report.executables.gitbash.path, env.PI_BASH_PATH)
})

test('Windows browsers are discovered outside PATH and WindowsApps aliases are not Python', { skip: process.platform !== 'win32' }, async t => {
  const { probeEnvironment } = await extension
  const { directory, env } = fixture(t)
  const edge = executable(path.join(directory, 'Microsoft/Edge/Application/msedge.exe'))
  const chrome = executable(path.join(directory, 'Google/Chrome/Application/chrome.exe'))
  const aliases = path.join(directory, 'Microsoft/WindowsApps')
  executable(path.join(aliases, 'python.exe'))
  executable(path.join(aliases, 'python3.exe'))
  const wsl = path.join(directory, 'Windows/System32')
  executable(path.join(wsl, 'bash.exe'))
  env.PATH = `${aliases}${path.delimiter}${wsl}`
  const report = probeEnvironment(directory, env)
  assert.equal(report.executables.msedge.path, edge)
  assert.equal(report.executables.chrome.path, chrome)
  assert.equal(report.executables.python.available, false)
  assert.equal(report.executables.gitbash.available, false)
  assert.equal(report.ok, true)
})

test('missing workspace, non-directory and access-denied errors retain their real classification', async t => {
  const { probeEnvironment } = await extension
  const { directory, env } = fixture(t)
  const missing = probeEnvironment(path.join(directory, 'missing'), env)
  assert.equal(missing.ok, false)
  assert.equal(missing.workspace.errorCode, 'ENOENT')
  const file = executable(path.join(directory, 'not-a-directory'))
  assert.equal(probeEnvironment(file, env).workspace.errorCode, 'ENOTDIR')
  t.mock.method(fs, 'opendirSync', () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }) })
  const denied = probeEnvironment(directory, env)
  assert.equal(denied.ok, false)
  assert.equal(denied.workspace.exists, true)
  assert.equal(denied.workspace.readable, false)
  assert.equal(denied.workspace.errorCode, 'EACCES')
})

test('runtime_probe returns a structured read-only result and needs no confirmation', async t => {
  const { default: install } = await extension
  const { default: installGate } = await import('../pi-approval-gate.mjs')
  const { directory } = fixture(t)
  let tool, gate
  install({ registerTool: definition => { tool = definition } })
  installGate({ on: (_name, callback) => { gate = callback } })
  assert.equal(tool.name, 'runtime_probe')
  const response = await tool.execute('runtime-1', {}, null, null, { cwd: directory })
  const report = JSON.parse(response.content[0].text)
  assert.equal(report.cwd, path.resolve(directory))
  assert.equal(report.ok, true)
  assert.deepEqual(response.details, report)
  assert.deepEqual(fs.readdirSync(directory), [], 'probe must not create files or install software')
  assert.equal(await gate({ toolName: 'runtime_probe' }, { hasUI: false }), undefined)
})

test('a denied executable is reported as access-denied rather than missing software', async t => {
  const { probeEnvironment } = await extension
  const { directory, env } = fixture(t)
  const node = executable(path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))
  const stat = fs.statSync
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (file === node) throw Object.assign(new Error('Access denied'), { code: 'EACCES' })
    return stat(file, ...args)
  })
  const report = probeEnvironment(directory, env)
  assert.equal(report.executables.node.status, 'access-denied')
  assert.equal(report.executables.node.errorCode, 'EACCES')
  assert.equal(report.optionalMissing.includes('node'), false)
})
