'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test('process inspection tolerates exit races while rejecting a live uninspectable client', { skip: process.platform !== 'win32' }, () => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$source = [IO.File]::ReadAllText($env:ANYU_PROCESS_SOURCE, [Text.Encoding]::UTF8)
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-InstallProcesses' }, $true)
. ([scriptblock]::Create($definition.Extent.Text.Replace('[AnyuInstallerProcessImage]', '[ProcessFixture]')))
Add-Type -TypeDefinition @'
public static class ProcessFixture {
    public static string Mode;
    public static int Queries;
    public static int ExitChecks;
    public static string GetPath(int pid) {
        Queries++;
        if (Mode == "owned" || Mode == "exited-with-image") return @"E:\QA\AnyuAgent.exe";
        if (Mode == "retry-other" && Queries > 1) return @"E:\Other\AnyuAgent.exe";
        if (Mode == "retry-owned" && Queries > 1) return @"E:\QA\AnyuAgent.exe";
        return null;
    }
    public static bool HasExited(int pid) {
        ExitChecks++;
        return Mode == "gone" || Mode == "exited-with-image" || (Mode == "exiting" && ExitChecks > 1);
    }
}
'@
function Get-Process { [pscustomobject]@{ Id = 1987654321; ProcessName = 'AnyuAgent' } }
function Write-InstallLog { param([string]$Message) }
$prefix = 'E:\QA\'; $InstallerProcessId = 0
$results = foreach ($mode in @('gone', 'exiting', 'exited-with-image', 'retry-other', 'retry-owned', 'owned', 'live-denied')) {
    [ProcessFixture]::Mode = $mode; [ProcessFixture]::Queries = 0; [ProcessFixture]::ExitChecks = 0
    try { $targets = @(Get-InstallProcesses); @{ mode = $mode; count = $targets.Count; error = '' } }
    catch { @{ mode = $mode; count = -1; error = $_.Exception.Message } }
}
ConvertTo-Json -InputObject @($results) -Compress
`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, ANYU_PROCESS_SOURCE: path.resolve(__dirname, '../build/installer-processes.ps1') },
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  for (const mode of ['gone', 'exiting', 'exited-with-image', 'retry-other']) assert.equal(report.find(item => item.mode === mode).count, 0, mode)
  for (const mode of ['owned', 'retry-owned']) assert.equal(report.find(item => item.mode === mode).count, 1, mode)
  assert.match(report.find(item => item.mode === 'live-denied').error, /Cannot inspect live/)
})
