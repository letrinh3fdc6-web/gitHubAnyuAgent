const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')

// Windows PowerShell can exit without executing its script under DETACHED_PROCESS.
// A short-lived launcher lets Start-Process create the independent update worker.
const START_WORKER = `
$ErrorActionPreference = 'Stop'
try {
  $arguments = '-NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File "' + $env:ANYU_UPDATE_SCRIPT + '" -ConfigPath "' + $env:ANYU_UPDATE_CONFIG + '"'
  Start-Process -FilePath $env:ANYU_UPDATE_POWERSHELL -ArgumentList $arguments -WindowStyle Hidden -ErrorAction Stop | Out-Null
} catch {
  Add-Content -LiteralPath $env:ANYU_UPDATE_LOG -Value $_.Exception.Message -Encoding UTF8
  exit 1
}`

function writeMarker(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function readMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

async function prepareWindowsUpdate({ markerPath, installerPath, executablePath, version, bytes, sha256, userDataPath, showUI = true, timeoutMs = 45000 }) {
  const session = crypto.randomUUID()
  const directory = path.join(path.dirname(markerPath), 'update-worker', session)
  fs.mkdirSync(directory, { recursive: true })
  const scriptPath = path.join(directory, 'install.ps1')
  const logPath = path.join(directory, 'install.log')
  const configPath = path.join(directory, 'install.json')
  const marker = { session, status: 'starting', installerPath, executablePath, installDirectory: path.dirname(executablePath), expectedVersion: version, bytes, sha256, logPath, createdAt: new Date().toISOString() }
  writeMarker(markerPath, marker)
  writeMarker(configPath, { ...marker, markerPath, parentPid: process.pid, userDataPath, showUI })
  const source = fs.readFileSync(path.join(__dirname, 'build', 'update-windows.ps1'), 'utf8').replace(/^\uFEFF/, '')
  fs.writeFileSync(scriptPath, '\uFEFF' + source, { mode: 0o600 })
  const inspector = fs.readFileSync(path.join(__dirname, 'build', 'installer-processes.ps1'), 'utf8').replace(/^\uFEFF/, '')
  fs.writeFileSync(path.join(directory, 'inspect.ps1'), '\uFEFF' + inspector, { mode: 0o600 })
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(START_WORKER, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ANYU_UPDATE_SCRIPT: scriptPath, ANYU_UPDATE_CONFIG: configPath, ANYU_UPDATE_POWERSHELL: executable, ANYU_UPDATE_LOG: logPath },
  })
  let spawnError
  child.once('error', error => { spawnError = error })
  child.unref()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`更新器启动失败：${spawnError.message}`)
    const current = readMarker(markerPath)
    if (current?.session === session && current.status === 'prepared') return { ...current, scriptPath }
    if (current?.session === session && current.status === 'failed') throw new Error(current.error || '更新器未能准备完成')
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`更新启动器退出 (${child.exitCode})，日志：${logPath}`)
    await delay(100)
  }
  const current = readMarker(markerPath)
  if (current?.session === session) writeMarker(markerPath, { ...current, status: 'cancelled' })
  throw new Error(`更新器准备超时，当前客户端未退出。日志：${logPath}`)
}

module.exports = { writeMarker, readMarker, prepareWindowsUpdate }
