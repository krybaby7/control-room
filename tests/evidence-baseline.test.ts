import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareBaselineEvidence, baselineEvidenceSourceId } from '../lib/evidence-baseline.ts';
import { PROJECT_BASELINES, BASELINE_ID, baselineRecordId, applyProjectBaseline } from '../lib/project-baselines.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { projectFixture, taskFixture } from './helpers/workspace.ts';
import { canonical, contentHash } from '../lib/canonical-json.ts';
import { versionRowId } from '../lib/version-identity.ts';
import type { PrepareContext } from '../lib/workspace-transaction.ts';
import type { ModuleRow, RegisteredOwnerTable, GuardedWrite } from '../lib/workspace-modules.ts';
import type { EvidenceVersion, EvidenceLink } from '../lib/evidence-contract.ts';
const now='2026-10-18T12:00:00.000Z';
function fixture(key:'tamenni'|'trade-graph'='tamenni') {
 const baseline=PROJECT_BASELINES.find(row=>row.key===key)!;
 const before=createSeedWorkspace(now);before.projects=[projectFixture({id:'baseline-owner-project',repositories:[{name:'Synthetic repository',url:`https://github.com/${baseline.repositories[0]}`} ]})];before.tasks=[];before.milestones=[];before.captures=[];
 const after=applyProjectBaseline(before,before.projects[0].id,BASELINE_ID,now);
 const rows=new Map<string,ModuleRow>();
 const context:PrepareContext={userId:'synthetic-owner',now,before:{workspace:before,revision:1,updatedAt:now},command:{type:'baseline.apply',projectId:before.projects[0].id,baselineId:BASELINE_ID},query:{async get(table,id){return rows.get(`${table}:${id}`)??null;},async list(table,{after='',limit=100}={}){return [...rows.entries()].filter(([key])=>key.startsWith(`${table}:`)).map(([,row])=>row).filter(row=>row.id>after).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,limit);}},async readImport(){throw new Error('No import authority in pure helper fixture.');}};
 async function persist(writes:GuardedWrite[]){for(const write of writes){assert.equal(write.operation,'insert');const key=`${write.table}:${write.id}`;assert.equal(rows.has(key),false);rows.set(key,{id:write.id,row_revision:1,payload_json:JSON.stringify(write.value),content_hash:await contentHash(canonical(write.value))});}}
 async function replace(table:RegisteredOwnerTable,id:string,value:unknown){rows.set(`${table}:${id}`,{id,row_revision:2,payload_json:JSON.stringify(value),content_hash:await contentHash(canonical(value))});}
 return {baseline,before,after,context,rows,persist,replace};
}
test('explicit baseline produces dated categorized contextual evidence and stable typed mappings without planning effects',async()=>{
 for(const key of ['tamenni','trade-graph']as const){const f=fixture(key),original=structuredClone(f.before),after=structuredClone(f.after);
 const plan=await prepareBaselineEvidence(f.context,f.after);
 const versions=plan.writes.filter(row=>row.table==='evidence_versions').map(row=>row.value as unknown as EvidenceVersion);
 assert.equal(versions.length,f.baseline.sources.length);assert.equal(plan.writes.filter(row=>row.table==='evidence_records').length,versions.length);
 const expectedIds=await Promise.all(f.baseline.sources.map(source=>baselineEvidenceSourceId(f.baseline,source)));
 for(const [index,source]of f.baseline.sources.entries()){const version=versions.find(row=>row.id===expectedIds[index])!;
 assert.equal(version.basis,source.basis==='observed'?'observed-artifact':source.basis==='documented'?'documented-result':'owner-statement');
 assert.equal(version.observedAt,null);assert.equal(version.recordedAt,now);assert.equal(version.candidate,null);assert.equal(version.environment,null);assert.equal(version.sourceUrl,source.url??null);assert.equal(version.sourceRevision,source.revision??null);
 assert.ok(version.statement.includes(source.summary));assert.ok(version.statement.includes(source.date));assert.match(version.statement,/Context only/);
 if(!source.url)assert.match(version.statement,/local document label/);
 if(['software','ci'].includes(source.id))assert.equal(version.scope,'software-verification');
 if(['scale','economics','scorecard'].includes(source.id))assert.equal(version.scope,'economics');
 }
 const links=plan.writes.filter(row=>row.table==='evidence_links').map(row=>row.value as unknown as EvidenceLink);
 assert.ok(links.some(row=>row.subject.type==='project'));assert.ok(links.some(row=>row.subject.type==='task'));assert.ok(links.every(row=>row.relation==='context'&&row.requirementId===null&&row.evidenceVersion===1));
 assert.ok(plan.events.every(row=>row.origin==='owner'&&row.sourceRef?.includes(`baseline:${BASELINE_ID}:${key}:`)&&row.occurredAt===now));
 assert.ok(plan.writes.every(row=>!['acceptance_records','decisions','decision_versions'].includes(row.table)));
 assert.deepEqual(f.before,original);assert.deepEqual(f.after,after);assert.ok(f.after.tasks.every(row=>row.status==='proposed'&&!row.weekly&&row.weeklyWeek===null&&row.completedAt===null));
 }
});
test('deterministic replay and restored records keep original source times, revisions, moves and unlinks',async()=>{
 const f=fixture(),first=await prepareBaselineEvidence(f.context,f.after);await f.persist(first.writes);
 const task=f.after.tasks[0];task.projectId='moved-project';task.status='done';task.completedAt=now;task.evidence='Owner completion retained';
 const source=f.baseline.sources[0],id=await baselineEvidenceSourceId(f.baseline,source),physical=await versionRowId(id,1);
 const originalVersion=JSON.parse(f.rows.get(`evidence_versions:${physical}`)!.payload_json)as EvidenceVersion;
 const corrected={...originalVersion,version:2,supersedesVersion:1,statement:'Owner correction preserves historical source',recordedAt:'2026-10-19T12:00:00.000Z'};
 await f.replace('evidence_records',id,{id,currentVersion:2,archivedAt:null});await f.replace('evidence_versions',await versionRowId(id,2),corrected);
 const unlink=[...f.rows.entries()].find(([key,row])=>key.startsWith('evidence_links:')&&(JSON.parse(row.payload_json)as EvidenceLink).evidenceId===id)!;f.rows.delete(unlink[0]);
 // Restored snapshots retain physical source identities even when planning IDs moved.
 f.context.before.workspace=structuredClone(f.after);f.context.now='2026-10-20T12:00:00.000Z';
 const rowsBefore=structuredClone([...f.rows]),planningBefore=structuredClone(f.after);
 const replay=await prepareBaselineEvidence(f.context,f.after);assert.deepEqual(replay.writes,[]);assert.deepEqual(replay.events,[]);assert.deepEqual([...f.rows],rowsBefore);assert.deepEqual(f.after,planningBefore);
 assert.ok(replay.preconditions!.some(row=>row.id===physical));
});
test('stable source collision fails closed and archived application cannot add evidence',async()=>{
 const f=fixture(),id=await baselineEvidenceSourceId(f.baseline,f.baseline.sources[0]);
 const first=await prepareBaselineEvidence(f.context,f.after);await f.persist(first.writes);
 const physical=await versionRowId(id,1),version=JSON.parse(f.rows.get(`evidence_versions:${physical}`)!.payload_json);
 await f.replace('evidence_versions',physical,{...version,statement:'Different content under occupied source ID'});
 await assert.rejects(prepareBaselineEvidence(f.context,f.after),/occupied/);
 const archived=fixture();archived.before.projects[0].archivedAt=now;await assert.rejects(prepareBaselineEvidence(archived.context,archived.after),/Restore this project/);
});
test('archived source stays archived and malformed commands never manufacture evidence',async()=>{
 const f=fixture(),first=await prepareBaselineEvidence(f.context,f.after);await f.persist(first.writes);f.context.before.workspace=structuredClone(f.after);
 const id=await baselineEvidenceSourceId(f.baseline,f.baseline.sources[0]);await f.replace('evidence_records',id,{id,currentVersion:1,archivedAt:now});
 assert.deepEqual((await prepareBaselineEvidence(f.context,f.after)).writes,[]);
 f.context.command={...f.context.command,sourceUrl:'https://invented.invalid'};await assert.rejects(prepareBaselineEvidence(f.context,f.after));
 assert.equal(f.after.tasks[0].id,baselineRecordId(f.after.projects[0].id,f.baseline.actions[0].key));
});
test('actual command replay and reviewed restore retain normalized baseline identities without duplication',async()=>{
 const {database}=await import('./helpers/sqlite.ts');const {loadWorkspace}=await import('../lib/workspace-store.ts');
 const {executeWorkspaceCommand}=await import('../lib/workspace-transaction.ts');const {workspaceHandlers}=await import('../lib/workspace-handlers.ts');
 const {exportWorkspaceBundle}=await import('../lib/workspace-export.ts');const {stageImport}=await import('../lib/import-staging.ts');
 const f=fixture(),{db,sqlite}=database();try{
 await loadWorkspace(db,'synthetic-owner',()=>f.before,now);
 const handlers=workspaceHandlers;
 const input={protocolVersion:1,expectedRevision:1,mutationId:'baseline-normalized-first-0001',command:f.context.command};
 const deps={db,handlers,now:()=>now};const first=await executeWorkspaceCommand('synthetic-owner',input,deps);assert.equal(first.status,'committed');
 assert.equal((await executeWorkspaceCommand('synthetic-owner',input,deps)).status,'replayed');
 const bundle=await exportWorkspaceBundle(db,'synthetic-owner',{now:()=>now});
 const original=sqlite.prepare('SELECT id,payload_json FROM evidence_versions ORDER BY id').all();assert.equal(original.length,f.baseline.sources.length);
 const staged=await stageImport(db,'synthetic-owner',new TextEncoder().encode(JSON.stringify(bundle)),now);assert.deepEqual(staged.diagnostics,[]);
 const restored=await executeWorkspaceCommand('synthetic-owner',{protocolVersion:1,expectedRevision:2,mutationId:'baseline-normalized-restore-0001',command:{type:'workspace.import.commit',importId:staged.id,hash:staged.hash,targetRevision:2,mode:'replace'}},deps);assert.equal(restored.status,'committed');
 const reapplied=await executeWorkspaceCommand('synthetic-owner',{...input,expectedRevision:3,mutationId:'baseline-normalized-again-0001'},deps);assert.equal(reapplied.status,'committed');
 assert.deepEqual(sqlite.prepare('SELECT id,payload_json FROM evidence_versions ORDER BY id').all(),original);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM evidence_records').get()!.n,f.baseline.sources.length);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM acceptance_records').get()!.n,0);
 }finally{sqlite.close();}
});
test('public baseline command atomically preserves owner history and rolls back every effect on version write failure',async()=>{
 const {database}=await import('./helpers/sqlite.ts');const {loadWorkspace,readCurrent}=await import('../lib/workspace-store.ts');
 const {executeWorkspaceCommand}=await import('../lib/workspace-transaction.ts');const {workspaceHandlers}=await import('../lib/workspace-handlers.ts');
 const f=fixture(),{db,sqlite}=database();try{
 const ownerTask=taskFixture('original-owner-task',{areaId:null,workType:'other',projectId:f.before.projects[0].id,status:'done',completedAt:'2026-10-10T10:00:00.000Z',evidence:'Historical achieved result retained'});f.before.tasks.push(ownerTask);
 await loadWorkspace(db,'synthetic-owner',()=>f.before,now);
 const tables=['workspaces','evidence_records','evidence_versions','evidence_links','audit_events','workspace_mutations','workspace_assertions'];
 const snapshot=()=>Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));
 const before=snapshot(),input={protocolVersion:1,expectedRevision:1,mutationId:'baseline-public-fault-retry-0001',command:f.context.command},deps={db,handlers:workspaceHandlers,now:()=>now};
 sqlite.exec("CREATE TRIGGER synthetic_baseline_version_fault BEFORE INSERT ON evidence_versions BEGIN SELECT RAISE(ABORT,'synthetic baseline version fault'); END;");
 await assert.rejects(executeWorkspaceCommand('synthetic-owner',input,deps));assert.deepEqual(snapshot(),before);
 sqlite.exec('DROP TRIGGER synthetic_baseline_version_fault');
 assert.equal((await executeWorkspaceCommand('synthetic-owner',input,deps)).status,'committed');
 const current=(await readCurrent(db,'synthetic-owner',now)).workspace;
 assert.deepEqual(current.tasks.find(task=>task.id===ownerTask.id),ownerTask);
 const proposals=current.tasks.filter(task=>task.id!==ownerTask.id);assert.equal(proposals.length,5);assert.ok(proposals.every(task=>task.status==='proposed'&&task.weekly===false&&task.weeklyWeek===null&&task.completedAt===null));
 const links=sqlite.prepare('SELECT payload_json FROM evidence_links').all().map(row=>JSON.parse(String(row.payload_json))as EvidenceLink);assert.ok(links.length>f.baseline.sources.length);assert.ok(links.every(link=>link.relation==='context'));
 const audit=sqlite.prepare('SELECT source_ref FROM audit_events WHERE kind=?').all('baseline.evidence.imported');assert.equal(audit.length,f.baseline.sources.length);assert.ok(audit.every(row=>String(row.source_ref).startsWith(`baseline:${BASELINE_ID}:tamenni:`)));
 const committed=snapshot();assert.equal((await executeWorkspaceCommand('synthetic-owner',input,deps)).status,'replayed');assert.deepEqual(snapshot(),committed);
 }finally{sqlite.close();}
});
test('same bundled sources link to a second project without duplicating normalized source versions',async()=>{
 const f=fixture(),first=await prepareBaselineEvidence(f.context,f.after);await f.persist(first.writes);
 const second=projectFixture({id:'second-baseline-project',repositories:structuredClone(f.before.projects[0].repositories)});
 const before=structuredClone(f.after);before.projects.push(second);const after=applyProjectBaseline(before,second.id,BASELINE_ID,now);
 f.context.before.workspace=before;f.context.command={type:'baseline.apply',projectId:second.id,baselineId:BASELINE_ID};
 const additions=await prepareBaselineEvidence(f.context,after);
 assert.ok(additions.writes.length>0);assert.ok(additions.writes.every(row=>row.table==='evidence_links'));
 const projectLinks=additions.writes.map(row=>row.value as unknown as EvidenceLink).filter(link=>link.subject.type==='project');
 assert.equal(projectLinks.length,f.baseline.sources.length);assert.ok(projectLinks.every(link=>link.subject.id===second.id));
});
