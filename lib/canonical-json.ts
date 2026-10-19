import {startHashWork} from './hash-work-diagnostics.ts';
/** Pure deterministic JSON hashing; no database, registry or module registration dependencies. */
function canonicalValue(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalValue((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function canonical(value:unknown):string{const finish=startHashWork('canonical');try{return canonicalValue(value);}finally{finish();}}
export async function contentHash(value:string|Uint8Array):Promise<string>{
 const encode=startHashWork('sha-encode');let bytes:Uint8Array;
 try{bytes=typeof value==='string'?new TextEncoder().encode(value):value;}finally{encode();}
 const submit=startHashWork('sha-submit');let pending:Promise<ArrayBuffer>;
 try{pending=crypto.subtle.digest('SHA-256',bytes as BufferSource);}finally{submit(bytes.byteLength);}
 const wait=startHashWork('sha-await');let digest:ArrayBuffer;
 try{digest=await pending;}finally{wait(bytes.byteLength);}
 const hex=startHashWork('sha-hex');try{return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');}finally{hex();}
}
