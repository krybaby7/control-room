import {z} from 'zod';
import {canonical} from './canonical-json.ts';
import type {AuditEventDraft,JsonValue} from './workspace-protocol.ts';
export type {AuditEventDraft,ChangeValue,JsonValue} from './workspace-protocol.ts';
export type FieldChange=AuditEventDraft['changes'][number];
const jsonSchema:z.ZodType<JsonValue>=z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(jsonSchema),z.record(jsonSchema)]));
const id=z.string().min(1).max(128);
const field=z.string().min(1).max(128).refine(value=>!['__proto__','prototype','constructor'].includes(value),'Unsafe event path.');
export const changeValueSchema=z.object({exists:z.boolean(),value:jsonSchema}).strict().refine(value=>value.exists||value.value===null,'Absent fields must encode null.');
export const fieldChangeSchema=z.object({path:z.array(field).min(1).max(40),before:changeValueSchema,after:changeValueSchema}).strict();
export const auditEventSchema:z.ZodType<AuditEventDraft>=z.object({id,kind:z.string().min(1).max(160),entityType:z.string().min(1).max(80),entityId:id.nullable(),changes:z.array(fieldChangeSchema).max(2000),origin:z.enum(['owner','connector','migration','system']),actorId:z.string().min(1).max(256),occurredAt:z.string().datetime({offset:true}),sourceRef:z.string().max(2048).nullable(),undoOf:id.nullable()}).strict();
export function canonicalJsonValue(value:unknown,depth=0):JsonValue {
 if(depth>40)throw new Error('Audit JSON nesting exceeds limit.');
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value))return value.map(item=>canonicalJsonValue(item,depth+1));
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('Audit values must be plain JSON.');
 const result:Record<string,JsonValue>={};for(const key of Object.keys(value).sort()){if(['__proto__','constructor','prototype'].includes(key))throw new Error('Unsafe audit JSON field.');const descriptor=Object.getOwnPropertyDescriptor(value,key)!;if(!('value'in descriptor))throw new Error('Audit values cannot invoke accessors.');result[key]=canonicalJsonValue(descriptor.value,depth+1);}return result;
}
export function parseAuditEvent(value:unknown):AuditEventDraft {const plain=canonicalJsonValue(value);if(new TextEncoder().encode(canonical(plain)).length>2_000_000)throw new Error('Audit event exceeds byte limit.');return auditEventSchema.parse(plain);}
/** Arrays are atomic; object insertion order is irrelevant; missing and explicit null remain distinct. */
export function topLevelChanges(before:Record<string,JsonValue>,after:Record<string,JsonValue>):FieldChange[]{
 const previous=canonicalJsonValue(before),next=canonicalJsonValue(after);if(!previous||!next||Array.isArray(previous)||Array.isArray(next)||typeof previous!=='object'||typeof next!=='object')throw new Error('Field diffs require JSON objects.');
 return [...new Set([...Object.keys(previous),...Object.keys(next)])].sort().flatMap(key=>{const left=Object.hasOwn(previous,key)?{exists:true,value:previous[key]}:{exists:false,value:null};const right=Object.hasOwn(next,key)?{exists:true,value:next[key]}:{exists:false,value:null};return canonical(left)===canonical(right)?[]:[{path:[key],before:left,after:right}];});
}
