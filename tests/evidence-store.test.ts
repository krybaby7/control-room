import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {readEvidenceSnapshot} from '../lib/evidence-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {versionRowId} from '../lib/version-identity.ts';
const now='2026-10-18T12:00:00.000Z';
const version={id:'evidence',version:1,basis:'owner-statement',scope:'implementation',title:'Synthetic owner claim',statement:'This statement is recorded, not independently verified.',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};
async function fixture(){const result=database();await loadWorkspace(result.db,'synthetic-a',()=>createSeedWorkspace(now),now);await loadWorkspace(result.db,'synthetic-b',()=>createSeedWorkspace(now),now);return result;}
async function seedEvidence(db:SqlDatabase,user='synthetic-a'){
 await db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash,current_version) VALUES(?,?,1,?,?,1)').bind(user,'evidence',JSON.stringify({id:'evidence',currentVersion:1,archivedAt:null}),await contentHash(canonical({id:'evidence',currentVersion:1,archivedAt:null}))).run();
 await db.prepare('INSERT INTO evidence_versions(user_id,id,row_revision,payload_json,content_hash,evidence_id,version,recorded_at) VALUES(?,?,1,?,?,?,1,?)').bind(user,await versionRowId('evidence',1),JSON.stringify(version),await contentHash(canonical(version)),'evidence',now).run();
}
function intercept(db:SqlDatabase,onRead:(sql:string)=>void):SqlDatabase{return {...db,prepare(sql){const statement=db.prepare(sql);const wrapped:SqlStatement={bind(...values){statement.bind(...values);return this;},async first<T>(){onRead(sql);return statement.first<T>();},async all<T>(){onRead(sql);return statement.all<T>();},run:()=>statement.run()};return wrapped;}};}
test('owner snapshot reads actual version schema at one revision without secrets or writes',async()=>{
 const {db,sqlite}=await fixture();try{
  await seedEvidence(db);const secret={id:'attachment',status:'reserved',filename:'synthetic.txt',mimeType:'text/plain',expectedBytes:20,actualBytes:null,sha256:null,storageKey:'private/blob-namespace/key',createdAt:now,expiresAt:'2026-10-18T12:30:00.000Z',readyAt:null,uploadMutationId:'private-upload-id',quarantineReason:null};await db.prepare('INSERT INTO attachments(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind('synthetic-a','attachment',JSON.stringify(secret),await contentHash(canonical(secret))).run();
  const before=sqlite.prepare('SELECT total_changes() AS n').get()!.n;const result=await readEvidenceSnapshot(db,'synthetic-a',now);assert.equal(result.revision,1);assert.equal(result.asOf,now);assert.deepEqual(result.evidenceVersions,[version]);assert.equal(result.evidenceHeads[0].currentVersion,1);assert.equal(result.attachments[0].status,'reserved');assert.equal(result.attachmentRecovery,'metadata-only');assert.ok(result.warnings.some(value=>value.includes('does not verify')));for(const hidden of ['synthetic-a','storageKey','uploadMutationId','private/blob-namespace/key','private-upload-id','cursorSecret'])assert.ok(!JSON.stringify(result).includes(hidden));assert.equal(sqlite.prepare('SELECT total_changes() AS n').get()!.n,before);assert.equal((await readEvidenceSnapshot(db,'synthetic-b',now)).evidenceVersions.length,0);
 }finally{sqlite.close();}
});
test('unknown legacy payloads are retained as counts and warnings rather than exposed or promoted',async()=>{
 const {db,sqlite}=await fixture();try{
  for(const table of ['evidence_records','evidence_links','decisions','attachments'])await db.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)`).bind('synthetic-a',`legacy-${table}`,JSON.stringify({unknown:'private unclassified legacy contents'}),'legacy-unverified-hash').run();
  const snapshot=await readEvidenceSnapshot(db,'synthetic-a',now);assert.deepEqual(snapshot.legacyCounts,{evidence_records:1,evidence_links:1,decisions:1,attachments:1});assert.equal(snapshot.evidenceHeads.length,0);assert.equal(snapshot.links.length,0);assert.equal(snapshot.attachments.length,0);assert.ok(snapshot.warnings.some(value=>value.includes('require explicit review')));assert.ok(!JSON.stringify(snapshot).includes('private unclassified'));assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM decisions WHERE user_id=?').get('synthetic-a')!.n,1);
 }finally{sqlite.close();}
});
test('typed corruption and missing immutable versions fail closed without silently downgrading to legacy',async()=>{
 for(const failure of ['digest','missing-version','invalid-head']){
  const {db,sqlite}=await fixture();try{await seedEvidence(db);if(failure==='digest')sqlite.prepare('UPDATE evidence_versions SET content_hash=?').run('0'.repeat(64));if(failure==='missing-version')sqlite.exec('DELETE FROM evidence_versions');if(failure==='invalid-head'){const bad={id:'evidence',currentVersion:0,archivedAt:null};sqlite.prepare('UPDATE evidence_records SET payload_json=?,content_hash=?').run(JSON.stringify(bad),await contentHash(canonical(bad)));}await assert.rejects(readEvidenceSnapshot(db,'synthetic-a',now));}finally{sqlite.close();}
 }
});
test('workspace revision changes retry a torn read, then return the stable updated view',async()=>{
 const {db,sqlite}=await fixture();try{await seedEvidence(db);let reads=0,changed=false;const wrapped=intercept(db,sql=>{if(sql.startsWith('SELECT content, revision'))reads++;if(!changed&&sql.includes('FROM evidence_versions')){changed=true;sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run('synthetic-a');}});const snapshot=await readEvidenceSnapshot(wrapped,'synthetic-a',now);assert.equal(snapshot.revision,2);assert.ok(reads>=4);}finally{sqlite.close();}
});
test('operational module CAS changes are detected even without a workspace revision bump',async()=>{
 const {db,sqlite}=await fixture();try{await seedEvidence(db);let visits=0;const wrapped=intercept(db,sql=>{if(sql.includes('FROM evidence_records')){visits++;if(visits===2)sqlite.prepare('UPDATE evidence_records SET row_revision=row_revision+1 WHERE user_id=?').run('synthetic-a');}});const result=await readEvidenceSnapshot(wrapped,'synthetic-a',now);assert.equal(result.revision,1);assert.ok(visits>=4);}finally{sqlite.close();}
});
test('continuously changing metadata stops after at most three snapshot attempts',async()=>{
 const {db,sqlite}=await fixture();try{await seedEvidence(db);let visits=0;const wrapped=intercept(db,sql=>{if(sql.includes('FROM evidence_records')){visits++;sqlite.prepare('UPDATE evidence_records SET row_revision=row_revision+1 WHERE user_id=?').run('synthetic-a');}});await assert.rejects(readEvidenceSnapshot(wrapped,'synthetic-a',now),/changed during/);assert.equal(visits,6);}finally{sqlite.close();}
});
test('aggregate 8 MB read bound and invalid owner/time reject without returning partial metadata',async()=>{
 const {db,sqlite}=await fixture();try{await assert.rejects(readEvidenceSnapshot(db,'',now),/authenticated owner/);await assert.rejects(readEvidenceSnapshot(db,'synthetic-a','not-a-time'));sqlite.prepare('INSERT INTO decisions(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('synthetic-a','too-large',JSON.stringify({legacy:'x'.repeat(8_000_000)}),'legacy');await assert.rejects(readEvidenceSnapshot(db,'synthetic-a',now),/bounded read/);}finally{sqlite.close();}
});

test('aggregate 10,000-row bound spans the complete owner snapshot rather than each table separately',async()=>{
 const {db,sqlite}=await fixture();try{const insert=sqlite.prepare('INSERT INTO decisions(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)');sqlite.exec('BEGIN');for(let index=0;index<10001;index++)insert.run('synthetic-a',`legacy-${String(index).padStart(5,'0')}`,'{}','legacy');sqlite.exec('COMMIT');await assert.rejects(readEvidenceSnapshot(db,'synthetic-a',now),/bounded read/);}finally{sqlite.close();}
});
