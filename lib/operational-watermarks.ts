import type {SqlDatabase} from './workspace-store.ts';
/** Frozen sequence bounds are separate from module content hashes and editor revisions. */
export async function readOperationalWatermarks(db:SqlDatabase,userId:string):Promise<Record<string,number>>{
 if(!userId)throw new Error('An authenticated owner is required.');
 const rows=(await db.prepare('SELECT stream_id,last_sequence FROM operational_stream_heads WHERE user_id=? ORDER BY stream_id LIMIT 201').bind(userId).all<{stream_id:string;last_sequence:number}>()).results;
 if(rows.length>200)throw new Error('Operational stream bound exceeded.');
 const result:Record<string,number>={sources:0};for(const row of rows){if(!/^[a-z][a-z0-9_-]{0,63}$/.test(row.stream_id)||!Number.isSafeInteger(row.last_sequence)||row.last_sequence<0)throw new Error('Invalid operational stream watermark.');result[row.stream_id]=row.last_sequence;}
 for(const table of ['source_observations','source_sync_runs','integration_history']as const){const row=await db.prepare(`SELECT MAX(stream_sequence) AS sequence FROM ${table} WHERE user_id=?`).bind(userId).first<{sequence:number|null}>();if(row?.sequence!==null&&row?.sequence!==undefined&&(!Number.isSafeInteger(row.sequence)||row.sequence<0||row.sequence>result.sources))throw new Error('Source rows exceed their committed operational watermark.');}
 const audit=await db.prepare("SELECT MAX(stream_sequence) AS sequence FROM audit_events WHERE user_id=? AND stream_id='sources'").bind(userId).first<{sequence:number|null}>();if(audit?.sequence!==null&&audit?.sequence!==undefined&&audit.sequence>result.sources)throw new Error('Operational audit exceeds its committed source watermark.');
 return result;
}
export function validateOperationalWatermarks(value:unknown):asserts value is Record<string,number>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length>200)throw new Error('Invalid operational watermarks.');
 for(const [key,sequence]of Object.entries(value))if(!/^[a-z][a-z0-9_-]{0,63}$/.test(key)||typeof sequence!=='number'||!Number.isSafeInteger(sequence)||sequence<0)throw new Error('Invalid operational watermark.');
}
