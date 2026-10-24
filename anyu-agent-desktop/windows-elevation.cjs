const { execFile } = require('node:child_process')

// Start-Process joins ArgumentList into one Windows command line.
function quoteWindowsArgument(value) {
  return `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

const START_ELEVATED_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
  $options = @{ FilePath = $env:ANYU_WORKER_EXE; Verb = 'RunAs'; PassThru = $true; WindowStyle = 'Hidden'; ErrorAction = 'Stop' }
  if ($env:ANYU_WORKER_ARGS.Length -gt 0) { $options.ArgumentList = $env:ANYU_WORKER_ARGS }
  $workerProcess = Start-Process @options
  'ANYU_UAC:' + (@{ pid = $workerProcess.Id } | ConvertTo-Json -Compress)
} catch {
  $nativeCode = 0
  $exception = $_.Exception
  while ($null -ne $exception) {
    if ($exception -is [System.ComponentModel.Win32Exception]) { $nativeCode = $exception.NativeErrorCode; break }
    $exception = $exception.InnerException
  }
  'ANYU_UAC:' + (@{ code = $nativeCode; message = $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 1
}`

function launchElevated(executable, args = [], { run = execFile, timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', START_ELEVATED_SCRIPT], {
      windowsHide: true, encoding: 'utf8', timeout,
      env: { ...process.env, ANYU_WORKER_EXE: executable, ANYU_WORKER_ARGS: args.map(quoteWindowsArgument).join(' ') },
    }, (error, stdout) => {
      let result
      try { result = JSON.parse(String(stdout || '').split(/\r?\n/).find(line => line.startsWith('ANYU_UAC:')).slice(9)) } catch {}
      if (!error && Number.isSafeInteger(result?.pid) && result.pid > 0) return resolve(result.pid)
      const cancelled = result?.code === 1223
      const code = cancelled ? 'UAC_CANCELLED' : error?.killed ? 'UAC_TIMEOUT' : 'UAC_LAUNCH_FAILED'
      const message = cancelled ? 'Windows UAC 已取消，权限设置未更改。'
        : code === 'UAC_TIMEOUT' ? 'Windows UAC 授权超时，请重新申请。'
          : `管理员执行进程启动失败：${result?.message || error?.message || '未收到启动结果'}`
      reject(Object.assign(new Error(message), { code, cancelled }))
    })
  })
}

module.exports = { launchElevated, quoteWindowsArgument, START_ELEVATED_SCRIPT }
