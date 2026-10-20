import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createManualSitesIngress,parseManualSitesWindow,privateIngressBoundaryKey,MANUAL_SITES_PROJECT,MANUAL_SITES_ORIGIN} from '../lib/devices/private-ingress.ts';
import {handleAgentHttp} from '../lib/agents/http.ts';
import {handleAgentArtifactHttp} from '../lib/agents/artifact-http.ts';
import {authenticateDevice} from '../lib/devices/auth.ts';
import {artifactSeedFixture,artifactNow,artifactLater} from './fixtures/agent-artifact.ts';
import {jobReadModelSchema} from '../lib/agents/read-model.ts';
import {readAgentJobs} from '../lib/agents/read-store.ts';
const at=artifactNow,window={mode:'manual-owner-private-sites',projectId:MANUAL_SITES_PROJECT,siteOrigin:MANUAL_SITES_ORIGIN,confirmedAt:at,releaseUntil:artifactLater(900)};
const raw=JSON.stringify(window);
function request(path='/api/bridge/jobs/claim',method='POST',headers:Record<string,string>={}){return new Request(MANUAL_SITES_ORIGIN+path,{method,headers});}
test('finite native confirmation is exact, default closed, and project matches retained hosting identity',async()=>{
 const hosting=JSON.parse(await readFile(new URL('../.openai/hosting.json',import.meta.url),'utf8'));assert.equal(MANUAL_SITES_PROJECT,hosting.project_id);
 assert.ok(parseManualSitesWindow(raw,at));
 for(const value of [undefined,'{}','not-json',JSON.stringify({...window,projectId:'another-project'}),JSON.stringify({...window,siteOrigin:'https://example.workers.dev'}),JSON.stringify({...window,siteOrigin:MANUAL_SITES_ORIGIN+'/'}),JSON.stringify({...window,ownerId:'invented'}),JSON.stringify({...window,releaseUntil:artifactLater(901)}),JSON.stringify({...window,releaseUntil:at})])assert.equal(parseManualSitesWindow(value,at),null);
 assert.equal(parseManualSitesWindow(raw,artifactLater(-1)),null);assert.equal(parseManualSitesWindow(raw,artifactLater(900)),null);
 assert.equal(await createManualSitesIngress(undefined,()=>at).verify(request()),null);
});
test('only server-minted opaque verdicts admit fixed method/path/origin and expire without renewal',async()=>{
 let now=at;const ingress=createManualSitesIngress(raw,()=>now),verdict=await ingress.verify(request());assert.deepEqual(verdict,{kind:'manual-owner-private-sites'});assert.ok(privateIngressBoundaryKey(verdict,now));
 assert.equal(privateIngressBoundaryKey({kind:'manual-owner-private-sites'},at),null);
 // Dispatch consumes its bearer; no bearer or visitor identity is required or inferred.
 assert.ok(await ingress.verify(request('/api/bridge/jobs/events')));
 assert.ok(await ingress.verify(request('/api/bridge/jobs/artifacts/12345678-abcd-abcd-abcd-123456789abc/content','PUT')));
 for(const req of [request('/api/bridge/jobs/claim','GET'),request('/api/jobs'),request('/api/bridge/jobs/claim?owner=x'),request('/api/bridge/jobs/artifacts/not-a-uuid/content','PUT'),request('/api/bridge/jobs/claim','POST',{Cookie:'session=x'}),request('/api/bridge/jobs/claim','POST',{'X-Control-Room-Ingress-Verdict':'true'}),request('/api/bridge/jobs/claim','POST',{'X-Control-Room-Service-Identity':'invented'}),new Request('https://direct-worker.example/api/bridge/jobs/claim',{method:'POST'})])assert.equal(await ingress.verify(req),null);
 now=artifactLater(900);assert.equal(await ingress.verify(request()),null);assert.equal(privateIngressBoundaryKey(verdict,now),null);
});
test('opaque Sites boundary preserves real device scope, owner, epoch and once-only bounded claim',async()=>{
 const f=await artifactSeedFixture();try{
  const ingress=createManualSitesIngress(raw,()=>at),headers={'Content-Type':'application/json','X-Control-Room-Device':f.deviceSecret};
  assert.equal(await authenticateDevice(request('/api/bridge/jobs/claim','POST'), 'jobs:poll',f.db,ingress,at),null);
  const mapped=await authenticateDevice(request('/api/bridge/jobs/claim','POST',headers),'jobs:poll',f.db,ingress,at);assert.equal(mapped?.ownerId,f.owner);assert.equal(mapped?.deviceId,f.principal.deviceId);
  const claim={jobId:f.jobId,journalNonce:'n'.repeat(32)},call=()=>handleAgentHttp('claim',new Request(MANUAL_SITES_ORIGIN+'/api/bridge/jobs/claim',{method:'POST',headers,body:JSON.stringify(claim)}),{db:f.db,ingress,now:()=>at,context:f.context});
  const first=await call();assert.equal(first.status,200);const lease=await first.json() as {attemptId:string;leaseToken:string};assert.equal(typeof lease.attemptId,'string');assert.equal(typeof lease.leaseToken,'string');assert.equal((await call()).status,200);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM job_attempts').get()!.n,1);
  const wrongDevice={...headers,'X-Control-Room-Device':'foreign_device_credential_0000000000000000000000'};assert.equal(await authenticateDevice(request('/api/bridge/jobs/claim','POST',wrongDevice),'jobs:poll',f.db,ingress,at),null);
  f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=1 WHERE user_id=?').run(f.owner);assert.equal(await authenticateDevice(request('/api/bridge/jobs/claim','POST',headers),'jobs:poll',f.db,ingress,at),null);
 }finally{f.sqlite.close();}
});
test('window expiry during a request body denies dispatch and artifact mutation issuance',async()=>{
 const f=await artifactSeedFixture();try{
  let now=at,calls=0;const ingress=createManualSitesIngress(raw,()=>now),headers={'Content-Type':'application/json','X-Control-Room-Device':f.deviceSecret};
  const body=(value:unknown)=>new ReadableStream<Uint8Array>({pull(controller){now=artifactLater(900);controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));controller.close();}},{highWaterMark:0});
  const req=new Request(MANUAL_SITES_ORIGIN+'/api/bridge/jobs/claim',{method:'POST',headers,body:body({jobId:f.jobId,journalNonce:'n'.repeat(32)}),duplex:'half'} as RequestInit);
  assert.equal((await handleAgentHttp('claim',req,{db:f.db,ingress,now:()=>now,operations:{claim:async()=>{calls++;return null;}}})).status,401);assert.equal(calls,0);
  now=at;const fakeBody=new Request(MANUAL_SITES_ORIGIN+'/api/bridge/jobs/claim',{method:'POST',headers,body:JSON.stringify({jobId:f.jobId,journalNonce:'n'.repeat(32),ingressVerdict:{kind:'manual-owner-private-sites'},serviceIdentity:'invented'})});
  assert.equal((await handleAgentHttp('claim',fakeBody,{db:f.db,ingress,now:()=>now,operations:{claim:async()=>{calls++;return null;}}})).status,400);assert.equal(calls,0);
  now=at;const artifact=new Request(MANUAL_SITES_ORIGIN+'/api/bridge/jobs/artifacts/mutation-id',{method:'POST',headers,body:body({attemptId:'missing',leaseToken:'a'.repeat(64)}),duplex:'half'} as RequestInit);
  assert.equal((await handleAgentArtifactHttp('mutation-id',artifact,{db:f.db,ingress,now:()=>now})).status,401);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM job_attempts').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('manual window alone never reports provider-ready admission; output remains closed and finite',async()=>{
 const f=await artifactSeedFixture();try{
  assert.deepEqual((await readAgentJobs(f.db,f.owner,at)).execution,{enabled:false,diagnostic:'not_installed'});
  const manualWindow={mode:'manual-owner-private-sites' as const,confirmedAt:at,releaseUntil:artifactLater(900)};
  const model=await readAgentJobs(f.db,f.owner,at,{executionAvailable:true,manualWindow});assert.equal(model.execution.enabled,false);assert.equal(model.execution.diagnostic,'not_configured');assert.deepEqual(model.execution.manualWindow,manualWindow);
  assert.throws(()=>jobReadModelSchema.parse({...model,execution:{...model.execution,manualWindow:{...manualWindow,releaseUntil:artifactLater(901)}}}));
 }finally{f.sqlite.close();}
});
test('every production bridge route uses the finite factory, never a configured legacy adapter',async()=>{
 let count=0;async function walk(directory:URL){for(const entry of await readdir(directory,{withFileTypes:true})){const path=new URL(entry.name+(entry.isDirectory()?'/':''),directory);if(entry.isDirectory())await walk(path);else if(entry.name==='route.ts'){const text=await readFile(path,'utf8');assert.match(text,/ingress:createManualSitesIngress\(env.CONTROL_ROOM_MANUAL_SITES_WINDOW\)/);assert.doesNotMatch(text,/serviceIdentity|unavailablePrivateIngress/);count++;}}}
 await walk(new URL('../app/api/bridge/',import.meta.url));assert.equal(count,16);
});
