[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath,[Parameter(Mandatory=$true)][string]$PackageDirectory,[Parameter(Mandatory=$true)][string]$ExpectedManifestSha256,[Parameter(Mandatory=$true)][string]$SourceId,[Parameter(Mandatory=$true)][string]$NodePath,[switch]$ConfirmInstall)
$ErrorActionPreference='Stop'
if(-not $ConfirmInstall){throw 'Explicit -ConfirmInstall is required; no automatic installation'}
foreach($path in @($ConfigPath,$PackageDirectory,$NodePath)){if(-not [IO.Path]::IsPathRooted($path) -or $path -match '["\r\n]'){throw 'Explicit absolute paths without quotes/newlines are required'}}
$manifestPath=Join-Path $PackageDirectory 'package-manifest.json'
if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedManifestSha256.ToLowerInvariant()){throw 'Package manifest digest differs'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
if($manifest.version -ne '0.1.0' -or -not $manifest.files){throw 'Unsupported collector package version'}
$root=[IO.Path]::GetFullPath($PackageDirectory).TrimEnd('\')+'\';$listed=@{}
foreach($entry in $manifest.files){if([IO.Path]::IsPathRooted($entry.path) -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)'){throw 'Unsafe package entry'};$path=[IO.Path]::GetFullPath((Join-Path $root $entry.path));if(-not $path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $path).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Unsafe package file'};if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Package file digest differs'};$listed[$path]=$true}
Get-ChildItem -LiteralPath $root -Recurse -File|Where-Object {$_.Extension -in '.mjs','.json','.ps1' -and $_.FullName -ne $manifestPath}|ForEach-Object {if(-not $listed.ContainsKey($_.FullName)){throw 'Unlisted executable/package file'}}
$config=Get-Content -LiteralPath $ConfigPath -Raw|ConvertFrom-Json
if(@($config.sources).Count -ne 1 -or $config.codecVersion -ne 1 -or ($config.scopes -join ',') -ne 'history.read,history.ingest' -or -not ($config.sources|Where-Object {$_.sourceId -eq $SourceId})){throw 'Explicit matching history source/enrollment configuration required'}
$sha=[Security.Cryptography.SHA256]::Create();$sourceHash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($SourceId)))).Replace('-','').ToLowerInvariant()
$expectedState=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('ControlRoomHistory\'+$sourceHash)
if([IO.Path]::GetFullPath($config.stateDirectory) -ne [IO.Path]::GetFullPath($expectedState) -or -not [IO.Path]::GetFullPath($ConfigPath).StartsWith([IO.Path]::GetFullPath($expectedState)+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Windows config/state must use the dedicated current-user source directory'}
[IO.Directory]::CreateDirectory($expectedState)|Out-Null
$ownerIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$directoryAcl=New-Object Security.AccessControl.DirectorySecurity
$directoryAcl.SetOwner($ownerIdentity.User);$directoryAcl.SetAccessRuleProtection($true,$false)
$directoryAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($ownerIdentity.User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $expectedState -AclObject $directoryAcl
$credential=Join-Path $config.stateDirectory ('credentials\'+$sourceHash+'.dpapi')
if(-not (Test-Path -LiteralPath $credential)){throw 'Protected enrolled credential missing'}
$enrolled=(& (Join-Path $root 'windows\protect-credential.ps1') -CredentialFile $credential -Read)|ConvertFrom-Json
$selected=$config.sources|Where-Object {$_.sourceId -eq $SourceId}
if($enrolled.sourceId -ne $SourceId -or $enrolled.epoch -ne $selected.epoch -or $enrolled.scopeRevision -ne $selected.scopeRevision -or [DateTimeOffset]::Parse($enrolled.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'Enrollment is expired or scope differs'}
if((& $NodePath --version) -notmatch '^v(2[4-9]|[3-9][0-9])\.'){throw 'Node 24 or later required'}
$taskHash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ConfigPath+'|'+$SourceId)))).Replace('-','').Substring(0,16)
$taskName='ControlRoomHistory-'+$taskHash
$action=New-ScheduledTaskAction -Execute $NodePath -Argument ('"'+(Join-Path $root 'src\cli.mjs')+'" run --config "'+$ConfigPath+'"') -WorkingDirectory $root
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ('Control Room history collector 0.1.0; '+$ExpectedManifestSha256) -Force|Out-Null
Write-Output 'Installed for the current logged-in user; unattended receipt verification remains pending.'
