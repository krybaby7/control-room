import {z} from 'zod';
import {assertPortable,BUNDLE_LIMITS,canonical,contentHash} from './workspace-export.ts';
import {canonicalJsonValue,parseAuditEvent} from './audit-events.ts';
import type {JsonValue} from './workspace-protocol.ts';
const sourceId=z.string().min(1).max(160).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value));
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const namespace=z.string().uuid().transform(value=>value.toLowerCase());
const envelopeSchema=z.object({historicalAudit:z.object({version:z.literal(1),namespace:namespace.nullable(),eventId:sourceId,payloadHash:digest}).strict(),sourceClaim:z.unknown()}).strict();
export interface HistoricalAuditRow {id:string;source:JsonValue;importHash:string;sourceIdentity:string;sourceHash:string}
const columns=new Set(['id','event_id','workspace_revision','ordinal','stream_id','stream_sequence','kind','entity_type','entity_id','occurred_at','payload']);
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function portableActors(value:unknown):unknown {if(Array.isArray(value))return value.map(portableActors);if(object(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='actorId'?'owner':portableActors(item)]));return value;}
function portableRow(value:unknown):{row:Record<string,unknown>;eventId:string}{
 value=canonicalJsonValue(value);assertPortable(value);if(!object(value)||Object.keys(value).some(key=>!columns.has(key))||!object(value.payload))throw new Error('Invalid portable audit record.');
 const eventId=sourceId.parse(value.id??value.event_id);if(value.id!==undefined&&value.id!==eventId||value.event_id!==undefined&&value.event_id!==eventId)throw new Error('Audit event identities differ.');
 if(value.payload.id!==undefined&&sourceId.parse(value.payload.id)!==eventId)throw new Error('Audit payload identity differs.');
 return {row:JSON.parse(JSON.stringify(value)) as Record<string,unknown>,eventId};
}
/** Claims retain provenance only. Neither namespaces nor imported event fields confer execution authority. */
export async function prepareHistoricalAuditRows(records:unknown[],auditNamespace:string|null,importHash:string):Promise<HistoricalAuditRow[]>{
 if(!Array.isArray(records)||records.length>BUNDLE_LIMITS.rows)throw new Error('Imported audit row limit exceeded.');digest.parse(importHash);const sourceNamespace=auditNamespace===null?null:namespace.parse(auditNamespace);
 const output:HistoricalAuditRow[]=[];const identities=new Map<string,string>();
 for(const record of records){
  const input=portableRow(record);let original=portableActors(input.row) as Record<string,unknown>,eventId=input.eventId,originNamespace=sourceNamespace;
  if(input.row.kind==='imported-history'&&(input.row.payload as Record<string,unknown>).kind==='imported-history'&&Array.isArray((input.row.payload as Record<string,unknown>).changes)&&((input.row.payload as Record<string,unknown>).changes as unknown[]).some(change=>object(change)&&object(change.after)&&object(change.after.value)&&Object.hasOwn(change.after.value,'historicalAudit'))){
   const event=parseAuditEvent(input.row.payload);const claims=event.changes.filter(change=>change.path.length===1&&change.path[0]==='sourceClaim'&&change.after.exists);
   const explicit=claims.filter(change=>object(change.after.value)&&Object.hasOwn(change.after.value,'historicalAudit'));
   if(explicit.length){
    if(event.entityType!=='historical-claim'||event.entityId!==null||claims.length!==1||explicit.length!==1)throw new Error('Ambiguous historical audit provenance.');
    const envelope=envelopeSchema.parse(explicit[0].after.value);const source=portableRow(envelope.sourceClaim);
    if(canonical(portableActors(source.row))!==canonical(source.row))throw new Error('Historical audit provenance contains nonportable actor attribution.');
    if(source.eventId!==envelope.historicalAudit.eventId||await contentHash(canonical(source.row))!==envelope.historicalAudit.payloadHash)throw new Error('Historical audit provenance digest or identity differs.');
    original=source.row;eventId=source.eventId;originNamespace=envelope.historicalAudit.namespace;
   }
  }
  const sourceHash=await contentHash(canonical(original));
  const sourceIdentity=originNamespace===null?`legacy-unknown:${sourceHash}`:`audit:${originNamespace}:${eventId}`;
  const existing=identities.get(sourceIdentity);if(existing){if(existing!==sourceHash)throw new Error('Conflicting payloads for the same historical audit identity.');continue;}identities.set(sourceIdentity,sourceHash);
  const source={historicalAudit:{version:1,namespace:originNamespace,eventId,payloadHash:sourceHash},sourceClaim:original} as JsonValue;
  output.push({id:`history_${await contentHash(sourceIdentity)}`,source,importHash,sourceIdentity,sourceHash});
 }
 return output;
}
