// 打包路径回归测试：pi.exe 是外部进程，读不到 app.asar 内的文件。
// 这个用例锁死两件事：扩展被打进 asar.unpacked，且 main.cjs 传给 Pi 的路径不是包内路径。
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8')

const unpack = Array.isArray(pkg.build?.asarUnpack) ? pkg.build.asarUnpack : []
assert.ok(unpack.includes('package.json'), 'The external Codex worker reads the desktop version from its package.json')
assert.ok(unpack.includes('codex-*.cjs') && unpack.includes('node_modules/**/*'), 'Codex worker modules and native/runtime dependencies must be outside app.asar')
assert.ok(pkg.build.files.includes('codex-*.cjs'), 'Codex worker modules must be packaged')
assert.ok(unpack.includes('pi-browser-extension.mjs'), 'package.json 必须把 pi-browser-extension.mjs 放进 asarUnpack')
assert.ok(fs.existsSync(path.join(root, 'pi-browser-extension.mjs')), '扩展源文件必须存在')
assert.ok(pkg.build.files.includes('pi-browser-extension.mjs'), '扩展必须仍在 files 白名单内，否则打包后不会带上')
for (const extension of ['runtime-probe-extension.mjs', 'pi-approval-gate.mjs', 'pi-workbench-extension.mjs']) {
  assert.ok(unpack.includes(extension), `${extension} must be accessible outside app.asar`)
  assert.ok(pkg.build.files.includes(extension), `${extension} must be packaged`)
  assert.ok(fs.existsSync(path.join(root, extension)), `${extension} source must exist`)
  assert.ok(main.includes(`externalProcessPath('${extension}')`), `${extension} must use the unpacked path`)
}

assert.match(main, /function externalProcessPath/, 'main.cjs 需要 asar 路径换算函数')
assert.match(main, /externalProcessPath\('pi-browser-extension\.mjs'\)/, '传给 Pi 的扩展路径必须经过 externalProcessPath 换算')
assert.ok(!/args\.push\('--extension', path\.join\(__dirname/.test(main), '不得把 __dirname 下的 asar 路径直接传给 Pi')

console.log('packaged extension path tests passed')
