import {contentHash} from './canonical-json.ts';
export const BACKUP_ARCHIVE_CHUNK_BYTES=4*1024*1024;
export interface BackupArchiveBucket {
 put(key:string,bytes:Uint8Array,options:{onlyIf:{etagDoesNotMatch:string};httpMetadata:{contentType:string};customMetadata:{sha256:string}}):Promise<{size:number}|null>;
 get(key:string):Promise<{size:number;body:ReadableStream<Uint8Array>;httpMetadata?:{contentType?:string};customMetadata?:Record<string,string>}|null>;
}
export interface BackupArchiveChunk {part:number;bytes:number;sha256:string}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function backupArchiveKey(namespace:string,part:number):string{
 if(!uuid.test(namespace)||!Number.isSafeInteger(part)||part<0||part>4)throw new Error('Invalid private archive object identity.');
 return 'backups/'+namespace+'/part-'+String(part).padStart(4,'0');
}
function check(value:BackupArchiveChunk){if(!Number.isSafeInteger(value.part)||value.part<0||value.part>4||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>BACKUP_ARCHIVE_CHUNK_BYTES||!/^[a-f0-9]{64}$/u.test(value.sha256))throw new Error('Invalid archive chunk metadata.');}
async function bounded<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
 if(signal?.aborted)throw new Error('Archive read cancelled.');let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
 const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('Archive read cancelled.'));signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(new Error('Archive read timed out.')),15000);});
 try{return await Promise.race([work,stopped]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
/** No binding, arbitrary key or overwrite fallback. PUT settlement is the caller's durable responsibility. */
export function createBackupArchiveStorage(bucket?:BackupArchiveBucket|null){
 const requireBucket=()=>{if(!bucket)throw new Error('Private archive storage is unavailable.');return bucket;};
 return {available:!!bucket,
 async put(namespace:string,chunk:BackupArchiveChunk,bytes:Uint8Array):Promise<void>{
  check(chunk);if(bytes.length!==chunk.bytes||await contentHash(bytes)!==chunk.sha256)throw new Error('Archive chunk digest differs.');
  await requireBucket().put(backupArchiveKey(namespace,chunk.part),bytes.slice(),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sha256:chunk.sha256}});
 },
 async get(namespace:string,chunk:BackupArchiveChunk,signal?:AbortSignal):Promise<Uint8Array|null>{
  check(chunk);const object=await bounded(requireBucket().get(backupArchiveKey(namespace,chunk.part)),signal);if(!object)return null;
  if(object.size!==chunk.bytes||object.customMetadata?.sha256!==chunk.sha256||object.httpMetadata?.contentType!=='application/octet-stream'){void object.body.cancel().catch(()=>{});throw new Error('Archive object metadata differs.');}
  const reader=object.body.getReader(),bytes=new Uint8Array(chunk.bytes);let offset=0;
  try{for(;;){const next=await bounded(reader.read(),signal);if(next.done)break;if(!(next.value instanceof Uint8Array)||offset+next.value.length>bytes.length)throw new Error('Archive chunk exceeds its byte bound.');bytes.set(next.value,offset);offset+=next.value.length;}if(offset!==chunk.bytes||await contentHash(bytes)!==chunk.sha256)throw new Error('Archive chunk bytes differ.');return bytes;}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
 }};
}
export type BackupArchiveStorage=ReturnType<typeof createBackupArchiveStorage>;
/** Splits a bounded ZIP stream without aggregating its complete bytes. */
export async function* backupArchiveChunks(stream:ReadableStream<Uint8Array>,expectedBytes:number):AsyncGenerator<Uint8Array>{
 if(!Number.isSafeInteger(expectedBytes)||expectedBytes<1||expectedBytes>20_000_000)throw new Error('Archive exceeds the owner backup byte bound.');
 const reader=stream.getReader();let buffer=new Uint8Array(Math.min(BACKUP_ARCHIVE_CHUNK_BYTES,expectedBytes)),used=0,total=0;
 try{for(;;){const next=await reader.read();if(next.done)break;if(!(next.value instanceof Uint8Array))throw new Error('Invalid archive stream.');let offset=0;while(offset<next.value.length){const count=Math.min(buffer.length-used,next.value.length-offset);if(count===0)throw new Error('Archive exceeded its exact reserved length.');buffer.set(next.value.subarray(offset,offset+count),used);used+=count;offset+=count;total+=count;if(total>expectedBytes)throw new Error('Archive exceeded its exact reserved length.');if(used===buffer.length){yield buffer;buffer=new Uint8Array(Math.min(BACKUP_ARCHIVE_CHUNK_BYTES,expectedBytes-total));used=0;}}}if(total!==expectedBytes||used!==0)throw new Error('Archive stream length differs from reservation.');}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
