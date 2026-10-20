import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {OWNER_TABLES,ownerReader} from '../lib/workspace-modules.ts';
import {stageImport} from '../lib/import-staging.ts';
import {criteriaHash} from '../lib/evidence-requirements.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {readWorkspaceBackup,listWorkspaceBackups} from '../lib/workspace-backups.ts';
import type {EvidenceRequirement} from '../lib/evidence-contract.ts';
const now='2026-10-18T12:00:00.000Z';let sequence=0;
const deps=(db:SqlDatabase)=>({db,handlers:workspaceHandlers,now:()=>now});
async function send(db:SqlDatabase,command:unknown,owner='a'){return executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:(await readCurrent(db,owner,now)).revision,mutationId:`normalized-merge-seed-${++sequence}`,command},deps(db));}
async function fixture(){
 const f=database();for(const owner of ['a','b'])await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);const before=await readCurrent(f.db,'a',now),subject={type:'project' as const,id:before.workspace.projects[0].id};await send(f.db,{type:'task.create',task:{projectId:subject.id,milestoneId:null,title:'Explicit accepted synthetic commitment',notes:'Fixture only',status:'todo',horizon:'next',priority:'normal',dueDate:null,weekly:false,dependsOn:[],blocker:'',sourceUrl:null,evidence:'',estimateMinutes:null}});const task=(await readCurrent(f.db,'a',now)).workspace.tasks.find(row=>row.title==='Explicit accepted synthetic commitment')!;assert.ok(task);
 await send(f.db,{type:'weekly.set',weekStart:'2030-02-04',capacityMinutes:120,taskIds:[task.id]});
 await send(f.db,{type:'evidence.create',value:{basis:'owner-statement',scope:'implementation',title:'Synthetic preserved evidence',statement:'Preserve exact source record',observedAt:now,candidate:null,environment:'Synthetic SQLite fixture',sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[]}});const evidence=(await ownerReader(f.db,'a').list('evidence_records'))[0];
 await send(f.db,{type:'evidence.requirement.create',value:{subject,label:'Preserved requirement',scope:'implementation',required:true,maxAgeDays:null,candidate:null,requireAttachment:false}});const requirement=JSON.parse((await ownerReader(f.db,'a').list('evidence_requirements'))[0].payload_json) as EvidenceRequirement;
 await send(f.db,{type:'evidence.link',value:{evidenceId:evidence.id,evidenceVersion:1,subject,requirementId:requirement.id,relation:'supports'}});
 await send(f.db,{type:'acceptance.record',value:{subject,decision:'accepted',statement:'Original explicit owner acceptance',candidate:null,criteriaHash:await criteriaHash(subject,[requirement]),evidenceRefs:[{id:evidence.id,version:1,requirementId:requirement.id,relation:'supports',historical:false}],supersedesId:null,exceptions:[]}});
 await send(f.db,{type:'decisions.create',value:{title:'Preserved owner decision',question:'Retain this choice?',options:[{id:'yes',label:'Yes',description:'Explicit owner choice'}],selectedOptionId:null,rationale:'',reviewOn:null,subjects:[subject],evidenceRefs:[{id:evidence.id,version:1}],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null}});const decision=(await ownerReader(f.db,'a').list('decision_records'))[0];await send(f.db,{type:'decisions.decide',id:decision.id,expectedVersion:1,choice:{selectedOptionId:'yes',rationale:'Existing owner authority remains independent of this planning merge'}});
 return {...f,subject,requirement};
}
async function stagedMerge(db:SqlDatabase){const before=await readCurrent(db,'a',now),incoming=structuredClone(before.workspace),id=`source-merge-proposal-${++sequence}`;incoming.tasks.push({...incoming.tasks[0],id,title:'Imported claim requires separate acceptance',status:'done',weekly:true,weeklyWeek:'2026-10-12',completedAt:now,archivedFromStatus:null,dependsOn:[],blocker:'',createdAt:now,updatedAt:now});const stage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(incoming)),now);assert.deepEqual(stage.diagnostics,[]);return {id,before,input:{protocolVersion:1,expectedRevision:before.revision,mutationId:`reviewed-planning-merge-${++sequence}`,command:{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:before.revision,mode:'merge',selection:{projects:[],milestones:[],tasks:[id],captures:[],activity:[]}}}};}
function normalized(sqlite:ReturnType<typeof database>['sqlite'],owner='a'){return Object.fromEntries([...OWNER_TABLES,'acceptance_owner_grants','decision_owner_grants'].map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY 1,2`).all(owner)]));}
function snapshot(sqlite:ReturnType<typeof database>['sqlite']){return {...normalized(sqlite),...Object.fromEntries(['workspaces','workspace_recovery','workspace_backups','workspace_mutations','audit_events','audit_project_links','audit_import_identities','workspace_execution_state','workspace_job_intents','workspace_assertions','workspace_command_guards'].map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY 1,2`).all('a')]))};}

test('reviewed planning-only merge preserves all normalized records and live owner grants byte exactly',async()=>{
 const {db,sqlite}=await fixture();try{const staged=await stagedMerge(db),original=normalized(sqlite),foreign=normalized(sqlite,'b');assert.equal(original.acceptance_owner_grants.length,1);assert.equal(original.decision_owner_grants.length,1);const result=await executeWorkspaceCommand('a',staged.input,deps(db));assert.equal(result.status,'committed');assert.deepEqual(normalized(sqlite),original);assert.deepEqual(normalized(sqlite,'b'),foreign);const after=await readCurrent(db,'a',now),created=after.workspace.tasks.find(row=>row.id===staged.id)!;assert.equal(after.revision,staged.before.revision+1);assert.equal(created.status,'proposed');assert.equal(created.weekly,false);assert.equal(created.weeklyWeek,null);assert.equal(created.completedAt,null);assert.deepEqual(after.workspace.tasks.filter(row=>row.id!==staged.id),staged.before.workspace.tasks);
 const backups=await listWorkspaceBackups(db,'a');assert.equal(backups.length,1);const recovery=await readWorkspaceBackup(db,'a',backups[0].id);assert.deepEqual(recovery!.bundle.planning,staged.before.workspace);assert.ok(recovery!.bundle.modules.evidence.records.length>0);assert.ok(recovery!.bundle.modules.decisions.records.length>0);assert.ok(recovery!.bundle.modules.weekly_plans.records.length>0);
 const committed=snapshot(sqlite);assert.equal((await executeWorkspaceCommand('a',staged.input,deps(db))).status,'replayed');assert.deepEqual(snapshot(sqlite),committed);
 }finally{sqlite.close();}
});

for(const race of ['existing-row-update','new-reference-row','previously-empty-module'] as const)test(`planning merge full normalized snapshot rejects ${race} between preparation and batch`,async()=>{
 const {db,sqlite,requirement}=await fixture();try{const {id,input}=await stagedMerge(db);let injected=false,afterRace:ReturnType<typeof snapshot>|undefined;
 const raced:SqlDatabase={...db,async batch(statements){assert.equal(injected,false);injected=true;
  if(race==='existing-row-update'){const value={...requirement,label:'A concurrent owner edit'};sqlite.prepare('UPDATE evidence_requirements SET payload_json=?,content_hash=?,row_revision=row_revision+1,label=? WHERE user_id=? AND id=?').run(JSON.stringify(value),await contentHash(canonical(value)),value.label,'a',requirement.id);}
  else if(race==='new-reference-row'){const value={...requirement,id:'late-requirement',label:'Late normalized reference'};sqlite.prepare('INSERT INTO evidence_requirements(user_id,id,row_revision,payload_json,content_hash,subject_type,subject_id,label,scope,required,require_attachment) VALUES(?,?,1,?,?,?,?,?,?,1,0)').run('a',value.id,JSON.stringify(value),await contentHash(canonical(value)),value.subject.type,value.subject.id,value.label,value.scope);}
  else {const value={configuration:'A late row in a previously empty module'};sqlite.prepare('INSERT INTO workspace_configuration(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('a','late-configuration',JSON.stringify(value),await contentHash(canonical(value)));}
  afterRace=snapshot(sqlite);return db.batch(statements);
 }};await assert.rejects(executeWorkspaceCommand('a',input,deps(raced)));assert.equal(injected,true);assert.deepEqual(snapshot(sqlite),afterRace);assert.equal((await readCurrent(db,'a',now)).workspace.tasks.some(row=>row.id===id),false);
 }finally{sqlite.close();}
});
