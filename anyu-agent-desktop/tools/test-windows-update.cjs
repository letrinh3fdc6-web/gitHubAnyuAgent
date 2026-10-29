const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { prepareWindowsUpdate, readMarker, writeMarker } = require('../windows-update.cjs')

test('installation scope preserves machine/user registrations and explains cancelled Windows authorization', { skip: process.platform !== 'win32' }, () => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$parseErrors = $null
$tokens = $null
$source = [IO.File]::ReadAllText($env:ANYU_UPDATE_SOURCE, [Text.Encoding]::UTF8)
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Get-InstallScope', 'Get-InstallerFailure')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $definition) { throw "Missing update function $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Get-ItemProperty {
    param([string]$Path, [string]$LiteralPath, [string]$ErrorAction)
    $key = if ($LiteralPath) { $LiteralPath } else { $Path }
    if ($script:registry.ContainsKey($key)) { $script:registry[$key] }
}
$env:ProgramFiles = 'C:\Program Files'
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)', 'C:\Program Files (x86)', 'Process')
$env:ProgramW6432 = 'C:\Program Files'
$cases = ConvertFrom-Json -InputObject $env:ANYU_SCOPE_FIXTURES
$results = foreach ($case in $cases) {
    $config = @{ installDirectory = $case.directory }
    $script:registry = @{}
    foreach ($property in $case.registry.PSObject.Properties) { $script:registry[$property.Name] = $property.Value }
    @{ name = $case.name; scope = (Get-InstallScope) }
}
@{ cases = @($results); cancelled = (Get-InstallerFailure 1223); other = (Get-InstallerFailure 2) } | ConvertTo-Json -Depth 5 -Compress
`
  const root = String.raw`C:\Users\Test\AppData\Local\Temp\Anyu Agent`
  const machineUninstall = String.raw`HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*`
  const userUninstall = machineUninstall.replace('HKLM:', 'HKCU:')
  const wowUninstall = String.raw`HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*`
  const machineGuid = String.raw`HKLM:\Software\app-guid`
  const userGuid = machineGuid.replace('HKLM:', 'HKCU:')
  const wowGuid = String.raw`HKLM:\Software\WOW6432Node\app-guid`
  const cases = [
    { name: 'NSIS machine registration outside Program Files', directory: root, expected: '/allusers', registry: { [machineUninstall]: [{ PSChildName: 'app-guid' }], [machineGuid]: { InstallLocation: root } } },
    { name: 'NSIS current-user registration', directory: root, expected: '/currentuser', registry: { [userUninstall]: [{ PSChildName: 'app-guid' }], [userGuid]: { InstallLocation: root } } },
    { name: '32-bit machine registration', directory: root, expected: '/allusers', registry: { [wowUninstall]: [{ PSChildName: 'app-guid' }], [wowGuid]: { InstallLocation: root } } },
    { name: 'uninstall entry with location', directory: root, expected: '/allusers', registry: { [machineUninstall]: [{ InstallLocation: root }] } },
    { name: 'another installation is not a match', directory: root, expected: '/currentuser', registry: { [machineUninstall]: [{ InstallLocation: root + '-other' }] } },
    { name: 'Program Files fallback', directory: String.raw`C:\Program Files\AnyuAgent`, expected: '/allusers', registry: {} },
    { name: 'unregistered user directory', directory: root, expected: '/currentuser', registry: {} },
    { name: 'same path in both hives preserves machine ownership', directory: root, expected: '/allusers', registry: { [machineUninstall]: [{ InstallLocation: root }], [userUninstall]: [{ InstallLocation: root }] } },
  ]
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, ANYU_UPDATE_SOURCE: path.resolve(__dirname, '../build/update-windows.ps1'), ANYU_SCOPE_FIXTURES: JSON.stringify(cases) },
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const report = JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
  for (const item of cases) assert.equal(report.cases.find(value => value.name === item.name)?.scope, item.expected, item.name)
  assert.match(report.cancelled, /Windows.*授权/)
  assert.match(report.cancelled, /重试/)
  assert.match(report.other, /错误 2/)
})

test('Windows helper really starts, accepts a leftover unlocked lock, and honors cancellation before install', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu update worker '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const installerPath = path.join(root, 'not-an-installer.exe')
  const payload = Buffer.from('test payload that must never execute')
  fs.writeFileSync(installerPath, payload)
  const markerPath = path.join(root, 'pending-update.json')
  fs.writeFileSync(markerPath + '.lock', '')
  const result = await prepareWindowsUpdate({ markerPath, installerPath, executablePath: process.execPath, version: '8.0.0', bytes: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex'), userDataPath: root, showUI: false, timeoutMs: 20000 })
  assert.equal(result.status, 'prepared')
  assert.ok(fs.readFileSync(result.logPath, 'utf8').includes('准备安装'))
  writeMarker(markerPath, { ...readMarker(markerPath), status: 'cancelled' })
  const deadline = Date.now() + 10000
  while (readMarker(markerPath)?.status !== 'failed' && Date.now() < deadline) await delay(100)
  assert.equal(readMarker(markerPath)?.status, 'failed')
  assert.ok(fs.existsSync(installerPath))
  assert.match(fs.readFileSync(result.logPath, 'utf8'), /更新安装未确认/)
})

test('Windows helper rejects a changed package before reporting readiness', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu update reject '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const installerPath = path.join(root, 'not-an-installer.exe')
  fs.writeFileSync(installerPath, 'changed')
  await assert.rejects(prepareWindowsUpdate({ markerPath: path.join(root, 'pending-update.json'), installerPath, executablePath: process.execPath, version: '8.0.0', bytes: 7, sha256: '0'.repeat(64), userDataPath: root, showUI: false, timeoutMs: 20000 }), /SHA-256/)
})
