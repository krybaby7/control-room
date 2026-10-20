import { contentHash } from './workspace-export.ts';
import type { BackupManifest } from './workspace-backups.ts';
export interface BackupObjectHead {size:number;}
export interface BackupObject extends BackupObjectHead {arrayBuffer():Promise<ArrayBuffer>;}
/** Structural subset of a private R2 bucket. Binding provisioning is the host's responsibility. */
export interface BackupBucket {
 put(key:string,value:Uint8Array,options?:{onlyIf?:{etagDoesNotMatch:string}}):Promise<BackupObjectHead|null>;
 get(key:string):Promise<BackupObject|null>;head(key:string):Promise<BackupObjectHead|null>;delete(key:string):Promise<void>;
}
export interface BackupStorage {
 readonly available:boolean;
 put(key:string,bytes:Uint8Array,expectedSha256:string):Promise<{bytes:number;sha256:string}>;
 get(key:string):Promise<Uint8Array|null>;head(key:string):Promise<BackupObjectHead|null>;delete(key:string):Promise<void>;
}
export class BackupStorageUnavailableError extends Error {}
export function createBackupStorage(bucket?:BackupBucket|null):BackupStorage {
 const requireBucket=()=>{if(!bucket)throw new BackupStorageUnavailableError('Private backup object storage is unavailable.');return bucket;};
 const keyCheck=(key:string)=>{if(!/^backups\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}$/.test(key))throw new Error('Invalid immutable backup object key.');};
 return {available:!!bucket,async put(key,bytes,expectedSha256){
   keyCheck(key);if(bytes.byteLength>8_000_000 || !/^[a-f0-9]{64}$/.test(expectedSha256) || await contentHash(bytes)!==expectedSha256)throw new Error('Backup upload digest or size is invalid.');
   const target=requireBucket();const existing=await target.head(key);if(existing)throw new Error('Backup object already exists.');
   const saved=await target.put(key,bytes.slice(),{onlyIf:{etagDoesNotMatch:'*'}});if(!saved)throw new Error('Backup immutable write failed.');
   const head=await target.head(key);if(!head||head.size!==bytes.byteLength)throw new Error('Backup object length verification failed.');
   const object=await target.get(key);if(!object||object.size!==bytes.byteLength)throw new Error('Backup object missing after upload.');
   const actual=new Uint8Array(await object.arrayBuffer());if(actual.byteLength!==bytes.byteLength || await contentHash(actual)!==expectedSha256)throw new Error('Backup object digest verification failed.');
   return {bytes:actual.byteLength,sha256:expectedSha256};
 },async get(key){keyCheck(key);const object=await requireBucket().get(key);if(!object)return null;if(object.size>8_000_000)throw new Error('Backup object exceeds read bound.');const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.byteLength!==object.size)throw new Error('Backup object length mismatch.');return bytes;},async head(key){keyCheck(key);return requireBucket().head(key);},async delete(key){keyCheck(key);await requireBucket().delete(key);}};
}
/** Object verification precedes readiness; callers must commit this manifest under a source-revision guard. */
export async function prepareObjectBackup(storage:BackupStorage,manifest:BackupManifest,bytes:Uint8Array):Promise<BackupManifest> {
 if(manifest.status!=='preparing' || manifest.storageKind!=='r2' || manifest.bytes!==bytes.byteLength)throw new Error('Invalid object backup preparation.');
 await storage.put(manifest.storageKey,bytes,manifest.sha256);return {...manifest,status:'ready'};
}
/** The caller supplies authoritative manifest-reference checks. Never collect young or referenced objects. */
export async function collectOrphanBackup(storage:BackupStorage,key:string,createdAt:number,now:number,isReferenced:(key:string)=>Promise<boolean>,graceMs=86_400_000):Promise<boolean> {
 if(!Number.isFinite(createdAt)||!Number.isFinite(now)||!Number.isSafeInteger(graceMs)||graceMs<3_600_000)throw new Error('Invalid orphan grace period.');
 if(now-createdAt<graceMs || await isReferenced(key))return false;await storage.delete(key);return true;
}
