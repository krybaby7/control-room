$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if ($nodePath) { $nodeVersion = & $nodePath --version }
if (-not $nodePath -or $nodeVersion -notmatch '^v(?:2[4-9]|[3-9][0-9])\.') {
  if (-not (Test-Path -LiteralPath $bundledNode)) { throw 'Install Node.js 24 or newer from nodejs.org before starting the companion.' }
  $nodePath = $bundledNode
  $nodeVersion = & $nodePath --version
}
$entryPath = Join-Path $PSScriptRoot 'companion\cli.mjs'
if (-not (Test-Path -LiteralPath $entryPath)) { throw 'Extract the complete companion ZIP before starting it.' }
if ($nodeVersion -notmatch '^v(?:2[4-9]|[3-9][0-9])\.') { throw 'Install Node.js 24 or newer from nodejs.org before starting the companion.' }
$running = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4319 -State Listen -ErrorAction SilentlyContinue
if (-not $running) {
  $dataPath = Join-Path $env:LOCALAPPDATA 'ControlRoomCompanion'
  New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
  $child = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $entryPath + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'companion.log') -RedirectStandardError (Join-Path $dataPath 'companion-error.log') -PassThru
}
$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
  if ($child -and $child.HasExited) { throw 'The companion exited. Check its private error log before restarting it.' }
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4319/' -TimeoutSec 2 -UseBasicParsing
    if ($response.Headers['X-Control-Room-Companion'] -ne '1') { throw 'Port 4319 is occupied by another application.' }
    $ready = $true
    break
  } catch {
    if ($running) { throw 'Port 4319 is occupied, but the Control Room companion could not be verified.' }
    Start-Sleep -Milliseconds 200
  }
}
if (-not $ready) { throw 'The companion did not become ready. Check its private logs.' }
Start-Process 'http://127.0.0.1:4319' | Out-Null
