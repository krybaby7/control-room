import {privateCapacityGuard,privateRowGrowth} from './private-capacity.ts';
import type {DeviceSqlGuard} from './devices/auth.ts';
import {isAdmittedAttachmentGeneration} from './attachment-generation.ts';
import {z} from 'zod';
import type {SqlDatabase} from './workspace-store.ts';
import type {AttachmentRecord} from './evidence-contract.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {attachmentStorageKey} from './attachments.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {evidenceDateSchema} from './evidence-validation.ts';
const uuid=z.string().uuid();
function owner(value:string):void{if(typeof value!=='string'||!value.trim()||value.length>256)throw new Error('An authenticated owner is required.');}
export interface BeginAttachmentUpload {record:AttachmentRecord;rowRevision:number;now:string;ownerNamespace:string}
/**
 * Creates a persistent pending attempt atomically with checking reservation authority.
 * The caller MUST acquire this before any potentially writing blob operation, and MUST
 * retain it when a put may still be running. Pending attempts never expire by clock.
 * A cleanup claim must atomically assert absence of pending attempts by key OR ID.
 */
export async function beginUpload(db:SqlDatabase,userId:string,input:BeginAttachmentUpload,trustedGuard?:DeviceSqlGuard):Promise<string|null>{
 owner(userId);const record=attachmentRecordSchema.parse(input.record);uuid.parse(record.id);uuid.parse(input.ownerNamespace);evidenceDateSchema.parse(input.now);
 if(!Number.isSafeInteger(input.rowRevision)||input.rowRevision<1)throw new Error('A positive attachment row revision is required.');
 const key=attachmentStorageKey(input.ownerNamespace,record.id);
 if(record.storageKey!==key||record.status!=='reserved'||Date.parse(record.expiresAt)<=Date.parse(input.now))return null;
 const hash=await contentHash(canonical(record)),token=crypto.randomUUID();
 const capacity=await privateCapacityGuard(db,userId,{newPendingPuts:1,growth:[privateRowGrowth('attachment_upload_attempts',null,{token,attachment_id:record.id,storage_key:key,created_at:input.now,settled_at:null})]});
 // Keep the already-verified trusted authority in its own materialized expression
 // tree. D1's depth100 limit applies even when total bindings are below100;
 // both proofs still execute in this same guarded persistent-attempt INSERT.
 const result=await db.prepare(`WITH upload_private_capacity AS MATERIALIZED(SELECT ${capacity.sql} AS valid), upload_device_authority AS MATERIALIZED(SELECT (${trustedGuard?.sql??'1'}) AS valid) INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at)
 SELECT ?,?,?,?,?,NULL WHERE EXISTS (
 SELECT 1 FROM attachments a JOIN workspace_source_namespaces n ON n.user_id=a.user_id
 WHERE a.user_id=? AND a.id=? AND a.row_revision=? AND a.content_hash=?
 AND n.blob_namespace=? AND json_valid(a.payload_json)
 AND json_extract(a.payload_json,'$.id')=? AND json_extract(a.payload_json,'$.status')='reserved'
 AND json_extract(a.payload_json,'$.storageKey')=? AND julianday(json_extract(a.payload_json,'$.expiresAt'))>julianday(?)
 ) AND EXISTS (SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.storage_key=? AND o.attachment_id=? AND o.namespace=? AND o.bytes=? AND o.purged_at IS NULL) AND NOT EXISTS (SELECT 1 FROM attachment_blob_fences f WHERE f.user_id=? AND (f.storage_key=? OR f.attachment_id=?)) AND EXISTS(SELECT 1 FROM upload_device_authority WHERE valid=1) AND EXISTS(SELECT 1 FROM upload_private_capacity WHERE valid=1)`)
 .bind(...capacity.bindings,...(trustedGuard?.bindings??[]),userId,token,record.id,key,input.now,userId,record.id,input.rowRevision,hash,input.ownerNamespace,record.id,key,input.now,userId,key,record.id,input.ownerNamespace,record.expectedBytes,userId,key,record.id).run();
 return result.meta.changes===1?token:null;
}
export interface FinishAttachmentUpload {token:string;now:string;definitivelySettled:boolean}
/**
 * `true` is a caller assertion that EVERY potentially writing operation definitively
 * settled, including work continuing after abort/timeout. Error/timeout alone is not
 * proof. An unresolved attempt survives process crashes and must not be time-expired.
 * This does not finalize attachment metadata or release quota.
 */
export async function finishUpload(db:SqlDatabase,userId:string,input:FinishAttachmentUpload):Promise<boolean>{
 owner(userId);uuid.parse(input.token);evidenceDateSchema.parse(input.now);if(input.definitivelySettled!==true)return false;
 const before=await db.prepare('SELECT token,attachment_id,storage_key,created_at,settled_at FROM attachment_upload_attempts WHERE user_id=? AND token=? AND settled_at IS NULL').bind(userId,input.token).first<{token:string;attachment_id:string;storage_key:string;created_at:string;settled_at:null}>();if(!before)return false;
 const capacity=await privateCapacityGuard(db,userId,{settlingPendingPuts:1,growth:[privateRowGrowth('attachment_upload_attempts',before,{...before,settled_at:input.now})]});
 const result=await db.prepare(`UPDATE attachment_upload_attempts SET settled_at=? WHERE user_id=? AND token=? AND settled_at IS NULL AND julianday(created_at)<=julianday(?) AND (${capacity.sql})`).bind(input.now,userId,input.token,input.now,...capacity.bindings).run();
 return result.meta.changes===1;
}
/** Read-only convenience check; never substitutes for the atomic begin/cleanup guards. */
export async function isBlobFenced(db:SqlDatabase,userId:string,input:{attachmentId:string;storageKey:string}):Promise<boolean>{
 owner(userId);uuid.parse(input.attachmentId);if(typeof input.storageKey!=='string'||input.storageKey.length<1||input.storageKey.length>500)throw new Error('A bounded attachment key is required.');
 if(await db.prepare('SELECT token FROM attachment_blob_fences WHERE user_id=? AND storage_key=? LIMIT 1').bind(userId,input.storageKey).first())return true;
 if(!await db.prepare('SELECT token FROM attachment_blob_fences WHERE user_id=? AND attachment_id=? LIMIT 1').bind(userId,input.attachmentId).first())return false;
 const object=await db.prepare('SELECT bytes,sha256 FROM attachment_blob_objects WHERE user_id=? AND storage_key=? AND attachment_id=? AND verified_at IS NOT NULL AND purged_at IS NULL').bind(userId,input.storageKey,input.attachmentId).first<{bytes:number;sha256:string|null}>();
 return !object?.sha256||!await isAdmittedAttachmentGeneration(db,userId,{...input,bytes:object.bytes,sha256:object.sha256});
}
