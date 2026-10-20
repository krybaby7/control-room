/** Pure deterministic JSON hashing; no database, registry or module registration dependencies. */
export function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function contentHash(value:string|Uint8Array):Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',(typeof value==='string'?new TextEncoder().encode(value):value) as BufferSource)),n=>n.toString(16).padStart(2,'0')).join(''); }
