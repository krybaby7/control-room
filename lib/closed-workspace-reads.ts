import {CURRENT_WORKSPACE_READ_SQL,BASELINE_REMOVAL_READ_SQL,readCurrent,type SqlDatabase,type SqlStatement} from './workspace-store.ts';
import {OPERATIONAL_WATERMARK_READ_SQL,validateOperationalWatermarks} from './operational-watermarks.ts';
import {WORKSPACE_NAMESPACE_READ_SQL,getWorkspaceNamespaces} from './workspace-namespaces.ts';
import {MUTATION_ADMISSION_READ_SQL,readMutationAdmission} from './mutation-admission-reader.ts';
import {mutationEpoch} from './idempotency-retention.ts';
import {currentWeek} from './calendar.ts';
import {buildRecoveryReadPageQueries} from './recoverability-read-pages.ts';
import {OWNER_TABLES,type RegisteredOwnerTable} from './workspace-modules.ts';
import {BUNDLE_LIMITS} from './workspace-export-core.ts';
import {canonical} from './canonical-json.ts';
export const RECOVERY_AUDIT_READ_SQL='SELECT event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json FROM audit_events WHERE user_id=? AND event_id>? AND NOT EXISTS(SELECT 1 FROM json_each(?) frozen WHERE frozen.key=audit_events.stream_id AND audit_events.stream_sequence>frozen.value) ORDER BY event_id LIMIT ?';
type Bind=string|number|null;
type Result=Awaited<ReturnType<SqlDatabase['batch']>>[number];
type Descriptor={native:SqlStatement;maximumRows:number};
function fail():never{throw new Error('Invalid closed recovery batch response or read scope.');}
function rows(result:Result|undefined,maximum:number):unknown[]{const value=result?.results;if(!Array.isArray(value)||value.length>maximum||value.some(row=>!row||typeof row!=='object'||Array.isArray(row)))fail();return value;}
function same(left:readonly Bind[],right:readonly Bind[]):boolean{return left.length===right.length&&left.every((value,index)=>value===right[index]);}
/** Private compiled SELECT-only substrate. The two factories below fix all
 * permitted recipes; there is no public query/owner/backend configuration. */
function coordinator(db:SqlDatabase,owner:string,now:string,recipe:(sql:string,values:Bind[])=>number,namespaceLast:boolean){
 if(!owner||!Number.isFinite(Date.parse(now)))fail();
 type Pending={statements:Descriptor[];resolve:(result:Result[])=>void;reject:(error:unknown)=>void};
 const descriptors=new WeakMap<SqlStatement,()=>Descriptor>(),pending:Pending[]=[];
 let timer:ReturnType<typeof setTimeout>|undefined,inFlight:Promise<void>|undefined,closed=false,failure:unknown,lastNamespace:unknown[]|undefined;
 // One event-turn barrier gathers dependent readers' ready microtask chains.
 // It never admits another command or changes pagination/concurrency limits.
 function schedule(){if(timer!==undefined||inFlight||closed||!pending.length)return;timer=setTimeout(()=>{timer=undefined;inFlight=flush().finally(()=>{inFlight=undefined;schedule();});},0);}
 async function flush(){const entries=pending.splice(0),flat=entries.flatMap(entry=>entry.statements);try{
  if(!flat.length||flat.length>10)fail();
  const statements=flat.map(value=>value.native);if(namespaceLast)statements.push(db.prepare(WORKSPACE_NAMESPACE_READ_SQL).bind(owner));
  if(statements.length>11)fail();const results=await db.batch(statements);if(!Array.isArray(results)||results.length!==statements.length)fail();
  for(const [index,value]of flat.entries())rows(results[index],value.maximumRows);
  if(namespaceLast)lastNamespace=rows(results.at(-1),1).map(row=>Object.freeze({...row as Record<string,unknown>}));
  let offset=0;for(const entry of entries){entry.resolve(results.slice(offset,offset+entry.statements.length));offset+=entry.statements.length;}
 }catch(error){failure=error;for(const entry of entries)entry.reject(error);for(const entry of pending.splice(0))entry.reject(error);}}
 function enqueue(statements:Descriptor[]):Promise<Result[]>{if(closed||failure!==undefined)return Promise.reject(failure??new Error('Closed workspace read coordinator.'));return new Promise((resolve,reject)=>{pending.push({statements,resolve,reject});schedule();});}
 const reader:SqlDatabase={prepare(sql){
  let bindings:Bind[]|undefined,started=false;const statement:SqlStatement={bind(...values){if(started)fail();recipe(sql,values);bindings=values;return statement;},
  async first<T>(){const result=await enqueue([take()]);return (rows(result[0],1)[0]??null)as T|null;},async all<T>(){const descriptor=take(),result=await enqueue([descriptor]);return {results:rows(result[0],descriptor.maximumRows)as T[]};},async run(){fail();}};
  function take(){if(started||!bindings)fail();started=true;const maximumRows=recipe(sql,bindings);return {native:db.prepare(sql).bind(...bindings),maximumRows};}
  descriptors.set(statement,take);return statement;
 },async batch(statements){if(!Array.isArray(statements)||!statements.length||statements.length>8)fail();return enqueue(statements.map(statement=>{const take=descriptors.get(statement);if(!take)fail();return take();}));}};
 return {reader,async namespaces(){if(!namespaceLast||pending.length||inFlight||lastNamespace===undefined||closed||failure!==undefined)fail();const captured=lastNamespace;
  const namespaceReader:SqlDatabase={prepare(sql){if(sql!==WORKSPACE_NAMESPACE_READ_SQL)fail();let bound=false;const statement:SqlStatement={bind(...values){if(bound||!same(values,[owner]))fail();bound=true;return statement;},async first<T>(){if(!bound)fail();return (captured[0]??null)as T|null;},async all(){fail();},async run(){fail();}};return statement;},async batch(){fail();}};
  return getWorkspaceNamespaces(namespaceReader,owner);
 },async close(){closed=true;if(timer!==undefined){clearTimeout(timer);timer=undefined;}for(const entry of pending.splice(0))entry.reject(new Error('Closed workspace read coordinator.'));await inFlight;}};
}
function planningRecipe(sql:string,values:Bind[],owner:string,now:string):number|undefined{
 if(sql===CURRENT_WORKSPACE_READ_SQL){if(!same(values,[currentWeek(now),owner]))fail();return 1;}
 if(sql===BASELINE_REMOVAL_READ_SQL){if(values.length!==2||values[0]!==owner||typeof values[1]!=='string')fail();let ids:unknown;try{ids=JSON.parse(values[1]);}catch{fail();}if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))fail();return ids.length;}
}
/** Fresh final-image reads only. Every cohort ends with the actual owner namespace
 * SELECT; only the last completed cohort's row is decoded as the final namespace.
 * All existing readers/decoders and full-image/CAS assertions remain mandatory. */
export function createFinalRecoveryReads(db:SqlDatabase,owner:string,now:string,watermarks:Record<string,number>){
 validateOperationalWatermarks(watermarks);const frozen=JSON.parse(canonical(watermarks))as Record<string,number>,vector=canonical(frozen);
 return coordinator(db,owner,now,(sql,values)=>{
  const planning=planningRecipe(sql,values,owner,now);if(planning!==undefined)return planning;
  if(sql===OPERATIONAL_WATERMARK_READ_SQL){if(!same(values,[owner]))fail();return 1;}
  if(sql===RECOVERY_AUDIT_READ_SQL){if(values.length!==4||values[0]!==owner||typeof values[1]!=='string'||values[2]!==vector||values[3]!==BUNDLE_LIMITS.pageSize)fail();return BUNDLE_LIMITS.pageSize;}
  const tags=[...sql.matchAll(/SELECT '([a-z_]+)' AS snapshot_tag/gu)].map(match=>match[1]);if(!tags.length||tags.length>5||new Set(tags).size!==tags.length||values[0]!==owner)fail();
  let index=1;const tables:Array<{table:RegisteredOwnerTable;after:string}>=[];let audit:{after:string;watermarks:Record<string,number>}|undefined;
  for(const tag of tags){const after=values[index++];if(typeof after!=='string')fail();if(tag==='__audit__'){if(values[index++]!==vector)fail();audit={after,watermarks:frozen};}else{if(!OWNER_TABLES.includes(tag as RegisteredOwnerTable))fail();tables.push({table:tag as RegisteredOwnerTable,after});}}
  if(index!==values.length)fail();const expected=buildRecoveryReadPageQueries(owner,{tables,...(audit?{audit}:{})});if(expected.length!==1||expected[0].sql!==sql||!same(expected[0].bindings,values))fail();return tags.length*BUNDLE_LIMITS.pageSize;
 },true);
}
/** Post-write admission and planning SELECT share one fresh snapshot. Preserve
 * admission/epoch/receipt precedence by exposing planning decoder refusal lazily. */
export async function readCommittedWorkspace(db:SqlDatabase,owner:string,mutationId:string,now:string){
 const epoch=mutationEpoch(mutationId),reads=coordinator(db,owner,now,(sql,values)=>{const planning=planningRecipe(sql,values,owner,now);if(planning!==undefined)return planning;if(sql!==MUTATION_ADMISSION_READ_SQL||!same(values,[owner,mutationId,epoch]))fail();return 1;},false);
 try{const [admission,current]=await Promise.allSettled([readMutationAdmission(reads.reader,owner,mutationId),readCurrent(reads.reader,owner,now)]);if(admission.status==='rejected')throw admission.reason;return {admission:admission.value,current(){if(current.status==='rejected')throw current.reason;return current.value;}};}finally{await reads.close();}
}
