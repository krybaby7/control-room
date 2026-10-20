import type {SqlDatabase,SqlStatement} from './workspace-store.ts';
import {canonical} from './canonical-json.ts';
import {reviewBoundary} from './reviews/boundary.ts';
import type {ProspectiveRecoverabilityResult} from './recoverability-snapshot.ts';
export class RecoverabilityCapacityError extends Error {readonly code='recovery_capacity';readonly paused:boolean;constructor(paused=false){super('This change would exceed the verified recovery capacity. Existing records are retained. Export your workspace and configure compatible recovery storage before adding more data.');this.paused=paused;}}
export type RecoverabilityCondition={sql:string;bindings:(string|number|null)[]};
const GROUP_BYTES=1_800_000;
function balancedAnd(parts:readonly string[]):string{
 if(parts.length===1)return `(${parts[0]})`;
 const middle=Math.floor(parts.length/2);return `(${balancedAnd(parts.slice(0,middle))} AND ${balancedAnd(parts.slice(middle))})`;
}
function bindingBytes(values:readonly(string|number|null)[]):number{return new TextEncoder().encode(JSON.stringify(values)).length;}
/** Pure server-produced predicates in their original order. No assertion has
 * been prepared or executed, and every predicate still requires the same claim. */
export function recoverabilityConditions(owner:string,mutationId:string,quote:ProspectiveRecoverabilityResult,binds:(string|number|null)[]):RecoverabilityCondition[]{
 if(!quote.measurement.allowed)throw new RecoverabilityCapacityError();const boundary=reviewBoundary(owner,quote.boundaryRevision,quote.boundaryWatermarks),conditions:RecoverabilityCondition[]=[boundary],rows=quote.boundaryRows.map(({table,rows})=>({sql:`(SELECT COUNT(*) FROM ${table} WHERE user_id=?)=? AND NOT EXISTS(SELECT id,row_revision,content_hash FROM ${table} WHERE user_id=? EXCEPT SELECT json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.content_hash') FROM json_each(?))`,bindings:[owner,rows.length,owner,canonical(rows)] as (string|number|null)[]}));
 // Each leaf has four parameters and two compound SELECT terms. Keep generic
 // caller gates within D1's 100-parameter limit, and each group at most 24 terms.
 const groupSize=Math.min(12,Math.floor((100-2-binds.length)/4));
 if(rows.length&&groupSize<1)throw new Error('Recoverability assertion gate exceeds the supported parameter bound.');
 let group:RecoverabilityCondition[]=[];
 const flush=()=>{if(group.length){conditions.push({sql:balancedAnd(group.map(item=>item.sql)),bindings:group.flatMap(item=>item.bindings)});group=[];}};
 for(const row of rows){
  // A previously valid singleton remains unchanged even when the conservative
  // aggregate estimate is large. Only newly combined statements need this cap.
  if(group.length&&(group.length>=groupSize||bindingBytes([owner,mutationId,...group.flatMap(item=>item.bindings),...row.bindings,...binds])>GROUP_BYTES))flush();
  group.push(row);
 }
 flush();
 if(quote.agentTerminalReserveRows)conditions.push({sql:"(SELECT COUNT(*) FROM agent_job_state WHERE user_id=? AND approval_id IS NOT NULL AND status IN ('queued','leased','running','cancelling','reconcile_required'))=? AND NOT EXISTS(SELECT job_id,operational_revision,status,approval_id FROM agent_job_state WHERE user_id=? AND approval_id IS NOT NULL AND status IN ('queued','leased','running','cancelling','reconcile_required') EXCEPT SELECT json_extract(value,'$.job_id'),json_extract(value,'$.operational_revision'),json_extract(value,'$.status'),json_extract(value,'$.approval_id') FROM json_each(?))",bindings:[owner,quote.agentTerminalReserveRows.length,owner,canonical(quote.agentTerminalReserveRows)]});
 return conditions;
}
function assertionSql(condition:string,gate:string):string{return `INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${condition} THEN 1 ELSE 0 END WHERE ${gate}`;}
/** Only adjacent PRE-DML predicates sharing this exact transient claim may be
 * combined. Every predicate and binding stays ordered, including duplicate schema
 * guards. Unsupported combined framing returns the original singletons before
 * any DB call; no failed statement/batch is retried or treated as admission. */
export function combineClaimConditions(owner:string,mutationId:string,gate:string,binds:readonly(string|number|null)[],conditions:readonly RecoverabilityCondition[]):RecoverabilityCondition[]{
 if(conditions.length<2)return [...conditions];
 const combined={sql:balancedAnd(conditions.map(condition=>condition.sql)),bindings:conditions.flatMap(condition=>condition.bindings)};
 if(2+combined.bindings.length+binds.length>100||bindingBytes([owner,mutationId,...combined.bindings,...binds])>GROUP_BYTES||new TextEncoder().encode(assertionSql(combined.sql,gate)).length>100000)return [...conditions];
 return [combined];
}
export function prepareClaimAssertions(db:SqlDatabase,owner:string,mutationId:string,gate:string,binds:readonly(string|number|null)[],conditions:readonly RecoverabilityCondition[]):SqlStatement[]{
 return conditions.map(condition=>db.prepare(assertionSql(condition.sql,gate)).bind(owner,mutationId,...condition.bindings,...binds));
}
/** Reuse only inside a writer's already-authorized atomic batch. No independent effects. */
export function recoverabilityAssertions(db:SqlDatabase,owner:string,mutationId:string,quote:ProspectiveRecoverabilityResult,gate:string,binds:(string|number|null)[]):SqlStatement[]{
 return prepareClaimAssertions(db,owner,mutationId,gate,binds,recoverabilityConditions(owner,mutationId,quote,binds));
}
