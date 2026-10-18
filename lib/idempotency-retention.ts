import {validateDraft} from './drafts.ts';
import type { SqlDatabase } from './workspace-store.ts';

export const MUTATION_EPOCH_PATTERN = /^[a-f0-9]{32}$/;
const namespacedId = /^m1_([a-f0-9]{32})_([a-f0-9]{32})$/;
export class MutationEpochError extends Error {
  readonly code: 'invalid-id' | 'unknown-epoch';
  constructor(code: 'invalid-id' | 'unknown-epoch', message: string) { super(message); this.code=code; this.name='MutationEpochError'; }
}
export type MutationEpochCheck = {status:'legacy'} | {status:'active'|'retired'; epoch:string};
function owner(userId:string):void { if (!userId) throw new Error('A signed-in user is required.'); }
function timestamp(now:string):void { if (!Number.isFinite(Date.parse(now))) throw new Error('A valid timestamp is required.'); }
export function mutationEpoch(mutationId:string):string|null {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(mutationId)) throw new MutationEpochError('invalid-id','A valid mutation ID is required.');
  if (!mutationId.startsWith('m1_')) return null;
  const match=namespacedId.exec(mutationId);
  if (!match) throw new MutationEpochError('invalid-id','The mutation epoch ID is invalid.');
  return match[1];
}
/** Read-only preflight. The command transaction must ALSO assert active status atomically. */
export async function checkMutationEpoch(db:SqlDatabase,userId:string,mutationId:string):Promise<MutationEpochCheck> {
  owner(userId);
  const epoch=mutationEpoch(mutationId);
  if (epoch===null) return {status:'legacy'};
  const row=await db.prepare('SELECT status FROM workspace_mutation_epochs WHERE user_id = ? AND epoch = ?').bind(userId,epoch).first<{status:'active'|'retired'}>();
  if (!row) throw new MutationEpochError('unknown-epoch','The mutation epoch was not issued for this owner.');
  return {status:row.status,epoch};
}
/** Epochs are random server namespaces, independent of client clocks and imported records. */
export async function issueMutationId(db:SqlDatabase,userId:string,now:string):Promise<string> {
  owner(userId); timestamp(now);
  let row=await db.prepare("SELECT epoch FROM workspace_mutation_epochs WHERE user_id = ? AND status = 'active' ORDER BY epoch LIMIT 1").bind(userId).first<{epoch:string}>();
  if (!row) {
    const epoch=crypto.randomUUID().replaceAll('-','');
    await db.prepare("INSERT INTO workspace_mutation_epochs (user_id, epoch, status, created_at, retired_at) VALUES (?, ?, 'active', ?, NULL)").bind(userId,epoch,now).run();
    row={epoch};
  }
  return `m1_${row.epoch}_${crypto.randomUUID().replaceAll('-','')}`;
}
/** Persist the rejecting tombstone first. Never delete legacy receipts or epoch authority. */
export async function retireEpoch(db:SqlDatabase,userId:string,epoch:string,now:string):Promise<{epoch:string;status:'retired';compactionAllowed:true}> {
  owner(userId); timestamp(now);
  if (!MUTATION_EPOCH_PATTERN.test(epoch)) throw new MutationEpochError('invalid-id','The mutation epoch is invalid.');
  await db.prepare("INSERT INTO workspace_mutation_epochs (user_id, epoch, status, created_at, retired_at) VALUES (?, ?, 'retired', ?, ?) ON CONFLICT(user_id, epoch) DO UPDATE SET status = 'retired', retired_at = COALESCE(workspace_mutation_epochs.retired_at, excluded.retired_at)").bind(userId,epoch,now,now).run();
  // This is permission to compact detail later, never permission to remove the tombstone.
  return {epoch,status:'retired',compactionAllowed:true};
}

export type EpochCompactionResult=
 | {status:'compacted';removed:number}
 | {status:'blocked';reason:'active-drafts'|'invalid-drafts'|'drafts-changed';activeDrafts:number};
export class EpochCompactionError extends Error {
 readonly code:'not-retired';
 constructor(){super('An existing retired epoch tombstone is required before receipt detail compaction.');this.name='EpochCompactionError';this.code='not-retired';}
}
/** Explicit internal maintenance only. Never retires an epoch, removes its tombstone, or touches legacy IDs. */
export async function compactRetiredEpoch(db:SqlDatabase,userId:string,epoch:string,now=new Date().toISOString()):Promise<EpochCompactionResult>{
 owner(userId);timestamp(now);if(!MUTATION_EPOCH_PATTERN.test(epoch))throw new MutationEpochError('invalid-id','The mutation epoch is invalid.');
 const clock=new Date(now).toISOString();
 const retired=async()=> (await db.prepare('SELECT status FROM workspace_mutation_epochs WHERE user_id=? AND epoch=?').bind(userId,epoch).first<{status:string}>())?.status==='retired';
 if(!await retired())throw new EpochCompactionError();
 const draftRows=(await db.prepare('SELECT id,row_revision,payload_json,expires_at FROM workspace_drafts WHERE user_id=? AND expires_at>? ORDER BY id').bind(userId,clock).all<{id:string;row_revision:number;payload_json:string;expires_at:string}>()).results;
 let references=0,invalid=0;
 for(const row of draftRows){try{const draft=validateDraft(JSON.parse(row.payload_json));if(draft.id!==row.id || draft.expiresAt!==row.expires_at)throw new Error('Draft metadata differs.');if(draft.mutationId && mutationEpoch(draft.mutationId)===epoch)references++;}catch{invalid++;}}
 if(invalid)return {status:'blocked',reason:'invalid-drafts',activeDrafts:invalid};
 if(references)return {status:'blocked',reason:'active-drafts',activeDrafts:references};
 const snapshot=JSON.stringify(draftRows);if(new TextEncoder().encode(snapshot).byteLength>1_800_000)return {status:'blocked',reason:'drafts-changed',activeDrafts:draftRows.length};
 const marker=`compact_${crypto.randomUUID()}`;const prefix=`m1_${epoch}_`;
 const gate=`EXISTS (SELECT 1 FROM workspace_assertions WHERE user_id=? AND mutation_id=?)`;
 // The row-set assertion closes additions/changes between schema parsing and deletion.
 // Malformed JSON and matching references are independently rejected in the same transaction.
 const results=await db.batch([
  db.prepare(`INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,1
   WHERE EXISTS (SELECT 1 FROM workspace_mutation_epochs WHERE user_id=? AND epoch=? AND status='retired')
   AND NOT EXISTS (SELECT 1 FROM workspace_drafts WHERE user_id=? AND expires_at>? AND CASE WHEN json_valid(payload_json)=0 THEN 1 ELSE (json_type(payload_json,'$.mutationId')='text' AND length(json_extract(payload_json,'$.mutationId'))=68 AND substr(json_extract(payload_json,'$.mutationId'),1,36)=? AND substr(json_extract(payload_json,'$.mutationId'),37) NOT GLOB '*[^0-9a-f]*') END)
   AND (SELECT COUNT(*) FROM workspace_drafts WHERE user_id=? AND expires_at>?)=?
   AND NOT EXISTS (SELECT id,row_revision,payload_json,expires_at FROM workspace_drafts WHERE user_id=? AND expires_at>? EXCEPT SELECT json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.payload_json'),json_extract(value,'$.expires_at') FROM json_each(?))`).bind(userId,marker,userId,epoch,userId,clock,prefix,userId,clock,draftRows.length,userId,clock,snapshot),
  db.prepare(`DELETE FROM workspace_mutations WHERE user_id=? AND length(mutation_id)=68 AND substr(mutation_id,1,36)=? AND substr(mutation_id,37) NOT GLOB '*[^0-9a-f]*' AND EXISTS (SELECT 1 FROM workspace_mutation_epochs WHERE user_id=? AND epoch=? AND status='retired') AND ${gate}`).bind(userId,prefix,userId,epoch,userId,marker),
  db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(userId,marker),
 ]);
 if(results[0]?.meta.changes!==1){
  if(!await retired())throw new EpochCompactionError();
  // A concurrent draft write is a safe block, never permission to retry automatically.
  const current=(await db.prepare('SELECT payload_json FROM workspace_drafts WHERE user_id=? AND expires_at>?').bind(userId,clock).all<{payload_json:string}>()).results;
  let matching=0,malformed=0;for(const row of current){try{const draft=validateDraft(JSON.parse(row.payload_json));if(draft.mutationId && mutationEpoch(draft.mutationId)===epoch)matching++;}catch{malformed++;}}
  return {status:'blocked',reason:malformed?'invalid-drafts':matching?'active-drafts':'drafts-changed',activeDrafts:malformed||matching||current.length};
 }
 return {status:'compacted',removed:results[1]?.meta.changes??0};
}
