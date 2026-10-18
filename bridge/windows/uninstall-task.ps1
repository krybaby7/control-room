# Stops/removes only the exact current-user packaged task; leaves local data.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($sid -notmatch '^S-\d+(?:-\d+)+$' -or $sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { throw 'Interactive user required.' }
    $taskName = 'ControlRoom.WindowsBridge.' + $sid
    $taskPath = '\ControlRoom\'
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
    if ($null -eq $task) { Write-Output 'No matching current-user bridge task is installed.'; return }
    $packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $launcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-bridge.ps1'))
    $powershell = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'))
    $actions = @($task.Actions)
    $triggers = @($task.Triggers)
    $prefix = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '" -NodePath "'
    $expectedArguments = '^' + [regex]::Escape($prefix) + '[A-Za-z]:\\(?:[^"\x00-\x1f\x7f:]+\\)*node\.exe" -ConfigPath "[A-Za-z]:\\[^"\x00-\x1f\x7f:]+\.json"$'
    if ($task.TaskName -cne $taskName -or $task.TaskPath -cne $taskPath -or $task.Description -cne 'Control Room read-only outbound Windows bridge v1; current user only.' -or $task.Principal.UserId -cne $sid -or $task.Principal.RunLevel -ne 'Limited' -or $task.Principal.LogonType -ne 'Interactive' -or $actions.Count -ne 1 -or $actions[0].Execute -ine $powershell -or $actions[0].WorkingDirectory -ine $packageRoot -or $actions[0].Arguments -notmatch $expectedArguments -or $triggers.Count -ne 1 -or $triggers[0].UserId -cne $sid) { throw 'Task identity differs.' }
    $null = Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath
    $null = Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
    Write-Output 'Exact current-user bridge task removed. Configuration, protected credentials and outbox retained.'
} catch {
    [Console]::Error.WriteLine('Bridge task removal refused or failed. No local data was deleted.')
    exit 1
}
