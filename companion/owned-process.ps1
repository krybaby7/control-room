$ErrorActionPreference = 'Stop'
# Compile only this checked-in fixed supervisor. No repository input becomes code.
Add-Type -Path (Join-Path $PSScriptRoot 'OwnedProcess.cs') -CompilerOptions '/nullable:enable'
exit [CompanionOwnedProcess]::Main().GetAwaiter().GetResult()
