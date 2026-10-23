import type {SqlDatabase} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {HistorySyncJobSchema,MAX_HISTORY_JOB_PAYLOAD_BYTES} from './job-store.ts';
import {collectionContentRunId} from './collection.ts';
import {historyRecordId,parseHistoryRecord} from './record.ts';
export interface HistoryActivity {
 sourceId:string;status:'observed'|'unknown'|'unavailable';running:boolean;nextDueAt:string|null;oldestPendingAt:string|null;
 continuation:'inventory'|'content'|'finalizing'|null;lastAttemptAt:string|null;
 failure:{phase:'inventory'|'content';at:string;kind:'read'|'access'|'commit'|'timeout'}|null;
 heartbeatAt:null;offline:false;stalePending:boolean;unknownJobs:number;diagnostic:string|null;
}
const MAX_ROWS=1000,MAX_BYTES=2*1024*1024;
function empty(sourceId:string):HistoryActivity{return {sourceId,status:'unavailable',running:false,nextDueAt:null,oldestPendingAt:null,continuation:null,lastAttemptAt:null,failure:null,heartbeatAt:null,offline:false,stalePending:false,unknownJobs:0,diagnostic:null};}
function earliest(a:string|null,b:string){return a===null||Date.parse(b)<Date.parse(a)?b:a;}
function latest(a:string|null,b:string){return a===null||Date.parse(b)>Date.parse(a)?b:a;}
/** One owner scan, bounded in SQL before any private payload transfer. This is
 * queue observation only: no principal, capability, heartbeat or success proof. */
export async function readHistoryActivities(db:SqlDatabase,ownerId:string,sourceIds:readonly string[],now:string):Promise<Map<string,HistoryActivity>>{
 if(!ownerId||ownerId.length>256||sourceIds.length>100||new Set(sourceIds).size!==sourceIds.length||sourceIds.some(id=>!id||id.length>1024)||!Number.isFinite(Date.parse(now)))throw Error('Invalid history activity query');
 const result=new Map(sourceIds.map(id=>[id,empty(id)]));if(!sourceIds.length)return result;
 const ids=JSON.stringify(await Promise.all(sourceIds.map(id=>historyRecordId('source',id))));
 // Metadata only in candidates. LIMIT bounds work even when an owner has a
 // larger queue. Repeating preflight inside fetch closes the read-growth race.
 const cte=`WITH candidates AS MATERIALIZED(SELECT 'job' type,id,length(CAST(payload_json AS BLOB)) bytes FROM workspace_job_intents WHERE user_id=? AND kind IN ('history_import','history_reconcile') AND execution_epoch=COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0) ORDER BY id LIMIT 1001), sources AS MATERIALIZED(SELECT 'source' type,id,length(CAST(payload_json AS BLOB)) bytes FROM project_history WHERE user_id=? AND id IN(SELECT value FROM json_each(?))), bounds AS MATERIALIZED(SELECT (SELECT COUNT(*) FROM candidates) n,COALESCE((SELECT SUM(bytes) FROM candidates),0)+COALESCE((SELECT SUM(bytes) FROM sources),0) bytes)`;
 const bindings=[ownerId,ownerId,ownerId,ids];
 const bound=await db.prepare(cte+' SELECT n,bytes FROM bounds').bind(...bindings).first<{n:number;bytes:number}>();
 const unknown=(diagnostic:string)=>{for(const value of result.values()){value.status='unknown';value.diagnostic=diagnostic;}return result;};
 if(!bound||bound.n>MAX_ROWS||bound.bytes>MAX_BYTES)return unknown('activity_bound_exceeded');
 type Row={type:string;id:string;payload_json:string;status:string|null;not_before:string|null;cancel_requested:number;content_hash:string|null;execution_epoch:number;n:number;bytes:number};
 const rows=(await db.prepare(cte+` SELECT s.type,h.id,h.payload_json,NULL status,NULL not_before,0 cancel_requested,h.content_hash,COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0) execution_epoch,b.n,b.bytes FROM sources s JOIN project_history h ON h.user_id=? AND h.id=s.id CROSS JOIN bounds b WHERE b.n<=1000 AND b.bytes<=2097152 UNION ALL SELECT c.type,j.id,j.payload_json,j.status,j.not_before,j.cancel_requested,NULL content_hash,j.execution_epoch,b.n,b.bytes FROM candidates c JOIN workspace_job_intents j ON j.user_id=? AND j.id=c.id CROSS JOIN bounds b WHERE b.n<=1000 AND b.bytes<=2097152`).bind(...bindings,ownerId,ownerId,ownerId).all<Row>()).results;
 if(rows.some(row=>row.n!==bound.n||row.bytes!==bound.bytes)||rows.filter(row=>row.type==='job').length!==bound.n)return unknown('activity_changed');
 const sources=new Map<string,{epoch:string;scopeRevision:number;executionEpoch:number}>();
 for(const row of rows.filter(row=>row.type==='source')){try{const record=parseHistoryRecord(JSON.parse(row.payload_json));if(record.kind!=='source'||record.id!==row.id||await contentHash(canonical(record))!==row.content_hash)continue;const source=record.value;const value=result.get(source.id);if(!value||source.executionEpoch!==row.execution_epoch||source.paused||source.removedAt!==null)continue;sources.set(source.id,source);value.status='observed';}catch{/* Corrupt source remains unavailable. */}}
 for(const row of rows.filter(row=>row.type==='job')){
  let raw:unknown;try{raw=JSON.parse(row.payload_json);}catch{for(const value of result.values())if(value.status==='observed'){value.unknownJobs++;value.status='unknown';}continue;}
  const sourceId=typeof raw==='object'&&raw!==null&&'sourceId'in raw?String(raw.sourceId):null;
  if(!sourceId){for(const value of result.values())if(value.status==='observed'||value.status==='unknown'){value.unknownJobs++;value.status='unknown';}continue;}
  const value=result.get(sourceId),source=sources.get(sourceId);if(!value||!source)continue;
  const parsed=HistorySyncJobSchema.safeParse(raw);
  if(!parsed.success||new TextEncoder().encode(row.payload_json).length>MAX_HISTORY_JOB_PAYLOAD_BYTES){value.unknownJobs++;value.status='unknown';continue;}
  const p=parsed.data,c=p.continuation;
  if(p.epoch!==source.epoch||p.scopeRevision!==source.scopeRevision||row.execution_epoch!==source.executionEpoch)continue;
  if(c.ownerId!==ownerId||c.sourceId!==p.sourceId||c.epoch!==p.epoch||c.scopeRevision!==p.scopeRevision||c.runId!==(c.phase==='inventory'?c.generation:await collectionContentRunId(c.generation))||!['pending','running','succeeded','cancelled'].includes(row.status??'')){value.unknownJobs++;value.status='unknown';continue;}
  if(c.lastAttemptAt)value.lastAttemptAt=latest(value.lastAttemptAt,c.lastAttemptAt);
  if(row.cancel_requested||row.status==='cancelled')continue;
  if(p.failure&&c.lastAttemptAt&&(!value.failure||Date.parse(c.lastAttemptAt)>Date.parse(value.failure.at)))value.failure={phase:c.phase==='inventory'?'inventory':'content',at:c.lastAttemptAt,kind:p.failure};
  if(row.status!=='pending'&&row.status!=='running')continue;
  value.oldestPendingAt=earliest(value.oldestPendingAt,p.dueAt);
  const phase=c.phase==='complete'?'finalizing':c.phase;
  if(value.continuation===null)value.continuation=phase;
  if(row.status==='pending'){
   if(!row.not_before||!Number.isFinite(Date.parse(row.not_before))){value.unknownJobs++;value.status='unknown';continue;}
   value.nextDueAt=earliest(value.nextDueAt,row.not_before);
  }else if(p.lease&&Date.parse(p.lease.expiresAt)>Date.parse(now)){value.running=true;value.continuation=phase;}
  else {value.stalePending=true;value.diagnostic='expired_running_lease';}
 }
 return result;
}
export async function readHistoryActivity(db:SqlDatabase,ownerId:string,sourceId:string,now:string):Promise<HistoryActivity>{return (await readHistoryActivities(db,ownerId,[sourceId],now)).get(sourceId)!;}
