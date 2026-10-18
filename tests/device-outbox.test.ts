import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceOutbox,memoryDeviceStorage,indexedDbDeviceStorage,type InvalidationBus} from '../lib/device-outbox.ts';
const draft={id:'d',entityType:'task',baseRevision:2,baseSnapshot:{},changedFields:{title:'new'},command:{type:'editTask',id:'task'},mutationId:'original-id',createdAt:'2026-10-18T00:00:00.000Z',updatedAt:'2026-10-18T00:00:00.000Z',expiresAt:'2026-11-01T00:00:00.000Z'};
test('opt-in persistence, owner separation and default memory-only closure',async()=>{
 const storage=memoryDeviceStorage();const first=await DeviceOutbox.open('a',{trustedDevice:true,storage});await first.put(draft);
 assert.equal((await DeviceOutbox.open('a',{trustedDevice:true,storage})).inspect().length,1);
 assert.equal((await DeviceOutbox.open('b',{trustedDevice:true,storage})).inspect().length,0);
 const ephemeral=await DeviceOutbox.open('a',{storage});await ephemeral.put(draft);assert.equal((await DeviceOutbox.open('a',{storage})).inspect().length,0);
 assert.throws(()=>indexedDbDeviceStorage(undefined));
});
test('unknown mutation remains uncertain; explicit retry uses exact original ID',async()=>{
 const box=await DeviceOutbox.open('a');await box.put(draft);await box.queue('d');let sends=0;
 await box.replay('d',async id=>{assert.equal(id,'original-id');return 'unknown';},async()=>{sends++;return 'committed';});assert.equal(sends,0);assert.equal(box.inspect()[0].state,'uncertain');
 await box.replay('d',async()=> 'retryable',async value=>{assert.equal(value.mutationId,'original-id');sends++;throw Error('response lost');});assert.equal(box.inspect()[0].state,'uncertain');
 await box.replay('d',async()=> 'committed',async()=>{sends++;return 'committed';});assert.equal(sends,1);assert.equal(box.inspect()[0].state,'committed');
});
test('logout invalidates in-flight reconciliation and other tabs before clearing storage',async()=>{
 const storage=memoryDeviceStorage();const listeners=new Set<(key:string)=>void>();const bus:InvalidationBus={publish(key){for(const listener of listeners)listener(key);},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
 const box=await DeviceOutbox.open('a',{trustedDevice:true,storage,bus});await box.put(draft);await box.queue('d');const tab=await DeviceOutbox.open('a',{trustedDevice:true,storage,bus});
 let finish!:(value:'retryable')=>void;let sends=0;const pending=box.replay('d',()=>new Promise(resolve=>{finish=resolve;}),async()=>{sends++;return 'committed';});await box.forget();finish('retryable');await pending;
 assert.equal(sends,0);assert.throws(()=>tab.inspect());assert.equal((await DeviceOutbox.open('a',{trustedDevice:true,storage})).inspect().length,0);
});
test('quota errors retain memory draft and expired persisted records stay hidden',async()=>{
 const storage=memoryDeviceStorage();const box=await DeviceOutbox.open('a',{trustedDevice:true,storage:{...storage,async write(){throw Error('QuotaExceededError');}}});await assert.rejects(box.put(draft));assert.equal(box.inspect().length,1);
 await storage.write('owner:a',[{draft,state:'sending'}]);assert.equal((await DeviceOutbox.open('a',{trustedDevice:true,storage,now:'2026-12-01T00:00:00.000Z'})).inspect().length,0);
 const recovered=await DeviceOutbox.open('a',{trustedDevice:true,storage,now:'2026-10-18T00:00:00.000Z'});assert.equal(recovered.inspect()[0].state,'uncertain');
});
