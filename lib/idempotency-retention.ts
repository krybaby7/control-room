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
