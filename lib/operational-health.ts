import type {SqlDatabase} from './workspace-store.ts';
import {readWorkspaceUsage} from './workspace-usage.ts';
import {sourceConnectionSchema,sourceTargetSchema} from './sources/validation.ts';
import {canonical,contentHash} from './canonical-json.ts';
export const OPERATIONAL_HEALTH_POLICY=Object.freeze({backupAgeSeconds:86400,pendingDueAgeSeconds:3600,storageWarningRatio:0.9,externalDelivery:'disabled' as const});
type Condition='storage_near_limit'|'backup_missing'|'backup_old'|'backup_clock_unknown'|'jobs_overdue'|'job_clock_unknown'|'sources_stale'|'source_age_unknown';
export interface OperationalHealth {
 generatedAt:string;readOnly:true;readinessGuarantee:false;externalDelivery:'disabled';
 storage:{byteAccounting:'portable logical payload metadata; excludes physical objects, private journals and database overhead';portablePayloadBytes:number;receiptCount:number;backupCatalogBytes:number;backupCatalogCount:number};
 backup:{lastRecordedCompleteAt:string|null;ageSeconds:number|null;coverage:'metadata-only'|'files-recorded'|'unknown';freshReadbackPerformed:false};
 jobs:{duePendingOrRunning:number;oldestDueAgeSeconds:number|null;unknownClockCount:number;ageBasis:'not_before; not enqueue or execution duration'};
 sources:{selected:number;withinRecordedAge:number;stale:number;unknown:number;oldestRecordedSuccessAgeSeconds:number|null;freshnessProof:false};
 conditions:Condition[];policy:typeof OPERATIONAL_HEALTH_POLICY;
}
function count(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('Health aggregate is unavailable.');return value;}
function age(value:unknown,now:number):number|null{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value))return null;const time=Date.parse(value);const normalized=value.length===20?value.slice(0,-1)+'.000Z':value;return Number.isFinite(time)&&new Date(time).toISOString()===normalized&&time<=now?Math.floor((now-time)/1000):null;}
/** Reporting only: catalog flags and recorded success clocks are not current
 * object readback, provider connectivity, readiness or delivery authority. */
export async function readOperationalHealth(db:SqlDatabase,owner:string,now=new Date().toISOString()):Promise<OperationalHealth>{
 if(!owner||owner.length>256)throw new Error('An authenticated owner is required.');
 const instant=Date.parse(now);if(!Number.isFinite(instant))throw new Error('Invalid health timestamp.');now=new Date(instant).toISOString();
 const exists=await db.prepare('SELECT 1 AS present FROM workspaces WHERE user_id=?').bind(owner).first();if(!exists)throw new Error('Health is unavailable.');
 const [usage,backups,jobs,rows]=await Promise.all([
  readWorkspaceUsage(db,owner,now),
  db.prepare("SELECT b.created_at,a.status AS archive_status,CASE WHEN b.sha256=a.source_sha256 AND b.content=a.metadata_content THEN 1 ELSE 0 END AS archive_identity_matches FROM workspace_backups b LEFT JOIN backup_archives a ON a.user_id=b.user_id AND a.id=b.id WHERE b.user_id=? AND b.status='ready' ORDER BY b.created_at DESC LIMIT 11").bind(owner).all<{created_at:string;archive_status:string|null;archive_identity_matches:number}>(),
  db.prepare("SELECT COUNT(*) AS due_count,MIN(CASE WHEN julianday(not_before)<=julianday(?) THEN not_before END) AS oldest_due,COALESCE(SUM(CASE WHEN julianday(not_before) IS NULL THEN 1 ELSE 0 END),0) AS unknown_count FROM workspace_job_intents WHERE user_id=? AND execution_epoch=COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0) AND cancel_requested=0 AND status IN ('pending','running') AND (julianday(not_before)<=julianday(?) OR julianday(not_before) IS NULL)").bind(now,owner,owner,now).first<{due_count:number;oldest_due:string|null;unknown_count:number}>(),
  db.prepare("SELECT t.id,t.payload_json,t.content_hash,c.id AS connection_id,c.payload_json AS connection_json,c.content_hash AS connection_hash,s.last_success_at,s.configuration_hash,s.execution_epoch,s.paused,s.failure,COALESCE(e.epoch,0) AS current_epoch FROM source_targets t LEFT JOIN source_connections c ON c.user_id=t.user_id AND c.id=t.connection_id LEFT JOIN source_sync_state s ON s.user_id=t.user_id AND s.source_id=t.id LEFT JOIN workspace_execution_state e ON e.user_id=t.user_id WHERE t.user_id=? ORDER BY t.id LIMIT 101").bind(owner).all<Record<string,unknown>>()
 ]);
 if(backups.results.length>10||rows.results.length>100||!jobs)throw new Error('Health aggregate exceeds its bound.');
 const conditions:Condition[]=[],latest=backups.results[0],backupAge=latest?age(latest.created_at,instant):null;
 const backup={lastRecordedCompleteAt:latest&&backupAge!==null?latest.created_at:null,ageSeconds:backupAge,coverage:(latest?latest.archive_status==='ready'&&latest.archive_identity_matches===1?'files-recorded':latest.archive_status===null?'metadata-only':'unknown':'unknown') as OperationalHealth['backup']['coverage'],freshReadbackPerformed:false as const};
 if(!latest)conditions.push('backup_missing');else if(backupAge===null)conditions.push('backup_clock_unknown');else if(backupAge>OPERATIONAL_HEALTH_POLICY.backupAgeSeconds)conditions.push('backup_old');
 const unknownClockCount=count(jobs.unknown_count),duePendingOrRunning=count(jobs.due_count)-unknownClockCount,oldestDueAgeSeconds=age(jobs.oldest_due,instant);
 if(unknownClockCount||duePendingOrRunning>0&&oldestDueAgeSeconds===null)conditions.push('job_clock_unknown');
 if(oldestDueAgeSeconds!==null&&oldestDueAgeSeconds>OPERATIONAL_HEALTH_POLICY.pendingDueAgeSeconds)conditions.push('jobs_overdue');
 const sources:OperationalHealth['sources']={selected:0,withinRecordedAge:0,stale:0,unknown:0,oldestRecordedSuccessAgeSeconds:null,freshnessProof:false};
 for(const row of rows.results){
  const target=sourceTargetSchema.safeParse(typeof row.payload_json==='string'?JSON.parse(row.payload_json):null),connection=sourceConnectionSchema.safeParse(typeof row.connection_json==='string'?JSON.parse(row.connection_json):null);
  if(!target.success||!connection.success||target.data.id!==row.id||connection.data.id!==row.connection_id||target.data.connectionId!==connection.data.id||await contentHash(canonical(target.data))!==row.content_hash||await contentHash(canonical(connection.data))!==row.connection_hash)throw new Error('Health source metadata differs.');
  if(target.data.archivedAt||connection.data.archivedAt||!connection.data.enabled)continue;
  sources.selected++;
  const seconds=age(row.last_success_at,instant),configurationHash=await contentHash(canonical({connection:connection.data,target:target.data}));
  if(seconds===null||row.configuration_hash!==configurationHash||row.execution_epoch!==row.current_epoch||row.paused!==0||row.failure!==null){sources.unknown++;continue;}
  sources.oldestRecordedSuccessAgeSeconds=Math.max(sources.oldestRecordedSuccessAgeSeconds??0,seconds);
  if(seconds>target.data.staleAfterSeconds)sources.stale++;else sources.withinRecordedAge++;
 }
 if(sources.stale)conditions.push('sources_stale');if(sources.unknown)conditions.push('source_age_unknown');
 const receiptCount=count(usage.receipts.count),backupCatalogCount=count(usage.backups.count),backupCatalogBytes=count(usage.backups.bytes);
 if(receiptCount>=usage.receipts.limits.hard*OPERATIONAL_HEALTH_POLICY.storageWarningRatio||backupCatalogCount>=usage.backups.limits.count*OPERATIONAL_HEALTH_POLICY.storageWarningRatio||backupCatalogBytes>=usage.backups.limits.bytes*OPERATIONAL_HEALTH_POLICY.storageWarningRatio)conditions.push('storage_near_limit');
 const portablePayloadBytes=[usage.planning.bytes,usage.audit.bytes,...usage.modules.map(module=>module.bytes)].reduce((sum,value)=>sum+count(value),0);count(portablePayloadBytes);
 return {generatedAt:now,readOnly:true,readinessGuarantee:false,externalDelivery:'disabled',storage:{byteAccounting:'portable logical payload metadata; excludes physical objects, private journals and database overhead',portablePayloadBytes,receiptCount,backupCatalogBytes,backupCatalogCount},backup,jobs:{duePendingOrRunning,oldestDueAgeSeconds,unknownClockCount,ageBasis:'not_before; not enqueue or execution duration'},sources,conditions,policy:OPERATIONAL_HEALTH_POLICY};
}
export async function handleOperationalHealth(request:Request,deps:{db:SqlDatabase|null;authenticateOwner:()=>Promise<string|null>;now?:()=>string}):Promise<Response>{
 const headers={'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff'};
 if(request.method!=='GET')return Response.json({error:'Read-only endpoint.'},{status:405,headers:{...headers,Allow:'GET'}});
 try{const owner=await deps.authenticateOwner();if(!owner)return Response.json({error:'Sign in again.'},{status:401,headers});if(new URL(request.url).search)return Response.json({error:'Unsupported health query.'},{status:400,headers});if(!deps.db)return Response.json({error:'Operational health is unavailable.'},{status:503,headers});return Response.json(await readOperationalHealth(deps.db,owner,deps.now?.()),{headers});}catch{return Response.json({error:'Operational health could not be loaded.'},{status:503,headers});}
}
