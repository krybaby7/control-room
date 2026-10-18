import {PRIVATE_PROFILE_TABLES} from './private-profile.ts';
import {canonical} from './canonical-json.ts';
import type {SqlDatabase} from './workspace-store.ts';
type Bind=string|number|null;
export interface PrivateCapacityGuard {sql:string;bindings:Bind[]}
export class PrivateCapacityError extends Error {readonly code='private_recovery_capacity';readonly status=409;constructor(){super('Private recovery capacity is full. Preserve existing data and arrange a compatible recovery profile before admitting more work.');this.name='PrivateCapacityError';}}
function capacityFail(reason:string):never{void reason;throw new PrivateCapacityError();}

/** Finite inactive-recovery admission. This is a storage quota, never device authority.
 * Other private growth writers must apply this same guard atomically to preserve
 * already admitted journal reservations. Positive deltas are conservative.
 * settlingPendingPuts is SERVER-ONLY credit: the caller must atomically prove
 * each exact owned token is still unsettled and has definitively completed its
 * physical PUT, and write settled_at in that SAME transaction. Never infer
 * settlement from elapsed time or grant credit from a request field. */
export const PRIVATE_JOURNAL_RESERVATION=Object.freeze({eventBytes:8*1024*1024,eventRows:1024,terminalBytes:256*1024,newIdentityBytes:1024*1024,pendingPutBytes:4096});
const agentPrivateTables=PRIVATE_PROFILE_TABLES;
export interface PrivateGrowth {table:typeof agentPrivateTables[number]|'baselineRemovalFences';bytes:number;rows:number}
export interface PrivateCapacityOptions {newAttempts?:number;newPendingPuts?:number;settlingPendingPuts?:number;growth?:readonly PrivateGrowth[]}
export async function privateCapacityGuard(db:SqlDatabase,owner:string,options:PrivateCapacityOptions={}):Promise<PrivateCapacityGuard>{
 const count=options.newAttempts??0;if(!owner||!Number.isSafeInteger(count)||count<0||count>1)capacityFail('invalid_private_capacity_request');
 const newPuts=options.newPendingPuts??0,settlingPuts=options.settlingPendingPuts??0;for(const amount of [newPuts,settlingPuts])if(!Number.isSafeInteger(amount)||amount<0||amount>500)capacityFail('invalid_pending_put_reservation');
 const growth=options.growth??[];if(growth.length>agentPrivateTables.length+1||new Set(growth.map(value=>value.table)).size!==growth.length)capacityFail('invalid_private_capacity_request');
 for(const value of growth)if(![...agentPrivateTables,'baselineRemovalFences'].includes(value.table)||!Number.isSafeInteger(value.bytes)||value.bytes<0||!Number.isSafeInteger(value.rows)||value.rows<0)capacityFail('invalid_private_capacity_request');
 const jsonFor=async(table:string,alias='')=>{
  const columns=(await db.prepare('PRAGMA table_info('+table+')').all<{name:string}>()).results.map(row=>row.name).filter(name=>name!=='user_id').sort();
  if(!columns.length||columns.some(name=>!/^[a-z_][a-z0-9_]*$/u.test(name)))capacityFail('invalid_server_schema');
  return 'json_object('+columns.flatMap(name=>["'"+name+"'",alias+'"'+name+'"']).join(',')+')';
 };
 const selects:string[]=[];const bindings:Bind[]=[];
 for(const table of agentPrivateTables){const json=await jsonFor(table);selects.push("(SELECT json_object('name','"+table+"','rows',COUNT(*),'bytes',COALESCE(SUM(length(CAST("+json+" AS BLOB))+1),0)) FROM "+table+" WHERE user_id=?)");bindings.push(owner);}
 selects.push("(SELECT json_object('name','baselineRemovalFences','rows',COUNT(*),'bytes',COALESCE(SUM(length(CAST(json_object('entity_id',entity_id,'entity_type',entity_type,'event_id',event_id,'kind',kind,'occurred_at',occurred_at,'payload_json',payload_json) AS BLOB))+1),0)) FROM audit_events WHERE user_id=? AND kind='entity.delete' AND entity_type IN('task','capture'))");bindings.push(owner);
 const eventJson=await jsonFor('job_events','e.');
 if(selects.length>90)capacityFail('private_profile_function_capacity');
 const profile="profile_json AS MATERIALIZED(SELECT json_array("+selects.join(',')+") value), profile AS MATERIALIZED(SELECT json_extract(value,'$.name') name,json_extract(value,'$.rows') rows,json_extract(value,'$.bytes') bytes FROM json_each((SELECT value FROM profile_json)))";
 const sql="WITH "+profile+", event_usage AS MATERIALIZED(SELECT e.attempt_id,COUNT(*) rows,COALESCE(SUM(length(CAST("+eventJson+" AS BLOB))+1),0) bytes FROM job_events e WHERE e.user_id=? GROUP BY e.attempt_id), reservations AS MATERIALIZED(SELECT COALESCE(SUM(MAX(0,8388608-COALESCE(e.bytes,0))+262144),0) bytes,COALESCE(SUM(MAX(0,1024-COALESCE(e.rows,0))+4),0) rows FROM job_attempts a LEFT JOIN event_usage e ON e.attempt_id=a.id WHERE a.user_id=? AND a.result_json IS NULL AND a.reconciled_at IS NULL), pending_puts AS MATERIALIZED(SELECT (SELECT COUNT(*) FROM attachment_upload_attempts WHERE user_id=? AND settled_at IS NULL)+(SELECT COUNT(*) FROM backup_archive_objects WHERE user_id=? AND pending_token IS NOT NULL AND settled_at IS NULL) count), growth AS MATERIALIZED(SELECT json_extract(value,'$.table') name,json_extract(value,'$.rows') rows,json_extract(value,'$.bytes') bytes FROM json_each(?)) SELECT 1 WHERE (SELECT COALESCE(SUM(rows),0) FROM profile)+(SELECT rows FROM reservations)+(SELECT COALESCE(SUM(rows),0) FROM growth)+?<=200000 AND (SELECT COALESCE(SUM(bytes),0) FROM profile)+(SELECT bytes FROM reservations)+(SELECT COALESCE(SUM(bytes),0) FROM growth)+?+((SELECT count FROM pending_puts)+?-?)*4096<=67043328 AND (SELECT count FROM pending_puts)>=? AND NOT EXISTS(SELECT 1 FROM profile p LEFT JOIN growth g ON g.name=p.name WHERE p.rows+COALESCE(g.rows,0)+CASE WHEN p.name='job_attempts' THEN ? WHEN p.name='agent_device_slots' THEN ? WHEN p.name='job_events' THEN (SELECT rows FROM reservations)+? ELSE 0 END>100000)";
 bindings.push(owner,owner,owner,owner,canonical(growth),count*1030,count*(8388608+262144+1048576),newPuts,settlingPuts,settlingPuts,count,count,count*1024);
 // EXISTS keeps this composable inside the caller's transient command claim.
 return {sql:'EXISTS('+sql+')',bindings};
}

/** Complete server-produced physical rows, including null/default columns. Never
 * estimate a payload-only object or accept these rows from a request. Deletions
 * grant no speculative credit; updates charge only positive encoded growth. */
export function privateRowGrowth(table:PrivateGrowth['table'],before:Record<string,Bind>|null,after:Record<string,Bind>|null):PrivateGrowth{
 if(![...agentPrivateTables,'baselineRemovalFences'].includes(table))throw new PrivateCapacityError();
 const encoded=(row:Record<string,Bind>|null)=>{if(!row)return 0;const value={...row};delete value.user_id;return new TextEncoder().encode(canonical(value)).length+1;};
 return {table,bytes:Math.max(0,encoded(after)-encoded(before)),rows:!before&&after?1:0};
}
export async function requirePrivateCapacity(db:SqlDatabase,owner:string,options:Parameters<typeof privateCapacityGuard>[2]={}):Promise<PrivateCapacityGuard>{
 const proof=await privateCapacityGuard(db,owner,options);if(!await db.prepare('SELECT 1 WHERE '+proof.sql).bind(...proof.bindings).first())throw new PrivateCapacityError();return proof;
}
