import {z} from 'zod';
import {canonical,contentHash} from './canonical-json.ts';
import type {SqlDatabase,SqlStatement} from './workspace-store.ts';
import {readCurrent} from './workspace-store.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {readOperationalWatermarks} from './operational-watermarks.ts';
import {captureRecoveryPrivateContinuity,validateRecoveryPrivateContinuity,type RecoveryPrivateContinuity} from './recovery-private-continuity.ts';
const TABLES=["acceptance_owner_grants","acceptance_records","agent_artifacts","agent_budgets","agent_capabilities","agent_device_slots","agent_job_state","agent_jobs","agent_protocol_claims","agent_results","attachment_archive_cleanup_claims","attachment_archive_stages","attachment_blob_fences","attachment_blob_namespaces","attachment_blob_objects","attachment_upload_attempts","attachment_usage","attachments","audit_events","audit_import_identities","audit_project_links","automation_capabilities","automation_occurrence_claims","automation_occurrences","automation_runtime","automation_schedules","backup_archive_objects","backup_archives","decision_owner_grants","decision_records","decision_versions","decisions","device_credentials","device_enrollments","device_heartbeats","device_live_windows","device_rate_buckets","device_runtime","device_sessions","devices","evaluation_runs","evidence_links","evidence_mappings","evidence_records","evidence_requirements","evidence_versions","integration_history","integration_job_attempts","integration_jobs","integration_service_principals","job_approvals","job_attempts","job_events","notification_events","notification_read_state","operational_stream_heads","project_baseline_heads","project_baseline_revisions","recurrence_occurrences","recurrence_rules","review_ack_grants","review_acknowledgements","review_analysis_consents","review_analysis_requests","review_analysis_runs","review_settings","review_snapshots","runtime_adapter_configurations","runtime_evidence","runtime_latest","runtime_minute_aggregates","runtime_observations","source_access_grants","source_connections","source_observations","source_proposals","source_sync_runs","source_sync_state","source_targets","weekly_plans","weekly_reviews","workspace_assertions","workspace_backups","workspace_command_guards","workspace_configuration","workspace_drafts","workspace_execution_state","workspace_import_chunks","workspace_imports","workspace_job_intents","workspace_mutation_epochs","workspace_mutations","workspace_recovery","workspace_source_namespaces","workspaces"] as const;
export const RECOVERY_APPLICATION_TABLES:readonly string[]=Object.freeze(TABLES);
const CONTROL='operator_recovery_maintenance',PREFIX='operator_recovery_guard_',META=['_cf_KV','d1_migrations','__drizzle_migrations'];
const hash=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid(),stamp=z.string().datetime({offset:true}),integer=z.number().int().nonnegative().safe();
const context=z.object({workspaceRevision:integer.min(1),executionEpoch:integer,operationalWatermarks:z.record(integer).refine(value=>Object.keys(value).length<=32)}).strict();
const input=z.object({operationId:uuid,token:hash,ownerId:z.string().min(1).max(256),manifestSha256:hash,ownerContextHash:hash,schemaFingerprint:hash,sourceContext:context,now:stamp}).strict();
export type RecoveryFreezeInput=z.infer<typeof input>;
export interface RecoveryMaintenanceReceipt {operationId:string;token:string;role:'source'|'target';ownerId:string;manifestSha256:string;ownerContextHash:string;schemaFingerprint:string;sourceContext:z.infer<typeof context>;createdAt:string}
interface Control {operation_id:string;token_hash:string;role:string;state:string;owner_id:string;manifest_hash:string;owner_context_hash:string;schema_hash:string;source_context_json:string;private_hash:string|null;inventory_hash:string|null;created_at:string;write_revision:number}
type Master={type:string;name:string;tbl_name:string;sql:string|null};
const controlDDL='CREATE TABLE IF NOT EXISTS '+CONTROL+"(singleton INTEGER PRIMARY KEY CHECK(singleton=1),operation_id TEXT NOT NULL,token_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('source','target')),state TEXT NOT NULL CHECK(state IN('source-frozen','target-inactive','target-installing','target-ready','released')),owner_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,owner_context_hash TEXT NOT NULL,schema_hash TEXT NOT NULL,source_context_json TEXT NOT NULL,private_hash TEXT,inventory_hash TEXT,created_at TEXT NOT NULL,write_revision INTEGER NOT NULL DEFAULT 0 CHECK(write_revision>=0))";
function triggerName(index:number,operation:string){return PREFIX+String(index).padStart(3,'0')+'_'+operation.toLowerCase();}
function triggerSQL(table:string,index:number,operation:string){return 'CREATE TRIGGER "'+triggerName(index,operation)+'" BEFORE '+operation+' ON "'+table+'" WHEN EXISTS(SELECT 1 FROM '+CONTROL+" WHERE singleton=1 AND state IN('source-frozen','target-inactive','target-ready')) BEGIN SELECT RAISE(ABORT,'operator_recovery_frozen'); END";}
async function masters(db:SqlDatabase):Promise<Master[]>{return (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all<Master>()).results;}
function appMaster(rows:Master[]):Master[]{
 const tables=rows.filter(row=>row.type==='table').map(row=>row.name);
 const unknown=tables.filter(table=>!RECOVERY_APPLICATION_TABLES.includes(table)&&!META.includes(table)&&table!==CONTROL);
 if(unknown.length||RECOVERY_APPLICATION_TABLES.some(table=>!tables.includes(table)))throw new Error('Unsupported recovery application table inventory.');
 return rows.filter(row=>RECOVERY_APPLICATION_TABLES.includes(row.tbl_name)&&!row.name.startsWith(PREFIX));
}
export async function inspectRecoveryMaintenanceSchema(db:SqlDatabase):Promise<{schemaFingerprint:string;tables:number}>{
 const rows=appMaster(await masters(db));return {schemaFingerprint:await contentHash(canonical(rows)),tables:RECOVERY_APPLICATION_TABLES.length};
}
/** Operator DDL only; no production route invokes this. All application tables,
 * including global/private tables, are fenced, so REPLACE cannot evade owner predicates. */
export async function prepareRecoveryMaintenance(db:SqlDatabase,expectedSchemaFingerprint:string):Promise<void>{
 hash.parse(expectedSchemaFingerprint);if((await inspectRecoveryMaintenanceSchema(db)).schemaFingerprint!==expectedSchemaFingerprint)throw new Error('Expected recovery schema fingerprint differs.');
 await db.prepare(controlDDL).run();
 const expected=RECOVERY_APPLICATION_TABLES.flatMap((table,index)=>['INSERT','UPDATE','DELETE'].map(operation=>({name:triggerName(index,operation),sql:triggerSQL(table,index,operation)})));
 const existing=await masters(db);
 for(const item of expected){const old=existing.find(row=>row.name===item.name);if(old&&old.sql?.trim()!==item.sql)throw new Error('Recovery trigger was changed.');}
 // DDL is bounded into batches; source remains writable until the final freeze insertion.
 for(let i=0;i<expected.length;i+=32){const absent=expected.slice(i,i+32).filter(item=>!existing.some(row=>row.name===item.name));if(absent.length)await db.batch(absent.map(item=>db.prepare(item.sql)));}
 await verifyMaintenanceDDL(db,expectedSchemaFingerprint);
}
async function verifyMaintenanceDDL(db:SqlDatabase,schemaFingerprint:string){
 if((await inspectRecoveryMaintenanceSchema(db)).schemaFingerprint!==schemaFingerprint)throw new Error('Recovery schema changed.');
 const rows=await masters(db),triggers=rows.filter(row=>row.name.startsWith(PREFIX));
 if(triggers.length!==RECOVERY_APPLICATION_TABLES.length*3)throw new Error('Recovery trigger coverage differs.');
 for(const [index,table]of RECOVERY_APPLICATION_TABLES.entries())for(const operation of ['INSERT','UPDATE','DELETE'])if(triggers.find(row=>row.name===triggerName(index,operation))?.sql?.trim()!==triggerSQL(table,index,operation))throw new Error('Recovery trigger coverage differs.');
 const columns=(await db.prepare('PRAGMA table_info('+CONTROL+')').all<{name:string}>()).results.map(row=>row.name);
 if(canonical(columns)!==canonical(['singleton','operation_id','token_hash','role','state','owner_id','manifest_hash','owner_context_hash','schema_hash','source_context_json','private_hash','inventory_hash','created_at','write_revision']))throw new Error('Recovery control schema differs.');
}
async function currentContext(db:SqlDatabase,ownerId:string,now:string){
 const workspace=await readCurrent(db,ownerId,now),execution=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(ownerId).first<{epoch:number}>();
 return {workspaceRevision:workspace.revision,executionEpoch:execution?.epoch??0,operationalWatermarks:await readOperationalWatermarks(db,ownerId)};
}
function receipt(value:RecoveryFreezeInput,role:'source'|'target'):RecoveryMaintenanceReceipt{return {operationId:value.operationId,token:value.token,role,ownerId:value.ownerId,manifestSha256:value.manifestSha256,ownerContextHash:value.ownerContextHash,schemaFingerprint:value.schemaFingerprint,sourceContext:structuredClone(value.sourceContext),createdAt:value.now};}
async function authenticatedControl(db:SqlDatabase,value:RecoveryMaintenanceReceipt,states:string[]):Promise<Control>{
 uuid.parse(value.operationId);hash.parse(value.token);hash.parse(value.manifestSha256);hash.parse(value.schemaFingerprint);hash.parse(value.ownerContextHash);context.parse(value.sourceContext);stamp.parse(value.createdAt);
 await verifyMaintenanceDDL(db,value.schemaFingerprint);
 const row=await db.prepare('SELECT * FROM '+CONTROL+' WHERE singleton=1').first<Control>();
 if(!row||row.operation_id!==value.operationId||row.token_hash!==await contentHash(value.token)||row.role!==value.role||!states.includes(row.state)||row.owner_id!==value.ownerId||row.manifest_hash!==value.manifestSha256||row.owner_context_hash!==value.ownerContextHash||row.schema_hash!==value.schemaFingerprint||row.source_context_json!==canonical(value.sourceContext)||row.created_at!==value.createdAt)throw new Error('Actual operator maintenance authority is unavailable.');
 return row;
}
/** The caller must durably retain operationId/token before invocation; an exact retry
 * recovers the same DB freeze, while package JSON alone is never a receipt. */
export async function freezeRecoveryDatabase(db:SqlDatabase,raw:RecoveryFreezeInput):Promise<RecoveryMaintenanceReceipt>{
 const value=input.parse(structuredClone(raw));await prepareRecoveryMaintenance(db,value.schemaFingerprint);
 const existing=await db.prepare('SELECT * FROM '+CONTROL+' WHERE singleton=1').first<Control>();
 if(existing){await authenticatedControl(db,receipt(value,'source'),['source-frozen']);return receipt(value,'source');}
 if(canonical(await currentContext(db,value.ownerId,value.now))!==canonical(value.sourceContext))throw new Error('Source context differs before freeze.');
 const schemaRows=(await masters(db)).filter(row=>RECOVERY_APPLICATION_TABLES.includes(row.tbl_name)),vector=canonical(value.sourceContext.operationalWatermarks);
 // Guard each actual row and absence against concurrent DDL; expected SQL is one bounded parameter.
 const schema=canonical(schemaRows);if(new TextEncoder().encode(schema).length>1800000)throw new Error('Recovery schema guard is too large.');
 const insert=db.prepare("INSERT INTO "+CONTROL+"(singleton,operation_id,token_hash,role,state,owner_id,manifest_hash,owner_context_hash,schema_hash,source_context_json,created_at) SELECT 1,?,?,'source','source-frozen',?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM "+CONTROL+") AND EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?) AND COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM attachment_upload_attempts WHERE settled_at IS NULL) AND NOT EXISTS(SELECT 1 FROM backup_archive_objects WHERE pending_token IS NOT NULL AND settled_at IS NULL) AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE COALESCE((SELECT last_sequence FROM operational_stream_heads WHERE user_id=? AND stream_id=expected.key),0)<>expected.value) AND NOT EXISTS(SELECT 1 FROM operational_stream_heads actual WHERE actual.user_id=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE expected.key=actual.stream_id AND expected.value=actual.last_sequence)) AND (SELECT COUNT(*) FROM sqlite_master WHERE tbl_name IN(SELECT value FROM json_each(?)) AND name NOT LIKE 'sqlite_%')=? AND NOT EXISTS(SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN(SELECT value FROM json_each(?)) AND name NOT LIKE 'sqlite_%' EXCEPT SELECT json_extract(value,'$.type'),json_extract(value,'$.name'),json_extract(value,'$.tbl_name'),json_extract(value,'$.sql') FROM json_each(?))");
 const result=await insert.bind(value.operationId,await contentHash(value.token),value.ownerId,value.manifestSha256,value.ownerContextHash,value.schemaFingerprint,canonical(value.sourceContext),value.now,value.ownerId,value.sourceContext.workspaceRevision,value.ownerId,value.sourceContext.executionEpoch,vector,value.ownerId,value.ownerId,vector,canonical(RECOVERY_APPLICATION_TABLES),schemaRows.length,canonical(RECOVERY_APPLICATION_TABLES),schema).run();
 if(result.meta.changes!==1)throw new Error('Source changed or unsettled writes prevent freeze.');
 await authenticatedControl(db,receipt(value,'source'),['source-frozen']);
 return receipt(value,'source');
}
export async function verifyFrozenRecoveryDatabase(db:SqlDatabase,value:RecoveryMaintenanceReceipt):Promise<void>{
 if(value.role!=='source')throw new Error('Source freeze authority is required.');await authenticatedControl(db,value,['source-frozen']);
 if(canonical(await currentContext(db,value.ownerId,value.createdAt))!==canonical(value.sourceContext)||(await db.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts WHERE settled_at IS NULL').first<{n:number}>())!.n!==0||(await db.prepare('SELECT COUNT(*) n FROM backup_archive_objects WHERE pending_token IS NOT NULL AND settled_at IS NULL').first<{n:number}>())!.n!==0)throw new Error('Frozen source continuity differs.');
}
export async function bindFrozenPrivateContinuity(db:SqlDatabase,value:RecoveryMaintenanceReceipt,raw:RecoveryPrivateContinuity,expectedPrivateSha256:string):Promise<void>{
 await verifyFrozenRecoveryDatabase(db,value);
 const parsed=await validateRecoveryPrivateContinuity(raw,{sha256:expectedPrivateSha256,manifestSha256:value.manifestSha256,ownerContextHash:value.ownerContextHash,sourceContext:value.sourceContext,ownerId:value.ownerId});
 if(Date.parse(parsed.capturedAt)<Date.parse(value.createdAt))throw new Error('Private continuity predates the actual source freeze.');
 const actual=await captureRecoveryPrivateContinuity(db,value.ownerId,{manifestSha256:value.manifestSha256,ownerContextHash:value.ownerContextHash,sourceContext:value.sourceContext},parsed.capturedAt);
 if(actual.sha256!==expectedPrivateSha256)throw new Error('Private continuity does not match actual frozen source rows.');
 const row=await authenticatedControl(db,value,['source-frozen']);if(row.private_hash!==null&&row.private_hash!==expectedPrivateSha256)throw new Error('Frozen private root is immutable.');
 await db.prepare('UPDATE '+CONTROL+' SET private_hash=? WHERE singleton=1 AND operation_id=? AND token_hash=? AND state=?').bind(expectedPrivateSha256,value.operationId,await contentHash(value.token),'source-frozen').run();
}
/** Exact-key exclusion is permanent. A possibly late DELETE can affect only these
 * excluded old keys; target files must always use newly generated namespaces. */
export async function assertRecoveryBlobCopyEligible(db:SqlDatabase,value:RecoveryMaintenanceReceipt,key:string):Promise<void>{
 await verifyFrozenRecoveryDatabase(db,value);if(typeof key!=='string'||key.length>500)throw new Error('Invalid private copy key.');
 if(await db.prepare('SELECT 1 FROM attachment_blob_fences WHERE storage_key=? UNION ALL SELECT 1 FROM attachment_archive_cleanup_claims WHERE storage_key=? LIMIT 1').bind(key,key).first())throw new Error('Permanently fenced or cleanup-claimed keys cannot be copied.');
 const metadata=await db.prepare("SELECT id,payload_json,content_hash FROM attachments WHERE user_id=? AND json_extract(payload_json,'$.storageKey')=?").bind(value.ownerId,key).first<{id:string;payload_json:string;content_hash:string}>();if(!metadata)throw new Error('A current ready attachment is required.');
 const record=attachmentRecordSchema.parse(JSON.parse(metadata.payload_json));if(record.id!==metadata.id||record.storageKey!==key||record.status!=='ready'||await contentHash(canonical(record))!==metadata.content_hash)throw new Error('Current ready attachment identity differs.');
 const object=await db.prepare('SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND storage_key=? AND attachment_id=? AND bytes=? AND sha256=? AND purged_at IS NULL AND verified_at IS NOT NULL').bind(value.ownerId,key,record.id,record.expectedBytes,record.sha256).first();if(!object)throw new Error('Unverified physical objects cannot be copied.');
}
export async function prepareInactiveRecoveryTarget(target:SqlDatabase,source:SqlDatabase,sourceReceipt:RecoveryMaintenanceReceipt,options:{operationId:string;token:string;expectedPrivateSha256:string}):Promise<RecoveryMaintenanceReceipt>{
 await verifyFrozenRecoveryDatabase(source,sourceReceipt);const sourceRow=await authenticatedControl(source,sourceReceipt,['source-frozen']);
 if(sourceRow.private_hash!==hash.parse(options.expectedPrivateSha256))throw new Error('Actual frozen private root is required.');
 for(const table of RECOVERY_APPLICATION_TABLES)if(await source.prepare('SELECT 1 FROM "'+table+'" WHERE user_id<>? LIMIT 1').bind(sourceReceipt.ownerId).first())throw new Error('Multiple-owner replacement requires complete trusted owner manifests.');
 await prepareRecoveryMaintenance(target,sourceReceipt.schemaFingerprint);
 if(await target.prepare('SELECT 1 FROM '+CONTROL).first())throw new Error('Target has previous maintenance state; use a new empty inactive target.');
 for(const table of RECOVERY_APPLICATION_TABLES)if((await target.prepare('SELECT COUNT(*) n FROM "'+table+'"').first<{n:number}>())!.n!==0)throw new Error('Recovery target must be completely empty.');
 const value=input.parse({operationId:options.operationId,token:options.token,ownerId:sourceReceipt.ownerId,manifestSha256:sourceReceipt.manifestSha256,ownerContextHash:sourceReceipt.ownerContextHash,schemaFingerprint:sourceReceipt.schemaFingerprint,sourceContext:sourceReceipt.sourceContext,now:sourceReceipt.createdAt});const result=receipt(value,'target');
 const empty=RECOVERY_APPLICATION_TABLES.map(table=>'NOT EXISTS(SELECT 1 FROM "'+table+'")').map(sql=>'('+sql+')');
 // Balanced EXISTS composition avoids D1's expression depth100 ceiling.
 const balanced=(parts:string[]):string=>parts.length===1?parts[0]:'('+balanced(parts.slice(0,Math.floor(parts.length/2)))+' AND '+balanced(parts.slice(Math.floor(parts.length/2)))+')';
 await target.prepare('INSERT INTO '+CONTROL+"(singleton,operation_id,token_hash,role,state,owner_id,manifest_hash,owner_context_hash,schema_hash,source_context_json,private_hash,created_at) SELECT 1,?,?,'target','target-inactive',?,?,?,?,?,?,? WHERE "+balanced(empty)).bind(result.operationId,await contentHash(result.token),result.ownerId,result.manifestSha256,result.ownerContextHash,result.schemaFingerprint,canonical(result.sourceContext),sourceRow.private_hash,result.createdAt).run();
 await authenticatedControl(target,result,['target-inactive']);return result;
}
/** Only trusted local installer code constructs these prepared statements. Never
 * pass request SQL. The target is blocked again before any other transaction can run. */
export async function writeInactiveRecoveryTarget(target:SqlDatabase,value:RecoveryMaintenanceReceipt,statements:SqlStatement[]):ReturnType<SqlDatabase['batch']>{
 if(value.role!=='target'||!statements.length||statements.length>80)throw new Error('A bounded target installer batch is required.');
 await authenticatedControl(target,value,['target-inactive']);
 const result=await target.batch([
  target.prepare('UPDATE '+CONTROL+" SET state='target-installing',write_revision=write_revision+1 WHERE singleton=1 AND role='target' AND state='target-inactive' AND operation_id=? AND token_hash=?").bind(value.operationId,await contentHash(value.token)),
  ...statements,
  target.prepare('UPDATE '+CONTROL+" SET state='target-inactive' WHERE singleton=1 AND state='target-installing' AND operation_id=? AND token_hash=?").bind(value.operationId,await contentHash(value.token))
 ]);
 if(result[0].meta.changes!==1||result.at(-1)?.meta.changes!==1)throw new Error('Target installer authority changed.');
 await authenticatedControl(target,value,['target-inactive']);return result.slice(1,-1);
}
/** Hashes every closed application row while the actual target fence is held.
 * This is an inventory digest, not a substitute for domain/reference/blob validation. */
export async function recoveryTargetInventorySha256(db:SqlDatabase,value:RecoveryMaintenanceReceipt):Promise<string>{
 await authenticatedControl(db,value,['target-inactive','target-ready']);
 const results=[];let rows=0,bytes=0;
 for(const table of RECOVERY_APPLICATION_TABLES){
  const columns=(await db.prepare('PRAGMA table_info("'+table+'")').all<{name:string;pk:number}>()).results,primary=columns.filter(column=>column.pk>0).sort((a,b)=>a.pk-b.pk).map(column=>column.name);
  if(columns.some(column=>!/^[a-z_]+$/.test(column.name)))throw new Error('Unsupported recovery column identity.');
  let after:Record<string,string|number|null>|null=null,count=0,chain=await contentHash('private-recovery-inventory-v1:'+table);
  if(!primary.length){if((await db.prepare('SELECT COUNT(*) n FROM "'+table+'"').first<{n:number}>())!.n!==0)throw new Error('Transient unkeyed recovery state must be empty.');}
  else for(;;){
   const where=after?' WHERE ('+primary.join(',')+')>('+primary.map(()=>'?').join(',')+')':'',bindings=after?primary.map(key=>after![key]):[];
   const page=(await db.prepare('SELECT '+columns.map(column=>column.name).join(',')+' FROM "'+table+'"'+where+' ORDER BY '+primary.join(',')+' LIMIT 8').bind(...bindings).all<Record<string,string|number|null>>()).results;
   for(const row of page){for(const item of Object.values(row))if(item!==null&&typeof item!=='string'&&(typeof item!=='number'||!Number.isSafeInteger(item)))throw new Error('Unsupported recovery scalar.');if(primary.some(key=>row[key]===null))throw new Error('Nullable recovery primary identity.');count++;rows++;bytes+=new TextEncoder().encode(canonical(row)).length;if(rows>200000||bytes>128*1024*1024)throw new Error('Target inventory exceeds supported profile.');after=row;}
   if(page.length)chain=await contentHash(chain+canonical(page));if(page.length<8)break;
  }
  results.push({table,rows:count,sha256:chain});
 }
 return contentHash(canonical({version:1,schemaFingerprint:value.schemaFingerprint,tables:results}));
}
export async function markRecoveryTargetReady(target:SqlDatabase,source:SqlDatabase,sourceReceipt:RecoveryMaintenanceReceipt,value:RecoveryMaintenanceReceipt,expected:{privateSha256:string;inventorySha256:string;actualInventorySha256:()=>Promise<string>}):Promise<void>{
 await verifyFrozenRecoveryDatabase(source,sourceReceipt);
 const sourceRow=await authenticatedControl(source,sourceReceipt,['source-frozen']),targetRow=await authenticatedControl(target,value,['target-inactive']);
 if(sourceRow.private_hash!==hash.parse(expected.privateSha256)||targetRow.private_hash!==expected.privateSha256||value.manifestSha256!==sourceReceipt.manifestSha256||value.ownerContextHash!==sourceReceipt.ownerContextHash||value.schemaFingerprint!==sourceReceipt.schemaFingerprint||value.sourceContext.executionEpoch>=Number.MAX_SAFE_INTEGER)throw new Error('Recovery handoff roots differ.');
 for(const table of RECOVERY_APPLICATION_TABLES)if(await target.prepare('SELECT 1 FROM "'+table+'" WHERE user_id<>? LIMIT 1').bind(value.ownerId).first())throw new Error('Target contains an unreviewed foreign owner.');
 // Caller is the trusted domain/refs/blob verifier, not JSON declaring itself valid.
 if(await expected.actualInventorySha256()!==hash.parse(expected.inventorySha256))throw new Error('Verified target inventory differs.');
 const forbidden=['device_credentials','device_enrollments','agent_capabilities','source_access_grants','integration_service_principals','automation_capabilities','decision_owner_grants','acceptance_owner_grants','review_ack_grants','review_analysis_consents'];
 for(const table of forbidden)if((await target.prepare('SELECT COUNT(*) n FROM '+table).first<{n:number}>())!.n!==0)throw new Error('Target cannot regain credential, grant or dispatch authority.');
 if(await target.prepare('SELECT 1 FROM job_approvals WHERE revoked_at IS NULL LIMIT 1').first())throw new Error('Approval history must be irrevocably revoked.');
 if(await target.prepare("SELECT 1 FROM workspace_job_intents j WHERE status IN('pending','awaiting_approval') OR (status='running' AND (cancel_requested<>1 OR kind<>'agent.execute' OR NOT EXISTS(SELECT 1 FROM agent_job_state s WHERE s.user_id=j.user_id AND s.intent_id=j.id AND s.status='reconcile_required' AND s.attempt_id IS NOT NULL))) LIMIT 1").first())throw new Error('Target pending work must be cancelled; uncertainty must remain fenced.');
 for(const [table,where]of [['agent_budgets','enabled<>0'],['automation_runtime','paused<>1'],['source_sync_state','paused<>1']] as const)if(await target.prepare('SELECT 1 FROM '+table+' WHERE '+where+' LIMIT 1').first())throw new Error('Target private execution must remain paused.');
 const epoch=await target.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(value.ownerId).first<{epoch:number}>();if(epoch?.epoch!==value.sourceContext.executionEpoch+1)throw new Error('Target must fence the old execution epoch.');
 if((await target.prepare('PRAGMA foreign_key_check').all()).results.length)throw new Error('Target foreign references differ.');
 const sealed=await target.prepare('UPDATE '+CONTROL+" SET state='target-ready',inventory_hash=? WHERE singleton=1 AND state='target-inactive' AND operation_id=? AND token_hash=? AND write_revision=?").bind(expected.inventorySha256,value.operationId,await contentHash(value.token),targetRow.write_revision).run();if(sealed.meta.changes!==1)throw new Error('Target changed during verification.');
 await authenticatedControl(target,value,['target-ready']);await verifyFrozenRecoveryDatabase(source,sourceReceipt);
}
/** Explicit operator rollback only; no automatic source release or target activation. */
export async function releaseRecoverySource(db:SqlDatabase,value:RecoveryMaintenanceReceipt,review:{operationId:string;reason:string}):Promise<void>{
 if(value.role!=='source'||review.operationId!==value.operationId||typeof review.reason!=='string'||review.reason.trim().length<10)throw new Error('Explicit reviewed source rollback is required.');
 await authenticatedControl(db,value,['source-frozen']);await db.prepare('UPDATE '+CONTROL+" SET state='released' WHERE singleton=1 AND operation_id=? AND token_hash=? AND role='source' AND state='source-frozen'").bind(value.operationId,await contentHash(value.token)).run();
}
