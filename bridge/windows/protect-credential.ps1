# Fixed credentials.mjs child: redirected anonymous pipes only.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Protect','Unprotect')][string]$Mode)
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

$inputBytes = $null
$outputBytes = $null
$entropy = $null
try {
    if (-not [Console]::IsInputRedirected -or -not [Console]::IsOutputRedirected) { throw 'Private pipes required.' }
    Add-Type -AssemblyName System.Security
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $entropy = $utf8.GetBytes('ControlRoom.WindowsBridge.Credential.v1')
    $stream = [Console]::OpenStandardInput()
    $memory = New-Object System.IO.MemoryStream
    $buffer = New-Object byte[] 4096
    try {
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($memory.Length + $read -gt 65536) { throw 'Input exceeds bound.' }
            $memory.Write($buffer, 0, $read)
        }
        $inputBytes = $memory.ToArray()
    } finally { [Array]::Clear($buffer, 0, $buffer.Length); $memory.Dispose() }
    if ($inputBytes.Length -eq 0) { throw 'Empty input.' }
    if ($Mode -eq 'Protect') {
        if ($inputBytes.Length -gt 16384) { throw 'Plaintext exceeds bound.' }
        $null = $utf8.GetCharCount($inputBytes)
        $ciphertext = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        try { $outputBytes = $utf8.GetBytes([Convert]::ToBase64String($ciphertext)) }
        finally { [Array]::Clear($ciphertext, 0, $ciphertext.Length) }
    } else {
        $ciphertext = [Convert]::FromBase64String($utf8.GetString($inputBytes))
        try { $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($ciphertext, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
        finally { [Array]::Clear($ciphertext, 0, $ciphertext.Length) }
        if ($outputBytes.Length -eq 0 -or $outputBytes.Length -gt 16384) { throw 'Plaintext exceeds bound.' }
        $null = $utf8.GetCharCount($outputBytes)
    }
    $output = [Console]::OpenStandardOutput()
    $output.Write($outputBytes, 0, $outputBytes.Length)
    $output.Flush()
} catch {
    [Console]::Error.WriteLine('Credential protection failed.')
    exit 1
} finally {
    if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
    if ($null -ne $outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
    if ($null -ne $entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
}
