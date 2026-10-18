import { validateDraft, type Draft } from './drafts.ts';
export type OutboxState = 'draft'|'queued'|'sending'|'uncertain'|'conflict'|'committed'|'failed';
export interface OutboxItem { draft:Draft; state:OutboxState }
export interface DeviceStorage { read(namespace:string):Promise<OutboxItem[]>; write(namespace:string,items:OutboxItem[]):Promise<void>; remove(namespace:string):Promise<void> }
export function memoryDeviceStorage():DeviceStorage {
  const records=new Map<string,OutboxItem[]>();
  return {async read(key){return structuredClone(records.get(key)??[]);},async write(key,value){records.set(key,structuredClone(value));},async remove(key){records.delete(key);}};
}
/** Browser adapter is opened only after explicit opt-in; no localStorage fallback. */
export function indexedDbDeviceStorage(factory:IDBFactory|undefined=globalThis.indexedDB):DeviceStorage {
  if(!factory) throw new Error('IndexedDB unavailable. Drafts remain in memory.');
  const database=new Promise<IDBDatabase>((resolve,reject)=>{const request=factory.open('control-room-private-outbox',1);request.onupgradeneeded=()=>request.result.createObjectStore('owners');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  async function transact<T>(mode:IDBTransactionMode,key:string,value?:OutboxItem[],remove=false):Promise<T> {
    const db=await database;
    return new Promise((resolve,reject)=>{const transaction=db.transaction('owners',mode);const store=transaction.objectStore('owners');const request=mode==='readonly'?store.get(key):remove?store.delete(key):store.put(value,key);let result:T;request.onsuccess=()=>{result=request.result as T;};transaction.oncomplete=()=>resolve(result);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error??new Error('Device storage aborted.'));});
  }
  return {async read(key){return (await transact<OutboxItem[]|undefined>('readonly',key))??[];},async write(key,value){await transact('readwrite',key,value);},async remove(key){await transact('readwrite',key,undefined,true);}};
}
export interface InvalidationBus { publish(namespace:string):void; subscribe(listener:(namespace:string)=>void):()=>void }
export function browserInvalidationBus():InvalidationBus {
  const channel=new BroadcastChannel('control-room-private-invalidation');
  return {publish(namespace){channel.postMessage(namespace);},subscribe(listener){const receive=(event:MessageEvent)=>{if(typeof event.data==='string')listener(event.data);};channel.addEventListener('message',receive);return ()=>{channel.removeEventListener('message',receive);channel.close();};}};
}
export class DeviceOutbox {
  private items:OutboxItem[]=[];
  private generation=0;
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
    const loaded=await result.storage.read(result.namespace);
    if(generation!==result.generation)throw new Error('Session changed.');
    const now=options.now??new Date().toISOString();
    result.items=loaded.map(item=>({draft:validateDraft(item.draft),state:item.state==='sending'?'uncertain':item.state} as OutboxItem)).filter(item=>item.draft.expiresAt>now);
    if(result.items.some(item=>!['draft','queued','uncertain','conflict','committed','failed'].includes(item.state)))throw new Error('Invalid outbox state.');
    return result;
  }
  private check(){if(!this.active)throw new Error('Session changed; reauthenticate before accessing private drafts.');}
  private persist():Promise<void>{const generation=this.generation;const snapshot=structuredClone(this.items);this.chain=this.chain.catch(()=>{}).then(async()=>{if(this.active&&generation===this.generation)await this.storage.write(this.namespace,snapshot);});return this.chain;}
  inspect():OutboxItem[]{this.check();return structuredClone(this.items);}
  export():string {this.check();return JSON.stringify({version:1,items:this.items});}
  async put(draft:Draft){this.check();const validated=validateDraft(draft);const index=this.items.findIndex(item=>item.draft.id===draft.id);if(index>=0&&['sending','uncertain'].includes(this.items[index].state))throw new Error('Resolve the original submission before replacing it.');const item:OutboxItem={draft:validated,state:'draft'};if(index<0){if(this.items.length>=100)throw new Error('Device outbox has reached its 100 item limit.');this.items.push(item);}else this.items[index]=item;await this.persist();}
  async discard(id:string){this.check();this.items=this.items.filter(item=>item.draft.id!==id);await this.persist();}
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
  async forget(){this.lock();this.bus?.publish(this.namespace);await this.chain.catch(()=>{});await this.storage.remove(this.namespace);this.unsubscribe?.();}
}
