param([ValidateSet('protect','unprotect','secure-directory')][string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
if ($inputValue.Length -gt 64000) { throw 'Credential input exceeds bound.' }
if ($Action -eq 'secure-directory') {
 $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl = [Security.AccessControl.DirectorySecurity]::new()
 $acl.SetAccessRuleProtection($true,$false)
 $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
 foreach ($sid in @($identity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow')) }
 # Persist only the DACL. Set-Acl may request SACL privileges on an existing
 # protected installation even when the current user owns its access rules.
 [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($inputValue),$acl)
 exit
}
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$entropy = [Text.Encoding]::UTF8.GetBytes('ControlRoomPersonalConnection-v1')
if ($Action -eq 'protect') {
 $plain = [Text.Encoding]::UTF8.GetBytes($inputValue)
 try { [Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($plain,$entropy,$scope))) }
 finally { [Array]::Clear($plain,0,$plain.Length) }
} else {
 $plain = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputValue),$entropy,$scope)
 try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain)) }
 finally { [Array]::Clear($plain,0,$plain.Length) }
}

