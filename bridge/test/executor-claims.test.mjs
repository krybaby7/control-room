import {canonicalMkdtemp as mkdtemp,unitPrivateStateVerifier} from './fixtures/private-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareDurableClaim} from '../executor/claims.mjs';
test('claim nonce is durable before HTTP and restart retries same exact identity with no lease token on disk',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-claim-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));const first=await prepareDurableClaim({verifyPrivateState:unitPrivateStateVerifier,directory,jobId:'job-fixture'}),again=await prepareDurableClaim({verifyPrivateState:unitPrivateStateVerifier,directory,jobId:'job-fixture'});assert.deepEqual(again,first);assert.match(first.journalNonce,/^[a-f0-9]{64}$/);const names=await readdir(directory);assert.equal(names.length,1);assert.match(names[0],/^[a-f0-9]{64}\.json$/);const disk=JSON.parse(await readFile(join(directory,names[0]),'utf8'));assert.deepEqual(Object.keys(disk).sort(),['jobId','journalNonce','schemaVersion']);assert.equal(Object.hasOwn(disk,'leaseToken'),false);
});
test('corrupt retained nonce refuses fresh identity; cap never evicts older claims',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-claim-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));await prepareDurableClaim({verifyPrivateState:unitPrivateStateVerifier,directory,jobId:'job-fixture'});const path=join(directory,(await readdir(directory))[0]);await writeFile(path,'{"partial":');await assert.rejects(prepareDurableClaim({verifyPrivateState:unitPrivateStateVerifier,directory,jobId:'job-fixture'}),/claim_corrupt/);assert.equal(await readFile(path,'utf8'),'{"partial":');
 const another=await mkdtemp(join(tmpdir(),'executor-claim-fixture-'));t.after(()=>rm(another,{recursive:true,force:true}));for(let i=0;i<12;i++)await prepareDurableClaim({verifyPrivateState:unitPrivateStateVerifier,directory:another,jobId:'job-'+i});await assert.rejects(prepareDurableClaim({verifyPrivateState:unitPrivateStateVerifier,directory:another,jobId:'job-overflow'}),/retention_capacity/);assert.equal((await readdir(another)).length,12);
});
test('a crash-held claim writer lock is never stolen based on a PID or timestamp',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'executor-claim-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));await writeFile(join(directory,'writer.lock'),'synthetic-stale-lock',{mode:0o600});await assert.rejects(prepareDurableClaim({verifyPrivateState:unitPrivateStateVerifier,directory,jobId:'job-fixture'}),/claim_locked_reconcile_required/);assert.equal(await readFile(join(directory,'writer.lock'),'utf8'),'synthetic-stale-lock');
});
