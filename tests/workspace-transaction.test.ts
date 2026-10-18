import {decodePlanning} from '../lib/workspace-codec.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {createHash} from 'node:crypto';
import {canonical} from '../lib/canonical-json.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/sqlite.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { loadWorkspace, readCurrent, type SqlDatabase } from '../lib/workspace-store.ts';
import { executeWorkspaceCommand, hashJson, type CommandHandlerRegistry, type MutationPlan, type PrepareContext } from '../lib/workspace-transaction.ts';
import { ownerReader, OWNER_TABLES } from '../lib/workspace-modules.ts';
import { ModuleConflictError, MutationIdReuseError, WorkspaceStorageError } from '../lib/workspace-errors.ts';
import {versionRowId} from '../lib/version-identity.ts';
import { workspaceHandlers } from '../lib/workspace-handlers.ts';
const now='2026-10-18T12:00:00.000Z';
const fixtureHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const id='synthetic-mutation-0001';
const command={type:'fixture.change'};
const input=(mutationId=id,expectedRevision=1)=>({protocolVersion:1,expectedRevision,mutationId,command});
function plan(context:PrepareContext):MutationPlan {
  const planningAfter=structuredClone(context.before.workspace);
  planningAfter.projects[0].goal='Changed together';
  return {planningAfter,writes:[{table:'evidence_records',operation:'insert',id:'record',value:{text:'Synthetic evidence'},expectedRowRevision:null}],events:[{id:'event',kind:'fixture.change',entityType:'project',entityId:planningAfter.projects[0].id,changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}],jobs:[{id:'job',kind:'synthetic',dedupeKey:'once',payload:{record:'record'},notBefore:now}]};
}
const handlers:CommandHandlerRegistry=new Map([['fixture.change',{prepare:async context=>plan(context)}]]);
async function setup(){const fixture=database();await loadWorkspace(fixture.db,'a',()=>createSeedWorkspace(now),now);await loadWorkspace(fixture.db,'b',()=>createSeedWorkspace(now),now);return fixture;}
function intercept(db:SqlDatabase,hook:()=>Promise<void>|void):SqlDatabase {let fired=false;return {...db,batch:async statements=>{if(!fired){fired=true;await hook();}return db.batch(statements);}};}
function count(sqlite:ReturnType<typeof database>['sqlite'],table:string,owner='a'){return sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id=?`).get(owner)!.n;}
function assertClean(sqlite:ReturnType<typeof database>['sqlite']){for(const table of ['workspace_mutations','workspace_command_guards','workspace_assertions','workspace_recovery','workspace_backups','evidence_records','audit_events','workspace_job_intents'])assert.equal(count(sqlite,table),0,table);assert.equal(sqlite.prepare('SELECT revision FROM workspaces WHERE user_id=?').get('a')!.revision,1);}
const deps=(db:SqlDatabase,registry=handlers)=>({db,handlers:registry,now:()=>now});

test('one command commits document, owner module row, ordered audit event and durable job together',async()=>{
  const {db,sqlite}=await setup();const result=await executeWorkspaceCommand('a',input(),deps(db));
  assert.equal(result.status,'committed');
  assert.equal(result.envelope.workspace.projects[0].goal,'Changed together');assert.equal(result.receipt.appliedRevision,2);
  for(const table of ['workspace_mutations','evidence_records','audit_events','workspace_job_intents'])assert.equal(count(sqlite,table),1,table);
  assert.equal(count(sqlite,'workspace_command_guards'),0);assert.equal(count(sqlite,'workspace_assertions'),0);
  assert.deepEqual({...sqlite.prepare('SELECT workspace_revision,ordinal,stream_id FROM audit_events').get()},{workspace_revision:2,ordinal:0,stream_id:null});
  assert.equal((await readCurrent(db,'b')).revision,1);assert.equal(count(sqlite,'evidence_records','b'),0);
});

test('lost workspace CAS between preparation and batch leaves no receipt or module side effects',async()=>{
  const {db,sqlite}=await setup();const raced=intercept(db,()=>{sqlite.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').run('a');});
  assert.deepEqual(await executeWorkspaceCommand('a',input(),deps(raced)),{status:'conflict',currentRevision:2});
  for(const table of ['workspace_mutations','workspace_command_guards','workspace_assertions','evidence_records','audit_events','workspace_job_intents'])assert.equal(count(sqlite,table),0,table);
});

for(const mismatch of ['row-revision','content-hash','missing-row'] as const)test(`module source precondition ${mismatch} aborts all effects`,async()=>{
  const {db,sqlite}=await setup();sqlite.prepare('INSERT INTO decisions (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run('a','source',1,'{}',fixtureHash({}));
  const registry:CommandHandlerRegistry=new Map([['fixture.change',{prepare:async context=>({...plan(context),preconditions:[{table:'decisions',id:'source',expectedRowRevision:1,expectedHash:fixtureHash({})}]})}]]);
  const raced=intercept(db,()=>{if(mismatch==='missing-row')sqlite.prepare('DELETE FROM decisions WHERE user_id=?').run('a');else sqlite.prepare(`UPDATE decisions SET ${mismatch==='row-revision'?'row_revision=2':"content_hash='new'"} WHERE user_id=?`).run('a');});
  await assert.rejects(executeWorkspaceCommand('a',input(),deps(raced,registry)),ModuleConflictError);assertClean(sqlite);
});

for(const operation of ['insert','update','delete'] as const)test(`module ${operation} lost CAS rolls back receipt and planning`,async()=>{
  const {db,sqlite}=await setup();if(operation!=='insert')sqlite.prepare('INSERT INTO evidence_records (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run('a','record',1,'{}',fixtureHash({}));
  const registry:CommandHandlerRegistry=new Map([['fixture.change',{prepare:async context=>({...plan(context),writes:[{table:'evidence_records',id:'record',operation,value:{text:'replacement'},expectedRowRevision:operation==='insert'?null:1}]})}]]);
  const raced=intercept(db,()=>{if(operation==='insert')sqlite.prepare('INSERT INTO evidence_records (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run('a','record',1,'{}','racer');else sqlite.prepare('UPDATE evidence_records SET row_revision=2 WHERE user_id=?').run('a');});
  await assert.rejects(executeWorkspaceCommand('a',input(),deps(raced,registry)),ModuleConflictError);
  for(const table of ['workspace_mutations','workspace_command_guards','workspace_assertions','audit_events','workspace_job_intents'])assert.equal(count(sqlite,table),0,table);
  assert.equal((await readCurrent(db,'a')).revision,1);assert.equal(count(sqlite,'evidence_records'),1);
});

for(const [operation,table] of [['INSERT','workspace_command_guards'],['INSERT','workspace_assertions'],['INSERT','workspace_mutations'],['INSERT','workspace_backups'],['INSERT','evidence_records'],['INSERT','audit_events'],['INSERT','workspace_job_intents'],['UPDATE','workspaces'],['DELETE','workspace_assertions'],['DELETE','workspace_command_guards']] as const)test(`SQL failure at ${operation} ${table} rolls back the complete command`,async()=>{
  const {db,sqlite}=await setup();
  // A backup exercises the snapshot statement as well as every ordinary side effect.
  const registry:CommandHandlerRegistry=new Map([['fixture.change',{prepare:async context=>({...plan(context),backup:{reason:'repair'}})}]]);
  sqlite.exec(`CREATE TRIGGER fixture_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;`);
  await assert.rejects(executeWorkspaceCommand('a',input(),deps(db,registry)),WorkspaceStorageError);assertClean(sqlite);
});

test('owner scoped get, pages, preconditions and row updates never borrow foreign records',async()=>{
  const {db,sqlite}=await setup();sqlite.prepare('INSERT INTO evidence_records (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run('b','foreign',1,'{}',fixtureHash({}));
  const reader=ownerReader(db,'a');assert.equal(await reader.get('evidence_records','foreign'),null);assert.deepEqual(await reader.list('evidence_records'),[]);
  const registry:CommandHandlerRegistry=new Map([['fixture.change',{prepare:async context=>({...plan(context),writes:[{table:'evidence_records',id:'foreign',operation:'update',value:{text:'forbidden'},expectedRowRevision:1}]})}]]);
  await assert.rejects(executeWorkspaceCommand('a',input(),deps(db,registry)),ModuleConflictError);assertClean(sqlite);assert.equal(count(sqlite,'evidence_records','b'),1);
  const result=await executeWorkspaceCommand('b',input(),deps(db));assert.equal(result.status,'committed');
  assert.equal(count(sqlite,'workspace_mutations','a'),0);assert.equal(count(sqlite,'workspace_mutations','b'),1);
});

test('replay after a later edit returns current state and original applied revision without repeating effects',async()=>{
  const {db,sqlite}=await setup();await executeWorkspaceCommand('a',input(),deps(db));
  await executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:2,mutationId:'later-mutation-0001',command:{type:'project.update',id:(await readCurrent(db,'a')).workspace.projects[0].id,patch:{goal:'Later goal'}}},deps(db,workspaceHandlers));
  const result=await executeWorkspaceCommand('a',input(),deps(db));assert.equal(result.status,'replayed');
  assert.equal(result.receipt.appliedRevision,2);assert.equal(result.envelope.revision,3);assert.equal(result.envelope.workspace.projects[0].goal,'Later goal');
  assert.equal(count(sqlite,'evidence_records'),1);assert.equal(count(sqlite,'workspace_job_intents'),1);
});

test('legacy command-only receipt replays without requiring a currently registered handler',async()=>{
  const {db,sqlite}=await setup();const legacyHash=await hashJson(command);sqlite.prepare('INSERT INTO workspace_mutations VALUES (?,?,?,?,?)').run('a',id,legacyHash,1,now);
  const result=await executeWorkspaceCommand('a',input(),deps(db,new Map()));assert.equal(result.status,'replayed');assert.equal(result.receipt.commandHash,legacyHash);assert.equal(count(sqlite,'evidence_records'),0);
});

for(const sameHash of [false,true])test(`racing receipt with ${sameHash?'same':'different'} command hash never applies prepared side effects`,async()=>{
  const {db,sqlite}=await setup();const hash=await hashJson(sameHash?{protocolVersion:1,command}:{protocolVersion:1,command:{type:'other'}});
  const raced=intercept(db,()=>{sqlite.prepare('INSERT INTO workspace_mutations VALUES (?,?,?,?,?)').run('a',id,hash,2,now);sqlite.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').run('a');});
  if(sameHash){const result=await executeWorkspaceCommand('a',input(),deps(raced));assert.equal(result.status,'replayed');}else await assert.rejects(executeWorkspaceCommand('a',input(),deps(raced)),MutationIdReuseError);
  for(const table of ['workspace_command_guards','workspace_assertions','evidence_records','audit_events','workspace_job_intents'])assert.equal(count(sqlite,table),0,table);
});

async function seedRestoreModule(sqlite:ReturnType<typeof database>['sqlite'],table:typeof OWNER_TABLES[number]):Promise<void>{
 const currentPlanning=decodePlanning(String(sqlite.prepare('SELECT content FROM workspaces WHERE user_id=?').get('a')!.content),now);
 const subject={type:'task',id:currentPlanning.tasks[0].id};
 const head={id:'preserved',currentVersion:1,archivedAt:null};
 const add=(name:string,value:unknown,columns:string[]=[],values:(string|number|null)[]=[],rowId='preserved')=>sqlite.prepare(`INSERT INTO ${name} (user_id,id,row_revision,payload_json,content_hash${columns.length?','+columns.join(','):''}) VALUES (${Array.from({length:5+columns.length},()=>'?').join(',')})`).run('a',rowId,1,JSON.stringify(value),fixtureHash(value),...values);
 if(['review_snapshots','review_acknowledgements','automation_schedules','automation_occurrences','notification_events','review_settings','review_analysis_runs','project_baseline_revisions'].includes(table)){
  const projectId=currentPlanning.projects[0].id;
  const snapshot={id:table==='review_snapshots'?'preserved':'snapshot-parent',scope:{projectIds:[projectId],filterDigest:'a'.repeat(64)},workspaceRevision:1,operationalWatermarks:{sources:0},sourceWatermark:await hashJson([]),sourceSet:[],generatedAt:now,facts:[],unknowns:['Historical fixture: no current assessment claimed.'],decisionVersions:[],planningRecords:[],auditRecords:[],coverage:{complete:true,remainingFacts:0,includedFactIds:[],includedEventIds:[]},modelRunId:null};
  const snapshotHash=await hashJson(snapshot);
  const schedule={id:table==='automation_schedules'?'preserved':'schedule-parent',kind:'daily_review',timezone:'Africa/Cairo',enabled:true,configurationVersion:1,recurrence:{frequency:'daily',localTime:'03:00'},sourceId:null,projectIds:[projectId],catchUp:'latest_only',createdAt:now,updatedAt:now,archivedAt:null};
  const values:Partial<Record<typeof OWNER_TABLES[number],unknown>>={project_baseline_revisions:{id:'preserved',projectId,parent:{kind:'initial',projectHash:await hashJson(currentPlanning.projects[0])},recordedAt:now,reviewedAsOf:now,snapshotRef:{id:snapshot.id,hash:snapshotHash},summary:'Preserved historical project context',accomplishments:[],blockers:[],unknowns:['Current source freshness is unknown.'],ownerReason:'Preserve reviewed owner context',observationRefs:[],evidenceRefs:[],decisionRefs:[],sourceWatermark:await hashJson([]),sourceFreshness:'historical-or-unknown'},review_snapshots:snapshot,review_acknowledgements:{id:'preserved',snapshotId:snapshot.id,snapshotHash,scope:snapshot.scope,acknowledgedAt:now,coveredFactIds:[],coveredEventIds:[]},automation_schedules:schedule,automation_occurrences:{id:'preserved',scheduleId:schedule.id,dueAt:now,kind:'daily_review',configurationHash:await hashJson(schedule),startedAt:now,finishedAt:now,outcome:'success',failure:null,missedPeriods:0,resultRef:{kind:'review',id:snapshot.id,hash:snapshotHash}},notification_events:{id:'preserved',dedupKey:'a'.repeat(64),kind:'blocker',severity:'warning',projectId,sourceId:null,title:'Retained historical notification',body:'Owner must review current context.',href:'/?view=review',createdAt:now,factIds:[],snapshotRef:{id:snapshot.id,hash:snapshotHash},observationRefs:[],evidenceRefs:[]},review_settings:{id:'analysis',enabled:false,provider:null,model:null,maxCostDollars:null,maxInputBytes:1000,maxOutputTokens:100,timeoutMs:1000},review_analysis_runs:{id:'preserved',snapshotId:snapshot.id,snapshotHash,provider:'synthetic',model:'fixture',inputDigest:'a'.repeat(64),status:'completed',startedAt:now,finishedAt:now,usage:{inputTokens:null,outputTokens:null,costDollars:null},suggestions:[],diagnostic:null}};
  const insert=async(name:typeof OWNER_TABLES[number])=>{const value=values[name] as {id:string},columns=moduleColumnNames(name),projection=await moduleProjection(name,value.id,value as unknown as JsonValue);add(name,value,[...columns],columns.map(c=>projection[c]),value.id);sqlite.prepare(`UPDATE ${name} SET content_hash=? WHERE user_id='a' AND id=?`).run(await hashJson(value as unknown as JsonValue),value.id);};
  if(['review_acknowledgements','automation_occurrences','notification_events','review_analysis_runs','project_baseline_revisions'].includes(table))await insert('review_snapshots');
  if(table==='automation_occurrences')await insert('automation_schedules');
  await insert(table);return;
 }
 if(table.startsWith('source_')||table==='integration_history'){
  const connection={id:'connection',provider:'github',label:'Retained selected source',accessMode:'interactive',enabled:true,archivedAt:null};
  const target={id:'source',connectionId:'connection',projectId:currentPlanning.projects[0].id,kind:'github_repository',providerResourceId:'synthetic/repo',canonicalUrl:null,selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null};
  const observation={id:'observation',sourceId:'source',externalId:'readme',sourceRevision:'revision',sourceUpdatedAt:null,observedAt:now,title:'Preserved source',canonicalUrl:null,contentDigest:'a'.repeat(64),payload:{excerpt:'Retain this'},origin:'historical-import'};
  const values:Partial<Record<typeof OWNER_TABLES[number],unknown>>={source_connections:connection,source_targets:target,source_observations:observation,source_sync_runs:{id:'preserved',sourceId:'source',startedAt:now,finishedAt:now,outcome:'success',pages:1,observations:1,failure:null,retryAt:null,sourceRevision:'revision'},source_proposals:{id:'preserved',sourceId:'source',observationRefs:[{id:observation.id,contentDigest:observation.contentDigest}],evidenceRefs:[],entity:{kind:'project',id:target.projectId},baseWorkspaceRevision:1,fields:[{field:'summary',before:'',after:'Proposal'}],rationale:'Retain proposal',confidence:'direct-source',createdAt:now,state:'pending',dedupKey:'a'.repeat(64),decision:null},integration_history:{id:'preserved',sourceId:'source',kind:'source_refresh',attempt:1,startedAt:now,finishedAt:now,outcome:'success',failure:null}};
  const insert=async(name:typeof OWNER_TABLES[number])=>{const value=values[name] as {id:string},columns=moduleColumnNames(name),projection=await moduleProjection(name,value.id,value as unknown as JsonValue);add(name,value,[...columns],columns.map(c=>projection[c]),value.id);sqlite.prepare(`UPDATE ${name} SET content_hash=? WHERE user_id='a' AND id=?`).run(await hashJson(value as unknown as JsonValue),value.id);};
  await insert('source_connections');if(table==='source_connections')return;
  await insert('source_targets');if(table==='source_targets')return;
  if(table==='source_proposals')await insert('source_observations');
  await insert(table);return;
 }
 if(table==='evidence_versions'){
  add('evidence_records',head,['current_version'],[1]);
  add(table,{id:'preserved',version:1,basis:'owner-statement',scope:'implementation',title:'Synthetic preserved evidence',statement:'Original content retained',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null},['evidence_id','version','recorded_at'],['preserved',1,now],await versionRowId('preserved',1));return;
 }
 if(table==='decision_records'){add(table,head,['current_version'],[1]);return;}
 if(table==='decision_versions'){
  add('decision_records',head,['current_version'],[1]);
  add(table,{id:'preserved',version:1,title:'Synthetic draft decision',question:'Retain the original?',options:[],selectedOptionId:null,rationale:'',status:'draft',decidedAt:null,reviewOn:null,subjects:[],evidenceRefs:[],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null,supersedesVersion:null,recordedAt:now,exception:null},['decision_id','version','recorded_at','status'],['preserved',1,now,'draft'],await versionRowId('preserved',1));return;
 }
 if(table==='evidence_requirements'){add(table,{id:'preserved',subject,label:'Retained requirement',scope:'implementation',required:true,maxAgeDays:null,candidate:null,requireAttachment:false,archivedAt:null},['subject_type','subject_id','label','scope','required','require_attachment'],[subject.type,subject.id,'Retained requirement','implementation',1,0]);return;}
 if(table==='acceptance_records'){add(table,{id:'preserved',subject,decision:'needs-review',statement:'Retained review',candidate:null,criteriaHash:'a'.repeat(64),evidenceRefs:[],recordedAt:now,supersedesId:null,exceptions:[]},['subject_type','subject_id','decision','statement','criteria_hash','evidence_refs_json','recorded_at'],[subject.type,subject.id,'needs-review','Retained review','a'.repeat(64),'[]',now]);return;}
 if(table==='evidence_mappings'){add(table,{subject,evidenceId:'preserved-evidence',sourceTextHash:'a'.repeat(64),evidenceVersion:1});return;}
 add(table,{});
}
for(const table of OWNER_TABLES)test(`planning restore refuses to omit ${table} data`,async()=>{
  const {db,sqlite}=await setup();await seedRestoreModule(sqlite,table);
  if(table==='project_baseline_revisions'){const bundle=await exportWorkspaceBundle(db,'a',{now:()=>now});assert.equal(bundle.modules.project_baseline_revisions.records.length,1);assert.equal(bundle.modules.review_snapshots.records.length,1);}
  const originals=new Map(OWNER_TABLES.map(name=>[name,sqlite.prepare(`SELECT * FROM ${name} ORDER BY user_id,id`).all()]));
  await assert.rejects(executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:1,mutationId:id,command:{type:'workspace.restore',workspace:createSeedWorkspace(now)}},deps(db,workspaceHandlers)));
  assert.equal(count(sqlite,table),1);for(const name of OWNER_TABLES)assert.deepEqual(sqlite.prepare(`SELECT * FROM ${name} ORDER BY user_id,id`).all(),originals.get(name),name);for(const affected of ['workspace_mutations','workspace_recovery','audit_events','workspace_job_intents','workspace_command_guards','workspace_assertions'])assert.equal(count(sqlite,affected),0,affected);
  assert.equal((await readCurrent(db,'a')).revision,1);
});

test('module updates and deletes advance only their owner row revision inside shared command revision',async()=>{
  const {db,sqlite}=await setup();for(const owner of ['a','b'])sqlite.prepare('INSERT INTO evidence_records (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run(owner,'record',4,'{}',fixtureHash({}));
  const registry=(operation:'update'|'delete',expectedRowRevision:number):CommandHandlerRegistry=>new Map([['fixture.change',{prepare:async context=>({...plan(context),writes:[{table:'evidence_records',id:'record',operation,value:{text:'new'},expectedRowRevision}],events:[],jobs:[]})}]]);
  assert.equal((await executeWorkspaceCommand('a',input(),deps(db,registry('update',4)))).status,'committed');
  const changed=await ownerReader(db,'a').get('evidence_records','record');assert.equal(changed?.row_revision,5);assert.equal(changed?.content_hash,await hashJson({text:'new'}));
  assert.equal((await ownerReader(db,'b').get('evidence_records','record'))?.row_revision,4);
  assert.equal((await executeWorkspaceCommand('a',input('delete-mutation-0001',2),deps(db,registry('delete',5)))).status,'committed');
  assert.equal(await ownerReader(db,'a').get('evidence_records','record'),null);assert.equal((await readCurrent(db,'a')).revision,3);
  assert.equal((await ownerReader(db,'b').get('evidence_records','record'))?.row_revision,4);
});

for(const field of ['actorId','origin','occurredAt'] as const)test(`untrusted event ${field} cannot obtain owner authority`,async()=>{
  const {db,sqlite}=await setup();const registry:CommandHandlerRegistry=new Map([['fixture.change',{prepare:async context=>{const prepared=plan(context);Object.assign(prepared.events[0],{[field]:field==='origin'?'connector':field==='occurredAt'?'2026-10-18T11:00:00.000Z':'foreign'});return prepared;}}]]);
  await assert.rejects(executeWorkspaceCommand('a',input(),deps(db,registry)),/authority/);assertClean(sqlite);
});

for(const race of ['insert','update','delete'] as const)test(`complete normalized reference snapshot rejects ${race} race atomically`,async()=>{
 const {db,sqlite}=await setup();const hash=fixtureHash({});
 if(race!=='insert')sqlite.prepare('INSERT INTO decisions (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run('a','decision',1,'{}',hash);
 const snapshot={coveredModules:[...OWNER_TABLES],digest:'synthetic',rows:race==='insert'?[]:[{module:'decisions' as const,id:'decision',rowRevision:1,contentHash:hash,references:[]}]};
 const registry:CommandHandlerRegistry=new Map([['fixture.change',{prepare:async context=>({...plan(context),referenceSnapshot:snapshot})}]]);
 const raced=intercept(db,()=>{if(race==='insert')sqlite.prepare('INSERT INTO decisions (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run('a','decision',1,'{}',hash);else if(race==='update')sqlite.prepare('UPDATE decisions SET row_revision=2 WHERE user_id=?').run('a');else sqlite.prepare('DELETE FROM decisions WHERE user_id=?').run('a');});
 await assert.rejects(executeWorkspaceCommand('a',input(),deps(raced,registry)),ModuleConflictError);
 for(const table of ['workspace_mutations','workspace_command_guards','workspace_assertions','evidence_records','audit_events','workspace_job_intents'])assert.equal(count(sqlite,table),0,table);
 assert.equal((await readCurrent(db,'a')).revision,1);sqlite.close();
});
