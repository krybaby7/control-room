import {privateCapacityGuard,privateRowGrowth} from './private-capacity.ts';
import {z} from 'zod';
import type {SqlDatabase,SqlStatement} from './workspace-store.ts';
import {ATTACHMENT_POLICY} from './attachment-policy.ts';
import {attachmentPriorGenerationSql} from './attachment-generation.ts';
import {attachmentStorageKey} from './attachments.ts';
export const ARCHIVE_RESERVATION_LIMITS=Object.freeze({activeStages:8,manifestBytes:8_000_000,ttlMs:3_600_000});
const ownerSchema=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
const uuid=z.string().uuid().refine(value=>value===value.toLowerCase());
const generatedUuid=uuid.refine(value=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const stamp=z.string().datetime({offset:true}).refine(value=>{try{return Number.isFinite(Date.parse(value))&&new Date(`${value.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)===value.slice(0,10);}catch{return false;}});
const recordSchema=z.object({id:uuid,bytes:z.number().int().nonnegative().max(ATTACHMENT_POLICY.fileBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const reservationSchema=z.object({stageId:generatedUuid,namespace:generatedUuid,sourceManifestHash:z.string().regex(/^[a-f0-9]{64}$/),manifestJson:z.string().max(ARCHIVE_RESERVATION_LIMITS.manifestBytes),createdAt:stamp,expiresAt:stamp,targetRevision:z.number().int().positive().safe(),records:z.array(recordSchema).max(ATTACHMENT_POLICY.ownerFiles)}).strict().superRefine((value,context)=>{
 const ttl=Date.parse(value.expiresAt)-Date.parse(value.createdAt);if(ttl<=0||ttl>ARCHIVE_RESERVATION_LIMITS.ttlMs)context.addIssue({code:'custom',message:'Archive expiry must be within one hour of the trusted server clock.'});
 if(value.stageId===value.namespace)context.addIssue({code:'custom',message:'Stage and blob namespace must be independently generated.'});
 if(new Set(value.records.map(row=>row.id)).size!==value.records.length)context.addIssue({code:'custom',message:'Archive attachment identities must be unique.'});
 if(new TextEncoder().encode(value.manifestJson).byteLength>ARCHIVE_RESERVATION_LIMITS.manifestBytes)context.addIssue({code:'custom',message:'Archive manifest exceeds byte limit.'});
 try{const manifest:unknown=JSON.parse(value.manifestJson);if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw new Error();}catch{context.addIssue({code:'custom',message:'Archive manifest must contain a JSON object.'});}
});
export type ArchiveObjectReservation=z.infer<typeof reservationSchema>;
export interface PhysicalAttachmentUsage {bytes:number;files:number}
export class ArchiveObjectReservationError extends Error{readonly code='archive_reservation_rejected';constructor(){super('Archive reservation could not be admitted. Refresh the workspace and check physical storage capacity or cleanup status.');this.name='ArchiveObjectReservationError';}}
/** Read-only aggregate: expired stages and retired metadata remain charged until bytes are purged.
 * Over-limit usage is reported honestly; reservation admission enforces the configured limits.
 */
export async function readPhysicalAttachmentUsage(db:SqlDatabase,userId:string):Promise<PhysicalAttachmentUsage>{
 const owner=ownerSchema.parse(userId);const row=await db.prepare('SELECT COUNT(*) AS files,COALESCE(SUM(bytes),0) AS bytes,COALESCE(SUM(CASE WHEN typeof(bytes)<>\'integer\' OR bytes<0 THEN 1 ELSE 0 END),0) AS invalid FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL').bind(owner).first<{bytes:number;files:number;invalid:number}>();
 if(!row||row.invalid!==0||!Number.isSafeInteger(row.files)||row.files<0||!Number.isSafeInteger(row.bytes)||row.bytes<0)throw new Error('Physical attachment usage is unavailable.');return {bytes:row.bytes,files:row.files};
}
/** Internal server helper. The authenticated caller must generate stageId/namespace with crypto.randomUUID
 * and supply its trusted current clock; UUID syntax is not proof of server generation.
 * No blob writes, verification, import acceptance, planning mutation or receipt are performed here.
 */
export async function reserveArchiveObjects(db:SqlDatabase,userId:string,input:ArchiveObjectReservation):Promise<{stageId:string;namespace:string;records:Array<{id:string;storageKey:string;bytes:number;sha256:string}>;usage:PhysicalAttachmentUsage}>{
 const owner=ownerSchema.parse(userId),value=reservationSchema.parse(input),records=value.records.map(row=>({...row,storageKey:attachmentStorageKey(value.namespace,row.id)}));const requestedBytes=records.reduce((total,row)=>total+row.bytes,0);if(requestedBytes>ATTACHMENT_POLICY.ownerBytes)throw new ArchiveObjectReservationError();
 const payload=JSON.stringify(records.map(row=>({storageKey:row.storageKey,id:row.id,bytes:row.bytes,sha256:row.sha256})));
 const objectGrowth=records.map(row=>privateRowGrowth('attachment_blob_objects',null,{storage_key:row.storageKey,attachment_id:row.id,namespace:value.namespace,bytes:row.bytes,sha256:row.sha256,created_at:value.createdAt,verified_at:null,purged_at:null}));
 const growth=[{table:'attachment_blob_objects' as const,bytes:objectGrowth.reduce((sum,row)=>sum+row.bytes,0),rows:objectGrowth.length},privateRowGrowth('attachment_blob_namespaces',null,{namespace:value.namespace,created_at:value.createdAt,purpose:'archive-stage',source_import_id:null})];
 const capacity=await privateCapacityGuard(db,owner,{growth});
 const assertionId=`archive-reservation-${crypto.randomUUID()}`,statements:SqlStatement[]=[];
 const assert=(condition:string,params:(string|number|null)[])=>statements.push(db.prepare(`INSERT INTO workspace_assertions(user_id,mutation_id,valid) VALUES(?,?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`).bind(owner,assertionId,...params));
 assert(capacity.sql,capacity.bindings);
 assert('EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?)',[owner,value.targetRevision]);
 assert('NOT EXISTS(SELECT 1 FROM attachment_archive_stages WHERE user_id=? AND id=?)',[owner,value.stageId]);
 // A namespace addresses physical keys in the shared private bucket; never reuse it for another owner.
 for(const [table,column]of [['attachment_blob_namespaces','namespace'],['attachment_archive_stages','namespace'],['attachment_blob_objects','namespace'],['attachment_blob_fences','namespace'],['attachment_archive_cleanup_claims','namespace'],['workspace_source_namespaces','blob_namespace']]as const)assert(`NOT EXISTS(SELECT 1 FROM ${table} WHERE ${column}=?)`,[value.namespace]);
 assert('NOT EXISTS(SELECT 1 FROM attachments WHERE storage_key LIKE ?)',[`attachments/${value.namespace}/%`]);
 assert("(SELECT COUNT(*) FROM attachment_archive_stages WHERE user_id=? AND status IN ('preparing','verified') AND expires_at>?) < ?",[owner,value.createdAt,ARCHIVE_RESERVATION_LIMITS.activeStages]);
 assert("NOT EXISTS(SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL AND (typeof(bytes)<>'integer' OR bytes<0)) AND (SELECT COUNT(*) FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL)+?<=? AND (SELECT COALESCE(SUM(bytes),0) FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL)+?<=?",[owner,owner,records.length,ATTACHMENT_POLICY.ownerFiles,owner,requestedBytes,ATTACHMENT_POLICY.ownerBytes]);
 const prior=attachmentPriorGenerationSql({owner:'reservation_owner.owner',attachmentId:"json_extract(r.value,'$.id')",storageKey:"json_extract(r.value,'$.storageKey')",bytes:"json_extract(r.value,'$.bytes')",sha256:"json_extract(r.value,'$.sha256')"});
 assert(`NOT EXISTS(SELECT 1 FROM json_each(?) r CROSS JOIN (SELECT ? AS owner) reservation_owner WHERE NOT ${prior})`,[payload,owner]);
 // No generation may revive an exact fenced key, even after definitive purge.
 assert("NOT EXISTS(SELECT 1 FROM json_each(?) r JOIN attachment_blob_fences f ON f.storage_key=json_extract(r.value,'$.storageKey'))",[payload]);
 for(const table of ['attachment_blob_objects','attachments']as const)assert(`NOT EXISTS(SELECT 1 FROM json_each(?) r JOIN ${table} existing ON existing.storage_key=json_extract(r.value,'$.storageKey'))`,[payload]);
 statements.push(db.prepare("INSERT INTO attachment_archive_stages(user_id,id,namespace,source_manifest_hash,manifest_json,created_at,expires_at,target_revision,status,import_id,import_hash) VALUES(?,?,?,?,?,?,?,?,'preparing',NULL,NULL)").bind(owner,value.stageId,value.namespace,value.sourceManifestHash,value.manifestJson,value.createdAt,value.expiresAt,value.targetRevision));
 statements.push(db.prepare("INSERT INTO attachment_blob_namespaces(user_id,namespace,created_at,purpose,source_import_id) VALUES(?,?,?,'archive-stage',NULL)").bind(owner,value.namespace,value.createdAt));
 // One bounded payload avoids hundreds of independently admitted object inserts.
 statements.push(db.prepare("INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) SELECT ?,json_extract(value,'$.storageKey'),json_extract(value,'$.id'),?,json_extract(value,'$.bytes'),json_extract(value,'$.sha256'),?,NULL,NULL FROM json_each(?)").bind(owner,value.namespace,value.createdAt,payload));
 statements.push(db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(owner,assertionId));
 try{await db.batch(statements);}catch{throw new ArchiveObjectReservationError();}
 return {stageId:value.stageId,namespace:value.namespace,records,usage:await readPhysicalAttachmentUsage(db,owner)};
}
