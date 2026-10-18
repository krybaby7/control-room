import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rm,link,unlink,symlink} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensurePrivateWindowsState} from '../bridge/src/windows-state.mjs';
import {createCredentialStore} from '../bridge/src/credentials.mjs';
import {DEFAULT_CONFIG,canonicalJson} from '../bridge/src/config.mjs';
import {Outbox} from '../bridge/src/outbox.mjs';

// This fixture is restricted to disposable GitHub Windows runners. It never
// starts the bridge, provisions a task, contacts a provider, or opens owner data.
let stage='environment',root=null,junction=null,hardlink=null;
const checks={};
const fixturePs=String.raw`param([Parameter(Mandatory=$true)][string]$Root,[ValidateSet('Prepare','Own','Check','Unsafe','Restore')][string]$Mode)
$ErrorActionPreference='Stop'
try {
  $local=[IO.Path]::GetFullPath([Environment]::GetFolderPath('LocalApplicationData')).TrimEnd('\')
  $full=[IO.Path]::GetFullPath($Root).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($full) -ine $local -or [IO.Path]::GetFileName($full) -notmatch '^ControlRoomSyntheticBridge-[A-Za-z0-9]+$') {throw 'scope'}
  if ((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'scope'}
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $users=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
  function Private([string]$p) {
    $item=Get-Item -LiteralPath $p -Force
    $acl=Get-Acl -LiteralPath $p
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true,$false)
    foreach($r in @($acl.Access)) {[void]$acl.RemoveAccessRuleSpecific($r)}
    $flags=[Security.AccessControl.InheritanceFlags]::None
    if($item.PSIsContainer){$flags=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
    foreach($who in @($sid,$system)){
      $r=New-Object Security.AccessControl.FileSystemAccessRule($who,[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
      [void]$acl.AddAccessRule($r)
    }
    Set-Acl -LiteralPath $p -AclObject $acl
  }
  $config=Join-Path $full 'config.json'
  $state=Join-Path $full '.control-room-bridge'
  if($Mode -eq 'Prepare' -or $Mode -eq 'Restore'){Private $full}
  if($Mode -eq 'Prepare' -or $Mode -eq 'Own' -or $Mode -eq 'Check'){
    $items=@(Get-Item -LiteralPath $config -Force;Get-Item -LiteralPath $state -Force;Get-ChildItem -LiteralPath $state -Force -Recurse)
    if($items.Count -gt 256){throw 'bound'}
    foreach($item in $items){
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse'}
      if($Mode -eq 'Prepare' -or $Mode -eq 'Own'){
        # Only freshly-created synthetic targets: elevated runners may otherwise
        # default to Administrators ownership. Production never takes ownership.
        $acl=Get-Acl -LiteralPath $item.FullName
        $acl.SetOwner($sid);Set-Acl -LiteralPath $item.FullName -AclObject $acl
      }else{
        $acl=Get-Acl -LiteralPath $item.FullName
        if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$acl.AreAccessRulesProtected){throw 'acl'}
        $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        if($rules.Count -ne 2){throw 'acl'}
        foreach($r in $rules){
          if($r.IdentityReference.Value -notin @($sid.Value,$system.Value) -or $r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'acl'}
        }
      }
    }
  }
  if($Mode -eq 'Prepare'){
    $acl=Get-Acl -LiteralPath $config
    [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow)))
    Set-Acl -LiteralPath $config -AclObject $acl
  }
  if($Mode -eq 'Unsafe'){
    $acl=Get-Acl -LiteralPath $full
    [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow)))
    Set-Acl -LiteralPath $full -AclObject $acl
  }
  [Console]::Out.Write('{"ok":true}')
}catch{[Console]::Error.Write('synthetic_fixture_failed');exit 1}
`;
async function fixture(mode){
  const executable=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',join(root,'fixture.ps1'),'-Root',root,'-Mode',mode],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill();},10000);
    child.stdin.on('error',()=>{});child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>4096){failed=true;child.kill();}});
    child.stderr.on('data',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('fixture_process'));});
    child.on('close',code=>{clearTimeout(timer);if(failed||code!==0||output!=='{"ok":true}')reject(new Error('fixture_process'));else resolve();});
    child.stdin.end();
  });
}
try{
  assert.equal(process.platform,'win32');assert.equal(Number(process.versions.node.split('.')[0]),24);
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_OS,'Windows');
  assert.match(process.env.LOCALAPPDATA??'',/^[A-Za-z]:\\/u);
  root=await mkdtemp(join(process.env.LOCALAPPDATA,'ControlRoomSyntheticBridge-'));
  const configPath=join(root,'config.json'),stateDirectory=join(root,'.control-room-bridge');
  await mkdir(stateDirectory);await writeFile(configPath,JSON.stringify(DEFAULT_CONFIG));
  await writeFile(join(root,'fixture.ps1'),fixturePs);
  stage='synthetic-ownership';await fixture('Prepare');
  const protect=()=>ensurePrivateWindowsState({configPath,stateDirectory});
  stage='acl-remediation';const first=await protect();assert.equal(first.status,'protected');await fixture('Check');
  stage='acl-idempotence';const second=await protect();assert.equal(second.entries,first.entries);await fixture('Check');checks.acl='passed';
  stage='dpapi';const credentialPath=join(stateDirectory,'credentials.dpapi');
  const credentials=createCredentialStore({path:credentialPath});
  const synthetic={deviceId:'synthetic-device',credentialId:'synthetic-credential',deviceCredential:'SYNTHETIC-ONLY-'+randomUUID()+'-測試',expiresAt:'2099-01-01T00:00:00.000Z'};
  await credentials.save(synthetic);const ciphertext=await readFile(credentialPath,'utf8');
  assert(!ciphertext.includes(synthetic.deviceCredential));assert.deepEqual(await credentials.load(),synthetic);
  await fixture('Own');await protect();await fixture('Check');
  await credentials.remove();assert.equal(await credentials.load(),null);checks.dpapi='passed';
  stage='sqlite-spool-acl';const outbox=await Outbox.open({directory:join(stateDirectory,'outbox')});
  try{
    const now=new Date().toISOString(),windowId=randomUUID();
    await outbox.enqueue({heartbeatBytes:canonicalJson({schemaVersion:1,deviceId:'synthetic-device',bootId:randomUUID(),generation:1,sequence:1,sentAt:now,bridgeVersion:'0.1.0',observations:[]}),liveWindowId:windowId,windowExpiresAt:new Date(Date.parse(now)+30000).toISOString(),createdAt:now});
    assert.equal((await outbox.status()).records,1);
  }finally{await outbox.close();}
  await fixture('Own');await protect();await fixture('Check');checks.spoolAcl='passed';
  stage='unsafe-parent';await fixture('Unsafe');
  try{await assert.rejects(protect);}finally{await fixture('Restore');}
  await protect();checks.unsafeParent='passed';
  stage='hardlink';hardlink=join(root,'synthetic-hardlink.json');await link(configPath,hardlink);
  try{await assert.rejects(protect);}finally{await unlink(hardlink);hardlink=null;}
  await protect();checks.hardlink='passed';
  stage='junction';const target=join(root,'synthetic-junction-target');await mkdir(target);await writeFile(join(target,'sentinel'),'unchanged');
  junction=join(stateDirectory,'synthetic-junction');
  try{
    await symlink(target,junction,'junction');
    await assert.rejects(protect);assert.equal(await readFile(join(target,'sentinel'),'utf8'),'unchanged');checks.junction='passed';
  }catch(error){
    if(['EPERM','EACCES','ENOTSUP'].includes(error?.code)){checks.junction='unavailable';}else throw error;
  }finally{await unlink(junction).catch(e=>{if(e.code!=='ENOENT')throw e;});junction=null;}
  await protect();await fixture('Check');
  checks.scheduler='not-run';checks.ownerDevice='not-run';
  console.log(JSON.stringify({environment:'github-actions-windows-synthetic',status:checks.junction==='passed'?'passed':'partial',checks}));
}catch{
  console.error(JSON.stringify({environment:'github-actions-windows-synthetic',status:'failed',stage,category:'bounded-fixture-failure'}));process.exitCode=1;
}finally{
  if(root){
    if(junction)await unlink(junction).catch(()=>{});
    if(hardlink)await unlink(hardlink).catch(()=>{});
    await fixture('Restore').catch(()=>{});
    await rm(root,{recursive:true,force:true}).catch(()=>{process.exitCode=1;console.error(JSON.stringify({status:'failed',stage:'synthetic-cleanup',category:'cleanup-failure'}));});
  }
}
