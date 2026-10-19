import type {SqlDatabase} from './workspace-store.ts';
import {mutationEpoch,MutationEpochError,type MutationEpochCheck} from './idempotency-retention.ts';
import {MutationIdReuseError} from './workspace-errors.ts';
export interface MutationAdmissionReceipt {readonly command_hash:string;readonly revision:number}
export interface MutationAdmissionSnapshot {
 readonly epoch:MutationEpochCheck;
 readonly receipt:MutationAdmissionReceipt|null;
 /** Null means this owner has no workspace. The caller must retain its existing
  * missing-workspace handling; this reader never seeds or borrows a workspace. */
 readonly currentRevision:number|null;
}
export const MUTATION_ADMISSION_READ_SQL=`SELECT e.status epoch_status,m.mutation_id receipt_id,m.command_hash receipt_hash,m.revision receipt_revision,w.revision current_revision
 FROM (SELECT ? owner,? mutation_id,? epoch) selected
 LEFT JOIN workspace_mutation_epochs e ON e.user_id=selected.owner AND e.epoch=selected.epoch
 LEFT JOIN workspace_mutations m ON m.user_id=selected.owner AND m.mutation_id=selected.mutation_id
 LEFT JOIN workspaces w ON w.user_id=selected.owner`;
type AdmissionRow={epoch_status:string|null;receipt_id:string|null;receipt_hash:string|null;receipt_revision:number|null;current_revision:number|null};
/** One owner-scoped SQLite statement snapshot, not execution authority. Epochs,
 * receipts and the revision head are read together without loading planning.
 * The same active epoch, receipt absence and workspace revision MUST still be
 * asserted atomically by the existing command compiler.
 *
 * Owner comes from the authenticated server boundary, never command JSON.
 * No owner result, authorization or schema metadata is cached here. */
export async function readMutationAdmission(db:SqlDatabase,authenticatedOwner:string,mutationId:string):Promise<MutationAdmissionSnapshot>{
 if(!authenticatedOwner)throw new Error('A signed-in user is required.');
 // Reuse the original reserved m1 parser and exact invalid-ID errors BEFORE SQL.
 const parsedEpoch=mutationEpoch(mutationId);
 const row=await db.prepare(MUTATION_ADMISSION_READ_SQL).bind(authenticatedOwner,mutationId,parsedEpoch).first<AdmissionRow>();
 if(!row)throw new Error('Mutation admission snapshot could not be read.');
 let epoch:MutationEpochCheck={status:'legacy'};
 if(parsedEpoch!==null){
  if(row.epoch_status!=='active'&&row.epoch_status!=='retired')throw new MutationEpochError('unknown-epoch','The mutation epoch was not issued for this owner.');
  epoch={status:row.epoch_status,epoch:parsedEpoch};
 }
 if(row.current_revision!==null&&(!Number.isSafeInteger(row.current_revision)))throw new Error('Mutation admission revision differs.');
 let receipt:MutationAdmissionReceipt|null=null;
 if(row.receipt_id!==null){
  if(row.receipt_id!==mutationId||typeof row.receipt_hash!=='string'||!Number.isSafeInteger(row.receipt_revision))throw new Error('Mutation admission receipt differs.');
  receipt=Object.freeze({command_hash:row.receipt_hash,revision:row.receipt_revision!});
 }
 return Object.freeze({epoch:Object.freeze(epoch),receipt,currentRevision:row.current_revision});
}
export type MutationAdmissionDecision=
 |{status:'retired';epoch:string}
 |{status:'replayed';receipt:MutationAdmissionReceipt}
 |{status:'conflict';currentRevision:number}
 |{status:'prepare'};
/** Pure precedence shared with the current executor: a retired epoch always
 * rejects before receipt replay, receipt hash mismatch always rejects before a
 * stale revision, and an exact current/legacy hash replays at any editor revision.
 * A replay still requires the caller's normal owner workspace hydration.
 * Unknown epochs have already thrown in readMutationAdmission. */
export function classifyMutationAdmission(snapshot:MutationAdmissionSnapshot,input:{commandHash:string;legacyHash:string;expectedRevision:number}):MutationAdmissionDecision{
 if(snapshot.epoch.status==='retired')return {status:'retired',epoch:snapshot.epoch.epoch};
 if(snapshot.receipt){
  if(snapshot.receipt.command_hash!==input.commandHash&&snapshot.receipt.command_hash!==input.legacyHash)throw new MutationIdReuseError('This mutation ID was reused for a different change.');
  return {status:'replayed',receipt:snapshot.receipt};
 }
 if(snapshot.currentRevision!==null&&snapshot.currentRevision!==input.expectedRevision)return {status:'conflict',currentRevision:snapshot.currentRevision};
 return {status:'prepare'};
}
