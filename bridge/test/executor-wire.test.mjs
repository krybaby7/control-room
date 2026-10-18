import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {wireFixture} from './fixtures/executor-wire.mjs';
import {parseAgentLease,bindAgentLease,flushJournalEvents} from '../executor/wire.mjs';
import {openExecutionJournal} from '../executor/journal.mjs';
import {sha} from '../executor/codec.mjs';
test('actual server lease field mapping binds frozen approval/task bytes and original hard deadline',()=>{
 const {wire,options}=wireFixture(),lease=bindAgentLease(wire,options);assert.equal(lease.identity.epoch,wire.executionEpoch);assert.equal(lease.mayLaunch,true);assert.equal(lease.taskInput.title,wire.taskInput.title);assert.throws(()=>{lease.taskInput.title='changed';},TypeError);assert.throws(()=>{lease.binding.runtime.version='changed';},TypeError);assert.equal(JSON.stringify(lease.snapshot()).includes(wire.leaseToken),false);assert.throws(()=>lease.assertCurrent(61000),/lease_expired/);
 const resumed=wireFixture();resumed.wire.resumed=true;assert.equal(bindAgentLease(resumed.wire,resumed.options).mayLaunch,false);
});
test('missing wire proof, task mutation, oversized combined context and historical record never become runnable',()=>{
 for(const mutate of [w=>{delete w.approvalEnvelope;},w=>{w.taskInput.title='changed';},w=>{w.record.historical=true;},w=>{w.executionEpoch=4;},w=>{w.deadlineAt='2026-10-18T13:00:00.000Z';}]){const {wire,options}=wireFixture();mutate(wire);assert.throws(()=>bindAgentLease(wire,options));}
 const {wire}=wireFixture();wire.taskInput.notes='x'.repeat(32768);assert.throws(()=>parseAgentLease(wire),/task_input_bound/);
 const bounded=wireFixture();bounded.wire.executionBinding.budget.inputBytesLimit=128;bounded.wire.approvalEnvelope.bindingSha256=sha(bounded.wire.executionBinding);assert.throws(()=>parseAgentLease(bounded.wire),/task_and_artifact_input_bound/);
});
test('15-second renewal cadence checks exact frozen context and cannot move original deadline',async()=>{
 const {wire,options}=wireFixture(),lease=bindAgentLease(wire,options);assert.equal(lease.needsRenew(16099),false);assert.equal(lease.needsRenew(16100),true);const ticks=[16100,16200];let requests=0;
 await lease.renew({async renew(body){requests++;assert.deepEqual(body,{attemptId:wire.attemptId,leaseToken:wire.leaseToken});return {...wire,serverNow:'2026-10-18T12:00:15.000Z',leaseExpiresAt:wire.deadlineAt,operationalRevision:2,resumed:true};}},()=>ticks.shift());assert.equal(requests,1);assert.equal(lease.needsRenew(31199),false);assert.equal(lease.needsRenew(31200),true);assert.throws(()=>lease.assertCurrent(61000),/lease_expired/);
});
test('ambiguous renewal or mutated frozen task stops locally without inventing process exit or cancellation',async()=>{
 for(const renew of [async()=>{throw new Error('private remote text');},async()=>{const {wire}=wireFixture();return {...wire,operationalRevision:2,resumed:true,taskInput:{...wire.taskInput,title:'new'}};}]){const {wire,options}=wireFixture(),lease=bindAgentLease(wire,options);let tick=16100;await assert.rejects(lease.renew({renew},()=>tick+=100),/lease_renewal_uncertain/);assert.throws(()=>lease.assertCurrent(17000),/lease_renewal_uncertain/);assert.equal(lease.snapshot().mayLaunch,false);assert.equal(Object.hasOwn(lease.snapshot(),'processExitConfirmed'),false);}
});
test('lost event response retries identical pending bytes; only exact epoch/hash receipts acknowledge',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-wire-fixture-'));const {wire,options}=wireFixture(),lease=bindAgentLease(wire,options),journal=await openExecutionJournal({directory,identity:lease.identity});t.after(async()=>{try{await journal.close();}finally{await rm(directory,{recursive:true,force:true});}});await journal.append({kind:'phase',value:{phase:'claimed',workspaceKey:null,processIdentity:null,nextEventSequence:1}});
 const event={schemaVersion:1,attemptId:wire.attemptId,epoch:wire.executionEpoch,sequence:1,kind:'accepted',observedAt:wire.serverNow,diagnostic:'ok',details:{specSha256:wire.record.specSha256,capabilitySha256:wire.executionBinding.capabilitySha256}};await journal.append({kind:'event',value:event});
 const bodies=[];await assert.rejects(flushJournalEvents({journal,lease,transport:{async events(body){bodies.push(structuredClone(body));throw new Error('lost response after real receipt fixture');}}}));assert.equal(journal.snapshot().pending.length,1);
 const receipt={attemptId:wire.attemptId,epoch:wire.executionEpoch,sequence:1,payloadSha256:sha(event),receivedAt:wire.serverNow};
 await assert.rejects(flushJournalEvents({journal,lease,transport:{async events(){return {receipts:[{...receipt,epoch:4}],lastAppliedSequence:1};}}}),/receipt_identity_differs/);assert.equal(journal.snapshot().pending.length,1);
 const result=await flushJournalEvents({journal,lease,transport:{async events(body){bodies.push(structuredClone(body));return {receipts:[receipt],lastAppliedSequence:1};}}});assert.equal(result.sent,1);assert.deepEqual(bodies[0],bodies[1]);assert.equal(journal.snapshot().pending.length,0);assert.equal((await flushJournalEvents({journal,lease,transport:{events(){throw new Error('should not send');}}})).sent,0);
});

test('one launch permission is consumed once and sticky cancellation never restores it',()=>{
 const {wire,options}=wireFixture(),lease=bindAgentLease(wire,options);lease.consumeLaunch(1200);assert.equal(lease.mayLaunch,false);assert.throws(()=>lease.consumeLaunch(1300),/launch_not_admissible/);const second=wireFixture(),cancelled=bindAgentLease(second.wire,second.options);cancelled.requestStop('cancel_requested');assert.equal(cancelled.mayLaunch,false);assert.throws(()=>cancelled.consumeLaunch(1200),/cancel_requested/);
});

test('frozen admission refuses foreign/duplicate/dependency and artifact claims with no invented native authority',()=>{
 for(const mutate of [w=>{w.frozenAdmission.dependencyRows[0].ownerKey='b'.repeat(64);},w=>{w.frozenAdmission.dependencyRows.push({...w.frozenAdmission.dependencyRows[0]});},w=>{w.frozenAdmission.dependencyRows[0].status='running';},w=>{w.frozenAdmission.activeAttemptsBefore=1;},w=>{w.frozenAdmission.approvalConsumedBefore=true;},w=>{w.frozenAdmission.artifactRefs=[{id:'other',sha256:'a'.repeat(64),bytes:1}];}]){const {wire}=wireFixture();mutate(wire);assert.throws(()=>parseAgentLease(wire));}
 const {wire}=wireFixture();wire.taskInput.acceptanceInputs={};wire.taskInput.acceptanceInputs.loop=wire.taskInput.acceptanceInputs;assert.throws(()=>parseAgentLease(wire),/invalid_task_input/);
});
