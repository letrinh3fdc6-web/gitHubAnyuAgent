param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [ValidateSet('Inspect', 'Stop')][string]$Mode = 'Inspect',
    [int]$InstallerProcessId = 0,
    [string]$LogPath = (Join-Path $env:TEMP 'AnyuAgent-install.log')
)
$ErrorActionPreference = 'Stop'

function Write-InstallLog([string]$Message) {
    try { Add-Content -LiteralPath $LogPath -Value "[$(Get-Date -Format o)] $Message" -Encoding UTF8 } catch {}
}

try {
    # Query image paths without enumerating each process's loaded modules.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AnyuInstallerProcessImage {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint size);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    public static string GetPath(uint pid) {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return null;
        try {
            uint size = 32768;
            var image = new StringBuilder((int)size);
            return QueryFullProcessImageName(handle, 0, image, ref size) ? image.ToString() : null;
        } finally { CloseHandle(handle); }
    }
}
'@
    $resolved = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\', '/')
    $volume = [IO.Path]::GetPathRoot($resolved).TrimEnd('\', '/')
    if ($resolved -eq $volume -or -not [IO.Path]::IsPathRooted($InstallDirectory)) {
        throw 'Refusing a drive root or a relative installation directory'
    }
    $prefix = $resolved + [IO.Path]::DirectorySeparatorChar
    Write-InstallLog "$Mode start: $resolved"

    function Get-InstallProcesses {
        foreach ($item in Get-Process -ErrorAction Stop) {
            if ($item.Id -eq $PID -or $item.Id -eq $InstallerProcessId) { continue }
            $image = $null
            try { $image = [AnyuInstallerProcessImage]::GetPath($item.Id) } catch {}
            if (-not $image) {
                if ($item.ProcessName -eq 'AnyuAgent') {
                    throw "Cannot inspect AnyuAgent PID $($item.Id); close it before installing"
                }
                continue
            }
            if ($image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $item }
        }
    }

    $targets = @(Get-InstallProcesses)
    if ($Mode -eq 'Stop' -and $targets.Count) {
        foreach ($item in $targets) { try { [void]$item.CloseMainWindow() } catch {} }
        $deadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            $targets = @(Get-InstallProcesses)
            if (-not $targets.Count) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        foreach ($item in $targets) {
            # Recheck the image path immediately before stopping the process.
            $current = Get-Process -Id $item.Id -ErrorAction SilentlyContinue
            $currentImage = if ($current) { [AnyuInstallerProcessImage]::GetPath($current.Id) } else { $null }
            if ($current -and $currentImage -and $currentImage.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                Write-InstallLog "Stopping installation-owned process $($current.ProcessName), PID $($current.Id)"
                Stop-Process -InputObject $current -Force -ErrorAction Stop
                if (-not $current.WaitForExit(2000)) { throw "Process $($current.Id) did not exit" }
            }
        }
        $targets = @(Get-InstallProcesses)
    }
    if ($targets.Count) {
        Write-InstallLog "$Mode blocked: $($targets.Count) process(es) still use the installation"
        Write-Output "$($targets.Count) process(es) still use this installation."
        exit 10
    }
    Write-InstallLog "$Mode complete: no installation-owned processes remain"
    exit 0
} catch {
    Write-InstallLog "$Mode failed: $($_.Exception.Message)"
    Write-Output $_.Exception.Message
    exit 20
}
