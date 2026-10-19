import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/sqlite.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { loadWorkspace,readCurrent,type SqlDatabase } from '../lib/workspace-store.ts';
import { executeWorkspaceCommand,type MutationPlan,type PrepareContext,type CommandHandlerRegistry } from '../lib/workspace-transaction.ts';
import { ownerReader,type GuardedWrite } from '../lib/workspace-modules.ts';
import { moduleProjection,moduleColumnNames } from '../lib/module-columns.ts';
import { versionRowId } from '../lib/version-identity.ts';
import { exportRegistry,moduleTables,ownerExportModule } from '../lib/workspace-export.ts';
import { CommandValidationError,ModuleConflictError } from '../lib/workspace-errors.ts';
import type { JsonValue } from '../lib/workspace-protocol.ts';
const now='2026-10-18T12:00:00.000Z';let sequence=0;
const json=(value:unknown)=>value as JsonValue;
const head=(id:string,currentVersion=1)=>({id,currentVersion,archivedAt:null});
const evidence=(id:string,version=1)=>({id,version,basis:'owner-statement',scope:'implementation',title:'Synthetic evidence',statement:'Immutable original evidence',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:version===1?null:version-1});
const decision=(id:string)=>({id,version:1,title:'Synthetic decision',question:'Keep the record?',options:[],selectedOptionId:null,rationale:'',status:'draft',decidedAt:null,reviewOn:null,subjects:[],evidenceRefs:[],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null,supersedesVersion:null,recordedAt:now,exception:null});
async function fixture(){const f=database();f.sqlite.exec('PRAGMA foreign_keys=ON');assert.equal(f.sqlite.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);await loadWorkspace(f.db,'a',()=>createSeedWorkspace(now),now);await loadWorkspace(f.db,'b',()=>createSeedWorkspace(now),now);return f;}
function plan(context:PrepareContext,writes:GuardedWrite[]):MutationPlan{return {planningAfter:context.before.workspace,writes,jobs:[],events:[{id:`synthetic-audit-${++sequence}`,kind:context.command.type,entityType:'evidence',entityId:'logical-evidence',changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:'a'.repeat(64),undoOf:'prior-synthetic-event'}]};}
async function execute(db:SqlDatabase,owner:string,prepare:(context:PrepareContext)=>Promise<MutationPlan>|MutationPlan,revision?:number){const registry:CommandHandlerRegistry=new Map([['fixture.evidence',{prepare:async context=>prepare(context)}]]);return executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:revision??(await readCurrent(db,owner,now)).revision,mutationId:`evidence-txn-${String(++sequence).padStart(12,'0')}`,command:{type:'fixture.evidence'}},{db,now:()=>now,handlers:registry});}
async function pair(id:string):Promise<GuardedWrite[]>{return [{table:'evidence_versions',operation:'insert',id:await versionRowId(id,1),value:json(evidence(id)),expectedRowRevision:null},{table:'evidence_records',operation:'insert',id,value:head(id),expectedRowRevision:null}];}
function rows(f:Awaited<ReturnType<typeof fixture>>,table:string,owner='a'){return f.sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY ${table==='audit_events'?'event_id':table==='audit_project_links'?'event_id,project_id':'id'}`).all(owner);}
function state(f:Awaited<ReturnType<typeof fixture>>){return Object.fromEntries(['workspaces','evidence_records','evidence_versions','decision_records','decision_versions','acceptance_records','audit_events','audit_project_links','workspace_mutations','workspace_backups'].map(table=>[table,table==='workspaces'||table==='workspace_mutations'?f.sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY ${table==='workspaces'?'user_id':'mutation_id'}`).all('a'):rows(f,table)]));}
async function committedPair(f:Awaited<ReturnType<typeof fixture>>,id='logical-evidence'){const writes=await pair(id);assert.equal((await execute(f.db,'a',ctx=>plan(ctx,writes))).status,'committed');return id;}

function intercept(db:import('../lib/workspace-store.ts').SqlDatabase,hook:()=>Promise<void>|void):import('../lib/workspace-store.ts').SqlDatabase {
 let fired=false;const prepare=db.prepare.bind(db),batch=db.batch.bind(db),sqlByStatement=new WeakMap<import('../lib/workspace-store.ts').SqlStatement,string>();
 return {prepare(sql){const statement=prepare(sql);sqlByStatement.set(statement,sql);return statement;},async batch(statements){
  if(!fired&&statements.some(statement=>sqlByStatement.get(statement)?.startsWith('INSERT INTO workspace_command_guards'))){fired=true;await hook();}
  return batch(statements);
 }};
}

test('central compiler commits typed parent/version in FK order with exact projections and owner isolation',async()=>{
 const f=await fixture();try{const id=await committedPair(f),physical=await versionRowId(id,1);for(const [table,rowId,value] of [['evidence_records',id,head(id)],['evidence_versions',physical,evidence(id)]] as const){const stored=f.sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? AND id=?`).get('a',rowId)!;const expected=await moduleProjection(table,rowId,json(value));for(const key of moduleColumnNames(table))assert.equal(stored[key],expected[key]);assert.deepEqual(JSON.parse(stored.payload_json as string),value);}
 assert.equal(await ownerReader(f.db,'b').get('evidence_records',id),null);const before=state(f);
 await assert.rejects(execute(f.db,'b',ctx=>plan(ctx,[{table:'evidence_records',operation:'update',id,value:head(id,2),expectedRowRevision:1}])),ModuleConflictError);assert.deepEqual(state(f),before);
 assert.equal((await execute(f.db,'b',ctx=>plan(ctx,[]))).status,'committed');assert.equal((await readCurrent(f.db,'a',now)).revision,2);
 }finally{f.sqlite.close();}
});

for(const table of ['evidence_versions','decision_versions','acceptance_records'] as const)for(const operation of ['update','delete'] as const)test(`immutable ${table} ${operation} rejects without receipt, event or revision change`,async()=>{
 const f=await fixture();try{
 let rowId:string,value:JsonValue;
 if(table==='evidence_versions'){const id=await committedPair(f);rowId=await versionRowId(id,1);value=json(evidence(id));}
 else if(table==='decision_versions'){const id='immutable-decision';rowId=await versionRowId(id,1);value=json(decision(id));await execute(f.db,'a',ctx=>plan(ctx,[{table:'decision_records',operation:'insert',id,value:head(id),expectedRowRevision:null},{table,operation:'insert',id:rowId,value,expectedRowRevision:null}]));}
 else{rowId='immutable-acceptance';value={id:rowId,subject:{type:'task',id:(await readCurrent(f.db,'a',now)).workspace.tasks[0].id},decision:'needs-review',statement:'Immutable review record',candidate:null,criteriaHash:'b'.repeat(64),evidenceRefs:[],recordedAt:now,supersedesId:null,exceptions:[]};await execute(f.db,'a',ctx=>plan(ctx,[{table,operation:'insert',id:rowId,value,expectedRowRevision:null}]));}
 const before=state(f);await assert.rejects(execute(f.db,'a',ctx=>plan(ctx,[{table,operation,id:rowId,expectedRowRevision:1,...(operation==='update'?{value}:{})}])),CommandValidationError);assert.deepEqual(state(f),before);
 }finally{f.sqlite.close();}
});

test('duplicate version assertion rolls back an otherwise valid head update and every side effect',async()=>{
 const f=await fixture();try{const id=await committedPair(f),before=state(f),versionId=await versionRowId(id,1);await assert.rejects(execute(f.db,'a',ctx=>plan(ctx,[{table:'evidence_records',operation:'update',id,value:head(id,2),expectedRowRevision:1},{table:'evidence_versions',operation:'insert',id:versionId,value:json(evidence(id)),expectedRowRevision:null}])),ModuleConflictError);assert.deepEqual(state(f),before);
 }finally{f.sqlite.close();}
});

test('head row CAS lost between prepare and batch cannot append the prepared new version',async()=>{
 const f=await fixture();try{const id=await committedPair(f),versionId=await versionRowId(id,2);let racedState:ReturnType<typeof state>|undefined;
 const raced=intercept(f.db,()=>{f.sqlite.prepare('UPDATE evidence_records SET row_revision=row_revision+1 WHERE user_id=? AND id=?').run('a',id);racedState=state(f);});
 await assert.rejects(execute(raced,'a',ctx=>plan(ctx,[{table:'evidence_records',operation:'update',id,value:head(id,2),expectedRowRevision:1},{table:'evidence_versions',operation:'insert',id:versionId,value:json(evidence(id,2)),expectedRowRevision:null}])),ModuleConflictError);assert.deepEqual(state(f),racedState);assert.equal(await ownerReader(f.db,'a').get('evidence_versions',versionId),null);
 }finally{f.sqlite.close();}
});

// Test-only adapters expose synthetic typed rows to the real pre-restore backup compiler.
const restoreTables=['evidence_records','evidence_versions','decision_records','decision_versions'] as const;
for(const table of restoreTables)if(!exportRegistry.entries().some(adapter=>moduleTables(adapter).includes(table)))exportRegistry.register(ownerExportModule(table,()=>{}));
test('reviewed full restore deletes version children before heads and inserts parents before versions under enabled foreign keys',async()=>{
 const f=await fixture();try{const oldEvidence='old-evidence',oldDecision='old-decision',newEvidence='new-evidence',newDecision='new-decision';const evidenceWrites=await pair(oldEvidence);const decisionPhysical=await versionRowId(oldDecision,1);
 await execute(f.db,'a',ctx=>plan(ctx,[...evidenceWrites,{table:'decision_versions',operation:'insert',id:decisionPhysical,value:json(decision(oldDecision)),expectedRowRevision:null},{table:'decision_records',operation:'insert',id:oldDecision,value:head(oldDecision),expectedRowRevision:null}]));
 const other=await pair(oldEvidence);await execute(f.db,'b',ctx=>plan(ctx,other));const foreignBefore=rows(f,'evidence_versions','b');
 const newEvidencePhysical=await versionRowId(newEvidence,1),newDecisionPhysical=await versionRowId(newDecision,1);const reader=ownerReader(f.db,'a');
 const result=await execute(f.db,'a',async ctx=>({...plan(ctx,[]),backup:{reason:'restore'},restoreEpoch:true,replacements:await Promise.all([
  {table:'decision_versions' as const,records:[{id:newDecisionPhysical,value:json(decision(newDecision))}]},
  {table:'evidence_versions' as const,records:[{id:newEvidencePhysical,value:json(evidence(newEvidence))}]},
  {table:'decision_records' as const,records:[{id:newDecision,value:head(newDecision)}]},
  {table:'evidence_records' as const,records:[{id:newEvidence,value:head(newEvidence)}]},
 ].map(async replacement=>({...replacement,beforeRows:await reader.list(replacement.table)})))}));
 assert.equal(result.status,'committed');assert.equal(f.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(await reader.get('evidence_records',oldEvidence),null);assert.equal(await reader.get('decision_records',oldDecision),null);assert.ok(await reader.get('evidence_versions',newEvidencePhysical));assert.ok(await reader.get('decision_versions',newDecisionPhysical));assert.deepEqual(rows(f,'evidence_versions','b'),foreignBefore);assert.equal(rows(f,'workspace_backups').length,1);
 const backup=JSON.parse(rows(f,'workspace_backups')[0].content as string),backedUp=JSON.stringify(backup.modules);assert.ok(backedUp.includes(oldEvidence));assert.ok(backedUp.includes('Immutable original evidence'));assert.ok(backedUp.includes(oldDecision));assert.ok(backedUp.includes('Keep the record?'));
 const beforeFailure=state(f),epochBefore=f.sqlite.prepare('SELECT * FROM workspace_execution_state WHERE user_id=?').get('a');
 f.sqlite.exec("CREATE TRIGGER synthetic_restore_failure BEFORE INSERT ON evidence_versions BEGIN SELECT RAISE(ABORT,'synthetic typed restore failure'); END;");
 await assert.rejects(execute(f.db,'a',async ctx=>({...plan(ctx,[]),backup:{reason:'restore'},restoreEpoch:true,replacements:await Promise.all(restoreTables.map(async table=>({table,beforeRows:await reader.list(table),records:(await reader.list(table)).map(row=>({id:row.id,value:JSON.parse(row.payload_json) as JsonValue}))})))})));
 assert.deepEqual(state(f),beforeFailure);assert.deepEqual(f.sqlite.prepare('SELECT * FROM workspace_execution_state WHERE user_id=?').get('a'),epochBefore);assert.equal(f.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);

 }finally{f.sqlite.close();}
});

test('audit metadata mirrors source authority and immutable project scopes retain both sides of a later-moved task',async()=>{
 const f=await fixture();try{const initial=(await readCurrent(f.db,'a',now)).workspace,task=initial.tasks[0],oldProject=task.projectId,newProject=initial.projects.find(project=>project.id!==oldProject)!.id;
 const result=await execute(f.db,'a',ctx=>{const output=plan(ctx,[]);output.planningAfter=structuredClone(ctx.before.workspace);const before=structuredClone(output.planningAfter.tasks[0]);output.planningAfter.tasks[0].projectId=newProject;output.planningAfter.tasks[0].milestoneId=null;output.events[0]={...output.events[0],entityType:'task',entityId:task.id,changes:[{path:['tasks',task.id],before:{exists:true,value:json(before)},after:{exists:true,value:json(output.planningAfter.tasks[0])}}]};return output;});assert.equal(result.status,'committed');
 const event=rows(f,'audit_events')[0],payload=JSON.parse(event.payload_json as string);assert.deepEqual([event.origin,event.actor_id,event.source_ref,event.undo_of],['owner','a','a'.repeat(64),'prior-synthetic-event']);assert.equal(payload.actorId,event.actor_id);const scopes=rows(f,'audit_project_links');assert.deepEqual(scopes.map(row=>row.project_id).sort(),[oldProject,newProject].sort());
 await execute(f.db,'a',ctx=>{const output=plan(ctx,[]);output.planningAfter=structuredClone(ctx.before.workspace);output.planningAfter.projects.push({...output.planningAfter.projects[0],id:'synthetic-third',name:'Third synthetic project'});output.planningAfter.tasks[0].projectId='synthetic-third';output.events=[];return output;});
 assert.deepEqual(rows(f,'audit_project_links'),scopes);assert.equal(rows(f,'audit_events')[0].payload_json,event.payload_json);assert.deepEqual(rows(f,'audit_project_links','b'),[]);
 }finally{f.sqlite.close();}
});
