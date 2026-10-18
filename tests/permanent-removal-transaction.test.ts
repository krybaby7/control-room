import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {previewEntityDeletion} from '../lib/workspace-deletion.ts';
import {listWorkspaceBackups,readWorkspaceBackup,BACKUP_LIMITS} from '../lib/workspace-backups.ts';
const now='2026-10-18T12:00:00.000Z';
const deps=(db:SqlDatabase)=>({db,handlers:workspaceHandlers,now:()=>now});
const envelope=(command:unknown,expectedRevision=1,mutationId='permanent-remove-0001')=>({protocolVersion:1,expectedRevision,mutationId,command});
async function setup(){const fixture=database();const workspace=createSeedWorkspace(now);for(const task of workspace.tasks)task.dependsOn=[];for(const capture of workspace.captures)capture.convertedTaskId=null;workspace.tasks[0]={...workspace.tasks[0],status:'archived',archivedFromStatus:'todo',weekly:false};workspace.captures[0].status='archived';await loadWorkspace(fixture.db,'a',()=>workspace,now);await loadWorkspace(fixture.db,'b',()=>createSeedWorkspace(now),now);return {...fixture,workspace};}
async function deletion(db:SqlDatabase,kind:'task'|'capture'='task'){const current=await readCurrent(db,'a');const record=kind==='task'?current.workspace.tasks[0]:current.workspace.captures[0];const preview=await previewEntityDeletion(current.workspace,kind,record.id,current.revision);return envelope({type:'entity.delete',entityType:kind,id:record.id,previewHash:preview.previewHash,targetRevision:current.revision},current.revision);}
function intercept(db:SqlDatabase,hook:()=>void):SqlDatabase{let fired=false;return {...db,batch:async statements=>{if(!fired){fired=true;hook();}return db.batch(statements);}};}
function state(sqlite:ReturnType<typeof database>['sqlite']){return Object.fromEntries(['workspaces','workspace_backups','workspace_recovery','workspace_mutations','audit_events','workspace_command_guards','workspace_assertions'].map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY user_id`).all()]));}
async function manual(db:SqlDatabase,index:number){const current=await readCurrent(db,'a');return executeWorkspaceCommand('a',envelope({type:'workspace.backup'},current.revision,`manual-recovery-${String(index).padStart(4,'0')}`),deps(db));}
async function removal(db:SqlDatabase,selected:string){const backups=await listWorkspaceBackups(db,'a');const item=backups.find(row=>row.id===selected)!;return envelope({type:'workspace.backup.remove',id:item.id,sha256:item.sha256,targetRevision:(await readCurrent(db,'a')).revision},(await readCurrent(db,'a')).revision,'snapshot-remove-0001');}

for(const kind of ['task','capture'] as const)test(`archived unreferenced ${kind} deletion retains its exact original ID and record in a complete backup`,async()=>{
 const {db,workspace}=await setup();const original=kind==='task'?workspace.tasks[0]:workspace.captures[0];const before=await readCurrent(db,'a');const input=await deletion(db,kind);
 assert.equal((await executeWorkspaceCommand('a',input,deps(db))).status,'committed');const current=await readCurrent(db,'a');const collection=kind==='task'?'tasks':'captures';assert.equal(current.workspace[collection].length,before.workspace[collection].length-1);assert.ok(!current.workspace[collection].some(row=>row.id===original.id));
 const [manifest]=await listWorkspaceBackups(db,'a');assert.equal(manifest.reason,'delete');const backup=await readWorkspaceBackup(db,'a',manifest.id);assert.ok(backup);assert.deepEqual(backup.bundle.planning[collection].find(row=>row.id===original.id),original);assert.deepEqual(backup.bundle.planning,before.workspace);
 assert.equal((await executeWorkspaceCommand('a',input,deps(db))).status,'replayed');assert.equal((await listWorkspaceBackups(db,'a')).length,1);
});

for(const invalid of ['active-task','active-capture','dependent-task','converted-capture','stale-preview','changed-preview'] as const)test(`permanent removal ${invalid} rejects without partial writes`,async()=>{
 const {db,sqlite,workspace}=await setup();if(invalid==='active-task'){workspace.tasks[0].status='todo';workspace.tasks[0].archivedFromStatus=null;}else if(invalid==='active-capture')workspace.captures[0].status='inbox';else if(invalid==='dependent-task')workspace.tasks[1].dependsOn=[workspace.tasks[0].id];else if(invalid==='converted-capture')workspace.captures[0].convertedTaskId=workspace.tasks[0].id;
 // Fixture state is synthetic and isolated; production mutation paths are exercised below.
 if(!invalid.includes('preview'))sqlite.prepare('UPDATE workspaces SET content=? WHERE user_id=?').run(JSON.stringify(workspace),'a');
 const input=await deletion(db,invalid.endsWith('capture')?'capture':'task');if(invalid==='stale-preview')(input.command as {targetRevision:number}).targetRevision=2;else if(invalid==='changed-preview')(input.command as {previewHash:string}).previewHash='0'.repeat(64);
 const before=state(sqlite);await assert.rejects(executeWorkspaceCommand('a',input,deps(db)));assert.deepEqual(state(sqlite),before);
});

test('full pinned manual backup quota blocks deletion without evicting an existing recovery point',async()=>{
 const {db,sqlite}=await setup();for(let index=0;index<BACKUP_LIMITS.snapshots;index++)await manual(db,index);const before=state(sqlite);const input=await deletion(db);
 await assert.rejects(executeWorkspaceCommand('a',input,deps(db)),/snapshot limit/);assert.deepEqual(state(sqlite),before);const backups=await listWorkspaceBackups(db,'a');assert.equal(backups.length,BACKUP_LIMITS.snapshots);assert.ok(backups.every(item=>item.pinned));
});

test('normalized record inserted after deletion preview blocks deletion and its snapshot atomically',async()=>{
 const {db,sqlite}=await setup();const input=await deletion(db);const before=state(sqlite);const raced=intercept(db,()=>{sqlite.prepare('INSERT INTO evidence_links (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run('a','race',1,'{}','synthetic');});await assert.rejects(executeWorkspaceCommand('a',input,deps(raced)));assert.deepEqual(state(sqlite),before);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM evidence_links WHERE user_id=?').get('a')!.n,1);
});

test('planning storage failure after deletion snapshot rolls snapshot, receipt and audit back',async()=>{
 const {db,sqlite}=await setup();const input=await deletion(db);const before=state(sqlite);sqlite.exec("CREATE TRIGGER fail_final BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'synthetic planning failure'); END;");await assert.rejects(executeWorkspaceCommand('a',input,deps(db)));assert.deepEqual(state(sqlite),before);
});

test('explicit removal of an older pinned manual point preserves the newer verified point and replays once',async()=>{
 const {db,sqlite}=await setup();await manual(db,1);await manual(db,2);const points=await listWorkspaceBackups(db,'a');const selected=points.find(row=>row.sourceRevision===1)!;const newest=points.find(row=>row.sourceRevision===2)!;const input=await removal(db,selected.id);
 assert.equal((await executeWorkspaceCommand('a',input,deps(db))).status,'committed');const remaining=await listWorkspaceBackups(db,'a');assert.equal(remaining.length,1);assert.equal(remaining[0].id,newest.id);assert.equal(remaining[0].pinned,true);assert.equal(await readWorkspaceBackup(db,'a',selected.id),null);assert.ok(await readWorkspaceBackup(db,'a',newest.id));const committed=state(sqlite);assert.equal((await executeWorkspaceCommand('a',input,deps(db))).status,'replayed');assert.deepEqual(state(sqlite),committed);
});

for(const target of ['only','newest'] as const)test(`removing ${target} recovery point is refused`,async()=>{
 const {db,sqlite}=await setup();await manual(db,1);if(target==='newest')await manual(db,2);const points=await listWorkspaceBackups(db,'a');const selected=points.reduce((a,b)=>a.sourceRevision>b.sourceRevision?a:b);const input=await removal(db,selected.id);const before=state(sqlite);await assert.rejects(executeWorkspaceCommand('a',input,deps(db)),/newer verified/);assert.deepEqual(state(sqlite),before);
});

for(const race of ['newer-deleted','newer-digest','selected-digest'] as const)test(`snapshot removal ${race} race cannot leave a receipt or remove the selected point`,async()=>{
 const {db,sqlite}=await setup();await manual(db,1);await manual(db,2);const points=await listWorkspaceBackups(db,'a');const old=points.find(row=>row.sourceRevision===1)!;const newer=points.find(row=>row.sourceRevision===2)!;const input=await removal(db,old.id);let afterRace:ReturnType<typeof state>;
 const raced=intercept(db,()=>{if(race==='newer-deleted')sqlite.prepare('DELETE FROM workspace_backups WHERE user_id=? AND id=?').run('a',newer.id);else sqlite.prepare('UPDATE workspace_backups SET sha256=? WHERE user_id=? AND id=?').run('0'.repeat(64),'a',race==='newer-digest'?newer.id:old.id);afterRace=state(sqlite);});
 await assert.rejects(executeWorkspaceCommand('a',input,deps(raced)));assert.deepEqual(state(sqlite),afterRace!);assert.ok(sqlite.prepare('SELECT id FROM workspace_backups WHERE user_id=? AND id=?').get('a',old.id));
});
