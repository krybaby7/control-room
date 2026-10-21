param([string[]]$Repository = @(), [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'ControlRoomCompanion\reports'))
$ErrorActionPreference = 'Stop'
$candidates = @((Get-Command node.exe -ErrorAction SilentlyContinue).Source, (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
$node = $null
foreach ($candidate in $candidates) {
 if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf) -and (& $candidate --version) -match '^v24\.') { $node = $candidate; break }
}
if (!$node) { throw 'An existing Node.js 24 runtime is required. No runtime is downloaded automatically.' }
$arguments = @((Join-Path $PSScriptRoot 'cli.mjs'), '--state-dir', $StateDirectory)
foreach ($repo in $Repository) { $arguments += @('--repo', $repo) }
& $node @arguments
exit $LASTEXITCODE
