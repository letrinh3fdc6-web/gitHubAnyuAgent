param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$lockStream = $null
$window = $null
$script:allowClose = $false
$script:phaseText = ''
$script:phaseStarted = [DateTime]::UtcNow
$script:lastStage = ''

function Write-UpdateLog([string]$Message) {
    Add-Content -LiteralPath $config.logPath -Value "[$(Get-Date -Format o)] $Message" -Encoding UTF8
}

function Set-UpdateStatus([string]$Status, [string]$Message = '') {
    $marker = Get-Content -LiteralPath $config.markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($marker.session -ne $config.session) { throw 'Another update has replaced this update session' }
    $marker | Add-Member -NotePropertyName status -NotePropertyValue $Status -Force
    $marker | Add-Member -NotePropertyName error -NotePropertyValue $Message -Force
    $marker | Add-Member -NotePropertyName workerPid -NotePropertyValue $PID -Force
    $marker | Add-Member -NotePropertyName updatedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $temporaryMarker = "$($config.markerPath).$PID.tmp"
    [IO.File]::WriteAllText($temporaryMarker, ($marker | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryMarker -Destination $config.markerPath -Force
}

function Pump-Window {
    if ($window) { $window.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::Background) }
}

function Show-Phase([string]$Text) {
    Write-UpdateLog $Text
    $script:phaseText = $Text
    $script:phaseStarted = [DateTime]::UtcNow
    if ($window) { $window.FindName('Phase').Text = $Text; Pump-Window }
}

function Update-InstallProgress([string]$StageFile) {
    $names = @{
        'checking-processes' = '正在检查安装目录占用…'
        'removing-old' = '正在处理旧版本文件…'
        'removing-old-user' = '正在处理旧用户版本文件…'
        'recovering-old' = '正在兼容处理旧版本长路径文件…'
        'unpacking' = '正在读取安装包…'
        'extracting' = '正在解压应用文件…'
        'copying' = '正在写入应用文件…'
        'registering' = '正在更新安装信息…'
        'installed' = '安装已完成，正在收尾…'
    }
    try {
        if (Test-Path -LiteralPath $StageFile) {
            $stage = (Get-Content -LiteralPath $StageFile -Encoding Unicode -Tail 1 -ErrorAction Stop).Trim()
            if ($names.ContainsKey($stage) -and $stage -ne $script:lastStage) {
                $script:lastStage = $stage
                Show-Phase $names[$stage]
            }
        }
    } catch {}
    if ($window) {
        $elapsed = [int]([DateTime]::UtcNow - $script:phaseStarted).TotalSeconds
        $window.FindName('Phase').Text = "$($script:phaseText) 已等待 $elapsed 秒"
    }
}

function Read-UpdateStatus {
    try { return (Get-Content -LiteralPath $config.markerPath -Raw -Encoding UTF8 | ConvertFrom-Json).status } catch { return '' }
}

function Get-InstallScope {
    $root = [IO.Path]::GetFullPath($config.installDirectory).TrimEnd('\')
    foreach ($hive in @('HKLM', 'HKCU')) {
        foreach ($branch in @('Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
            foreach ($entry in @(Get-ItemProperty -Path "${hive}:\$branch\*" -ErrorAction SilentlyContinue)) {
                $location = $entry.InstallLocation
                if (-not $location -and $entry.PSChildName) {
                    # Electron-builder stores the location under Software\<app GUID>.
                    $installBranch = if ($branch.Contains('WOW6432Node')) { 'Software\WOW6432Node' } else { 'Software' }
                    $installation = Get-ItemProperty -LiteralPath "${hive}:\$installBranch\$($entry.PSChildName)" -ErrorAction SilentlyContinue
                    $location = $installation.InstallLocation
                }
                if ($location -and ([string]$location).TrimEnd('\') -eq $root) {
                    if ($hive -eq 'HKLM') { return '/allusers' }
                    return '/currentuser'
                }
            }
        }
    }
    foreach ($programRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramW6432)) {
        if ($programRoot -and $root.StartsWith($programRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return '/allusers' }
    }
    return '/currentuser'
}

function Get-InstallerFailure([int]$ExitCode, [string]$StageFile = '') {
    if ($ExitCode -eq 1223) { return 'Windows 安装授权未完成或已取消。请重新打开 AnyuAgent 重试，并在系统授权窗口选择“是”。' }
    $stages = @()
    if ($StageFile -and (Test-Path -LiteralPath $StageFile)) {
        try { $stages = @(Get-Content -LiteralPath $StageFile -Encoding Unicode -Tail 40 -ErrorAction Stop) } catch {}
    }
    if ($ExitCode -eq 31 -or $stages -contains 'failed-processes:10') { return '安装目录仍有 AnyuAgent 或运行时进程在使用。请保存任务并完全退出后重试；本次未强行结束任务。' }
    if ($ExitCode -eq 32 -or $stages -contains 'failed-processes:timeout') { return 'Windows 进程检查超时，尚未覆盖应用文件。请稍后重试，并查看安装日志。' }
    if ($ExitCode -eq 33 -or @($stages | Where-Object { $_ -like 'failed-processes:*' }).Count) { return 'Windows 未能完成安装进程检查，尚未覆盖应用文件。请查看安装日志中的具体检查错误。' }
    $busyFile = @($stages | Where-Object { $_ -like 'failed-file-busy:*' } | Select-Object -Last 1)
    if ($busyFile.Count) { return ('旧版本文件正在被占用或无法替换：' + $busyFile[0].Substring('failed-file-busy:'.Length) + '。请关闭占用后重试。') }
    if (@($stages | Where-Object { $_ -like 'failed-old-uninstall:*' }).Count -or ($ExitCode -eq 2 -and @($stages | Where-Object { $_ -in @('removing-old', 'removing-old-user') }).Count)) {
        return '旧版本卸载未完成，可能存在文件占用或目录权限问题。请重新打开旧版并导出安装日志；不要重复启动多个安装器。'
    }
    return "安装器返回错误 $ExitCode。请查看 $env:TEMP\AnyuAgent-install.log"
}

function Get-InstallerStartOptions([string]$Arguments, [string]$Scope) {
    $options = @{ FilePath = $config.installerPath; ArgumentList = $Arguments; WindowStyle = 'Hidden'; PassThru = $true; WorkingDirectory = (Split-Path -Parent $config.installerPath) }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    $isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Write-UpdateLog "Update worker elevated: $isElevated"
    if ($Scope -eq '/allusers' -and -not $isElevated) { $options.Verb = 'RunAs' }
    return $options
}

function Write-InstallFileDiagnostics {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        Write-UpdateLog ("File diagnostics token elevated: " + $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AnyuInstallerFileAccess {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    public static int CheckRenameAccess(string path) {
        // Request DELETE permission without deleting, renaming or writing the file.
        IntPtr handle = CreateFile(path, 0x10000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1)) return Marshal.GetLastWin32Error();
        CloseHandle(handle);
        return 0;
    }
}
'@
        $count = 0
        $failures = 0
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        $directories = [Collections.Generic.Stack[string]]::new()
        $directories.Push($config.installDirectory)
        while ($directories.Count -and [DateTime]::UtcNow -lt $deadline) {
            $directory = $directories.Pop()
            foreach ($file in [IO.Directory]::EnumerateFiles($directory)) {
                if ([DateTime]::UtcNow -ge $deadline) { break }
                $count++
                $code = [AnyuInstallerFileAccess]::CheckRenameAccess($file)
                if ($code -ne 0 -and $code -ne 2 -and $code -ne 3) {
                    $failures++
                    if ($failures -le 20) { Write-UpdateLog "File replacement access failed: Win32 $code, $file" }
                }
            }
            foreach ($child in [IO.Directory]::EnumerateDirectories($directory)) {
                if (-not ([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint)) { $directories.Push($child) }
            }
        }
        Write-UpdateLog "File diagnostics: checked $count, inaccessible $failures, pending directories $($directories.Count) (10 second budget, diagnostic token only; files unchanged)"
    } catch { Write-UpdateLog "File diagnostics unavailable: $($_.Exception.Message)" }
}

try {
    # An unlocked leftover file from a crash must not disable all future updates.
    $lockStream = [IO.File]::Open("$($config.markerPath).lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if ($config.showUI) {
        Add-Type -AssemblyName PresentationFramework
        [xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="AnyuAgent" Width="430" Height="170" WindowStartupLocation="CenterScreen" ResizeMode="NoResize" WindowStyle="None" AllowsTransparency="True" Background="Transparent" Topmost="True">
  <Border Background="#FAFAFA" CornerRadius="8" BorderBrush="#DDDDDD" BorderThickness="1" Padding="22">
    <StackPanel>
      <TextBlock Text="正在安装更新" FontFamily="Microsoft YaHei UI" FontSize="18" FontWeight="SemiBold" Foreground="#252525"/>
      <TextBlock Text="安装完成后 AnyuAgent 将自动重新启动。" FontFamily="Microsoft YaHei UI" FontSize="12" Foreground="#777777" Margin="0,8,0,16"/>
      <ProgressBar x:Name="Progress" Height="5" IsIndeterminate="True" Foreground="#409EFF" Background="#E7E7E7" BorderThickness="0"/>
      <TextBlock x:Name="Phase" FontFamily="Microsoft YaHei UI" FontSize="12" Foreground="#777777" TextWrapping="Wrap" Margin="0,10,0,0"/>
      <Button x:Name="CloseButton" Content="关闭" Width="72" Height="28" HorizontalAlignment="Right" Margin="0,12,0,0" Visibility="Collapsed"/>
    </StackPanel>
  </Border>
</Window>
'@
        $window = [Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($xaml))
        $window.Add_Closing({ param($sender, $event) if (-not $script:allowClose) { $event.Cancel = $true } })
        $window.Show()
    }
    Show-Phase '准备安装…'
    if (-not (Test-Path -LiteralPath $config.installerPath -PathType Leaf)) { throw '更新安装包不存在。' }
    if ((Get-Item -LiteralPath $config.installerPath).Length -ne $config.bytes) { throw '更新包大小校验失败。' }
    # Use the runtime directly; inherited PowerShell module paths can hide Get-FileHash.
    $packageHasher = [Security.Cryptography.SHA256]::Create()
    $packageStream = $null
    try {
        $packageStream = [IO.File]::OpenRead($config.installerPath)
        $packageHash = [BitConverter]::ToString($packageHasher.ComputeHash($packageStream)).Replace('-', '')
    } finally {
        if ($packageStream) { $packageStream.Dispose() }
        $packageHasher.Dispose()
    }
    if ($packageHash -ne $config.sha256) { throw '更新包 SHA-256 校验失败。' }
    if (-not (Test-Path -LiteralPath $config.executablePath -PathType Leaf)) { throw '当前客户端安装位置不存在。' }
    if ((Read-UpdateStatus) -eq 'cancelled') { Write-UpdateLog 'Preparation was cancelled before readiness'; exit 0 }
    Set-UpdateStatus 'prepared'

    # The application commits only after this helper has loaded and verified the package.
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    while ((Read-UpdateStatus) -eq 'prepared' -and [DateTime]::UtcNow -lt $deadline) { Pump-Window; Start-Sleep -Milliseconds 100 }
    if ((Read-UpdateStatus) -ne 'installing') { throw '更新安装未确认，当前客户端未被替换。' }
    Show-Phase '正在关闭旧版本…'
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ((Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Pump-Window; Start-Sleep -Milliseconds 100 }
    if (Get-Process -Id $config.parentPid -ErrorAction SilentlyContinue) { throw '旧版本尚未退出，请关闭后重试。' }

    $inspectPath = Join-Path (Split-Path -Parent $ConfigPath) 'inspect.ps1'
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $inspectArgs = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $inspectPath + '" -InstallDirectory "' + $config.installDirectory + '" -Mode Inspect -LogPath "' + $config.logPath + '"'
        $inspect = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $inspectArgs -WindowStyle Hidden -PassThru
        $inspectDeadline = [DateTime]::UtcNow.AddSeconds(15)
        while (-not $inspect.HasExited -and [DateTime]::UtcNow -lt $inspectDeadline) { Pump-Window; Start-Sleep -Milliseconds 100; $inspect.Refresh() }
        if (-not $inspect.HasExited) { throw '旧版本进程检查超时，尚未开始安装。' }
        $inspect.WaitForExit()
        if ($inspect.ExitCode -eq 0) { break }
        if ($inspect.ExitCode -ne 10) { throw '无法确认旧版本进程已退出，尚未开始安装。' }
        Pump-Window
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($inspect.ExitCode -ne 0) { throw '旧版本仍有进程占用安装目录，尚未开始安装。' }

    Set-UpdateStatus 'installing'
    $installScope = Get-InstallScope
    Write-UpdateLog "Install scope: $installScope"
    if ($installScope -eq '/allusers') {
        Show-Phase '正在安装新版。如出现 Windows 系统授权，请选择“是”…'
    } else {
        Show-Phase '正在安装新版…'
    }
    # NSIS /D must be last and its value must NOT be surrounded by quotes.
    $stageFile = Join-Path (Split-Path -Parent $ConfigPath) 'installer-stages.log'
    $env:ANYU_UPDATE_STAGE_FILE = $stageFile
    Write-UpdateLog "Installer stages: $stageFile"
    $arguments = '/S --updated ' + $installScope + ' --anyu-progress="' + $stageFile + '" /D=' + $config.installDirectory
    $startOptions = Get-InstallerStartOptions $arguments $installScope
    try { $installer = Start-Process @startOptions } catch {
        $startError = $_.Exception
        while ($startError) {
            if ($startError -is [ComponentModel.Win32Exception] -and $startError.NativeErrorCode -eq 1223) { throw (Get-InstallerFailure 1223) }
            $startError = $startError.InnerException
        }
        throw
    }
    $slowNoticeAt = [DateTime]::UtcNow.AddMinutes(8)
    while (-not $installer.HasExited) {
        Update-InstallProgress $stageFile
        if ([DateTime]::UtcNow -ge $slowNoticeAt) {
            Write-UpdateLog 'Installation is taking longer than expected; waiting for the existing installer, not starting another one'
            $slowNoticeAt = [DateTime]::UtcNow.AddMinutes(5)
        }
        Pump-Window; Start-Sleep -Milliseconds 500; $installer.Refresh()
    }
    $installer.WaitForExit()
    Write-UpdateLog "Installer exit code: $($installer.ExitCode)"
    if ($installer.ExitCode -ne 0) {
        Write-InstallFileDiagnostics
        throw (Get-InstallerFailure $installer.ExitCode $stageFile)
    }
    $installedVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($config.executablePath).ProductVersion
    $normalized = [regex]::Match($installedVersion, '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?').Value
    if ($normalized -ne $config.expectedVersion.TrimStart('v')) { throw "安装版本核对失败：期望 $($config.expectedVersion)，实际 $installedVersion" }

    Set-UpdateStatus 'restarting'
    Show-Phase '正在重新启动…'
    if ($config.userDataPath) { $env:ANYU_USER_DATA_DIR = $config.userDataPath }
    $client = Start-Process -FilePath $config.executablePath -WorkingDirectory $config.installDirectory -ArgumentList '--updated' -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ((Read-UpdateStatus) -eq 'completed') { break }
        $client.Refresh()
        if ($client.HasExited) { throw '新版客户端启动后提前退出。' }
        Pump-Window
        Start-Sleep -Milliseconds 100
    }
    if ((Read-UpdateStatus) -ne 'completed') { throw '新版客户端未能在一分钟内完成启动，请手动打开。' }
    Show-Phase '更新完成。'
    # Retain the verified installer as the next differential-download base.
    Write-UpdateLog "Update completed: $($config.expectedVersion)"
} catch {
    $failure = $_.Exception.Message
    try { Write-UpdateLog "Update failed: $failure"; Set-UpdateStatus 'failed' $failure } catch {}
    if ($window) {
        $window.FindName('Progress').IsIndeterminate = $false
        $window.Height = 280
        Show-Phase ("更新未完成：$failure`n日志：$($config.logPath)`n可关闭此窗口后重新打开 AnyuAgent 重试。")
        $script:allowClose = $true
        $closeButton = $window.FindName('CloseButton')
        $closeButton.Visibility = [Windows.Visibility]::Visible
        $closeButton.Add_Click({ $window.Close() })
        while ($window.IsVisible) { Pump-Window; Start-Sleep -Milliseconds 150 }
    }
    exit 1
} finally {
    if ($lockStream) { $lockStream.Dispose() }
    $script:allowClose = $true
    if ($window) { $window.Close() }
}
