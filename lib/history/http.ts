import {getWorkspaceNamespaces} from '../workspace-namespaces.ts';
import {historyUploadReservationKey} from './upload-identity.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import type {PrivateIngressVerifier} from '../devices/contracts.ts';
import type {PrivateHistoryBucket} from './object-store.ts';
import {stageHistoryObject,MAX_HISTORY_OBJECT_BYTES,HistoryObjectAttemptError,purgeAbandonedHistoryObjects} from './object-store.ts';
import {authenticateHistoryIngest,historyAuthorityGuard} from './auth.ts';
import {CollectionEnvelopeSchema} from './validation.ts';
import {ingestHistoryPage} from './store.ts';
import {historyRecoveryAdmission} from './admission.ts';
import {settleUploadBody} from '../upload-body-settlement.ts';
import {PrivateCapacityError} from '../private-capacity.ts';
import {RecoverabilityCapacityError} from '../recoverability-admission.ts';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
class TransportError extends Error{readonly status:number;readonly diagnostic:string;constructor(status:number,diagnostic:string){super(diagnostic);this.status=status;this.diagnostic=diagnostic;}}
export async function readHistoryTransportBytes(body:ReadableStream<Uint8Array>|null,maxBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
 if(!body)throw new TransportError(400,'empty_body');
 const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0,timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new TransportError(408,'body_deadline')),20000);});
 try{for(;;){signal?.throwIfAborted();const item=await Promise.race([reader.read(),deadline]);if(item.done)break;if(!(item.value instanceof Uint8Array)||item.value.byteLength>maxBytes-size)throw new TransportError(413,'body_limit');chunks.push(item.value);size+=item.value.byteLength;}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
 }catch(error){void reader.cancel().catch(()=>{});throw error;}finally{clearTimeout(timer);reader.releaseLock();}
}
export interface HistoryHttpServices{db:SqlDatabase|null;bucket?:PrivateHistoryBucket;privateIngress?:PrivateIngressVerifier;now():string}
/** Default-closed native private ingress is independent of the scoped application
 * credential. The authenticated principal supplies owner and allowed source. */
export async function handleHistoryTransport(operation:'ingest'|'objects',request:Request,services:HistoryHttpServices):Promise<Response>{
 const response=(value:unknown,status=200)=>Response.json(value,{status,headers});
 try{
  if(request.method!=='POST')return response({error:'Method not allowed.'},405);
  if(!services.db||!services.privateIngress)return response({error:'Private history ingestion is not configured.',diagnostic:'private_ingress_unavailable'},503);
  const auth=await authenticateHistoryIngest(request,services.db,{now:services.now(),privateIngress:services.privateIngress});
  if(!auth)return response({error:'History authorization is unavailable.',diagnostic:'history_authorization'},401);
  const {principal}=auth,contentType=request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if(operation==='objects'){
   if(!services.bucket)return response({error:'Private object storage is unavailable.'},503);
   if(contentType!=='application/octet-stream')throw new TransportError(415,'object_content_type');
   if(request.headers.get('X-History-Source')!==principal.sourceId||request.headers.get('X-History-Epoch')!==principal.epoch||request.headers.get('X-History-Scope-Revision')!==String(principal.scopeRevision))throw new TransportError(403,'history_scope');
   const sha256=request.headers.get('X-History-SHA256');if(!sha256||!/^[a-f0-9]{64}$/.test(sha256))throw new TransportError(400,'object_digest');
   const uploadId=request.headers.get('X-History-Upload-Id');if(!uploadId||!/^upload_[a-f0-9]{64}$/.test(uploadId))throw new TransportError(400,'object_upload_identity');
   const namespaces=await getWorkspaceNamespaces(services.db,principal.ownerId);if(!namespaces)throw new TransportError(503,'owner_namespace_unavailable');
   const reservationKey=await historyUploadReservationKey(namespaces.cursorSecret,{ownerId:principal.ownerId,sourceId:principal.sourceId,epoch:principal.epoch,scopeRevision:principal.scopeRevision},uploadId);
   const bytes=await readHistoryTransportBytes(request.body,MAX_HISTORY_OBJECT_BYTES,request.signal),guard=await historyAuthorityGuard(services.db,principal,services.now());
   if(!guard)throw new TransportError(401,'history_authorization');
   const db=services.db;
   const manifest=await stageHistoryObject({db,bucket:services.bucket,guardSql:guard,now:services.now,authorize:async()=>!!await historyAuthorityGuard(db,principal,services.now())},{ownerId:principal.ownerId,sourceId:principal.sourceId,epoch:principal.epoch,scopeRevision:principal.scopeRevision,bytes,sha256,reservationKey});
   return response(manifest,201);
  }
  if(contentType!=='application/json')throw new TransportError(415,'page_content_type');
  const bytes=await readHistoryTransportBytes(request.body,2*1024*1024,request.signal);let raw:unknown;
  try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new TransportError(400,'page_json');}
  const parsed=CollectionEnvelopeSchema.safeParse(raw);if(!parsed.success)throw new TransportError(400,'page_codec');
  if(parsed.data.page.sourceId!==principal.sourceId||parsed.data.epoch!==principal.epoch||parsed.data.scopeRevision!==principal.scopeRevision)throw new TransportError(403,'history_scope');
  const guard=await historyAuthorityGuard(services.db,principal,services.now());if(!guard)throw new TransportError(401,'history_authorization');
  const result=await ingestHistoryPage(services.db,principal.ownerId,parsed.data,{now:services.now(),authorityGuard:guard,prepareAdmission:historyRecoveryAdmission(services.db)});
  if(result.status==='conflict')throw new TransportError(409,'history_cursor_conflict');
  const discardedObjectKeys=(await services.db.prepare("SELECT key FROM history_object_ledger WHERE user_id=? AND source_id=? AND status='abandoned' AND key IN(SELECT json_extract(value,'$.key') FROM json_each(?))").bind(principal.ownerId,principal.sourceId,JSON.stringify(parsed.data.page.objectManifest)).all<{key:string}>()).results.map(row=>row.key);
  if(services.bucket){const db=services.db;try{await purgeAbandonedHistoryObjects({db,bucket:services.bucket,now:services.now,authorize:async()=>!!await historyAuthorityGuard(db,principal,services.now())},principal.ownerId,5*60000,async(owner,key)=>!!await db.prepare("SELECT 1 FROM project_history WHERE user_id=? AND (json_extract(payload_json,'$.value.bodyObjectKey')=? OR json_extract(payload_json,'$.value.objectKey')=?) LIMIT 1").bind(owner,key,key).first(),principal.sourceId);}catch{/* Committed acknowledgement is independent of bounded cleanup success. */}}
  return response({receipt:result.receipt,discardedObjectKeys});
 }catch(error){
  if(error instanceof HistoryObjectAttemptError)return response({error:'History upload attempt requires unchanged retry or a new settled attempt.',diagnostic:error.code==='pending'?'object_upload_pending':'object_upload_attempt_failed'},error.code==='pending'?409:410);
  if(error instanceof TransportError)return response({error:'History request could not be accepted.',diagnostic:error.diagnostic},error.status);
  if(error instanceof PrivateCapacityError||error instanceof RecoverabilityCapacityError)return response({error:'History capacity requires owner review. Retained content is preserved.',diagnostic:'history_capacity'},429);
  // No owner IDs, paths, tokens, source bodies or private provider errors escape.
  return response({error:'History was not acknowledged. Retry the unchanged page or reconcile its cursor.',diagnostic:'history_conflict'},409);
 }finally{if(!request.bodyUsed)await settleUploadBody(request.body);}
}
