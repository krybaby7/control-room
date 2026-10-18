import { ImportQuarantine, type ImportStage, type ImportPreview } from './import-quarantine.ts';
import { BUNDLE_LIMITS, contentHash, type WorkspaceBundle } from './workspace-export.ts';
import type { WorkspaceEnvelope } from './types.ts';
import type { SqlDatabase } from './workspace-store.ts';
export const IMPORT_STAGING_LIMITS={bytes:BUNDLE_LIMITS.bytes,ownerBytes:20_000_000,stages:8,chunkBytes:256*1024,ttlMs:3_600_000} as const;
interface StageRow {id:string;content_hash:string;created_at:string;expires_at:string;bytes:number;metadata_json:string}
interface ChunkRow {ordinal:number;content_base64:string}
function checked(owner:string,now:string|number):{epoch:number;iso:string} {
 if(!owner)throw new Error('A signed-in owner is required.');const epoch=typeof now==='number'?now:Date.parse(now);if(!Number.isSafeInteger(epoch))throw new Error('Invalid staging time.');return {epoch,iso:new Date(epoch).toISOString()};
}
function base64(bytes:Uint8Array):string {let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
function unbase64(value:string):Uint8Array {
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('Corrupt import chunk.');
 const binary=atob(value);return Uint8Array.from(binary,char=>char.charCodeAt(0));
}
async function expire(db:SqlDatabase,owner:string,now:string) {
 await db.batch([
 db.prepare('DELETE FROM workspace_import_chunks WHERE user_id=? AND import_id IN (SELECT id FROM workspace_imports WHERE user_id=? AND expires_at<=?)').bind(owner,owner,now),
 db.prepare('DELETE FROM workspace_imports WHERE user_id=? AND expires_at<=?').bind(owner,now),
 ]);
}
/** Durable quarantine only. This module cannot mutate the active workspace. */
export async function stageImport(db:SqlDatabase,owner:string,raw:Uint8Array,now:string|number=new Date().toISOString()):Promise<ImportStage> {
 const clock=checked(owner,now);
 if(!(raw instanceof Uint8Array)||raw.byteLength>IMPORT_STAGING_LIMITS.bytes)throw new Error('Import byte limit exceeded.');
 // Clone before the first await so the persisted bytes cannot change during hashing.
 const bytes=raw.slice();const quarantine=new ImportQuarantine({now:()=>clock.epoch});const stage=await quarantine.stage(owner,bytes);
 await expire(db,owner,clock.iso);
 const expires=new Date(clock.epoch+IMPORT_STAGING_LIMITS.ttlMs).toISOString();
 const metadata=JSON.stringify({diagnostics:stage.diagnostics.map(({path,code})=>({path,code}))});
 const statements=[db.prepare('INSERT INTO workspace_imports(user_id,id,content_hash,created_at,expires_at,bytes,metadata_json) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM workspace_imports WHERE user_id=?) < ? AND COALESCE((SELECT SUM(bytes) FROM workspace_imports WHERE user_id=?),0)+? <= ?').bind(owner,stage.id,stage.hash,clock.iso,expires,bytes.byteLength,metadata,owner,IMPORT_STAGING_LIMITS.stages,owner,bytes.byteLength,IMPORT_STAGING_LIMITS.ownerBytes)];
 for(let offset=0,ordinal=0;offset<bytes.byteLength;offset+=IMPORT_STAGING_LIMITS.chunkBytes,ordinal++) {
  statements.push(db.prepare('INSERT INTO workspace_import_chunks(user_id,import_id,ordinal,content_base64) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM workspace_imports WHERE user_id=? AND id=? AND content_hash=?)').bind(owner,stage.id,ordinal,base64(bytes.subarray(offset,offset+IMPORT_STAGING_LIMITS.chunkBytes)),owner,stage.id,stage.hash));
 }
 await db.batch(statements);
 const inserted=await db.prepare('SELECT id FROM workspace_imports WHERE user_id=? AND id=? AND content_hash=?').bind(owner,stage.id,stage.hash).first<{id:string}>();
 if(!inserted)throw new Error('Import staging owner quota exceeded.');
 return stage;
}
export interface StagedImport {stage:ImportStage;raw:Uint8Array;preview(current:WorkspaceEnvelope,currentModules?:WorkspaceBundle['modules']):ImportPreview}
export async function readStagedImport(db:SqlDatabase,owner:string,id:string,now:string|number=new Date().toISOString()):Promise<StagedImport> {
 const clock=checked(owner,now);if(!id||id.length>160)throw new Error('Invalid import ID.');
 const row=await db.prepare('SELECT id,content_hash,created_at,expires_at,bytes,metadata_json FROM workspace_imports WHERE user_id=? AND id=? AND expires_at>?').bind(owner,id,clock.iso).first<StageRow>();
 if(!row)throw new Error('Import not found or expired.');
 if(!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>IMPORT_STAGING_LIMITS.bytes)throw new Error('Corrupt import byte length.');
 const chunks=(await db.prepare('SELECT ordinal,content_base64 FROM workspace_import_chunks WHERE user_id=? AND import_id=? ORDER BY ordinal LIMIT 33').bind(owner,id).all<ChunkRow>()).results;
 const expected=Math.ceil(row.bytes/IMPORT_STAGING_LIMITS.chunkBytes);if(chunks.length!==expected)throw new Error('Missing or extra import chunk.');
 const raw=new Uint8Array(row.bytes);let offset=0;
 for(let ordinal=0;ordinal<chunks.length;ordinal++) {
  const chunk=chunks[ordinal];if(chunk.ordinal!==ordinal||chunk.content_base64.length>Math.ceil(IMPORT_STAGING_LIMITS.chunkBytes/3)*4)throw new Error('Corrupt import chunk ordering or length.');
  const bytes=unbase64(chunk.content_base64);const length=Math.min(IMPORT_STAGING_LIMITS.chunkBytes,row.bytes-offset);if(bytes.length!==length)throw new Error('Corrupt import chunk length.');raw.set(bytes,offset);offset+=bytes.length;
 }
 if(offset!==row.bytes||await contentHash(raw)!==row.content_hash)throw new Error('Corrupt import digest or length.');
 const quarantine=new ImportQuarantine({now:()=>clock.epoch});const transient=await quarantine.stage(owner,raw);
 const stage={...transient,id:row.id,createdAt:Date.parse(row.created_at),expiresAt:Date.parse(row.expires_at)};
 return {stage,raw,preview(current,currentModules){return {...quarantine.preview(owner,transient.id,current,currentModules),importId:row.id};}};
}
export async function discardStagedImport(db:SqlDatabase,owner:string,id:string):Promise<boolean> {
 checked(owner,Date.now());if(!id||id.length>160)throw new Error('Invalid import ID.');
 const result=await db.batch([db.prepare('DELETE FROM workspace_import_chunks WHERE user_id=? AND import_id=?').bind(owner,id),db.prepare('DELETE FROM workspace_imports WHERE user_id=? AND id=?').bind(owner,id)]);
 return result[1].meta.changes===1;
}
