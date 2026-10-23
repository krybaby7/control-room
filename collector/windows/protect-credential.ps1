[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$CredentialFile,[switch]$Read)
$ErrorActionPreference='Stop'
if(-not [IO.Path]::IsPathRooted($CredentialFile)){throw 'Absolute private credential path required'}
Add-Type -AssemblyName System.Security
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($Read){
 $acl=Get-Acl -LiteralPath $CredentialFile
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value -or -not $acl.AreAccessRulesProtected){throw 'Credential ACL is not protected for the current user'}
 foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value){throw 'Credential ACL grants another identity'}}
 $cipher=[Convert]::FromBase64String([IO.File]::ReadAllText($CredentialFile))
 $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain));[Array]::Clear($plain,0,$plain.Length)
}else{
 # Enrollment JSON enters stdin, never a command argument or transcript/log.
 $text=[Console]::In.ReadToEnd();if($text.Length -gt 16384){throw 'Credential input exceeds bound'}
 $value=$text|ConvertFrom-Json
 if($value.version -ne 1 -or $value.token -notmatch '^crh_[a-f0-9]{64}$' -or -not $value.sourceId -or -not $value.epoch -or $value.scopeRevision -lt 1){throw 'Invalid history enrollment'}
 $plain=[Text.Encoding]::UTF8.GetBytes($text)
 $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $parent=[IO.Path]::GetDirectoryName($CredentialFile);[IO.Directory]::CreateDirectory($parent)|Out-Null
 $acl=New-Object Security.AccessControl.FileSecurity
 $acl.SetOwner($identity.User);$acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity.User,'FullControl','Allow')))
 [IO.File]::WriteAllText($CredentialFile,[Convert]::ToBase64String($cipher));Set-Acl -LiteralPath $CredentialFile -AclObject $acl
 [Array]::Clear($plain,0,$plain.Length)
}
