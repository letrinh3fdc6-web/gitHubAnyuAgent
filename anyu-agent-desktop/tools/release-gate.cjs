'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')
const portable = process.argv.includes('--portable')
const tests = ['test-agent-context.cjs', 'test-agent-workbench.cjs', 'test-agent-connectors.cjs', 'test-workbench-integration.cjs', 'test-agent-session.cjs', 'test-agent-orchestrator.cjs', 'test-runtime-probe.cjs', 'test-auth-memory.cjs']
if (!portable) tests.push('test-context-pi-live.cjs', 'test-runtime-probe-pi-live.cjs', 'test-subagent-pi-live.cjs', 'test-approval-pi-live.cjs', 'test-workbench-pi-live.cjs', 'test-codex-client.cjs', 'test-codex-runtime.cjs', 'test-codex-provider.cjs')
const commands = [
  ['tools/test-updater.cjs'],
  ['--test', 'tools/test-desktop-updates.cjs', 'tools/test-windows-update.cjs', 'tools/test-shutdown.cjs'],
  ['--test', ...tests.map(file => path.join('tools', file))],
  ['tools/test-packaged-extension-path.cjs'],
  ['tools/test-gateway-bridge.cjs'],
]
const report = { version: 1, platform: process.platform, arch: process.arch, node: process.version, at: new Date().toISOString(), portable, passed: false, checks: [], sources: {} }
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  report.checks.push({ command: args, passed: result.status === 0 })
  if (result.status !== 0) break
}
for (const file of ['main.cjs', 'agent-workbench.cjs', 'workspace-checkpoints.cjs', 'agent-orchestrator.cjs', 'pi-workbench-extension.mjs', 'codex-client.cjs', 'codex-provider.cjs', 'codex-tools.cjs', 'codex-runtime.cjs', 'codex-worker.cjs', 'package-lock.json']) report.sources[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')
report.passed = report.checks.length === commands.length && report.checks.every(check => check.passed)
const output = path.join(root, 'test-results')
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(output, 'release-gate.json'), JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
