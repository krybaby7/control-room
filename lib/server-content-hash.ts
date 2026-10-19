import {createHash} from 'node:crypto';
import {contentHash} from './canonical-json.ts';
/** Server-only native SHA-256. Never import through a client/shared module.
 * Small immutable strings use exactly the existing TextEncoder UTF8 bytes.
 * Larger strings and every binary input retain the original WebCrypto path.
 * The Promise interface, digest algorithm and lowercase hexadecimal are unchanged. */
export const SERVER_SYNC_SHA_MAX_BYTES=64*1024;
export async function serverContentHash(value:string|Uint8Array):Promise<string>{
 if(typeof value!=='string'||value.length>SERVER_SYNC_SHA_MAX_BYTES)return contentHash(value);
 const bytes=new TextEncoder().encode(value);
 if(bytes.byteLength>SERVER_SYNC_SHA_MAX_BYTES)return contentHash(value);
 return createHash('sha256').update(bytes).digest('hex');
}
