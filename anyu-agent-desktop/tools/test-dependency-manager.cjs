const assert = require('node:assert/strict')
const { run, normalizeDependencies, PYPI_INDEXES, dependencyRuntimeInfo } = require('../dependency-manager.cjs')

async function main() {
  const normalized = normalizeDependencies({ commands: ['ffmpeg', 'ffmpeg'], python: ['openpyxl'], optionalCommands: ['soffice'] })
  assert.deepEqual(normalized, { commands: ['ffmpeg'], python: ['openpyxl'], optionalCommands: ['soffice'] })
  assert.ok(PYPI_INDEXES.some((url) => url.includes('tuna.tsinghua.edu.cn')), '必须包含国内 PyPI 镜像')
  assert.ok(Array.isArray(dependencyRuntimeInfo().pypiIndexes), '依赖运行时信息缺失')

  const events = []
  const finished = run(process.execPath, ['-e', 'process.stdout.write("package manager active"); setTimeout(() => {}, 80)'], 1000, (event) => events.push(event), 'FFmpeg', 'dependency-installing', 10, 12)
  const result = await finished
  assert.equal(result.code, 0)
  assert.ok(events.some((event) => event.indeterminate && /package manager active/.test(event.message)))
  assert.ok(events.some((event) => event.indeterminate && /仍在运行/.test(event.message)), 'quiet installers must emit heartbeat progress')

  const timeoutEvents = []
  const timedOut = await run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], 35, (event) => timeoutEvents.push(event), 'FFmpeg', 'dependency-installing', 10, 12)
  assert.equal(timedOut.code, 124)
  assert.match(timedOut.stderr, /超时/)
  console.log('dependency progress heartbeats and timeout reporting: passed')
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
