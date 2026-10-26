import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWindowsPrivateChecker,withWindowsPrivateChecks,checkWindowsPrivatePath} from '../src/windows-private-path.mjs';

const exec=promisify(execFile),path=join(tmpdir(),'synthetic-private-check');
const replies=body=>`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);${body}});`;
function syntheticChecker(script,options={}){
 const children=[];
 const checker=createWindowsPrivateChecker({...options,spawnHelper:()=>{const child=spawn(process.execPath,['-e',script],{stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(child);return child;}});
 return {checker,children};
}
function reaped(children){for(const child of children)assert.ok(child.exitCode!==null||child.signalCode!==null,'owned child must be reaped');}

test('serialized checks reuse one owned process and close awaits its exit',async()=>{
 const {checker,children}=syntheticChecker(replies("process.stdout.write(JSON.stringify({id:request.id,ok:true})+'\\n');"));
 try{await Promise.all([checker.check(path),checker.check(path+'-two'),checker.check(path)]);assert.equal(children.length,1);}finally{await checker.close();}
 reaped(children);await assert.rejects(checker.check(path),/helper/);
});
test('a nonzero exit during shutdown cannot turn a matching reply into success',async()=>{
 const script=replies("process.stdout.write(JSON.stringify({id:request.id,ok:true})+'\\n');")+"process.stdin.on('end',()=>process.exit(23));";
 const {checker,children}=syntheticChecker(script);
 await checker.check(path);await assert.rejects(checker.close(),/helper/);reaped(children);
});
for(const stream of ['stdout','stderr'])test('delayed extra '+stream+' during close invalidates the completed operation',async()=>{
 const script=replies("process.stdout.write(JSON.stringify({id:request.id,ok:true})+'\\n');")+`process.stdin.on('end',()=>setTimeout(()=>{process.${stream}.write('unexpected\\n');process.exit(0);},20));`;
 const {checker,children}=syntheticChecker(script);
 await checker.check(path);await assert.rejects(checker.close(),/helper/);reaped(children);
});
test('scope cleanup preserves the original operation failure while reaping a failed helper',{skip:process.platform!=='win32'},async()=>{
 const script=replies("process.stdout.write(JSON.stringify({id:request.id,ok:true})+'\\n');")+"process.stdin.on('end',()=>process.exit(23));";
 const {checker,children}=syntheticChecker(script),original=Object.assign(Error('original synthetic operation failure'),{code:'synthetic_original'});
 await assert.rejects(withWindowsPrivateChecks(async()=>{await checkWindowsPrivatePath(path);throw original;},{checkerFactory:()=>checker}),error=>error===original);
 reaped(children);
});
for(const [name,script] of [
 ['wrong identity',replies("process.stdout.write(JSON.stringify({id:request.id+1,ok:true})+'\\n');")],
 ['extra property',replies("process.stdout.write(JSON.stringify({id:request.id,ok:true,extra:1})+'\\n');")],
 ['wrong type',replies("process.stdout.write(JSON.stringify({id:request.id,ok:'true'})+'\\n');")],
 ['denied path',replies("process.stdout.write(JSON.stringify({id:request.id,ok:false})+'\\n');")],
 ['malformed JSON',replies("process.stdout.write('invalid\\n');")],
 ['duplicate keys',replies("process.stdout.write('{\"id\":'+request.id+',\"ok\":false,\"ok\":true}\\n');")],
 ['extra replies',replies("const reply=JSON.stringify({id:request.id,ok:true})+'\\n';process.stdout.write(reply+reply);")],
 ['oversized stdout',replies("process.stdout.write('x'.repeat(2048));")],
 ['invalid UTF8',replies("process.stdout.write(Buffer.from([255,10]));")],
 ['early EOF',replies('process.exit(0);')],
 ['nonzero exit',replies('process.exit(23);')],
 ['oversized stderr',replies("process.stderr.write('private details'.repeat(200));")],
])test('helper fails closed, poisons pending checks and reaps child on '+name,async()=>{
 const {checker,children}=syntheticChecker(script);
 try{
  const results=await Promise.allSettled([checker.check(path),checker.check(path+'-two')]);
  assert.ok(results.every(result=>result.status==='rejected'));
  for(const result of results){assert.match(result.reason.message,/Collector private path helper/);assert.ok(!result.reason.message.includes(path));assert.ok(!result.reason.message.includes('private details'));}
  await assert.rejects(checker.check(path),/helper/);assert.equal(children.length,1);
 }finally{await assert.rejects(checker.close(),/helper/);}reaped(children);
});
test('timeout includes queue waiting and cleanup reaps the silent child',async()=>{
 const {checker,children}=syntheticChecker('setInterval(()=>{},1000);',{timeoutMs:100});
 const results=await Promise.allSettled([checker.check(path),checker.check(path)]);
 assert.ok(results.every(result=>result.status==='rejected'&&/timed out/.test(result.reason.message)));
 await assert.rejects(checker.close(),/helper/);reaped(children);
});
test('aborted checks never spawn and active cancellation fails queued requests',async()=>{
 const aborted=new AbortController();aborted.abort();
 const before=syntheticChecker('setInterval(()=>{},1000);',{signal:aborted.signal});
 await assert.rejects(before.checker.check(path),/aborted/);await assert.rejects(before.checker.close(),/aborted/);assert.equal(before.children.length,0);
 const active=new AbortController(),{checker,children}=syntheticChecker('setInterval(()=>{},1000);',{signal:active.signal,maxPending:2});
 const pending=Promise.allSettled([checker.check(path),checker.check(path),checker.check(path)]);active.abort();
 const results=await pending;assert.ok(results.every(result=>result.status==='rejected'));assert.match(results[2].reason.message,/queue/);
 await assert.rejects(checker.close(),/aborted/);reaped(children);await assert.rejects(checker.check(path),/aborted/);
});
test('startup errors and operation failures still close owned helpers',async()=>{
 const checker=createWindowsPrivateChecker({spawnHelper:()=>spawn(join(tmpdir(),'synthetic-missing-private-helper'),[],{stdio:['pipe','pipe','pipe']})});
 await assert.rejects(checker.check(path),/helper/);await assert.rejects(checker.close(),/helper/);
 const scoped=syntheticChecker(replies("process.stdout.write(JSON.stringify({id:request.id,ok:true})+'\\n');"));
 await assert.rejects(withWindowsPrivateChecks(async()=>{await checkWindowsPrivatePath(path);throw Error('synthetic operation failure');},{checkerFactory:()=>scoped.checker}),/synthetic operation failure/);
 await scoped.checker.close();reaped(scoped.children);
});
test('nested scopes reuse a checker while unrelated scopes remain isolated',{skip:process.platform!=='win32'},async()=>{
 const children=[];let factories=0;
 const factory=options=>{factories++;return createWindowsPrivateChecker({...options,spawnHelper:()=>{const child=spawn(process.execPath,['-e',replies("process.stdout.write(JSON.stringify({id:request.id,ok:true})+'\\n');")],{stdio:['pipe','pipe','pipe']});children.push(child);return child;}});};
 await Promise.all([1,2].map(()=>withWindowsPrivateChecks(async()=>{
  await checkWindowsPrivatePath(path);await withWindowsPrivateChecks(()=>checkWindowsPrivatePath(path));await checkWindowsPrivatePath(path);
 },{checkerFactory:factory})));
 assert.equal(factories,2);assert.equal(children.length,2);reaped(children);
});

test('native helper isolates module environment, reuses process, and detects changed ACLs',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-private-helper-')),state=join(directory,'state'),children=[];let denied=false;
 const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];env.PSModulePath=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules');
 const command=`$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));Set-Acl -LiteralPath $env:SYNTHETIC_PRIVATE_HELPER_PATH -AclObject $acl`;
 const checker=createWindowsPrivateChecker({spawnHelper:(executable,args,options)=>{assert.equal(options.env.PSModulePath,env.PSModulePath);assert.equal(options.env.TEMP,process.env.TEMP);const child=spawn(executable,args,options);children.push(child);return child;}});
 try{
  await mkdir(state);await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:5000,env:{...env,SYNTHETIC_PRIVATE_HELPER_PATH:state}});
  await checker.check(state);await checker.check(state);assert.equal(children.length,1);
  // Modify only this synthetic DACL; do not request owner/SACL privileges.
  await exec(join(process.env.SystemRoot??'C:\\Windows','System32','icacls.exe'),[state,'/grant','*S-1-5-32-545:R'],{windowsHide:true,timeout:5000});
  await assert.rejects(checker.check(state),/helper/);denied=true;assert.equal(children.length,1);
 }finally{if(denied)await assert.rejects(checker.close(),/helper/);else await checker.close();await rm(directory,{recursive:true,force:true});}reaped(children);
});
