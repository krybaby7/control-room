# Fixed current-user helper ACL boundary. Only the chosen dedicated helper
# directory and its allowlisted files are protected. Parents are inspected, never changed.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$DirectoryPath,[switch]$Protect)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Windows PowerShell startup may prepend inherited/user module directories.
# Pin again INSIDE the fixed PS5 process before any cmdlet discovery.
$env:PSModulePath = [IO.Path]::Combine($PSHOME,'Modules')
$PSModuleAutoLoadingPreference = 'None'
try {
    foreach ($name in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security')) {
        Import-Module ([IO.Path]::Combine($PSHOME,'Modules',$name,($name+'.psd1'))) -ErrorAction Stop
    }
} catch { [Console]::Error.Write('fixed_windows_modules_unavailable'); exit 1 }

$locks = New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
$targets = New-Object 'System.Collections.Generic.List[object]'
try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($sid.Value -notmatch '^S-\d+(?:-\d+)+$' -or $sid.Value -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { throw 'Interactive current user required.' }
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $adminSid = 'S-1-5-32-544'
    $trustedInstallerSid = (New-Object Security.Principal.NTAccount('NT SERVICE','TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value
    if (-not ('ControlRoomAcl.Native' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace ControlRoomAcl {
 public static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct Info {
   public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint QueryDosDeviceW(string name,System.Text.StringBuilder target,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetKernelObjectSecurity(SafeFileHandle handle,uint requested,byte[] descriptor,uint length,out uint needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(SafeFileHandle handle,uint requested,byte[] descriptor);
  public static bool LocalVolume(string drive) {
   System.Text.StringBuilder target=new System.Text.StringBuilder(32768);
   if(QueryDosDeviceW(drive,target,target.Capacity)==0)throw new Win32Exception(Marshal.GetLastWin32Error());
   // Reject SUBST aliases and redirected/network devices whose real ancestors
   // would otherwise be hidden from the parent-integrity walk.
   return target.ToString().StartsWith("\\Device\\HarddiskVolume",StringComparison.OrdinalIgnoreCase);
  }
  public static SafeFileHandle Open(string path,bool writable) {
   // No delete sharing: the inspected object cannot be swapped while held.
   // Remediation also refuses pre-existing data writers; already-private objects
   // use read-only metadata handles and may coexist with the current user's SQLite.
   SafeFileHandle handle=CreateFileW(path,writable?0x00060080u:0x00020080u,writable?1u:3u,IntPtr.Zero,3u,0x02200000u,IntPtr.Zero);
   if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
   return handle;
  }
  public static Info Inspect(SafeFileHandle handle) {
   Info result;if(!GetFileInformationByHandle(handle,out result))throw new Win32Exception(Marshal.GetLastWin32Error());return result;
  }
  public static byte[] Descriptor(SafeFileHandle handle) {
   uint needed;GetKernelObjectSecurity(handle,5u,null,0u,out needed);
   if(needed==0||needed>65536)throw new InvalidOperationException();
   byte[] descriptor=new byte[needed];
   if(!GetKernelObjectSecurity(handle,5u,descriptor,needed,out needed))throw new Win32Exception(Marshal.GetLastWin32Error());
   return descriptor;
  }
  public static void Protect(SafeFileHandle handle,byte[] descriptor) {
   if(!SetKernelObjectSecurity(handle,0x80000004u,descriptor))throw new Win32Exception(Marshal.GetLastWin32Error());
  }
 }
}
'@
    }
    function Normalize-LocalPath([string]$Path) {
        if ($Path.Length -gt 1024 -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '["\x00-\x1f\x7f]' -or $Path.Substring(2).Contains(':') -or $Path -match '(?:^|[\\/])\.{1,2}(?:[\\/]|$)' -or $Path -match '[. ](?:[\\/]|$)') { throw 'Local absolute path required.' }
        return [IO.Path]::GetFullPath($Path).TrimEnd('\')
    }
    $config = Normalize-LocalPath $DirectoryPath
    $state = $config
    if (-not [ControlRoomAcl.Native]::LocalVolume($config.Substring(0,2))) { throw 'Redirected or network drive refused.' }
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($config))
    if (-not $drive.IsReady -or $drive.DriveType -notin @([IO.DriveType]::Fixed,[IO.DriveType]::Removable) -or $drive.DriveFormat -notin @('NTFS','ReFS')) { throw 'Local ACL-capable physical volume required.' }
    $parent = [IO.Path]::GetDirectoryName($config)
    $driveRoot = [IO.Path]::GetPathRoot($config).TrimEnd('\')
    $windowsRoot = [IO.Path]::GetFullPath([Environment]::GetFolderPath('Windows')).TrimEnd('\')
    function Read-ObjectAcl($Handle,[bool]$Directory) {
        $descriptor = [ControlRoomAcl.Native]::Descriptor($Handle)
        if ($Directory) { $acl = New-Object Security.AccessControl.DirectorySecurity } else { $acl = New-Object Security.AccessControl.FileSecurity }
        $acl.SetSecurityDescriptorBinaryForm($descriptor)
        return $acl
    }
    function Assert-Regular($Handle,[bool]$Directory) {
        $info = [ControlRoomAcl.Native]::Inspect($Handle)
        if (($info.Attributes -band 0x400) -ne 0 -or ((($info.Attributes -band 0x10) -ne 0) -ne $Directory) -or (-not $Directory -and $info.Links -ne 1)) { throw 'Regular non-linked object required.' }
    }
    function Assert-Owner($Acl) {
        if ($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Current user ownership required.' }
    }
    function Test-PrivateAcl($Acl,[bool]$Directory) {
        if (-not $Acl.AreAccessRulesProtected) { return $false }
        $rules = @($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 2) { return $false }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($rule in $rules) {
            if ($rule.IdentityReference.Value -notin @($sid.Value,$systemSid.Value) -or $rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { return $false }
            $expected = if ($Directory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
            if ($rule.InheritanceFlags -ne $expected -or -not $seen.Add($rule.IdentityReference.Value)) { return $false }
        }
        return $true
    }
    function Protect-Target([string]$Path,[bool]$Directory) {
        $handle = [ControlRoomAcl.Native]::Open($Path,$false)
        try {
            Assert-Regular $handle $Directory
            $acl = Read-ObjectAcl $handle $Directory
            Assert-Owner $acl
            if (-not (Test-PrivateAcl $acl $Directory)) {
                if (-not $Protect) { throw 'Explicit helper protection required.' }
                $handle.Dispose()
                $handle = [ControlRoomAcl.Native]::Open($Path,$true)
                Assert-Regular $handle $Directory
                Assert-Owner (Read-ObjectAcl $handle $Directory)
                if ($Directory) { $replacement = New-Object Security.AccessControl.DirectorySecurity } else { $replacement = New-Object Security.AccessControl.FileSecurity }
                $replacement.SetOwner($sid)
                $replacement.SetAccessRuleProtection($true,$false)
                $inheritance = if ($Directory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
                foreach ($identity in @($sid,$systemSid)) {
                    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
                    $replacement.AddAccessRule($rule)
                }
                # SetKernelObjectSecurity targets only this held object; it does not
                # recursively propagate a named-directory ACL to unchecked children.
                [ControlRoomAcl.Native]::Protect($handle,$replacement.GetSecurityDescriptorBinaryForm())
            }
            Assert-Regular $handle $Directory
            $checked = Read-ObjectAcl $handle $Directory
            Assert-Owner $checked
            if (-not (Test-PrivateAcl $checked $Directory)) { throw 'Private ACL verification failed.' }
            $locks.Add($handle)
            return [pscustomobject]@{Path=$Path;Directory=$Directory;Handle=$handle}
        } catch { $handle.Dispose(); throw }
    }
    function Assert-SafeParent([string]$Path,$Handle,[bool]$Immediate) {
        Assert-Regular $Handle $true
        $acl = Read-ObjectAcl $Handle $true
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        $osAncestor = [String]::Equals($Path.TrimEnd('\'),$driveRoot,[StringComparison]::OrdinalIgnoreCase) -or [String]::Equals($Path.TrimEnd('\'),$windowsRoot,[StringComparison]::OrdinalIgnoreCase) -or $windowsRoot.StartsWith($Path.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)
        if ($owner -notin @($sid.Value,$systemSid.Value,$adminSid) -and -not (-not $Immediate -and $osAncestor -and $owner -eq $trustedInstallerSid)) { throw 'Unsafe parent ownership.' }
        # Ancestors may permit creation of unrelated siblings. They must never
        # permit another ordinary principal to replace existing path components.
        $mask = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
        if ($Immediate) { $mask = $mask -bor [Security.AccessControl.FileSystemRights]::Write }
        foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
            if ($rule.IdentityReference.Value -in @($sid.Value,$systemSid.Value,$adminSid)) { continue }
            if (-not $Immediate -and $osAncestor -and $rule.IdentityReference.Value -eq $trustedInstallerSid) { continue }
            # Conservative: an ordinary allow is rejected even if another deny
            # might override it. No parent permission is edited to make it pass.
            if (($rule.FileSystemRights -band $mask) -ne 0) { throw 'Unsafe parent write or swap permission.' }
        }
    }
    $ancestors = New-Object 'System.Collections.Generic.List[string]'
    $cursor = $parent
    while ($cursor) {
        if ($ancestors.Count -ge 64) { throw 'Parent depth exceeds bound.' }
        $ancestors.Insert(0,$cursor)
        $next = [IO.Directory]::GetParent($cursor)
        if ($null -eq $next) { break }
        $cursor = $next.FullName
    }
    $parents = New-Object 'System.Collections.Generic.List[object]'
    foreach ($path in $ancestors) {
        $handle = [ControlRoomAcl.Native]::Open($path,$false)
        $locks.Add($handle)
        $immediate = [String]::Equals($path.TrimEnd('\'),$parent.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)
        Assert-SafeParent $path $handle $immediate
        $parents.Add([pscustomobject]@{Path=$path;Handle=$handle;Immediate=$immediate})
    }
    # Never create a helper directory or modify parents during registration.
    if (-not [IO.Directory]::Exists($state)) { throw 'Existing helper directory required.' }
    $entries = @(Get-ChildItem -LiteralPath $state -Force)
    $executables = @($entries | Where-Object { -not $_.PSIsContainer -and $_.Extension -ieq '.exe' })
    if ($executables.Count -ne 1 -or $entries.Count -gt 2) { throw 'Single-file helper inventory required.' }
    $expectedPdb = [IO.Path]::GetFileNameWithoutExtension($executables[0].Name)+'.pdb'
    foreach ($entry in $entries) { if ($entry.PSIsContainer -or ($entry.Name -ne $executables[0].Name -and $entry.Name -ne $expectedPdb)) { throw 'Unexpected helper sidecar.' } }
    $targets.Add((Protect-Target $state $true))
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($state)
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        Get-ChildItem -LiteralPath $directory -Force | ForEach-Object {
            if ($targets.Count -ge 256) { throw 'State tree exceeds bound.' }
            $item = $_
            $full = [IO.Path]::GetFullPath($item.FullName)
            if (-not $full.StartsWith($state+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'State path escaped scope.' }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused.' }
            $target = Protect-Target $full ([bool]$item.PSIsContainer)
            $targets.Add($target)
            if ($item.PSIsContainer) { $queue.Enqueue($full) }
        }
    }
    foreach ($target in $targets) {
        Assert-Regular $target.Handle $target.Directory
        $acl = Read-ObjectAcl $target.Handle $target.Directory
        Assert-Owner $acl
        if (-not (Test-PrivateAcl $acl $target.Directory)) { throw 'Private ACL changed.' }
    }
    foreach ($p in $parents) { Assert-SafeParent $p.Path $p.Handle $p.Immediate }
    [Console]::Out.WriteLine(('{"protected":true,"entries":'+$targets.Count+'}'))
} catch {
    [Console]::Error.WriteLine('Native helper protection failed. Choose a current-user private folder and inspect local permissions.')
    exit 1
} finally {
    foreach ($handle in $locks) { $handle.Dispose() }
}
