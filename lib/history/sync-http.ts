import {z} from 'zod';
import {settleUploadBody} from '../upload-body-settlement.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import {PrivateCapacityError} from '../private-capacity.ts';
import {RecoverabilityCapacityError} from '../recoverability-admission.ts';
import {canonical} from '../canonical-json.ts';
import {readHistoryTransportBytes} from './http.ts';
import {CollectionEnvelopeSchema,InventoryMembershipSchema,canonicalEnvelopeDigest} from './validation.ts';
import {ingestHistoryPage} from './store.ts';
import {historyRecoveryAdmission} from './admission.ts';
import {claimHistorySync,readHistorySyncJob,historySyncClaimGuard,finishHistorySync,type HistoryRunnerAuthority,type HistorySyncClaim} from './job-store.ts';
import {runHistorySync,type HistorySyncRunnerPorts} from './sync-runner.ts';
export interface HistorySyncHttpServices {
 db:SqlDatabase|null;
 now():string;
 /** SERVER ONLY: derives owner from an authenticated, independently verified
  * service identity and private ingress. Never use visitor cookies, source:read
  * bearer reuse, or history.ingest enrollment as acquisition proof. */
 resolveHistoryRunner?(request:Request,now:string):Promise<HistoryRunnerAuthority|null>;
 /** Selected supported read-only provider plus owner-scoped verified objects.
  * This factory cannot substitute a custom commit or grant provider capability. */
 createPorts?(authority:HistoryRunnerAuthority,claim:HistorySyncClaim):Promise<Omit<HistorySyncRunnerPorts,'commitPageAtomic'>|null>;
}
const inputSchema=z.object({intentId:z.string().min(1).max(128)}).strict();
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
/** Bounded server composition. No scheduler, provider, credential or browser
 * session is activated by installing this handler; absent dependencies fail closed. */
export async function handleHistorySyncRequest(request:Request,services:HistorySyncHttpServices):Promise<Response>{
 const response=(value:unknown,status=200)=>Response.json(value,{status,headers});
 try{
  if(request.method!=='POST')return response({diagnostic:'method_not_allowed'},405);
  if(!services.db||!services.resolveHistoryRunner||!services.createPorts)return response({diagnostic:'history_sync_unconfigured'},503);
  if(request.headers.has('cookie'))return response({diagnostic:'history_runner_authorization'},401);
  const db=services.db,authority=await services.resolveHistoryRunner(request,services.now());if(!authority)return response({diagnostic:'history_runner_authorization'},401);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return response({diagnostic:'history_sync_content_type'},415);
  let raw:unknown;try{const bytes=await readHistoryTransportBytes(request.body,1024,request.signal);raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return response({diagnostic:'history_sync_input'},400);}
  const parsed=inputSchema.safeParse(raw);if(!parsed.success)return response({diagnostic:'history_sync_input'},400);
  const claim=await claimHistorySync(db,authority.ownerId,parsed.data.intentId,{now:services.now(),authority});if(!claim)return response({diagnostic:'history_sync_unavailable'},409);
  const provider=await services.createPorts(authority,claim);if(!provider){await finishHistorySync(db,claim,{authority,now:services.now(),outcome:'failed',failure:'access',retryAt:new Date(Date.parse(services.now())+30000).toISOString()});return response({diagnostic:'history_reader_unavailable'},503);}
  const ports:HistorySyncRunnerPorts={...provider,async commitPageAtomic(input,digest,memberships,progress){
   const envelope=CollectionEnvelopeSchema.parse(input);if(await canonicalEnvelopeDigest(envelope)!==digest)throw Error('History page digest differs');
   const current=await readHistorySyncJob(db,claim.ownerId,claim.intentId);if(!current||current.payload.controlRevision+1!==progress.nextClaim.payload.controlRevision||current.payload.lease?.token!==claim.payload.lease?.token||progress.nextClaim.intentId!==claim.intentId||progress.nextClaim.ownerId!==claim.ownerId)throw Error('History progress identity differs');
   if(envelope.page.sourceId!==current.payload.sourceId||envelope.epoch!==current.payload.epoch||envelope.scopeRevision!==current.payload.scopeRevision||envelope.page.runId!==current.payload.continuation.runId)throw Error('History page scope differs');
   const observedAt=progress.nextClaim.payload.continuation.lastAttemptAt;if(!observedAt)throw Error('History progress clock is missing');
   const expected=current.payload.continuation.phase==='inventory'?envelope.page.conversations.map(row=>({codecVersion:1,sourceId:current.payload.sourceId,epoch:current.payload.epoch,scopeRevision:current.payload.scopeRevision,generation:current.payload.continuation.generation,conversationId:row.id,archived:row.archived,observedAt})):[];
   for(const member of memberships)InventoryMembershipSchema.parse(member);if(canonical(memberships)!==canonical(expected))throw Error('History inventory membership differs');
   const guard=await historySyncClaimGuard(db,current,authority,services.now());if(!guard)throw Error('History runner authority lost');
   // Only ingestion receives this wrapper. Recovery snapshots/admission use the
   // original DB, whose read batches must not receive mutation extensions.
   const atomic:SqlDatabase={prepare:sql=>db.prepare(sql),batch:statements=>db.batch([...progress.before,...statements,...progress.after])};
   const result=await ingestHistoryPage(atomic,claim.ownerId,envelope,{now:services.now(),inventoryMemberships:memberships,authorityGuard:{sql:guard.sql,params:guard.bindings},prepareAdmission:historyRecoveryAdmission(db,{additionalPrivateGrowth:progress.privateGrowth})});
   if(result.status==='conflict')throw Error('History ingestion CAS conflict');return result.receipt;
  }};
  const result=await runHistorySync(db,claim,authority,ports,{now:()=>services.now(),signal:request.signal});return response(result,result.status==='failed'?409:result.status==='unavailable'?403:200);
 }catch(error){if(error instanceof PrivateCapacityError||error instanceof RecoverabilityCapacityError)return response({diagnostic:'history_capacity'},429);return response({diagnostic:'history_sync_conflict'},409);}
 finally{if(!request.bodyUsed)await settleUploadBody(request.body);}
}
