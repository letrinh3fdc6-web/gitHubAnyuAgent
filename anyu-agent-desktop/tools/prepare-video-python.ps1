param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Choose a new Python staging directory' }
$parent = Split-Path -Parent $target
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$archive = Join-Path $parent 'python-3.12.10-embed-amd64.zip'
$source = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'
if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $source -OutFile $archive -TimeoutSec 120 }
Expand-Archive -LiteralPath $archive -DestinationPath $target
@('python312.zip', '.', 'Lib/site-packages', 'import site') | Set-Content -LiteralPath (Join-Path $target 'python312._pth') -Encoding ascii
$requirements = Join-Path $PSScriptRoot '../../../anyuagent-video-studio/runtime/requirements.txt'
python -m pip install --disable-pip-version-check --target (Join-Path $target 'Lib/site-packages') --only-binary=:all: --python-version 3.12 --platform win_amd64 --implementation cp --abi cp312 -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
& (Join-Path $target 'python.exe') -I -c 'import edge_tts, faster_whisper; print(edge_tts.__version__); print(faster_whisper.__version__)'
if ($LASTEXITCODE -ne 0) { throw 'Portable Python health check failed' }
$provenance = @{source=$source; archiveSha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower(); version='3.12.10'; dependencies=(Get-Content -LiteralPath $requirements)}
$provenance | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'source.json') -Encoding utf8
"Portable Python ready: $target"
