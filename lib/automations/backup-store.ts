import {requirePrivateCapacity,PrivateCapacityError,privateRowGrowth,type PrivateGrowth} from '../private-capacity.ts';
import {backupQuotaGuard,readBackupQuotaUsage} from '../backup-archive-quota.ts';
import {automationScheduleSchema} from './validation.ts';
import {prepareScheduledFileArchive,readPreparingArchiveMetadata,readReadyFileBackup,fileArchiveReadyStatements,type FileBackupServices,type PreparedFileBackup} from './backup-archive-store.ts';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {BACKUP_LIMITS,BackupCapacityError,prepareWorkspaceBackup,readWorkspaceBackup} from '../workspace-backups.ts';
import {measureProspectiveRecoverability} from '../recoverability-snapshot.ts';
import {recoverabilityAssertions,RecoverabilityCapacityError} from '../recoverability-admission.ts';
import {readOperationalWatermarks} from '../operational-watermarks.ts';
import {moduleProjection} from '../module-columns.ts';
import type {AuditEventDraft,JsonValue} from '../workspace-protocol.ts';
import {automationOccurrenceSchema} from './validation.ts';
import {claimScheduledBackupJob,scheduledBackupClaimGuard} from './backup-job-store.ts';
import type {AutomationServicePrincipal} from './runner.ts';
export interface ScheduledMetadataBackupResult {status:'completed'|'replayed'|'blocked'|'conflict'|'uncertain';reason?:string}
/** Explicit schedule mode selects metadata or a fully verified chunked file archive; no silent fallback. */
export async function runScheduledBackup(db:SqlDatabase,principal:AutomationServicePrincipal,intentId:string,options:{now:()=>string;files?:FileBackupServices;signal?:AbortSignal}):Promise<ScheduledMetadataBackupResult>{
 const owner=principal.ownerId;
 const job=await db.prepare("SELECT i.execution_epoch,j.subject_id,s.payload_json schedule_payload FROM workspace_job_intents i JOIN integration_jobs j ON j.user_id=i.user_id AND j.intent_id=i.id JOIN automation_schedules s ON s.user_id=j.user_id AND s.id=j.schedule_id WHERE i.user_id=? AND i.id=? AND i.kind='workspace_backup' AND j.job_subject_kind='backup'").bind(owner,intentId).first<{execution_epoch:number;subject_id:string;schedule_payload:string}>();
 if(!job)return {status:'blocked',reason:'unavailable'};
 let fileMode=false;try{const schedule=automationScheduleSchema.parse(JSON.parse(job.schedule_payload));fileMode=schedule.kind==='backup'&&schedule.backupMode==='files'&&schedule.fileBackupConsent===true;}catch{return {status:'blocked',reason:'configuration_unavailable'};}
 if(fileMode&&!options.files)return {status:'blocked',reason:'private_file_storage_unavailable'};
 const eventId=`backup_run_${await contentHash(canonical([owner,intentId,job.execution_epoch]))}`;
 async function replay():Promise<ScheduledMetadataBackupResult|null>{
  const row=await db.prepare("SELECT payload_json FROM audit_events WHERE user_id=? AND event_id=? AND kind='backup.generated'").bind(owner,eventId).first<{payload_json:string}>();if(!row)return null;
  const epoch=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(owner).first<{epoch:number}>();if((epoch?.epoch??0)!==job!.execution_epoch)return {status:'conflict'};
  const result=JSON.parse(row.payload_json).changes?.[0]?.after?.value;
  if(!result||result.backupId!==job!.subject_id||typeof result.sha256!=='string')return {status:'uncertain',reason:'receipt_unverified'};
  const backup=await readWorkspaceBackup(db,owner,result.backupId);if(!backup||backup.manifest.sha256!==result.sha256||backup.manifest.reason!=='scheduled')return {status:'uncertain',reason:'receipt_unverified'};
  if(fileMode){const full=await readReadyFileBackup(db,owner,result.backupId,options.files!,options.signal);if(!full)return {status:'uncertain',reason:'receipt_unverified'};await full.stream.cancel();if(result.archiveIndexHash!==full.indexHash)return {status:'uncertain',reason:'receipt_unverified'};}return {status:'replayed'};
 }
 try{const prior=await replay();if(prior)return prior;}catch{return {status:'uncertain',reason:'receipt_unverified'};}
 let plannedBytes=0;
 const claim=await claimScheduledBackupJob(db,principal,intentId,{now:options.now()});if(!claim)return {status:'blocked',reason:'authority_unavailable'};
 try{
  const now=options.now(),before=await readCurrent(db,owner,now),rawPlanning=await db.prepare('SELECT content FROM workspaces WHERE user_id=?').bind(owner).first<{content:string}>();
  const baseline=await measureProspectiveRecoverability(db,owner,{now});
  const sources=(await db.prepare('SELECT source_id,operational_revision FROM source_sync_state WHERE user_id=? ORDER BY source_id').bind(owner).all<{source_id:string;operational_revision:number}>()).results;
  const retained=fileMode?await readPreparingArchiveMetadata(db,claim):null;
  const prepared=retained??await prepareWorkspaceBackup(db,owner,before,'scheduled',now),manifest={...prepared.manifest,id:claim.backupId,storageKey:claim.backupId};
  let fileArchive:PreparedFileBackup|undefined;if(fileMode)fileArchive=await prepareScheduledFileArchive(db,claim,{manifest,content:prepared.content},baseline,options.files!,{now:options.now,signal:options.signal});
  plannedBytes=fileMode?0:manifest.bytes;
  const admission=await db.prepare('SELECT missed_periods FROM automation_occurrence_claims WHERE user_id=? AND intent_id=?').bind(owner,intentId).first<{missed_periods:number}>();if(!admission)return {status:'conflict'};
  const watermarks=await readOperationalWatermarks(db,owner),sequence=(watermarks.automations??0)+1;
  const occurrence=automationOccurrenceSchema.parse({id:`occurrence_${await contentHash(canonical([owner,claim.scheduleId,claim.occurrenceDueAt]))}`,scheduleId:claim.scheduleId,dueAt:claim.occurrenceDueAt,kind:'backup',configurationHash:claim.scheduleConfigurationHash,startedAt:claim.startedAt,finishedAt:now,outcome:'success',failure:null,missedPeriods:admission.missed_periods,resultRef:{kind:'backup',id:claim.backupId,hash:fileArchive?.indexHash??manifest.sha256}});
  const event:AuditEventDraft={id:eventId,kind:'backup.generated',entityType:'backup',entityId:claim.backupId,changes:[{path:['result'],before:{exists:false,value:null},after:{exists:true,value:{backupId:claim.backupId,sha256:manifest.sha256,...(fileArchive?{archiveIndexHash:fileArchive.indexHash,filesIncluded:true}:{})}}}],origin:'system',actorId:'backup-runner',occurredAt:now,sourceRef:manifest.sha256,undoOf:null};
  const recovery=await measureProspectiveRecoverability(db,owner,{now,operationalWrites:[{table:'automation_occurrences',value:occurrence as unknown as JsonValue,streamSequence:sequence}],operationalEvents:[{event,streamId:'automations',sequence}],operationalWatermarksAfter:{...watermarks,automations:sequence}});
  // Preparation must describe exactly the same boundary measured for the terminal write.
  const bundle=JSON.parse(prepared.content);if(canonical(baseline.boundaryRows)!==canonical(recovery.boundaryRows)||canonical(baseline.boundaryWatermarks)!==canonical(recovery.boundaryWatermarks)||bundle.source.workspaceRevision!==recovery.boundaryRevision||canonical(bundle.source.operationalWatermarks??{})!==canonical(recovery.boundaryWatermarks))return {status:'conflict'};
  if(!recovery.measurement.allowed)throw new RecoverabilityCapacityError();
  if(options.signal?.aborted)return {status:'conflict'};const authority=await scheduledBackupClaimGuard(db,claim,options.now());if(!authority)return {status:'conflict'};
  const privateGrowth=[privateRowGrowth('workspace_backups',null,{id:claim.backupId,source_revision:before.revision,created_at:now,reason:'scheduled',bytes:manifest.bytes,sha256:manifest.sha256,content:prepared.content,status:'ready',pinned:0}),await privateBackupUpdates(db,owner,'workspace_job_intents','id=?',[intentId],{status:'completed'})];
  const head=(await db.prepare('SELECT * FROM operational_stream_heads WHERE user_id=? AND stream_id=?').bind(owner,'automations').first<PrivatePhysicalRow>());privateGrowth.push(privateRowGrowth('operational_stream_heads',null,{...(head??{stream_id:'automations',revision:0,last_sequence:0}),revision:Number(head?.revision??0)+1,last_sequence:sequence}));if(head)privateGrowth.at(-1)!.rows=0;
  if(fileArchive)privateGrowth.push(await privateBackupUpdates(db,owner,'backup_archives','id=?',[claim.backupId],{status:'ready',updated_at:now}));
  privateGrowth.push(await privateBackupUpdates(db,owner,'integration_jobs','intent_id=?',[intentId],{lease_token:null,lease_expires_at:null,lease_access_mode:null,lease_principal_ref:null},true),await privateBackupUpdates(db,owner,'integration_job_attempts','intent_id=? AND attempt=?',[intentId,claim.attempt],{finished_at:now,outcome:'success',failure:null}),await privateBackupUpdates(db,owner,'automation_runtime','schedule_id=?',[claim.scheduleId],{last_success_at:now,failure:null,retry_at:null},true));
  const capacity=await requirePrivateCapacity(db,owner,{growth:privateGrowth});
  const token=crypto.randomUUID(),binds=[owner,eventId,token],gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)',statements:SqlStatement[]=[];
  statements.push(db.prepare(`WITH authority AS MATERIALIZED(SELECT 1 WHERE ${authority.sql}) INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 WHERE EXISTS(SELECT 1 FROM authority)`).bind(...authority.bindings,...binds));
  statements.push(...recoverabilityAssertions(db,owner,eventId,recovery,gate,binds));
  const assert=(sql:string,values:(string|number|null)[])=>statements.push(db.prepare(`INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${sql} THEN 1 ELSE 0 END WHERE ${gate}`).bind(owner,eventId,...values,...binds));
  assert(capacity.sql,capacity.bindings);
  assert('EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=? AND content=?)',[owner,before.revision,rawPlanning!.content]);
  const quota=backupQuotaGuard(owner,fileMode?0:manifest.bytes,fileMode?0:1);assert(quota.sql,quota.bindings);assert('NOT EXISTS(SELECT 1 FROM workspace_backups WHERE user_id=? AND id=?)',[owner,claim.backupId]);
  if(fileArchive)statements.push(...fileArchiveReadyStatements(db,owner,claim.backupId,fileArchive,now,gate,binds,eventId));
  assert('(SELECT COUNT(*) FROM source_sync_state WHERE user_id=?)=? AND NOT EXISTS(SELECT source_id,operational_revision FROM source_sync_state WHERE user_id=? EXCEPT SELECT json_extract(value,\'$.source_id\'),json_extract(value,\'$.operational_revision\') FROM json_each(?))',[owner,sources.length,owner,canonical(sources)]);
  const projection=await moduleProjection('automation_occurrences',occurrence.id,occurrence as unknown as JsonValue);projection.stream_sequence=sequence;const columns=Object.keys(projection);
  statements.push(db.prepare(`INSERT INTO workspace_backups(user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) SELECT ?,?,?,?,'scheduled',?,?,?,'ready',0 WHERE ${gate}`).bind(owner,claim.backupId,before.revision,now,manifest.bytes,manifest.sha256,prepared.content,...binds));
  statements.push(db.prepare(`INSERT INTO automation_occurrences(user_id,id,row_revision,payload_json,content_hash,${columns.join(',')}) SELECT ?,?,1,?,?,${columns.map(()=>'?').join(',')} WHERE ${gate}`).bind(owner,occurrence.id,canonical(occurrence),await contentHash(canonical(occurrence)),...Object.values(projection),...binds));
  statements.push(db.prepare(`INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json,origin,actor_id,source_ref,undo_of) SELECT ?,?,NULL,NULL,'automations',?,'backup.generated','backup',?,?,?,'system','backup-runner',?,NULL WHERE ${gate}`).bind(owner,eventId,sequence,claim.backupId,now,canonical(event),manifest.sha256,...binds));
  statements.push(db.prepare(`INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) SELECT ?,'automations',1,? WHERE ${gate} ON CONFLICT(user_id,stream_id) DO UPDATE SET revision=revision+1,last_sequence=excluded.last_sequence`).bind(owner,sequence,...binds));
  statements.push(db.prepare(`UPDATE workspace_job_intents SET status='completed' WHERE user_id=? AND id=? AND ${gate}`).bind(owner,intentId,...binds));
  statements.push(db.prepare(`UPDATE integration_jobs SET operational_revision=operational_revision+1,lease_token=NULL,lease_expires_at=NULL,lease_access_mode=NULL,lease_principal_ref=NULL WHERE user_id=? AND intent_id=? AND ${gate}`).bind(owner,intentId,...binds));
  statements.push(db.prepare(`UPDATE integration_job_attempts SET finished_at=?,outcome='success',failure=NULL WHERE user_id=? AND intent_id=? AND attempt=? AND ${gate}`).bind(now,owner,intentId,claim.attempt,...binds));
  statements.push(db.prepare(`UPDATE automation_runtime SET last_success_at=?,failure=NULL,retry_at=NULL,operational_revision=operational_revision+1 WHERE user_id=? AND schedule_id=? AND ${gate}`).bind(now,owner,claim.scheduleId,...binds));
  statements.push(db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(owner,eventId),db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...binds));
  const result=await db.batch(statements);const verified=await replay();return verified?.status==='replayed'?{status:result[0]?.meta.changes===1?'completed':'replayed'}:verified??{status:'conflict'};
 }catch(error){try{const prior=await replay();if(prior)return prior;}catch{return {status:'uncertain',reason:'receipt_unverified'};}
  const usage=await readBackupQuotaUsage(db,owner);
  if(error instanceof PrivateCapacityError||error instanceof BackupCapacityError||error instanceof RecoverabilityCapacityError||!fileMode&&usage&&(usage.count>=BACKUP_LIMITS.snapshots||usage.bytes+plannedBytes>BACKUP_LIMITS.ownerBytes)){try{const paused=await(await import('../background/capacity-pause.ts')).pauseJobForRecoveryCapacity(db,claim,options.now());return paused?{status:'blocked',reason:'storage_capacity'}:{status:'conflict'};}catch{return {status:'uncertain',reason:'pause_unconfirmed'};}}
  if(!await scheduledBackupClaimGuard(db,claim,options.now()))return {status:'conflict'};
  return {status:'uncertain',reason:'completion_unconfirmed'};
 }
}

/** Legacy metadata-only callers retain their existing behavior; file mode never falls back silently. */
export async function runScheduledMetadataBackup(db:SqlDatabase,principal:AutomationServicePrincipal,intentId:string,options:{now:()=>string}):Promise<ScheduledMetadataBackupResult>{return runScheduledBackup(db,principal,intentId,options);}

type PrivatePhysicalRow=Record<string,string|number|null>;
async function privateBackupUpdates(db:SqlDatabase,owner:string,table:PrivateGrowth['table'],where:string,bindings:(string|number|null)[],changes:PrivatePhysicalRow,incrementRevision=false):Promise<PrivateGrowth>{
 const rows=(await db.prepare('SELECT * FROM '+table+' WHERE user_id=? AND '+where+' LIMIT 6').bind(owner,...bindings).all<PrivatePhysicalRow>()).results;
 if(rows.length>5)throw new Error('Private backup growth selection exceeds its bound.');
 return rows.reduce<PrivateGrowth>((total,row)=>{const growth=privateRowGrowth(table,null,{...row,...changes,...(incrementRevision?{operational_revision:Number(row.operational_revision)+1}:{})});return {table,bytes:total.bytes+growth.bytes,rows:0};},{table,bytes:0,rows:0});
}
