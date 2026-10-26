import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readHistoryRecord,listHistoryRecords} from '../lib/history/store.ts';
import {enrollHistoryIngestCredential} from '../lib/history/auth.ts';
import {handleHistoryTransport} from '../lib/history/http.ts';
import type {PrivateHistoryBucket} from '../lib/history/object-store.ts';
import type {PrivateIngressVerifier} from '../lib/devices/contracts.ts';
import {createTransport} from '../collector/src/transport.mjs';
import {runCollector} from '../collector/src/cli.mjs';
import {acquireSingleInstance} from '../collector/src/spool.mjs';
const owner='synthetic-collector-http-owner',sourceId='synthetic-source',origin='https://example.invalid';
const execFileAsync=promisify(execFile);
function nativePowerShellEnvironment(){
 const env={...process.env};
 for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
 env.PSModulePath=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules');
 return env;
}
// Only this fixture's newly-created temporary state receives owner-only ACLs.
// mode:0700 alone does not remove inherited Windows access rules.
async function privateTestState(directory:string){
 const state=join(directory,'state');await mkdir(state,{mode:0o700});
 if(process.platform==='win32')await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $env:CONTROL_ROOM_SYNTHETIC_STATE -AclObject $acl`],{windowsHide:true,timeout:5000,env:{...nativePowerShellEnvironment(),CONTROL_ROOM_SYNTHETIC_STATE:state}});
 return state;
}
/** Actual reader, CLI, durable spool, client transport and server HTTP/store paths.
 * Memory bucket and private-ingress verifier are synthetic ports: no R2, hosted
 * ingress, physical device, provider authentication or owner roots are verified. */
async function fixture(messageCount=251){
 const directory=await mkdtemp(join(tmpdir(),'synthetic-collector-integration-')),{db,sqlite}=database(),now=()=>new Date().toISOString(),root=join(directory,'root');
 try{
  const state=await privateTestState(directory);
  await mkdir(root,{mode:0o700});
  const records:unknown[]=[{type:'session_meta',payload:{id:'synthetic-thread'}}];
  for(let i=0;i<messageCount;i++)records.push({type:'response_item',payload:{type:'message',id:'synthetic-'+i,role:'user',content:[{type:'input_text',text:'synthetic retained content '+i}]}});
  await writeFile(join(root,'retained.jsonl'),records.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await loadWorkspace(db,owner,()=>workspaceFixture(),now());
  const configured=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'history.source.configure',sourceId,expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic fixture',roots:[root],accountId:null,deviceId:null,includeArchived:true,exclusions:[]}},{db,now,handlers:workspaceHandlers});
  assert.equal(configured.status,'committed');
  const source=(await readHistoryRecord(db,owner,'source',sourceId))!.record.value.configuration;
  const enrollment=await enrollHistoryIngestCredential(db,{authenticatedOwnerId:owner,authorizeOwner:async()=>true},{sourceId,expiresAt:new Date(Date.now()+3600000).toISOString()},now());
  const objects=new Map<string,Uint8Array>(),counts={uploads:0,metadata:0,ingress:0};let revokeOnPut=false;
  const bucket:PrivateHistoryBucket={async put(key,bytes){objects.set(key,bytes.slice());if(revokeOnPut)await db.prepare('UPDATE history_ingest_credentials SET revoked_at=? WHERE user_id=?').bind(now(),owner).run();},async get(key,maxBytes){const bytes=objects.get(key);if(bytes&&bytes.byteLength>maxBytes)throw Error('Synthetic bucket read exceeds declared bound.');return bytes?.slice()??null;},async delete(key){objects.delete(key);}};
  const privateIngress:PrivateIngressVerifier={async verify(){counts.ingress++;return {serviceIdentity:'synthetic-private-ingress'};}};
  const services={db,now,bucket,privateIngress};
  const transportOptions={origin,allowedOrigins:[origin],credential:async()=>({...enrollment,sourceId,epoch:source.epoch,scopeRevision:source.scopeRevision}),privateIngress:async()=>({Authorization:'synthetic-gateway-proof'}),fetchImpl:(async(url:RequestInfo|URL,input?:RequestInit)=>{const operation=String(url).endsWith('/objects')?'objects':'ingest';if(operation==='objects')counts.uploads++;else counts.metadata++;return handleHistoryTransport(operation,new Request(url,input),services);}) as typeof fetch};
  // The JS default ingress provider infers Promise<void>; this fixture supplies
  // its documented synthetic header-provider port without changing production.
  const transport=(createTransport as unknown as (options:typeof transportOptions)=>ReturnType<typeof createTransport>)(transportOptions);
  const configuration={codecVersion:1,origin,stateDirectory:state,sources:[source],scopes:['history.read','history.ingest'],reconcileIntervalMs:1000,debounceMs:0,maxCatchUpLagMs:1000};
  const runOptions={once:true,signal:new AbortController().signal,adapterFactory:undefined,transport,now:Date.now};
  const run=()=>runCollector(configuration,runOptions);
  return {db,sqlite,objects,counts,run,revokeDuringPut:()=>{revokeOnPut=true;},cleanup:async()=>{sqlite.close();await rm(directory,{recursive:true,force:true});}};
 }catch(error){sqlite.close();await rm(directory,{recursive:true,force:true});throw error;}
}
test('native Windows collector ACL check ignores a poisoned inherited PowerShell module path',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-collector-module-path-'));
 try{
  const state=await privateTestState(directory),modules=join(directory,'modules'),security=join(modules,'Microsoft.PowerShell.Security');
  await mkdir(security,{recursive:true});
  await writeFile(join(security,'Microsoft.PowerShell.Security.psd1'),"@{RootModule='Microsoft.PowerShell.Security.psm1';ModuleVersion='1.0.0';FunctionsToExport=@('Get-Acl');CmdletsToExport=@()}");
  await writeFile(join(security,'Microsoft.PowerShell.Security.psm1'),"function Get-Acl { throw 'Synthetic poisoned inherited module path' }; Export-ModuleMember -Function Get-Acl");
  const env={...nativePowerShellEnvironment(),PSModulePath:modules+';'+nativePowerShellEnvironment().PSModulePath,CONTROL_ROOM_SYNTHETIC_STATE:state};
  // The shadow module must actually break an unprotected native child first.
  await assert.rejects(execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Get-Acl -LiteralPath $env:CONTROL_ROOM_SYNTHETIC_STATE | Out-Null"],{windowsHide:true,timeout:5000,env}),/Synthetic poisoned inherited module path/);
  const moduleUrl=new URL('../collector/src/spool.mjs',import.meta.url).href;
  await execFileAsync(process.execPath,['--input-type=module','-e',`import {privateDirectory} from ${JSON.stringify(moduleUrl)};await privateDirectory(process.argv[1]);`,state],{windowsHide:true,timeout:10000,env});
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('native Windows collector lock excludes contenders and releases after close or process death',{skip:process.platform!=='win32',timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-collector-instance-'));let release,child,childClosed:Promise<void>|undefined;
 try{
  const state=await privateTestState(directory),other=join(directory,'other');await mkdir(other);
  const otherState=await privateTestState(other);
  release=await acquireSingleInstance(state);
  await assert.rejects(acquireSingleInstance(state),{code:'EADDRINUSE'});
  const releaseOther=await acquireSingleInstance(otherState);await releaseOther();
  await release();release=undefined;
  const moduleUrl=new URL('../collector/src/spool.mjs',import.meta.url).href;
  child=spawn(process.execPath,['--input-type=module','-e',`import {acquireSingleInstance} from ${JSON.stringify(moduleUrl)};await acquireSingleInstance(process.argv[1]);process.stdout.write('locked');`,state],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const activeChild=child;
  childClosed=new Promise<void>(resolve=>{activeChild.once('close',()=>resolve());});
  await new Promise<void>((resolve,reject)=>{
   let stderr='';activeChild.stderr.on('data',bytes=>{stderr+=bytes;});
   activeChild.once('error',reject);activeChild.once('exit',()=>reject(Error('Synthetic lock holder exited: '+stderr)));
   activeChild.stdout.once('data',bytes=>{try{assert.equal(bytes.toString(),'locked');resolve();}catch(error){reject(error);}});
  });
  await assert.rejects(acquireSingleInstance(state),{code:'EADDRINUSE'});
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await childClosed;child=undefined;
  release=await acquireSingleInstance(state);
 }finally{
  if(child){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await childClosed;}
  await release?.();await rm(directory,{recursive:true,force:true});
 }
});
test('synthetic CLI through actual history HTTP and SQLite imports 251 messages, repeats without uploads and retains first immutable metadata',{timeout:120000},async()=>{
 const f=await fixture();try{
  assert.equal((await f.run()).pending,0);
  assert.equal(f.counts.uploads,252);assert.equal(f.counts.metadata,2);assert.equal(f.objects.size,252);
  const firstPage=await listHistoryRecords(f.db,owner,'message',{limit:200}),remaining=await listHistoryRecords(f.db,owner,'message',{limit:200,after:firstPage.at(-1)!.record.id});
  assert.equal(firstPage.length,200);assert.equal(remaining.length,51);const initial=[...firstPage,...remaining];
  assert.equal((await listHistoryRecords(f.db,owner,'segment')).length,1);assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,2);
  assert.equal((await f.run()).pending,0);
  assert.equal(f.counts.uploads,252);assert.equal(f.objects.size,252);assert.equal(f.counts.metadata,4);
  const secondFirst=await listHistoryRecords(f.db,owner,'message',{limit:200}),secondRest=await listHistoryRecords(f.db,owner,'message',{limit:200,after:secondFirst.at(-1)!.record.id});
  assert.deepEqual([...secondFirst,...secondRest],initial);
  assert.equal((await listHistoryRecords(f.db,owner,'segment')).length,1);assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,4);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").bind(owner).first<{n:number}>())!.n,4);
  assert.equal((await f.db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,2);
  assert.equal((await listHistoryRecords(f.db,'synthetic-foreign-owner','message')).length,0);assert.equal(f.counts.ingress,256);
 }finally{await f.cleanup();}
});
test('synthetic credential revocation during a physical bucket PUT prevents object finalization and every metadata acknowledgement',{timeout:120000},async()=>{
 const f=await fixture(1);try{
  f.revokeDuringPut();await assert.rejects(f.run(),/reconcile_needed|credential_or_ingress_denied/);
  assert.equal(f.counts.uploads,1);assert.equal(f.counts.metadata,0);assert.equal(f.objects.size,1);
  const ledger=(await f.db.prepare('SELECT status,pending_token FROM history_object_ledger WHERE user_id=?').bind(owner).all<{status:string;pending_token:string|null}>()).results;
  assert.deepEqual(ledger.map(row=>({...row})),[{status:'abandoned',pending_token:null}]);
  assert.equal((await listHistoryRecords(f.db,owner,'message')).length,0);assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,0);assert.equal((await listHistoryRecords(f.db,owner,'cursor')).length,0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").bind(owner).first<{n:number}>())!.n,0);
  assert.equal((await f.db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,2);
 }finally{await f.cleanup();}
});
