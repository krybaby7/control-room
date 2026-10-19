/** Bounded in-isolate admission only. D1 CAS, authentication, epochs and receipts
 * remain authoritative. No workspace/DB result is cached or shared. */
export type WorkspaceAdmissionFailure='owner_capacity'|'owner_waiters'|'global_waiters'|'wait_timeout'|'aborted';
export class WorkspaceAdmissionOverloadError extends Error {
 readonly code='workspace_admission_busy';
 readonly temporary=true;
 readonly reason:WorkspaceAdmissionFailure;
 constructor(reason:WorkspaceAdmissionFailure){super('Workspace admission is temporarily unavailable. This queued operation was not started.');this.name='WorkspaceAdmissionOverloadError';this.reason=reason;}
}
export interface WorkspaceAdmissionLimits {maximumOwners:number;maximumWaitersPerOwner:number;maximumWaiters:number;waitMilliseconds:number}
const defaults:WorkspaceAdmissionLimits={maximumOwners:32,maximumWaitersPerOwner:24,maximumWaiters:256,waitMilliseconds:15000};
interface Entry {resolve:()=>void;reject:(reason:unknown)=>void;signal?:AbortSignal;abort?:()=>void;timer?:ReturnType<typeof setTimeout>;queued:boolean}
interface Slot {active:boolean;queue:Entry[]}
export class WorkspaceAdmission {
 private readonly limits:WorkspaceAdmissionLimits;
 private readonly owners=new Map<string,Slot>();
 private waiting=0;
 constructor(limits:Partial<WorkspaceAdmissionLimits>={}){
  this.limits={...defaults,...limits};
  for(const [key,cap]of [['maximumOwners',256],['maximumWaitersPerOwner',256],['maximumWaiters',4096],['waitMilliseconds',15000]] as const){const value=this.limits[key];if(!Number.isSafeInteger(value)||value<1||value>cap)throw new Error('Invalid trusted admission limits.');}
 }
 /** Owner must come from the authenticated server boundary, never request JSON.
  * Cancellation/deadline while queued guarantees work was not called. Once
  * admitted, its slot is held until work definitively settles, even on abort. */
 async run<T>(owner:string,work:()=>Promise<T>,options:{signal?:AbortSignal}={}):Promise<T>{
  if(!owner||owner.length>256||owner.trim()!==owner||/[\u0000-\u001f\u007f]/u.test(owner))throw new Error('An authenticated owner is required.');
  if(options.signal?.aborted)throw new WorkspaceAdmissionOverloadError('aborted');
  let slot=this.owners.get(owner);
  if(!slot){if(this.owners.size>=this.limits.maximumOwners)throw new WorkspaceAdmissionOverloadError('owner_capacity');slot={active:false,queue:[]};this.owners.set(owner,slot);}
  if(slot.active){if(slot.queue.length>=this.limits.maximumWaitersPerOwner)throw new WorkspaceAdmissionOverloadError('owner_waiters');if(this.waiting>=this.limits.maximumWaiters)throw new WorkspaceAdmissionOverloadError('global_waiters');}
  const selected=slot;
  const ticket=await new Promise<Entry>((resolve,reject)=>{
   const entry:Entry={resolve:()=>resolve(entry),reject,signal:options.signal,queued:selected.active};
   if(!selected.active){selected.active=true;entry.resolve();return;}
   selected.queue.push(entry);this.waiting++;
   const cancel=(reason:WorkspaceAdmissionFailure)=>{if(!entry.queued)return;const index=selected.queue.indexOf(entry);if(index<0)return;selected.queue.splice(index,1);this.waiting--;entry.queued=false;this.clear(entry);reject(new WorkspaceAdmissionOverloadError(reason));};
   entry.abort=()=>cancel('aborted');entry.signal?.addEventListener('abort',entry.abort,{once:true});entry.timer=setTimeout(()=>cancel('wait_timeout'),this.limits.waitMilliseconds);
   if(entry.signal?.aborted)entry.abort();
  });
  this.clear(ticket);
  // This continuation belongs to the requesting caller. Never execute its work
  // from the previous request's finally/Promise chain: workerd I/O is scoped to
  // its originating request. Queue entries carry tickets, never work closures.
  try{if(options.signal?.aborted)throw new WorkspaceAdmissionOverloadError('aborted');return await work();}
  finally{this.release(owner,selected);}

 }
 /** Counts only: never exposes owner keys, work closures, commands or results. */
 snapshot():Readonly<{owners:number;active:number;waiting:number}>{return {owners:this.owners.size,active:[...this.owners.values()].filter(slot=>slot.active).length,waiting:this.waiting};}
 private clear(entry:Entry){clearTimeout(entry.timer);entry.timer=undefined;if(entry.abort)entry.signal?.removeEventListener('abort',entry.abort);entry.abort=undefined;}
 private release(owner:string,slot:Slot){
  const next=slot.queue.shift();
  if(next){this.waiting--;next.queued=false;next.resolve();}
  else{slot.active=false;this.owners.delete(owner);}
 }
}
/** Process-local bounded optimization, not distributed execution authority. */
export const workspaceAdmission=new WorkspaceAdmission();
export function withWorkspaceAdmission<T>(authenticatedOwner:string,work:()=>Promise<T>,options:{signal?:AbortSignal}={}):Promise<T>{return workspaceAdmission.run(authenticatedOwner,work,options);}
