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
export async function beginUpload(db:SqlDatabase,userId:string,input:BeginAttachmentUpload):Promise<string|null>{
 owner(userId);const record=attachmentRecordSchema.parse(input.record);uuid.parse(record.id);uuid.parse(input.ownerNamespace);evidenceDateSchema.parse(input.now);
 if(!Number.isSafeInteger(input.rowRevision)||input.rowRevision<1)throw new Error('A positive attachment row revision is required.');
 const key=attachmentStorageKey(input.ownerNamespace,record.id);
 if(record.storageKey!==key||record.status!=='reserved'||Date.parse(record.expiresAt)<=Date.parse(input.now))return null;
 const hash=await contentHash(canonical(record)),token=crypto.randomUUID();
 const result=await db.prepare(`INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at)
 SELECT ?,?,?,?,?,NULL WHERE EXISTS (
 SELECT 1 FROM attachments a JOIN workspace_source_namespaces n ON n.user_id=a.user_id
 WHERE a.user_id=? AND a.id=? AND a.row_revision=? AND a.content_hash=?
 AND n.blob_namespace=? AND json_valid(a.payload_json)
 AND json_extract(a.payload_json,'$.id')=? AND json_extract(a.payload_json,'$.status')='reserved'
 AND json_extract(a.payload_json,'$.storageKey')=? AND julianday(json_extract(a.payload_json,'$.expiresAt'))>julianday(?)
 ) AND EXISTS (SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.storage_key=? AND o.attachment_id=? AND o.namespace=? AND o.bytes=? AND o.purged_at IS NULL) AND NOT EXISTS (SELECT 1 FROM attachment_blob_fences f WHERE f.user_id=? AND (f.storage_key=? OR f.attachment_id=?))`)
 .bind(userId,token,record.id,key,input.now,userId,record.id,input.rowRevision,hash,input.ownerNamespace,record.id,key,input.now,userId,key,record.id,input.ownerNamespace,record.expectedBytes,userId,key,record.id).run();
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
 const result=await db.prepare(`UPDATE attachment_upload_attempts SET settled_at=? WHERE user_id=? AND token=? AND settled_at IS NULL AND julianday(created_at)<=julianday(?)`).bind(input.now,userId,input.token,input.now).run();
 return result.meta.changes===1;
}
/** Read-only convenience check; never substitutes for the atomic begin/cleanup guards. */
export async function isBlobFenced(db:SqlDatabase,userId:string,input:{attachmentId:string;storageKey:string}):Promise<boolean>{
 owner(userId);uuid.parse(input.attachmentId);if(typeof input.storageKey!=='string'||input.storageKey.length<1||input.storageKey.length>500)throw new Error('A bounded attachment key is required.');
 return Boolean(await db.prepare('SELECT token FROM attachment_blob_fences WHERE user_id=? AND (storage_key=? OR attachment_id=?) LIMIT 1').bind(userId,input.storageKey,input.attachmentId).first());
}
