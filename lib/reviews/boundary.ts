import type {SqlDatabase} from '../workspace-store.ts';
import {canonical} from '../canonical-json.ts';
/** Complete vector equality includes absence: newly introduced streams invalidate admission. */
export function reviewBoundary(owner:string,revision:number,watermarks:Record<string,number>){
 const entries=Object.entries(watermarks).sort(([a],[b])=>a.localeCompare(b));
 return {sql:`EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?) AND NOT EXISTS(SELECT 1 FROM operational_stream_heads h WHERE h.user_id=? AND NOT EXISTS(SELECT 1 FROM json_each(?) v WHERE json_extract(v.value,'$[0]')=h.stream_id AND json_extract(v.value,'$[1]')=h.last_sequence)) AND NOT EXISTS(SELECT 1 FROM json_each(?) v WHERE NOT(json_extract(v.value,'$[0]')='sources' AND json_extract(v.value,'$[1]')=0) AND NOT EXISTS(SELECT 1 FROM operational_stream_heads h WHERE h.user_id=? AND h.stream_id=json_extract(v.value,'$[0]') AND h.last_sequence=json_extract(v.value,'$[1]')))`,bindings:[owner,revision,owner,canonical(entries),canonical(entries),owner] as (string|number|null)[]};
}
export async function reviewBoundaryCurrent(db:SqlDatabase,owner:string,revision:number,watermarks:Record<string,number>):Promise<boolean>{const guard=reviewBoundary(owner,revision,watermarks);return Boolean(await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.bindings).first());}
