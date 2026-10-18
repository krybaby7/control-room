import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceOutbox,memoryDeviceStorage,indexedDbDeviceStorage,DeviceOutboxConflictError,type DeviceStorage,type InvalidationBus} from '../lib/device-outbox.ts';
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
 const storage=memoryDeviceStorage();const box=await DeviceOutbox.open('a',{trustedDevice:true,storage:{...storage,async compareAndSwap(){throw Error('QuotaExceededError');}}});await assert.rejects(box.put(draft));assert.equal(box.inspect().length,1);
 await storage.write('owner:a',[{draft,state:'sending'}]);assert.equal((await DeviceOutbox.open('a',{trustedDevice:true,storage,now:'2026-12-01T00:00:00.000Z'})).inspect().length,0);
 const recovered=await DeviceOutbox.open('a',{trustedDevice:true,storage,now:'2026-10-18T00:00:00.000Z'});assert.equal(recovered.inspect()[0].state,'uncertain');
});

test('two stale tabs cannot overwrite different draft IDs; conflicted local work remains exportable',async()=>{
 const storage=memoryDeviceStorage();const a=await DeviceOutbox.open('a',{trustedDevice:true,storage});const b=await DeviceOutbox.open('a',{trustedDevice:true,storage});
 const outcomes=await Promise.allSettled([a.put({...draft,id:'first'}),b.put({...draft,id:'second'})]);assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);const rejected=outcomes.find(item=>item.status==='rejected');assert.ok(rejected&&rejected.reason instanceof DeviceOutboxConflictError);
 assert.equal((await storage.read('owner:a')).length,1);assert.equal(a.inspect()[0].draft.id,'first');assert.equal(b.inspect()[0].draft.id,'second');assert.ok(b.export().includes('second'));
});

test('same-ID edits use storage revision CAS and preserve the losing local edit',async()=>{
 const storage=memoryDeviceStorage();const original=await DeviceOutbox.open('a',{trustedDevice:true,storage});await original.put(draft);const stale=await DeviceOutbox.open('a',{trustedDevice:true,storage});
 await original.put({...draft,changedFields:{title:'winner'}});await assert.rejects(stale.put({...draft,changedFields:{title:'local unsaved'}}),DeviceOutboxConflictError);
 assert.equal((await storage.read('owner:a'))[0].draft.changedFields.title,'winner');assert.equal(stale.inspect()[0].draft.changedFields.title,'local unsaved');
});

test('discardIfUnchanged refuses a newer same-ID draft and leaves storage untouched',async()=>{
 const storage=memoryDeviceStorage();const original=await DeviceOutbox.open('a',{trustedDevice:true,storage});await original.put(draft);const stale=await DeviceOutbox.open('a',{trustedDevice:true,storage});await original.put({...draft,changedFields:{title:'newer'}});
 const before=await storage.readVersioned('owner:a');assert.equal(await stale.discardIfUnchanged(draft.id,draft),false);assert.deepEqual(await storage.readVersioned('owner:a'),before);
});

test('discard compare-and-swap race cannot delete a newer value after its fresh read',async()=>{
 const storage=memoryDeviceStorage();let inject=false;const raced:DeviceStorage={...storage,async compareAndSwap(namespace,revision,items){if(inject){inject=false;await storage.write(namespace,[{draft:{...draft,changedFields:{title:'racing edit'}},state:'draft'}]);}return storage.compareAndSwap(namespace,revision,items);}};
 const box=await DeviceOutbox.open('a',{trustedDevice:true,storage:raced});await box.put(draft);inject=true;assert.equal(await box.discardIfUnchanged(draft.id,draft),false);assert.equal((await storage.read('owner:a'))[0].draft.changedFields.title,'racing edit');
});

test('fresh discard preserves other tabs drafts and cannot adopt a stale local namespace for later overwrite',async()=>{
 const storage=memoryDeviceStorage();const stale=await DeviceOutbox.open('a',{trustedDevice:true,storage});await stale.put(draft);const other=await DeviceOutbox.open('a',{trustedDevice:true,storage});await other.put({...draft,id:'other'});
 assert.equal(await stale.discardIfUnchanged(draft.id,draft),true);assert.deepEqual((await storage.read('owner:a')).map(item=>item.draft.id),['other']);await assert.rejects(stale.put({...draft,id:'local'}),DeviceOutboxConflictError);assert.deepEqual((await storage.read('owner:a')).map(item=>item.draft.id),['other']);
});

test('serialized writes in one instance retain both local edits',async()=>{
 const storage=memoryDeviceStorage();const box=await DeviceOutbox.open('a',{trustedDevice:true,storage});await Promise.all([box.put({...draft,id:'one'}),box.put({...draft,id:'two'})]);assert.deepEqual((await storage.read('owner:a')).map(item=>item.draft.id),['one','two']);
});

test('forget fences an in-flight CAS, then clears with a revision tombstone that rejects stale writers',async()=>{
 const storage=memoryDeviceStorage();let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let pause=true;
 const delayed:DeviceStorage={...storage,async compareAndSwap(namespace,revision,items){if(pause){pause=false;entered();await new Promise<void>(resolve=>{release=resolve;});}return storage.compareAndSwap(namespace,revision,items);}};
 const box=await DeviceOutbox.open('a',{trustedDevice:true,storage:delayed});const stale=await DeviceOutbox.open('a',{trustedDevice:true,storage});const pending=box.put(draft);await started;const forget=box.forget();assert.throws(()=>box.inspect());release();await pending;await forget;
 const cleared=await storage.readVersioned('owner:a');assert.deepEqual(cleared.items,[]);assert.ok(cleared.revision>=2);await assert.rejects(stale.put(draft),DeviceOutboxConflictError);assert.deepEqual(await storage.readVersioned('owner:a'),cleared);
});

test('cross-tab logout hides drafts immediately and invalidates pending callbacks',async()=>{
 const storage=memoryDeviceStorage();const listeners=new Set<(key:string)=>void>();const bus:InvalidationBus={publish(key){for(const listener of listeners)listener(key);},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
 const box=await DeviceOutbox.open('a',{trustedDevice:true,storage,bus});await box.put(draft);const tab=await DeviceOutbox.open('a',{trustedDevice:true,storage,bus});await box.forget();assert.throws(()=>tab.inspect());assert.throws(()=>tab.export());await assert.rejects(tab.put(draft));assert.deepEqual((await storage.readVersioned('owner:a')).items,[]);
});

test('outbox cap rejects the 101st draft without evicting existing drafts',async()=>{
 const storage=memoryDeviceStorage();const box=await DeviceOutbox.open('a',{trustedDevice:true,storage});for(let i=0;i<100;i++)await box.put({...draft,id:`d-${i}`});const before=await storage.readVersioned('owner:a');await assert.rejects(box.put({...draft,id:'overflow'}),/100 item|8 MB/);assert.equal(box.inspect().length,100);assert.deepEqual(await storage.readVersioned('owner:a'),before);
});

test('storage CAS enforces byte cap without evicting existing values',async()=>{
 const storage=memoryDeviceStorage();await storage.write('owner:a',[{draft,state:'draft'}]);const before=await storage.readVersioned('owner:a');await assert.rejects(storage.compareAndSwap('owner:a',before.revision,[{draft:{...draft,changedFields:{text:'x'.repeat(8_000_001)}},state:'draft'}]),/8 MB/);assert.deepEqual(await storage.readVersioned('owner:a'),before);
});

/** Minimal serialized IDB transaction fake exercises the native adapter, including legacy array migration. */
function fakeIndexedDb(initial:unknown){
 const records=new Map<string,unknown>([['owner:a',initial]]);let chain=Promise.resolve();
 type Request={result:unknown;onsuccess:null|(()=>void)};
 const factory={open(){const request={result:{createObjectStore(){},transaction(){
   let pending=0;let aborted=false;let complete=false;let ready!:()=>void;let done!:()=>void;
   const start=new Promise<void>(resolve=>{ready=resolve;});const finished=new Promise<void>(resolve=>{done=resolve;});
   const tx={oncomplete:null as null|(()=>void),onerror:null as null|(()=>void),onabort:null as null|(()=>void),error:null,
    abort(){aborted=true;tx.onabort?.();done();},
    objectStore(){return {
     get(key:string){const get:Request={result:undefined,onsuccess:null};pending++;void start.then(()=>{if(aborted)return;get.result=structuredClone(records.get(key));get.onsuccess?.();pending--;settle();});return get;},
     put(value:unknown,key:string){pending++;void start.then(()=>{if(aborted)return;records.set(key,structuredClone(value));pending--;settle();});}
    };}
   };
   function settle(){queueMicrotask(()=>{if(!aborted&&!complete&&pending===0){complete=true;tx.oncomplete?.();done();}});}
   chain=chain.then(()=>{ready();return finished;});return tx;
  }},onsuccess:null as null|(()=>void),onerror:null as null|(()=>void)};queueMicrotask(()=>request.onsuccess?.());return request;}};
 return factory as unknown as IDBFactory;
}

test('native IndexedDB adapter migrates legacy arrays at revision zero and serializes CAS within readwrite transactions',async()=>{
 const storage=indexedDbDeviceStorage(fakeIndexedDb([{draft,state:'draft'}]));const legacy=await storage.readVersioned('owner:a');assert.equal(legacy.revision,0);assert.deepEqual(legacy.items,[{draft,state:'draft'}]);
 const [a,b]=await Promise.all([storage.compareAndSwap('owner:a',0,[{draft:{...draft,id:'a'},state:'draft'}]),storage.compareAndSwap('owner:a',0,[{draft:{...draft,id:'b'},state:'draft'}])]);assert.deepEqual([a,b],[true,false]);assert.equal((await storage.readVersioned('owner:a')).revision,1);
 await storage.remove('owner:a');const cleared=await storage.readVersioned('owner:a');assert.deepEqual(cleared,{revision:2,items:[]});assert.equal(await storage.compareAndSwap('owner:a',1,[{draft,state:'draft'}]),false);assert.deepEqual(await storage.readVersioned('owner:a'),cleared);
});
