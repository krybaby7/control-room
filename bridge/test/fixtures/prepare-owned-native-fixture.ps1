# Synthetic CI staging ownership only. Product registration/run remain verify-only.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$DirectoryPath,[Parameter(Mandatory=$true)][string]$ExecutableSha256)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
$PSModuleAutoLoadingPreference='None'
foreach($name in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security')) { Import-Module ([IO.Path]::Combine($PSHOME,'Modules',$name,($name+'.psd1'))) -ErrorAction Stop }
$handles=New-Object 'System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
try {
 Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SyntheticOwner {
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,System.Text.StringBuilder path,uint length,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetKernelObjectSecurity(SafeFileHandle handle,uint requested,byte[] descriptor,uint length,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(SafeFileHandle handle,uint requested,byte[] descriptor);
 public static SafeFileHandle Open(string path,bool ownerWrite){var h=CreateFileW(path,ownerWrite?0x000A0080u:0x00020080u,1u,IntPtr.Zero,3u,0x02200000u,IntPtr.Zero);if(h.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());return h;}
 public static Info Inspect(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new Win32Exception(Marshal.GetLastWin32Error());return i;}
 public static string Path(SafeFileHandle h){var b=new System.Text.StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity)throw new Win32Exception();return b.ToString();}
 public static byte[] Descriptor(SafeFileHandle h){uint n;GetKernelObjectSecurity(h,1,null,0,out n);if(n==0||n>65536)throw new InvalidOperationException();var b=new byte[n];if(!GetKernelObjectSecurity(h,1,b,n,out n))throw new Win32Exception(Marshal.GetLastWin32Error());return b;}
 public static void Owner(SafeFileHandle h,byte[] b){if(!SetKernelObjectSecurity(h,1,b))throw new Win32Exception(Marshal.GetLastWin32Error());}
}
'@
 if($DirectoryPath  -notmatch  '^[A-Za-z]:\\'  -or  $DirectoryPath  -match  '[\x00-\x1f"*?<>|]'  -or  $ExecutableSha256  -notmatch  '^[a-f0-9]{64}$') {throw 'invalid_fixture'}
 $directory=[IO.Path]::GetFullPath($DirectoryPath).TrimEnd('\')
 if([IO.Path]::GetFileName($directory)  -notmatch  '^owned-native-build-[A-Za-z0-9]{6}$') {throw 'invalid_fixture'}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $admin='S-1-5-32-544'
 $tempHandle=[SyntheticOwner]::Open([IO.Path]::GetTempPath().TrimEnd('\'),$false);$handles.Add($tempHandle)
 $temp=[SyntheticOwner]::Path($tempHandle)
 if($temp.StartsWith('\\?\')){$temp=$temp.Substring(4)}
 if( -not  [String]::Equals([IO.Path]::GetDirectoryName($directory),$temp.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){throw 'invalid_fixture_parent'}
 $entries=@(Get-ChildItem -LiteralPath $directory -Force)
 if($entries.Count  -lt  1  -or  $entries.Count  -gt  2){throw 'invalid_fixture_inventory'}
 foreach($entry in $entries){if($entry.PSIsContainer  -or  $entry.Name  -notin  @('OwnedProcess.exe','OwnedProcess.pdb')){throw 'invalid_fixture_inventory'}}
 $digest=(Get-FileHash -LiteralPath (Join-Path $directory 'OwnedProcess.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
 if($digest  -ne  $ExecutableSha256){throw 'invalid_fixture_digest'}
 # Hold every ancestor without delete sharing before inspecting the target objects.
 $cursor=[IO.Path]::GetDirectoryName($directory)
 while($cursor){$h=[SyntheticOwner]::Open($cursor,$false);$handles.Add($h);$i=[SyntheticOwner]::Inspect($h);if(($i.Attributes -band  0x400) -ne  0  -or  ($i.Attributes -band  0x10) -eq  0){throw 'invalid_fixture_parent'};$next=[IO.Directory]::GetParent($cursor);if($null -eq  $next){break};$cursor=$next.FullName}
 $targets=@($directory)+@($entries|ForEach-Object{$_.FullName})
 $wasCurrent=$true;$wasAdmin=$false
 foreach($path in $targets){
  $h=[SyntheticOwner]::Open($path,$true);$handles.Add($h);$i=[SyntheticOwner]::Inspect($h);$isDirectory=[String]::Equals($path,$directory,[StringComparison]::OrdinalIgnoreCase)
  if(($i.Attributes -band  0x400) -ne  0  -or  ((($i.Attributes -band  0x10) -ne  0) -ne  $isDirectory)  -or  ( -not  $isDirectory  -and  $i.Links -ne  1)){throw 'invalid_fixture_object'}
  $created=[DateTime]::FromFileTimeUtc(([Int64]$i.CreationHigh  -shl  32) -bor  [Int64]$i.CreationLow)
  if($created  -gt  [DateTime]::UtcNow  -or  ([DateTime]::UtcNow-$created).TotalMinutes -gt  10){throw 'stale_fixture'}
  $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorBinaryForm([SyntheticOwner]::Descriptor($h));$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner -ne  $sid.Value){$wasCurrent=$false;if($owner -ne  $admin){throw 'foreign_fixture_owner'};$wasAdmin=$true;$replacement=New-Object Security.AccessControl.DirectorySecurity;$replacement.SetOwner($sid);[SyntheticOwner]::Owner($h,$replacement.GetSecurityDescriptorBinaryForm())}
  $checked=New-Object Security.AccessControl.DirectorySecurity;$checked.SetSecurityDescriptorBinaryForm([SyntheticOwner]::Descriptor($h));if($checked.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne  $sid.Value){throw 'fixture_owner_unconfirmed'}
 }
 [Console]::Out.WriteLine(('{"ownerWasCurrent":'+$wasCurrent.ToString().ToLowerInvariant()+',"ownerWasAdmin":'+$wasAdmin.ToString().ToLowerInvariant()+'}'))
}catch{[Console]::Error.WriteLine('synthetic_fixture_owner_unavailable');exit 1}finally{foreach($h in $handles){$h.Dispose()}}
