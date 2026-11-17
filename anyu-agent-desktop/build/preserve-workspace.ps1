param([Parameter(Mandatory=$true)][string]$InstallDirectory)
$ErrorActionPreference = 'Stop'

function Get-LongPath([string]$Value) {
    if ($Value.StartsWith('\\?\')) { return $Value }
    if ($Value.StartsWith('\\')) { return '\\?\UNC\' + $Value.Substring(2) }
    return '\\?\' + $Value
}

function Copy-VerifiedTree([string]$Source, [string]$Target) {
    [IO.Directory]::CreateDirectory((Get-LongPath $Target)) | Out-Null
    $count = 0
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries((Get-LongPath $Source))) {
        $attributes = [IO.File]::GetAttributes($entry)
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Workspace contains a linked entry. Original files retained; installation stopped: $entry"
        }
        $destination = Join-Path $Target ([IO.Path]::GetFileName($entry))
        if ($attributes -band [IO.FileAttributes]::Directory) {
            $count += Copy-VerifiedTree $entry $destination
            continue
        }
        $inputStream = $null; $outputStream = $null; $verification = $null
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            # Refuse concurrent writers rather than backing up a partial result.
            $inputStream = [IO.File]::Open($entry, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            $outputStream = [IO.File]::Open((Get-LongPath $destination), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream.CopyTo($outputStream)
            $outputStream.Flush($true)
            $outputStream.Dispose(); $outputStream = $null
            $inputStream.Position = 0
            $sourceHash = [BitConverter]::ToString($hasher.ComputeHash($inputStream))
            $verification = [IO.File]::OpenRead((Get-LongPath $destination))
            $targetHash = [BitConverter]::ToString($hasher.ComputeHash($verification))
            if ($sourceHash -ne $targetHash -or $inputStream.Length -ne $verification.Length) { throw "Workspace backup checksum mismatch: $entry" }
            $count++
        } finally {
            if ($verification) { $verification.Dispose() }
            if ($outputStream) { $outputStream.Dispose() }
            if ($inputStream) { $inputStream.Dispose() }
            $hasher.Dispose()
        }
    }
    return $count
}

try {
    $installation = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
    if ($installation.Length -le [IO.Path]::GetPathRoot($installation).Length) { throw 'Installation root is invalid' }
    $source = Join-Path $installation 'workspace'
    if (-not [IO.Directory]::Exists((Get-LongPath $source))) { Write-Output 'No legacy workspace'; exit 0 }
    if ([IO.File]::GetAttributes((Get-LongPath $source)) -band [IO.FileAttributes]::ReparsePoint) { throw 'Legacy workspace is a linked directory; installation stopped without changing it' }
    $backupRoot = $installation + '.workspace-backups'
    if ([IO.Directory]::Exists((Get-LongPath $backupRoot)) -and ([IO.File]::GetAttributes((Get-LongPath $backupRoot)) -band [IO.FileAttributes]::ReparsePoint)) { throw 'Workspace backup destination must not be a link' }
    $name = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N')
    $destination = Join-Path $backupRoot $name
    $staging = $destination + '.partial'
    $files = Copy-VerifiedTree $source (Join-Path $staging 'workspace')
    $record = @{ version = 1; source = $source; complete = $true; files = $files; at = [DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText((Get-LongPath (Join-Path $staging 'backup.json')), (ConvertTo-Json $record -Compress), [Text.UTF8Encoding]::new($false))
    [IO.Directory]::Move((Get-LongPath $staging), (Get-LongPath $destination))
    Write-Output "Workspace preserved and verified: $files files; $destination"
    exit 0
} catch {
    [Console]::Error.WriteLine("Workspace preservation failed; original files retained: $($_.Exception.Message)")
    exit 36
}
