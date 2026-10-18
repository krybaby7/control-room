import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {ensurePrivateWindowsState} from '../src/windows-state.mjs';
const paths={configPath:'C:\\Synthetic Private\\config.json',stateDirectory:'C:\\Synthetic Private\\.control-room-bridge'};
/** Fake child status only; these tests do not claim Windows ACL execution. */
function childSpawner(calls,{output='{"protected":true,"entries":2}',code=0,hang=false}={}){
 return (executable,args,options)=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.kill=()=>{child.killed=true;};
  calls.push({executable,args,options,child});let stdinBytes=0;child.stdin.on('data',part=>{stdinBytes+=part.length;});
  child.stdin.on('end',()=>{calls.at(-1).stdinBytes=stdinBytes;if(!hang)setImmediate(()=>{child.stderr.write('Synthetic local path/private diagnostic must not escape');child.stdout.write(output);child.emit('close',code);});});
  return child;
 };
}
test('Linux fixture explicitly does no Windows ACL work or private-state provisioning',async()=>{
 let called=false;assert.deepEqual(await ensurePrivateWindowsState({configPath:'/synthetic/config.json',stateDirectory:'/synthetic/.control-room-bridge'},{platform:'linux',spawnImpl:()=>{called=true;}}),{status:'not-applicable',reason:'windows-only'});assert.equal(called,false);
});
test('fixed hidden System32 PowerShell receives only chosen config and exact dedicated sibling state',async()=>{
 const calls=[],result=await ensurePrivateWindowsState(paths,{platform:'win32',spawnImpl:childSpawner(calls)});
 assert.deepEqual(result,{status:'protected',entries:2});assert.equal(calls.length,1);
 const call=calls[0];assert.match(call.executable,/^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
 assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.deepEqual(call.options.stdio,['pipe','pipe','pipe']);
 assert.ok(call.args.some(value=>value.endsWith('protect-state.ps1')));assert.deepEqual(call.args.slice(-4),['-ConfigPath',paths.configPath,'-StateDirectory',paths.stateDirectory]);assert.equal(call.stdinBytes,0);
 assert.equal(call.args.includes('-Command'),false);assert.equal(call.args.includes('-EncodedCommand'),false);
});
test('relative UNC ADS control traversal overlap and unrelated target paths stop before a process',async()=>{
 for(const value of [
  {...paths,configPath:'relative.json'},
  {...paths,configPath:'\\\\server\\share\\config.json'},
  {...paths,configPath:'C:\\Synthetic Private\\config.json:stream'},
  {...paths,configPath:'C:\\Synthetic Private\\..\\config.json'},
  {...paths,configPath:'C:\\Synthetic\nPrivate\\config.json'},
  {...paths,stateDirectory:paths.configPath},
  {...paths,stateDirectory:'C:\\Synthetic Private\\unrelated'},
  {...paths,stateDirectory:'C:\\Other\\.control-room-bridge'}
 ]){
  let called=false;await assert.rejects(ensurePrivateWindowsState(value,{platform:'win32',spawnImpl:()=>{called=true;}}),/invalid_private_state_path/);assert.equal(called,false);
 }
});
test('nonzero process, malformed/oversized status and unsafe status counts never claim protection',async()=>{
 for(const options of [{code:1},{output:'private diagnostic'},{output:'x'.repeat(4097)},{output:'{"protected":false,"entries":2}'},{output:'{"protected":true,"entries":257}'},{output:'{"protected":true,"entries":2,"sid":"private"}'}])await assert.rejects(ensurePrivateWindowsState(paths,{platform:'win32',spawnImpl:childSpawner([],options)}),error=>error.message==='private_state_unavailable');
});
test('deadline terminates a stalled fixed child and ignores a late success',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const calls=[];
 try{const work=ensurePrivateWindowsState(paths,{platform:'win32',spawnImpl:childSpawner(calls,{hang:true}),timeoutMs:25});context.mock.timers.tick(25);await assert.rejects(work,/private_state_unavailable/);assert.equal(calls[0].child.killed,true);calls[0].child.stdout.write('{"protected":true,"entries":2}');calls[0].child.emit('close',0);}
 finally{context.mock.timers.reset();}
});
test('fixed script protects only explicitly owned config/state objects and never changes parent ACLs',async()=>{
 const text=await readFile(new URL('../windows/protect-state.ps1',import.meta.url),'utf8');
 for(const fragment of ['WindowsIdentity]::GetCurrent().User','S-1-5-18','S-1-5-32-544','TrustedInstaller','SetAccessRuleProtection($true,$false)','Assert-Owner','Test-PrivateAcl','Assert-SafeParent','InheritOnly','Unsafe parent write or swap permission','State tree exceeds bound.','Current user ownership required.','0x80000004u','0x02200000u','info.Links -ne 1','Private ACL changed.'])assert.ok(text.includes(fragment),fragment);
 assert.match(text,/\$targets\.Count -ge 256/);assert.match(text,/\$ancestors\.Count -ge 64/);
 assert.match(text,/Protect-Target \$config \$false/);assert.match(text,/Protect-Target \$state \$true/);
 assert.doesNotMatch(text,/Set-Acl|SetNamedSecurityInfo|SetFileSecurity|Remove-Item|Copy-Item|Move-Item|Invoke-Expression|EncodedCommand|Start-Process|icacls\b/i);
 assert.match(text,/\$locks\).*Dispose|\$handle\.Dispose\(\)/);
});
