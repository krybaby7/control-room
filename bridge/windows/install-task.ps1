# Explicit current-user install; never starts the task during installation.
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
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($sid -notmatch '^S-\d+(?:-\d+)+$' -or $sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { throw 'Interactive user required.' }
    $taskName = 'ControlRoom.WindowsBridge.' + $sid
    $taskPath = '\ControlRoom\'
    $node = Resolve-BridgeFile $NodePath
    if ([IO.Path]::GetFileName($node) -ine 'node.exe') { throw 'Node executable required.' }
    $version = & $node --version 2>$null
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.\d+\.\d+$') { throw 'Node 24 required.' }
    $packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $null = Resolve-BridgeFile (Join-Path $packageRoot 'src\cli.mjs')
    $launcher = Resolve-BridgeFile (Join-Path $PSScriptRoot 'run-bridge.ps1')
    $powershell = Resolve-BridgeFile (Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe')
    $config = Resolve-BridgeFile $ConfigPath
    if ([IO.Path]::GetExtension($config) -ine '.json') { throw 'JSON config required.' }
    if (Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue) { throw 'Task already exists. Inspect and uninstall explicitly before reinstalling.' }
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '" -NodePath "' + $node + '" -ConfigPath "' + $config + '"'
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $packageRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
    $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Control Room read-only outbound Windows bridge v1; current user only.'
    $null = Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -InputObject $task
    Write-Output 'Current-user bridge task installed for the next logon. No service or model was started.'
} catch {
    [Console]::Error.WriteLine('Bridge task installation failed. Inspect the local package and task identity.')
    exit 1
}
