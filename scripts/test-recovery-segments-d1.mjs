// Synthetic offline replacement rehearsal. Never connects to hosted D1/R2 or changes a Sites binding.
// The destination is a new isolated database, blocked by DB-wide maintenance triggers even after readiness.
// Both database generations share one isolated R2 bucket to exercise late old-key DELETE safety.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {encodeRecoverySegments,decodeRecoverySegments,validateRecoveryManifest} from '../lib/recovery-segments.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {ownerAttachmentServices} from '../lib/attachment-services.ts';
import {ownerReader,OWNER_TABLES} from '../lib/workspace-modules.ts';
import {exportRegistry,moduleTables,exportWorkspaceBundle,serializePortableAuditRow,BUNDLE_LIMITS} from '../lib/workspace-export.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {parsePlanningImport,encodePlanning} from '../lib/workspace-codec.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import {parseAuditEvent} from '../lib/audit-events.ts';
import {readHistoryPage,verifyHistoryCursor} from '../lib/history.ts';
import {criteriaHash,evidenceRequirementSchema} from '../lib/evidence-requirements.ts';
import {attachmentRecordSchema} from '../lib/evidence-module.ts';
import {deriveAttachmentManifest,validateAttachmentManifest} from '../lib/attachment-manifest.ts';
import {getWorkspaceNamespaces,getOrCreateWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {createR2BlobStore,stageAttachmentUpload,readReadyAttachment,attachmentStorageKey} from '../lib/attachments.ts';
import {beginUpload,finishUpload} from '../lib/attachment-upload-fences.ts';
import {runInteractiveReview} from '../lib/reviews/http.ts';
import {agentCapabilitySchema} from '../lib/agents/contracts.ts';
import {buildAgentJobSpec,agentJobSpecSha256,buildAgentExecutionBinding,agentExecutionBindingSha256,buildAgentApprovalEnvelope} from '../lib/agents/policy.ts';
import {writeAttachmentArchive,attachmentArchivePath} from '../lib/attachment-archive-export.ts';
import {createBackupArchiveStorage,backupArchiveKey} from '../lib/backup-archive-storage.ts';
import {copyRecoveryBackupArchives} from '../lib/recovery-backups.ts';
import {readReadyFileBackup} from '../lib/automations/backup-archive-store.ts';
import {inactiveRecoveryDatabase,installRecoveryPrivateContinuity,installRecoveryIntentRoots} from '../lib/recovery-install.ts';
import {captureRecoveryPrivateContinuity} from '../lib/recovery-private-continuity.ts';
import {inspectRecoveryMaintenanceSchema,freezeRecoveryDatabase,bindFrozenPrivateContinuity,assertRecoveryBlobCopyEligible,prepareInactiveRecoveryTarget,recoveryTargetInventorySha256,markRecoveryTargetReady} from '../lib/recovery-maintenance.ts';
import {previewEntityDeletion} from '../lib/workspace-deletion.ts';
import {readReferenceSnapshot,referenceRegistry} from '../lib/workspace-references.ts';
import {BASELINE_ID,baselineRecordId} from '../lib/project-baselines.ts';

assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 is required.');
const NOW='2026-10-18T12:00:00.000Z',OWNER='synthetic-segmented-replacement-owner';
const bufferCompare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const stream=bytes=>new ReadableStream({start(controller){controller.enqueue(bytes.slice());controller.close();}});
const hash=value=>contentHash(canonical(value));
const batch=async(db,statements,size=32)=>{for(let i=0;i<statements.length;i+=size)await db.batch(statements.slice(i,i+size));};
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated recovery fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['SOURCE','TARGET','FAILED','STAGE'],d1Persist:false,r2Buckets:['SOURCE_BUCKET','TARGET_BUCKET'],r2Persist:false,cf:false});
try{
 const source=await mf.getD1Database('SOURCE'),target=await mf.getD1Database('TARGET'),failed=await mf.getD1Database('FAILED'),stage=await mf.getD1Database('STAGE');
 const sourceStore=createR2BlobStore(await mf.getR2Bucket('SOURCE_BUCKET')),targetStore=createR2BlobStore(await mf.getR2Bucket('SOURCE_BUCKET'));
 const migrationNames=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
 for(const db of [source,target,failed])for(const name of migrationNames){
  const sql=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');
  for(const statement of sql.split('--> statement-breakpoint'))if(statement.trim())await db.prepare(statement.trim()).run();
 }
 await stage.prepare('CREATE TABLE segments(module TEXT NOT NULL,idx INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(module,idx))').run();
 await stage.prepare('CREATE TABLE installs(id TEXT PRIMARY KEY,manifest_hash TEXT NOT NULL,status TEXT NOT NULL,checkpoint_json TEXT,handoff_hash TEXT)').run();
 await stage.prepare('CREATE TABLE staged_rows(install_id TEXT NOT NULL,module TEXT NOT NULL,id TEXT NOT NULL,row_json TEXT NOT NULL,PRIMARY KEY(install_id,module,id))').run();
 await stage.prepare('CREATE TABLE assertions(ok INTEGER CHECK(ok=1))').run();
 async function assertEmpty(db){
  // All actual application tables must be empty, including unregistered private authority tables.
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('d1_migrations','__drizzle_migrations','operator_recovery_maintenance')").all()).results;
  for(const {name}of tables){assert.match(name,/^[a-zA-Z_][a-zA-Z0-9_]*$/);assert.equal((await db.prepare('SELECT COUNT(*) n FROM "'+name+'"').first()).n,0,'Replacement must be empty: '+name);}
 }
 await assertEmpty(target);await assertEmpty(failed);assert.equal((await target.prepare('PRAGMA foreign_keys').first()).foreign_keys,1);
 await loadWorkspace(source,OWNER,()=>createSeedWorkspace(NOW),NOW);
 async function send(command){
  const result=await executeWorkspaceCommand(OWNER,{protocolVersion:1,expectedRevision:(await readCurrent(source,OWNER,NOW)).revision,mutationId:crypto.randomUUID(),command},{db:source,handlers:workspaceHandlers,now:()=>NOW,...await ownerAttachmentServices(source,OWNER,NOW,await mf.getR2Bucket('SOURCE_BUCKET'))});
  assert.equal(result.status,'committed');return result;
 }
 const project=(await readCurrent(source,OWNER,NOW)).workspace.projects[0];assert.ok(project);
 await send({type:'baseline.apply',projectId:project.id,baselineId:BASELINE_ID});
 const baselineContextId=baselineRecordId(project.id,'context');
 assert.ok((await readCurrent(source,OWNER,NOW)).workspace.captures.some(capture=>capture.id===baselineContextId));
 // Baseline context is referenced by normalized evidence; the real guard must
 // keep refusing its removal. Exercise native deletion with an independent
 // owner-created archived task that has no references.
 const taskTemplate=(await readCurrent(source,OWNER,NOW)).workspace.tasks.find(task=>task.projectId===project.id);
 assert.ok(taskTemplate);
 const taskInput=Object.fromEntries(Object.entries(taskTemplate).filter(([key])=>!['id','createdAt','updatedAt','completedAt','weeklyWeek','archivedFromStatus'].includes(key)));
 await send({type:'task.create',task:{...taskInput,title:'Synthetic unreferenced archived recovery fixture',milestoneId:null,status:'archived',weekly:false,dependsOn:[]}});
 const deletionBase=await readCurrent(source,OWNER,NOW),removedOwnerTask=deletionBase.workspace.tasks.find(task=>task.title==='Synthetic unreferenced archived recovery fixture');assert.ok(removedOwnerTask);
 const removedOwnerTaskId=removedOwnerTask.id,deletionReferences=await readReferenceSnapshot(ownerReader(source,OWNER),referenceRegistry);
 const deletion=await previewEntityDeletion(deletionBase.workspace,'task',removedOwnerTaskId,deletionBase.revision,deletionReferences);
 assert.equal(deletion.canDelete,true,canonical(deletion.blockers));
 await send({type:'entity.delete',entityType:'task',id:removedOwnerTaskId,previewHash:deletion.previewHash,targetRevision:deletionBase.revision});
 await send({type:'decisions.create',value:{title:'Synthetic replacement decision',question:'Retain the exact draft?',options:[{id:'retain',label:'Retain',description:''}],selectedOptionId:null,rationale:'',reviewOn:null,subjects:[{type:'project',id:project.id}],evidenceRefs:[],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null}});
 const nativeDecision=(await ownerReader(source,OWNER).list('decision_records'))[0];
 await send({type:'decisions.decide',id:nativeDecision.id,expectedVersion:1,choice:{selectedOptionId:'retain',rationale:'Explicit synthetic owner choice, with no execution or trading effect.'}});
 const fileBytes=new TextEncoder().encode('Synthetic segmented recovery R2 bytes; no private owner data.\n');
 await send({type:'attachment.reserve',value:{filename:'replacement-fixture.txt',mimeType:'text/plain',expectedBytes:fileBytes.length}});
 const reservedRow=(await ownerReader(source,OWNER).list('attachments'))[0],reserved=attachmentRecordSchema.parse(JSON.parse(reservedRow.payload_json));
 const sourceNamespaces=await getWorkspaceNamespaces(source,OWNER);assert.ok(sourceNamespaces);
 const upload=await beginUpload(source,OWNER,{record:reserved,rowRevision:reservedRow.row_revision,now:NOW,ownerNamespace:sourceNamespaces.blobNamespace});assert.ok(upload);
 assert.equal((await stageAttachmentUpload(OWNER,reserved,stream(fileBytes),sourceStore,{ownerNamespace:sourceNamespaces.blobNamespace,now:NOW})).status,'staged');
 assert.equal(await finishUpload(source,OWNER,{token:upload,now:NOW,definitivelySettled:true}),true);
 await send({type:'attachment.finalize',id:reserved.id});
 const ready=attachmentRecordSchema.parse(JSON.parse((await ownerReader(source,OWNER).get('attachments',reserved.id)).payload_json));
 await send({type:'evidence.create',value:{basis:'documented-result',scope:'implementation',title:'Exact recovery attachment',statement:'Synthetic bytes retained, not proof of a physical device.',observedAt:NOW,candidate:null,environment:'isolated Miniflare',sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[ready.id]}});

 const acceptanceSubject={type:'project',id:project.id},requirements=(await ownerReader(source,OWNER).list('evidence_requirements')).map(row=>evidenceRequirementSchema.parse(JSON.parse(row.payload_json)));
 await send({type:'acceptance.record',value:{subject:acceptanceSubject,decision:'accepted',statement:'Owner acceptance of synthetic software context only; no physical execution claim.',candidate:null,criteriaHash:await criteriaHash(acceptanceSubject,requirements),evidenceRefs:[],supersedesId:null,exceptions:[]}});
 const ownerAssessment=(await ownerReader(source,OWNER).list('acceptance_records'))[0],importedAssessmentId=crypto.randomUUID(),importedAssessment={...JSON.parse(ownerAssessment.payload_json),id:importedAssessmentId,statement:'Historical imported assessment fixture; no native owner attribution.'};
 const assessmentProjection=await moduleProjection('acceptance_records',importedAssessmentId,importedAssessment),assessmentNames=moduleColumnNames('acceptance_records');
 await source.prepare('INSERT INTO acceptance_records(user_id,id,row_revision,payload_json,content_hash,'+assessmentNames.join(',')+') VALUES('+['user_id','id','row_revision','payload_json','content_hash',...assessmentNames].map(()=>'?').join(',')+')').bind(OWNER,importedAssessmentId,1,canonical(importedAssessment),await hash(importedAssessment),...assessmentNames.map(name=>assessmentProjection[name])).run();
 await send({type:'reviews.request',projectIds:[project.id],filterDigest:await hash({projectId:project.id})});
 const reviewIntent=(await source.prepare("SELECT id FROM workspace_job_intents WHERE user_id=? AND kind='review_generate' AND status='pending'").bind(OWNER).first()).id;
 assert.equal((await runInteractiveReview(source,OWNER,reviewIntent,()=>NOW)).status,'committed');
 assert.ok((await readOperationalWatermarks(source,OWNER)).reviews>0);
 const nativeReview=(await ownerReader(source,OWNER).list('review_snapshots'))[0];
 await send({type:'reviews.acknowledge',snapshotId:nativeReview.id,snapshotHash:nativeReview.content_hash});
 const nativeNotification=(await ownerReader(source,OWNER).list('notification_events'))[0];assert.ok(nativeNotification);
 await send({type:'notifications.read',id:nativeNotification.id,contentHash:nativeNotification.content_hash,read:true});
 await source.prepare('INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,1,?,?)').bind(OWNER,'synthetic-unsaved-owner-draft',JSON.stringify({text:'Unsubmitted owner wording retained exactly; never execute as instructions.'}),'2026-10-19T12:00:00.000Z').run();
 {
 const SHA='a'.repeat(64);
  const sourcePlanning=await readCurrent(source,OWNER,NOW),workspace=sourcePlanning.workspace,task=workspace.tasks.find(row=>row.status!=='archived'&&workspace.projects.some(project=>project.id===row.projectId&&project.archivedAt===null)&&(!row.milestoneId||workspace.milestones.some(milestone=>milestone.id===row.milestoneId&&milestone.archivedAt===null)));assert.ok(task);const deviceId='synthetic-private-device',jobId='synthetic-private-job',attemptId='synthetic-private-attempt',budgetId='synthetic-private-budget',intentId='synthetic-private-intent';
  const cap=agentCapabilitySchema.parse({schemaVersion:1,deviceId,configurationSha256:SHA,provider:'codex',runtime:{version:'synthetic-1',sourceCommit:'b'.repeat(40),packageSha256:SHA,toolPolicy:'synthetic-policy',executableSha256:SHA,executableVersion:'synthetic 1',toolPolicySha256:SHA},operations:['project.inspect'],models:[{id:'synthetic-model',efforts:['medium']}],repositoryKeys:['synthetic-repo'],observedAt:NOW,expiresAt:'2026-10-18T12:05:00.000Z',maxConcurrent:1,availableSlots:1,maxTimeoutSeconds:600,maxOutputBytesLimit:2048,allowedPathsSha256ByRepositoryKey:{'synthetic-repo':SHA},modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true});
  const spec=await buildAgentJobSpec({operation:'project.inspect',projectId:task.projectId,taskId:task.id,repositoryKey:'synthetic-repo',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'synthetic-model',effort:'medium',timeoutSeconds:120,outputBytesLimit:2048,dependsOnJobIds:[]},{workspace,workspaceRevision:sourcePlanning.revision,acceptanceInputs:{}});
  const specHash=await agentJobSpecSha256(spec),binding=await buildAgentExecutionBinding(spec,cap,{artifactRefs:[],budget:{jobs:1,timeoutSeconds:120,outputBytesLimit:2048,inputBytesLimit:32768,payment:'subscription-only',costDollars:null},now:NOW}),bindingHash=await agentExecutionBindingSha256(binding);
  const record={id:jobId,intentId,spec,specSha256:specHash,createdAt:NOW,retryOfJobId:null,historical:false},envelope=await buildAgentApprovalEnvelope(spec,{approval:{id:'synthetic-private-approval',jobId,deviceId,specSha256:specHash,capabilitySha256:await contentHash(canonical(cap)),configurationSha256:SHA,taskSnapshotSha256:spec.taskSnapshotSha256,approvedAt:NOW,expiresAt:'2026-10-19T12:00:00.000Z',revokedAt:null,attempts:1,budget:{jobs:1,timeoutSeconds:120},origin:'native-owner'},executionBinding:binding,reservationId:budgetId,approverId:OWNER},NOW);
  await source.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'agent.execute',?,?,?,'running',0,0)").bind(OWNER,intentId,jobId,canonical({jobId,specSha256:specHash}),NOW).run();
  await source.prepare('INSERT INTO agent_job_state(user_id,job_id,intent_id,status,operational_revision,spec_hash,task_hash,device_id,approval_id,attempt_id,execution_epoch,updated_at) VALUES(?,?,?,?,2,?,?,?,?,?,0,?)').bind(OWNER,jobId,intentId,'running',specHash,spec.taskSnapshotSha256,deviceId,envelope.approval.id,attemptId,NOW).run();
  await source.prepare('INSERT INTO job_approvals(user_id,id,job_id,device_id,spec_hash,binding_hash,payload_json,created_at,expires_at,consumed_at,reserved_seconds) VALUES(?,?,?,?,?,?,?,?,?,?,120)').bind(OWNER,envelope.approval.id,jobId,deviceId,specHash,bindingHash,canonical(envelope),NOW,envelope.approval.expiresAt,NOW).run();
  const identity=canonical({record,executionBinding:binding,budgetId});
  await source.prepare('INSERT INTO job_attempts(user_id,id,job_id,device_id,approval_id,execution_epoch,journal_nonce_hash,lease_token_hash,lease_expires_at,deadline_at,created_at,launched_at,last_applied_sequence,operational_revision,identity_json) VALUES(?,?,?,?,?,0,?,?,?,?,?,?,1,2,?)').bind(OWNER,attemptId,jobId,deviceId,envelope.approval.id,SHA,SHA,'2026-10-18T12:01:00.000Z','2026-10-18T12:02:00.000Z',NOW,NOW,identity).run();
  await source.prepare('INSERT INTO agent_device_slots(user_id,device_id,attempt_id,reserved_at) VALUES(?,?,?,?)').bind(OWNER,deviceId,attemptId,NOW).run();
  await source.prepare('INSERT INTO agent_budgets(user_id,id,operational_revision,payload_json,maximum_jobs,maximum_seconds,reserved_jobs,reserved_seconds,charged_seconds,enabled,updated_at) VALUES(?,?,1,?,1,600,1,120,0,1,?)').bind(OWNER,budgetId,canonical({maximumJobs:1,maximumSeconds:600,enabled:true}),NOW).run();
  const event={schemaVersion:1,attemptId,epoch:0,sequence:1,observedAt:NOW,diagnostic:'ok',kind:'accepted',details:{specSha256:specHash,capabilitySha256:await contentHash(canonical(cap))}},eventHash=await contentHash(canonical(event)),receipt={attemptId,epoch:0,sequence:1,payloadSha256:eventHash,receivedAt:NOW};
  await source.prepare('INSERT INTO job_events(user_id,attempt_id,epoch,sequence,payload_hash,payload_json,receipt_json,received_at,applied_at) VALUES(?,?,0,1,?,?,?,?,?)').bind(OWNER,attemptId,eventHash,canonical(event),canonical(receipt),NOW,NOW).run();

 const projection=await moduleProjection('agent_jobs',jobId,record),names=moduleColumnNames('agent_jobs');
 await source.prepare('INSERT INTO agent_jobs(user_id,id,row_revision,payload_json,content_hash,'+names.join(',')+') VALUES('+['user_id','id','row_revision','payload_json','content_hash',...names].map(()=>'?').join(',')+')').bind(OWNER,jobId,1,canonical(record),await hash(record),...names.map(name=>projection[name])).run();
 }

 // Real native ZIP fixture: ready and retired archives, no live provider.
 const backupBundle=await exportWorkspaceBundle(source,OWNER,{now:()=>NOW}),backupContent=JSON.stringify(backupBundle),backupSha=await contentHash(backupContent);
 const zipReader=writeAttachmentArchive(backupBundle,[ready],async id=>{assert.equal(id,ready.id);return fileBytes;}).getReader();
 const zipPieces=[];let zipLength=0;
 for(;;){const next=await zipReader.read();if(next.done)break;zipPieces.push(next.value);zipLength+=next.value.length;assert.ok(zipLength<4*1024*1024);}
 zipReader.releaseLock();const zipBytes=new Uint8Array(zipLength);let zipOffset=0;for(const piece of zipPieces){zipBytes.set(piece,zipOffset);zipOffset+=piece.length;}
 const completeManifest={...backupBundle,completeness:'complete',attachments:await Promise.all(backupBundle.attachments.map(async entry=>({...entry,archivePath:await attachmentArchivePath(entry.id),availability:'included'})))};
 const backupIds={ready:crypto.randomUUID(),retired:crypto.randomUUID()},backupNamespaces={ready:crypto.randomUUID(),retired:crypto.randomUUID()};
 for(const status of ['ready','retired']){
  const id=backupIds[status],namespace=backupNamespaces[status],descriptor={part:0,bytes:zipBytes.length,sha256:await contentHash(zipBytes)};
  const index={format:'workspace-archive-chunks',version:1,archiveId:id,metadataSha256:backupSha,manifestSha256:await contentHash(new TextEncoder().encode(JSON.stringify(completeManifest))),zipBytes:zipBytes.length,files:1,fileBytes:fileBytes.length,chunks:[descriptor]};
  await createBackupArchiveStorage(await mf.getR2Bucket('SOURCE_BUCKET')).put(namespace,descriptor,zipBytes);
  if(status==='ready')await source.prepare("INSERT INTO workspace_backups(user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) VALUES(?,?,?,?,'scheduled',?,?,?,'ready',0)").bind(OWNER,id,backupBundle.source.workspaceRevision,NOW,new TextEncoder().encode(backupContent).length,backupSha,backupContent).run();
  await source.prepare('INSERT INTO backup_archives(user_id,id,namespace,intent_id,source_revision,source_sha256,metadata_content,metadata_bytes,execution_epoch,status,created_at,updated_at,zip_bytes,files,file_bytes,chunk_count,index_json,index_sha256) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?,1,?,1,?,?)').bind(OWNER,id,namespace,crypto.randomUUID(),backupBundle.source.workspaceRevision,backupSha,status==='ready'?backupContent:null,status==='ready'?new TextEncoder().encode(backupContent).length:0,status,NOW,NOW,zipBytes.length,fileBytes.length,canonical(index),await hash(index)).run();
  await source.prepare('INSERT INTO backup_archive_objects(user_id,archive_id,part_number,storage_key,bytes,sha256,created_at,verified_at,pending_token,settled_at) VALUES(?,?,0,?,?,?,?,?,?,?)').bind(OWNER,id,backupArchiveKey(namespace,0),descriptor.bytes,descriptor.sha256,NOW,NOW,crypto.randomUUID(),NOW).run();
  if(status==='retired')await source.prepare('INSERT INTO backup_archive_cleanup_claims(user_id,storage_key,archive_id,part_number,token,claimed_at,purged_at) VALUES(?,?,?,0,?,?,NULL)').bind(OWNER,backupArchiveKey(namespace,0),id,crypto.randomUUID(),NOW).run();
 }
 const priorMutationEpoch='c'.repeat(32);
 await source.prepare("INSERT INTO workspace_mutation_epochs(user_id,epoch,status,created_at,retired_at) VALUES(?,?,'active',?,NULL)").bind(OWNER,priorMutationEpoch,NOW).run();
 // Explicitly model an already over-limit owner. Ordinary mutations must not be used to evade admission.
 // Audit uses an independent frozen stream so source editor revision and original planning IDs remain intact.
 for(let offset=0;offset<10001;offset+=32){
  const statements=[];
  for(let i=offset;i<Math.min(10001,offset+32);i++){
   const id='synthetic-recovery-'+String(i).padStart(5,'0');
   const event=parseAuditEvent({id,kind:'synthetic.recovery.context',entityType:'project',entityId:project.id,changes:[{path:['context'],before:{exists:false,value:null},after:{exists:true,value:'Dated synthetic context '+i+' '+'.'.repeat(900)}}],origin:'owner',actorId:OWNER,occurredAt:NOW,sourceRef:null,undoOf:null});
   statements.push(source.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json,origin,actor_id) VALUES(?,?,NULL,NULL,?,?,?,?,?,?,?,?,?)').bind(OWNER,id,'recovery_fixture',i+1,event.kind,event.entityType,event.entityId,NOW,canonical(event),event.origin,OWNER));
  }
  await source.batch(statements);
 }
 await assert.rejects(()=>exportWorkspaceBundle(source,OWNER,{now:()=>NOW}),/limit|capacity|exceed/i,'Existing v1 export ceilings remain enforced.');
 await source.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,1,10001)').bind(OWNER,'recovery_fixture').run();
 // Permanent fenced historical identity is preserved, never advertised/copied.
 const oldNamespace=crypto.randomUUID(),oldId=crypto.randomUUID(),oldKey=attachmentStorageKey(oldNamespace,oldId);
 const oldBytes=new TextEncoder().encode('Synthetic old fenced bytes');
 assert.equal(await sourceStore.put(oldKey,oldBytes,{bytes:oldBytes.length,sha256:await contentHash(oldBytes),mimeType:'text/plain'}),'stored');
 await source.prepare('INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) VALUES(?,?,?,?,?,?,NULL)').bind(OWNER,oldKey,oldId,oldNamespace,crypto.randomUUID(),NOW).run();
 await source.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)').bind(OWNER,oldKey,oldId,oldNamespace,oldBytes.length,await contentHash(oldBytes),NOW,NOW).run();
 const frozen=await readCurrent(source,OWNER,NOW),vector=await readOperationalWatermarks(source,OWNER);
 const adapters=exportRegistry.entries().sort((a,b)=>bufferCompare(a.key,b.key)),specs=[...adapters.map(({key,schemaVersion})=>({key,schemaVersion})),{key:'planning',schemaVersion:frozen.workspace.schemaVersion}].sort((a,b)=>bufferCompare(a.key,b.key));
 const context={snapshotId:crypto.randomUUID(),ownerContextHash:await hash({owner:OWNER,sourceRevision:frozen.revision}),workspaceRevision:frozen.revision,operationalWatermarks:vector};
 const smallModules={},sourceHashes={},auditColumns='event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json';
 async function* sourceAudit(){
  let after='',count=0;const digest=createHash('sha256');digest.update('[');
  for(;;){
   const rows=(await source.prepare('SELECT '+auditColumns+' FROM audit_events WHERE user_id=? AND event_id>? ORDER BY event_id LIMIT 200').bind(OWNER,after).all()).results;if(!rows.length)break;
   for(const row of rows){const value=serializePortableAuditRow(row);if(count++)digest.update(',');digest.update(canonical(value));yield {id:row.event_id,rowRevision:1,contentHash:await hash(value),value};after=row.event_id;}
  }
  digest.update(']');sourceHashes.audit_events=digest.digest('hex');assert.ok(count>10000);
 }
 const inputs=[];
 for(const spec of specs){
  if(spec.key==='planning'){const row={id:'workspace',rowRevision:frozen.revision,contentHash:await hash(frozen.workspace),value:frozen.workspace};sourceHashes.planning=row.contentHash;inputs.push({...spec,rows:[row]});continue;}
  if(spec.key==='audit_events'){inputs.push({...spec,rows:sourceAudit()});continue;}
  const adapter=exportRegistry.get(spec.key),records=await adapter.exportRows({userId:OWNER,sourceRevision:frozen.revision,query:ownerReader(source,OWNER),db:source,operationalWatermarks:vector});
  smallModules[spec.key]={schemaVersion:spec.schemaVersion,records};sourceHashes[spec.key]=await hash(records);
  inputs.push({...spec,rows:[...records].sort((a,b)=>bufferCompare(a.id,b.id))});
 }
 const manifest=await encodeRecoverySegments({context,modules:inputs,onSegment:async segment=>{await stage.prepare('INSERT INTO segments(module,idx,content) VALUES(?,?,?)').bind(segment.module,segment.index,segment.content).run();}});
 assert.ok(manifest.totalBytes>BUNDLE_LIMITS.bytes);assert.ok(manifest.totalRows>BUNDLE_LIMITS.rows);
 assert.deepEqual((await readCurrent(source,OWNER,NOW)),frozen);assert.deepEqual(await readOperationalWatermarks(source,OWNER),vector);
 const schemaProfile=await inspectRecoveryMaintenanceSchema(source);
 const sourceEpoch=(await source.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(OWNER).first())?.epoch??0;
 const sourceReceipt=await freezeRecoveryDatabase(source,{operationId:crypto.randomUUID(),token:'b'.repeat(64),ownerId:OWNER,manifestSha256:manifest.sha256,ownerContextHash:context.ownerContextHash,schemaFingerprint:schemaProfile.schemaFingerprint,sourceContext:{workspaceRevision:frozen.revision,executionEpoch:sourceEpoch,operationalWatermarks:vector},now:NOW});
 const privateContinuity=await captureRecoveryPrivateContinuity(source,OWNER,{manifestSha256:manifest.sha256,ownerContextHash:context.ownerContextHash,sourceContext:sourceReceipt.sourceContext},NOW);
 await bindFrozenPrivateContinuity(source,sourceReceipt,privateContinuity,privateContinuity.sha256);
 await assert.rejects(source.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').bind(OWNER).run(),/operator_recovery_frozen/);
 await assert.rejects(assertRecoveryBlobCopyEligible(source,sourceReceipt,oldKey),/fenced|cleanup/i);
 const attachmentManifest=deriveAttachmentManifest(smallModules);validateAttachmentManifest(attachmentManifest,smallModules,{allowLegacyEmpty:false});assert.equal(attachmentManifest.length,1);
 // The side header is trusted operator input, not authority recovered from untrusted segment JSON.
 const header={format:'control-room-isolated-replacement',version:1,exportedAt:NOW,sourceAuditNamespace:sourceNamespaces.auditNamespace,sourceHashes,attachmentManifest,manifestHash:manifest.sha256,privateContinuityHash:privateContinuity.sha256,schemaFingerprint:schemaProfile.schemaFingerprint};
 const headerHash=await hash(header),readSegment=async(recoveryModule,index)=>{const row=await stage.prepare('SELECT content FROM segments WHERE module=? AND idx=?').bind(recoveryModule,index).first();if(!row)throw new Error('Missing segment');return row.content;};
 await validateRecoveryManifest(manifest,context,specs);
 async function initInstall(id){await stage.prepare("INSERT INTO installs(id,manifest_hash,status) VALUES(?,?,'staging')").bind(id,manifest.sha256).run();}
 async function state(id){return stage.prepare('SELECT * FROM installs WHERE id=?').bind(id).first();}
 async function stagedCount(id){return (await stage.prepare('SELECT COUNT(*) n FROM staged_rows WHERE install_id=?').bind(id).first()).n;}
 async function decodeInto(id,{stopAfter=null,reader=readSegment,resume=null}={}){
  const prior=await state(id);assert.equal(prior.status,'staging');assert.equal(prior.manifest_hash,manifest.sha256);
  let checkpoint=prior.checkpoint_json,pending=[],written=0,complete=false;
  async function flush(){
   if(!pending.length)return;
   const next=canonical(pending.at(-1).cursor);
   await stage.batch([
    stage.prepare("INSERT INTO assertions(ok) SELECT CASE WHEN EXISTS(SELECT 1 FROM installs WHERE id=? AND status='staging' AND manifest_hash=? AND checkpoint_json IS ?) THEN 1 ELSE 0 END").bind(id,manifest.sha256,checkpoint),
    ...pending.map(item=>stage.prepare('INSERT INTO staged_rows(install_id,module,id,row_json) VALUES(?,?,?,?)').bind(id,item.module,item.row.id,canonical(item.row))),
    stage.prepare('UPDATE installs SET checkpoint_json=? WHERE id=?').bind(next,id),stage.prepare('DELETE FROM assertions')
   ]);written+=pending.length;pending=[];checkpoint=next;
  }
  for await(const item of decodeRecoverySegments(manifest,{expectedContext:context,expectedModules:specs,readSegment:reader,...(resume?{resume}: {})})){
   if(item.kind==='complete'){await flush();complete=true;break;}pending.push(item);
   if(pending.length===32||stopAfter!==null&&written+pending.length===stopAfter){await flush();if(stopAfter!==null&&written>=stopAfter)throw new Error('Synthetic interrupted staging');}
  }
  assert.equal(complete,true);
  await stage.prepare("UPDATE installs SET status='verified' WHERE id=? AND status='staging'").bind(id).run();
 }
 const lastModule=manifest.modules.findLast(recoveryModule=>recoveryModule.segments.length),last=lastModule.segments.at(-1),originalLast=await readSegment(lastModule.key,last.index);
 await initInstall('corrupt');
 await assert.rejects(()=>decodeInto('corrupt',{reader:async(key,index)=>key===lastModule.key&&index===last.index?originalLast.replace(/.$/,'!'):readSegment(key,index)}));
 assert.equal(await stagedCount('corrupt'),0);assert.equal((await state('corrupt')).status,'staging');
 await initInstall('late-corrupt');const readCounts=new Map();
 await assert.rejects(()=>decodeInto('late-corrupt',{reader:async(key,index)=>{const identity=key+':'+index,count=(readCounts.get(identity)??0)+1;readCounts.set(identity,count);return key===lastModule.key&&index===last.index&&count===2?originalLast.replace(/.$/,'!'):readSegment(key,index);}}));
 assert.ok(await stagedCount('late-corrupt')>0);assert.equal((await state('late-corrupt')).status,'staging');assert.equal((await state('late-corrupt')).handoff_hash,null);
 await initInstall('interrupted');await assert.rejects(()=>decodeInto('interrupted',{stopAfter:17}),/interrupted/);
 assert.equal(await stagedCount('interrupted'),17);assert.equal((await state('interrupted')).status,'staging');
 const checkpoint=JSON.parse((await state('interrupted')).checkpoint_json),forged={...checkpoint,rowOffset:checkpoint.rowOffset+1};
 await assert.rejects(()=>decodeInto('interrupted',{resume:{cursor:forged,trustedCheckpoint:checkpoint}}));assert.equal(await stagedCount('interrupted'),17);
 await decodeInto('interrupted',{resume:{cursor:checkpoint,trustedCheckpoint:checkpoint}});
 assert.equal(await stagedCount('interrupted'),manifest.totalRows);
 async function rows(recoveryModule){
  return (await stage.prepare('SELECT row_json FROM staged_rows WHERE install_id=? AND module=? ORDER BY id').bind('interrupted',recoveryModule).all()).results.map(row=>JSON.parse(row.row_json));
 }
 const planningRows=await rows('planning');assert.equal(planningRows.length,1);assert.equal(planningRows[0].contentHash,sourceHashes.planning);
 const planning=parsePlanningImport(planningRows[0].value,NOW),modules={};
 for(const adapter of adapters){
  if(adapter.key==='audit_events'){modules[adapter.key]={schemaVersion:adapter.schemaVersion,records:[]};continue;}
  const stored=await rows(adapter.key);assert.equal(stored.length,manifest.modules.find(recoveryModule=>recoveryModule.key===adapter.key).rows);
  const records=adapter.parseAndMigrate({schemaVersion:adapter.schemaVersion,records:stored});
  // Logical hashes use the actual export order, which may differ from BINARY segment order.
  const original=smallModules[adapter.key].records,byId=new Map(records.map(row=>[row.id,row]));
  assert.equal(await hash(original.map(row=>byId.get(row.id))),sourceHashes[adapter.key]);modules[adapter.key]={schemaVersion:adapter.schemaVersion,records};
 }
 assert.deepEqual(Object.keys(modules).sort(),adapters.map(adapter=>adapter.key).sort());
 for(const adapter of adapters)adapter.validateReferences?.({planning,modules},modules[adapter.key].records);
 validateAttachmentManifest(header.attachmentManifest,modules,{allowLegacyEmpty:false});
 const prepared=[];
 for(const adapter of adapters)if(adapter.policy==='replace'){
  const declared=moduleTables(adapter),split=adapter.prepareReplace?await adapter.prepareReplace({planning,modules},modules[adapter.key].records):declared.length===1&&declared[0]===adapter.key?[{table:declared[0],records:modules[adapter.key].records.map(({id,value})=>({id,value}))}]:null;
  assert.ok(split,'Composite replacement requires an explicit typed splitter: '+adapter.key);assert.deepEqual(split.map(group=>group.table).sort(),declared.sort());
  for(const group of split)for(const record of group.records){
   const portable=modules[adapter.key].records.find(row=>row.id===record.id||row.value?.physicalId===record.id);assert.ok(portable,'Exact physical row provenance');
   const native=await ownerReader(source,OWNER).get(group.table,record.id);assert.ok(native);
   const nativeValue=JSON.parse(native.payload_json);assert.equal(await hash(nativeValue),native.content_hash);assert.equal(native.row_revision,portable.rowRevision);
   // A trusted same-owner frozen cutover retains original records. Ordinary
   // portable import transformations (for example historical agent labels) are
   // not new attribution or execution authority here; private dispatch is revoked.
   prepared.push({table:group.table,id:record.id,value:nativeValue,rowRevision:native.row_revision});
  }
 }
 const covered=new Set(adapters.flatMap(moduleTables));assert.deepEqual([...covered].sort(),OWNER_TABLES.filter(table=>table!=='workspace_configuration').sort());
 const tableOrder=[],remaining=new Set([...covered]);
 while(remaining.size){
  let progress=false;
  for(const table of [...remaining]){
   const dependencies=(await target.prepare('PRAGMA foreign_key_list("'+table+'")').all()).results.map(row=>row.table).filter(other=>other!==table&&covered.has(other));
   if(dependencies.every(other=>!remaining.has(other))){tableOrder.push(table);remaining.delete(table);progress=true;}
  }
  assert.ok(progress,'Foreign key dependency cycle requires an explicit reviewed adapter');
 }
 const sourcePhysical=await source.prepare('SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL').bind(OWNER).first();
 const freshFileBytes=header.attachmentManifest.reduce((total,file)=>total+file.bytes,0);
 assert.ok(sourcePhysical.count+header.attachmentManifest.length<=500&&sourcePhysical.bytes+freshFileBytes<=209715200,'Fresh file generations require physical quota headroom including old keys.');
 // Every attachment is read and fully checked before any replacement metadata is installed.
 const verifiedBytes=new Map();
 for(const entry of header.attachmentManifest){
  assert.equal(entry.availability,'excluded');const record=attachmentRecordSchema.parse(modules.attachments.records.find(row=>row.id===entry.id).value);
  await assertRecoveryBlobCopyEligible(source,sourceReceipt,record.storageKey);
  const read=await readReadyAttachment(OWNER,record,sourceStore,{ownerNamespace:sourceNamespaces.blobNamespace,now:NOW});
  assert.equal(await contentHash(read.bytes),entry.sha256);assert.equal(read.bytes.length,entry.bytes);verifiedBytes.set(entry.id,read.bytes);
 }
 async function verifyStageInventory(){
  assert.equal(await stagedCount('interrupted'),manifest.totalRows,'Staged row count differs');
  for(const recoveryModule of manifest.modules){
   const expected=createHash('sha256'),actual=createHash('sha256');expected.update('[');actual.update('[');let first=true,count=0;
   for(const descriptor of recoveryModule.segments)for(const row of JSON.parse(await readSegment(recoveryModule.key,descriptor.index)).rows){if(!first)expected.update(',');first=false;expected.update(canonical(row));}
   let after='';first=true;
   for(;;){
    const page=(await stage.prepare("SELECT id,row_json FROM staged_rows WHERE install_id='interrupted' AND module=? AND id>? ORDER BY id LIMIT 200").bind(recoveryModule.key,after).all()).results;if(!page.length)break;
    for(const row of page){if(!first)actual.update(',');first=false;actual.update(canonical(JSON.parse(row.row_json)));count++;after=row.id;}
   }
   expected.update(']');actual.update(']');assert.equal(count,recoveryModule.rows);assert.equal(actual.digest('hex'),expected.digest('hex'),'Staged module contents differ: '+recoveryModule.key);
  }
 }
 async function install(db,{failAfter=null}={}){
  await assertEmpty(db);await verifyStageInventory();assert.equal((await state('interrupted')).status,'verified');assert.equal(await hash(header),headerHash);
  const rawTarget=db;
  const targetReceipt=await prepareInactiveRecoveryTarget(rawTarget,source,sourceReceipt,{operationId:crypto.randomUUID(),token:crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''),expectedPrivateSha256:privateContinuity.sha256});
  db=inactiveRecoveryDatabase(rawTarget,targetReceipt);
  await getOrCreateWorkspaceNamespaces(db,OWNER);
  await db.prepare('UPDATE workspace_source_namespaces SET audit_namespace=? WHERE user_id=?').bind(sourceNamespaces.auditNamespace,OWNER).run();
  const namespaces=await getWorkspaceNamespaces(db,OWNER);assert.equal(namespaces.auditNamespace,sourceNamespaces.auditNamespace);assert.notEqual(namespaces.blobNamespace,sourceNamespaces.blobNamespace);assert.notDeepEqual(namespaces.cursorSecret,sourceNamespaces.cursorSecret);
  await db.prepare('INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(?,?,?,?)').bind(OWNER,encodePlanning(planning),context.workspaceRevision,NOW).run();
  let writes=0;
  for(const table of tableOrder){
   const statements=[];
   for(const row of prepared.filter(row=>row.table===table)){
    let value=structuredClone(row.value);
    if(table==='attachments'&&value.status==='ready'){
     const bytes=verifiedBytes.get(row.id);assert.ok(bytes);value.storageKey=attachmentStorageKey(namespaces.blobNamespace,row.id);
     const uploadToken=crypto.randomUUID();
     await db.batch([
      db.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at) VALUES(?,?,?,?,?,?,?,NULL)').bind(OWNER,value.storageKey,row.id,namespaces.blobNamespace,bytes.length,value.sha256,NOW),
      db.prepare('INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at) VALUES(?,?,?,?,?,NULL)').bind(OWNER,uploadToken,row.id,value.storageKey,NOW),
     ]);
     assert.equal(await targetStore.put(value.storageKey,bytes,{bytes:bytes.length,sha256:value.sha256,mimeType:value.mimeType}),'stored');
     await db.prepare('UPDATE attachment_upload_attempts SET settled_at=? WHERE user_id=? AND token=? AND settled_at IS NULL').bind(NOW,OWNER,uploadToken).run();
     const loaded=await readReadyAttachment(OWNER,value,targetStore,{ownerNamespace:namespaces.blobNamespace,now:NOW});assert.deepEqual(loaded.bytes,bytes);
     await db.prepare('UPDATE attachment_blob_objects SET verified_at=? WHERE user_id=? AND storage_key=?').bind(NOW,OWNER,value.storageKey).run();
    }
    const projection=await moduleProjection(table,row.id,value),names=moduleColumnNames(table);assert.deepEqual(Object.keys(projection),names);
    const columns=['user_id','id','row_revision','payload_json','content_hash',...names],values=[OWNER,row.id,row.rowRevision,canonical(value),await hash(value),...names.map(name=>projection[name])];
    statements.push(db.prepare('INSERT INTO '+table+'('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').bind(...values));
   }
   try{await batch(db,statements);}catch(cause){throw new Error('Closed normalized recovery table failed: '+table,{cause});}writes+=statements.length;if(failAfter!==null&&writes>=failAfter)throw new Error('Synthetic interrupted physical installation');
  }
  let auditAfter='';const auditDigest=createHash('sha256');auditDigest.update('[');
  for(;;){
   const page=(await stage.prepare("SELECT row_json FROM staged_rows WHERE install_id='interrupted' AND module='audit_events' AND id>? ORDER BY id LIMIT 32").bind(auditAfter).all()).results;if(!page.length)break;
   const original=page.map(row=>JSON.parse(row.row_json));
   for(const row of original){assert.equal(row.contentHash,await hash(row.value));if(ordinal+original.indexOf(row))auditDigest.update(',');auditDigest.update(canonical(row.value));}
   const nativeColumns=['event_id','workspace_revision','ordinal','stream_id','stream_sequence','kind','entity_type','entity_id','occurred_at','payload_json','origin','actor_id','source_ref','undo_of'],statements=[];
   for(const row of original){
    const native=await source.prepare('SELECT '+nativeColumns.join(',')+' FROM audit_events WHERE user_id=? AND event_id=?').bind(OWNER,row.id).first();assert.ok(native);
    assert.deepEqual(serializePortableAuditRow(Object.fromEntries(auditColumns.split(',').map(column=>[column,native[column]]))),row.value);
    statements.push(db.prepare('INSERT INTO audit_events(user_id,'+nativeColumns.join(',')+') VALUES('+['user_id',...nativeColumns].map(()=>'?').join(',')+')').bind(OWNER,...nativeColumns.map(column=>native[column])));
   }
   await batch(db,statements);
   const preserved=(await db.prepare('SELECT '+nativeColumns.join(',')+' FROM audit_events WHERE user_id=? AND event_id IN ('+original.map(()=>'?').join(',')+') ORDER BY event_id').bind(OWNER,...original.map(row=>row.id)).all()).results;
   const nativeSource=(await source.prepare('SELECT '+nativeColumns.join(',')+' FROM audit_events WHERE user_id=? AND event_id IN ('+original.map(()=>'?').join(',')+') ORDER BY event_id').bind(OWNER,...original.map(row=>row.id)).all()).results;
   assert.deepEqual(preserved,nativeSource,'Native audit IDs, actor/origin, stream/null fields and exact original payload differ.');
   auditAfter=original.at(-1).id;
  }
  auditDigest.update(']');assert.equal(auditDigest.digest('hex'),sourceHashes.audit_events);
  assert.deepEqual((await readCurrent(db,OWNER,NOW)).workspace,planning);
  const auditCount=(await db.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').bind(OWNER).first()).n;
  assert.equal(auditCount,manifest.modules.find(recoveryModule=>recoveryModule.key==='audit_events').rows);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM audit_import_identities WHERE user_id=?').bind(OWNER).first()).n,0);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  // Exact inert intent roots satisfy normalized FK children; no runnable authority is installed.
  for(const table of ['workspace_mutations','source_sync_state','automation_runtime']){
   const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first();if(exists)assert.equal((await db.prepare('SELECT COUNT(*) n FROM '+table).first()).n,0,table);
  }
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_job_intents').first()).n,privateContinuity.tables.workspace_job_intents.length);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE status IN('pending','awaiting_approval') OR (status='running' AND (kind<>'agent.execute' OR cancel_requested<>1))").first()).n,0);
  const physical=[];
  for(const table of tableOrder){
   const actual=(await db.prepare('SELECT id,row_revision,payload_json,content_hash FROM '+table+' WHERE user_id=? ORDER BY id').bind(OWNER).all()).results;
   const expected=prepared.filter(row=>row.table===table).sort((a,b)=>bufferCompare(a.id,b.id));assert.equal(actual.length,expected.length);
   for(let i=0;i<actual.length;i++){
    const value=JSON.parse(actual[i].payload_json),sourceValue=structuredClone(expected[i].value);if(table==='attachments'&&sourceValue.status==='ready')sourceValue.storageKey=attachmentStorageKey(namespaces.blobNamespace,sourceValue.id);
    assert.equal(actual[i].id,expected[i].id);assert.equal(actual[i].row_revision,expected[i].rowRevision);assert.deepEqual(value,sourceValue);assert.equal(actual[i].content_hash,await hash(value));physical.push([table,actual[i].id,actual[i].content_hash]);
   }
  }
  const continuityResult=await installRecoveryPrivateContinuity(source,sourceReceipt,rawTarget,targetReceipt,privateContinuity,privateContinuity.sha256);
  assert.equal((await rawTarget.prepare('SELECT COUNT(*) count FROM acceptance_owner_grants WHERE user_id=? AND record_id=?').bind(OWNER,ownerAssessment.id).first()).count,1);
  assert.equal((await rawTarget.prepare('SELECT COUNT(*) count FROM acceptance_owner_grants WHERE user_id=? AND record_id=?').bind(OWNER,importedAssessmentId).first()).count,0);
  for(const table of ['acceptance_owner_grants','decision_owner_grants','review_ack_grants','notification_read_state','audit_project_links','audit_import_identities','workspace_drafts'])assert.equal((await rawTarget.prepare('SELECT COUNT(*) count FROM '+table+' WHERE user_id=?').bind(OWNER).first()).count,privateContinuity.tables[table].length,table);
  assert.equal((await rawTarget.prepare('SELECT payload_json FROM workspace_drafts WHERE user_id=?').bind(OWNER).first()).payload_json,privateContinuity.tables.workspace_drafts[0].payload_json);
  const oldHistory=await readHistoryPage(source,OWNER,{}, {secret:sourceNamespaces.cursorSecret,now:()=>NOW});assert.ok(oldHistory.nextCursor);
  await assert.rejects(readHistoryPage(rawTarget,OWNER,{cursor:oldHistory.nextCursor},{secret:namespaces.cursorSecret,now:()=>NOW}),/cursor.*unavailable/i);
  const newHistory=await readHistoryPage(rawTarget,OWNER,{}, {secret:namespaces.cursorSecret,now:()=>NOW});assert.ok(newHistory.nextCursor);
  assert.deepEqual(newHistory.entries.map(entry=>entry.id),oldHistory.entries.map(entry=>entry.id));
  await verifyHistoryCursor(OWNER,newHistory.nextCursor,{}, {secret:namespaces.cursorSecret,now:()=>NOW});
  assert.equal(continuityResult.retainedAttempts,1);assert.equal(continuityResult.retainedRemovalFences,1);
  assert.equal(privateContinuity.baselineRemovalFences[0].entity_id,removedOwnerTaskId);
  assert.ok(await rawTarget.prepare("SELECT event_id FROM audit_events WHERE user_id=? AND entity_id=? AND kind='entity.delete'").bind(OWNER,removedOwnerTaskId).first());
  assert.equal((await rawTarget.prepare("SELECT status FROM agent_job_state WHERE user_id=? AND job_id='synthetic-private-job'").bind(OWNER).first()).status,'reconcile_required');
  assert.equal((await rawTarget.prepare("SELECT released_at FROM agent_device_slots WHERE user_id=? AND device_id='synthetic-private-device'").bind(OWNER).first()).released_at,null);
  assert.equal((await rawTarget.prepare("SELECT reserved_seconds,enabled FROM agent_budgets WHERE user_id=? AND id='synthetic-private-budget'").bind(OWNER).first()).reserved_seconds,120);
  assert.equal((await rawTarget.prepare("SELECT enabled FROM agent_budgets WHERE user_id=? AND id='synthetic-private-budget'").bind(OWNER).first()).enabled,0);
  assert.deepEqual((await rawTarget.prepare('SELECT identity_json FROM job_attempts WHERE user_id=?').bind(OWNER).all()).results,privateContinuity.tables.job_attempts.map(row=>({identity_json:row.identity_json})));
  assert.deepEqual((await rawTarget.prepare('SELECT receipt_json FROM job_events WHERE user_id=?').bind(OWNER).all()).results,privateContinuity.tables.job_events.map(row=>({receipt_json:row.receipt_json})));
  for(const table of ['integration_job_attempts','automation_occurrence_claims'] ){
   const expected=privateContinuity.tables[table];for(const row of expected){const columns=Object.keys(row);const all=(await rawTarget.prepare('SELECT '+columns.join(',')+' FROM '+table+' WHERE user_id=?').bind(OWNER).all()).results;assert.ok(all.some(actual=>canonical(actual)===canonical(row)),'Original native journal identity retained: '+table);}
  }
  for(const row of privateContinuity.tables.integration_jobs){
   const actual=await rawTarget.prepare('SELECT * FROM integration_jobs WHERE user_id=? AND intent_id=?').bind(OWNER,row.intent_id).first();assert.ok(actual);
   const expected={user_id:OWNER,...row,lease_token:null,lease_expires_at:null,lease_access_mode:null,lease_principal_ref:null};assert.deepEqual(actual,expected);
  }
  for(const row of privateContinuity.tables.workspace_mutations){
   assert.deepEqual(await rawTarget.prepare('SELECT command_hash,revision,committed_at FROM workspace_mutations WHERE user_id=? AND mutation_id=?').bind(OWNER,row.mutation_id).first(),{command_hash:row.command_hash,revision:row.revision,committed_at:row.committed_at});
  }
  assert.equal((await rawTarget.prepare('SELECT status FROM workspace_mutation_epochs WHERE user_id=? AND epoch=?').bind(OWNER,priorMutationEpoch).first()).status,'retired');
  assert.ok(await rawTarget.prepare('SELECT storage_key FROM attachment_blob_fences WHERE user_id=? AND storage_key=?').bind(OWNER,oldKey).first());
  // A delayed operation on the permanently excluded old key cannot address any
  // new namespace file. This is a real isolated R2 DELETE, never an owner bucket.
  await (await mf.getR2Bucket('SOURCE_BUCKET')).delete(oldKey);
  assert.deepEqual(await readOperationalWatermarks(rawTarget,OWNER),vector);
  const restoredReviewRows=await exportRegistry.get('review_snapshots').exportRows({userId:OWNER,sourceRevision:context.workspaceRevision,query:ownerReader(rawTarget,OWNER),db:rawTarget,operationalWatermarks:await readOperationalWatermarks(rawTarget,OWNER)});
  assert.equal(restoredReviewRows.length,smallModules.review_snapshots.records.length);assert.ok(restoredReviewRows.length>0);
  const backupCopies=await copyRecoveryBackupArchives(source,sourceReceipt,rawTarget,targetReceipt,privateContinuity,{source:{bucket:await mf.getR2Bucket('SOURCE_BUCKET'),attachmentBucket:await mf.getR2Bucket('SOURCE_BUCKET')},targetBucket:await mf.getR2Bucket('SOURCE_BUCKET')});
  assert.equal(backupCopies.mappings.length,1);assert.equal(backupCopies.retainedInert,1);
  const copiedReady=backupCopies.mappings[0];assert.equal(copiedReady.archiveId,backupIds.ready);assert.notEqual(copiedReady.sourceNamespace,copiedReady.targetNamespace);
  await (await mf.getR2Bucket('SOURCE_BUCKET')).delete(backupArchiveKey(backupNamespaces.retired,0));
  assert.equal((await rawTarget.prepare('SELECT execution_epoch FROM backup_archives WHERE user_id=? AND id=?').bind(OWNER,backupIds.retired).first()).execution_epoch,sourceEpoch);
  assert.equal((await rawTarget.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(OWNER).first()).epoch,sourceEpoch+1);
  const actualBackup=await readReadyFileBackup(rawTarget,OWNER,backupIds.ready,{bucket:await mf.getR2Bucket('SOURCE_BUCKET'),attachmentBucket:await mf.getR2Bucket('SOURCE_BUCKET')});
  assert.ok(actualBackup);await actualBackup.stream.cancel();
  assert.equal(await readReadyFileBackup(rawTarget,OWNER,backupIds.retired,{bucket:await mf.getR2Bucket('SOURCE_BUCKET'),attachmentBucket:await mf.getR2Bucket('SOURCE_BUCKET')}),null);
  const targetPhysical=await rawTarget.prepare('SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL').bind(OWNER).first();
  assert.equal(targetPhysical.count,sourcePhysical.count+header.attachmentManifest.length);assert.equal(targetPhysical.bytes,sourcePhysical.bytes+freshFileBytes);
  const inventorySha256=await recoveryTargetInventorySha256(rawTarget,targetReceipt);
  await markRecoveryTargetReady(rawTarget,source,sourceReceipt,targetReceipt,{privateSha256:privateContinuity.sha256,inventorySha256,actualInventorySha256:()=>recoveryTargetInventorySha256(rawTarget,targetReceipt)});
  await assert.rejects(rawTarget.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').bind(OWNER).run(),/operator_recovery_frozen/);
  const handoff={backupCopies,privateContinuityHash:privateContinuity.sha256,inventorySha256,continuityResult,maintenance:'target-ready-still-fenced',manifestHash:manifest.sha256,headerHash,workspaceRevision:context.workspaceRevision,physicalHash:await hash(physical),auditRows:auditCount,attachmentRows:verifiedBytes.size,authority:'revoked-private-continuity',bindingAction:'manual-reviewed-replacement-only'};
  return {handoff,hash:await hash(handoff)};
 }
 await assert.rejects(()=>install(failed,{failAfter:1}),/interrupted physical/);
 assert.equal((await state('interrupted')).handoff_hash,null);
 await assert.rejects(()=>install(failed),/Replacement must be empty/);
 // Missing staged data must not be mistaken for a valid resumable destination.
 const first=(await rows('planning'))[0];await stage.prepare("DELETE FROM staged_rows WHERE install_id='interrupted' AND module='planning'").run();
 assert.notEqual(await stagedCount('interrupted'),manifest.totalRows);assert.equal((await state('interrupted')).handoff_hash,null);
 await assert.rejects(()=>install(target),/Staged row count differs/);await assertEmpty(target);
 await stage.prepare("INSERT INTO staged_rows(install_id,module,id,row_json) VALUES('interrupted','planning',?,?)").bind(first.id,canonical(first)).run();
 const installed=await install(target);
 await stage.prepare("UPDATE installs SET status='ready-for-manual-cutover',handoff_hash=? WHERE id='interrupted' AND status='verified' AND manifest_hash=?").bind(installed.hash,manifest.sha256).run();
 assert.equal((await state('interrupted')).handoff_hash,installed.hash);
 assert.deepEqual(await readCurrent(source,OWNER,NOW),frozen);assert.deepEqual(await readOperationalWatermarks(source,OWNER),vector);
 assert.deepEqual((await readReadyAttachment(OWNER,attachmentRecordSchema.parse(JSON.parse((await ownerReader(target,OWNER).get('attachments',ready.id)).payload_json)),targetStore,{ownerNamespace:(await getWorkspaceNamespaces(target,OWNER)).blobNamespace,now:NOW})).bytes,fileBytes);
 console.log(JSON.stringify({profile:'isolated-replacement-rehearsal',migrations:migrationNames.length,modules:specs.length,segments:manifest.modules.reduce((sum,recoveryModule)=>sum+recoveryModule.segments.length,0),rows:manifest.totalRows,bytes:manifest.totalBytes,handoff:installed.handoff,sourcePlanningUnchanged:true,sharedIsolatedR2FreshNamespaces:true,excludedLateDeletesTested:true,v1BoundsUnchanged:true,hostedBindingChanged:false,limitations:['64MiB metadata profile only','No hosted cutover or live provider/device verification','No private credential, capability or dispatch authority is restored','Backup source physical identities retained in sealed continuity; ready chunks use fresh namespaces','Single-owner empty replacement profile; no production binding cutover']}));
 console.log('PASS actual isolated D1/R2 segmented replacement: all-segment preverification, corruption rejection, checkpoint CAS, interrupted-target refusal, typed reference/FK validation, exact native audit identities and existing nonexecution owner attribution, verified fresh-namespace attachment, manual-only handoff.');
}finally{await mf.dispose();}
