import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedWorkspace} from '../lib/seed.ts';
import {database} from './helpers/sqlite.ts';
import {stageImport,readStagedImport,discardStagedImport,IMPORT_STAGING_LIMITS} from '../lib/import-staging.ts';
const now='2026-10-18T00:00:00.000Z';
function setup(){const result=database();result.sqlite.exec('CREATE TABLE IF NOT EXISTS workspace_imports(user_id TEXT NOT NULL,id TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,bytes INTEGER NOT NULL,metadata_json TEXT NOT NULL,PRIMARY KEY(user_id,id));CREATE TABLE IF NOT EXISTS workspace_import_chunks(user_id TEXT NOT NULL,import_id TEXT NOT NULL,ordinal INTEGER NOT NULL,content_base64 TEXT NOT NULL,PRIMARY KEY(user_id,import_id,ordinal))');return result;}
test('invalid JSON remains downloadable, owner isolated, immutable and expires after one hour',async()=>{
 const {db,sqlite}=setup();const raw=new TextEncoder().encode('private malformed {');const staged=await stageImport(db,'a',raw,now);raw.fill(0);
 assert.equal(staged.bundle,null);assert.equal(staged.diagnostics[0].code,'invalid-utf8-or-json');
 const recovered=await readStagedImport(db,'a',staged.id,now);assert.equal(new TextDecoder().decode(recovered.raw),'private malformed {');assert.equal(recovered.stage.id,staged.id);assert.equal(recovered.stage.hash,staged.hash);
 const metadata=sqlite.prepare('SELECT metadata_json FROM workspace_imports').get() as {metadata_json:string};assert.ok(!metadata.metadata_json.includes('private malformed'));
 await assert.rejects(readStagedImport(db,'b',staged.id,now));assert.equal(await discardStagedImport(db,'b',staged.id),false);
 await assert.rejects(readStagedImport(db,'a',staged.id,'2026-10-18T01:00:00.000Z'));
 await stageImport(db,'a',new Uint8Array(), '2026-10-18T01:00:00.000Z');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_imports').get()!.n,1);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_import_chunks').get()!.n,0);sqlite.close();
});
test('chunked durable retrieval detects missing, reordered and corrupted content',async()=>{
 const {db,sqlite}=setup();const raw=new Uint8Array(IMPORT_STAGING_LIMITS.chunkBytes+1).fill(65);const stage=await stageImport(db,'a',raw,now);assert.deepEqual((await readStagedImport(db,'a',stage.id,now)).raw,raw);
 sqlite.prepare('UPDATE workspace_import_chunks SET content_base64=? WHERE ordinal=1').run('Qg==');await assert.rejects(readStagedImport(db,'a',stage.id,now),/digest/);
 sqlite.prepare('DELETE FROM workspace_import_chunks WHERE ordinal=1').run();await assert.rejects(readStagedImport(db,'a',stage.id,now),/Missing/);sqlite.close();
});
test('owner stage/byte quotas fail without orphan chunks and permit another owner',async()=>{
 const {db,sqlite}=setup();for(let i=0;i<8;i++)await stageImport(db,'a',new Uint8Array([i]),now);await assert.rejects(stageImport(db,'a',new Uint8Array([9]),now),/quota/);await stageImport(db,'b',new Uint8Array([9]),now);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_import_chunks').get()!.n,9);
 await assert.rejects(stageImport(db,'b',new Uint8Array(IMPORT_STAGING_LIMITS.bytes+1),now),/byte limit/);
 // Isolated synthetic row exercises aggregate quota independently of count.
 sqlite.prepare('UPDATE workspace_imports SET bytes=? WHERE user_id=?').run(IMPORT_STAGING_LIMITS.ownerBytes,'b');await assert.rejects(stageImport(db,'b',new Uint8Array([1]),now),/quota/);sqlite.close();
});
test('chunk statement failure rolls metadata and prior chunks back atomically',async()=>{
 const {db,sqlite}=setup();sqlite.exec("CREATE TRIGGER fail_chunk BEFORE INSERT ON workspace_import_chunks WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'injected chunk failure'); END");
 await assert.rejects(stageImport(db,'a',new Uint8Array(IMPORT_STAGING_LIMITS.chunkBytes+1),now),/injected/);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_imports').get()!.n,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_import_chunks').get()!.n,0);sqlite.close();
});
test('unknown bundle versions remain quarantined and explicit discard removes chunks',async()=>{
 const {db,sqlite}=setup();const stage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify({format:'control-room',bundleVersion:999,planning:{}})),now);assert.equal(stage.bundle,null);assert.equal(stage.diagnostics[0].code,'invalid-schema-version-module-or-reference');assert.equal(await discardStagedImport(db,'a',stage.id),true);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_import_chunks').get()!.n,0);sqlite.close();
});

test('durable preview reconstructs legacy planning without storing its parsed bundle in metadata',async()=>{
 const {db,sqlite}=setup();const planning=createSeedWorkspace(now);const before=structuredClone(planning);planning.projects[0].goal='Imported proposal';const stage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(planning)),now);const recovered=await readStagedImport(db,'a',stage.id,now);const current={workspace:before,revision:7,updatedAt:now};const preview=recovered.preview(current);assert.equal(preview.importId,stage.id);assert.equal(preview.hash,stage.hash);assert.equal(preview.targetRevision,7);assert.deepEqual(preview.diff['planning.projects'].changed,[planning.projects[0].id]);assert.notEqual(current.workspace.projects[0].goal,'Imported proposal');const row=sqlite.prepare('SELECT metadata_json FROM workspace_imports').get() as {metadata_json:string};assert.ok(!row.metadata_json.includes('Imported proposal'));sqlite.close();
});
