import { validateDraft, type Draft } from './drafts.ts';
export type OutboxState = 'draft'|'queued'|'sending'|'uncertain'|'conflict'|'committed'|'failed';
export interface OutboxItem { draft:Draft; state:OutboxState }
export interface VersionedDeviceItems { revision:number; items:OutboxItem[] }
export interface DeviceStorage { readVersioned(namespace:string):Promise<VersionedDeviceItems>; compareAndSwap(namespace:string,expectedRevision:number,items:OutboxItem[]):Promise<boolean>; read(namespace:string):Promise<OutboxItem[]>; write(namespace:string,items:OutboxItem[]):Promise<void>; remove(namespace:string):Promise<void> }
export const DEVICE_OUTBOX_LIMITS=Object.freeze({items:100,bytes:8_000_000});
export class DeviceOutboxConflictError extends Error { constructor(){super('Device drafts changed in another tab. Your unsaved draft remains available for review or export.');this.name='DeviceOutboxConflictError';} }
function versioned(value:unknown):VersionedDeviceItems {
  if(value===undefined)return {revision:0,items:[]};
  if(Array.isArray(value))return {revision:0,items:structuredClone(value) as OutboxItem[]};
  const record=value as VersionedDeviceItems;
  if(!record||!Number.isSafeInteger(record.revision)||record.revision<0||!Array.isArray(record.items))throw new Error('Invalid device storage version.');
  return structuredClone(record);
}
function bounded(items:OutboxItem[]):void {if(items.length>DEVICE_OUTBOX_LIMITS.items||new TextEncoder().encode(JSON.stringify(items)).byteLength>DEVICE_OUTBOX_LIMITS.bytes)throw new Error('Device outbox exceeds its 100 item or 8 MB limit. Export or explicitly discard selected drafts.');}
function nextRevision(revision:number):number {if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)throw new Error('Invalid device storage revision.');return revision+1;}
export function memoryDeviceStorage():DeviceStorage {
  const records=new Map<string,VersionedDeviceItems>();
  const storage:DeviceStorage={async readVersioned(key){return versioned(records.get(key));},async compareAndSwap(key,expected,items){bounded(items);const current=versioned(records.get(key));if(current.revision!==expected)return false;records.set(key,{revision:nextRevision(expected),items:structuredClone(items)});return true;},async read(key){return (await storage.readVersioned(key)).items;},async write(key,items){bounded(items);const current=versioned(records.get(key));records.set(key,{revision:nextRevision(current.revision),items:structuredClone(items)});},async remove(key){const current=versioned(records.get(key));records.set(key,{revision:nextRevision(current.revision),items:[]});}};
  return storage;
}
/** Browser adapter is opened only after explicit opt-in; no localStorage fallback. */
export function indexedDbDeviceStorage(factory:IDBFactory|undefined=globalThis.indexedDB):DeviceStorage {
  if(!factory) throw new Error('IndexedDB unavailable. Drafts remain in memory.');
  const database=new Promise<IDBDatabase>((resolve,reject)=>{const request=factory.open('control-room-private-outbox',1);request.onupgradeneeded=()=>request.result.createObjectStore('owners');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  async function readVersioned(key:string):Promise<VersionedDeviceItems> {
    const db=await database;return new Promise((resolve,reject)=>{const tx=db.transaction('owners','readonly');const request=tx.objectStore('owners').get(key);let result:VersionedDeviceItems;request.onsuccess=()=>{try{result=versioned(request.result);}catch(error){tx.abort();reject(error);}};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('Device storage aborted.'));});
  }
  async function update(key:string,items:OutboxItem[],expected?:number):Promise<boolean> {
    bounded(items);const snapshot=structuredClone(items);const db=await database;
    // The read and conditional write share one native readwrite transaction.
    return new Promise((resolve,reject)=>{const tx=db.transaction('owners','readwrite');const store=tx.objectStore('owners');const request=store.get(key);let changed=false;request.onsuccess=()=>{try{const current=versioned(request.result);if(expected!==undefined&&current.revision!==expected)return;store.put({revision:nextRevision(current.revision),items:snapshot},key);changed=true;}catch(error){tx.abort();reject(error);}};tx.oncomplete=()=>resolve(changed);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('Device storage aborted.'));});
  }
  return {readVersioned,compareAndSwap:(key,expected,items)=>update(key,items,expected),async read(key){return (await readVersioned(key)).items;},async write(key,items){await update(key,items);},async remove(key){await update(key,[]);}};
}
export interface InvalidationBus { publish(namespace:string):void; subscribe(listener:(namespace:string)=>void):()=>void }
export function browserInvalidationBus():InvalidationBus {
  const channel=new BroadcastChannel('control-room-private-invalidation');
  return {publish(namespace){channel.postMessage(namespace);},subscribe(listener){const receive=(event:MessageEvent)=>{if(typeof event.data==='string')listener(event.data);};channel.addEventListener('message',receive);return ()=>{channel.removeEventListener('message',receive);channel.close();};}};
}
export class DeviceOutbox {
  private items:OutboxItem[]=[];
  private generation=0;
  private storageRevision=0;
  private active=true;
  private chain:Promise<void>=Promise.resolve();
  private unsubscribe?:()=>void;
  private namespace:string;
  private storage:DeviceStorage;
  private bus?:InvalidationBus;
  private constructor(namespace:string,storage:DeviceStorage,bus?:InvalidationBus) {
    this.namespace=namespace;this.storage=storage;this.bus=bus;
    this.unsubscribe=bus?.subscribe(key=>{if(key===namespace)this.lock();});
  }
  static async open(owner:string,options:{trustedDevice?:boolean;storage?:DeviceStorage;bus?:InvalidationBus;now?:string}={}):Promise<DeviceOutbox> {
    if(!owner)throw new Error('Verified server owner required.');
    const result=new DeviceOutbox(`owner:${owner}`,options.trustedDevice?(options.storage??indexedDbDeviceStorage()):memoryDeviceStorage(),options.bus);
    const generation=result.generation;
    const loaded=await result.storage.readVersioned(result.namespace);
    result.storageRevision=loaded.revision;
    bounded(loaded.items);
    if(generation!==result.generation)throw new Error('Session changed.');
    const now=options.now??new Date().toISOString();
    result.items=loaded.items.map(item=>({draft:validateDraft(item.draft),state:item.state==='sending'?'uncertain':item.state} as OutboxItem)).filter(item=>item.draft.expiresAt>now);
    if(result.items.some(item=>!['draft','queued','uncertain','conflict','committed','failed'].includes(item.state)))throw new Error('Invalid outbox state.');
    return result;
  }
  private check(){if(!this.active)throw new Error('Session changed; reauthenticate before accessing private drafts.');}
  private persist():Promise<void>{const generation=this.generation;const snapshot=structuredClone(this.items);bounded(snapshot);this.chain=this.chain.catch(()=>{}).then(async()=>{if(!this.active||generation!==this.generation)return;if(!await this.storage.compareAndSwap(this.namespace,this.storageRevision,snapshot))throw new DeviceOutboxConflictError();this.storageRevision++;});return this.chain;}
  inspect():OutboxItem[]{this.check();return structuredClone(this.items);}
  export():string {this.check();return JSON.stringify({version:1,items:this.items});}
  async put(draft:Draft){this.check();const validated=validateDraft(draft);const index=this.items.findIndex(item=>item.draft.id===draft.id);if(index>=0&&['sending','uncertain'].includes(this.items[index].state))throw new Error('Resolve the original submission before replacing it.');const item:OutboxItem={draft:validated,state:'draft'};const candidate=this.items.slice();if(index<0)candidate.push(item);else candidate[index]=item;bounded(candidate);this.items=candidate;await this.persist();}
  async discard(id:string){this.check();const item=this.find(id);if(!await this.discardIfUnchanged(id,item.draft))throw new DeviceOutboxConflictError();}
  async discardIfUnchanged(id:string,expectedDraft:Draft):Promise<boolean>{
    this.check();const generation=this.generation;const expected=canonicalDraft(validateDraft(expectedDraft));let removed=false;
    const operation=this.chain.catch(()=>{}).then(async()=>{
      if(!this.active||generation!==this.generation)return;
      const fresh=await this.storage.readVersioned(this.namespace);
      if(!this.active||generation!==this.generation)return;
      const found=fresh.items.find(item=>item.draft.id===id);
      if(!found||canonicalDraft(found.draft)!==expected)return;
      if(!await this.storage.compareAndSwap(this.namespace,fresh.revision,fresh.items.filter(item=>item.draft.id!==id)))return;
      if(!this.active||generation!==this.generation)return;
      // Never adopt a fresh revision over stale local content from a different tab.
      if(this.storageRevision===fresh.revision)this.storageRevision++;
      this.items=this.items.filter(item=>item.draft.id!==id||canonicalDraft(item.draft)!==expected);removed=true;
    });
    this.chain=operation;await operation;return removed;
  }
  async queue(id:string){this.check();const item=this.find(id);if(item.state!=='draft'&&item.state!=='failed'&&item.state!=='conflict')throw new Error('Item cannot be queued.');if(!item.draft.command||!item.draft.mutationId)throw new Error('Exact command and original mutation ID required.');item.state='queued';await this.persist();}
  private find(id:string){const item=this.items.find(item=>item.draft.id===id);if(!item)throw new Error('Unknown outbox item.');return item;}
  /** Explicit owner action. Always reconcile original ID first; unknown never triggers a POST. */
  async replay(id:string,lookup:(mutationId:string)=>Promise<'committed'|'conflict'|'unknown'|'retryable'>,send:(draft:Draft)=>Promise<'committed'|'conflict'|'failed'|'uncertain'>){
    this.check();const item=this.find(id);if(!['queued','uncertain'].includes(item.state))throw new Error('Queue explicitly before sending.');const generation=this.generation;const mutationId=item.draft.mutationId;if(!mutationId||!item.draft.command)throw new Error('Exact command and original mutation ID required.');if(item.draft.expiresAt<=new Date().toISOString())throw new Error('Draft expired; inspect or discard it before replay.');
    const outcome=await lookup(mutationId);if(generation!==this.generation||!this.active)return;
    if(outcome==='committed'||outcome==='conflict'){item.state=outcome;await this.persist();return;}
    if(outcome==='unknown'){item.state='uncertain';await this.persist();return;}
    item.state='sending';await this.persist();if(generation!==this.generation||!this.active)return;
    try{const status=await send(structuredClone(item.draft));if(generation===this.generation&&this.active){item.state=status;await this.persist();}}catch{if(generation===this.generation&&this.active){item.state='uncertain';await this.persist();}}
  }
  /** 401 hides content immediately. Never unseal without a freshly verified owner. */
  lock(){this.active=false;this.generation++;this.items=[];}
  async forget(){this.lock();this.bus?.publish(this.namespace);await this.chain.catch(()=>{});for(;;){const fresh=await this.storage.readVersioned(this.namespace);if(await this.storage.compareAndSwap(this.namespace,fresh.revision,[]))break;}this.unsubscribe?.();}
}

function canonicalDraft(value:unknown):string {if(Array.isArray(value))return `[${value.map(canonicalDraft).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalDraft((value as Record<string,unknown>)[key])}`).join(',')}}`;return JSON.stringify(value);}
