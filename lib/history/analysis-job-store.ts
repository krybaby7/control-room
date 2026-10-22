import {sourceSemanticDigest} from './source-identity.ts';
import {z} from 'zod';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {privateUpdateGrowth} from '../private-growth.ts';
import {requirePrivateCapacity,type PrivateGrowth} from '../private-capacity.ts';
import {readHistoryRecord} from './store.ts';
const id=z.string().min(1).max(128),stamp=z.string().datetime({offset:true}),digest=z.string().regex(/^[a-f0-9]{64}$/u),count=z.number().int().nonnegative().safe();
const unique=(values:string[])=>new Set(values).size===values.length;
const destination=z.object({projectId:id,areaId:id.nullable()}).strict();
export const AreaAnalysisOriginalSchema=z.union([
 z.object({sourceId:id,epoch:id,scopeRevision:z.number().int().positive().safe(),watermark:z.number().int().positive().safe(),pageId:z.string().min(1).max(16384)}).strict(),
 z.object({ruleId:id,ruleRevision:z.number().int().positive().safe(),projectId:id,areaId:id.nullable(),sourceIds:z.array(id).min(1).max(100).refine(unique),affectedDestinations:z.array(destination).min(1).max(2).refine(values=>new Set(values.map(canonical)).size===values.length)}).strict(),
 z.object({sourceId:id,removalId:id}).strict(),
]);
export type AreaAnalysisOriginal=z.infer<typeof AreaAnalysisOriginalSchema>;
export const AnalysisJobPinSchema=z.object({watermark:z.string().min(1).max(1024),inputDigest:digest}).strict();
export type AnalysisJobPin=z.infer<typeof AnalysisJobPinSchema>;
const fence=z.object({kind:z.enum(['source','association_rule','source_removal','ingest_page']),logicalId:z.string().min(1).max(1024),physicalId:z.string().min(1).max(128),rowRevision:z.number().int().positive().safe(),contentHash:digest,semanticDigest:digest.optional()}).strict();
const ControlSchema=z.object({format:z.literal('history-analysis-job/v1'),originalPayload:z.string().min(1).max(65536),originalDigest:digest,controlRevision:z.number().int().positive().safe(),mode:z.enum(['analyze_retained','reproject_removed_source']),fences:z.array(fence).min(1).max(103),pin:AnalysisJobPinSchema,pinDigest:digest,cursor:z.string().min(1).max(16384).nullable(),reservedRequestIds:z.array(id).max(250).refine(unique),attempt:count,retryAt:stamp.nullable(),failure:z.enum(['access','stale_input','processing','timeout']).nullable(),lease:z.object({token:z.string().uuid(),expiresAt:stamp,principalRef:id}).strict().nullable()}).strict();
export type AreaAnalysisControl=z.infer<typeof ControlSchema>;
export interface AreaAnalysisJob {ownerId:string;intentId:string;status:string;executionEpoch:number;cancelRequested:boolean;notBefore:string;serialized:string;original:AreaAnalysisOriginal;control:AreaAnalysisControl|null;}
export interface AnalysisJobSqlGuard {sql:string;bindings:(string|number|null)[]}
/** Native private service identity only. Neither this authority nor a job pin is
 * paid inference consent; the separate analysis journal must authorize inference. */
export interface AreaAnalysisAuthority {ownerId:string;principalRef:string;verifiedAt:string;expiresAt:string;guardAt(now:string):Promise<AnalysisJobSqlGuard|null>;pinGuardAt(pin:AnalysisJobPin,now:string):Promise<AnalysisJobSqlGuard|null>;}
export const MAX_ANALYSIS_JOB_BYTES=1_800_000;
function encode(control:AreaAnalysisControl){const text=canonical(ControlSchema.parse(control));if(new TextEncoder().encode(text).length>MAX_ANALYSIS_JOB_BYTES)throw Error('Analysis job exceeds private payload bound');return text;}
export async function readAreaAnalysisJob(db:SqlDatabase,ownerId:string,intentId:string):Promise<AreaAnalysisJob|null>{
 const row=await db.prepare("SELECT status,execution_epoch,cancel_requested,not_before,payload_json FROM workspace_job_intents WHERE user_id=? AND id=? AND kind='area_analysis'").bind(ownerId,intentId).first<{status:string;execution_epoch:number;cancel_requested:number;not_before:string;payload_json:string}>();if(!row||!Number.isSafeInteger(row.execution_epoch)||row.execution_epoch<0||new TextEncoder().encode(row.payload_json).length>MAX_ANALYSIS_JOB_BYTES)return null;
 try{const raw=JSON.parse(row.payload_json),parsed=ControlSchema.safeParse(raw),control=parsed.success?parsed.data:null,original=AreaAnalysisOriginalSchema.parse(control?JSON.parse(control.originalPayload):raw);if(control){encode(control);if(control.originalDigest!==await contentHash(control.originalPayload)||control.mode!==('removalId'in original?'reproject_removed_source':'analyze_retained')||control.pinDigest!==await contentHash(canonical([control.originalDigest,control.fences,control.pin])))return null;}return {ownerId,intentId,status:row.status,executionEpoch:row.execution_epoch,cancelRequested:row.cancel_requested!==0,notBefore:row.not_before,serialized:row.payload_json,original,control};}catch{return null;}
}
async function principal(authority:AreaAnalysisAuthority|undefined,ownerId:string,now:string){stamp.parse(now);if(!authority||authority.ownerId!==ownerId||!id.safeParse(authority.principalRef).success||!stamp.safeParse(authority.verifiedAt).success||Date.parse(authority.verifiedAt)>Date.parse(now)||!stamp.safeParse(authority.expiresAt).success||Date.parse(authority.expiresAt)<=Date.parse(now))return null;return authority.guardAt(now);}
function globalGuard(job:AreaAnalysisJob):AnalysisJobSqlGuard{return {sql:'COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=?',bindings:[job.ownerId,job.executionEpoch]};}
function combine(parts:AnalysisJobSqlGuard[]):AnalysisJobSqlGuard{return {sql:parts.map(part=>'('+part.sql+')').join(' AND '),bindings:parts.flatMap(part=>part.bindings)};}
let guardSequence=0;
/** Bind the trusted predicate vector once so100 selected sources remain below
 * D1's100-parameter ceiling. Each nested guard receives its own SQL-local name. */
function compactGuard(guard:AnalysisJobSqlGuard):AnalysisJobSqlGuard{const name='history_analysis_values_'+(++guardSequence);let index=0;const sql=guard.sql.replace(/'(?:''|[^'])*'|"(?:[^"]|"")*"|\?/gu,token=>token==='?'?`json_extract(${name}.value,'$[${index++}]')`:token);if(index!==guard.bindings.length)throw Error('Analysis guard bindings differ');return {sql:`EXISTS(WITH ${name} AS MATERIALIZED(SELECT ? value) SELECT 1 FROM ${name} WHERE ${sql})`,bindings:[canonical(guard.bindings)]};}
async function pinnedGuard(db:SqlDatabase,job:AreaAnalysisJob,authority:AreaAnalysisAuthority|undefined,now:string,control=job.control){const access=await principal(authority,job.ownerId,now);if(!access||!control)return null;const pin=await authority!.pinGuardAt(control.pin,now);if(!pin)return null;const parts=[access,pin,globalGuard(job)];for(const expected of control.fences){const current=await readHistoryRecord(db,job.ownerId,expected.kind,expected.logicalId);if(!current||current.record.id!==expected.physicalId||current.rowRevision!==expected.rowRevision||current.contentHash!==expected.contentHash)return null;parts.push({sql:'EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=? AND row_revision=? AND content_hash=?)',bindings:[job.ownerId,expected.physicalId,expected.rowRevision,expected.contentHash]});}return combine(parts);}
async function captureFences(db:SqlDatabase,job:AreaAnalysisJob):Promise<AreaAnalysisControl['fences']|null>{
 const result:AreaAnalysisControl['fences']=[],original=job.original,sourceIds='sourceIds'in original?original.sourceIds:[original.sourceId];
 for(const sourceId of [...sourceIds].sort()){const source=await readHistoryRecord(db,job.ownerId,'source',sourceId);if(!source||source.record.value.executionEpoch!==job.executionEpoch)return null;const value=source.record.value;
  if('removalId'in original?value.removedAt===null:value.removedAt!==null)return null;
  if('watermark'in original&&(value.epoch!==original.epoch||value.scopeRevision!==original.scopeRevision))return null;
  result.push({kind:'source',logicalId:sourceId,physicalId:source.record.id,rowRevision:source.rowRevision,contentHash:source.contentHash,semanticDigest:await sourceSemanticDigest(value)});
 }
 if('watermark'in original){const logicalId=await contentHash(canonical([original.sourceId,original.epoch,original.scopeRevision,original.pageId])),receipt=await readHistoryRecord(db,job.ownerId,'ingest_page',logicalId);if(!receipt||receipt.record.value.executionEpoch!==job.executionEpoch||receipt.record.value.acknowledgement.watermark!==String(original.watermark))return null;result.push({kind:'ingest_page',logicalId,physicalId:receipt.record.id,rowRevision:receipt.rowRevision,contentHash:receipt.contentHash});}
 if('ruleId'in original){const rule=await readHistoryRecord(db,job.ownerId,'association_rule',original.ruleId);if(!rule||rule.rowRevision!==original.ruleRevision||rule.record.value.rowRevision!==original.ruleRevision||rule.record.value.projectId!==original.projectId||rule.record.value.areaId!==original.areaId)return null;let selected:string[];try{selected=[...new Set(rule.record.value.targetIds.map(target=>z.tuple([id,z.string().min(1).max(512)]).parse(JSON.parse(target))[0]))].sort();}catch{return null;}if(canonical(selected)!==canonical([...original.sourceIds].sort())||!original.affectedDestinations.some(d=>d.projectId===original.projectId&&d.areaId===original.areaId))return null;result.push({kind:'association_rule',logicalId:original.ruleId,physicalId:rule.record.id,rowRevision:rule.rowRevision,contentHash:rule.contentHash});}
 if('removalId'in original){const removal=await readHistoryRecord(db,job.ownerId,'source_removal',original.removalId),source=await readHistoryRecord(db,job.ownerId,'source',original.sourceId);if(!removal||removal.record.value.sourceId!==original.sourceId||removal.record.value.removedAt!==source?.record.value.removedAt)return null;result.push({kind:'source_removal',logicalId:original.removalId,physicalId:removal.record.id,rowRevision:removal.rowRevision,contentHash:removal.contentHash});}
 return result;
}
async function write(db:SqlDatabase,job:AreaAnalysisJob,control:AreaAnalysisControl,status:string,guard:AnalysisJobSqlGuard,options:{notBefore?:string;cancel?:boolean;refreshGuard?:()=>Promise<AnalysisJobSqlGuard|null>}={}):Promise<AreaAnalysisJob|null>{
 const serialized=encode(control),notBefore=options.notBefore??job.notBefore,cancel=options.cancel??job.cancelRequested,capacity=await requirePrivateCapacity(db,job.ownerId,{growth:[await privateUpdateGrowth(db,job.ownerId,'workspace_job_intents','id=?',[job.intentId],{payload_json:serialized,status,not_before:notBefore,cancel_requested:cancel?1:0})]});
 if(options.refreshGuard){const fresh=await options.refreshGuard();if(!fresh)return null;guard=fresh;}guard=compactGuard(guard);
 const changed=await db.prepare(`WITH authority AS MATERIALIZED(SELECT 1 WHERE ${guard.sql}),capacity AS MATERIALIZED(SELECT 1 WHERE ${capacity.sql}) UPDATE workspace_job_intents SET payload_json=?,status=?,not_before=?,cancel_requested=? WHERE user_id=? AND id=? AND kind='area_analysis' AND payload_json=? AND status=? AND execution_epoch=? AND cancel_requested=? AND EXISTS(SELECT 1 FROM authority) AND EXISTS(SELECT 1 FROM capacity)`).bind(...guard.bindings,...capacity.bindings,serialized,status,notBefore,cancel?1:0,job.ownerId,job.intentId,job.serialized,job.status,job.executionEpoch,job.cancelRequested?1:0).run();return changed.meta.changes===1?{...job,control,serialized,status,notBefore,cancelRequested:cancel}:null;
}
export async function adoptAreaAnalysisJob(db:SqlDatabase,ownerId:string,intentId:string,options:{authority?:AreaAnalysisAuthority;pin:AnalysisJobPin;now:string}):Promise<AreaAnalysisJob|null>{
 const job=await readAreaAnalysisJob(db,ownerId,intentId);if(!job||job.cancelRequested||job.status!=='pending')return null;const pin=AnalysisJobPinSchema.parse(options.pin);if(job.control)return canonical(job.control.pin)===canonical(pin)&&await pinnedGuard(db,job,options.authority,options.now)?job:null;
 const fences=await captureFences(db,job);if(!fences)return null;const originalDigest=await contentHash(job.serialized),control:AreaAnalysisControl={format:'history-analysis-job/v1',originalPayload:job.serialized,originalDigest,controlRevision:1,mode:'removalId'in job.original?'reproject_removed_source':'analyze_retained',fences,pin,pinDigest:await contentHash(canonical([originalDigest,fences,pin])),cursor:null,reservedRequestIds:[],attempt:0,retryAt:null,failure:null,lease:null},guard=await pinnedGuard(db,job,options.authority,options.now,control);return guard?write(db,job,control,'pending',guard):null;
}
export async function areaAnalysisClaimGuard(db:SqlDatabase,job:AreaAnalysisJob,authority:AreaAnalysisAuthority|undefined,now:string):Promise<AnalysisJobSqlGuard|null>{const control=job.control,lease=control?.lease;if(job.status!=='running'||job.cancelRequested||!lease||lease.principalRef!==authority?.principalRef||Date.parse(lease.expiresAt)<=Date.parse(now))return null;const pinned=await pinnedGuard(db,job,authority,now);return pinned?compactGuard(combine([pinned,{sql:"EXISTS(SELECT 1 FROM workspace_job_intents WHERE user_id=? AND id=? AND kind='area_analysis' AND status='running' AND payload_json=? AND execution_epoch=? AND cancel_requested=0)",bindings:[job.ownerId,job.intentId,job.serialized,job.executionEpoch]}])):null;}
export async function isAreaAnalysisClaimCurrent(db:SqlDatabase,job:AreaAnalysisJob,authority:AreaAnalysisAuthority|undefined,now:string):Promise<boolean>{const guard=await areaAnalysisClaimGuard(db,job,authority,now);return !!guard&&!!await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first();}
export async function claimAreaAnalysisJob(db:SqlDatabase,ownerId:string,intentId:string,options:{authority?:AreaAnalysisAuthority;now:string;leaseMs?:number}):Promise<AreaAnalysisJob|null>{
 const leaseMs=options.leaseMs??20000;if(!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>20000)throw Error('Analysis lease must be at most 20 seconds');const job=await readAreaAnalysisJob(db,ownerId,intentId);if(!job||!job.control||job.cancelRequested||Date.parse(job.notBefore)>Date.parse(options.now)||job.status!=='pending'&&!(job.status==='running'&&job.control.lease&&Date.parse(job.control.lease.expiresAt)<=Date.parse(options.now)))return null;const guard=await pinnedGuard(db,job,options.authority,options.now);if(!guard)return null;
 return write(db,job,{...job.control,controlRevision:job.control.controlRevision+1,attempt:job.control.attempt+1,lease:{token:crypto.randomUUID(),principalRef:options.authority!.principalRef,expiresAt:new Date(Math.min(Date.parse(options.now)+leaseMs,Date.parse(options.authority!.expiresAt))).toISOString()}},'running',guard);
}
export async function renewAreaAnalysisJob(db:SqlDatabase,job:AreaAnalysisJob,options:{authority?:AreaAnalysisAuthority;now:string;leaseMs?:number}){const ms=options.leaseMs??20000;if(!Number.isSafeInteger(ms)||ms<1||ms>20000)throw Error('Invalid analysis lease');const guard=await areaAnalysisClaimGuard(db,job,options.authority,options.now);return guard?write(db,job,{...job.control!,controlRevision:job.control!.controlRevision+1,lease:{...job.control!.lease!,expiresAt:new Date(Math.min(Date.parse(options.now)+ms,Date.parse(options.authority!.expiresAt))).toISOString()}},'running',guard):null;}
/** Processor must persist its actual journal/publication before advancing this
 * checkpoint. This helper authorizes no provider call or accepted owner fact. */
export async function finishAreaAnalysisJob(db:SqlDatabase,job:AreaAnalysisJob,options:{authority?:AreaAnalysisAuthority;now:string;currentTime?:()=>string;outcome:'complete'|'continue'|'failed';cursor:string|null;reservedRequestIds:readonly string[];retryAt?:string;failure?:AreaAnalysisControl['failure']}){
 const clock=()=>stamp.parse(options.currentTime?.()??options.now),refreshGuard=async()=>{const refreshed=await areaAnalysisClaimGuard(db,job,options.authority,clock()),time=Date.parse(clock());return refreshed&&job.control?.lease&&options.authority&&Date.parse(job.control.lease.expiresAt)>time&&Date.parse(options.authority.expiresAt)>time?refreshed:null;};
 const guard=await refreshGuard();if(!guard||!job.control)return null;if(options.outcome==='failed'&&options.cursor!==job.control.cursor)throw Error('Failed analysis cannot advance its cursor');const previous=job.control.reservedRequestIds;if(canonical(options.reservedRequestIds)!==canonical(previous))throw Error('Analysis reserved request provenance must match durable reservations');if(options.outcome==='complete'&&options.cursor!==null)throw Error('Analysis continuation remains');const retryAt=options.outcome==='complete'?null:stamp.parse(options.retryAt??options.now),control={...job.control,controlRevision:job.control.controlRevision+1,cursor:options.cursor,reservedRequestIds:[...options.reservedRequestIds],lease:null,retryAt,failure:options.outcome==='failed'?(options.failure??'processing'):null};return write(db,job,control,options.outcome==='complete'?'succeeded':'pending',guard,{notBefore:retryAt??options.now,refreshGuard});
}
/** Cancellation uses current private controller authority/global epoch but can
 * settle stale input. It preserves original pin, cursor and reserved requests. */
export async function cancelAreaAnalysisJob(db:SqlDatabase,ownerId:string,intentId:string,authority:AreaAnalysisAuthority|undefined,now:string){const job=await readAreaAnalysisJob(db,ownerId,intentId);if(!job?.control||!['pending','running'].includes(job.status))return null;const access=await principal(authority,ownerId,now);return access?write(db,job,{...job.control,controlRevision:job.control.controlRevision+1,lease:null},'cancelled',combine([access,globalGuard(job)]),{cancel:true,notBefore:now}):null;}
export async function retryAreaAnalysisJob(db:SqlDatabase,job:AreaAnalysisJob,authority:AreaAnalysisAuthority|undefined,now:string){if(!job.control||job.status!=='cancelled')return null;const guard=await pinnedGuard(db,job,authority,now);return guard?write(db,job,{...job.control,controlRevision:job.control.controlRevision+1,lease:null,retryAt:now,failure:null},'pending',guard,{cancel:false,notBefore:now}):null;}

const nativeRequestId=z.string().regex(/^history-analysis-v1:[a-f0-9]{64}$/u);
/** Persist the journal's native reserved request BEFORE a possible provider call.
 * This is provenance only and neither reserves money nor grants consent. */
export async function appendAreaAnalysisReservation(db:SqlDatabase,job:AreaAnalysisJob,authority:AreaAnalysisAuthority|undefined,now:string,requestId:string):Promise<AreaAnalysisJob|null>{
 nativeRequestId.parse(requestId);const guard=await areaAnalysisClaimGuard(db,job,authority,now);if(!guard||!job.control)return null;
 if(job.control.reservedRequestIds.includes(requestId))return await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first()?job:null;
 return write(db,job,{...job.control,controlRevision:job.control.controlRevision+1,reservedRequestIds:[...job.control.reservedRequestIds,requestId]},'running',guard);
}
export interface PreparedAreaAnalysisProgress {readonly ownerId:string;readonly intentId:string;readonly inputDigest:string;}
export interface AreaAnalysisProgressRuntime {
 ownerId:string;intentId:string;pin:AnalysisJobPin;inputDigest:string;
 condition:AnalysisJobSqlGuard;postcondition:AnalysisJobSqlGuard;privateGrowth:PrivateGrowth[];nextJob:AreaAnalysisJob;
 statement(db:SqlDatabase,publisherGuardSql:string,guardBindings:(string|number|null)[]):SqlStatement;
}
const progressPorts=new WeakMap<PreparedAreaAnalysisProgress,{db:SqlDatabase;runtime:AreaAnalysisProgressRuntime}>();
export async function prepareAreaAnalysisProgress(db:SqlDatabase,job:AreaAnalysisJob,options:{authority?:AreaAnalysisAuthority;now:string;inputDigest:string;outcome:'complete'|'continue';cursor:string|null;reservedRequestIds:readonly string[];retryAt?:string}):Promise<PreparedAreaAnalysisProgress|null>{
 digest.parse(options.inputDigest);const condition=await areaAnalysisClaimGuard(db,job,options.authority,options.now);if(!condition||!job.control)return null;
 const previous=job.control.reservedRequestIds;if(canonical(options.reservedRequestIds)!==canonical(previous))throw Error('Analysis reserved request provenance must match durable reservations');for(const request of options.reservedRequestIds)nativeRequestId.parse(request);if(options.outcome==='complete'&&options.cursor!==null)throw Error('Analysis continuation remains');
 const retryAt=options.outcome==='complete'?null:stamp.parse(options.retryAt??options.now),control={...job.control,controlRevision:job.control.controlRevision+1,cursor:options.cursor,reservedRequestIds:[...options.reservedRequestIds],lease:null,retryAt,failure:null},serialized=encode(control),status=options.outcome==='complete'?'succeeded':'pending',notBefore=retryAt??options.now;
 const privateGrowth=[await privateUpdateGrowth(db,job.ownerId,'workspace_job_intents','id=?',[job.intentId],{payload_json:serialized,status,not_before:notBefore,cancel_requested:0})];await requirePrivateCapacity(db,job.ownerId,{growth:privateGrowth});
 const nextJob:AreaAnalysisJob={...job,control,serialized,status,notBefore,cancelRequested:false},runtime:AreaAnalysisProgressRuntime={ownerId:job.ownerId,intentId:job.intentId,pin:structuredClone(job.control.pin),inputDigest:options.inputDigest,condition,privateGrowth,nextJob,postcondition:{sql:"EXISTS(SELECT 1 FROM workspace_job_intents WHERE user_id=? AND id=? AND kind='area_analysis' AND status=? AND payload_json=? AND execution_epoch=? AND cancel_requested=0 AND not_before=?)",bindings:[job.ownerId,job.intentId,status,serialized,job.executionEpoch,notBefore]},statement(target,publisherGuardSql,guardBindings){if(target!==db||!publisherGuardSql)throw Error('Prepared analysis publication database/guard differs');return target.prepare(`UPDATE workspace_job_intents SET payload_json=?,status=?,not_before=? WHERE user_id=? AND id=? AND kind='area_analysis' AND status=? AND payload_json=? AND execution_epoch=? AND cancel_requested=0 AND (${publisherGuardSql})`).bind(serialized,status,notBefore,job.ownerId,job.intentId,job.status,job.serialized,job.executionEpoch,...guardBindings);}};
 // Freeze nested values as well: callers cannot mutate a correctly branded port's
 // input pin, predicates, growth or next state before the publication quote.
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};freeze(runtime);
 const port=Object.freeze({ownerId:job.ownerId,intentId:job.intentId,inputDigest:options.inputDigest});progressPorts.set(port,{db,runtime});return port;
}
/** The publisher alone composes this native port. Wire/model/import objects do
 * not acquire its WeakMap identity by copying exposed fields. Assert condition
 * BEFORE publication changes source input/head; combine privateGrowth with ALL
 * publication/journal/head writes; execute statement under the transient native
 * publication guard AFTER projection writes, then assert postcondition. */
export function requirePreparedAreaAnalysisProgress(port:PreparedAreaAnalysisProgress,db:SqlDatabase,ownerId:string,inputDigest:string):AreaAnalysisProgressRuntime{
 const prepared=progressPorts.get(port);if(!prepared||prepared.db!==db||prepared.runtime.ownerId!==ownerId||prepared.runtime.inputDigest!==inputDigest)throw Error('Native prepared analysis progress is required');return prepared.runtime;
}

/** A new native snapshot may restart the same trigger after planning/chat input
 * changes. It never steals a live lease, changes original source scope, drops a
 * reserved request, refunds inference, or rebases work under the old lease. */
export async function rebaseAreaAnalysisJob(db:SqlDatabase,ownerId:string,intentId:string,options:{authority?:AreaAnalysisAuthority;pin:AnalysisJobPin;now:string}):Promise<AreaAnalysisJob|null>{
 stamp.parse(options.now);const job=await readAreaAnalysisJob(db,ownerId,intentId);if(!job?.control||job.cancelRequested)return null;
 const control=job.control,eligible=job.status==='pending'&&control.lease===null||job.status==='running'&&control.lease!==null&&Date.parse(control.lease.expiresAt)<=Date.parse(options.now);if(!eligible)return null;
 const pin=AnalysisJobPinSchema.parse(options.pin),fences=await captureFences(db,job);
 // Trigger scope and original provenance are immutable. A changed source/rule
 // requires its own newly authorized trigger. Only native semantic source
 // digests can prove an operational capability-only row change; legacy fences
 // remain exact. The new lease still uses the recaptured physical row CAS.
 if(!fences||fences.length!==control.fences.length||fences.some((current,index)=>{const previous=control.fences[index];if(canonical(current)===canonical(previous))return false;if(current.kind!=='source'||previous.kind!=='source')return true;const {semanticDigest:oldSemantic,...oldPhysical}=previous,{semanticDigest:newSemantic,...newPhysical}=current;if(canonical(oldPhysical)===canonical(newPhysical))return oldSemantic!==undefined&&oldSemantic!==newSemantic;return current.logicalId!==previous.logicalId||current.physicalId!==previous.physicalId||!oldSemantic||oldSemantic!==newSemantic;}))return null;
 const next:AreaAnalysisControl={...control,controlRevision:control.controlRevision+1,fences,pin,pinDigest:await contentHash(canonical([control.originalDigest,fences,pin])),cursor:null,lease:null,retryAt:options.now,failure:null};
 const native=await pinnedGuard(db,job,options.authority,options.now,next);if(!native)return null;
 const queue:AnalysisJobSqlGuard={sql:"EXISTS(SELECT 1 FROM workspace_job_intents WHERE user_id=? AND id=? AND kind='area_analysis' AND status=? AND payload_json=? AND execution_epoch=? AND cancel_requested=0)",bindings:[ownerId,intentId,job.status,job.serialized,job.executionEpoch]},guard=combine([native,queue]);
 if(canonical(pin)===canonical(control.pin)&&canonical(fences)===canonical(control.fences)){const compact=compactGuard(guard);return await db.prepare('SELECT 1 WHERE '+compact.sql).bind(...compact.bindings).first()?job:null;}
 return write(db,job,next,'pending',guard,{notBefore:options.now,cancel:false});
}
