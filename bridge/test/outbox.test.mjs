import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Outbox} from '../src/outbox.mjs';
import {canonicalJson} from '../src/config.mjs';
const now='2026-10-18T12:00:00.000Z',expires='2026-10-18T12:00:30.000Z';
function heartbeat(sequence,patch={}){return canonicalJson({schemaVersion:1,deviceId:'synthetic-device',bootId:'11111111-1111-4111-8111-111111111111',generation:1,sequence,sentAt:now,bridgeVersion:'0.1.0',observations:[],...patch});}
const entry=(sequence,patch={})=>({heartbeatBytes:heartbeat(sequence),liveWindowId:'window-'+sequence,windowExpiresAt:expires,createdAt:now,...patch});
function fixture(work){const directory=mkdtempSync(join(tmpdir(),'bridge-outbox-'));let outbox=Outbox.open({directory});try{return work({directory,get outbox(){return outbox;},reopen(){outbox.close();outbox=Outbox.open({directory});return outbox;}});}finally{outbox.close();rmSync(directory,{recursive:true,force:true});}}
test('immutable canonical heartbeat retry preserves original live window and rejects authority',()=>fixture(({outbox})=>{
 const first=outbox.enqueue(entry(1));assert.deepEqual(outbox.enqueue(entry(1)),first);assert.equal(outbox.status().records,1);
 assert.throws(()=>outbox.enqueue(entry(1,{windowExpiresAt:'2026-10-18T12:01:00.000Z'})));
 assert.throws(()=>outbox.enqueue(entry(1,{heartbeatBytes:heartbeat(1,{bridgeVersion:'0.1.1'})})));
 assert.throws(()=>outbox.enqueue(entry(2,{heartbeatBytes:JSON.stringify(JSON.parse(heartbeat(2)),null,1)})));
 assert.throws(()=>outbox.enqueue(entry(2,{heartbeatBytes:heartbeat(2,{execution:{command:'run'}})})));
}));
test('reconnect requires genuinely new live sample; old unreceived payload is history with unchanged bytes',()=>fixture(context=>{
 let box=context.outbox;const old=box.enqueue(entry(1));box=context.reopen();assert.deepEqual(box.pending({now}),[]);
 assert.deepEqual(box.enqueue(entry(1)),old);assert.deepEqual(box.pending({now}),[]);
 const fresh=box.enqueue(entry(2));const [live]=box.pending({now});assert.equal(live.id,fresh.id);assert.equal(live.delivery,'live');box.ack(fresh.id,{classification:'live'});
 const [history]=box.pending({now});assert.equal(history.id,old.id);assert.equal(history.delivery,'history');assert.equal(history.heartbeatBytes,heartbeat(1));assert.equal(history.liveWindowId,'window-1');
 box.ack(old.id,{classification:'history'});assert.equal(box.status().records,0);
}));
test('expired/failed live receipt cannot unlock historical drain',()=>fixture(({outbox})=>{
 outbox.enqueue(entry(1));const second=outbox.enqueue(entry(2));assert.deepEqual(outbox.pending({now:expires}),[]);
 outbox.ack(second.id,{classification:'history'});assert.deepEqual(outbox.pending({now}),[]);
 const third=outbox.enqueue(entry(3));outbox.ack(third.id,{classification:'live'});assert.equal(outbox.pending({now})[0].delivery,'history');
}));
test('bounded telemetry evicts oldest with honest gaps and keeps newest',()=>fixture(({outbox,directory})=>{
 for(let index=1;index<=245;index++)outbox.enqueue(entry(index));
 assert.equal(outbox.status().records,240);assert.equal(outbox.status().gapCount,5);
 const [latest]=outbox.pending({now});assert.equal(latest.heartbeatBytes,heartbeat(245));outbox.ack(latest.id,{classification:'live'});
 assert.equal(outbox.pending({now})[0].heartbeatBytes,heartbeat(6));
 assert.ok(readdirSync(directory).reduce((sum,name)=>sum+statSync(join(directory,name)).size,0)<=8388608);
}));
test('SQLite write failure rolls back existing heartbeat and gap count without full-copy spool',()=>fixture(({outbox,directory})=>{
 const first=outbox.enqueue(entry(1));const database=new DatabaseSync(join(directory,'outbox.sqlite'));
 database.exec("CREATE TRIGGER synthetic_fault BEFORE INSERT ON telemetry BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
 try{assert.throws(()=>outbox.enqueue(entry(2)));assert.equal(outbox.status().records,1);assert.equal(outbox.status().gapCount,0);assert.equal(outbox.pending({now})[0].id,first.id);
 assert.ok(readdirSync(directory).reduce((sum,name)=>sum+statSync(join(directory,name)).size,0)<=8388608);
 }finally{database.exec('DROP TRIGGER synthetic_fault');database.close();}
}));

test('physical main and rollback journal remain below eight MiB during a rolled-back full transaction',()=>fixture(({outbox,directory})=>{
 const first=outbox.enqueue(entry(1));const database=new DatabaseSync(join(directory,'outbox.sqlite'));
 database.exec('PRAGMA journal_mode=DELETE; PRAGMA max_page_count=960; BEGIN IMMEDIATE');
 try{
  // Synthetic corruption is confined to an uncommitted fixture transaction.
  // It exercises SQLite's physical ceiling, not a supported telemetry payload.
  assert.throws(()=>database.prepare('UPDATE telemetry SET heartbeat_bytes=?').run('x'.repeat(5*1024*1024)));
  const physical=readdirSync(directory).reduce((sum,name)=>sum+statSync(join(directory,name)).size,0);assert.ok(physical<=8388608);
 }finally{try{database.exec('ROLLBACK');}catch{}database.close();}
 assert.equal(outbox.status().records,1);assert.equal(outbox.pending({now})[0].id,first.id);assert.equal(outbox.pending({now})[0].heartbeatBytes,heartbeat(1));
}));

test('optional GPU alias accepts new samples without hydrating or rewriting historical heartbeat bytes',()=>fixture(context=>{
 const observation={source:'pc-command-center',instanceId:'pc-command-center',observedAt:now,reportedAgeSeconds:1,state:'ready',diagnostic:'ok',metrics:null};
 const oldBytes=heartbeat(1,{observations:[observation]});const old=context.outbox.enqueue(entry(1,{heartbeatBytes:oldBytes}));
 const box=context.reopen(),freshBytes=heartbeat(2,{observations:[{...observation,selectedGpuAlias:'owner-primary'}]}),fresh=box.enqueue(entry(2,{heartbeatBytes:freshBytes}));
 assert.equal(box.pending({now})[0].heartbeatBytes,freshBytes);box.ack(fresh.id,{classification:'live'});const history=box.pending({now})[0];assert.equal(history.id,old.id);assert.equal(history.heartbeatBytes,oldBytes);assert.equal(Object.hasOwn(JSON.parse(history.heartbeatBytes).observations[0],'selectedGpuAlias'),false);
 box.enqueue(entry(3,{heartbeatBytes:heartbeat(3,{observations:[{...observation,selectedGpuAlias:null}]})}));
 for(const extra of [{selectedGpuAlias:'x'.repeat(65)},{selectedGpuAlias:42},{selectedGpuAlias:'owner-primary',selectedGpuId:'raw-local-id'},{selectedGpuAlias:'owner-primary',execute:true}])assert.throws(()=>box.enqueue(entry(4,{heartbeatBytes:heartbeat(4,{observations:[{...observation,...extra}]})})));
}));
