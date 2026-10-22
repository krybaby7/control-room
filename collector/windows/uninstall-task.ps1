[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath,[Parameter(Mandatory=$true)][string]$SourceId,[switch]$ConfirmUninstall)
$ErrorActionPreference='Stop'
if(-not $ConfirmUninstall){throw 'Explicit -ConfirmUninstall required'}
$sha=[Security.Cryptography.SHA256]::Create();$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ConfigPath+'|'+$SourceId)))).Replace('-','').Substring(0,16)
$name='ControlRoomHistory-'+$hash
if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){Stop-ScheduledTask -TaskName $name;Unregister-ScheduledTask -TaskName $name -Confirm:$false}
Write-Output 'Collection stopped. Protected credentials, spool and retained evidence were preserved.'
