const { app, BrowserWindow, ipcMain, safeStorage, shell, session, dialog, Menu } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DEFAULT_MANIFEST_URL, compareVersions, artifactFromManifest } = require('./updater.cjs')
const { PluginManager, MAX_PACKAGE_BYTES } = require('./plugin-manager.cjs')

const API_BASE = process.env.ANYU_API_BASE || 'https://x.ailzd.com/api/v1'
const GATEWAY_BASE = API_BASE.replace(/\/api\/v1\/?$/i, '')
const PI_PROVIDER = 'anyu-gateway'
const UPDATE_MANIFEST_URL = process.env.ANYU_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL
function providerForApi(api) {
  return api === 'anthropic-messages' ? `${PI_PROVIDER}-anthropic` : api === 'google-generative-ai' || api === 'google-vertex' ? `${PI_PROVIDER}-gemini` : `${PI_PROVIDER}-openai`
}
function baseUrlForApi(api) {
  // Anthropic's SDK appends /v1/messages itself; its base URL must stay at the origin.
  if (api === 'anthropic-messages') return GATEWAY_BASE
  return api === 'google-generative-ai' || api === 'google-vertex' ? `${GATEWAY_BASE}/v1beta` : `${GATEWAY_BASE}/v1`
}
function canonicalApi(value, fallback = 'openai-completions') {
  const raw = String(value || '').toLowerCase()
  if (raw.includes('anthropic') || raw.includes('claude')) return 'anthropic-messages'
  if (raw.includes('google') || raw.includes('gemini')) return 'google-generative-ai'
  if (raw.includes('response')) return 'openai-responses'
  if (raw.includes('openai') || raw.includes('completion') || raw.includes('chat')) return 'openai-completions'
  return fallback
}
function modelInputCapabilities(model, id, api) {
  const values = [model?.input, model?.input_modalities, model?.modalities, model?.capabilities?.input, model?.capabilities?.input_modalities]
    .flatMap((value) => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,|]+/) : [])
    .map((value) => String(value).toLowerCase().trim()).filter(Boolean)
  const explicitFalse = [model?.supports_images, model?.supportsImages, model?.vision, model?.capabilities?.vision].some((value) => value === false)
  const lower = `${id || ''} ${model?.name || ''} ${api || ''}`.toLowerCase()
  const inferred = !explicitFalse && !/image-generation|image-edit|embedding|audio/.test(lower) && /gemini|claude|anthropic|gpt-4o|gpt-4\.1|gpt-5|o[1-9]|vision|multimodal|vl|qwen2?\.5-vl|qwen3-vl|qvq|glm-4v|doubao-vision|kimi-vl|moonshot-v1-vision|internvl|pixtral|llava|ernie-4\.5/.test(lower)
  const hasImage = !explicitFalse && (values.some((value) => /image|vision|multimodal|photo|picture/.test(value)) || inferred)
  const input = values.length ? [...new Set(values.map((value) => value === 'vision' || value === 'multimodal' ? 'image' : value).filter((value) => !explicitFalse || value !== 'image'))] : ['text']
  if (hasImage && !input.includes('image')) input.push('image')
  return input
}
function modelPermissionMode(model, provider = '') {
  const explicit = String(model?.permissionMode || model?.permission_mode || '').toLowerCase()
  if (explicit === 'full' || explicit === 'confirm') return explicit
  const toolFlags = [
    model?.supportsTools, model?.supports_tools, model?.toolUse,
    model?.tool_use, model?.capabilities?.tools, model?.capabilities?.tool_use
  ]
  if (toolFlags.some((value) => value === false)) return 'confirm'
  if (toolFlags.some((value) => value === true)) return 'full'
  const lower = `${model?.id || model?.name || ''} ${model?.api || ''} ${provider || ''}`.toLowerCase()
  // Anyu 的主流对话模型都具备 Agent 工具调用能力；未知模型保守地要求确认。
  if (/gpt|codex|openai|claude|anthropic|gemini|google|grok|qwen|deepseek|glm|kimi|mistral|moonshot|doubao|llama/.test(lower)) return 'full'
  return 'confirm'
}
function resolvePermissionMode(requested, model, provider = '') {
  const mode = String(requested || '').toLowerCase()
  if (mode === 'full' || mode === 'confirm') return mode
  return modelPermissionMode(model, provider)
}
let mainWindow
let auth = null
const keyCache = new Map()
let piProcess = null
let piBuffer = ''
let piRequestCounter = 0
const piPending = new Map()
let piStartLock = Promise.resolve()
let updateInProgress = false
let recoveredUpdateState = null
let pluginManager = null

function timestampValue(value) {
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function sendUpdateProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:progress', payload)
}

async function checkForUpdate() {
  const manifestUrl = new URL(UPDATE_MANIFEST_URL)
  manifestUrl.searchParams.set('_anyuagent_cache_bust', String(Date.now()))
  const response = await fetch(manifestUrl, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache'
    }
  })
  const text = await response.text()
  let manifest
  try { manifest = text ? JSON.parse(text) : null } catch { throw new Error('更新目录不是有效 JSON') }
  if (!response.ok) throw new Error(`更新目录不可用 (HTTP ${response.status})`)
  const artifact = artifactFromManifest(manifest, app.getVersion(), manifestUrl.href)
  if (new URL(artifact.url).origin !== manifestUrl.origin) throw new Error('更新包地址不属于当前更新源')
  return { ok: true, currentVersion: app.getVersion(), latestVersion: artifact.version, available: compareVersions(artifact.version, app.getVersion()) > 0, artifact: { name: artifact.name, version: artifact.version, bytes: artifact.bytes, sha256: artifact.sha256, url: artifact.url } }
}

function updaterScriptPath() { return path.join(app.getPath('temp'), `anyuagent-updater-${process.pid}-${Date.now()}.ps1`) }

function pendingUpdatePath() { return path.join(app.getPath('userData'), 'pending-update.json') }

function writePendingUpdate(installerPath, expectedVersion) {
  const markerPath = pendingUpdatePath()
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  const marker = {
    installerPath,
    expectedVersion: String(expectedVersion || ''),
    executablePath: app.getPath('exe'),
    installDirectory: path.dirname(app.getPath('exe')),
    createdAt: new Date().toISOString()
  }
  const temporaryPath = `${markerPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(temporaryPath, markerPath)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
    fs.rmSync(markerPath, { force: true })
    fs.renameSync(temporaryPath, markerPath)
  }
  return markerPath
}

function scheduleWindowsInstall(installerPath, expectedVersion, markerPath = pendingUpdatePath()) {
  const executablePath = app.getPath('exe')
  const installDirectory = path.dirname(executablePath)
  const scriptPath = updaterScriptPath()
  const logPath = `${scriptPath}.log`
  const lockPath = `${markerPath}.lock`
  const script = [
    'param([int]$ParentPid, [string]$Installer, [string]$Executable, [string]$InstallDirectory, [string]$ExpectedVersion, [string]$Script, [string]$Log, [string]$Marker, [string]$Lock)',
    "$ErrorActionPreference = 'Stop'",
    '$success = $false',
    '$lockStream = $null',
    '$lockAcquired = $false',
    'function Set-MarkerStatus([string]$Status, [string]$ErrorMessage) { try { $raw = Get-Content -LiteralPath $Marker -Raw -ErrorAction SilentlyContinue; $data = if ($raw) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }; $data | Add-Member -NotePropertyName status -NotePropertyValue $Status -Force; $data | Add-Member -NotePropertyName error -NotePropertyValue $ErrorMessage -Force; $data | Add-Member -NotePropertyName logPath -NotePropertyValue $Log -Force; $data | Add-Member -NotePropertyName updatedAt -NotePropertyValue (Get-Date).ToString("o") -Force; $temporaryMarker = "$Marker.$PID.tmp"; $utf8 = New-Object System.Text.UTF8Encoding($false); [IO.File]::WriteAllText($temporaryMarker, ($data | ConvertTo-Json -Depth 8), $utf8); Move-Item -LiteralPath $temporaryMarker -Destination $Marker -Force } catch {} }',
    'function Write-Log([string]$Message) { try { Add-Content -LiteralPath $Log -Value ("[{0}] {1}" -f (Get-Date -Format o), $Message) -Encoding utf8 } catch {} }',
    'try {',
    '  try { $lockStream = [IO.File]::Open($Lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $lockAcquired = $true } catch { Write-Log "另一个更新器正在运行，退出"; exit 0 }',
    '  Write-Log "更新器启动，父进程 PID=$ParentPid，安装包=$Installer"',
    '  $deadline = (Get-Date).AddSeconds(60)',
    '  while ((Get-Date) -lt $deadline) {',
    '    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue',
    '    if (-not $parent) { break }',
    '    Start-Sleep -Milliseconds 250',
    '  }',
    '  $remaining = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue',
    '  if ($remaining) { Write-Log "父进程未按时退出，强制结束"; Stop-Process -Id $ParentPid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }',
    '  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "更新安装包不存在: $Installer" }',
    '  if (-not (Test-Path -LiteralPath $InstallDirectory -PathType Container)) { throw "安装目录不存在: $InstallDirectory" }',
    '  $exitCode = 1',
    '  for ($attempt = 1; $attempt -le 3; $attempt++) {',
    '    # NSIS requires the quoted /D value when the install directory contains spaces.',
    '    $installArgument = "/D=`"$InstallDirectory`""',
    '    $installerArgs = @("/S", "/NCRC", $installArgument)',
    '    try {',
    '      $probe = $null',
    '      $probe = Join-Path $InstallDirectory (".anyu-write-test-" + [guid]::NewGuid().ToString("N"))',
    '      [IO.File]::WriteAllText($probe, "update")',
    '      Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue',
    '      Write-Log "尝试 $attempt：直接运行安装器"',
    '      $process = Start-Process -FilePath $Installer -ArgumentList $installerArgs -Wait -PassThru -ErrorAction Stop',
    '    } catch {',
    '      if ($probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }',
    '      Write-Log "直接运行失败，尝试请求管理员权限：$($_.Exception.Message)"',
    '      $process = Start-Process -FilePath $Installer -ArgumentList $installerArgs -Verb RunAs -Wait -PassThru -ErrorAction Stop',
    '    }',
    '    $exitCode = [int]$process.ExitCode',
    '    Write-Log "安装器退出码=$exitCode"',
    '    if ($exitCode -ne 0) {',
    '      try { Write-Log "非零退出码，使用管理员权限重试"; $process = Start-Process -FilePath $Installer -ArgumentList $installerArgs -Verb RunAs -Wait -PassThru -ErrorAction Stop; $exitCode = [int]$process.ExitCode; Write-Log "管理员重试退出码=$exitCode" } catch { Write-Log "管理员重试失败：$($_.Exception.Message)" }',
    '    }',
    '    if ($exitCode -eq 0) { break }',
    '    Start-Sleep -Seconds 2',
    '  }',
    '  if ($exitCode -ne 0) { throw "安装器退出码: $exitCode" }',
    '  $target = $Executable',
    '  $ready = $false',
    '  for ($i = 0; $i -lt 40; $i++) {',
    '    if (Test-Path -LiteralPath $target -PathType Leaf) { $ready = $true; break }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '  if (-not $ready) { throw "安装完成后找不到客户端: $target" }',
    '  $installedVersion = [string](Get-Item -LiteralPath $target).VersionInfo.ProductVersion',
    '  Write-Log "安装后版本=$installedVersion"',
    '  if ($ExpectedVersion -and (-not $installedVersion -or -not $installedVersion.StartsWith($ExpectedVersion, [StringComparison]::OrdinalIgnoreCase))) { throw "安装版本校验失败: 期望 $ExpectedVersion，实际 $installedVersion" }',
    '  $started = $false',
    '  for ($launchAttempt = 1; $launchAttempt -le 3; $launchAttempt++) {',
    '    Write-Log "尝试启动客户端 $launchAttempt"',
    '    $client = Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) -PassThru -ErrorAction SilentlyContinue',
    '    if ($client) { Start-Sleep -Seconds 5; $running = Get-Process -Id $client.Id -ErrorAction SilentlyContinue; if ($running -and -not $running.HasExited) { $started = $true; break } }',
    '    Start-Sleep -Seconds 1',
    '  }',
    '  if (-not $started) { throw "客户端重启失败: $target" }',
    '  Write-Log "客户端已启动，更新成功"',
    '  $success = $true',
  '} catch {',
    '  $failure = $_.Exception.Message',
    '  Write-Log "更新失败：$failure"',
    '  Set-MarkerStatus "failed" $failure',
    '  exit 1',
    '} finally {',
    '  if ($lockStream) { try { $lockStream.Dispose() } catch {} }',
    '  if ($success) {',
    '    Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue',
    '    Remove-Item -LiteralPath $Marker -Force -ErrorAction SilentlyContinue',
    '  }',
    '  if ($lockAcquired) { Remove-Item -LiteralPath $Lock -Force -ErrorAction SilentlyContinue }',
    '  if ($lockAcquired) { Remove-Item -LiteralPath $Script -Force -ErrorAction SilentlyContinue }',
    '}'
  ].join('\r\n') + '\r\n'
  fs.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o600 })
  const { spawn: spawnChild } = require('child_process')
  const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ParentPid', String(process.pid), '-Installer', installerPath, '-Executable', executablePath, '-InstallDirectory', installDirectory, '-ExpectedVersion', String(expectedVersion || ''), '-Script', scriptPath, '-Log', logPath, '-Marker', markerPath, '-Lock', lockPath]
  const child = spawnChild(powershell, args, { detached: true, windowsHide: true, stdio: 'ignore' })
  child.once('error', (error) => {
    try { fs.appendFileSync(logPath, `更新器启动失败: ${error.message}\r\n`, { encoding: 'utf8' }) } catch {}
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      marker.status = 'failed'; marker.error = `更新器启动失败: ${error.message}`; marker.logPath = logPath; marker.updatedAt = new Date().toISOString()
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 })
    } catch {}
  })
  child.unref()
  return { scriptPath, logPath, executablePath, markerPath, lockPath }
}

function recoverPendingUpdate() {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  const markerPath = pendingUpdatePath()
  let pending
  try { pending = JSON.parse(fs.readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, '')) } catch { return false }
  if (pending?.status === 'failed') {
    recoveredUpdateState = { status: 'error', message: String(pending.error || '上次自动更新失败'), logPath: String(pending.logPath || '') }
    return false
  }
  const installerPath = String(pending?.installerPath || '')
  const expectedVersion = String(pending?.expectedVersion || '')
  if (expectedVersion && compareVersions(app.getVersion(), expectedVersion) >= 0) {
    try { fs.rmSync(markerPath, { force: true }); fs.rmSync(installerPath, { force: true }) } catch {}
    return false
  }
  if (!installerPath || !fs.existsSync(installerPath)) {
    try { fs.rmSync(markerPath, { force: true }) } catch {}
    return false
  }
  scheduleWindowsInstall(installerPath, expectedVersion, markerPath)
  setTimeout(() => app.exit(0), 250)
  return true
}

function getUpdateState() {
  return recoveredUpdateState ? { ...recoveredUpdateState } : { status: 'idle', message: '' }
}

async function downloadAndInstallUpdate() {
  if (updateInProgress) throw new Error('更新正在进行中')
  updateInProgress = true
  let installerPath = ''
  try {
    const info = await checkForUpdate()
    if (!info.available) return { ...info, status: 'latest' }
    if (process.platform !== 'win32') throw new Error('当前自动安装仅支持 Windows')
    if (!app.isPackaged) throw new Error('开发模式不能自动安装更新，请使用已安装的 AnYuAgent')
    const tempName = `AnYuAgent-update-${info.latestVersion}-${Date.now()}.exe`
    installerPath = path.join(app.getPath('temp'), tempName)
    sendUpdateProgress({ phase: 'downloading', version: info.latestVersion, loaded: 0, total: info.artifact.bytes, percent: 0 })
    const response = await fetch(info.artifact.url, { headers: { Accept: 'application/octet-stream' } })
    if (!response.ok || !response.body) throw new Error(`更新包下载失败 (HTTP ${response.status})`)
    const file = await fs.promises.open(installerPath, 'wx', 0o700)
    const hash = crypto.createHash('sha256')
    let loaded = 0
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        await file.write(buffer)
        hash.update(buffer)
        loaded += buffer.length
        sendUpdateProgress({ phase: 'downloading', version: info.latestVersion, loaded, total: info.artifact.bytes, percent: Math.min(100, Math.round(loaded / info.artifact.bytes * 100)) })
      }
      await file.sync()
    } finally {
      await file.close()
    }
    const actualSha256 = hash.digest('hex')
    if (loaded !== info.artifact.bytes) throw new Error(`更新包大小校验失败（期望 ${info.artifact.bytes}，实际 ${loaded}）`)
    if (actualSha256 !== info.artifact.sha256.toLowerCase()) throw new Error('更新包 SHA-256 校验失败')
    sendUpdateProgress({ phase: 'installing', version: info.latestVersion, loaded, total: loaded, percent: 100 })
    // Release the bundled Pi runtime before the installer replaces app resources.
    await stopPi()
    const markerPath = writePendingUpdate(installerPath, info.latestVersion)
    scheduleWindowsInstall(installerPath, info.latestVersion, markerPath)
    // Give the detached updater a moment to receive the handoff. The forced
    // exit fallback prevents a hidden window or child process from blocking it.
    setTimeout(() => {
      app.quit()
      setTimeout(() => app.exit(0), 1500)
    }, 250)
    return { ...info, status: 'installing' }
  } catch (error) {
    if (installerPath) { try { fs.rmSync(installerPath, { force: true }) } catch {} }
    sendUpdateProgress({ phase: 'error', message: error.message || '自动更新失败' })
    throw error
  } finally {
    updateInProgress = false
  }
}

function authFile() { return path.join(app.getPath('userData'), 'anyu-auth.json') }
function protect(value) {
  if (!value) return ''
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : value
}
function unprotect(value) {
  if (!value) return ''
  if (!safeStorage.isEncryptionAvailable()) return value
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')) } catch { return '' }
}
function loadAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(authFile(), 'utf8'))
    auth = { accessToken: unprotect(raw.accessToken), refreshToken: unprotect(raw.refreshToken), user: raw.user || null }
    if (!auth.accessToken) auth = null
  } catch { auth = null }
}
function saveAuth(data) {
  auth = data
  const out = { accessToken: protect(data.accessToken), refreshToken: protect(data.refreshToken), user: data.user || null }
  fs.mkdirSync(path.dirname(authFile()), { recursive: true })
  fs.writeFileSync(authFile(), JSON.stringify(out), { mode: 0o600 })
}
function clearAuth() {
  auth = null
  try { fs.rmSync(authFile(), { force: true }) } catch {}
}

function piAgentDir() { return path.join(app.getPath('userData'), 'pi') }
function piSessionDir() { return path.join(piAgentDir(), 'sessions') }
function piAttachmentDir() { return path.join(piAgentDir(), 'attachments') }
function piAttachmentIndexFile() { return path.join(piAttachmentDir(), 'index.json') }
function piMediaDir() { return path.join(piAgentDir(), 'media') }
function piMediaIndexFile() { return path.join(piMediaDir(), 'index.json') }
function piSessionMetaFile() { return path.join(piAgentDir(), 'sessions-meta.json') }
function readPiSessionMeta() {
  try {
    const value = JSON.parse(fs.readFileSync(piSessionMetaFile(), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
function writePiSessionMeta(meta) {
  fs.mkdirSync(piAgentDir(), { recursive: true })
  fs.writeFileSync(piSessionMetaFile(), JSON.stringify(meta, null, 2), { mode: 0o600 })
}
function sessionMetaKey(sessionPath) { return path.resolve(String(sessionPath || '')) }
function assertPiSessionPath(sessionPath, { allowMissing = true } = {}) {
  const value = String(sessionPath || '')
  if (!value || !isInside(piSessionDir(), value) || path.extname(value).toLowerCase() !== '.jsonl') throw new Error('不允许操作工作区之外的会话文件')
  if (!allowMissing && !fs.existsSync(value)) throw new Error('会话文件不存在')
  return path.resolve(value)
}
function sessionMetaAction(payload = {}) {
  const action = String(payload.action || '')
  const sessionPath = assertPiSessionPath(payload.sessionPath, { allowMissing: action === 'delete' })
  const key = sessionMetaKey(sessionPath)
  const meta = readPiSessionMeta()
  const current = meta[key] && typeof meta[key] === 'object' ? meta[key] : {}
  if (action === 'pin') {
    meta[key] = { ...current, pinned: Boolean(payload.pinned), updatedAt: Date.now() }
  } else if (action === 'rename') {
    const title = String(payload.title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!title) throw new Error('会话名称不能为空')
    meta[key] = { ...current, title, updatedAt: Date.now() }
  } else if (action === 'delete') {
    try { if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { force: true }) } catch (error) { throw new Error(`删除会话失败：${error.message}`) }
    delete meta[key]
    const attachmentIndex = readAttachmentIndex()
    const attachmentKey = attachmentSessionKey(sessionPath)
    for (const record of (Array.isArray(attachmentIndex[attachmentKey]) ? attachmentIndex[attachmentKey] : [])) {
      try { if (record?.file) fs.rmSync(record.file, { force: true }) } catch {}
    }
    delete attachmentIndex[attachmentKey]
    writeAttachmentIndex(attachmentIndex)
    const mediaIndex = readMediaIndex()
    delete mediaIndex[attachmentKey]
    writeMediaIndex(mediaIndex)
  } else throw new Error('不支持的会话操作')
  writePiSessionMeta(meta)
  return { ok: true, action, path: sessionPath, pinned: Boolean(meta[key]?.pinned), title: meta[key]?.title || '' }
}
function attachmentSessionKey(sessionPath) {
  return crypto.createHash('sha256').update(String(sessionPath || 'unsaved')).digest('hex')
}
function readAttachmentIndex() {
  try {
    const value = JSON.parse(fs.readFileSync(piAttachmentIndexFile(), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function writeAttachmentIndex(index) {
  fs.mkdirSync(piAttachmentDir(), { recursive: true })
  fs.writeFileSync(piAttachmentIndexFile(), JSON.stringify(index, null, 2), { mode: 0o600 })
}
function safeAttachmentId(value) {
  const id = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
  return id || `attachment-${Date.now()}`
}
function savePiAttachments(payload = {}) {
  const sessionPath = String(payload.sessionPath || '')
  if (sessionPath && !isInside(piSessionDir(), sessionPath)) throw new Error('不允许保存工作区之外的会话附件')
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : []
  if (!attachments.length) return []
  const index = readAttachmentIndex()
  const key = attachmentSessionKey(sessionPath)
  const current = Array.isArray(index[key]) ? index[key] : []
  fs.mkdirSync(piAttachmentDir(), { recursive: true })
  const saved = []
  for (const attachment of attachments) {
    if (attachment?.kind !== 'image' || typeof attachment.data !== 'string' || !attachment.data) continue
    const id = safeAttachmentId(attachment.id)
    let buffer
    try { buffer = Buffer.from(attachment.data, 'base64') } catch { continue }
    if (!buffer.length || buffer.length > 16 * 1024 * 1024) continue
    const file = path.join(piAttachmentDir(), `${key}-${id}.bin`)
    fs.writeFileSync(file, buffer, { mode: 0o600 })
    const record = {
      id, kind: 'image', name: String(attachment.name || id).slice(0, 240),
      size: Number(attachment.size || buffer.length), mimeType: String(attachment.mimeType || 'image/png'),
      messageText: String(payload.messageText || ''), createdAt: Number(payload.createdAt || Date.now()), file
    }
    const oldIndex = current.findIndex((item) => item.id === id && item.messageText === record.messageText)
    if (oldIndex >= 0) current[oldIndex] = record
    else current.push(record)
    saved.push({ ...record })
  }
  index[key] = current.slice(-500)
  writeAttachmentIndex(index)
  return saved
}
function loadPiAttachments(sessionPath) {
  const key = attachmentSessionKey(String(sessionPath || ''))
  const index = readAttachmentIndex()
  const records = Array.isArray(index[key]) ? index[key] : []
  return records.flatMap((record) => {
    try {
      const data = fs.readFileSync(record.file).toString('base64')
      return [{ ...record, dataUrl: `data:${record.mimeType || 'image/png'};base64,${data}` }]
    } catch { return [] }
  })
}
function readMediaIndex() {
  try {
    const value = JSON.parse(fs.readFileSync(piMediaIndexFile(), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function writeMediaIndex(index) {
  fs.mkdirSync(piMediaDir(), { recursive: true })
  fs.writeFileSync(piMediaIndexFile(), JSON.stringify(index, null, 2), { mode: 0o600 })
}
function mediaMessageRecord(message) {
  if (!message || !['user', 'assistant', 'tool'].includes(message.role)) return null
  const record = {
    id: message.id ? String(message.id) : undefined,
    role: message.role,
    content: String(message.content || ''),
    createdAt: Number(message.createdAt || Date.now()),
    isError: Boolean(message.isError),
    mediaPending: Boolean(message.mediaPending)
  }
  if (Array.isArray(message.attachments)) {
    record.attachments = message.attachments.filter((item) => item?.kind === 'image' && typeof item.data === 'string' && item.data).map((item) => ({
      id: String(item.id || `media-image-${Date.now()}`), kind: 'image', name: String(item.name || 'Anyu 生图.png'),
      size: Number(item.size || Math.floor(item.data.length * 0.75)), mimeType: String(item.mimeType || 'image/png'), data: item.data,
      dataUrl: `data:${String(item.mimeType || 'image/png')};base64,${item.data}`,
      downloadTaskId: item.downloadTaskId ? String(item.downloadTaskId) : undefined,
      downloadIndex: Number.isFinite(Number(item.downloadIndex)) ? Number(item.downloadIndex) : 0
    }))
  }
  if (message.media?.kind === 'video' && typeof message.media.dataUrl === 'string' && message.media.dataUrl) {
    record.media = { kind: 'video', name: String(message.media.name || 'Anyu 生视频.mp4'), data: String(message.media.data || ''), dataUrl: message.media.dataUrl, downloadTaskId: message.media.downloadTaskId ? String(message.media.downloadTaskId) : undefined }
  }
  if (message.mediaPlan) record.mediaPlan = message.mediaPlan
  return record
}
function savePiMediaMessages(payload = {}) {
  const sessionPath = String(payload.sessionPath || '')
  if (!sessionPath || !isInside(piSessionDir(), sessionPath)) throw new Error('不允许保存工作区之外的媒体会话')
  const messages = Array.isArray(payload.messages) ? payload.messages.map(mediaMessageRecord).filter(Boolean).slice(-100) : []
  const index = readMediaIndex(); const key = attachmentSessionKey(sessionPath)
  index[key] = { sessionPath, cwd: String(payload.cwd || ''), modified: Date.now(), messages }
  writeMediaIndex(index)
  return { ok: true }
}
function loadPiMediaMessages(sessionPath) {
  const key = attachmentSessionKey(String(sessionPath || ''))
  const record = readMediaIndex()[key]
  return Array.isArray(record?.messages) ? record.messages : []
}
function piExecutable() {
  const packaged = app.isPackaged
  return packaged
    ? path.join(process.resourcesPath, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi')
    : path.join(__dirname, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi')
}
function materializePiSession(payload = {}) {
  const sessionPath = String(payload.sessionPath || '')
  if (!sessionPath || !isInside(piSessionDir(), sessionPath)) throw new Error('不允许创建工作区之外的会话文件')
  if (fs.existsSync(sessionPath)) {
    const requestedCwd = String(payload.cwd || '').trim()
    if (requestedCwd) {
      try {
        const lines = fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/)
        const header = JSON.parse(lines[0])
        if (header?.type === 'session' && header.cwd !== requestedCwd) {
          header.cwd = requestedCwd; lines[0] = JSON.stringify(header); fs.writeFileSync(sessionPath, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 })
          return { ok: true, created: false, updated: true, path: sessionPath }
        }
      } catch {}
    }
    return { ok: true, created: false, path: sessionPath }
  }
  const sessionId = path.basename(sessionPath, '.jsonl').split('_').pop() || crypto.randomUUID()
  const cwd = String(payload.cwd || app.getPath('home'))
  const header = { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.writeFileSync(sessionPath, `${JSON.stringify(header)}\n`, { mode: 0o600 })
  return { ok: true, created: true, path: sessionPath }
}
function sessionWorkingDirectory(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return ''
  try {
    const first = fs.readFileSync(sessionPath, 'utf8').split(/\r?\n/).find(Boolean)
    const header = first ? JSON.parse(first) : null
    return header?.type === 'session' ? String(header.cwd || '') : ''
  } catch { return '' }
}
function isInside(parent, candidate) {
  const root = path.resolve(parent) + path.sep
  return path.resolve(candidate).startsWith(root)
}
function keyValue(record) {
  if (!record || typeof record !== 'object') return ''
  for (const name of ['key', 'api_key', 'apiKey', 'token', 'secret', 'value', 'key_value', 'secret_key', 'token_value']) {
    if (typeof record[name] === 'string' && record[name].trim()) return record[name].trim()
  }
  return ''
}
function rememberKeys(payload) {
  const items = Array.isArray(payload) ? payload : payload?.items || payload?.data || payload?.keys || []
  if (!Array.isArray(items)) return
  for (const item of items) if (item?.id != null) keyCache.set(String(item.id), item)
}

function modelConfig(models) {
  const grouped = new Map()
  for (const model of (Array.isArray(models) ? models : [])) {
    const id = String(model?.id || model?.name || '').replace(/^models\//, '').trim()
    if (!id) continue
    const lower = `${id} ${model?.api || ''}`.toLowerCase()
    const api = canonicalApi(model?.api, lower.includes('gemini') || lower.includes('google') ? 'google-generative-ai' : lower.includes('claude') || lower.includes('anthropic') ? 'anthropic-messages' : 'openai-completions')
    const provider = providerForApi(api)
    if (!grouped.has(provider)) grouped.set(provider, { api, models: [] })
    grouped.get(provider).models.push({
      id,
      name: String(model?.name || model?.display_name || id),
      api,
      baseUrl: baseUrlForApi(api),
      reasoning: Boolean(model?.reasoning || model?.supports_reasoning || model?.supportsReasoning || model?.thinkingLevelMap || model?.thinking_level_map),
      thinkingLevelMap: model?.thinkingLevelMap || model?.thinking_level_map || model?.reasoning_effort_map || model?.reasoningEffortMap,
      compat: model?.compat,
      input: modelInputCapabilities(model, id, api),
      supportsImages: modelInputCapabilities(model, id, api).includes('image'),
      supportsTools: model?.supportsTools ?? model?.supports_tools ?? model?.capabilities?.tools,
      permissionMode: model?.permissionMode || model?.permission_mode || '',
      contextWindow: Number(model?.contextWindow || model?.context_window || 128000),
      maxTokens: Number(model?.maxTokens || model?.max_tokens || 16384),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
  }
  const providers = {}
  for (const [provider, group] of grouped) providers[provider] = { name: `Anyu ${group.api}`, baseUrl: baseUrlForApi(group.api), api: group.api, apiKey: '$ANYU_API_KEY', authHeader: true, models: group.models }
  return { providers }
}

function parsePiLines(chunk) {
  piBuffer += chunk.toString('utf8')
  while (true) {
    const index = piBuffer.indexOf('\n')
    if (index < 0) break
    const line = piBuffer.slice(0, index).replace(/\r$/, '')
    piBuffer = piBuffer.slice(index + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.type === 'response' && message.id && piPending.has(message.id)) {
      settlePiRequest(message.id, message.success === false ? new Error(message.error || 'Pi command failed') : null, message)
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pi:event', message)
  }
}

function settlePiRequest(id, error, value) {
  const pending = piPending.get(id)
  if (!pending) return
  piPending.delete(id)
  if (pending.timer) clearTimeout(pending.timer)
  if (error) pending.reject(error)
  else pending.resolve(value)
}

async function stopPi() {
  const child = piProcess
  if (!child) return
  piProcess = null
  for (const id of [...piPending.keys()]) settlePiRequest(id, new Error('Pi process stopped'))
  try { child.stdin?.end() } catch {}
  try { child.kill() } catch {}
  const waitForExit = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve()
    const timer = setTimeout(resolve, 1200)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  await waitForExit()
  if (child.exitCode === null && !child.signalCode) {
    try { child.kill('SIGKILL') } catch {}
    await waitForExit()
  }
}

function sendPi(command) {
  if (!piProcess?.stdin?.writable) return Promise.reject(new Error('Pi Agent 尚未启动'))
  const id = command.id || `anyu-${++piRequestCounter}`
  const payload = { ...command, id }
  // Prompt and steer are asynchronous task submissions. Pi acknowledges them
  // separately from the eventual agent_end/agent_settled events, so applying a
  // client-side timeout here can report a false failure while the task is still
  // running. They remain pending until Pi acknowledges them or the process exits.
  // 异步任务提交只等待 Pi 的接收确认，不能因长输出超过客户端等待时间而误报失败。
  const timeoutMs = ['prompt', 'steer', 'follow_up'].includes(command.type) ? 0 : 15000
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => { settlePiRequest(id, new Error(`Pi 命令超时：${command.type || 'unknown'}`)) }, timeoutMs)
      : null
    piPending.set(id, { resolve, reject, timer })
    try { piProcess.stdin.write(`${JSON.stringify(payload)}\n`) } catch (error) {
      settlePiRequest(id, error)
    }
  })
}

async function startPiUnsafe(options = {}) {
  const record = keyCache.get(String(options.keyId))
  const apiKey = keyValue(record)
  if (!apiKey) throw new Error('所选密钥没有可用的 API Key，请刷新密钥列表后重试')
  const executable = piExecutable()
  if (!fs.existsSync(executable)) throw new Error(`Pi 运行时不存在：${executable}`)
  await stopPi()
  const agentDir = piAgentDir(); const sessionDir = piSessionDir()
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(modelConfig(options.models), null, 2), { mode: 0o600 })
  const selectedModel = (Array.isArray(options.models) ? options.models : []).find((model) => String(model?.id || model?.name || '') === String(options.model || '')) || options.models?.[0] || {}
  const provider = String(options.provider || providerForApi(selectedModel.api || 'openai-completions'))
  const resolvedPermissionMode = resolvePermissionMode(options.permissionMode, selectedModel, provider)
  const args = ['--mode', 'rpc', '--provider', provider, '--model', String(options.model || selectedModel.id || 'gpt-4o-mini'), '--session-dir', sessionDir]
  if (resolvedPermissionMode === 'full') args.push('--approve')
  if (options.sessionPath && isInside(sessionDir, options.sessionPath)) args.push('--session', path.resolve(options.sessionPath))
  const sessionCwd = options.sessionPath ? sessionWorkingDirectory(options.sessionPath) : ''
  const requestedCwd = sessionCwd || options.cwd
  const cwd = requestedCwd && fs.existsSync(requestedCwd) && fs.statSync(requestedCwd).isDirectory() ? requestedCwd : app.getPath('home')
  const pluginPaths = pluginManager ? pluginManager.runtimeSkillPaths(cwd) : []
  for (const skillPath of pluginPaths) args.push('--skill', skillPath)
  piBuffer = ''
  let startupStderr = ''
  piProcess = spawn(executable, args, {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, ANYU_API_KEY: apiKey, PI_SKIP_VERSION_CHECK: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const child = piProcess
  child.stdout.on('data', parsePiLines)
  child.stderr.on('data', (data) => { const message = data.toString(); startupStderr = `${startupStderr}${message}`.slice(-4000); console.error(`[pi] ${message}`); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pi:stderr', message) })
  child.once('error', (error) => {
    if (piProcess === child) {
      piProcess = null
      for (const id of [...piPending.keys()]) settlePiRequest(id, error)
    }
  })
  child.once('exit', (code) => {
    if (piProcess === child) {
      piProcess = null
      const error = new Error(`Pi Agent 已退出 (${code ?? 'unknown'})`)
      for (const id of [...piPending.keys()]) settlePiRequest(id, error)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pi:exit', { code })
    }
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Pi Agent 启动超时${startupStderr.trim() ? `: ${startupStderr.trim().slice(-1200)}` : ''}`)), 12000)
    const fail = (error) => { clearTimeout(timer); reject(error) }
    child.once('error', fail)
    child.once('exit', (code, signal) => { fail(new Error(`Pi Agent 启动失败 (${code ?? signal ?? 'unknown'})${startupStderr.trim() ? `: ${startupStderr.trim().slice(-1200)}` : ''}`)) })
    const check = () => {
      if (child.exitCode !== null) { fail(new Error(`Pi Agent 启动失败 (${child.exitCode})${startupStderr.trim() ? `: ${startupStderr.trim().slice(-1200)}` : ''}`)); return }
      if (piProcess === child) { clearTimeout(timer); resolve() } else setTimeout(check, 60)
    }
    setTimeout(check, 120)
  })
  await sendPi({ type: 'get_state' })
  return { ok: true, cwd, sessionDir, permissionMode: resolvedPermissionMode }
}

async function startPi(options = {}) {
  const run = piStartLock.then(() => startPiUnsafe(options), () => startPiUnsafe(options))
  piStartLock = run.catch(() => {})
  return run
}

function listPiSessions() {
  const directory = piSessionDir()
  if (!fs.existsSync(directory)) return []
  const sessionMeta = readPiSessionMeta()
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  visit(directory)
  const sessions = files.map((file) => {
    let title = '新会话'; let modified = 0; let firstMessageAt = 0; let entryCreatedAt = 0; let fileBirthtime = 0; let cwd = ''; let hasNamedTitle = false
    try {
      const stat = fs.statSync(file)
      modified = stat.mtimeMs
      fileBirthtime = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        let entry; try { entry = JSON.parse(line) } catch { continue }
        const messageTime = entry.message && (entry.message.timestamp || entry.message.createdAt || entry.message.time)
        const entryTime = timestampValue(entry.timestamp || entry.createdAt || entry.time || messageTime)
        if (entry.type === 'session') { if (entry.name) { title = entry.name; hasNamedTitle = true }; cwd = String(entry.cwd || ''); if (!entryCreatedAt && entryTime) entryCreatedAt = entryTime }
        const message = entry.message
        if (message?.role === 'user') {
          if (!firstMessageAt && entryTime) firstMessageAt = entryTime
          const content = Array.isArray(message.content) ? message.content.find((part) => part.type === 'text')?.text : message.content
          if (!hasNamedTitle && content) title = String(content).replace(/\s+/g, ' ').slice(0, 48)
        }
      }
    } catch {}
    const metadata = sessionMeta[sessionMetaKey(file)] || {}
    firstMessageAt = firstMessageAt || entryCreatedAt || fileBirthtime || modified
    return { path: file, title: String(metadata.title || title), createdAt: Number(firstMessageAt), firstMessageAt: Number(firstMessageAt), modified, cwd, pinned: Boolean(metadata.pinned) }
  })
  // A media-only first message is intentionally kept in a sidecar until Pi
  // receives a normal assistant turn. Include that virtual session in history
  // so it behaves like every other conversation immediately.
  const mediaIndex = readMediaIndex()
  const mediaByPath = new Map(Object.values(mediaIndex).map((record) => [path.resolve(String(record?.sessionPath || '')), record]))
  for (const item of sessions) {
    if (item.title !== '新会话') continue
    const record = mediaByPath.get(path.resolve(item.path)); const firstUser = (record?.messages || []).find((message) => message?.role === 'user')
    if (firstUser?.content) item.title = String(firstUser.content).replace(/\s+/g, ' ').slice(0, 48)
    if (record?.createdAt || record?.modified) item.createdAt = item.firstMessageAt = timestampValue(record.createdAt || record.modified)
  }
  const known = new Set(sessions.map((item) => path.resolve(item.path)))
  for (const record of Object.values(mediaIndex)) {
    const sessionPath = String(record?.sessionPath || '')
    if (!sessionPath || !isInside(piSessionDir(), sessionPath) || known.has(path.resolve(sessionPath))) continue
    const firstUser = (record.messages || []).find((message) => message?.role === 'user')
    const metadata = sessionMeta[sessionMetaKey(sessionPath)] || {}
    const createdAt = timestampValue(record.createdAt || record.modified)
    sessions.push({ path: sessionPath, title: String(metadata.title || firstUser?.content || '新会话').replace(/\s+/g, ' ').slice(0, 48) || '新会话', createdAt, firstMessageAt: createdAt, modified: createdAt, cwd: String(record.cwd || ''), pinned: Boolean(metadata.pinned) })
  }
  return sessions.sort((a, b) => Number(b.createdAt || b.firstMessageAt || b.modified || 0) - Number(a.createdAt || a.firstMessageAt || a.modified || 0) || String(a.path).localeCompare(String(b.path)))
}

async function requestApi(route, options = {}, retry = true) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) }
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${API_BASE}${route}`, {
    method: options.method || 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
  let payload = null
  const text = await response.text()
  try { payload = text ? JSON.parse(text) : null } catch { payload = { message: text } }
  if (response.status === 401 && retry && auth?.refreshToken && !route.includes('/auth/')) {
    const refreshed = await requestApi('/auth/refresh', { method: 'POST', body: { refresh_token: auth.refreshToken } }, false).catch(() => null)
    if (refreshed?.access_token) {
      saveAuth({ ...auth, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || auth.refreshToken })
      return requestApi(route, options, false)
    }
    clearAuth()
  }
  if (!response.ok || (payload && payload.code && payload.code !== 0)) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status})`)
    error.status = response.status; error.code = payload?.code
    throw error
  }
  const result = payload && payload.code === 0 ? payload.data : payload
  if (/^\/keys(?:[?\/]|$)/i.test(route)) rememberKeys(result)
  return result
}

// Keep multipart assembly and media downloads in the main process so the
// renderer never needs to handle the Anyu JWT or gateway credentials.
async function requestMultipart(route, fields = {}, files = [], retry = true, maxFileBytes = 16 * 1024 * 1024) {
  const boundary = `----AnYuAgent${crypto.randomBytes(12).toString('hex')}`
  const chunks = []
  const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value)))
  for (const [name, value] of Object.entries(fields || {})) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value ?? '')}\r\n`)
  }
  for (const file of Array.isArray(files) ? files : []) {
    if (!file?.field || typeof file.data !== 'string') continue
    let data
    try { data = Buffer.from(file.data, 'base64') } catch { continue }
    if (!data.length || data.length > maxFileBytes) continue
    const field = String(file.field).replace(/[^a-zA-Z0-9_.-]/g, '_')
    const filename = String(file.name || 'reference.png').replace(/["\\\r\n]/g, '_')
    const mime = String(file.mimeType || 'application/octet-stream').replace(/[\r\n]/g, '')
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`)
    push(data); push('\r\n')
  }
  push(`--${boundary}--\r\n`)
  const headers = { Accept: 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`
  const response = await fetch(`${API_BASE}${route}`, { method: 'POST', headers, body: Buffer.concat(chunks) })
  const text = await response.text()
  let payload = null; try { payload = text ? JSON.parse(text) : null } catch { payload = { message: text } }
  if (response.status === 401 && retry && auth?.refreshToken) {
    const refreshed = await requestApi('/auth/refresh', { method: 'POST', body: { refresh_token: auth.refreshToken } }, false).catch(() => null)
    if (refreshed?.access_token) {
      saveAuth({ ...auth, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || auth.refreshToken })
      return requestMultipart(route, fields, files, false, maxFileBytes)
    }
    clearAuth()
  }
  if (!response.ok || (payload && payload.code && payload.code !== 0)) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status})`)
    error.status = response.status; error.code = payload?.code; throw error
  }
  return payload && payload.code === 0 ? payload.data : payload
}

async function publishPluginPackage(publication, options = {}) {
  const packagePath = String(publication?.filePath || '')
  if (!packagePath || !fs.existsSync(packagePath)) throw new Error('插件发布包不存在')
  const data = fs.readFileSync(packagePath)
  if (!data.length || data.length > MAX_PACKAGE_BYTES) throw new Error('插件包超过 64 MB 限制')
  const manifest = publication.manifest || {}
  const publisher = options.publisher && typeof options.publisher === 'object' ? options.publisher : { id: 'community', name: String(options.publisherName || '社区用户'), verified: false }
  const fields = {
    plugin_id: String(manifest.id || ''),
    version: String(manifest.version || ''),
    publisher_name: String(publisher.name || ''),
    visibility: options.visibility === 'private' ? 'private' : 'public',
    sha256: String(publication.sha256 || ''),
    manifest: JSON.stringify(manifest),
    metadata: JSON.stringify({ ...manifest, publisher, visibility: options.visibility === 'private' ? 'private' : 'public' })
  }
  return requestMultipart('/marketplace/plugins/publish', fields, [{ field: 'package', name: `${manifest.id || 'plugin'}-${manifest.version || 'latest'}.anyu-plugin.zip`, mimeType: 'application/zip', data: data.toString('base64') }], true, MAX_PACKAGE_BYTES)
}

async function requestBinary(route, retry = true) {
  const headers = { Accept: '*/*' }
  if (auth?.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`
  const response = await fetch(`${API_BASE}${route}`, { headers })
  if (response.status === 401 && retry && auth?.refreshToken) {
    const refreshed = await requestApi('/auth/refresh', { method: 'POST', body: { refresh_token: auth.refreshToken } }, false).catch(() => null)
    if (refreshed?.access_token) {
      saveAuth({ ...auth, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || auth.refreshToken })
      return requestBinary(route, false)
    }
    clearAuth()
  }
  if (!response.ok) throw new Error(`媒体结果不可用 (HTTP ${response.status})`)
  const data = Buffer.from(await response.arrayBuffer())
  let mimeType = response.headers.get('content-type') || 'application/octet-stream'
  if (!/^image\//i.test(mimeType) && !/^video\//i.test(mimeType)) {
    if (data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp') mimeType = 'video/mp4'
    else if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) mimeType = 'video/webm'
    else if (data.length >= 8 && data.toString('ascii', 1, 4) === 'PNG') mimeType = 'image/png'
    else if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) mimeType = 'image/jpeg'
  }
  return { data: data.toString('base64'), mimeType }
}

async function listKeyModels(keyId) {
  const record = keyCache.get(String(keyId))
  const apiKey = keyValue(record)
  if (!apiKey) throw new Error('所选密钥没有可用的 API Key，请刷新密钥列表后重试')
  // The user-authenticated route is protocol-aware and is the source of truth
  // for Anthropic/Gemini/vendor-specific keys. The gateway /v1/models fallback
  // is retained for OpenAI-compatible keys and older Anyu deployments.
  for (const route of [`/keys/${keyId}/models?role=chat`, `/codex/keys/${keyId}/models?role=chat`]) {
    try {
      const result = await requestApi(route)
      const entries = result?.items || result?.models || result?.data || (Array.isArray(result) ? result : [])
      if (Array.isArray(entries) && entries.length) return result
    } catch {}
  }
  const response = await fetch(`${GATEWAY_BASE}/v1/models`, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = { message: text } }
  if (!response.ok) {
    const fallback = record?.models || record?.model_list || record?.available_models
    if (Array.isArray(fallback) && fallback.length) return { items: fallback }
    const protocol = canonicalApi(record?.api || record?.protocol || record?.provider, 'openai-completions')
    throw new Error(`${protocol === 'anthropic-messages' ? 'Anthropic' : protocol === 'google-generative-ai' ? 'Gemini' : '当前协议'} 密钥模型目录不可用 (HTTP ${response.status})，请在 Anyu 中确认该密钥已绑定模型`)
  }
  return payload && payload.code === 0 ? payload.data : payload
}

async function login(body) {
  const data = await requestApi('/auth/login', { method: 'POST', body }, false)
  if (data?.requires_2fa) return data
  saveAuth({ accessToken: data.access_token, refreshToken: data.refresh_token || '', user: data.user || null })
  return data
}
async function login2fa(body) {
  const data = await requestApi('/auth/login/2fa', { method: 'POST', body }, false)
  saveAuth({ accessToken: data.access_token, refreshToken: data.refresh_token || '', user: data.user || null })
  return data
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1050, minHeight: 700,
    title: 'AnYuAgent', backgroundColor: '#00000000',
    frame: false, transparent: true, roundedCorners: true, hasShadow: true,
    icon: path.join(__dirname, 'branding', 'anyu.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' } })
}

function requiredMediaSelection(payload, kind) {
  const groupId = Number(payload?.groupId)
  const model = String(payload?.model || '').trim()
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !model) {
    throw new Error(`请选择当前目录中的${kind === 'image' ? '图片' : '视频'}分组和模型`)
  }
  return { groupId, model }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  if (recoverPendingUpdate()) return
  loadAuth()
  pluginManager = new PluginManager(app.getPath('userData'))
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
     callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'"] } })
  })
  ipcMain.handle('auth:state', async () => {
    if (!auth?.accessToken) return { authenticated: false }
    try {
      const user = await requestApi('/auth/me')
      saveAuth({ ...auth, user: user.user || user })
      return { authenticated: true, user: auth.user }
    } catch { clearAuth(); return { authenticated: false } }
  })
  ipcMain.handle('auth:login', (_, body) => login(body))
  ipcMain.handle('auth:login2fa', (_, body) => login2fa(body))
  ipcMain.handle('auth:logout', async () => {
    try { if (auth?.refreshToken) await requestApi('/auth/logout', { method: 'POST', body: { refresh_token: auth.refreshToken } }) } catch {}
    clearAuth(); return { ok: true }
  })
  ipcMain.handle('api:request', (_, route, options) => requestApi(route, options || {}))
  ipcMain.handle('anyu:skills-groups', () => requestApi('/groups/available'))
  ipcMain.handle('anyu:image-create', (_, payload = {}) => {
    const selection = requiredMediaSelection(payload, 'image')
    return requestMultipart('/anyu-ai/tasks', {
      prompt: payload.prompt, group_id: selection.groupId, model: selection.model,
      size: payload.size || '1024x1024', quality: payload.quality || 'auto', count: payload.count || 1
    }, (payload.references || []).map((file) => ({ ...file, field: 'reference_images' })))
  })
  ipcMain.handle('anyu:image-task', (_, taskId) => requestApi(`/anyu-ai/tasks/${encodeURIComponent(String(taskId || ''))}`))
  ipcMain.handle('anyu:image-download', (_, taskId, index = 0) => requestBinary(`/anyu-ai/tasks/${encodeURIComponent(String(taskId || ''))}/images/${Number(index) || 0}`))
  ipcMain.handle('anyu:video-create', (_, payload = {}) => {
    const selection = requiredMediaSelection(payload, 'video')
    // Keep provider defaults server-owned. The skill planner supplies a value
    // only when the user's request and the selected model make one necessary.
    const fields = { prompt: payload.prompt, group_id: selection.groupId, model: selection.model }
    if (Number.isFinite(Number(payload.duration)) && Number(payload.duration) > 0) fields.duration = Number(payload.duration)
    if (String(payload.resolution || '').trim()) fields.resolution = String(payload.resolution).trim()
    if (String(payload.aspectRatio || '').trim()) fields.aspect_ratio = String(payload.aspectRatio).trim()
    return requestMultipart('/anyu-ai/video-tasks', fields, (payload.references || []).map((file) => ({ ...file, field: file.field || 'reference_images' })))
  })
  ipcMain.handle('anyu:video-task', (_, taskId) => requestApi(`/anyu-ai/video-tasks/${encodeURIComponent(String(taskId || ''))}`))
  ipcMain.handle('anyu:video-download', (_, taskId) => requestBinary(`/anyu-ai/video-tasks/${encodeURIComponent(String(taskId || ''))}/video`))
  ipcMain.handle('pi:key-models', (_, keyId) => listKeyModels(keyId))
  ipcMain.handle('pi:save-attachments', (_, payload) => savePiAttachments(payload || {}))
  ipcMain.handle('pi:attachments', (_, sessionPath) => loadPiAttachments(sessionPath))
  ipcMain.handle('pi:materialize-session', (_, payload) => materializePiSession(payload || {}))
  ipcMain.handle('pi:save-media', (_, payload) => savePiMediaMessages(payload || {}))
  ipcMain.handle('pi:media', (_, sessionPath) => loadPiMediaMessages(sessionPath))
  ipcMain.handle('pi:list-sessions', () => listPiSessions())
  ipcMain.handle('pi:session-action', (_, payload) => sessionMetaAction(payload || {}))
  ipcMain.handle('pi:start', (_, options) => startPi(options || {}))
  ipcMain.handle('pi:stop', () => stopPi().then(() => ({ ok: true })))
  ipcMain.handle('pi:command', (_, command) => {
    const allowed = new Set(['prompt', 'steer', 'follow_up', 'abort', 'clear_queue', 'new_session', 'switch_session', 'get_state', 'set_model', 'set_thinking_level', 'get_available_thinking_levels', 'cycle_thinking_level', 'get_messages', 'get_entries', 'get_tree', 'set_session_name'])
    if (!command || !allowed.has(command.type)) throw new Error('不支持的 Pi 命令')
    if (command.type === 'switch_session' && !isInside(piSessionDir(), command.sessionPath)) {
      throw new Error('不允许打开工作区之外的会话文件')
    }
    return sendPi(command)
  })
  ipcMain.handle('pi:ui-response', (_, response) => {
    if (!response?.id || !piProcess?.stdin?.writable) return { ok: false }
    piProcess.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
    return { ok: true }
  })
  ipcMain.handle('app:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('plugin:state', () => pluginManager.state())
  ipcMain.handle('plugin:scan', (_, sourcePath) => pluginManager.scanPackage(sourcePath))
  ipcMain.handle('plugin:pick-package', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'AnYu 插件', extensions: ['anyu-plugin', 'zip'] }, { name: '所有文件', extensions: ['*'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('plugin:install-local', async (_, payload = {}) => pluginManager.install(payload.path, { scope: payload.scope, projectPath: payload.projectPath, source: 'local', visibility: payload.visibility || 'private' }))
  ipcMain.handle('plugin:set-enabled', (_, payload = {}) => pluginManager.setEnabled(payload.id, payload.enabled))
  ipcMain.handle('plugin:uninstall', (_, id) => pluginManager.uninstall(id))
  ipcMain.handle('plugin:rollback', (_, payload = {}) => pluginManager.rollback(payload.id, payload.version))
  ipcMain.handle('plugin:marketplace', async () => {
    try {
      const result = await requestApi('/marketplace/plugins')
      const entries = Array.isArray(result) ? result : result?.items || result?.plugins || result?.data || []
      return (Array.isArray(entries) ? entries : []).map((item) => ({
        ...item,
        id: item?.id || item?.pluginId || item?.plugin_id,
        displayName: item?.displayName || item?.display_name || item?.name,
        description: item?.description || item?.summary || '',
        publisher: item?.publisher || item?.publisherName || item?.publisher_name,
        verified: Boolean(item?.verified || item?.publisher?.verified),
        downloadUrl: item?.downloadUrl || item?.download_url || item?.packageUrl || item?.package_url,
        categories: item?.categories || item?.tags || [],
        keywords: item?.keywords || []
      }))
    } catch { return [] }
  })
  ipcMain.handle('plugin:install-marketplace', async (_, payload = {}) => {
    const url = String(payload.downloadUrl || payload.download_url || '')
    if (!/^https:\/\//i.test(url)) throw new Error('市场插件下载地址无效')
    const response = await fetch(url, { headers: { Accept: 'application/octet-stream' } })
    if (!response.ok) throw new Error(`插件下载失败 (HTTP ${response.status})`)
    const data = Buffer.from(await response.arrayBuffer())
    if (!data.length || data.length > MAX_PACKAGE_BYTES) throw new Error('插件包超过 64 MB 限制')
    const filename = `${crypto.randomUUID()}.anyu-plugin.zip`
    const filePath = path.join(pluginManager.downloadPath, filename)
    fs.writeFileSync(filePath, data, { mode: 0o600 })
    try { return await pluginManager.install(filePath, { scope: payload.scope, projectPath: payload.projectPath, source: 'marketplace', visibility: 'public' }) } finally { fs.rmSync(filePath, { force: true }) }
  })
  ipcMain.handle('plugin:publish', async (_, payload = {}) => {
    const id = String(payload.id || '')
    const record = pluginManager.get(id)
    if (!record?.installedPath) throw new Error('请选择一个已安装的自定义插件')
    const publisherName = String(payload.publisherName || '').trim()
    if (!publisherName) throw new Error('请填写发布者名称')
    const visibility = payload.visibility === 'private' ? 'private' : 'public'
    const publication = await pluginManager.preparePublish(record.installedPath, {
      publisherId: String(payload.publisherId || auth?.user?.id || auth?.user?.user_id || 'community'),
      publisherName,
      visibility
    })
    try {
      const result = await publishPluginPackage(publication, { publisherName, visibility, publisher: publication.manifest.publisher })
      const status = String(result?.publishStatus || result?.reviewStatus || result?.status || result?.state || 'submitted')
      return pluginManager.markPublished(id, {
        visibility,
        status,
        publisher: publication.manifest.publisher,
        marketplaceId: result?.id || result?.pluginId || result?.plugin_id,
        downloadUrl: result?.downloadUrl || result?.download_url || result?.packageUrl
      })
    } finally { fs.rmSync(publication.filePath, { force: true }) }
  })
  ipcMain.handle('update:check', async () => checkForUpdate())
  ipcMain.handle('update:state', () => getUpdateState())
  ipcMain.handle('update:download-install', async () => downloadAndInstallUpdate())
  ipcMain.handle('app:open-external', (_, url) => { if (/^https?:/i.test(url)) return shell.openExternal(url) })
  ipcMain.handle('window:action', (_, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
    else if (action === 'close') mainWindow.close()
    return { ok: true, maximized: mainWindow.isMaximized() }
  })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
