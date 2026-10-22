param([string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'ControlRoomCompanion'),[string]$OpenUri)
$ErrorActionPreference = 'Stop'
# Protocol arguments never become commands or file paths. Only the fixed open action is admitted.
if ($OpenUri -and $OpenUri -notmatch '^controlroom://open(?:[/?#].*)?$') { throw 'Unsupported Control Room action.' }
$launcher = Join-Path $InstallDirectory 'Start-ControlRoomCompanion.ps1'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Install the complete reviewed companion package first.' }
$pwsh = @((Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),(Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe')) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (!$pwsh) { throw 'An existing PowerShell 7 runtime is required.' }
if ($OpenUri) { Start-Process -FilePath $pwsh -ArgumentList @('-NoLogo','-NoProfile','-File',('"'+$launcher+'"'),'-OpenDashboard') -WindowStyle Hidden; exit }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
foreach ($sid in @($identity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,$propagation,'Allow')) }
[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($InstallDirectory),$acl)
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Control Room Companion.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($startup)
$shortcut.TargetPath = $pwsh
$shortcut.Arguments = '-NoLogo -NoProfile -File "'+$launcher+'"'
$shortcut.WorkingDirectory = $InstallDirectory
$shortcut.WindowStyle = 7
$shortcut.Save()
# The protocol points to this copied fixed handler, never a disposable release path.
$openHandler = Join-Path $InstallDirectory 'Open-ControlRoom.ps1'
$handler = @'
param([string]$OpenUri)
$ErrorActionPreference = 'Stop'
if ($OpenUri -notmatch '^controlroom://open(?:[/?#].*)?$') { throw 'Unsupported Control Room action.' }
$pwsh = @((Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),(Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe')) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (!$pwsh) { throw 'PowerShell 7 is required.' }
$launcher = Join-Path $PSScriptRoot 'Start-ControlRoomCompanion.ps1'
Start-Process -FilePath $pwsh -ArgumentList @('-NoLogo','-NoProfile','-File',('"'+$launcher+'"'),'-OpenDashboard') -WindowStyle Hidden
'@
Set-Content -LiteralPath $openHandler -Value $handler -Encoding UTF8
$protocol = 'HKCU:\Software\Classes\controlroom'
New-Item -Path $protocol -Force | Out-Null
Set-Item -LiteralPath $protocol -Value 'URL:Control Room personal companion'
New-ItemProperty -LiteralPath $protocol -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path ($protocol+'\shell\open\command') -Force | Out-Null
# The copied handler validates only a fixed URI action and ignores its query.
Set-Item -LiteralPath ($protocol+'\shell\open\command') -Value ('"'+$pwsh+'" -NoLogo -NoProfile -File "'+$openHandler+'" -OpenUri "%1"')
