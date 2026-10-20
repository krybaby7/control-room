import type {SqlDatabase} from './workspace-store.ts';
import {parseAuditEvent} from './audit-events.ts';
import type {AuditEventDraft} from './workspace-protocol.ts';
export interface AuditCommandGroup {events:AuditEventDraft[];mutationId:string}
/** Immutable owner command groups only. Operational streams and imported claims never become undo authority. */
export async function readAuditCommandGroup(db:SqlDatabase,userId:string,eventId:string):Promise<AuditCommandGroup|null>{
 if(!userId||!eventId||eventId.length>128)throw new Error('A valid owner history target is required.');
 const source=await db.prepare('SELECT workspace_revision FROM audit_events WHERE user_id=? AND event_id=?').bind(userId,eventId).first<{workspace_revision:number|null}>();
 if(!source||source.workspace_revision===null||!Number.isSafeInteger(source.workspace_revision)||source.workspace_revision<1)return null;
 const receipt=await db.prepare('SELECT mutation_id FROM workspace_mutations WHERE user_id=? AND revision=? LIMIT 2').bind(userId,source.workspace_revision).all<{mutation_id:string}>();
 if(receipt.results.length!==1)return null;
 const metadata=(await db.prepare('SELECT event_id,ordinal,length(CAST(payload_json AS BLOB)) AS bytes FROM audit_events WHERE user_id=? AND workspace_revision=? ORDER BY ordinal LIMIT 201').bind(userId,source.workspace_revision).all<{event_id:string;ordinal:number;bytes:number}>()).results;
 if(!metadata.length||metadata.length>200||metadata.some((row,index)=>row.ordinal!==index||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>2_000_000)||metadata.reduce((sum,row)=>sum+row.bytes,0)>8_000_000)throw new Error('History command exceeds undo bounds.');
 const events:AuditEventDraft[]=[];
 for(const row of metadata){const raw=await db.prepare('SELECT payload_json,kind,entity_type,entity_id,occurred_at,origin,actor_id,source_ref,undo_of FROM audit_events WHERE user_id=? AND event_id=?').bind(userId,row.event_id).first<{payload_json:string;kind:string;entity_type:string;entity_id:string|null;occurred_at:string;origin:string|null;actor_id:string|null;source_ref:string|null;undo_of:string|null}>();if(!raw)throw new Error('Immutable history is unavailable.');const event=parseAuditEvent(JSON.parse(raw.payload_json));if(event.kind!==raw.kind||event.entityType!==raw.entity_type||event.entityId!==raw.entity_id||Date.parse(event.occurredAt)!==Date.parse(raw.occurred_at)||raw.origin!==null&&event.origin!==raw.origin||raw.actor_id!==null&&event.actorId!==raw.actor_id||raw.source_ref!==null&&event.sourceRef!==raw.source_ref||raw.undo_of!==null&&event.undoOf!==raw.undo_of)throw new Error('History attribution differs from its immutable metadata.');if(event.id!==row.event_id||event.actorId!==userId||event.origin!=='owner'||event.kind==='imported-history')throw new Error('History is not an undoable owner command.');events.push(event);}
 return {events,mutationId:receipt.results[0].mutation_id};
}
