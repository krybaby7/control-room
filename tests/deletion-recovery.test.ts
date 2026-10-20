import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/sqlite.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { loadWorkspace, readCurrent, type SqlDatabase } from '../lib/workspace-store.ts';
import { executeWorkspaceCommand, hashJson, type CommandHandlerRegistry } from '../lib/workspace-transaction.ts';
import { workspaceHandlers } from '../lib/workspace-handlers.ts';
import { readWorkspaceBackup, listWorkspaceBackups, BACKUP_LIMITS } from '../lib/workspace-backups.ts';
import { ModuleConflictError, WorkspaceStorageError } from '../lib/workspace-errors.ts';
const now='2026-10-18T12:00:00.000Z';
const input=(mutationId='manual-backup-0001',expectedRevision=1,command:unknown={type:'workspace.backup'})=>({protocolVersion:1,mutationId,expectedRevision,command});
const deps=(db:SqlDatabase,handlers=workspaceHandlers)=>({db,handlers,now:()=>now});
async function setup(){const fixture=database();for(const owner of ['a','b'])await loadWorkspace(fixture.db,owner,()=>createSeedWorkspace(now),now);return fixture;}
function intercept(db:import('../lib/workspace-store.ts').SqlDatabase,hook:()=>Promise<void>|void):import('../lib/workspace-store.ts').SqlDatabase {
 let fired=false;const prepare=db.prepare.bind(db),batch=db.batch.bind(db),sqlByStatement=new WeakMap<import('../lib/workspace-store.ts').SqlStatement,string>();
 return {prepare(sql){const statement=prepare(sql);sqlByStatement.set(statement,sql);return statement;},async batch(statements){
  if(!fired&&statements.some(statement=>sqlByStatement.get(statement)?.startsWith('INSERT INTO workspace_command_guards'))){fired=true;await hook();}
  return batch(statements);
 }};
}
function count(sqlite:ReturnType<typeof database>['sqlite'],table:string,owner='a'){return sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id=?`).get(owner)!.n;}
function noEffects(sqlite:ReturnType<typeof database>['sqlite']){for(const table of ['workspace_mutations','workspace_backups','workspace_command_guards','workspace_assertions','audit_events'])assert.equal(count(sqlite,table),0,table);assert.equal(sqlite.prepare('SELECT revision FROM workspaces WHERE user_id=?').get('a')!.revision,1);}

test('production manual backup command stores a verified pinned snapshot of the pre-command revision',async()=>{
 const {db,sqlite}=await setup();const before=await readCurrent(db,'a');const result=await executeWorkspaceCommand('a',input(),deps(db));
 assert.equal(result.status,'committed');const list=await listWorkspaceBackups(db,'a');assert.equal(list.length,1);assert.equal(list[0].pinned,true);assert.equal(list[0].reason,'manual');assert.equal(list[0].sourceRevision,1);
 const saved=await readWorkspaceBackup(db,'a',list[0].id);assert.ok(saved);assert.deepEqual(saved.bundle.planning,before.workspace);assert.equal(saved.bundle.modules.audit_events.records.length,0);
 assert.equal((await readCurrent(db,'a')).revision,2);assert.equal(count(sqlite,'workspace_mutations'),1);assert.equal(count(sqlite,'audit_events'),1);assert.equal(count(sqlite,'workspace_recovery'),0);
});

test('separate manual commands retain multiple generations; replay does not create another generation',async()=>{
 const {db}=await setup();await executeWorkspaceCommand('a',input(),deps(db));await executeWorkspaceCommand('a',input('manual-backup-0002',2),deps(db));
 const original=await listWorkspaceBackups(db,'a');assert.equal(original.length,2);assert.deepEqual(original.map(row=>row.sourceRevision).sort(),[1,2]);
 const replay=await executeWorkspaceCommand('a',input(),deps(db));assert.equal(replay.status,'replayed');assert.deepEqual(await listWorkspaceBackups(db,'a'),original);
 const second=original.find(row=>row.sourceRevision===2)!;assert.equal((await readWorkspaceBackup(db,'a',second.id))?.bundle.modules.audit_events.records.length,1);
});

test('failed protected module CAS creates no deletion snapshot or receipt',async()=>{
 const {db,sqlite}=await setup();sqlite.prepare('INSERT INTO decisions VALUES (?,?,?,?,?)').run('a','source',1,'{}',await hashJson({}));
 const handlers:CommandHandlerRegistry=new Map([['fixture.delete',{prepare:async context=>({planningAfter:context.before.workspace,writes:[{table:'decisions',operation:'delete',id:'source',expectedRowRevision:1}],events:[],jobs:[],backup:{reason:'delete'}})}]]);
 const raced=intercept(db,()=>{sqlite.prepare('UPDATE decisions SET row_revision=2 WHERE user_id=?').run('a');});
 await assert.rejects(executeWorkspaceCommand('a',input('delete-backup-0001',1,{type:'fixture.delete'}),deps(raced,handlers)),ModuleConflictError);noEffects(sqlite);assert.equal(count(sqlite,'decisions'),1);
});

test('snapshot storage failure aborts receipt, audit, workspace and all transient guards',async()=>{
 const {db,sqlite}=await setup();sqlite.exec("CREATE TRIGGER fail_backup BEFORE INSERT ON workspace_backups BEGIN SELECT RAISE(ABORT,'synthetic snapshot failure'); END;");
 await assert.rejects(executeWorkspaceCommand('a',input(),deps(db)),WorkspaceStorageError);noEffects(sqlite);
});

test('lost workspace revision after backup preparation inserts no snapshot',async()=>{
 const {db,sqlite}=await setup();const raced=intercept(db,()=>{sqlite.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').run('a');});
 assert.deepEqual(await executeWorkspaceCommand('a',input(),deps(raced)),{status:'conflict',currentRevision:2});
 for(const table of ['workspace_backups','workspace_mutations','audit_events','workspace_command_guards','workspace_assertions'])assert.equal(count(sqlite,table),0,table);
});

test('snapshot source, listings and reads are owner scoped even when callers reuse mutation IDs',async()=>{
 const {db}=await setup();await executeWorkspaceCommand('a',input(),deps(db));const [a]=await listWorkspaceBackups(db,'a');
 assert.deepEqual(await listWorkspaceBackups(db,'b'),[]);assert.equal(await readWorkspaceBackup(db,'b',a.id),null);
 await executeWorkspaceCommand('b',input(),deps(db));const [b]=await listWorkspaceBackups(db,'b');assert.notEqual(a.id,b.id);assert.equal(a.ownerScope,'a');assert.equal(b.ownerScope,'b');
 assert.equal((await readWorkspaceBackup(db,'a',a.id))?.bundle.source.workspaceRevision,1);assert.equal(await readWorkspaceBackup(db,'a',b.id),null);
});

test('backup count quota is reasserted inside command transaction after a racing insert',async()=>{
 const {db,sqlite}=await setup();const raced=intercept(db,()=>{for(let i=0;i<BACKUP_LIMITS.snapshots;i++)sqlite.prepare('INSERT INTO workspace_backups (user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) VALUES (?,?,?,?,?,?,?,?,?,?)').run('a',`racing-${i}`,1,now,'manual',2,'synthetic','{}','ready',1);});
 await assert.rejects(executeWorkspaceCommand('a',input(),deps(raced)),WorkspaceStorageError);
 assert.equal(count(sqlite,'workspace_backups'),BACKUP_LIMITS.snapshots);for(const table of ['workspace_mutations','audit_events','workspace_command_guards','workspace_assertions'])assert.equal(count(sqlite,table),0,table);assert.equal((await readCurrent(db,'a')).revision,1);
});

test('backup byte quota is reasserted inside command transaction after a racing insert',async()=>{
 const {db,sqlite}=await setup();const raced=intercept(db,()=>{sqlite.prepare('INSERT INTO workspace_backups (user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) VALUES (?,?,?,?,?,?,?,?,?,?)').run('a','racing-size',1,now,'manual',BACKUP_LIMITS.ownerBytes,'synthetic','{}','ready',1);});
 await assert.rejects(executeWorkspaceCommand('a',input(),deps(raced)),WorkspaceStorageError);assert.equal(count(sqlite,'workspace_backups'),1);assert.equal(count(sqlite,'workspace_mutations'),0);assert.equal((await readCurrent(db,'a')).revision,1);
});

test('manual snapshots preserve the original pre-restore recovery row exactly',async()=>{
 const {db,sqlite}=await setup();const row=sqlite.prepare('SELECT content,revision,updated_at FROM workspaces WHERE user_id=?').get('a')!;
 sqlite.prepare('INSERT INTO workspace_recovery (user_id,content,revision,updated_at) VALUES (?,?,?,?)').run('a',row.content as string,7,row.updated_at as string);
 const before=sqlite.prepare('SELECT * FROM workspace_recovery WHERE user_id=?').get('a');await executeWorkspaceCommand('a',input(),deps(db));await executeWorkspaceCommand('a',input('manual-backup-0002',2),deps(db));
 assert.deepEqual(sqlite.prepare('SELECT * FROM workspace_recovery WHERE user_id=?').get('a'),before);assert.equal(count(sqlite,'workspace_backups'),2);
});

test('actual workspace restore rolls back its full backup when legacy recovery snapshot fails',async()=>{
 const {db,sqlite}=await setup();const before=await readCurrent(db,'a');
 sqlite.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON workspace_recovery BEGIN SELECT RAISE(ABORT,'synthetic legacy snapshot failure'); END;");
 const imported=structuredClone(before.workspace);imported.projects[0].goal='Synthetic replacement';
 await assert.rejects(executeWorkspaceCommand('a',input('restore-backup-0001',1,{type:'workspace.restore',workspace:imported}),deps(db)),WorkspaceStorageError);
 noEffects(sqlite);assert.equal(count(sqlite,'workspace_recovery'),0);assert.deepEqual((await readCurrent(db,'a')).workspace,before.workspace);
});
