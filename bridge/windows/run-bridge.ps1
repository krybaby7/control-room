# Fixed hidden logon launcher. No service, model or command selector.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$ConfigPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Resolve-BridgeFile([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '["\x00-\x1f\x7f]' -or $Path.Substring(2).Contains(':')) { throw 'Local absolute regular file required.' }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Regular file required.' }
    return $item.FullName
}
try {
    $node = Resolve-BridgeFile $NodePath
    if ([IO.Path]::GetFileName($node) -ine 'node.exe') { throw 'Node executable required.' }
    $version = & $node --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.\d+\.\d+$') { throw 'Node 24 required.' }
    $packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $module = Resolve-BridgeFile (Join-Path $packageRoot 'src\cli.mjs')
    $config = Resolve-BridgeFile $ConfigPath
    if ([IO.Path]::GetExtension($config) -ine '.json') { throw 'JSON config required.' }
    # Every path is a regular file, cannot end in a slash, and contains no quote/CR/LF.
    $arguments = '"' + $module + '" run --config "' + $config + '"'
    $child = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $packageRoot -WindowStyle Hidden -Wait -PassThru
    exit $child.ExitCode
} catch {
    [Console]::Error.WriteLine('Bridge launcher failed. Run doctor locally.')
    exit 1
}
