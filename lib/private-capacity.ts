import {privateSchemaMetadata} from './private-schema.ts';
import {PRIVATE_PROFILE_TABLES} from './private-profile.ts';
import {canonical} from './canonical-json.ts';
import type {SqlDatabase} from './workspace-store.ts';
type Bind=string|number|null;
export interface PrivateCapacityGuard {sql:string;bindings:Bind[]}
export class PrivateCapacityError extends Error {readonly code='private_recovery_capacity';readonly status=409;constructor(){super('Private recovery capacity is full. Preserve existing data and arrange a compatible recovery profile before admitting more work.');this.name='PrivateCapacityError';}}
function balancedAnd(parts:readonly string[]):string{if(parts.length===1)return '('+parts[0]+')';const middle=Math.floor(parts.length/2);return '('+balancedAnd(parts.slice(0,middle))+' AND '+balancedAnd(parts.slice(middle))+')';}
function capacityFail(reason:string):never{void reason;throw new PrivateCapacityError();}

/** Finite inactive-recovery admission. This is a storage quota, never device authority.
 * Other private growth writers must apply this same guard atomically to preserve
 * already admitted journal reservations. Positive deltas are conservative.
 * settlingPendingPuts is SERVER-ONLY credit: the caller must atomically prove
 * each exact owned token is still unsettled and has definitively completed its
 * physical PUT, and write settled_at in that SAME transaction. Never infer
 * settlement from elapsed time or grant credit from a request field.
 * firstCancelAttemptIds is likewise SERVER-ONLY: under exact current-state CAS,
 * the same transaction must set both cancellation fields and persist the actual
 * owner mutation ID. Only the FIRST such update can spend its 4KiB/2-row share;
 * bounded total command growth is required and repeated/no-op IDs earn no credit.
 * firstRevokeDeviceIds is only the explicit owner revoke of one existing native
 * runtime with revoked_at NULL; SAME-batch exact revision/count guards must set
 * its server revocation timestamp. The fixed 20-device pool is unavailable to
 * ordinary writes and reenrollment. Already occupied pool space remains valid
 * for finite funded cancellation/PUT settlement, never new work. */
export const PRIVATE_JOURNAL_RESERVATION=Object.freeze({eventBytes:8*1024*1024,eventRows:1024,terminalBytes:256*1024,newIdentityBytes:1024*1024,pendingPutBytes:4096,firstCancelBytes:4096,firstCancelRows:2});
const agentPrivateTables=PRIVATE_PROFILE_TABLES;
export interface PrivateGrowth {table:typeof agentPrivateTables[number]|'baselineRemovalFences';bytes:number;rows:number}
export const PRIVATE_REVOCATION_POOL=Object.freeze({devices:20,bytesPerDevice:2048,rowsPerDevice:1,bytes:40960,rows:20,framingBytes:24576});
export interface PrivateCapacityOptions {newAttempts?:number;newPendingPuts?:number;settlingPendingPuts?:number;firstCancelAttemptIds?:readonly string[];firstRevokeDeviceIds?:readonly string[];growth?:readonly PrivateGrowth[]}
export async function privateCapacityGuard(db:SqlDatabase,owner:string,options:PrivateCapacityOptions={}):Promise<PrivateCapacityGuard>{
 const count=options.newAttempts??0;if(!owner||!Number.isSafeInteger(count)||count<0||count>1)capacityFail('invalid_private_capacity_request');
 const newPuts=options.newPendingPuts??0,settlingPuts=options.settlingPendingPuts??0;for(const amount of [newPuts,settlingPuts])if(!Number.isSafeInteger(amount)||amount<0||amount>500)capacityFail('invalid_pending_put_reservation');
 const growth=options.growth??[];if(growth.length>agentPrivateTables.length+1||new Set(growth.map(value=>value.table)).size!==growth.length)capacityFail('invalid_private_capacity_request');
 for(const value of growth)if(![...agentPrivateTables,'baselineRemovalFences'].includes(value.table)||!Number.isSafeInteger(value.bytes)||value.bytes<0||!Number.isSafeInteger(value.rows)||value.rows<0)capacityFail('invalid_private_capacity_request');
 const firstCancel=options.firstCancelAttemptIds??[];if(firstCancel.length>12||new Set(firstCancel).size!==firstCancel.length||firstCancel.some(value=>typeof value!=='string'||value.length<1||value.length>128||Array.from(value).some(character=>character.charCodeAt(0)<=32||character.charCodeAt(0)===127)))capacityFail('invalid_first_cancel_funding');
 if(firstCancel.length&&(count||newPuts||settlingPuts||growth.reduce((sum,value)=>sum+value.bytes,0)>firstCancel.length*4096||growth.reduce((sum,value)=>sum+value.rows,0)>firstCancel.length*2))capacityFail('first_cancel_growth_exceeds_funding');
 const firstRevoke=options.firstRevokeDeviceIds??[];if(firstRevoke.length>1||firstRevoke.some(value=>typeof value!=='string'||value.length<1||value.length>128||Array.from(value).some(character=>character.charCodeAt(0)<=32||character.charCodeAt(0)===127)))capacityFail('invalid_first_revoke_funding');
 if(firstRevoke.length&&(count||newPuts||settlingPuts||firstCancel.length||growth.reduce((sum,value)=>sum+value.bytes,0)>2048||growth.reduce((sum,value)=>sum+value.rows,0)>1))capacityFail('first_revoke_growth_exceeds_funding');
 const metadata=await privateSchemaMetadata(db);
 const jsonFor=(table:typeof agentPrivateTables[number],alias='')=>{
  const columns=metadata.tables[table].map(row=>row.name).filter(name=>name!=='user_id').sort();
  if(!columns.length||columns.some(name=>!/^[a-z_][a-z0-9_]*$/u.test(name)))capacityFail('invalid_server_schema');
  return 'json_object('+columns.flatMap(name=>["'"+name+"'",alias+'"'+name+'"']).join(',')+')';
 };
 const selects:string[]=[];const bindings:Bind[]=[owner];
 for(const table of agentPrivateTables){const json=jsonFor(table);selects.push("(SELECT json_object('name','"+table+"','rows',COUNT(*),'bytes',COALESCE(SUM(length(CAST("+json+" AS BLOB))+1),0)) FROM "+table+" WHERE user_id=(SELECT owner FROM private_capacity_owner))");}
 selects.push("(SELECT json_object('name','baselineRemovalFences','rows',COUNT(*),'bytes',COALESCE(SUM(length(CAST(json_object('entity_id',entity_id,'entity_type',entity_type,'event_id',event_id,'kind',kind,'occurred_at',occurred_at,'payload_json',payload_json) AS BLOB))+1),0)) FROM audit_events WHERE user_id=(SELECT owner FROM private_capacity_owner) AND kind='entity.delete' AND entity_type IN('task','capture'))");
 const eventJson=jsonFor('job_events','e.');
 if(selects.length>90)capacityFail('private_profile_function_capacity');
 const profile="profile_json AS MATERIALIZED(SELECT json_array("+selects.join(',')+") value), profile AS MATERIALIZED(SELECT json_extract(value,'$.name') name,json_extract(value,'$.rows') rows,json_extract(value,'$.bytes') bytes FROM json_each((SELECT value FROM profile_json)))";
 const sql="WITH private_capacity_owner AS MATERIALIZED(SELECT ? owner), "+profile+", event_usage AS MATERIALIZED(SELECT e.attempt_id,COUNT(*) rows,COALESCE(SUM(length(CAST("+eventJson+" AS BLOB))+1),0) bytes FROM job_events e WHERE e.user_id=(SELECT owner FROM private_capacity_owner) GROUP BY e.attempt_id), reservations AS MATERIALIZED(SELECT COALESCE(SUM(MAX(0,8388608-COALESCE(e.bytes,0))+262144-CASE WHEN safety.cancel_request_id IS NOT NULL AND safety.cancel_requested_at IS NOT NULL THEN 4096 ELSE 0 END),0) bytes,COALESCE(SUM(MAX(0,1024-COALESCE(e.rows,0))+4-CASE WHEN safety.cancel_request_id IS NOT NULL AND safety.cancel_requested_at IS NOT NULL THEN 2 ELSE 0 END),0) rows,COALESCE(SUM(CASE WHEN safety.cancel_requested_at IS NULL AND safety.cancel_request_id IS NULL THEN 1 ELSE 0 END),0) cancellations FROM job_attempts a LEFT JOIN event_usage e ON e.attempt_id=a.id LEFT JOIN agent_job_state safety ON safety.user_id=a.user_id AND safety.job_id=a.job_id AND safety.attempt_id=a.id WHERE a.user_id=(SELECT owner FROM private_capacity_owner) AND a.result_json IS NULL AND a.reconciled_at IS NULL), pending_puts AS MATERIALIZED(SELECT (SELECT COUNT(*) FROM attachment_upload_attempts WHERE user_id=(SELECT owner FROM private_capacity_owner) AND settled_at IS NULL)+(SELECT COUNT(*) FROM backup_archive_objects WHERE user_id=(SELECT owner FROM private_capacity_owner) AND pending_token IS NOT NULL AND settled_at IS NULL) count), revocation_usage AS MATERIALIZED(SELECT COUNT(*) runtime_rows,COALESCE(SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END),0) spent FROM device_runtime WHERE user_id=(SELECT owner FROM private_capacity_owner)), first_revoke AS MATERIALIZED(SELECT r.device_id FROM device_runtime r JOIN devices d ON d.user_id=r.user_id AND d.id=r.device_id JOIN json_each(?) selected ON selected.value=r.device_id WHERE r.user_id=(SELECT owner FROM private_capacity_owner) AND r.revoked_at IS NULL AND d.archived_at IS NULL AND (SELECT runtime_rows FROM revocation_usage)<=20), first_cancel AS MATERIALIZED(SELECT a.id FROM job_attempts a JOIN agent_job_state s ON s.user_id=a.user_id AND s.job_id=a.job_id AND s.attempt_id=a.id JOIN json_each(?) selected ON selected.value=a.id WHERE a.user_id=(SELECT owner FROM private_capacity_owner) AND a.result_json IS NULL AND a.reconciled_at IS NULL AND s.cancel_requested_at IS NULL AND s.cancel_request_id IS NULL), safety_pool AS MATERIALIZED(SELECT CASE WHEN (SELECT COUNT(*) FROM first_revoke)>0 OR (SELECT COUNT(*) FROM first_cancel)>0 OR ?>0 THEN MIN(20,(SELECT spent FROM revocation_usage)+(SELECT COUNT(*) FROM first_revoke)) ELSE 0 END units), growth AS MATERIALIZED(SELECT json_extract(value,'$.table') name,json_extract(value,'$.rows') rows,json_extract(value,'$.bytes') bytes FROM json_each(?)) SELECT 1 WHERE "+balancedAnd([
  "(SELECT COALESCE(SUM(rows),0) FROM profile)+(SELECT rows FROM reservations)+(SELECT COALESCE(SUM(rows),0) FROM growth)+?-(SELECT COUNT(*) FROM first_cancel)*2<=199980+(SELECT units FROM safety_pool)",
  "(SELECT COALESCE(SUM(bytes),0) FROM profile)+(SELECT bytes FROM reservations)+(SELECT COALESCE(SUM(bytes),0) FROM growth)+?+((SELECT count FROM pending_puts)+?-? )*4096-(SELECT COUNT(*) FROM first_cancel)*4096<=67043328+(SELECT units FROM safety_pool)*2048",
  "(SELECT COUNT(*) FROM first_revoke)=?",
  "(SELECT COUNT(*) FROM first_cancel)=?",
  "(SELECT count FROM pending_puts)>=?",
  "NOT EXISTS(SELECT 1 FROM profile p LEFT JOIN growth g ON g.name=p.name WHERE p.rows+COALESCE(g.rows,0)+CASE WHEN p.name='job_attempts' THEN ? WHEN p.name='agent_device_slots' THEN ? WHEN p.name='job_events' THEN (SELECT rows FROM reservations)+? WHEN p.name='workspace_mutations' THEN (SELECT cancellations FROM reservations)-(SELECT COUNT(*) FROM first_cancel)+20-(SELECT units FROM safety_pool)+? ELSE 0 END>100000)"
 ]);
 bindings.push(canonical(firstRevoke),canonical(firstCancel),settlingPuts>0&&newPuts===0&&count===0?1:0,canonical(growth),count*1030,count*(8388608+262144+1048576),newPuts,settlingPuts,firstRevoke.length,firstCancel.length,settlingPuts,count,count,count*1024,count);
 // EXISTS keeps this composable inside the caller's transient command claim.
 return {sql:'(EXISTS('+sql+') AND ('+metadata.guard.sql+'))',bindings:[...bindings,...metadata.guard.bindings]};
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
