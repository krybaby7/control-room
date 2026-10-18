// Isolated actual Miniflare D1 proof with synthetic device messages.
// The injected ingress identity is a fixture dependency, not verified deployment,
// Windows hardware, a live bridge, or provider availability.
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runBridgeOnce} from '../bridge/src/cli.mjs';
import {createBridgeTransport} from '../bridge/src/transport.mjs';
import {Outbox} from '../bridge/src/outbox.mjs';
import {Miniflare} from 'miniflare';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {issueMutationId} from '../lib/idempotency-retention.ts';
import {createOwnerEnrollment} from '../lib/devices/enrollment.ts';
import {handleDeviceHttp} from '../lib/devices/http.ts';
import {authenticateDevice} from '../lib/devices/auth.ts';
import {unavailablePrivateIngress} from '../lib/devices/contracts.ts';
import {ingestHeartbeat,readRuntime,readLatestRuntimeEvidence} from '../lib/runtime/store.ts';
import {exportWorkspaceBundle,parseWorkspaceBundle} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';

assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 or newer is required.');
const owner='synthetic-runtime-d1-owner',other='synthetic-runtime-d1-other-owner';
const base='2026-10-18T12:00:00.000Z',at=seconds=>new Date(Date.parse(base)+seconds*1000).toISOString();
let clock=base;
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated runtime D1 fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,cf:false});
// A deliberately synthetic server dependency exercises the real HTTP adapter.
// Production routes still use unavailablePrivateIngress and remain unavailable.
const syntheticIngress={async verify(){return {serviceIdentity:'synthetic-runtime-d1-ingress'};}};
try{
 const db=await mf.getD1Database('DB');
 const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
 for(const name of migrations){const source=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');for(const sql of source.split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();}
 await loadWorkspace(db,owner,()=>createSeedWorkspace(base),base);
 await loadWorkspace(db,other,()=>createSeedWorkspace(base),base);
 const planning=(await readCurrent(db,owner,clock)).workspace,projectId=planning.projects[0].id;
 async function count(table,scope=owner){return (await db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE user_id=?').bind(scope).first()).n;}
 async function execute(command,scope=owner,retained){
  const before=await readCurrent(db,scope,clock),request=retained??{protocolVersion:1,expectedRevision:before.revision,mutationId:await issueMutationId(db,scope,clock),command};
  const result=await executeWorkspaceCommand(scope,request,{db,handlers:workspaceHandlers,now:()=>clock});
  assert.deepEqual((await readCurrent(db,scope,clock)).workspace,before.workspace,'Runtime owner commands cannot change planning.');
  return {result,request};
 }
 const command={type:'devices.enrollment.create',value:{label:'Synthetic D1 runtime PC',scopes:['telemetry:write']}};
 const enrollmentRequest={revision:(await readCurrent(db,owner,clock)).revision,mutationId:await issueMutationId(db,owner,clock),command};
 const enrollment=await createOwnerEnrollment(db,owner,enrollmentRequest,clock);
 assert.equal(enrollment.status,200);assert.deepEqual(enrollment.body.envelope.workspace,planning);
 const issued=enrollment.body.result;assert.ok(issued);assert.equal(enrollment.body.receipt.commandHash,await contentHash(canonical({protocolVersion:1,command})));
 assert.equal(await count('devices'),1);assert.equal(await count('device_enrollments'),1);
 const replay=await createOwnerEnrollment(db,owner,enrollmentRequest,clock);
 assert.equal(replay.status,409);assert.equal(replay.body.code,'enrollment-secret-unavailable');assert.equal('result'in replay.body,false);assert.deepEqual(replay.body.receipt,enrollment.body.receipt);
 assert.equal(await count('devices'),1);assert.equal(await count('device_enrollments'),1);
 const enrolledRow=await db.prepare('SELECT secret_hash,consumed_at FROM device_enrollments WHERE user_id=? AND id=?').bind(owner,issued.enrollmentId).first();
 assert.equal(enrolledRow.secret_hash,await contentHash(issued.secret));assert.equal(enrolledRow.consumed_at,null);
 const bridgeVersion='0.1.0';
 function request(action,body,credential,cookie=false){
  return new Request('https://synthetic-device.invalid/api/bridge/'+action,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{'X-Control-Room-Device':credential}:{}),...(cookie?{Cookie:'fixture_browser=not-device-authority'}:{})},body:JSON.stringify(body)});
 }
 const deps={db,ingress:syntheticIngress,now:()=>clock,ingest:ingestHeartbeat};
 const denied=await handleDeviceHttp('enroll',request('enroll',{secret:issued.secret,bridgeVersion}),{...deps,ingress:unavailablePrivateIngress});
 assert.equal(denied.status,401);assert.equal(await count('device_credentials'),0);
 const redeemed=await handleDeviceHttp('enroll',request('enroll',{secret:issued.secret,bridgeVersion}),deps);
 assert.equal(redeemed.status,201);assert.equal(redeemed.headers.get('cache-control'),'no-store, private');
 const credential=await redeemed.json();assert.equal(credential.deviceId,issued.deviceId);assert.equal(await count('device_credentials'),1);
 const credentialRow=await db.prepare('SELECT token_hash FROM device_credentials WHERE user_id=? AND id=?').bind(owner,credential.credentialId).first();
 assert.equal(credentialRow.token_hash,await contentHash(credential.deviceCredential));
 assert.equal((await handleDeviceHttp('enroll',request('enroll',{secret:issued.secret,bridgeVersion}),deps)).status,409);
 assert.equal(await count('device_credentials'),1);
 const principal=await authenticateDevice(request('session',{},credential.deviceCredential),'telemetry:write',db,syntheticIngress,clock);assert.ok(principal);assert.equal(principal.ownerId,owner);
 assert.equal((await handleDeviceHttp('session',request('session',{bootId:crypto.randomUUID(),bridgeVersion},credential.deviceCredential,true),deps)).status,403);
 assert.equal((await handleDeviceHttp('session',request('session',{bootId:crypto.randomUUID(),bridgeVersion},credential.deviceCredential),{...deps,ingress:unavailablePrivateIngress})).status,401);
 const manifest={id:'pc-command-center',version:1,enabled:true,capabilities:['read.health','read.summary'],endpointAlias:'pc-command-center'};
 const configured=await execute({type:'runtime.adapter.configure',value:{deviceId:issued.deviceId,projectId,manifest,selectedGpuAlias:null}});
 assert.equal(configured.result.status,'committed');const configuration=(await ownerReader(db,owner).list('runtime_adapter_configurations'))[0];assert.ok(configuration);
 const beforeRejected=await readCurrent(db,owner,clock);
 await assert.rejects(execute({type:'runtime.adapter.configure',value:{deviceId:issued.deviceId,projectId,manifest:{...manifest,id:'agent-lab',endpointAlias:'agent-lab'},selectedGpuAlias:null}}));
 assert.deepEqual(await readCurrent(db,owner,clock),beforeRejected);
 await assert.rejects(execute({type:'runtime.adapter.configure',value:{deviceId:issued.deviceId,projectId:null,manifest,selectedGpuAlias:null}},other));
 assert.equal((await readRuntime(db,other,clock)).devices.length,0);
 const bootId=crypto.randomUUID(),sessionResponse=await handleDeviceHttp('session',request('session',{bootId,bridgeVersion},credential.deviceCredential),deps);assert.equal(sessionResponse.status,200);
 const session=await sessionResponse.json();assert.equal(session.bootId,bootId);assert.ok(session.generation>0);
 const windowResponse=await handleDeviceHttp('live-window',request('live-window',{bootId,generation:session.generation,sequence:1},credential.deviceCredential),deps);assert.equal(windowResponse.status,200);
 const window=await windowResponse.json();
 const observation={source:'pc-command-center',instanceId:'pc-command-center',observedAt:at(-2),reportedAgeSeconds:2,state:'ready',diagnostic:'ok',metrics:{cpuPercent:12,memoryPercent:null,gpuUtilizationPercent:null,gpuMemoryUsedBytes:null,gpuMemoryTotalBytes:null,gpuTemperatureC:null,diskReadBytesPerSec:null,diskWriteBytesPerSec:null,networkSentBytesPerSec:null,networkReceivedBytesPerSec:null}};
 const heartbeat={schemaVersion:1,deviceId:issued.deviceId,bootId,generation:session.generation,sequence:1,sentAt:clock,bridgeVersion,observations:[observation]};
 const envelope={schemaVersion:1,delivery:'live',liveWindowId:window.windowId,heartbeat},beforeIngest=await readCurrent(db,owner,clock);
 const received=await handleDeviceHttp('heartbeat',request('heartbeat',envelope,credential.deviceCredential),deps);assert.equal(received.status,200);
 const receipt=await received.json();assert.equal(receipt.classification,'live');assert.equal(receipt.heartbeatHash,await contentHash(canonical(heartbeat)));assert.equal(receipt.receivedAt,base);
 assert.deepEqual(await readCurrent(db,owner,clock),beforeIngest);assert.equal(await count('device_heartbeats'),1);assert.equal(await count('runtime_observations'),1);
 clock=at(5);
 const duplicate=await handleDeviceHttp('heartbeat',request('heartbeat',{...envelope,delivery:'history',liveWindowId:null},credential.deviceCredential),deps);assert.equal(duplicate.status,200);assert.deepEqual(await duplicate.json(),receipt);assert.equal(await count('device_heartbeats'),1);
 const model=await readRuntime(db,owner,clock),source=model.devices[0].sources[0];
 assert.equal(model.ingress,'unverified');assert.equal(model.devices[0].connectivity,'online');assert.equal(model.devices[0].lastLiveReceivedAt,base);assert.equal(source.freshness.source,'fresh');assert.equal(source.observedAt,at(-2));assert.equal(source.receivedAt,base);assert.equal(source.lastSuccessfulSampleAt,at(-2));assert.equal(source.observation.metrics.memoryPercent,null);
 const proof=await readLatestRuntimeEvidence(db,owner,{deviceId:issued.deviceId,source:observation.source,instanceId:observation.instanceId});assert.ok(proof);assert.equal(proof.payloadHash,await contentHash(canonical(observation)));
 const selectedCommand={type:'runtime.evidence.select',deviceId:issued.deviceId,source:observation.source,instanceId:observation.instanceId,expectedPayloadHash:proof.payloadHash,expectedHeartbeatHash:receipt.heartbeatHash};
 const selected=await execute(selectedCommand);assert.equal(selected.result.status,'committed');assert.equal(await count('runtime_evidence'),1);
 assert.equal((await execute(selectedCommand,owner,selected.request)).result.status,'replayed');assert.equal(await count('runtime_evidence'),1);
 const frozen=JSON.parse((await ownerReader(db,owner).list('runtime_evidence'))[0].payload_json);assert.equal(frozen.origin,'native-device');assert.deepEqual(frozen.observation,observation);assert.equal(frozen.heartbeatRef.hash,receipt.heartbeatHash);
 const beforeWrongProof=await readCurrent(db,owner,clock);await assert.rejects(execute({...selectedCommand,expectedHeartbeatHash:'f'.repeat(64)}));assert.deepEqual(await readCurrent(db,owner,clock),beforeWrongProof);assert.equal(await count('runtime_evidence'),1);
 const bundle=await exportWorkspaceBundle(db,owner,{now:()=>clock});assert.doesNotThrow(()=>parseWorkspaceBundle(bundle));
 assert.equal(bundle.modules.devices.records.length,1);assert.equal(bundle.modules.runtime_adapter_configurations.records.length,1);assert.equal(bundle.modules.runtime_evidence.records.length,1);
 for(const table of ['device_credentials','device_enrollments','device_sessions','device_live_windows','device_runtime','device_heartbeats','runtime_observations','runtime_latest','runtime_minute_aggregates'])assert.equal(bundle.modules[table],undefined);
 const portable=canonical(bundle);assert.equal(portable.includes(issued.secret),false);assert.equal(portable.includes(credential.deviceCredential),false);assert.equal(portable.includes(enrolledRow.secret_hash),false);assert.equal(portable.includes(credentialRow.token_hash),false);
 assert.equal(await count('acceptance_records'),0);
 // Cross-file regression: the actual CLI persists an uncertain live send,
 // then its actual transport delivers original queued bytes as null-window history.
 const spoolDirectory=await mkdtemp(join(tmpdir(),'control-room-runtime-d1-spool-'));
 let outbox;
 try{
  outbox=await Outbox.open({directory:spoolDirectory});
  let failLiveOnce=true,sampleCount=0;const delivered=[];
  const transport=createBridgeTransport({baseUrl:'https://synthetic-device.invalid',deviceCredential:credential.deviceCredential,maxAttempts:1,now:()=>Date.parse(clock),ingressAdapter:{async getHeaders(){return {headers:{'X-Synthetic-Fixture-Ingress':'runtime-d1'},expiresAt:at(1000)};}},fetchImpl:async(url,options)=>{
   const path=new URL(url).pathname,action=path.split('/').at(-1);assert.ok(['live-window','heartbeat'].includes(action));assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(new Headers(options.headers).has('Cookie'),false);assert.equal(new Headers(options.headers).get('X-Synthetic-Fixture-Ingress'),'runtime-d1');
   const payload=JSON.parse(options.body);
   if(action==='heartbeat'){
    if(payload.delivery==='live'&&failLiveOnce){failLiveOnce=false;throw new Error('Synthetic network loss before delivery.');}
    if(payload.delivery==='history'){clock=at(61);assert.equal(payload.liveWindowId,null);}
    delivered.push({delivery:payload.delivery,liveWindowId:payload.liveWindowId,heartbeatBytes:canonical(payload.heartbeat)});
   }
   const response=await handleDeviceHttp(action,new Request(url,options),deps);if(!response.ok){const diagnostic=await response.clone().json().catch(()=>({code:'unreadable-fixture-response'}));assert.fail('Synthetic HTTP '+action+' rejected: '+response.status+' '+JSON.stringify(diagnostic));}return response;
  }});
  const config={deviceId:issued.deviceId,bridgeVersion,pcCommandCenter:{enabled:true,instanceId:'pc-command-center',selectedGpuId:null}};
  const sample=async({instanceId,selectedGpuId,now})=>{assert.equal(instanceId,'pc-command-center');assert.equal(selectedGpuId,null);sampleCount++;return {...observation,observedAt:now(),reportedAgeSeconds:0,metrics:{...observation.metrics,cpuPercent:21+sampleCount}};};
  clock=at(20);
  await assert.rejects(runBridgeOnce({config,session,sequence:2,transport,outbox,sample,now:()=>clock}));
  assert.equal(outbox.status().records,1);assert.equal(await count('device_heartbeats'),1);
  assert.equal((await readRuntime(db,owner,clock)).devices[0].lastLiveReceivedAt,base);
  const queued=outbox.pending({now:clock,limit:240});assert.equal(queued.length,1);const originalQueuedBytes=queued[0].heartbeatBytes;assert.equal(JSON.parse(originalQueuedBytes).observations[0].observedAt,at(20));assert.ok(queued[0].liveWindowId);
  clock=at(60);
  const freshReceipt=await runBridgeOnce({config,session,sequence:3,transport,outbox,sample,now:()=>clock});assert.equal(freshReceipt.classification,'live');assert.equal(freshReceipt.receivedAt,at(60));
  assert.equal(outbox.status().records,0);assert.deepEqual(delivered.map(value=>value.delivery),['live','history']);assert.equal(delivered[1].liveWindowId,null);assert.equal(delivered[1].heartbeatBytes,originalQueuedBytes);
  const historicalReceipt=await db.prepare('SELECT payload_hash,payload_json,receipt_json,classification,received_at FROM device_heartbeats WHERE user_id=? AND device_id=? AND boot_id=? AND sequence=2').bind(owner,issued.deviceId,bootId).first();
  assert.ok(historicalReceipt);assert.equal(historicalReceipt.classification,'history');assert.equal(historicalReceipt.received_at,at(61));assert.equal(historicalReceipt.payload_json,originalQueuedBytes);assert.equal(historicalReceipt.payload_hash,await contentHash(originalQueuedBytes));assert.equal(JSON.parse(historicalReceipt.receipt_json).reason,'history_delivery');
  const afterReplay=await readRuntime(db,owner,clock);assert.equal(afterReplay.devices[0].lastLiveReceivedAt,at(60));assert.equal(afterReplay.devices[0].sources[0].receivedAt,at(60));assert.equal(afterReplay.devices[0].sources[0].observedAt,at(60));assert.equal(afterReplay.devices[0].sources[0].observation.metrics.cpuPercent,23);
  const untouchedWindow=await db.prepare('SELECT consumed_at FROM device_live_windows WHERE user_id=? AND device_id=? AND id=?').bind(owner,issued.deviceId,queued[0].liveWindowId).first();assert.equal(untouchedWindow.consumed_at,null);
  assert.deepEqual((await readCurrent(db,owner,clock)).workspace,planning);assert.deepEqual(JSON.parse((await ownerReader(db,owner).list('runtime_evidence'))[0].payload_json),frozen);
 }finally{outbox?.close();await rm(spoolDirectory,{recursive:true,force:true});}
 const deviceRow=await ownerReader(db,owner).get('devices',issued.deviceId);assert.ok(deviceRow);
 assert.equal((await execute({type:'devices.revoke',id:issued.deviceId,expectedRowRevision:deviceRow.row_revision})).result.status,'committed');
 assert.equal(await authenticateDevice(request('session',{},credential.deviceCredential),'telemetry:write',db,syntheticIngress,clock),null);assert.equal((await readRuntime(db,owner,clock)).devices[0].connectivity,'revoked');
 assert.equal((await handleDeviceHttp('heartbeat',request('heartbeat',envelope,credential.deviceCredential),deps)).status,401);
 assert.deepEqual(JSON.parse((await ownerReader(db,owner).list('runtime_evidence'))[0].payload_json),frozen);
 const secondInput={revision:(await readCurrent(db,owner,clock)).revision,mutationId:await issueMutationId(db,owner,clock),command:{type:'devices.enrollment.create',value:{label:command.value.label,deviceId:issued.deviceId,scopes:['telemetry:write']}}};
 const second=await createOwnerEnrollment(db,owner,secondInput,clock);assert.equal(second.status,200);assert.deepEqual(second.body.envelope.workspace,planning);
 const secondResponse=await handleDeviceHttp('enroll',request('enroll',{secret:second.body.result.secret,bridgeVersion}),deps);assert.equal(secondResponse.status,201);const secondCredential=await secondResponse.json();
 assert.equal(await authenticateDevice(request('session',{},credential.deviceCredential),'telemetry:write',db,syntheticIngress,clock),null);assert.ok(await authenticateDevice(request('session',{},secondCredential.deviceCredential),'telemetry:write',db,syntheticIngress,clock));
 const secondBoot=crypto.randomUUID(),newSessionResponse=await handleDeviceHttp('session',request('session',{bootId:secondBoot,bridgeVersion},secondCredential.deviceCredential),deps);assert.equal(newSessionResponse.status,200);const newSession=await newSessionResponse.json();assert.ok(newSession.generation>session.generation);
 // Device-wide cadence remains enforced across explicit re-enrollment.
 clock=at(72);
 const newWindow=await handleDeviceHttp('live-window',request('live-window',{bootId:secondBoot,generation:newSession.generation,sequence:1},secondCredential.deviceCredential),deps);assert.equal(newWindow.status,200,JSON.stringify(await newWindow.clone().json()));
 const disconnected=await readRuntime(db,owner,clock);assert.equal(disconnected.devices[0].lastLiveReceivedAt,null);assert.notEqual(disconnected.devices[0].sources[0].freshness.source,'fresh');
 // Reviewed restoration retains context but cannot resurrect private enrollment,
 // credentials, sessions, windows, latest projections or enabled adapters.
 const revision=(await readCurrent(db,owner,clock)).revision,staged=await stageImport(db,owner,new TextEncoder().encode(portable),clock);assert.equal(staged.diagnostics.length,0);assert.equal((await readCurrent(db,owner,clock)).revision,revision);
 const restore=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:revision,mutationId:await issueMutationId(db,owner,clock),command:{type:'workspace.import.commit',importId:staged.id,hash:staged.hash,targetRevision:revision,mode:'replace'}},{db,handlers:workspaceHandlers,now:()=>clock});assert.equal(restore.status,'committed');
 assert.deepEqual((await readCurrent(db,owner,clock)).workspace,bundle.planning);
 for(const table of ['device_credentials','device_enrollments','device_sessions','device_live_windows','device_runtime','device_heartbeats','runtime_observations','runtime_latest','runtime_minute_aggregates'])assert.equal(await count(table),0);
 const restored=await readRuntime(db,owner,clock);assert.equal(restored.ingress,'unverified');assert.equal(restored.devices[0].enrolled,false);assert.equal(restored.devices[0].connectivity,'never-seen');assert.equal(restored.devices[0].lastLiveReceivedAt,null);assert.equal(restored.configurations[0].value.manifest.enabled,false);assert.equal(restored.devices[0].sources[0].observation,null);
 const historical=JSON.parse((await ownerReader(db,owner).list('runtime_evidence'))[0].payload_json);assert.equal(historical.origin,'historical-import');assert.deepEqual(historical.observation,frozen.observation);assert.deepEqual(historical.heartbeatRef,frozen.heartbeatRef);
 assert.equal(await readLatestRuntimeEvidence(db,owner,{deviceId:issued.deviceId,source:observation.source,instanceId:observation.instanceId}),null);
 assert.equal(await authenticateDevice(request('session',{},secondCredential.deviceCredential),'telemetry:write',db,syntheticIngress,clock),null);
 assert.equal((await handleDeviceHttp('session',request('session',{bootId:crypto.randomUUID(),bridgeVersion},secondCredential.deviceCredential),deps)).status,401);
 const afterRestore=await readCurrent(db,owner,clock);await assert.rejects(execute(selectedCommand));assert.deepEqual(await readCurrent(db,owner,clock),afterRestore);
 assert.equal((await readRuntime(db,other,clock)).devices.length,0);assert.equal(await count('runtime_evidence',other),0);
 console.log(JSON.stringify({migrations:migrations.length,storage:'actual-miniflare-d1',ingress:'synthetic-fixture-only',enrollment:'one-time-no-secret-replay',heartbeat:'exact-synthetic-sample',heartbeatReplay:'once-original-clocks',cliSpoolReplay:'actual-cli-transport-http-d1-history-null-window',selectedEvidence:'immutable-context',reEnrollment:'old-authority-rejected',restore:'disconnected-historical-only',planning:'unchanged-by-device-commands',provider:'not-tested'}));
 console.log('PASS actual isolated Miniflare D1: shared owner enrollment/configuration/evidence/revocation, synthetic HTTP device protocol, redacted export and reviewed disconnected restore.');
}finally{await mf.dispose();}
