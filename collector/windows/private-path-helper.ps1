$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding($false,$true)
[Console]::InputEncoding=$utf8
[Console]::OutputEncoding=$utf8
try {
 while($true){
  # ReadLine alone would allocate an unbounded request before validation.
  $line=New-Object Text.StringBuilder
  while(($next=[Console]::In.Read()) -ne -1 -and $next -ne 10){
   if($line.Length -ge 32768){throw 'Request too large'}
   [void]$line.Append([char]$next)
  }
  if($next -eq -1){if($line.Length -ne 0){throw 'Truncated request'};break}
  $text=$line.ToString()
  if($utf8.GetByteCount($text) -gt 32768){throw 'Request too large'}
  $request=ConvertFrom-Json -InputObject $text
  if(($request.PSObject.Properties.Name|Sort-Object) -join ',' -ne 'id,path' -or
     ($request.id -isnot [int] -and $request.id -isnot [long]) -or $request.id -lt 1 -or $request.id -gt 9007199254740991 -or
     $request.path -isnot [string] -or $request.path.Length -lt 1 -or $request.path.Length -gt 4096 -or
     $request.path.IndexOf([char]0) -ge 0 -or -not [IO.Path]::IsPathRooted($request.path)){throw 'Invalid request'}
  $ok='true'
  try{& (Join-Path $PSScriptRoot 'check-private-path.ps1') -Path $request.path}
  catch{$ok='false'}
  [Console]::Out.WriteLine('{"id":'+$request.id+',"ok":'+$ok+'}')
  [Console]::Out.Flush()
  if($ok -eq 'false'){exit 1}
 }
}catch{[Console]::Error.WriteLine('Collector private path helper failed');exit 1}
