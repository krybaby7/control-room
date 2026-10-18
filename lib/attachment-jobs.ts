import type {AttachmentRecord} from './evidence-contract.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {attachmentStorageKey,type AttachmentCleanupIntent,type BlobStore} from './attachments.ts';
import {z} from 'zod';
const intentSchema=z.object({attachmentId:z.string().uuid(),storageKey:z.string().min(1).max(500),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),reason:z.enum(['invalid-upload','expired-reservation','owner-delete'])}).strict();
/** Persistent fencing token: never expires or permits key reuse after a timed-out delete. */
export interface AttachmentDeletionClaim {token:string;attachmentId:string;storageKey:string}
export interface AttachmentCleanupSnapshot {
 record:AttachmentRecord;rowRevision:number;ownerNamespace:string;
 /** Complete live AND retained-backup reference set, read consistently with referenceRevision. */
 references:readonly string[];referenceRevision:string;
 claim:AttachmentDeletionClaim|null;purged:boolean;
}
/**
 * Server-created owner-scoped adapter; no request owner ID is accepted here.
 * Implementations MUST atomically compare metadata/references when claiming, retain the
 * tombstone/fence forever, and reject finalization, upload and new reference/backup
 * retention to a claimed key. A lease that expires or allows resurrection is unsafe.
 * The SQL adapter supplies these fences; production activation also requires the guarded runner.
 */
export interface AttachmentCleanupStore {
 /** Read-only completed-key lookup; never resolves the deletion key from current metadata. */
 completed?(intent:{attachmentId:string;storageKey:string;sha256:string|null}):Promise<boolean>;
 read(attachmentId:string):Promise<AttachmentCleanupSnapshot|null>;
 claim(input:{attachmentId:string;expectedRowRevision:number;referenceRevision:string;storageKey:string}):Promise<AttachmentCleanupSnapshot|null>;
 /** Fresh guarded read; checks exact persistent claim, namespace, terminal state and no references. */
 authorize(claim:AttachmentDeletionClaim):Promise<AttachmentCleanupSnapshot|null>;
 /** After confirmed blob absence, atomically marks fence and matching physical ledger purged; retains tombstones. */
 complete(claim:AttachmentDeletionClaim):Promise<boolean>;
}
export interface AttachmentCleanupRunner {
 readonly ownerNamespace:string;readonly metadata:AttachmentCleanupStore;readonly blobs:BlobStore;
 timeoutMs?:number;
}
export type AttachmentCleanupResult=
 |{status:'purged';alreadyAbsent:boolean}
 |{status:'blocked';reason:'missing'|'references'|'ready'|'state'|'namespace'|'changed'}
 |{status:'retirement-required'}
 |{status:'retry';reason:'unavailable'|'timeout'|'storage'|'integrity'};
class DeadlineError extends Error {}
/** Only attachment.cleanup payloads from the guarded retirement lifecycle are supported. */
export async function runAttachmentCleanup(raw:AttachmentCleanupIntent,runner:AttachmentCleanupRunner):Promise<AttachmentCleanupResult>{
 const intent=intentSchema.parse(raw);const timeoutMs=runner.timeoutMs??15_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw new Error('Cleanup deadline must be between 1 and 60000 ms.');
 const deadline=Date.now()+timeoutMs;
 async function bounded<T>(operation:()=>Promise<T>):Promise<T>{const remaining=deadline-Date.now();if(remaining<=0)throw new DeadlineError();let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DeadlineError()),remaining);})]);}finally{if(timer)clearTimeout(timer);}}
 function check(snapshot:AttachmentCleanupSnapshot):AttachmentCleanupResult|null{
  const record=attachmentRecordSchema.parse(snapshot.record);
  if(snapshot.ownerNamespace!==runner.ownerNamespace||record.id!==intent.attachmentId||record.storageKey!==intent.storageKey||record.storageKey!==attachmentStorageKey(runner.ownerNamespace,record.id))return {status:'blocked',reason:'namespace'};
  if(record.sha256!==intent.sha256||!Number.isSafeInteger(snapshot.rowRevision)||snapshot.rowRevision<1||!snapshot.referenceRevision)return {status:'blocked',reason:'changed'};
  if(record.status==='ready')return {status:'blocked',reason:'ready'};
  // Expiry alone grants no deletion authority: retirement must release quota and enqueue first.
  if(record.status==='reserved')return {status:'retirement-required'};
  if(record.status!=='deleted'&&!(record.status==='quarantined'&&intent.reason==='invalid-upload'))return {status:'blocked',reason:'state'};
  if(snapshot.references.length)return {status:'blocked',reason:'references'};
  return null;
 }
 function validClaim(snapshot:AttachmentCleanupSnapshot,claim:AttachmentDeletionClaim){return snapshot.claim?.token===claim.token&&claim.token.length>0&&snapshot.claim.attachmentId===intent.attachmentId&&snapshot.claim.storageKey===intent.storageKey&&claim.attachmentId===intent.attachmentId&&claim.storageKey===intent.storageKey;}
 try{
  if(runner.metadata.completed&&await bounded(()=>runner.metadata.completed!(intent)))return {status:'purged',alreadyAbsent:true};
  let snapshot=await bounded(()=>runner.metadata.read(intent.attachmentId));if(!snapshot)return {status:'blocked',reason:'missing'};
  let blocked=check(snapshot);if(blocked)return blocked;
  if(!runner.blobs.available)return {status:'retry',reason:'unavailable'};
  if(!snapshot.claim){const initial=snapshot;snapshot=await bounded(()=>runner.metadata.claim({attachmentId:intent.attachmentId,expectedRowRevision:initial.rowRevision,referenceRevision:initial.referenceRevision,storageKey:intent.storageKey}));if(!snapshot)return {status:'blocked',reason:'changed'};}
  blocked=check(snapshot);if(blocked)return blocked;const claim=snapshot.claim;if(!claim||!validClaim(snapshot,claim))return {status:'blocked',reason:'changed'};
  const authorized=await bounded(()=>runner.metadata.authorize(claim));if(!authorized||!validClaim(authorized,claim))return {status:'blocked',reason:'changed'};blocked=check(authorized);if(blocked)return blocked;
  const existing=await bounded(()=>runner.blobs.head(intent.storageKey));
  if(existing&&intent.sha256!==null&&existing.sha256!==intent.sha256)return {status:'retry',reason:'integrity'};
  if(existing){const beforeDelete=await bounded(()=>runner.metadata.authorize(claim));if(!beforeDelete||!validClaim(beforeDelete,claim))return {status:'blocked',reason:'changed'};blocked=check(beforeDelete);if(blocked)return blocked;await bounded(()=>runner.blobs.delete(intent.storageKey));}
  // A lost delete response is ambiguous. A retry re-heads the same permanently fenced key.
  if(await bounded(()=>runner.blobs.head(intent.storageKey)))return {status:'retry',reason:'storage'};
  const after=await bounded(()=>runner.metadata.authorize(claim));if(!after||!validClaim(after,claim))return {status:'blocked',reason:'changed'};blocked=check(after);if(blocked)return blocked;
  if(!await bounded(()=>runner.metadata.complete(claim)))return {status:'blocked',reason:'changed'};
  return {status:'purged',alreadyAbsent:existing===null};
 }catch(error){return {status:'retry',reason:error instanceof DeadlineError?'timeout':'storage'};}
}
