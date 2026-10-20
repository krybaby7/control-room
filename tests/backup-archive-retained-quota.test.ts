import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import type {SqlDatabase} from '../lib/workspace-store.ts';
import {backupQuotaGuard,readBackupQuotaUsage} from '../lib/backup-archive-quota.ts';
import {BACKUP_LIMITS} from '../lib/workspace-backups.ts';
const now='2026-10-18T12:00:00.000Z',sha='a'.repeat(64);
const namespace='11111111-1111-4111-8111-111111111111';
async function retained(db:SqlDatabase,owner:string,part=0,bytes=100,ns=namespace){
 const key='backups/'+ns+'/part-'+String(part).padStart(4,'0');
 await db.prepare('INSERT INTO backup_archive_retained_objects(user_id,storage_key,source_archive_id,part_number,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)').bind(owner,key,'original-file-backup',part,ns,bytes,sha,now,now).run();return key;
}
async function allowed(db:SqlDatabase,owner:string,bytes=0,count=0){
 const guard=backupQuotaGuard(owner,bytes,count);
 return (await db.prepare('SELECT CASE WHEN '+guard.sql+' THEN 1 ELSE 0 END AS allowed').bind(...guard.bindings).first<{allowed:number}>())!.allowed===1;
}
test('real migrated SQLite charges old retained generations plus current chunks and metadata without adding snapshots',async()=>{
 const {db,sqlite}=database();try{
  await retained(db,'a',0,120);
  await db.prepare("INSERT INTO workspace_backups(user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) VALUES(?,?,1,?,'manual',?,?,?,'ready',1)").bind('a','current',now,10,sha,'0123456789').run();
  await db.prepare('INSERT INTO backup_archive_objects(user_id,archive_id,part_number,storage_key,bytes,sha256,created_at,verified_at) VALUES(?,?,0,?,?,?,?,?)').bind('a','current','backups/22222222-2222-4222-8222-222222222222/part-0000',80,sha,now,now).run();
  assert.deepEqual(await readBackupQuotaUsage(db,'a'),{count:1,bytes:210});
  assert.deepEqual(await readBackupQuotaUsage(db,'b'),{count:0,bytes:0});
  // Exact immutable keys survive indefinitely; neither expiry nor missing current
  // archive metadata hides the old retained generation's charge.
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM backup_archive_retained_objects').first<{n:number}>())!.n,1);
 }finally{sqlite.close();}
});
test('retained physical bytes enforce the same owner ceiling and actual atomic guard leaves no partial mutation',async()=>{
 const {db,sqlite}=database();try{
  const each=BACKUP_LIMITS.ownerBytes/5;assert.equal(Number.isInteger(each),true);
  for(let part=0;part<5;part++)await retained(db,'a',part,each);
  assert.deepEqual(await readBackupQuotaUsage(db,'a'),{count:0,bytes:BACKUP_LIMITS.ownerBytes});
  assert.equal(await allowed(db,'a'),true);assert.equal(await allowed(db,'a',1,1),false);
  const guard=backupQuotaGuard('a',1,1);
  await assert.rejects(db.batch([
   db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+guard.sql+' THEN 1 ELSE 0 END').bind('a','retained-capacity-proof',...guard.bindings),
   db.prepare("INSERT INTO workspace_backups(user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) VALUES('a','must-not-exist',1,?,'manual',1,?,'x','ready',0)").bind(now,sha),
  ]));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_backups').first<{n:number}>())!.n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM backup_archive_retained_objects').first<{n:number}>())!.n,5);
 }finally{sqlite.close();}
});
test('retained keys are globally unique and cannot be rebound to a different owner or generation',async()=>{
 const {db,sqlite}=database();try{
  await retained(db,'a');await assert.rejects(retained(db,'a'));await assert.rejects(retained(db,'b'));
  assert.deepEqual(await readBackupQuotaUsage(db,'a'),{count:0,bytes:100});
  assert.deepEqual(await readBackupQuotaUsage(db,'b'),{count:0,bytes:0});
 }finally{sqlite.close();}
});
test('malformed retained bytes, digest, namespace and physical identity fail both quota reading and SQL admission closed',async()=>{
 for(const [column,value] of [['bytes',0],['bytes',-1],['bytes',4194305],['bytes',1.5],['sha256','x'.repeat(64)],['namespace','not-a-namespace'],['part_number',5],['storage_key','backups/foreign/part-0000'],['verified_at',''],['source_archive_id','']] as const){
  const {db,sqlite}=database();try{
   await retained(db,'a');await db.prepare('UPDATE backup_archive_retained_objects SET '+column+'=? WHERE user_id=?').bind(value,'a').run();
   await assert.rejects(readBackupQuotaUsage(db,'a'),/bookkeeping/);assert.equal(await allowed(db,'a'),false);
   assert.deepEqual(await readBackupQuotaUsage(db,'b'),{count:0,bytes:0});
  }finally{sqlite.close();}
 }
});
test('purged retained rows remain permanent and only their physical bytes leave the charge sum',async()=>{
 const {db,sqlite}=database();try{
  const key=await retained(db,'a',0,120);await retained(db,'a',1,80);
  await db.prepare('UPDATE backup_archive_retained_objects SET purged_at=? WHERE user_id=? AND storage_key=?').bind(now,'a',key).run();
  assert.deepEqual(await readBackupQuotaUsage(db,'a'),{count:0,bytes:80});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM backup_archive_retained_objects').first<{n:number}>())!.n,2);
  // This fixture updates a private ledger directly; no production cleanup API or
  // authorization is introduced by the retained ledger or quota helper.
 }finally{sqlite.close();}
});
