import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentExecutionTransport,bindAuthenticatedAgentGrant} from '../executor/transport.mjs';
import {wireFixture} from './fixtures/executor-wire.mjs';
import {openExecutionJournal} from '../executor/journal.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {jobSpecSha256} from '../src/execution-policy.mjs';
const now=()=>Date.parse('2026-10-18T12:00:00.000Z'),ingressAdapter={async getHeaders(){return {headers:{'x-synthetic-private-ingress':'fixture-only'},expiresAt:'2026-10-18T12:05:00.000Z'};}},payload={jobId:'job-fixture',journalNonce:'a'.repeat(64)},deviceCredential='synthetic-assigned-device-credential';
const options={enabled:true,baseUrl:'https://synthetic.example.invalid',deviceCredential,ingressAdapter,now};
test('execution transport is disabled by default and uses exact separate jobs endpoint/headers when explicitly injected',async()=>{
 let calls=0;const disabled=createAgentExecutionTransport({...options,enabled:false,fetchImpl:async()=>{calls++;throw new Error('should not fetch');}});await assert.rejects(disabled.claim(payload),/local_execution_disabled/);assert.equal(calls,0);
 const transport=createAgentExecutionTransport({...options,fetchImpl:async(url,request)=>{calls++;assert.equal(url,'https://synthetic.example.invalid/api/bridge/jobs/claim');assert.equal(request.redirect,'error');assert.equal(request.credentials,'omit');assert.equal(request.cache,'no-store');assert.equal(request.headers.get('x-control-room-device'),deviceCredential);assert.equal(request.headers.get('cookie'),null);assert.deepEqual(JSON.parse(request.body),payload);return Response.json(null);}});assert.equal(await transport.claim(payload),null);assert.equal(calls,1);
});
test('private ingress remains unavailable by default and owner/cookie/header substitution is rejected',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return Response.json(null);};await assert.rejects(createAgentExecutionTransport({...options,ingressAdapter:undefined,fetchImpl}).claim(payload),/private_ingress_unavailable/);
 for(const key of ['cookie','x-control-room-device','x-owner-id','x-authenticated-user','host']){const ingressAdapter={async getHeaders(){return {headers:{[key]:'forged'},expiresAt:'2026-10-18T12:05:00.000Z'};}};await assert.rejects(createAgentExecutionTransport({...options,ingressAdapter,fetchImpl}).claim(payload),/unsafe_ingress_headers/);}assert.equal(calls,0);
});
test('redirects, custom authority fields, non-HTTPS origins and ambiguous requests do not fall back or automatically retry',async()=>{
 for(const baseUrl of ['http://synthetic.example.invalid','https://user:secret@synthetic.example.invalid','https://synthetic.example.invalid/path'])assert.throws(()=>createAgentExecutionTransport({...options,baseUrl}));
 let calls=0;const transport=createAgentExecutionTransport({...options,fetchImpl:async()=>{calls++;throw new Error('private network text');}});await assert.rejects(transport.claim({...payload,ownerId:'forged'}),/invalid_shape/);assert.equal(calls,0);await assert.rejects(transport.claim(payload),/agent_transport_uncertain/);assert.equal(calls,1);
});
test('bounded body/deadline reader rejects oversized, malformed and hung responses without raw body disclosure',async()=>{
 for(const response of [new Response('private invalid json',{headers:{'content-type':'application/json'}}),new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'text/plain'}})]){const transport=createAgentExecutionTransport({...options,fetchImpl:async()=>response});await assert.rejects(transport.claim(payload),error=>/invalid_agent_response|agent_response_bound/.test(error.message)&&!error.message.includes('private invalid'));}
 let cancelled=false;const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}}),transport=createAgentExecutionTransport({...options,requestMs:20,fetchImpl:async()=>new Response(body,{headers:{'content-type':'application/json'}})});await assert.rejects(transport.claim(payload),/agent_transport_uncertain/);assert.equal(cancelled,true);
});
test('401 and 403 stop authentication and never expose returned provider prose',async()=>{
 for(const status of [401,403]){let calls=0;const transport=createAgentExecutionTransport({...options,fetchImpl:async()=>{calls++;return new Response('private provider secret',{status});}});await assert.rejects(transport.claim(payload),error=>error.code==='agent_authentication_stopped'&&!error.message.includes('provider'));assert.equal(calls,1);}
});

const localFacts=async()=>({otherActiveAttempts:0,usedJobs:0,usedRuntimeSeconds:0,cancelRequested:false,localDisabled:false});
async function grantJournal(t,wire){const directory=await mkdtemp(join(tmpdir(),'executor-brand-fixture-'));const journal=await openExecutionJournal({directory,identity:{jobId:wire.jobId,attemptId:wire.attemptId,deviceId:wire.approvalEnvelope.approval.deviceId,epoch:wire.executionEpoch,specSha256:wire.record.specSha256}});t.after(async()=>{try{await journal.close();}finally{await rm(directory,{recursive:true,force:true});}});return journal;}
test('only exact fixed private transport grants bind native context; JSON copies/flags cannot mint provenance',async t=>{
 const {wire,options:fixture}=wireFixture(),journal=await grantJournal(t,wire);let monotonic=1000;
 const transport=createAgentExecutionTransport({...options,monotonic:()=>monotonic+=100,fetchImpl:async()=>Response.json(wire)}),grant=await transport.claim(payload),local={policy:fixture.admission.policy,capability:fixture.admission.capability,journal,readLocalState:localFacts};
 for(const raw of [wire,JSON.parse(JSON.stringify(grant)),{...grant,transportTrusted:true}])await assert.rejects(bindAuthenticatedAgentGrant(raw,local),/authenticated_agent_grant_required/);
 const lease=await bindAuthenticatedAgentGrant(grant,local);assert.equal(lease.mayLaunch,true);assert.equal(journal.snapshot().phase,'claimed');assert.equal(lease.identity.epoch,wire.executionEpoch);assert.throws(()=>lease.consumeLaunch(1400),/durable_launch_intent_required/);assert.equal(Object.hasOwn(lease.snapshot(),'leaseToken'),false);await assert.rejects(bindAuthenticatedAgentGrant(grant,local),/authenticated_agent_grant_required/);await assert.rejects(lease.renew({renew:async()=>wire}),/authenticated_agent_transport_required/);assert.throws(()=>lease.reportEvents({events:async()=>({})},[]),/authenticated_agent_transport_required/);
});
test('an authenticated grant still cannot bypass current local configuration, exact capability or cancellation',async t=>{
 for(const variant of ['disabled','capability','cancelled']){const {wire,options:fixture}=wireFixture(),journal=await grantJournal(t,wire);let tick=1000;const transport=createAgentExecutionTransport({...options,monotonic:()=>tick+=100,fetchImpl:async()=>Response.json(wire)}),grant=await transport.claim(payload),policy=structuredClone(fixture.admission.policy),capability=structuredClone(fixture.admission.capability);if(variant==='disabled')policy.enabled=false;if(variant==='capability')capability.runtime.executableSha256='e'.repeat(64);await assert.rejects(bindAuthenticatedAgentGrant(grant,{policy,capability,journal,readLocalState:async()=>({...await localFacts(),cancelRequested:variant==='cancelled'})}),/admission_blocked/);assert.equal(journal.snapshot().phase,null);}
});
test('renewal uses a newly branded immutable grant and preserves original server deadline',async t=>{
 const {wire,options:fixture}=wireFixture(),journal=await grantJournal(t,wire);let tick=1000,calls=0;const transport=createAgentExecutionTransport({...options,monotonic:()=>tick+=100,fetchImpl:async(url)=>{calls++;return Response.json(url.endsWith('/renew')?{...wire,serverNow:'2026-10-18T12:00:15.000Z',leaseExpiresAt:wire.deadlineAt,operationalRevision:2,resumed:true}:wire);}}),grant=await transport.claim(payload),lease=await bindAuthenticatedAgentGrant(grant,{policy:fixture.admission.policy,capability:fixture.admission.capability,journal,readLocalState:localFacts});tick=16100;await lease.renew(transport);assert.equal(calls,2);assert.equal(lease.snapshot().operationalRevision,2);assert.ok(lease.snapshot().deadlineMonotonicMs<=61200);
});
test('valid256-node128-character dependency manifest above64KiB survives the fixed512KiB lease response cap',async t=>{
 const {wire,options:fixture}=wireFixture(),ids=Array.from({length:255},(_,i)=>('n'+String(i).padStart(3,'0')).padEnd(128,'x')),rows=ids.map((id,i)=>({id,ownerKey:wire.frozenAdmission.ownerContextHash,dependsOnJobIds:ids.slice(i+1,i+9),status:'succeeded'}));
 wire.record.spec.dependsOnJobIds=ids.slice(0,8);wire.record.specSha256=jobSpecSha256(wire.record.spec);wire.approvalEnvelope.approval.specSha256=wire.record.specSha256;wire.frozenAdmission.dependencyRows=[{id:wire.jobId,ownerKey:wire.frozenAdmission.ownerContextHash,dependsOnJobIds:ids.slice(0,8),status:'queued'},...rows];assert.ok(Buffer.byteLength(JSON.stringify(wire.frozenAdmission))>65536);assert.ok(Buffer.byteLength(JSON.stringify(wire.frozenAdmission))<=393216);
 const journal=await grantJournal(t,wire);let tick=1000;const transport=createAgentExecutionTransport({...options,monotonic:()=>tick+=100,fetchImpl:async()=>Response.json(wire)}),grant=await transport.claim(payload),lease=await bindAuthenticatedAgentGrant(grant,{policy:fixture.admission.policy,capability:fixture.admission.capability,journal,readLocalState:localFacts});assert.equal(lease.mayLaunch,true);assert.equal(grant.frozenAdmission.dependencyRows.length,256);
});
test('lease response512KiB and ordinary response64KiB limits are fixed independently from64KiB request cap',async()=>{
 const oversized=JSON.stringify({padding:'x'.repeat(524288)}),leaseTransport=createAgentExecutionTransport({...options,fetchImpl:async()=>new Response(oversized,{headers:{'content-type':'application/json'}})});await assert.rejects(leaseTransport.claim(payload),/agent_response_bound/);
 const eventsTransport=createAgentExecutionTransport({...options,fetchImpl:async()=>Response.json({padding:'x'.repeat(65536)})});await assert.rejects(eventsTransport.events({attemptId:'attempt-fixture',leaseToken:'f'.repeat(64),events:[{schemaVersion:1}]}),/agent_response_bound/);await assert.rejects(leaseTransport.claim({...payload,journalNonce:'x'.repeat(65536)}),/invalid_journal_nonce/);
});

test('authenticated resumed grant after capability TTL keeps exact pins/local stops and cannot relaunch',async t=>{
 const {wire,options:fixture}=wireFixture(600);wire.resumed=true;wire.serverNow='2026-10-18T12:05:01.000Z';wire.leaseExpiresAt='2026-10-18T12:06:01.000Z';const journal=await grantJournal(t,wire);let tick=301000;const transport=createAgentExecutionTransport({...options,monotonic:()=>tick+=100,fetchImpl:async()=>Response.json(wire)}),grant=await transport.claim(payload),lease=await bindAuthenticatedAgentGrant(grant,{policy:fixture.admission.policy,capability:fixture.admission.capability,journal,readLocalState:localFacts});assert.equal(lease.mayLaunch,false);assert.ok(lease.snapshot().deadlineMonotonicMs<=600200);assert.throws(()=>lease.consumeLaunch(301400),/durable_launch_intent_required/);lease.requestStop('cancel_requested');assert.throws(()=>lease.assertCurrent(301500),/cancel_requested/);
});
