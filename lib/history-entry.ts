import {z} from 'zod';
import type {SqlDatabase} from './workspace-store.ts';
import type {HistoryEntry} from './history.ts';
import {canonicalJsonValue,parseAuditEvent,type AuditEventDraft} from './audit-events.ts';
const id=z.string().min(1).max(128).refine(value=>value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value),'A safe exact history ID is required.');
const stamp=z.string().datetime({offset:true}),origin=z.enum(['owner','connector','migration','system']);
export const HISTORY_ENTRY_ROW_BYTES=2_000_000;
interface Metadata {event_id:string;workspace_revision:number|null;ordinal:number|null;stream_id:string|null;stream_sequence:number|null;kind:string;entity_type:string;entity_id:string|null;occurred_at:string;origin:string|null;actor_id:string|null;source_ref:string|null;undo_of:string|null;payload_bytes:number}
/** Exact immutable owner event lookup. Legacy source claims never become current identity or undo authority. */
export async function readHistoryEntry(db:SqlDatabase,userId:string,eventId:string):Promise<HistoryEntry|null>{
 if(typeof userId!=='string'||!userId.trim())throw new Error('An authenticated owner is required.');id.parse(eventId);
 const row=await db.prepare('SELECT event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,origin,actor_id,source_ref,undo_of,length(CAST(payload_json AS BLOB)) AS payload_bytes FROM audit_events WHERE user_id=? AND event_id=?').bind(userId,eventId).first<Metadata>();
 if(!row)return null;
 if(!Number.isSafeInteger(row.payload_bytes)||row.payload_bytes<0||row.payload_bytes>HISTORY_ENTRY_ROW_BYTES)throw new Error('History event exceeds byte limit.');
 const stored=await db.prepare('SELECT payload_json FROM audit_events WHERE user_id=? AND event_id=? AND length(CAST(payload_json AS BLOB))<=?').bind(userId,eventId,HISTORY_ENTRY_ROW_BYTES).first<{payload_json:string}>();
 if(!stored)throw new Error('Immutable history event is unavailable.');
 if(new TextEncoder().encode(stored.payload_json).byteLength>HISTORY_ENTRY_ROW_BYTES)throw new Error('History event exceeds byte limit.');
 const payload=canonicalJsonValue(JSON.parse(stored.payload_json));let event:AuditEventDraft|null=null;
 try{event=parseAuditEvent(payload);}catch{/* Match timeline semantics: retain legacy summaries without fabricated diffs. */}
 if(!id.safeParse(row.event_id).success||row.event_id!==eventId||!stamp.safeParse(row.occurred_at).success)throw new Error('Invalid stored history metadata.');
 if(event&&((row.origin!==null&&row.origin!==event.origin)||(row.actor_id!==null&&row.actor_id!==event.actorId)||(row.source_ref!==null&&row.source_ref!==event.sourceRef)||(row.undo_of!==null&&row.undo_of!==event.undoOf)))throw new Error('Stored audit metadata differs.');
 if(event&&(event.id!==row.event_id||event.kind!==row.kind||event.entityType!==row.entity_type||event.entityId!==row.entity_id||Date.parse(event.occurredAt)!==Date.parse(row.occurred_at)))throw new Error('Stored audit event attribution differs.');
 const eventOrigin=row.origin??event?.origin??null;if(eventOrigin!==null&&!origin.safeParse(eventOrigin).success)throw new Error('Invalid stored history origin.');
 return {id:row.event_id,workspaceRevision:row.workspace_revision,ordinal:row.ordinal,streamId:row.stream_id,streamSequence:row.stream_sequence,kind:row.kind,entityType:row.entity_type,entityId:row.entity_id,occurredAt:row.occurred_at,origin:eventOrigin as HistoryEntry['origin'],actorId:row.actor_id??event?.actorId??null,sourceRef:row.source_ref??event?.sourceRef??null,undoOf:row.undo_of??event?.undoOf??null,event,sourcePayload:event?null:payload};
}
