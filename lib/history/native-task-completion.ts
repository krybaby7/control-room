import type {SqlDatabase} from '../workspace-store.ts';
import type {Workspace} from '../types.ts';
import {parseAuditEvent} from '../audit-events.ts';
import {mutationEpoch} from '../idempotency-retention.ts';
/** Current native owner completion only. Historical/imported done labels remain
 * unchanged, but are not an acceptance grant. Pruned or pre-restore receipts
 * conservatively become unknown rather than fabricating portable authority. */
export async function nativeCompletedTaskIds(db:SqlDatabase,owner:string,workspace:Workspace):Promise<Set<string>>{
 if(!owner)throw Error('Authenticated completion owner required.');const tasks=workspace.tasks.filter(task=>task.status==='done'&&task.completedAt!==null);if(!tasks.length||tasks.length>2000)return new Set();
 const rows=(await db.prepare("WITH eligible AS MATERIALIZED(SELECT a.event_id,a.kind,a.entity_id,a.occurred_at,length(CAST(a.payload_json AS BLOB)) payload_bytes,m.mutation_id,m.committed_at,e.epoch FROM audit_events a JOIN workspace_mutations m ON m.user_id=a.user_id AND m.revision=a.workspace_revision JOIN workspace_mutation_epochs e ON e.user_id=m.user_id AND e.status='active' AND substr(m.mutation_id,1,36)='m1_'||e.epoch||'_' JOIN json_each(?) target ON json_extract(target.value,'$.id')=a.entity_id AND json_extract(target.value,'$.completedAt')=a.occurred_at WHERE a.user_id=? AND a.entity_type='task' AND a.kind IN('task.create','task.update') AND a.origin='owner' AND a.actor_id=? AND a.workspace_revision IS NOT NULL AND a.occurred_at=m.committed_at AND ((SELECT restored_at FROM workspace_execution_state WHERE user_id=a.user_id) IS NULL OR julianday(m.committed_at)>julianday((SELECT restored_at FROM workspace_execution_state WHERE user_id=a.user_id))) ORDER BY a.workspace_revision,a.ordinal LIMIT 4001), bounded AS MATERIALIZED(SELECT 1 WHERE (SELECT COUNT(*) FROM eligible)<=4000 AND (SELECT COALESCE(SUM(payload_bytes),0) FROM eligible)<=8388608) SELECT eligible.event_id,eligible.kind,eligible.entity_id,eligible.occurred_at,eligible.mutation_id,eligible.committed_at,eligible.epoch,a.payload_json FROM eligible JOIN audit_events a ON a.event_id=eligible.event_id AND a.user_id=? WHERE EXISTS(SELECT 1 FROM bounded)").bind(JSON.stringify(tasks.map(task=>({id:task.id,completedAt:task.completedAt}))),owner,owner,owner).all<{event_id:string;kind:string;entity_id:string;occurred_at:string;payload_json:string;mutation_id:string;committed_at:string;epoch:string}>()).results;
 if(rows.length>4000)return new Set();const result=new Set<string>();let bytes=0;
 for(const row of rows){if((bytes+=new TextEncoder().encode(row.payload_json).length)>8*1024*1024)return new Set();try{
  if(mutationEpoch(row.mutation_id)!==row.epoch)continue;const event=parseAuditEvent(JSON.parse(row.payload_json));if(event.id!==row.event_id||event.kind!==row.kind||event.entityType!=='task'||event.entityId!==row.entity_id||event.origin!=='owner'||event.actorId!==owner||event.occurredAt!==row.occurred_at)continue;
  const task=tasks.find(task=>task.id===row.entity_id);if(!task)continue;
  const change=event.changes.find(change=>change.path.length===2&&change.path[0]==='tasks'&&change.path[1]===task.id);if(!change?.after.exists||!change.after.value||typeof change.after.value!=='object'||Array.isArray(change.after.value))continue;
  const after=change.after.value,before=change.before.value;if(after.id!==task.id||after.status!=='done'||after.completedAt!==task.completedAt)continue;
  if(event.kind==='task.create'&&change.before.exists||event.kind==='task.update'&&(!change.before.exists||!before||typeof before!=='object'||Array.isArray(before)||before.status==='done'))continue;
  result.add(task.id);
 }catch{/* Corrupt or non-native provenance cannot accept a task. */}}
 return result;
}
