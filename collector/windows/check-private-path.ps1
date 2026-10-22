[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$item=Get-Item -LiteralPath $Path -Force
if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Private state cannot be a reparse point'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$acl=Get-Acl -LiteralPath $Path
if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value){throw 'Private state must belong to the current user'}
foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value){throw 'Private state grants access to another identity'}}
