import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {readFile,mkdtemp,rm,access,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {createWindowsOwnedProcessSupervisor} from '../executor/owned-process.mjs';
const windows=process.platform==='win32',fixture=fileURLToPath(new URL('./fixtures/owned-child.mjs',import.meta.url));
let owner,buildDirectory,registration;
test.before(async()=>{
 if(!windows)return;
 buildDirectory=await mkdtemp(join(tmpdir(),'owned-native-build-'));
 const project=fileURLToPath(new URL('../windows/owned-process/OwnedProcess.csproj',import.meta.url));
 const build=spawnSync('dotnet',['publish',project,'--configuration','Release','--output',buildDirectory,'--runtime','win-x64','--self-contained','false','-p:PublishSingleFile=true'],{encoding:'utf8',shell:false,timeout:120000});
 assert.equal(build.status,0,build.stdout+'\n'+build.stderr);
 assert.deepEqual((await readdir(buildDirectory)).filter(name=>name!=='OwnedProcess.pdb'),['OwnedProcess.exe']);
 const helperExecutable=join(buildDirectory,'OwnedProcess.exe'),helperSha256=createHash('sha256').update(await readFile(helperExecutable)).digest('hex');
 registration={helperExecutable,helperSha256};
});
test.beforeEach(async()=>{if(windows)owner=await createWindowsOwnedProcessSupervisor(registration);});
test.after(async()=>{if(buildDirectory)await rm(buildDirectory,{recursive:true,force:true});});
function request(args=[],overrides={}){
 const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[key])env[key]=process.env[key];
 return {executable:process.execPath,args:[fixture,...args],cwd:resolve(tmpdir()),env,input:'synthetic input',timeoutMs:5000,outputBytesLimit:65536,signal:new AbortController().signal,onStarted:async identity=>{assert.ok(identity.pid>0);assert.match(identity.ownershipSha256,/^[a-f0-9]{64}$/u);},onStdout(){},onStderr(){},...overrides};
}
test('non-Windows owner construction refuses to manufacture native ownership', {skip:windows},async()=>{await assert.rejects(createWindowsOwnedProcessSupervisor({helperExecutable:'/synthetic',helperSha256:'a'.repeat(64)}),/windows_owned_process_unavailable/);});
test('native Windows suspended process does not execute until durable callback completes', {skip:!windows},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'owned-marker-')),marker=join(directory,'marker');
 try{const result=await owner.run(request(['marker',marker],{onStarted:async()=>{await assert.rejects(access(marker));await new Promise(resolve=>setTimeout(resolve,150));await assert.rejects(access(marker));}}));assert.equal(result.processExitConfirmed,true);assert.equal(result.terminationUnconfirmed,false);assert.equal(result.exitCode,0);assert.equal(await readFile(marker,'utf8'),'executed');}finally{await rm(directory,{recursive:true,force:true});}
});
test('native Windows exact stdin and quotes preserve bytes', {skip:!windows},async()=>{const result=await owner.run(request([],{input:'synthetic 界 "quote" \\ end'}));assert.equal(result.stdout,'synthetic 界 "quote" \\ end');assert.equal(result.stopReason,null);assert.equal(result.processExitConfirmed,true);});
test('native Windows cancels owned parent/descendants while unrelated owned child keeps emitting', {skip:!windows},async()=>{
 const unrelated=spawn(process.execPath,[fixture,'heartbeat'],{stdio:'pipe',shell:false});await once(unrelated,'spawn');let heartbeats=0;unrelated.stdout.on('data',()=>{heartbeats++;});await once(unrelated.stdout,'data');
 try{
  const controller=new AbortController();let output='';const result=await owner.run(request(['tree'],{signal:controller.signal,onStdout:chunk=>{output+=chunk.toString();if(output.includes('descendant-ready'))controller.abort();}}));
  assert.match(output,/descendant-ready/u);assert.equal(result.stopReason,'cancelled');assert.equal(result.processExitConfirmed,true);assert.equal(result.terminationUnconfirmed,false);assert.equal(unrelated.exitCode,null);assert.equal(unrelated.killed,false);const before=heartbeats;await once(unrelated.stdout,'data');assert.ok(heartbeats>before);
 }finally{unrelated.kill();await once(unrelated,'close');}
});
test('native Windows finite timeout and output limit stop whole owned job', {skip:!windows},async()=>{
 for(const [mode,patch,reason] of [['silent',{timeoutMs:1000},'timed_out'],['flood',{outputBytesLimit:1024},'output_limit']]){const result=await owner.run(request([mode],patch));assert.equal(result.stopReason,reason);assert.equal(result.processExitConfirmed,true);assert.equal(result.terminationUnconfirmed,false);assert.ok(Buffer.byteLength(result.stdout)<=1024);}
});
test('native Windows rejected durable-start callback cannot resume child or claim exit', {skip:!windows},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'owned-refuse-')),marker=join(directory,'marker');try{const result=await owner.run(request(['marker',marker],{onStarted:async()=>{throw Error('synthetic write failure');}}));assert.equal(result.processExitConfirmed,false);assert.equal(result.terminationUnconfirmed,true);await assert.rejects(access(marker));}finally{await rm(directory,{recursive:true,force:true});}
});

test('native Windows registration refuses an unbound mutable application sidecar', {skip:!windows},async()=>{
 const sidecar=join(buildDirectory,'OwnedProcess.dll');await writeFile(sidecar,'synthetic untrusted sidecar');try{await assert.rejects(owner.run(request()),/unexpected_owned_helper_sidecar/);}finally{await rm(sidecar);}
});

test('native Windows joins deferred durable callback after helper exits and never resumes afterward', {skip:!windows},async()=>{
 const controller=new AbortController();let release,started;const barrier=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});let settled=false;
 const pending=owner.run(request(['silent'],{signal:controller.signal,onStarted:async()=>{started();controller.abort();await barrier;}})).then(value=>{settled=true;return value;});
 await entered;await new Promise(resolve=>setTimeout(resolve,250));assert.equal(settled,false);release();const result=await pending;assert.equal(result.processExitConfirmed,false);assert.equal(result.terminationUnconfirmed,true);
 await assert.rejects(owner.run(request()),/owned_process_slot_unavailable/);
});
test('native Windows stale or reused PID text cannot select a process to stop', {skip:!windows},async()=>{
 await assert.rejects(owner.run({...request(),pid:process.pid}),/invalid_shape/);
 const result=await owner.run(request());assert.equal(result.processExitConfirmed,true);assert.equal(result.exitCode,0);
});
