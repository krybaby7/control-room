import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/sqlite.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { loadWorkspace, readCurrent } from '../lib/workspace-store.ts';
import { prepareWorkspaceBackup, readWorkspaceBackup, listWorkspaceBackups, type BackupManifest } from '../lib/workspace-backups.ts';
import { createBackupStorage, prepareObjectBackup, collectOrphanBackup, type BackupBucket } from '../lib/backup-storage.ts';
import { contentHash } from '../lib/workspace-export.ts';
const now='2026-10-18T12:00:00.000Z';
async function setup(){const fixture=database();fixture.sqlite.exec('CREATE TABLE IF NOT EXISTS workspace_backups(user_id TEXT NOT NULL,id TEXT NOT NULL,source_revision INTEGER NOT NULL,created_at TEXT NOT NULL,reason TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,pinned INTEGER NOT NULL,PRIMARY KEY(user_id,id))');await loadWorkspace(fixture.db,'a',()=>createSeedWorkspace(now),now);return fixture;}
function fake(){const objects=new Map<string,Uint8Array>();let corrupt=false;let error=false;const bucket:BackupBucket={async put(key,value){if(error)throw new Error('R2 unavailable');if(objects.has(key))return null;objects.set(key,value.slice());return {size:value.byteLength};},async head(key){const bytes=objects.get(key);return bytes?{size:bytes.byteLength}:null;},async get(key){const bytes=objects.get(key);return bytes?{size:bytes.byteLength,async arrayBuffer(){const copy=bytes.slice();if(corrupt)copy[0]^=1;return copy.buffer;}}:null;},async delete(key){objects.delete(key);}};return {bucket,objects,setCorrupt:()=>{corrupt=true;},setError:()=>{error=true;}};}
test('D1 preparation writes nothing and stored snapshots verify owner, completeness and digest',async()=>{
 const {db,sqlite}=await setup();const before=await readCurrent(db,'a');const changesBefore=sqlite.prepare('SELECT total_changes() AS n').get()!.n;const prepared=await prepareWorkspaceBackup(db,'a',before,'manual',now);assert.equal(sqlite.prepare('SELECT total_changes() AS n').get()!.n,changesBefore,'backup preparation must not write any database table');assert.equal(prepared.manifest.status,'ready');assert.deepEqual(prepared.manifest.completeModules,['planning','acceptance_records','attachment_usage','attachments','audit_events','decisions','evidence','evidence_links','evidence_requirements','integration_history','recurrence_occurrences','recurrence_rules','source_connections','source_observations','source_proposals','source_sync_runs','source_targets','weekly_plans','weekly_reviews']);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_backups').get()!.n,0);
 const m=prepared.manifest;sqlite.prepare('INSERT INTO workspace_backups VALUES (?,?,?,?,?,?,?,?,?,?)').run('a',m.id,m.sourceRevision,m.createdAt,m.reason,m.bytes,m.sha256,prepared.content,m.status,1);
 assert.equal((await listWorkspaceBackups(db,'a'))[0].pinned,true);assert.equal(await readWorkspaceBackup(db,'b',m.id),null);assert.deepEqual((await readWorkspaceBackup(db,'a',m.id))!.bundle.planning,before.workspace);
 sqlite.prepare('UPDATE workspace_backups SET content=? WHERE user_id=?').run('{}','a');await assert.rejects(readWorkspaceBackup(db,'a',m.id),/digest/);await assert.rejects(listWorkspaceBackups(db,'a'),/digest/);sqlite.close();
});
test('full snapshot quota retains every manual/pinned snapshot; stale source and missing module fail closed',async()=>{
 const {db,sqlite}=await setup();const before=await readCurrent(db,'a');for(let i=0;i<10;i++)sqlite.prepare('INSERT INTO workspace_backups VALUES (?,?,?,?,?,?,?,?,?,?)').run('a',String(i),1,now,'manual',1,'hash','x','ready',1);
 await assert.rejects(prepareWorkspaceBackup(db,'a',before,'delete',now),/snapshot limit/);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_backups').get()!.n,10);
 sqlite.prepare('DELETE FROM workspace_backups WHERE user_id=?').run('a');sqlite.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').run('a');await assert.rejects(prepareWorkspaceBackup(db,'a',before,'repair',now),/changed/);
 sqlite.prepare('INSERT INTO workspace_configuration (user_id,id,row_revision,payload_json,content_hash) VALUES (?,?,1,?,?)').run('a','decision','{}','hash');await assert.rejects(prepareWorkspaceBackup(db,'a',await readCurrent(db,'a'),'restore',now),/no export adapter/);sqlite.close();
});
test('byte quota failure preserves prior snapshots',async()=>{
 const {db,sqlite}=await setup();sqlite.prepare('INSERT INTO workspace_backups VALUES (?,?,?,?,?,?,?,?,?,?)').run('a','retained',1,now,'manual',20_000_000,'hash','x','ready',1);await assert.rejects(prepareWorkspaceBackup(db,'a',await readCurrent(db,'a'),'delete',now),/byte budget/);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_backups').get()!.n,1);sqlite.close();
});
test('R2 readiness requires verified immutable bytes; missing binding, provider failure and corruption fail',async()=>{
 const bytes=new TextEncoder().encode('synthetic bundle');const sha256=await contentHash(bytes);const base:BackupManifest={id:'id',ownerScope:'a',sourceRevision:1,reason:'manual',createdAt:now,formatVersion:1,bytes:bytes.byteLength,sha256,storageKind:'r2',storageKey:'backups/a/id',status:'preparing',expiresAt:null,completeModules:['planning'],missingAttachments:[]};
 const unavailable=createBackupStorage();assert.equal(unavailable.available,false);await assert.rejects(prepareObjectBackup(unavailable,base,bytes),/unavailable/);
 const fixture=fake();const storage=createBackupStorage(fixture.bucket);assert.equal((await prepareObjectBackup(storage,base,bytes)).status,'ready');assert.equal(base.status,'preparing');await assert.rejects(storage.put(base.storageKey,bytes,sha256),/exists/);assert.equal(await storage.get('backups/a/missing'),null);
 const corrupt=fake();corrupt.setCorrupt();await assert.rejects(prepareObjectBackup(createBackupStorage(corrupt.bucket),base,bytes),/digest/);assert.equal(base.status,'preparing');const failed=fake();failed.setError();await assert.rejects(prepareObjectBackup(createBackupStorage(failed.bucket),base,bytes),/unavailable/);
 assert.equal(await collectOrphanBackup(storage,base.storageKey,0,100,async()=>false),false);assert.equal(await collectOrphanBackup(storage,base.storageKey,0,90_000_000,async()=>true),false);assert.equal(await collectOrphanBackup(storage,base.storageKey,0,90_000_000,async()=>false),true);assert.equal(await storage.head(base.storageKey),null);
});
test('oversized structured recovery is rejected at the explicit D1 fallback bound',async()=>{
 const {db,sqlite}=await setup();sqlite.prepare('INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES (?,?,1,0,NULL,NULL,?,?,NULL,?,?)').run('a','large-event','fixture','workspace',now,JSON.stringify({text:'x'.repeat(1_800_001)}));await assert.rejects(prepareWorkspaceBackup(db,'a',await readCurrent(db,'a'),'delete',now),/1.8 MB/);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_backups').get()!.n,0);sqlite.close();
});
