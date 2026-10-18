// Synthetic offline replacement rehearsal. Never connects to hosted D1/R2 or changes a Sites binding.
// The destination is a new isolated database, deliberately not exposed until the sidecar handoff marker.
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
import {prepareHistoricalAuditRows} from '../lib/audit-import.ts';
import {attachmentRecordSchema} from '../lib/evidence-module.ts';
import {deriveAttachmentManifest,validateAttachmentManifest} from '../lib/attachment-manifest.ts';
import {getWorkspaceNamespaces,getOrCreateWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {createR2BlobStore,stageAttachmentUpload,readReadyAttachment,attachmentStorageKey} from '../lib/attachments.ts';
import {beginUpload,finishUpload} from '../lib/attachment-upload-fences.ts';
import {BASELINE_ID} from '../lib/project-baselines.ts';

assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 is required.');
const NOW='2026-10-18T12:00:00.000Z',OWNER='synthetic-segmented-replacement-owner';
const bufferCompare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const stream=bytes=>new ReadableStream({start(controller){controller.enqueue(bytes.slice());controller.close();}});
const hash=value=>contentHash(canonical(value));
const batch=async(db,statements,size=32)=>{for(let i=0;i<statements.length;i+=size)await db.batch(statements.slice(i,i+size));};
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated recovery fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['SOURCE','TARGET','FAILED','STAGE'],d1Persist:false,r2Buckets:['SOURCE_BUCKET','TARGET_BUCKET'],r2Persist:false,cf:false});
try{
 const source=await mf.getD1Database('SOURCE'),target=await mf.getD1Database('TARGET'),failed=await mf.getD1Database('FAILED'),stage=await mf.getD1Database('STAGE');
 const sourceStore=createR2BlobStore(await mf.getR2Bucket('SOURCE_BUCKET')),targetStore=createR2BlobStore(await mf.getR2Bucket('TARGET_BUCKET'));
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
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('d1_migrations','__drizzle_migrations')").all()).results;
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
 await send({type:'decisions.create',value:{title:'Synthetic replacement decision',question:'Retain the exact draft?',options:[{id:'retain',label:'Retain',description:''}],selectedOptionId:null,rationale:'',reviewOn:null,subjects:[{type:'project',id:project.id}],evidenceRefs:[],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null}});
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
 const attachmentManifest=deriveAttachmentManifest(smallModules);validateAttachmentManifest(attachmentManifest,smallModules,{allowLegacyEmpty:false});assert.equal(attachmentManifest.length,1);
 // The side header is trusted operator input, not authority recovered from untrusted segment JSON.
 const header={format:'control-room-isolated-replacement',version:1,exportedAt:NOW,sourceAuditNamespace:sourceNamespaces.auditNamespace,sourceHashes,attachmentManifest,manifestHash:manifest.sha256};
 const headerHash=await hash(header),readSegment=async(module,index)=>{const row=await stage.prepare('SELECT content FROM segments WHERE module=? AND idx=?').bind(module,index).first();if(!row)throw new Error('Missing segment');return row.content;};
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
 const lastModule=manifest.modules.findLast(module=>module.segments.length),last=lastModule.segments.at(-1),originalLast=await readSegment(lastModule.key,last.index);
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
 async function rows(module){
  return (await stage.prepare('SELECT row_json FROM staged_rows WHERE install_id=? AND module=? ORDER BY id').bind('interrupted',module).all()).results.map(row=>JSON.parse(row.row_json));
 }
 const planningRows=await rows('planning');assert.equal(planningRows.length,1);assert.equal(planningRows[0].contentHash,sourceHashes.planning);
 const planning=parsePlanningImport(planningRows[0].value,NOW),modules={};
 for(const adapter of adapters){
  if(adapter.key==='audit_events'){modules[adapter.key]={schemaVersion:adapter.schemaVersion,records:[]};continue;}
  const stored=await rows(adapter.key);assert.equal(stored.length,manifest.modules.find(module=>module.key===adapter.key).rows);
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
   prepared.push({table:group.table,id:record.id,value:record.value,rowRevision:portable.rowRevision});
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
 // Every attachment is read and fully checked before any replacement metadata is installed.
 const verifiedBytes=new Map();
 for(const entry of header.attachmentManifest){
  assert.equal(entry.availability,'excluded');const record=attachmentRecordSchema.parse(modules.attachments.records.find(row=>row.id===entry.id).value);
  const read=await readReadyAttachment(OWNER,record,sourceStore,{ownerNamespace:sourceNamespaces.blobNamespace,now:NOW});
  assert.equal(await contentHash(read.bytes),entry.sha256);assert.equal(read.bytes.length,entry.bytes);verifiedBytes.set(entry.id,read.bytes);
 }
 async function verifyStageInventory(){
  assert.equal(await stagedCount('interrupted'),manifest.totalRows,'Staged row count differs');
  for(const module of manifest.modules){
   const expected=createHash('sha256'),actual=createHash('sha256');expected.update('[');actual.update('[');let first=true,count=0;
   for(const descriptor of module.segments)for(const row of JSON.parse(await readSegment(module.key,descriptor.index)).rows){if(!first)expected.update(',');first=false;expected.update(canonical(row));}
   let after='';first=true;
   for(;;){
    const page=(await stage.prepare("SELECT id,row_json FROM staged_rows WHERE install_id='interrupted' AND module=? AND id>? ORDER BY id LIMIT 200").bind(module.key,after).all()).results;if(!page.length)break;
    for(const row of page){if(!first)actual.update(',');first=false;actual.update(canonical(JSON.parse(row.row_json)));count++;after=row.id;}
   }
   expected.update(']');actual.update(']');assert.equal(count,module.rows);assert.equal(actual.digest('hex'),expected.digest('hex'),'Staged module contents differ: '+module.key);
  }
 }
 async function install(db,{failAfter=null}={}){
  await assertEmpty(db);await verifyStageInventory();assert.equal((await state('interrupted')).status,'verified');assert.equal(await hash(header),headerHash);
  const namespaces=await getOrCreateWorkspaceNamespaces(db,OWNER);assert.notEqual(namespaces.auditNamespace,sourceNamespaces.auditNamespace);assert.notEqual(namespaces.blobNamespace,sourceNamespaces.blobNamespace);
  await db.prepare('INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(?,?,?,?)').bind(OWNER,encodePlanning(planning),context.workspaceRevision,NOW).run();
  let writes=0;
  for(const table of tableOrder){
   const statements=[];
   for(const row of prepared.filter(row=>row.table===table)){
    let value=structuredClone(row.value);
    if(table==='attachments'&&value.status==='ready'){
     const bytes=verifiedBytes.get(row.id);assert.ok(bytes);value.storageKey=attachmentStorageKey(namespaces.blobNamespace,row.id);
     assert.equal(await targetStore.put(value.storageKey,bytes,{bytes:bytes.length,sha256:value.sha256,mimeType:value.mimeType}),'stored');
     const loaded=await readReadyAttachment(OWNER,value,targetStore,{ownerNamespace:namespaces.blobNamespace,now:NOW});assert.deepEqual(loaded.bytes,bytes);
     await db.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)').bind(OWNER,value.storageKey,row.id,namespaces.blobNamespace,bytes.length,value.sha256,NOW,NOW).run();
    }
    const projection=await moduleProjection(table,row.id,value),names=moduleColumnNames(table);assert.deepEqual(Object.keys(projection),names);
    const columns=['user_id','id','row_revision','payload_json','content_hash',...names],values=[OWNER,row.id,row.rowRevision,canonical(value),await hash(value),...names.map(name=>projection[name])];
    statements.push(db.prepare('INSERT INTO '+table+'('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').bind(...values));
   }
   await batch(db,statements);writes+=statements.length;if(failAfter!==null&&writes>=failAfter)throw new Error('Synthetic interrupted physical installation');
  }
  let auditAfter='',ordinal=0;const auditDigest=createHash('sha256');auditDigest.update('[');
  for(;;){
   const page=(await stage.prepare("SELECT row_json FROM staged_rows WHERE install_id='interrupted' AND module='audit_events' AND id>? ORDER BY id LIMIT 32").bind(auditAfter).all()).results;if(!page.length)break;
   const original=page.map(row=>JSON.parse(row.row_json));
   for(const row of original){assert.equal(row.contentHash,await hash(row.value));if(ordinal+original.indexOf(row))auditDigest.update(',');auditDigest.update(canonical(row.value));}
   const claims=await prepareHistoricalAuditRows(original.map(row=>row.value),header.sourceAuditNamespace,manifest.sha256),statements=[];
   for(const claim of claims){
    const event=parseAuditEvent({id:claim.id,kind:'imported-history',entityType:'historical-claim',entityId:null,changes:[{path:['sourceClaim'],before:{exists:false,value:null},after:{exists:true,value:claim.source}}],origin:'owner',actorId:OWNER,occurredAt:NOW,sourceRef:claim.importHash,undoOf:null});
    statements.push(db.prepare("INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json,origin,actor_id,source_ref) VALUES(?,?,?,?,'imported-history','historical-claim',NULL,?,?,'owner',?,?)").bind(OWNER,event.id,context.workspaceRevision,ordinal++,NOW,canonical(event),OWNER,manifest.sha256));
    statements.push(db.prepare('INSERT INTO audit_import_identities(user_id,source_identity,source_hash,event_id) VALUES(?,?,?,?)').bind(OWNER,claim.sourceIdentity,claim.sourceHash,claim.id));
   }
   await batch(db,statements);
   const restored=(await db.prepare('SELECT a.event_id,a.payload_json,i.source_identity,i.source_hash FROM audit_events a JOIN audit_import_identities i ON i.user_id=a.user_id AND i.event_id=a.event_id WHERE a.user_id=? AND a.event_id IN ('+claims.map(()=>'?').join(',')+')').bind(OWNER,...claims.map(claim=>claim.id)).all()).results;
   assert.equal(restored.length,claims.length);
   for(const claim of claims){const actual=restored.find(row=>row.event_id===claim.id);assert.ok(actual);assert.equal(actual.source_identity,claim.sourceIdentity);assert.equal(actual.source_hash,claim.sourceHash);assert.deepEqual(parseAuditEvent(JSON.parse(actual.payload_json)).changes[0].after.value,claim.source);}
   auditAfter=original.at(-1).id;
  }
  auditDigest.update(']');assert.equal(auditDigest.digest('hex'),sourceHashes.audit_events);
  assert.deepEqual((await readCurrent(db,OWNER,NOW)).workspace,planning);
  const auditCount=(await db.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').bind(OWNER).first()).n;
  assert.equal(auditCount,manifest.modules.find(module=>module.key==='audit_events').rows);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM audit_import_identities WHERE user_id=?').bind(OWNER).first()).n,auditCount);
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  // Private authority must start empty. New namespaces and verified target object ledger are the only intentional private setup.
  for(const table of ['workspace_mutations','workspace_job_intents','decision_owner_grants','acceptance_owner_grants','source_sync_state','automation_runtime']){
   const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first();if(exists)assert.equal((await db.prepare('SELECT COUNT(*) n FROM '+table).first()).n,0,table);
  }
  const physical=[];
  for(const table of tableOrder){
   const actual=(await db.prepare('SELECT id,row_revision,payload_json,content_hash FROM '+table+' WHERE user_id=? ORDER BY id').bind(OWNER).all()).results;
   const expected=prepared.filter(row=>row.table===table).sort((a,b)=>bufferCompare(a.id,b.id));assert.equal(actual.length,expected.length);
   for(let i=0;i<actual.length;i++){
    const value=JSON.parse(actual[i].payload_json),sourceValue=structuredClone(expected[i].value);if(table==='attachments'&&sourceValue.status==='ready')sourceValue.storageKey=attachmentStorageKey(namespaces.blobNamespace,sourceValue.id);
    assert.equal(actual[i].id,expected[i].id);assert.equal(actual[i].row_revision,expected[i].rowRevision);assert.deepEqual(value,sourceValue);assert.equal(actual[i].content_hash,await hash(value));physical.push([table,actual[i].id,actual[i].content_hash]);
   }
  }
  const handoff={manifestHash:manifest.sha256,headerHash,workspaceRevision:context.workspaceRevision,physicalHash:await hash(physical),auditRows:auditCount,attachmentRows:verifiedBytes.size,authority:'fresh-private-state',bindingAction:'manual-reviewed-replacement-only'};
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
 console.log(JSON.stringify({profile:'isolated-replacement-rehearsal',migrations:migrationNames.length,modules:specs.length,segments:manifest.modules.reduce((sum,module)=>sum+module.segments.length,0),rows:manifest.totalRows,bytes:manifest.totalBytes,handoff:installed.handoff,sourceUntouched:true,v1BoundsUnchanged:true,hostedBindingChanged:false,limitations:['64MiB metadata profile only','No hosted cutover or live provider/device verification','Private authority is not imported','Recovery of private tombstones and operational state requires a separately reviewed operator policy']}));
 console.log('PASS actual isolated D1/R2 segmented replacement: all-segment preverification, corruption rejection, checkpoint CAS, interrupted-target refusal, typed reference/FK validation, stable historical identities, verified fresh-namespace attachment, manual-only handoff.');
}finally{await mf.dispose();}
