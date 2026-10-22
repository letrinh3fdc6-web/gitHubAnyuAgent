param([string]$OutputDirectory = (Join-Path ([Environment]::GetFolderPath('Desktop')) ('AnyuAgent-install-diagnostic-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$registryPaths = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$installed = @(Get-ItemProperty -Path $registryPaths -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'AnyuAgent|AnYuAgent|LetaAgent' } |
    Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString)
$processes = @(foreach ($item in Get-Process -ErrorAction SilentlyContinue) {
    if ($item.ProcessName -notmatch 'Anyu|LetaAgent|old-uninstaller|powershell|^pi$') { continue }
    $image = $null
    $started = $null
    try { $image = $item.Path } catch {}
    try { $started = $item.StartTime.ToString('o') } catch {}
    [pscustomobject]@{ Name = $item.ProcessName; ProcessId = $item.Id; Executable = $image; StartedAt = $started; Responding = $item.Responding; CPU = $item.CPU }
})
$report = [pscustomobject]@{
    CollectedAt = (Get-Date).ToString('o')
    Windows = [Environment]::OSVersion.VersionString
    Is64BitOS = [Environment]::Is64BitOperatingSystem
    PowerShell = $PSVersionTable.PSVersion.ToString()
    InstalledApplications = $installed
    RelatedProcesses = $processes
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'diagnostic.json') -Encoding UTF8
$logs = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'letaagent-updater-*.ps1.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3)
$currentLog = Join-Path $env:TEMP 'AnyuAgent-install.log'
if (Test-Path -LiteralPath $currentLog -PathType Leaf) { $logs += Get-Item -LiteralPath $currentLog }
foreach ($log in $logs) {
    Get-Content -LiteralPath $log.FullName -Tail 200 | Set-Content -LiteralPath (Join-Path $OutputDirectory $log.Name) -Encoding UTF8
}
Write-Output "Diagnostic saved: $OutputDirectory"
