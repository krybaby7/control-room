import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openExecutorStore} from '../executor/store.mjs';
const identity={jobId:'job-fixture',attemptId:'attempt-fixture',deviceId:'device-fixture',epoch:1,specSha256:'a'.repeat(64)};
test('separate execution store allows one slot and refuses a second process without stealing locks',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-store-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=await openExecutorStore({directory});await assert.rejects(openExecutorStore({directory}),/locked_reconcile_required/);const attempt=await store.openAttempt(identity);await assert.rejects(store.openAttempt({...identity,attemptId:'other'}),/slot_unavailable/);await attempt.close();await store.close();const reopened=await openExecutorStore({directory});await reopened.close();
});
test('retention capacity rejects admission without deleting any old attempt',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-store-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));for(let i=0;i<12;i++)await mkdir(join(directory,i.toString(16).padStart(64,'0')),{mode:0o700});const store=await openExecutorStore({directory});await assert.rejects(store.openAttempt(identity),/retention_capacity/);await store.close();
});

test('concurrent attempt opens reserve the one local slot before any filesystem await',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-store-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=await openExecutorStore({directory});const outcomes=await Promise.allSettled([store.openAttempt(identity),store.openAttempt({...identity,attemptId:'parallel'})]);assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);assert.equal(outcomes.filter(row=>row.status==='rejected').length,1);for(const row of outcomes)if(row.status==='fulfilled')await row.value.close();await store.close();
});
