const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

if (process.platform !== 'win32') process.exit(0)
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-installer-process-test-'))
const install = path.join(directory, "AnyuAgent test's folder")
const sibling = install + '-other'
const helper = path.resolve(__dirname, '../build/installer-processes.ps1')
const children = []
function check(mode, target = install) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-InstallDirectory', target, '-Mode', mode, '-LogPath', path.join(directory, 'install.log')], { encoding: 'utf8', timeout: 15000, windowsHide: true })
}
function launch(root, name) {
  fs.mkdirSync(root, { recursive: true })
  const exe = path.join(root, name + '.exe')
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32/ping.exe'), exe)
  const child = spawn(exe, ['-t', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' })
  children.push(child)
  return child
}
async function main() {
  try {
    assert.equal(check('Inspect', path.join(directory, 'not-installed')).status, 0)
    assert.equal(check('Inspect', path.parse(directory).root).status, 20)
    const app = launch(install, 'AnyuAgent')
    const runtime = launch(path.join(install, 'resources/pi-runtime'), 'pi')
    const unrelated = launch(sibling, 'pi')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(check('Inspect').status, 10)
    const stopped = check('Stop')
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr)
    assert.equal(check('Inspect').status, 0)
    process.kill(unrelated.pid, 0)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.notEqual(app.exitCode, null)
    assert.notEqual(runtime.exitCode, null)
    assert.equal(unrelated.exitCode, null, 'A process outside the exact installation directory was stopped')
    assert.match(fs.readFileSync(path.join(directory, 'install.log'), 'utf8'), /Stop complete/)
    console.log(JSON.stringify({ passed: true, checks: ['fresh installation', 'drive root rejection', 'spaces and apostrophes', 'application and runtime cleanup', 'sibling directory isolation', 'diagnostic log'], evidence: directory }))
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
