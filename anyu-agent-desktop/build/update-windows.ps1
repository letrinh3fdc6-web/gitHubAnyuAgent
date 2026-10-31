param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$lockStream = $null
$window = $null
$script:allowClose = $false

function Write-UpdateLog([string]$Message) {
    Add-Content -LiteralPath $config.logPath -Value "[$(Get-Date -Format o)] $Message" -Encoding UTF8
}

function Set-UpdateStatus([string]$Status, [string]$Message = '') {
    $marker = Get-Content -LiteralPath $config.markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($marker.session -ne $config.session) { throw 'Another update has replaced this update session' }
    $marker | Add-Member -NotePropertyName status -NotePropertyValue $Status -Force
    $marker | Add-Member -NotePropertyName error -NotePropertyValue $Message -Force
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
    if ($window) { $window.FindName('Phase').Text = $Text; Pump-Window }
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

function Get-InstallerFailure([int]$ExitCode) {
    if ($ExitCode -eq 1223) { return 'Windows 安装授权未完成或已取消。请重新打开 AnyuAgent 重试，并在系统授权窗口选择“是”。' }
    return "安装器返回错误 $ExitCode。请查看 $env:TEMP\AnyuAgent-install.log"
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
    $arguments = '/S --updated ' + $installScope + ' /D=' + $config.installDirectory
    $installer = Start-Process -FilePath $config.installerPath -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddMinutes(8)
    while (-not $installer.HasExited -and [DateTime]::UtcNow -lt $deadline) { Pump-Window; Start-Sleep -Milliseconds 150; $installer.Refresh() }
    if (-not $installer.HasExited) { throw '安装仍在进行，未启动客户端。请查看安装日志后重试。' }
    $installer.WaitForExit()
    Write-UpdateLog "Installer exit code: $($installer.ExitCode)"
    if ($installer.ExitCode -ne 0) { throw (Get-InstallerFailure $installer.ExitCode) }
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
    Remove-Item -LiteralPath $config.installerPath -Force -ErrorAction SilentlyContinue
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
