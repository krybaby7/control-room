// Actual isolated Miniflare D1/R2 and original HTTP handlers. Synthetic process,
// model identity and private ingress only; no provider or deployed ingress claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {artifactSeedFixture,artifactNow,artifactLater} from './fixtures/agent-artifact.ts';
import {handleAgentArtifactHttp,type AgentArtifactHttpAction} from '../lib/agents/artifact-http.ts';
import {createManualSitesIngress,MANUAL_SITES_ORIGIN,MANUAL_SITES_PROJECT} from '../lib/devices/private-ingress.ts';
import {authenticateDevice} from '../lib/devices/auth.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {agentJobResultSchema} from '../lib/agents/contracts.ts';
import {handleAgentHttp,type AgentHttpAction} from '../lib/agents/http.ts';
import {createAgentResultVerifier} from '../lib/agents/result-verifier.ts';
import {readCurrent,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {attachmentHash,createR2BlobStore,readReadyAttachment,type AttachmentBucket} from '../lib/attachments.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {openExecutionJournal} from '../bridge/executor/journal.mjs';
import {openExecutionArtifacts} from '../bridge/executor/artifacts.mjs';
import {createAgentExecutionTransport} from '../bridge/executor/transport.mjs';
import {createArtifactUploadTransport,openArtifactUploadJournal,uploadAttemptArtifacts} from '../bridge/executor/artifact-upload.mjs';
import {finishUploadedAttempt} from '../bridge/executor/completion.mjs';
const now=()=>artifactNow;

test('actual native D1/R2 upload and completion preserve exact mapped receipts across reply loss and restart',async()=>{
 const seed=await artifactSeedFixture(),directory=await mkdtemp(join(tmpdir(),'synthetic-executor-native-'));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic fixture only");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,r2Buckets:['BUCKET'],r2Persist:false,cf:false});
 let journal:Awaited<ReturnType<typeof openExecutionJournal>>|undefined,mappings:Awaited<ReturnType<typeof openArtifactUploadJournal>>|undefined;
 try{
  const nativeDb=await mf.getD1Database('DB'),nativeBucket=await mf.getR2Bucket('BUCKET'),bucket=nativeBucket as unknown as AttachmentBucket;
  let raceArtifactId:string|null=null;
  const nativeStatements=new WeakMap<SqlStatement,ReturnType<typeof nativeDb.prepare>>(),sqlByStatement=new WeakMap<SqlStatement,string>();
  const db:SqlDatabase={prepare(sql){let native=nativeDb.prepare(sql);const statement:SqlStatement={bind(...values){native=native.bind(...values);nativeStatements.set(statement,native);return statement;},first<T>(){return native.first<T>();},all<T>(){return native.all<T>();},run(){return native.run();}};nativeStatements.set(statement,native);sqlByStatement.set(statement,sql);return statement;},async batch(statements){if(raceArtifactId&&statements.some(statement=>/INSERT INTO agent_results/u.test(sqlByStatement.get(statement)??''))){await nativeDb.prepare('UPDATE attachments SET row_revision=row_revision+1 WHERE user_id=? AND id=?').bind(seed.owner,raceArtifactId).run();raceArtifactId=null;}return nativeDb.batch(statements.map(statement=>nativeStatements.get(statement)!));}};
  const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();assert.equal(migrations.length,28);
  for(const name of migrations){const source=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');for(const sql of source.split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();}
  for(const table of ['workspaces','workspace_source_namespaces','workspace_execution_state','devices','device_runtime','device_credentials','agent_capabilities','workspace_job_intents','agent_jobs','agent_job_state','job_approvals','agent_budgets']){
   for(const row of seed.sqlite.prepare('SELECT * FROM '+table).all()){assert.equal(row.user_id,seed.owner);const keys=Object.keys(row);await db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(key=>{const value=row[key];assert.ok(value===null||typeof value==='string'||typeof value==='number');return value;})).run();}
  }
  const before=await readCurrent(db,seed.owner,artifactNow),dropped=new Set<string>(),seen=new Map<string,string[]>();let raceNextCompletion=false;
  const deps={db,bucket,ingress:seed.ingress,now},verifyResult=createAgentResultVerifier({db,bucket,now});
  const fetchImpl=async(input:RequestInfo|URL,init?:RequestInit)=>{
   const request=new Request(input,init),path=new URL(request.url).pathname,body=request.method==='POST'?await request.clone().text():'[binary]';seen.set(path,[...(seen.get(path)??[]),body]);
   let reply:Response;
   if(path.startsWith('/api/bridge/jobs/artifacts/')){const tail=path.slice('/api/bridge/jobs/artifacts/'.length),content=/^([^/]+)\/content$/u.exec(tail);reply=await handleAgentArtifactHttp(content?'content':tail as AgentArtifactHttpAction,request,deps,content?.[1]);}
   else{if(path.endsWith('/complete')&&raceNextCompletion){const mapped=JSON.parse(body);raceArtifactId=mapped.result.artifactIds[0];raceNextCompletion=false;}reply=await handleAgentHttp(path.slice('/api/bridge/jobs/'.length) as AgentHttpAction,request,{db,ingress:seed.ingress,now,context:seed.context,verifyResult});}
   const lossy=['/reserve','/finalize','/events','/complete'].some(suffix=>path.endsWith(suffix));
   if(reply.ok&&lossy&&!dropped.has(path)){dropped.add(path);await reply.arrayBuffer();throw new Error('Synthetic response loss after actual commit');}
   return reply;
  };
  const ingressAdapter={async getHeaders(){return {headers:{'x-synthetic-private-ingress':'fixture-only'},expiresAt:'2099-01-01T00:00:00.000Z'};}};
  const config={enabled:true,baseUrl:'https://synthetic.invalid',deviceCredential:seed.deviceSecret,ingressAdapter,fetchImpl,now:()=>Date.parse(artifactNow)};
  const transport=createAgentExecutionTransport(config as never),artifactTransport=createArtifactUploadTransport(config as never),journalNonce='synthetic_native_executor_upload_nonce_000001';
  const claim=await transport.claim({jobId:seed.jobId,journalNonce});assert.ok(claim);
  const ownerContextHash=claim.frozenAdmission.ownerContextHash;
  const identity={jobId:claim.jobId,attemptId:claim.attemptId,deviceId:seed.principal.deviceId,epoch:claim.executionEpoch,specSha256:claim.record.specSha256},credentials={attemptId:claim.attemptId,leaseToken:claim.leaseToken};
  journal=await openExecutionJournal({directory,identity,verifyPrivateState:undefined});mappings=await openArtifactUploadJournal({directory,identity,ownerContextHash,verifyPrivateState:undefined});
  const processIdentity={pid:999,startedAt:artifactNow,supervisorId:'synthetic-no-process',ownershipSha256:'f'.repeat(64)};
  for(const phase of ['claimed','workspace_ready','launch_intent','process_started','process_exited'])await journal.append({kind:'phase',value:{phase,workspaceKey:phase==='claimed'?null:'synthetic-workspace',processIdentity:['process_started','process_exited'].includes(phase)?processIdentity:null,nextEventSequence:1}});
  const event=async(kind:string,details:unknown)=>journal!.append({kind:'event',value:{schemaVersion:1,attemptId:identity.attemptId,epoch:identity.epoch,sequence:journal!.snapshot().nextEventSequence,kind,observedAt:artifactNow,diagnostic:'ok',details}});
  await event('accepted',{specSha256:identity.specSha256,capabilitySha256:claim.executionBinding.capabilitySha256});
  await event('started',{runtimePackageSha256:claim.executionBinding.runtime.packageSha256,toolPolicySha256:claim.executionBinding.runtime.toolPolicySha256,requestedModel:claim.record.spec.requestedModel,observedModel:null});
  await event('model_observed',{requestedModel:claim.record.spec.requestedModel,observedModel:claim.record.spec.requestedModel,observedModels:[claim.record.spec.requestedModel],modelVerified:true});
  await event('process_exit',{exitCode:0,processExitConfirmed:true,terminationUnconfirmed:false});
  const artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),verifyPrivateState:undefined}),bytes=Buffer.from(JSON.stringify({summary:'Synthetic isolated inspection',findings:[],limitations:['Synthetic fixture does not execute a provider.']}));
  const descriptor=await artifacts.put({id:'result-native-local',filename:'inspection.json',contentType:'application/json',data:bytes});await journal.append({kind:'artifact',value:descriptor});await event('artifact_ready',{artifactId:descriptor.id,sha256:descriptor.sha256,bytes:descriptor.bytes,type:descriptor.contentType});
  await journal.append({kind:'result',value:{attemptId:identity.attemptId,epoch:identity.epoch,disposition:'succeeded',requestedModel:claim.record.spec.requestedModel,observedModel:claim.record.spec.requestedModel,modelVerified:true,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[descriptor.id],usage:null,diagnostic:'ok'}});
  const reopen=async()=>{await journal!.close();await mappings!.close();journal=await openExecutionJournal({directory,identity,verifyPrivateState:undefined});mappings=await openArtifactUploadJournal({directory,identity,ownerContextHash,verifyPrivateState:undefined});};
  const upload=()=>uploadAttemptArtifacts({journal:journal!,artifacts,mappings:mappings!,transport:artifactTransport,credentials,ownerContextHash});
  await assert.rejects(upload(),/artifact_transport_uncertain/);await reopen();await assert.rejects(upload(),/artifact_transport_uncertain/);await reopen();const uploaded=await upload();
  const id=uploaded.remoteIds[0];assert.match(id,/^[a-f0-9-]{36}$/u);assert.notEqual(id,descriptor.id);
  const record=JSON.parse((await ownerReader(db,seed.owner).get('attachments',id))!.payload_json),namespace=await getWorkspaceNamespaces(db,seed.owner);assert.ok(namespace);assert.equal(record.status,'ready');
  const physical=await readReadyAttachment(seed.owner,record,createR2BlobStore(bucket),{ownerNamespace:namespace.blobNamespace,now:artifactNow});assert.deepEqual(Buffer.from(physical.bytes),bytes);assert.equal(physical.metadata.sha256,await attachmentHash(bytes));
  const localResult=agentJobResultSchema.parse(journal.snapshot().records.find((row:{entry:{kind:string}})=>row.entry.kind==='result')!.entry.value);
  const verifierInput={principal:seed.principal,record:claim.record,attemptId:identity.attemptId,result:{...localResult,artifactIds:[id]},executionBinding:claim.executionBinding};
  await nativeBucket.put(record.storageKey,Buffer.from('corrupt synthetic bytes'),{httpMetadata:{contentType:record.mimeType},customMetadata:{sha256:descriptor.sha256}});
  await assert.rejects(verifyResult(verifierInput));
  await nativeBucket.put(record.storageKey,bytes,{httpMetadata:{contentType:record.mimeType},customMetadata:{sha256:descriptor.sha256}});
  assert.equal((await verifyResult(verifierInput)).adapterChecksPassed,true);
  const lease={identity,reportEvents:(_transport:unknown,events:unknown)=>transport.events({...credentials,events})};
  const finish=()=>finishUploadedAttempt({journal:journal!,lease,transport,credentials,journalNonce,ownerContextHash,mapping:{journal:mappings!,directory},now});
  await assert.rejects(finish(),/agent_transport_uncertain/);await reopen();
  raceNextCompletion=true;await assert.rejects(finish(),/agent_conflict|agent_transport_uncertain/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_results WHERE user_id=?').bind(seed.owner).first<{n:number}>())!.n,0);assert.equal(journal.snapshot().phase,'process_exited');
  await nativeDb.prepare('UPDATE attachments SET row_revision=? WHERE user_id=? AND id=?').bind((await ownerReader(db,seed.owner).get('attachments',id))!.row_revision-1,seed.owner,id).run();
  await reopen();await assert.rejects(finish(),/agent_transport_uncertain/);await reopen();assert.equal((await finish()).status,'acknowledged');
  assert.equal(journal.snapshot().pending.length,0);assert.equal(journal.snapshot().phase,'acknowledged');
  const events=(await db.prepare('SELECT payload_json FROM job_events WHERE user_id=? AND attempt_id=? ORDER BY sequence').bind(seed.owner,identity.attemptId).all<{payload_json:string}>()).results.map(row=>JSON.parse(row.payload_json));
  assert.deepEqual(events.map(event=>event.kind),['accepted','started','model_observed','process_exit','artifact_ready','completed']);assert.equal(events[1].details.observedModel,null);assert.equal(events[2].details.observedModel,claim.record.spec.requestedModel);assert.equal(events[4].details.artifactId,id);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_artifacts WHERE user_id=?').bind(seed.owner).first<{n:number}>())!.n,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_results WHERE user_id=?').bind(seed.owner).first<{n:number}>())!.n,1);
  assert.deepEqual((await readCurrent(db,seed.owner,artifactNow)).workspace,before.workspace);
  for(const suffix of ['reserve','finalize','events','complete']){const bodies=seen.get('/api/bridge/jobs/'+(suffix==='reserve'||suffix==='finalize'?'artifacts/':'')+suffix)!;assert.equal(bodies.length,suffix==='complete'?3:2);assert.ok(bodies.every(body=>body===bodies[0]));}
 }finally{await journal?.close();await mappings?.close();seed.sqlite.close();await mf.dispose();await rm(directory,{recursive:true,force:true});}
});


test('actual native D1 owner cancellation returns stop-only renewal and needs exact acknowledged exit before terminal receipt',async()=>{
 const seed=await artifactSeedFixture(),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic cancellation fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,cf:false});
 try{
  const db=await mf.getD1Database('DB') as unknown as SqlDatabase;
  for(const name of (await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort())for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
  for(const table of ['workspaces','workspace_source_namespaces','workspace_execution_state','devices','device_runtime','device_credentials','agent_capabilities','workspace_job_intents','agent_jobs','agent_job_state','job_approvals','agent_budgets'])for(const row of seed.sqlite.prepare('SELECT * FROM '+table).all()){const keys=Object.keys(row);await db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(key=>{const value=row[key];assert.ok(value===null||typeof value==='string'||typeof value==='number');return value;})).run();}
  let time=artifactNow;const clock=()=>time,verifyResult=createAgentResultVerifier({db,now:clock});
  const fetchImpl=async(input:RequestInfo|URL,init?:RequestInit)=>{const request=new Request(input,init),action=new URL(request.url).pathname.slice('/api/bridge/jobs/'.length) as AgentHttpAction;return handleAgentHttp(action,request,{db,ingress:seed.ingress,now:clock,context:seed.context,verifyResult});};
  const transport=createAgentExecutionTransport({enabled:true,baseUrl:'https://synthetic.invalid',deviceCredential:seed.deviceSecret,ingressAdapter:{async getHeaders(){return {headers:{'x-synthetic-private-ingress':'fixture-only'},expiresAt:'2099-01-01T00:00:00.000Z'};}},fetchImpl,now:()=>Date.parse(time)} as never);
  const claim=await transport.claim({jobId:seed.jobId,journalNonce:'synthetic_native_cancel_journal_nonce_0001'});assert.ok(claim);assert.equal(claim.cancelRequest,null);
  const credentials={attemptId:claim.attemptId,leaseToken:claim.leaseToken},base={schemaVersion:1,attemptId:claim.attemptId,epoch:claim.executionEpoch,observedAt:artifactLater(1),diagnostic:'ok'};
  const events=[{...base,sequence:1,kind:'accepted',details:{specSha256:claim.record.specSha256,capabilitySha256:claim.executionBinding.capabilitySha256}},{...base,sequence:2,kind:'started',details:{runtimePackageSha256:claim.executionBinding.runtime.packageSha256,toolPolicySha256:claim.executionBinding.runtime.toolPolicySha256,requestedModel:claim.record.spec.requestedModel,observedModel:null}},{...base,sequence:3,kind:'model_observed',details:{requestedModel:claim.record.spec.requestedModel,observedModel:null,observedModels:[],modelVerified:false}}];
  time=artifactLater(1);await transport.events({...credentials,events});
  const before=await readCurrent(db,seed.owner,time),state=await db.prepare('SELECT operational_revision FROM agent_job_state WHERE user_id=? AND job_id=?').bind(seed.owner,seed.jobId).first<{operational_revision:number}>();assert.ok(state);
  const requestId='synthetic-native-owner-cancel-request-1';time=artifactLater(2);
  const cancellation=await executeWorkspaceCommand(seed.owner,{protocolVersion:1,expectedRevision:before.revision,mutationId:requestId,command:{type:'jobs.cancel',id:seed.jobId,expectedOperationalRevision:state.operational_revision}},{db,handlers:workspaceHandlers,now:clock});assert.equal(cancellation.status,'committed');
  const ownerRequest=await db.prepare('SELECT status,cancel_request_id,cancel_requested_at FROM agent_job_state WHERE user_id=? AND job_id=?').bind(seed.owner,seed.jobId).first<{status:string;cancel_request_id:string;cancel_requested_at:string}>();assert.deepEqual(ownerRequest,{status:'cancelling',cancel_request_id:requestId,cancel_requested_at:time});
  const attemptBeforeRenew=await db.prepare('SELECT operational_revision FROM job_attempts WHERE user_id=? AND id=?').bind(seed.owner,claim.attemptId).first<{operational_revision:number}>();assert.ok(attemptBeforeRenew);
  time=artifactLater(3);const renewed=await transport.renew(credentials);assert.ok(renewed);assert.deepEqual(renewed.cancelRequest,{requestId,requestedAt:artifactLater(2)});assert.equal(renewed.leaseExpiresAt,claim.leaseExpiresAt);assert.equal(renewed.deadlineAt,claim.deadlineAt);assert.equal(renewed.operationalRevision,attemptBeforeRenew.operational_revision+1);
  const exit={...base,observedAt:artifactLater(4),sequence:4,kind:'process_exit',details:{exitCode:null,processExitConfirmed:true,terminationUnconfirmed:false}},ack={...base,observedAt:artifactLater(4),sequence:5,kind:'cancel_acknowledged',diagnostic:'cancel_requested',details:{requestId,exitConfirmed:true}};
  time=artifactLater(4);await assert.rejects(transport.events({...credentials,events:[{...ack,sequence:4}]}),/agent_conflict/);await assert.rejects(transport.events({...credentials,events:[exit,{...ack,details:{requestId:'wrong-owner-request',exitConfirmed:true}}]}),/agent_conflict/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM job_events WHERE user_id=? AND attempt_id=?').bind(seed.owner,claim.attemptId).first<{n:number}>())!.n,3,'denied acknowledgements cannot partially commit exit evidence');
  const result=agentJobResultSchema.parse({attemptId:claim.attemptId,epoch:claim.executionEpoch,disposition:'cancelled',requestedModel:claim.record.spec.requestedModel,observedModel:null,modelVerified:false,terminalProtocolObserved:false,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[],usage:null,diagnostic:'cancel_requested'});
  await assert.rejects(transport.complete({...credentials,result}),/agent_conflict/);
  await transport.events({...credentials,events:[exit,ack,{...base,sequence:6,observedAt:artifactLater(4),kind:'blocked',diagnostic:'cancel_requested',details:{reason:'cancel_requested'}}]});
  time=artifactLater(5);const receipt=await transport.complete({...credentials,result});assert.deepEqual(await transport.complete({...credentials,result}),receipt);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_results WHERE user_id=?').bind(seed.owner).first<{n:number}>())!.n,1);
  assert.equal((await db.prepare('SELECT status FROM agent_job_state WHERE user_id=? AND job_id=?').bind(seed.owner,seed.jobId).first<{status:string}>())!.status,'cancelled');
  assert.equal((await db.prepare('SELECT released_at FROM agent_device_slots WHERE user_id=?').bind(seed.owner).first<{released_at:string}>())!.released_at,time);
  assert.equal((await db.prepare('SELECT reserved_seconds FROM agent_budgets WHERE user_id=?').bind(seed.owner).first<{reserved_seconds:number}>())!.reserved_seconds,0);
  const after=await readCurrent(db,seed.owner,time);assert.deepEqual(after.workspace,before.workspace);assert.equal(after.revision,before.revision+1,'only the authenticated owner cancellation mutates workspace revision');
 }finally{seed.sqlite.close();await mf.dispose();}
});


test('actual native D1 nonce recovery batches expired immutable evidence without reclaim or renewed launch authority',async()=>{
 let reportNow=artifactNow;const now=()=>reportNow;
 const seed=await artifactSeedFixture(),directory=await mkdtemp(join(tmpdir(),'synthetic-executor-native-'));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic fixture only");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,r2Buckets:['BUCKET'],r2Persist:false,cf:false});
 let journal:Awaited<ReturnType<typeof openExecutionJournal>>|undefined,mappings:Awaited<ReturnType<typeof openArtifactUploadJournal>>|undefined;
 try{
  const nativeDb=await mf.getD1Database('DB'),nativeBucket=await mf.getR2Bucket('BUCKET'),bucket=nativeBucket as unknown as AttachmentBucket;
  let raceArtifactId:string|null=null;
  const nativeStatements=new WeakMap<SqlStatement,ReturnType<typeof nativeDb.prepare>>(),sqlByStatement=new WeakMap<SqlStatement,string>();
  const db:SqlDatabase={prepare(sql){let native=nativeDb.prepare(sql);const statement:SqlStatement={bind(...values){native=native.bind(...values);nativeStatements.set(statement,native);return statement;},first<T>(){return native.first<T>();},all<T>(){return native.all<T>();},run(){return native.run();}};nativeStatements.set(statement,native);sqlByStatement.set(statement,sql);return statement;},async batch(statements){if(raceArtifactId&&statements.some(statement=>/INSERT INTO agent_results/u.test(sqlByStatement.get(statement)??''))){await nativeDb.prepare('UPDATE attachments SET row_revision=row_revision+1 WHERE user_id=? AND id=?').bind(seed.owner,raceArtifactId).run();raceArtifactId=null;}return nativeDb.batch(statements.map(statement=>nativeStatements.get(statement)!));}};
  const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();assert.equal(migrations.length,28);
  for(const name of migrations){const source=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');for(const sql of source.split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();}
  for(const table of ['workspaces','workspace_source_namespaces','workspace_execution_state','devices','device_runtime','device_credentials','agent_capabilities','workspace_job_intents','agent_jobs','agent_job_state','job_approvals','agent_budgets']){
   for(const row of seed.sqlite.prepare('SELECT * FROM '+table).all()){assert.equal(row.user_id,seed.owner);const keys=Object.keys(row);await db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(key=>{const value=row[key];assert.ok(value===null||typeof value==='string'||typeof value==='number');return value;})).run();}
  }
  const before=await readCurrent(db,seed.owner,artifactNow),dropped=new Set<string>(),seen=new Map<string,string[]>();let raceNextCompletion=false;
  const deps={db,bucket,ingress:seed.ingress,now},verifyResult=createAgentResultVerifier({db,bucket,now});
  const fetchImpl=async(input:RequestInfo|URL,init?:RequestInit)=>{
   const request=new Request(input,init),path=new URL(request.url).pathname,body=request.method==='POST'?await request.clone().text():'[binary]';seen.set(path,[...(seen.get(path)??[]),body]);
   let reply:Response;
   if(path.startsWith('/api/bridge/jobs/artifacts/')){const tail=path.slice('/api/bridge/jobs/artifacts/'.length),content=/^([^/]+)\/content$/u.exec(tail);reply=await handleAgentArtifactHttp(content?'content':tail as AgentArtifactHttpAction,request,deps,content?.[1]);}
   else{if(path.endsWith('/complete')&&raceNextCompletion){const mapped=JSON.parse(body);raceArtifactId=mapped.result.artifactIds[0];raceNextCompletion=false;}reply=await handleAgentHttp(path.slice('/api/bridge/jobs/'.length) as AgentHttpAction,request,{db,ingress:seed.ingress,now,context:seed.context,verifyResult});}
   const payload=body==='[binary]'?null:JSON.parse(body),lossKey=path.endsWith('/reconcile')?path+':'+(payload.events?'events-'+payload.events[0].sequence:'result'):path;
   const lossy=['/reserve','/finalize'].some(suffix=>path.endsWith(suffix))||path.endsWith('/reconcile')&&(!payload.events||payload.events[0].sequence===1);
   if(reply.ok&&lossy&&!dropped.has(lossKey)){dropped.add(lossKey);await reply.arrayBuffer();throw new Error('Synthetic response loss after actual commit');}
   return reply;
  };
  const ingressAdapter={async getHeaders(){return {headers:{'x-synthetic-private-ingress':'fixture-only'},expiresAt:'2099-01-01T00:00:00.000Z'};}};
  const config={enabled:true,baseUrl:'https://synthetic.invalid',deviceCredential:seed.deviceSecret,ingressAdapter,fetchImpl,now:()=>Date.parse(reportNow)};
  const transport=createAgentExecutionTransport(config as never),artifactTransport=createArtifactUploadTransport(config as never),journalNonce='synthetic_native_executor_upload_nonce_000001';
  const claim=await transport.claim({jobId:seed.jobId,journalNonce});assert.ok(claim);
  const ownerContextHash=claim.frozenAdmission.ownerContextHash;
  const identity={jobId:claim.jobId,attemptId:claim.attemptId,deviceId:seed.principal.deviceId,epoch:claim.executionEpoch,specSha256:claim.record.specSha256},credentials={attemptId:claim.attemptId,leaseToken:claim.leaseToken};
  journal=await openExecutionJournal({directory,identity,verifyPrivateState:undefined});mappings=await openArtifactUploadJournal({directory,identity,ownerContextHash,verifyPrivateState:undefined});
  const processIdentity={pid:999,startedAt:artifactNow,supervisorId:'synthetic-no-process',ownershipSha256:'f'.repeat(64)};
  for(const phase of ['claimed','workspace_ready','launch_intent','process_started','process_exited'])await journal.append({kind:'phase',value:{phase,workspaceKey:phase==='claimed'?null:'synthetic-workspace',processIdentity:['process_started','process_exited'].includes(phase)?processIdentity:null,nextEventSequence:1}});
  const event=async(kind:string,details:unknown)=>journal!.append({kind:'event',value:{schemaVersion:1,attemptId:identity.attemptId,epoch:identity.epoch,sequence:journal!.snapshot().nextEventSequence,kind,observedAt:artifactNow,diagnostic:'ok',details}});
  await event('accepted',{specSha256:identity.specSha256,capabilitySha256:claim.executionBinding.capabilitySha256});
  await event('started',{runtimePackageSha256:claim.executionBinding.runtime.packageSha256,toolPolicySha256:claim.executionBinding.runtime.toolPolicySha256,requestedModel:claim.record.spec.requestedModel,observedModel:null});
  for(let i=0;i<55;i++)await event('progress',{stage:'executing',completedUnits:i,totalUnits:55});
  await event('model_observed',{requestedModel:claim.record.spec.requestedModel,observedModel:claim.record.spec.requestedModel,observedModels:[claim.record.spec.requestedModel],modelVerified:true});
  await event('process_exit',{exitCode:0,processExitConfirmed:true,terminationUnconfirmed:false});
  const artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),verifyPrivateState:undefined}),bytes=Buffer.from(JSON.stringify({summary:'Synthetic isolated inspection',findings:[],limitations:['Synthetic fixture does not execute a provider.']}));
  const descriptor=await artifacts.put({id:'result-native-local',filename:'inspection.json',contentType:'application/json',data:bytes});await journal.append({kind:'artifact',value:descriptor});await event('artifact_ready',{artifactId:descriptor.id,sha256:descriptor.sha256,bytes:descriptor.bytes,type:descriptor.contentType});
  await journal.append({kind:'result',value:{attemptId:identity.attemptId,epoch:identity.epoch,disposition:'succeeded',requestedModel:claim.record.spec.requestedModel,observedModel:claim.record.spec.requestedModel,modelVerified:true,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[descriptor.id],usage:null,diagnostic:'ok'}});
  const reopen=async()=>{await journal!.close();await mappings!.close();journal=await openExecutionJournal({directory,identity,verifyPrivateState:undefined});mappings=await openArtifactUploadJournal({directory,identity,ownerContextHash,verifyPrivateState:undefined});};
  const upload=()=>uploadAttemptArtifacts({journal:journal!,artifacts,mappings:mappings!,transport:artifactTransport,credentials,ownerContextHash});
  await assert.rejects(upload(),/artifact_transport_uncertain/);await reopen();await assert.rejects(upload(),/artifact_transport_uncertain/);await reopen();const uploaded=await upload();
  const id=uploaded.remoteIds[0];assert.match(id,/^[a-f0-9-]{36}$/u);assert.notEqual(id,descriptor.id);
  const record=JSON.parse((await ownerReader(db,seed.owner).get('attachments',id))!.payload_json),namespace=await getWorkspaceNamespaces(db,seed.owner);assert.ok(namespace);assert.equal(record.status,'ready');
  const physical=await readReadyAttachment(seed.owner,record,createR2BlobStore(bucket),{ownerNamespace:namespace.blobNamespace,now:artifactNow});assert.deepEqual(Buffer.from(physical.bytes),bytes);assert.equal(physical.metadata.sha256,await attachmentHash(bytes));
  const localResult=agentJobResultSchema.parse(journal.snapshot().records.find((row:{entry:{kind:string}})=>row.entry.kind==='result')!.entry.value);
  const verifierInput={principal:seed.principal,record:claim.record,attemptId:identity.attemptId,result:{...localResult,artifactIds:[id]},executionBinding:claim.executionBinding};
  await nativeBucket.put(record.storageKey,Buffer.from('corrupt synthetic bytes'),{httpMetadata:{contentType:record.mimeType},customMetadata:{sha256:descriptor.sha256}});
  await assert.rejects(verifyResult(verifierInput));
  await nativeBucket.put(record.storageKey,bytes,{httpMetadata:{contentType:record.mimeType},customMetadata:{sha256:descriptor.sha256}});
  assert.equal((await verifyResult(verifierInput)).adapterChecksPassed,true);
  reportNow=artifactLater(121); // Original lease and hard deadline expired; reporting is evidence only.
  const attemptBefore=await db.prepare('SELECT lease_expires_at,deadline_at FROM job_attempts WHERE user_id=? AND id=?').bind(seed.owner,identity.attemptId).first<{lease_expires_at:string;deadline_at:string}>();assert.ok(attemptBefore);assert(Date.parse(attemptBefore.deadline_at)<Date.parse(reportNow));
  const first=journal.snapshot().records.find((row:{entry:{kind:string}})=>row.entry.kind==='event')!.entry.value;
  const invalidNonceTransport=createAgentExecutionTransport(config as never);await assert.rejects(invalidNonceTransport.reconcile({attemptId:identity.attemptId,journalNonce:'wrong_synthetic_recovery_nonce_000001',proof:'exited',events:[first]}),/agent_authentication_stopped/);
  const otherDevice='synthetic-other-device',otherSecret='synthetic_other_recovery_device_secret_000001',display={id:otherDevice,label:'Synthetic other recovery device',createdAt:artifactNow,archivedAt:null};
  await db.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?)').bind(seed.owner,otherDevice,canonical(display),await contentHash(canonical(display)),artifactNow).run();
  await db.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation) VALUES(?,?,1,0,0)').bind(seed.owner,otherDevice).run();
  await db.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').bind(seed.owner,'synthetic-other-recovery-credential',otherDevice,await contentHash(otherSecret),JSON.stringify(['jobs:poll','jobs:report']),artifactNow,artifactLater(3600)).run();
  const otherPrincipal=await authenticateDevice(new Request('https://synthetic.invalid/api/bridge/jobs/reconcile',{headers:{'x-control-room-device':otherSecret}}),'jobs:poll',db,seed.ingress,reportNow);assert.equal(otherPrincipal?.deviceId,otherDevice);
  const otherTransport=createAgentExecutionTransport({...config,deviceCredential:otherSecret} as never);
  await assert.rejects(otherTransport.reconcile({attemptId:identity.attemptId,journalNonce,proof:'exited',events:[first]}),/agent_authentication_stopped/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM job_events WHERE user_id=? AND attempt_id=?').bind(seed.owner,identity.attemptId).first<{n:number}>())!.n,0);
  const finish=()=>finishUploadedAttempt({mode:'reconcile',journal:journal!,transport,identity,ownerContextHash,journalNonce,mapping:{journal:mappings!,directory,verifyPrivateState:undefined},now} as never);
  await assert.rejects(finish(),/agent_transport_uncertain/);assert.equal((await db.prepare('SELECT COUNT(*) n FROM job_events WHERE user_id=? AND attempt_id=?').bind(seed.owner,identity.attemptId).first<{n:number}>())!.n,50);
  await reopen();await assert.rejects(finish(),/agent_transport_uncertain/);await reopen();assert.equal((await finish()).status,'acknowledged');
  assert.equal(journal.snapshot().pending.length,0);assert.equal(journal.snapshot().phase,'acknowledged');
  const recoveryBodies=seen.get('/api/bridge/jobs/reconcile')!.map(body=>JSON.parse(body)),batches=recoveryBodies.filter(body=>body.events&&body.journalNonce===journalNonce&&body.events.length>1);assert(batches.length>=3);assert(batches.every(body=>body.events.length<=50));assert.deepEqual(batches[0],batches[1]);
  const resultBodies=recoveryBodies.filter(body=>body.result);assert.equal(resultBodies.length,2);assert.deepEqual(resultBodies[0],resultBodies[1]);
  const receipt=await transport.reconcile(resultBodies[0]);assert.deepEqual(receipt.result,resultBodies[0].result);
  const events=(await db.prepare('SELECT payload_json FROM job_events WHERE user_id=? AND attempt_id=? ORDER BY sequence').bind(seed.owner,identity.attemptId).all<{payload_json:string}>()).results.map(row=>JSON.parse(row.payload_json));assert.equal(events.length,61);assert.equal(events.at(-1).kind,'completed');assert.equal(events.find(event=>event.kind==='artifact_ready').details.artifactId,id);
  const originalReceipts=await transport.reconcile({attemptId:identity.attemptId,journalNonce,proof:'exited',events:batches[0].events});assert.equal(originalReceipts.receipts.length,50);assert.equal(originalReceipts.lastAppliedSequence,61);
  await assert.rejects(transport.reconcile({attemptId:identity.attemptId,journalNonce,proof:'exited',events:[{...events[0],diagnostic:'unknown'}]}),/agent_conflict/);
  await assert.rejects(transport.reconcile({attemptId:identity.attemptId,journalNonce,proof:'exited',events:[{...events.at(-1),sequence:62}]}),/agent_conflict/);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_results WHERE user_id=?').bind(seed.owner).first<{n:number}>())!.n,1);assert.equal((await db.prepare('SELECT COUNT(*) n FROM job_events WHERE user_id=? AND attempt_id=?').bind(seed.owner,identity.attemptId).first<{n:number}>())!.n,61);
  assert.equal(seen.get('/api/bridge/jobs/claim')!.length,1);assert.equal(seen.has('/api/bridge/jobs/renew'),false);assert.equal(seen.has('/api/bridge/jobs/complete'),false);
  assert.deepEqual(await db.prepare('SELECT lease_expires_at,deadline_at FROM job_attempts WHERE user_id=? AND id=?').bind(seed.owner,identity.attemptId).first(),attemptBefore);
  const after=await readCurrent(db,seed.owner,reportNow);assert.deepEqual(after.workspace,before.workspace);assert.equal(after.revision,before.revision+2,'only original artifact reserve/finalize advanced the editor revision');
 }finally{await journal?.close();await mappings?.close();seed.sqlite.close();await mf.dispose();await rm(directory,{recursive:true,force:true});}
});


test('actual native D1/R2 finite opaque Sites ingress preserves device authentication and expires without domain writes',async()=>{
 const seed=await artifactSeedFixture(),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic opaque ingress fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,r2Buckets:['BUCKET'],r2Persist:false,cf:false});
 try{
  const db=await mf.getD1Database('DB') as unknown as SqlDatabase,bucket=await mf.getR2Bucket('BUCKET') as unknown as AttachmentBucket;
  for(const name of (await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort())for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
  for(const table of ['workspaces','workspace_source_namespaces','workspace_execution_state','devices','device_runtime','device_credentials','agent_capabilities','workspace_job_intents','agent_jobs','agent_job_state','job_approvals','agent_budgets'])for(const row of seed.sqlite.prepare('SELECT * FROM '+table).all()){const keys=Object.keys(row);await db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...keys.map(key=>{const value=row[key];assert.ok(value===null||typeof value==='string'||typeof value==='number');return value;})).run();}
  let time=artifactNow;const clock=()=>time,raw=JSON.stringify({mode:'manual-owner-private-sites',projectId:MANUAL_SITES_PROJECT,siteOrigin:MANUAL_SITES_ORIGIN,confirmedAt:artifactNow,releaseUntil:artifactLater(900)}),ingress=createManualSitesIngress(raw,clock),deps={db,bucket,ingress,now:clock,context:seed.context};
  const request=(action:string,value:unknown,credential:string|null=seed.deviceSecret)=>new Request(MANUAL_SITES_ORIGIN+'/api/bridge/jobs/'+action,{method:'POST',headers:{'content-type':'application/json',...(credential?{'x-control-room-device':credential}:{})},body:JSON.stringify(value)});
  const claimBody={jobId:seed.jobId,journalNonce:'synthetic_native_manual_sites_nonce_00001'};
  const verdict=await ingress.verify(request('claim',claimBody));assert.deepEqual(verdict,{kind:'manual-owner-private-sites'});assert.equal(Object.hasOwn(verdict!,'serviceIdentity'),false);
  const snapshot=async()=>canonical(await Promise.all(['workspaces','agent_capabilities','job_attempts','job_approvals','agent_job_state','agent_budgets','agent_device_slots','agent_artifacts','attachments','attachment_upload_attempts','attachment_blob_objects','workspace_job_intents','workspace_mutations'].map(async table=>({table,rows:(await db.prepare('SELECT * FROM '+table+' WHERE user_id=? ORDER BY rowid').bind(seed.owner).all()).results}))));
  const beforeDenied=await snapshot();for(const credential of [null,'wrong_synthetic_device_credential_00000001']){const denied=await handleAgentHttp('claim',request('claim',claimBody,credential),deps);assert.equal(denied.status,401);assert.deepEqual(await denied.json(),{error:'Agent request was rejected.',code:'agent_unauthorized'});}assert.equal(await snapshot(),beforeDenied);
  const capability=await handleAgentHttp('capabilities',request('capabilities',{capability:seed.capability,expectedOperationalRevision:1}),deps);assert.equal(capability.status,200);const capReceipt=await capability.json() as {sha256:string;operationalRevision:number};assert.equal(capReceipt.operationalRevision,2);assert.equal(capReceipt.sha256,await contentHash(canonical(seed.capability)));
  const claimed=await handleAgentHttp('claim',request('claim',claimBody),deps);assert.equal(claimed.status,200);const claim=await claimed.json() as {attemptId:string;leaseToken:string};assert.equal(typeof claim.attemptId,'string');assert.equal((await handleAgentHttp('claim',request('claim',claimBody),deps)).status,200);assert.equal((await db.prepare('SELECT COUNT(*) n FROM job_attempts WHERE user_id=?').bind(seed.owner).first<{n:number}>())!.n,1);
  // Re-read the last once-only claim response's token; same nonce rotates only this attempt.
  const resumed=await handleAgentHttp('claim',request('claim',claimBody),deps),current=await resumed.json() as typeof claim,credentials={attemptId:current.attemptId,leaseToken:current.leaseToken};
  const artifactPost=async(action:'mutation-id'|'reserve'|'finalize',value:unknown)=>{const response=await handleAgentArtifactHttp(action,request('artifacts/'+action,value),deps);assert.equal(response.status,200);return await response.json() as {revision:number;mutationId:string;artifact:{id:string}};};
  const bytes=new TextEncoder().encode('Synthetic finite ingress bytes; no runtime execution.\n'),issued=await artifactPost('mutation-id',credentials),reserved=await artifactPost('reserve',{...credentials,...issued,filename:'finite-window.txt',mimeType:'text/plain',expectedBytes:bytes.length,logicalType:'diagnostic',sha256:await attachmentHash(bytes)}),id=reserved.artifact.id;
  const content=new Request(MANUAL_SITES_ORIGIN+'/api/bridge/jobs/artifacts/'+id+'/content',{method:'PUT',headers:{'content-type':'text/plain','x-control-room-device':seed.deviceSecret,'x-control-room-attempt':current.attemptId,'x-control-room-lease':current.leaseToken},body:bytes as BodyInit});assert.equal((await handleAgentArtifactHttp('content',content,deps,id)).status,200);
  await artifactPost('finalize',{...credentials,...await artifactPost('mutation-id',credentials),id});const attachment=JSON.parse((await ownerReader(db,seed.owner).get('attachments',id))!.payload_json),namespace=(await getWorkspaceNamespaces(db,seed.owner))!;assert.deepEqual((await readReadyAttachment(seed.owner,attachment,createR2BlobStore(bucket),{ownerNamespace:namespace.blobNamespace,now:time})).bytes,bytes);
  const beforeExpiry=await snapshot();time=artifactLater(900);assert.equal(await ingress.verify(request('claim',claimBody)),null);
  const expired=await handleAgentHttp('renew',request('renew',credentials),deps);assert.equal(expired.status,401);assert.deepEqual(await expired.json(),{error:'Agent request was rejected.',code:'agent_unauthorized'});
  assert.equal((await handleAgentArtifactHttp('mutation-id',request('artifacts/mutation-id',credentials),deps)).status,401);assert.equal(await snapshot(),beforeExpiry);
  const after=await readCurrent(db,seed.owner,time),initial=await readCurrent(seed.db,seed.owner,artifactNow);assert.deepEqual(after.workspace,initial.workspace);assert.equal((await db.prepare('SELECT COUNT(*) n FROM job_attempts WHERE user_id=?').bind(seed.owner).first<{n:number}>())!.n,1);
 }finally{seed.sqlite.close();await mf.dispose();}
});
