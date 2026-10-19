import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=name=>readFile(new URL('../windows/'+name,import.meta.url),'utf8');
test('DPAPI boundary requires redirected private pipes, fixed modes, CurrentUser and bounded plaintext; no file or plaintext logging',async()=>{
 const text=await read('protect-credential.ps1');
 assert.match(text,/ValidateSet\('Protect','Unprotect'\)/);
 assert.match(text,/\[Console\]::IsInputRedirected/);assert.match(text,/\[Console\]::IsOutputRedirected/);
 assert.match(text,/OpenStandardInput\(\)/);assert.match(text,/OpenStandardOutput\(\)/);
 assert.match(text,/DataProtectionScope\]::CurrentUser/);assert.doesNotMatch(text,/LocalMachine/);
 assert.match(text,/ControlRoom\.WindowsBridge\.Credential\.v1/);
 assert.match(text,/65536/);assert.match(text,/16384/);assert.match(text,/\[Array\]::Clear/);
 assert.doesNotMatch(text,/\b(?:Set-Content|Add-Content|Out-File|Write-Host|Write-Output|Start-Transcript|Invoke-Expression)\b/i);
 assert.doesNotMatch(text,/WriteLine\([^']|\$_/);
});
test('logon task is fixed current user, limited, hidden and not launched by installation',async()=>{
 const text=await read('install-task.ps1');
 assert.match(text,/WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
 assert.match(text,/'ControlRoom\.WindowsBridge\.' \+ \$sid/);
 assert.match(text,/New-ScheduledTaskTrigger -AtLogOn -User \$sid/);
 assert.match(text,/-UserId \$sid -LogonType Interactive -RunLevel Limited/);
 assert.match(text,/-Hidden -MultipleInstances IgnoreNew/);
 assert.match(text,/GetFolderPath\('System'\)/);assert.match(text,/WindowsPowerShell\\v1\.0\\powershell\.exe/);
 assert.match(text,/run-bridge\.ps1/);assert.match(text,/-WindowStyle Hidden -File/);
 assert.match(text,/Task already exists/);assert.match(text,/ReparsePoint/);
 assert.doesNotMatch(text,/Start-ScheduledTask|Start-Process|RunLevel Highest|LogonType Password|-Password|ExecutionPolicy|Register-ScheduledTask[^\n]*-Force/i);
});
test('fixed hidden launcher validates Node 24 and regular absolute files and has no command or shell selector',async()=>{
 const text=await read('run-bridge.ps1');
 assert.match(text,/Get-Item -LiteralPath/);assert.match(text,/Substring\(2\)\.Contains\(':'\)/);
 assert.match(text,/ReparsePoint/);assert.match(text,/node\.exe/);assert.match(text,/\^v24/);
 assert.match(text,/src\\cli\.mjs/);assert.match(text,/" run --config "/);
 assert.match(text,/Start-Process -FilePath \$node -ArgumentList \$arguments/);
 assert.match(text,/-WindowStyle Hidden -Wait -PassThru/);
 assert.doesNotMatch(text,/\$args\b|Invoke-Expression|cmd\.exe|EncodedCommand|ExecutionPolicy|Start-Service|Restart-Service|Stop-Process|ollama|trade/i);
});
test('uninstall verifies exact action/user/path/trigger before touching only its task and leaves data',async()=>{
 const text=await read('uninstall-task.ps1'),guard=text.indexOf('Task identity differs.'),stop=text.indexOf('Stop-ScheduledTask'),remove=text.indexOf('Unregister-ScheduledTask');
 assert.ok(guard>=0&&stop>guard&&remove>stop);
 for(const name of ['TaskName','TaskPath','Description','Principal.UserId','Principal.RunLevel','Principal.LogonType','WorkingDirectory','Arguments','UserId'])assert.ok(text.includes(name));
 assert.match(text,/\$actions\.Count -ne 1/);assert.match(text,/\$triggers\.Count -ne 1/);
 assert.match(text,/Execute -ine \$powershell/);assert.match(text,/run-bridge\.ps1/);
 assert.match(text,/Unregister-ScheduledTask -TaskName \$taskName -TaskPath \$taskPath -Confirm:\$false/);
 assert.doesNotMatch(text,/Remove-Item|DeleteFile|DeleteDirectory|Stop-Process|Get-Process|\$args\b|-Force/i);
});
test('documentation keeps Windows/device/ingress evidence explicitly unverified',async()=>{
 const base=new URL('../../docs/',import.meta.url);
 const [windows,ingress,acceptance]=await Promise.all(['integrations/windows-bridge.md','integrations/private-service-ingress.md','verification/windows-bridge-acceptance.md'].map(path=>readFile(new URL(path,base),'utf8')));
 assert.match(windows,/NOT RUN/);assert.match(windows,/Node 24/);assert.match(windows,/CurrentUser/);
 assert.match(ingress,/unsupported by default/);assert.match(ingress,/renewal.*unverified/i);
 assert.match(acceptance,/Windows acceptance NOT RUN/);assert.match(acceptance,/not.*live hardware proof/i);
});

test('installer and launcher invoke the fixed scoped ACL helper before task registration or Node launch',async()=>{
 for(const [name,later]of [['install-task.ps1','Register-ScheduledTask'],['run-bridge.ps1','Start-Process']]){
  const text=await read(name),helper=text.indexOf("$null = & $aclHelper -ConfigPath $config -StateDirectory $stateDirectory");
  assert.ok(helper>0&&text.indexOf(later)>helper);
  assert.match(text,/Join-Path \$PSScriptRoot 'protect-state\.ps1'/);
  assert.match(text,/GetDirectoryName\(\$config\)\) '\.control-room-bridge'/);
  assert.match(text,/\$LASTEXITCODE -ne 0/);
  assert.doesNotMatch(text,/Set-Acl|icacls|Remove-Item/i);
 }
});
