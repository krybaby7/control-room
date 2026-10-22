import {canonical,contentHash} from './canonical-json.ts';
import {BUNDLE_LIMITS} from './workspace-export-core.ts';
export const RECOVERABILITY_HASH_CONCURRENCY=32;
export interface RecoverabilityHashRow {readonly payload_json:string;readonly content_hash:string}
/** Synchronous shape and UTF8 aggregate refusal, before parallel work starts. */
export function assertRecoverabilityHashRows(rows:readonly RecoverabilityHashRow[]):void{
 let bytes=0;const encoder=new TextEncoder();
 for(const row of rows){if(!row||typeof row.payload_json!=='string'||typeof row.content_hash!=='string'||!/^[a-f0-9]{64}$/u.test(row.content_hash))throw new Error('Invalid physical snapshot hash row.');bytes+=encoder.encode(row.payload_json).byteLength;if(bytes>BUNDLE_LIMITS.bytes)throw new Error('Physical snapshot byte bound exceeded.');}
}
/** Every captured row is verified with native canonical SHA. The UTF8 aggregate
 * is checked before scheduling any digest; the pool and all values are local to
 * this one call. A refusal waits for all started work and never leaves a write. */
export async function verifyRecoverabilityRowHashes(rows:readonly RecoverabilityHashRow[]):Promise<void>{
 assertRecoverabilityHashRows(rows);
 let cursor=0;const failure:{index:number;error:unknown}[]=[];
 async function worker(){
  for(;;){const index=cursor++;if(index>=rows.length)return;const row=rows[index];
   try{if(await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('Current normalized content hash differs.');}
   catch(error){if(!failure.length||index<failure[0].index)failure[0]={index,error};}
  }
 }
 await Promise.all(Array.from({length:Math.min(RECOVERABILITY_HASH_CONCURRENCY,rows.length)},()=>worker()));
 if(failure.length)throw failure[0].error;
}
