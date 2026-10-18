import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {canonical} from '../lib/canonical-json.ts';
const at='2026-10-18T12:00:00.000Z',namespace='10000000-0000-4000-8000-000000000001',otherNamespace='20000000-0000-4000-8000-000000000002';
const migrations=new URL('../drizzle/',import.meta.url),names=readdirSync(migrations).filter(name=>/^\d+_.*\.sql$/.test(name)).sort();
function oldDatabase(){const sqlite=new DatabaseSync(':memory:');for(const name of names.filter(name=>Number(name.slice(0,4))<=14))sqlite.exec(readFileSync(new URL(name,migrations),'utf8'));return sqlite;}
function migrate(sqlite:DatabaseSync){const name=names.find(name=>name.startsWith('0015_'));assert.ok(name);sqlite.exec('BEGIN IMMEDIATE');try{sqlite.exec(readFileSync(new URL(name,migrations),'utf8'));sqlite.exec('COMMIT');}catch(error){sqlite.exec('ROLLBACK');throw error;}}
function metadata(id:string,bytes:number,status='ready',ns=namespace){return {id,filename:'synthetic.txt',mimeType:'text/plain',expectedBytes:bytes,actualBytes:status==='ready'?bytes:null,sha256:status==='ready'?'a'.repeat(64):null,status,storageKey:`attachments/${ns}/${id}`,createdAt:at,expiresAt:at,readyAt:status==='ready'?at:null,uploadMutationId:`synthetic-${id}`,quarantineReason:null};}
function insert(sqlite:DatabaseSync,owner:string,value:ReturnType<typeof metadata>){sqlite.prepare('INSERT INTO attachments(user_id,id,row_revision,payload_json,content_hash,status,expected_bytes,sha256,storage_key,created_at,ready_at) VALUES(?,?,7,?,?,?,?,?,?,?,?)').run(owner,value.id,canonical(value),'b'.repeat(64),value.status,value.expectedBytes,value.sha256,value.storageKey,value.createdAt,value.readyAt);}
function backup(sqlite:DatabaseSync,id:string,rows:ReturnType<typeof metadata>[],owner='a'){const content=canonical({modules:{attachments:{schemaVersion:1,records:rows.map(value=>({id:value.id,rowRevision:7,contentHash:'b'.repeat(64),value}))}}});sqlite.prepare('INSERT INTO workspace_backups(user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) VALUES(?,?,7,?,?,?, ?,?, ?,1)').run(owner,id,at,'manual',content.length,'c'.repeat(64),content,'ready');}
function namespaceRow(sqlite:DatabaseSync,owner:string,ns:string){sqlite.prepare('INSERT INTO workspace_source_namespaces(user_id,audit_namespace,blob_namespace,cursor_secret) VALUES(?,?,?,?)').run(owner,crypto.randomUUID(),ns,'d'.repeat(64));}
const preservedTables=['attachments','workspaces','workspace_backups','workspace_source_namespaces','decision_owner_grants','acceptance_owner_grants','attachment_blob_fences','attachment_blob_namespaces'];
function snapshot(sqlite:DatabaseSync){return Object.fromEntries(preservedTables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));}
test('0015 backfills owner base keys including retired and backup-only objects without changing historical records or grants',()=>{
 const sqlite=oldDatabase();try{
  namespaceRow(sqlite,'a',namespace);namespaceRow(sqlite,'b',otherNamespace);
  const current=metadata('30000000-0000-4000-8000-000000000003',3),retired=metadata('40000000-0000-4000-8000-000000000004',5,'deleted'),backupOnly=metadata('50000000-0000-4000-8000-000000000005',8),foreign=metadata('60000000-0000-4000-8000-000000000006',13,'ready',otherNamespace);
  insert(sqlite,'a',current);insert(sqlite,'a',retired);insert(sqlite,'a',foreign);insert(sqlite,'b',metadata('70000000-0000-4000-8000-000000000007',17,'ready',otherNamespace));
  sqlite.prepare('INSERT INTO attachments(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('a','legacy-placeholder',canonical({filename:'legacy-only.txt'}),'e'.repeat(64));
  backup(sqlite,'synthetic-retained-backup',[current,backupOnly,foreign]);backup(sqlite,'synthetic-duplicate-backup',[backupOnly]);
  sqlite.prepare('INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(?,?,7,?)').run('a',canonical({syntheticPlanning:'unchanged'}),at);
  sqlite.prepare('INSERT INTO decision_owner_grants(user_id,decision_id,version,content_hash) VALUES(?,?,1,?)').run('a','synthetic-decision','f'.repeat(64));
  sqlite.prepare('INSERT INTO acceptance_owner_grants(user_id,record_id,content_hash) VALUES(?,?,?)').run('a','synthetic-acceptance','0'.repeat(64));
  const before=snapshot(sqlite);migrate(sqlite);assert.deepEqual(snapshot(sqlite),before);
  const rows=sqlite.prepare('SELECT * FROM attachment_blob_objects WHERE user_id=? ORDER BY storage_key').all('a');assert.equal(rows.length,3);assert.deepEqual(rows.map(row=>row.attachment_id),[current.id,retired.id,backupOnly.id]);assert.deepEqual(rows.map(row=>row.bytes),[3,5,8]);assert.ok(rows.every(row=>row.namespace===namespace&&row.purged_at===null));
  assert.deepEqual({...sqlite.prepare('SELECT COUNT(*) AS files,SUM(bytes) AS bytes FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL').get('a')},{files:3,bytes:16});
  const other=sqlite.prepare('SELECT COUNT(*) AS files,SUM(bytes) AS bytes FROM attachment_blob_objects WHERE user_id=?').get('b');assert.deepEqual({...other},{files:1,bytes:17});
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM attachment_archive_stages').get()!.n,0);
 }finally{sqlite.close();}
});

test('0015 immutable key byte/hash conflicts fail closed and atomically preserve prior owner records',()=>{
 for(const variant of ['bytes','hash','backup-only-bytes','backup-only-hash','unknown-current-two-known-hashes'] as const){
  const sqlite=oldDatabase();try{
   namespaceRow(sqlite,'a',namespace);const current=metadata('30000000-0000-4000-8000-000000000003',3);
   if(variant==='unknown-current-two-known-hashes'){insert(sqlite,'a',metadata(current.id,3,'reserved'));backup(sqlite,'first-known-backup',[current]);}
   else if(!variant.startsWith('backup-only'))insert(sqlite,'a',current);else backup(sqlite,'first-backup',[current]);
   const conflicting={...current,...(variant.endsWith('bytes')?{expectedBytes:8,actualBytes:8}:{sha256:'f'.repeat(64)})};backup(sqlite,'conflicting-backup',[conflicting]);
   sqlite.prepare('INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(?,?,7,?)').run('a',canonical({planning:'retained during rejected migration'}),at);
   sqlite.prepare('INSERT INTO acceptance_owner_grants(user_id,record_id,content_hash) VALUES(?,?,?)').run('a','retained-grant','0'.repeat(64));
   const before=snapshot(sqlite);assert.throws(()=>migrate(sqlite),/CHECK constraint failed/,variant);assert.deepEqual(snapshot(sqlite),before,variant);
   assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('attachment_blob_objects','attachment_archive_stages')").get()!.n,0);
   assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_assertions WHERE mutation_id='physical-backfill-v1'").get()!.n,0);
  }finally{sqlite.close();}
 }
});
test('0015 unknown reservation digest is compatible with a known retained digest but bytes must agree',()=>{
 const sqlite=oldDatabase();try{
  namespaceRow(sqlite,'a',namespace);const reserved=metadata('30000000-0000-4000-8000-000000000003',3,'reserved');insert(sqlite,'a',reserved);backup(sqlite,'known-ready-backup',[{...reserved,status:'ready',actualBytes:3,sha256:'a'.repeat(64),readyAt:at}]);const before=snapshot(sqlite);migrate(sqlite);assert.deepEqual(snapshot(sqlite),before);
  const row=sqlite.prepare('SELECT bytes,sha256,purged_at FROM attachment_blob_objects WHERE user_id=? AND storage_key=?').get('a',reserved.storageKey);assert.deepEqual({...row},{bytes:3,sha256:null,purged_at:null});
 }finally{sqlite.close();}
});
