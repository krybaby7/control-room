import type {SqlDatabase} from '../workspace-store.ts';
import {getWorkspaceNamespaces} from '../workspace-namespaces.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {privateUpdateGrowth} from '../private-growth.ts';
import {requirePrivateCapacity} from '../private-capacity.ts';
import {CollectionEnvelopeSchema,canonicalEnvelopeDigest,canonicalJson} from './validation.ts';
import {historyUploadReservationKey} from './upload-identity.ts';
import {stageHistoryObject,readHistoryObject,HistoryObjectAttemptError,type PrivateHistoryBucket,type HistoryObjectScope} from './object-store.ts';
import {readHistorySyncJob,historySyncClaimGuard,PendingEnvelopePointerSchema,type HistorySyncClaim,type HistoryRunnerAuthority} from './job-store.ts';
import type {PendingEnvelopeObjectPort} from './sync-runner.ts';
export interface PendingEnvelopeObjectOptions {db:SqlDatabase;bucket:PrivateHistoryBucket;authority:HistoryRunnerAuthority;claim:HistorySyncClaim;now:()=>string;}
const MAX_BYTES=2*1024*1024,ATTEMPTS=5;
type Ledger={source_id:string;epoch:string;scope_revision:number;sha256:string;bytes:number;status:string;pending_token:string|null;purged_at:string|null};
function helpers(options:PendingEnvelopeObjectOptions){
 const {db,claim,authority}=options,scope:HistoryObjectScope={ownerId:claim.ownerId,sourceId:claim.payload.sourceId,epoch:claim.payload.epoch,scopeRevision:claim.payload.scopeRevision},token=claim.payload.lease?.token;
 async function fresh(){const current=await readHistorySyncJob(db,scope.ownerId,claim.intentId);if(!token||!current||current.payload.lease?.token!==token||current.ownerId!==scope.ownerId||current.executionEpoch!==claim.executionEpoch||current.kind!==claim.kind||current.payload.sourceId!==scope.sourceId||current.payload.epoch!==scope.epoch||current.payload.scopeRevision!==scope.scopeRevision)throw Error('Pending envelope lease or scope changed.');const guard=await historySyncClaimGuard(db,current,authority,options.now());if(!guard||!await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first())throw Error('Pending envelope authority lost.');return {current,guard};}
 async function key(digest:string,attempt:number){const namespaces=await getWorkspaceNamespaces(db,scope.ownerId);if(!namespaces)throw Error('Owner object namespace unavailable.');const id='upload_'+await contentHash(canonical(['history-pending-envelope-v1',claim.intentId,scope.sourceId,scope.epoch,scope.scopeRevision,digest,attempt]));return historyUploadReservationKey(namespaces.cursorSecret,scope,id);}
 const ledger=(key:string)=>db.prepare('SELECT source_id,epoch,scope_revision,sha256,bytes,status,pending_token,purged_at FROM history_object_ledger WHERE user_id=? AND key=?').bind(scope.ownerId,key).first<Ledger>();
 function matches(row:Ledger,digest:string,bytes:number){if(!/^[a-f0-9]{64}$/u.test(digest)||!Number.isSafeInteger(bytes)||bytes<1||bytes>MAX_BYTES)throw Error('Invalid bounded pending envelope manifest.');if(row.source_id!==scope.sourceId||row.epoch!==scope.epoch||row.scope_revision!==scope.scopeRevision||row.sha256!==digest||row.bytes!==bytes)throw Error('Pending envelope object scope or content differs.');}
 async function ownsKey(objectKey:string,digest:string){for(let attempt=0;attempt<ATTEMPTS;attempt++)if(await key(digest,attempt)===objectKey)return true;return false;}
 function deps(guard:{sql:string;bindings:(string|number|null)[]}){return {db,bucket:options.bucket,now:options.now,guardSql:{sql:guard.sql,params:guard.bindings},authorize:async()=>{try{await fresh();return true;}catch{return false;}}};}
 return {scope,fresh,key,ledger,matches,ownsKey,deps};
}
/** Immutable, quota-admitted pending wire envelopes. Retry keys never come from a caller. */
export function createPendingEnvelopeObjectPort(options:PendingEnvelopeObjectOptions):PendingEnvelopeObjectPort {
 const h=helpers(options);
 return {async retire(ownerId,pointer){if(ownerId!==h.scope.ownerId)throw Error('Pending envelope owner differs.');const candidate=PendingEnvelopePointerSchema.parse(pointer);await retirePendingEnvelopeObjects(options,[candidate.key]);},async put(ownerId,input,digest){
  if(ownerId!==h.scope.ownerId)throw Error('Pending envelope owner differs.');const envelope=CollectionEnvelopeSchema.parse(input),bytes=new TextEncoder().encode(canonicalJson(envelope));
  if(bytes.length>MAX_BYTES||await canonicalEnvelopeDigest(envelope)!==digest)throw Error('Pending envelope digest or bounded size differs.');
  const initial=await h.fresh();if(envelope.page.sourceId!==h.scope.sourceId||envelope.epoch!==h.scope.epoch||envelope.scopeRevision!==h.scope.scopeRevision||envelope.page.runId!==initial.current.payload.continuation.runId)throw Error('Pending envelope source run differs.');
  for(let attempt=0;attempt<ATTEMPTS;attempt++){
   const reservationKey=await h.key(digest,attempt),before=await h.ledger(reservationKey);if(before){h.matches(before,digest,bytes.length);if(before.pending_token!==null||before.status==='staging')throw new HistoryObjectAttemptError('pending');if(before.status!=='ready'||before.purged_at!==null)continue;}
   const {guard}=await h.fresh();try{const manifest=await stageHistoryObject(h.deps(guard),{...h.scope,bytes,sha256:digest,reservationKey});await h.fresh();return PendingEnvelopePointerSchema.parse({key:manifest.key,digest:manifest.sha256,bytes:manifest.bytes});}
   catch(error){const settled=await h.ledger(reservationKey);if(!settled)throw error;h.matches(settled,digest,bytes.length);if(settled.pending_token!==null||settled.status==='staging')throw new HistoryObjectAttemptError('pending');if(settled.status==='ready'&&settled.purged_at===null){const latest=await h.fresh();const manifest=await stageHistoryObject(h.deps(latest.guard),{...h.scope,bytes,sha256:digest,reservationKey});return {key:manifest.key,digest:manifest.sha256,bytes:manifest.bytes};}await h.fresh();}
  }
  throw new HistoryObjectAttemptError('failed');
 },async get(ownerId,input){if(ownerId!==h.scope.ownerId)throw Error('Pending envelope owner differs.');const pointer=PendingEnvelopePointerSchema.parse(input),{guard,current}=await h.fresh();if(!await h.ownsKey(pointer.key,pointer.digest))throw Error('Pending envelope key belongs to another job.');const bytes=await readHistoryObject(h.deps(guard),h.scope,{key:pointer.key,sha256:pointer.digest,bytes:pointer.bytes}),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),envelope=CollectionEnvelopeSchema.parse(JSON.parse(text));if(new TextEncoder().encode(canonicalJson(envelope)).length!==pointer.bytes||await canonicalEnvelopeDigest(envelope)!==pointer.digest||envelope.page.sourceId!==h.scope.sourceId||envelope.epoch!==h.scope.epoch||envelope.scopeRevision!==h.scope.scopeRevision||envelope.page.runId!==current.payload.continuation.runId)throw Error('Retained pending envelope differs.');await h.fresh();return envelope;}};
}
/** Call only after clearing the pointer transaction. This keeps physical quota
 * charged; existing grace-period maintenance alone can later purge bytes. */
export async function retirePendingEnvelopeObjects(options:PendingEnvelopeObjectOptions,candidateKeys:readonly string[]):Promise<number>{
 if(candidateKeys.length>25||new Set(candidateKeys).size!==candidateKeys.length)throw Error('Invalid bounded pending retirement candidates.');const h=helpers(options);let retired=0;
 for(const key of candidateKeys){const {guard}=await h.fresh(),row=await h.ledger(key);if(!row)continue;h.matches(row,row.sha256,row.bytes);if(!await h.ownsKey(key,row.sha256))throw Error('Retirement key belongs to another job.');if(row.status!=='ready'||row.pending_token!==null||row.purged_at!==null)continue;
  const growth=await privateUpdateGrowth(options.db,h.scope.ownerId,'history_object_ledger','key=?',[key],{status:'abandoned'}),capacity=await requirePrivateCapacity(options.db,h.scope.ownerId,{growth:[growth]});
  const result=await options.db.prepare(`UPDATE history_object_ledger SET status='abandoned' WHERE user_id=? AND key=? AND source_id=? AND epoch=? AND scope_revision=? AND sha256=? AND bytes=? AND status='ready' AND pending_token IS NULL AND purged_at IS NULL AND (${guard.sql}) AND (${capacity.sql}) AND NOT EXISTS(SELECT 1 FROM workspace_job_intents job,json_tree(job.payload_json) ref WHERE job.user_id=? AND json_valid(job.payload_json) AND ref.type='text' AND ref.value=?) AND NOT EXISTS(SELECT 1 FROM project_history history,json_tree(history.payload_json) ref WHERE history.user_id=? AND ref.type='text' AND ref.value=?)`).bind(h.scope.ownerId,key,h.scope.sourceId,h.scope.epoch,h.scope.scopeRevision,row.sha256,row.bytes,...guard.bindings,...capacity.bindings,h.scope.ownerId,key,h.scope.ownerId,key).run();retired+=result.meta.changes??0;
 }
 return retired;
}
