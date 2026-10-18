import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/executor.mjs';
import {sha} from '../executor/codec.mjs';
import {parseExecutionBinding,admitExecutionLease,recoveryDisposition} from '../executor/lease.mjs';
function input(){
 const admission=fixture(),spec=admission.spec;
 const binding={schemaVersion:1,provider:'codex',requestedModel:spec.requestedModel,effort:spec.effort,runtime:admission.policy.runtime,capabilitySha256:admission.approval.capabilitySha256,configurationSha256:admission.approval.configurationSha256,allowedPathsSha256:admission.capability.allowedPathsSha256ByRepositoryKey.fixture,artifactRefs:[{id:'input-fixture',sha256:'c'.repeat(64),bytes:128}],effects:['repository.read','report.write'],budget:{jobs:1,timeoutSeconds:60,outputBytesLimit:4096,inputBytesLimit:128,payment:'subscription-only',costDollars:null},modelIdentityPolicy:'require-observed'};
 return {lease:{jobId:'job-fixture',attemptId:'attempt-fixture',deviceId:'device-fixture',epoch:3,leaseToken:'synthetic-private-token-not-real-0000000000',expiresAt:'2026-10-18T12:01:00.000Z',spec,specSha256:admission.specSha256,approvalId:admission.approval.id},envelope:{approval:admission.approval,executionBinding:binding,bindingSha256:sha(binding),reservationId:'reservation-fixture',approverId:'owner-fixture'},expectedBindingSha256:sha(binding),admission,timing:{serverNow:admission.now,sentMonotonicMs:1000,receivedMonotonicMs:1100}};
}
test('exact separate binding plus old verdict is mandatory and token is never public',()=>{
 const raw=input(),lease=admitExecutionLease(raw);assert.equal(lease.remaining(1200),59800);assert.equal(JSON.stringify(lease.snapshot()).includes(raw.lease.leaseToken),false);
 assert.throws(()=>admitExecutionLease({...raw,expectedBindingSha256:'d'.repeat(64)}),/binding_differs/);
 const disabled=input();disabled.admission.policy.enabled=false;assert.throws(()=>admitExecutionLease(disabled),/admission_blocked/);
});
test('forged full runtime/provider/model/input/effect pins fail even if envelope self-hash is recomputed',()=>{
 for(const mutate of [b=>{b.provider='claude';},b=>{b.runtime.executableSha256='e'.repeat(64);},b=>{b.requestedModel='other';},b=>{b.artifactRefs[0].sha256='e'.repeat(64);},b=>{b.effects.push('patch.write');},b=>{b.allowedPathsSha256='e'.repeat(64);}]){const raw=input();raw.envelope.executionBinding=structuredClone(raw.envelope.executionBinding);mutate(raw.envelope.executionBinding);raw.envelope.bindingSha256=sha(raw.envelope.executionBinding);raw.expectedBindingSha256=raw.envelope.bindingSha256;assert.throws(()=>admitExecutionLease(raw),/differs/);}
});
test('monotonic lease expiry cannot be extended by wall-clock rollback or a changed attempt',()=>{
 const raw=input(),lease=admitExecutionLease(raw);assert.throws(()=>lease.renew({...raw.lease,attemptId:'other'},{serverNow:raw.admission.now,sentMonotonicMs:2000,receivedMonotonicMs:2100}),/renewal_identity_differs/);assert.throws(()=>lease.assertCurrent(61100),/lease_expired/);assert.throws(()=>lease.renew(raw.lease,{serverNow:raw.admission.now,sentMonotonicMs:62000,receivedMonotonicMs:62100}),/lease_expired/);
 const backwards=admitExecutionLease(input());assert.throws(()=>backwards.assertCurrent(1000),/monotonic_clock_invalid/);assert.throws(()=>backwards.assertCurrent(1200),/monotonic_clock_invalid/);
});
test('renewal never extends original finite job budget; cancel/revocation is sticky',()=>{
 const raw=input(),lease=admitExecutionLease(raw);lease.renew({...raw.lease,expiresAt:'2026-10-18T12:01:30.000Z'},{serverNow:'2026-10-18T12:00:30.000Z',sentMonotonicMs:30000,receivedMonotonicMs:30100});assert.throws(()=>lease.assertCurrent(61100),/lease_expired/);
 const cancelled=admitExecutionLease(input());cancelled.requestStop('cancel_requested');assert.throws(()=>cancelled.assertCurrent(1200),/cancel_requested/);
});
test('untrusted timing, expired lease, extra schema fields and historical authority fail closed',()=>{
 const raw=input();assert.throws(()=>admitExecutionLease({...raw,timing:{...raw.timing,receivedMonotonicMs:20000}}),/timing/);assert.throws(()=>admitExecutionLease({...raw,lease:{...raw.lease,expiresAt:raw.admission.now}}),/lease_expired/);assert.throws(()=>parseExecutionBinding({...raw.envelope.executionBinding,command:'ignored'}),/invalid_shape/);const historical=input();historical.envelope.approval.origin='historical-import';assert.throws(()=>admitExecutionLease(historical),/admission_blocked/);
});
test('recovery offers upload-only or owner reconciliation and never auto relaunches',()=>{
 for(const phase of ['claimed','workspace_ready','launch_intent','process_started','process_exited','result_uploaded','acknowledged','reconcile_required','blocked'])assert.equal(recoveryDisposition({phase}).mayLaunch,false);
 assert.equal(recoveryDisposition({phase:'process_exited'}).mode,'upload_only');assert.equal(recoveryDisposition({phase:'process_started'}).mode,'reconcile_required');
});
