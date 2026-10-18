import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand,mutationOutcome} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {exportWorkspaceBundle,contentHash,canonical} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {listWorkspaceBackups,readWorkspaceBackup} from '../lib/workspace-backups.ts';
import {CommandValidationError} from '../lib/workspace-errors.ts';
const now='2026-10-18T12:00:00.000Z';
async function legacyEvidenceRow(physicalId:string,record:unknown){const value={kind:'legacy',physicalId,record};return {id:`l:${await contentHash(canonical(['evidence_records',physicalId]))}`,rowRevision:99,contentHash:await contentHash(canonical(value)),value};}
const deps=(db:SqlDatabase)=>({db,handlers:workspaceHandlers,now:()=>now});
async function setup(){
 const fixture=database();const {db,sqlite}=fixture;for(const owner of ['a','b'])await loadWorkspace(db,owner,()=>createSeedWorkspace(now),now);
 for(const owner of ['a','b'])sqlite.prepare('INSERT INTO evidence_records (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run(owner,'original',4,JSON.stringify({text:'Original evidence'}),await contentHash(canonical({text:'Original evidence'})));
 sqlite.prepare("INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES (?,?,1,0,'original','fixture',NULL,?,?)").run('a','original-event',now,'{}');
 for(const owner of ['a','b'])for(const status of ['pending','running','claimed','completed'])sqlite.prepare('INSERT INTO workspace_job_intents (user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES (?,?,?,?,?,?,?,0,0)').run(owner,status,'fixture',status,'{}',now,status);
 const bundle=await exportWorkspaceBundle(db,'a',{now:()=>now});bundle.planning.projects[0].goal='Reviewed replacement';bundle.modules.evidence.records=[await legacyEvidenceRow('replacement',{text:'Imported evidence'})];
 bundle.modules.audit_events.records=[{id:'remote-event',kind:'source-claim',payload:{actorId:'untrusted-actor',claim:'Historical data only'}}];
 const stage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(bundle)),now);assert.deepEqual(stage.diagnostics,[]);
 const command={type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:1,mode:'replace'};
 const input={protocolVersion:1,mutationId:'reviewed-import-0001',expectedRevision:1,command};
 return {...fixture,bundle,stage,input};
}
function intercept(db:SqlDatabase,hook:()=>void):SqlDatabase{let fired=false;return {...db,batch:async statements=>{if(!fired){fired=true;hook();}return db.batch(statements);}};}
function snapshot(sqlite:ReturnType<typeof database>['sqlite']){return Object.fromEntries(['workspaces','evidence_records','audit_events','workspace_backups','workspace_recovery','workspace_mutations','workspace_execution_state','workspace_job_intents','workspace_command_guards','workspace_assertions','audit_import_identities'].map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY user_id`).all()]));}

test('reviewed import atomically replaces planning and module, appends provenance, snapshots original and invalidates execution',async()=>{
 const {db,sqlite,input}=await setup();const before=await readCurrent(db,'a');const foreign=sqlite.prepare('SELECT * FROM workspace_job_intents WHERE user_id=?').all('b');
 const result=await executeWorkspaceCommand('a',input,deps(db));assert.equal(result.status,'committed');assert.equal((await readCurrent(db,'a')).workspace.projects[0].goal,'Reviewed replacement');
 const rows=await ownerReader(db,'a').list('evidence_records');assert.equal(rows.length,1);assert.equal(rows[0].id,'replacement');assert.equal(rows[0].row_revision,1);assert.deepEqual(JSON.parse(rows[0].payload_json),{text:'Imported evidence'});
 assert.equal((await ownerReader(db,'b').get('evidence_records','original'))?.row_revision,4);
 const history=sqlite.prepare('SELECT * FROM audit_events WHERE user_id=? ORDER BY workspace_revision,ordinal').all('a');assert.equal(history.length,3);assert.equal(history[0].event_id,'original-event');const imported=JSON.parse(history[2].payload_json as string);assert.equal(imported.actorId,'a');assert.equal(imported.kind,'imported-history');assert.equal(imported.changes[0].after.value.sourceClaim.payload.actorId,'owner');assert.equal(imported.changes[0].after.value.sourceClaim.payload.claim,'Historical data only');assert.match(imported.changes[0].after.value.historicalAudit.namespace,/^[a-f0-9-]{36}$/);
 const backups=await listWorkspaceBackups(db,'a');assert.equal(backups.length,1);const backup=await readWorkspaceBackup(db,'a',backups[0].id);assert.ok(backup);assert.deepEqual(backup.bundle.planning,before.workspace);assert.deepEqual((backup.bundle.modules.evidence.records[0] as {value:{record:unknown}}).value.record,{text:'Original evidence'});
 assert.equal(sqlite.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').get('a')!.epoch,1);
 const jobs=sqlite.prepare('SELECT id,status,cancel_requested FROM workspace_job_intents WHERE user_id=? ORDER BY id').all('a');assert.deepEqual(jobs.map(row=>[row.id,row.status,row.cancel_requested]),[['claimed','claimed',1],['completed','completed',0],['pending','cancelled',0],['running','running',1]]);assert.deepEqual(sqlite.prepare('SELECT * FROM workspace_job_intents WHERE user_id=?').all('b'),foreign);
 assert.equal((await mutationOutcome(db,'a',input.mutationId)).status,'committed');const committed=snapshot(sqlite);assert.equal((await executeWorkspaceCommand('a',input,deps(db))).status,'replayed');assert.deepEqual(snapshot(sqlite),committed);
});

for(const race of ['revision','hash','new-row','deleted-row'] as const)test(`replacement table ${race} race aborts the entire import`,async()=>{
 const {db,sqlite,input}=await setup();let afterRace:ReturnType<typeof snapshot>;const raced=intercept(db,()=>{if(race==='revision')sqlite.prepare('UPDATE evidence_records SET row_revision=5 WHERE user_id=?').run('a');else if(race==='hash')sqlite.prepare("UPDATE evidence_records SET content_hash='changed' WHERE user_id=?").run('a');else if(race==='deleted-row')sqlite.prepare('DELETE FROM evidence_records WHERE user_id=?').run('a');else sqlite.prepare('INSERT INTO evidence_records (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,?,?,?)').run('a','racer',1,'{}','changed');afterRace=snapshot(sqlite);});
 await assert.rejects(executeWorkspaceCommand('a',input,deps(raced)));assert.deepEqual(snapshot(sqlite),afterRace!);
});

for(const [operation,table,when] of [['DELETE','evidence_records',''],['INSERT','evidence_records',''],['INSERT','audit_events',"WHEN NEW.kind='imported-history'"],['INSERT','workspace_execution_state',''],['UPDATE','workspace_job_intents','']] as const)test(`SQL abort at ${operation} ${table} rolls all replacement effects back`,async()=>{
 const {db,sqlite,input}=await setup();const before=snapshot(sqlite);sqlite.exec(`CREATE TRIGGER fixture_abort BEFORE ${operation} ON ${table} ${when} BEGIN SELECT RAISE(ABORT,'synthetic import failure'); END;`);await assert.rejects(executeWorkspaceCommand('a',input,deps(db)));assert.deepEqual(snapshot(sqlite),before);
});

for(const invalid of ['wrong-hash','foreign-owner','stale-preview','expired-stage'] as const)test(`reviewed import ${invalid} cannot mutate authoritative records`,async()=>{
 const {db,sqlite,input,stage}=await setup();const before=snapshot(sqlite);let owner='a';if(invalid==='wrong-hash')input.command.hash='0'.repeat(64);else if(invalid==='foreign-owner')owner='b';else if(invalid==='stale-preview')input.command.targetRevision=2;else sqlite.prepare('UPDATE workspace_imports SET expires_at=? WHERE user_id=? AND id=?').run(now,'a',stage.id);
 await assert.rejects(executeWorkspaceCommand(owner,input,deps(db)),CommandValidationError);assert.deepEqual(snapshot(sqlite),before);
});

test('legacy planning restore refuses to omit populated normalized modules',async()=>{
 const {db,sqlite}=await setup();const before=snapshot(sqlite);await assert.rejects(executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:1,mutationId:'legacy-restore-0001',command:{type:'workspace.restore',workspace:createSeedWorkspace(now)}},deps(db)),/complete normalized bundle/);assert.deepEqual(snapshot(sqlite),before);
});

test('staged source digest changing between preparation and batch cannot commit an accepted import',async()=>{
 const {db,sqlite,input,stage}=await setup();const before=snapshot(sqlite);const raced=intercept(db,()=>{sqlite.prepare('UPDATE workspace_imports SET content_hash=? WHERE user_id=? AND id=?').run('0'.repeat(64),'a',stage.id);});
 await assert.rejects(executeWorkspaceCommand('a',input,deps(raced)));assert.deepEqual(snapshot(sqlite),before);
});

for(const invalid of ['bulk-row-bytes','expanded-history-bytes','duplicate-identity'] as const)test(`import ${invalid} is rejected before any authoritative write`,async()=>{
 const {db,sqlite,bundle,input}=await setup();
 if(invalid==='bulk-row-bytes'){const value={text:'x'.repeat(1_800_000)};bundle.modules.evidence.records=[await legacyEvidenceRow('large',value)];}
 else if(invalid==='expanded-history-bytes')bundle.modules.audit_events.records=[{id:'large-history',kind:'legacy-summary',payload:{text:'"'.repeat(650000)}}];
 else bundle.modules.evidence.records.push(bundle.modules.evidence.records[0]);
 const stage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(bundle)),now);assert.equal(stage.diagnostics.length,invalid==='duplicate-identity'?1:0);input.command.importId=stage.id;input.command.hash=stage.hash;const before=snapshot(sqlite);
 await assert.rejects(executeWorkspaceCommand('a',input,deps(db)),CommandValidationError);assert.deepEqual(snapshot(sqlite),before);
});

for(const race of ['deleted','expired'] as const)test(`staged source ${race} at the transaction boundary prevents import`,async()=>{
 const {db,sqlite,input,stage}=await setup();const before=snapshot(sqlite);const raced=intercept(db,()=>{if(race==='deleted')sqlite.prepare('DELETE FROM workspace_imports WHERE user_id=? AND id=?').run('a',stage.id);else sqlite.prepare('UPDATE workspace_imports SET expires_at=? WHERE user_id=? AND id=?').run(now,'a',stage.id);});
 await assert.rejects(executeWorkspaceCommand('a',input,deps(raced)));assert.deepEqual(snapshot(sqlite),before);
});

test('same source audit identity survives a changed bundle without appending another historical event',async()=>{
 const {db,sqlite,input,bundle}=await setup();
 await executeWorkspaceCommand('a',input,deps(db));
 const identity=`audit:${bundle.source.auditNamespace}:remote-event`,eventId=`history_${await contentHash(identity)}`;
 const originalHistory=sqlite.prepare('SELECT * FROM audit_events WHERE user_id=? AND event_id=?').get('a',eventId);assert.ok(originalHistory);
 const identityRow=sqlite.prepare('SELECT * FROM audit_import_identities WHERE user_id=? AND source_identity=?').get('a',identity);assert.ok(identityRow);
 bundle.planning.projects[0].goal='Same source claim, independently reviewed newer bundle';
 const nextStage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(bundle)),now);assert.deepEqual(nextStage.diagnostics,[]);assert.notEqual(nextStage.hash,input.command.hash);
 const next={protocolVersion:1,mutationId:'reviewed-import-again-0001',expectedRevision:2,command:{...input.command,importId:nextStage.id,hash:nextStage.hash,targetRevision:2}};
 assert.equal((await executeWorkspaceCommand('a',next,deps(db))).status,'committed');
 assert.deepEqual(sqlite.prepare('SELECT * FROM audit_events WHERE user_id=? AND event_id=?').get('a',eventId),originalHistory);
 assert.deepEqual(sqlite.prepare('SELECT * FROM audit_import_identities WHERE user_id=? AND source_identity=?').get('a',identity),identityRow);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE user_id=? AND kind='imported-history'").get('a')!.n,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE user_id=? AND kind='workspace.import.commit'").get('a')!.n,2);
 assert.equal((await readCurrent(db,'a')).workspace.projects[0].goal,bundle.planning.projects[0].goal);
});

test('same known source audit identity with changed claim cannot overwrite provenance or partially restore',async()=>{
 const {db,sqlite,input,bundle}=await setup();await executeWorkspaceCommand('a',input,deps(db));
 bundle.modules.audit_events.records=[{id:'remote-event',kind:'source-claim',payload:{actorId:'untrusted-actor',claim:'Conflicting altered historical content'}}];
 const nextStage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(bundle)),now);assert.deepEqual(nextStage.diagnostics,[]);
 const before=snapshot(sqlite),next={protocolVersion:1,mutationId:'reviewed-import-conflict-0001',expectedRevision:2,command:{...input.command,importId:nextStage.id,hash:nextStage.hash,targetRevision:2}};
 await assert.rejects(executeWorkspaceCommand('a',next,deps(db)));assert.deepEqual(snapshot(sqlite),before);
});
