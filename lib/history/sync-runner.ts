import type {SqlDatabase} from '../workspace-store.ts';
import type {CollectionEnvelope,CollectionPage,InventoryMembership,IngestReceipt} from './contracts.ts';
import {collectHistoryPages,type CollectionContinuation, type CollectionPorts} from './collection.ts';
import {canonicalEnvelopeDigest,CollectionEnvelopeSchema,MAX_PAGE_METADATA_BYTES,canonicalJson,type VerifiedObject,type RetainedReferences} from './validation.ts';
import {readHistorySyncJob,isHistorySyncClaimCurrent,saveHistoryJobPending,prepareHistoryJobProgress,finishHistorySync,PendingEnvelopePointerSchema,type HistorySyncClaim,type HistoryRunnerAuthority,type PendingEnvelopePointer,type PreparedHistoryProgress} from './job-store.ts';
export interface PendingEnvelopeObjectPort {
 /** Private owner-scoped immutable storage. The implementation owns object quota,
  * checksum/finalization and orphan retention; never truncate to job payload size. */
 put(ownerId:string,envelope:CollectionEnvelope,digest:string):Promise<PendingEnvelopePointer>;
 get(ownerId:string,pointer:PendingEnvelopePointer):Promise<unknown>;
}
export interface HistorySyncRunnerPorts {
 objects:PendingEnvelopeObjectPort;
 read(state:CollectionContinuation,signal:AbortSignal):Promise<CollectionPage>;
 verify(envelope:CollectionEnvelope):Promise<{objects:VerifiedObject[];retained:RetainedReferences}>;
 contentProgress?:CollectionPorts['contentProgress'];
 /** Root invokes existing ingest and injects progress.before before page DML and
  * progress.after into THAT SAME atomic batch. It must not commit them separately. */
 commitPageAtomic(envelope:CollectionEnvelope,digest:string,memberships:InventoryMembership[],progress:PreparedHistoryProgress):Promise<IngestReceipt>;
}
export async function runHistorySync(db:SqlDatabase,initial:HistorySyncClaim,authority:HistoryRunnerAuthority|undefined,ports:HistorySyncRunnerPorts,options:{now:()=>string;signal:AbortSignal}):Promise<{status:'complete'|'continue'|'unavailable'|'failed';pages:number}>{
 let claim=initial;const now=options.now();if(!await isHistorySyncClaimCurrent(db,claim,authority,now))return {status:'unavailable',pages:0};let pages=0;
 const leaseRemaining=Date.parse(claim.payload.lease!.expiresAt)-Date.parse(now);if(leaseRemaining<=0)return {status:'unavailable',pages:0};
 const signal=AbortSignal.any([options.signal,AbortSignal.timeout(Math.min(20_000,leaseRemaining))]);
 async function bounded<T>(operation:()=>Promise<T>):Promise<T>{signal.throwIfAborted();let abort:()=>void=()=>{};const stopped=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});try{return await Promise.race([operation(),stopped]);}finally{signal.removeEventListener('abort',abort);}}
 const collection:CollectionPorts={
  async load(){const current=await readHistorySyncJob(db,claim.ownerId,claim.intentId);if(!current||!await isHistorySyncClaimCurrent(db,current,authority,options.now())||current.payload.lease?.token!==initial.payload.lease?.token)throw Error('History lease/source authority lost');claim=current;let pending:CollectionEnvelope|null=null;if(claim.payload.pendingObject){const pointer=claim.payload.pendingObject;const raw=await bounded(()=>ports.objects.get(claim.ownerId,pointer));pending=CollectionEnvelopeSchema.parse(raw);if(new TextEncoder().encode(JSON.stringify(pending)).length>MAX_PAGE_METADATA_BYTES||await canonicalEnvelopeDigest(pending)!==claim.payload.pendingObject.digest||new TextEncoder().encode(canonicalJson(pending)).length!==claim.payload.pendingObject.bytes)throw Error('Pending envelope object differs');}return {...claim.payload.continuation,pending};},
  read:(state,readSignal)=>bounded(()=>ports.read(state,readSignal)),verify:envelope=>bounded(()=>ports.verify(envelope)),contentProgress:ports.contentProgress,
  async savePending(expected,envelope){if(expected.revision!==claim.payload.continuation.revision)throw Error('History continuation CAS differs');const digest=await canonicalEnvelopeDigest(envelope),pointer=PendingEnvelopePointerSchema.parse(await bounded(()=>ports.objects.put(claim.ownerId,envelope,digest)));if(pointer.digest!==digest||pointer.bytes!==new TextEncoder().encode(canonicalJson(envelope)).length)throw Error('Pending object digest differs');const next={...expected,revision:expected.revision+1};const {pending,...continuation}=next;void pending;const updated=await saveHistoryJobPending(db,claim,authority,options.now(),continuation,pointer);if(!updated)throw Error('History pending authority lost');claim=updated;},
  async commitPageAtomic(expected,envelope,digest,memberships,next){if(expected.revision!==claim.payload.continuation.revision)throw Error('History continuation CAS differs');const {pending,...continuation}=next;void pending;const progress=await prepareHistoryJobProgress(db,claim,authority,options.now(),continuation,null);if(!progress)throw Error('History commit authority lost');const receipt=await bounded(()=>ports.commitPageAtomic(envelope,digest,memberships,progress));pages++;return receipt;},
 };
 try{const result=await collectHistoryPages(collection,{signal,now:options.now,maxPages:5,maxMs:Math.min(20_000,leaseRemaining)});claim=(await readHistorySyncJob(db,claim.ownerId,claim.intentId))!;const complete=result.continuation.phase==='complete';const finished=await finishHistorySync(db,claim,{authority,now:options.now(),outcome:complete?'complete':'continue',retryAt:options.now()});return {status:finished?(complete?'complete':'continue'):'unavailable',pages};}
 catch{const latest=await readHistorySyncJob(db,claim.ownerId,claim.intentId);if(latest&&latest.payload.lease?.token===initial.payload.lease?.token)await finishHistorySync(db,latest,{authority,now:options.now(),outcome:'failed',failure:signal.aborted?'timeout':'commit',retryAt:new Date(Date.parse(options.now())+30_000).toISOString()});return {status:'failed',pages};}
}
