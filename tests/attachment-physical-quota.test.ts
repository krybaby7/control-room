import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {readPhysicalAttachmentUsage,reserveArchiveObjects,ArchiveObjectReservationError,type ArchiveObjectReservation} from '../lib/attachment-physical-quota.ts';
import {attachmentStorageKey} from '../lib/attachments.ts';
import {ATTACHMENT_POLICY} from '../lib/attachment-policy.ts';
const now='2026-10-18T12:00:00.000Z',expires='2026-10-18T13:00:00.000Z';
async function fixture(){const f=database();for(const owner of ['a','b'])await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);return f;}
function input(records:Array<{id:string;bytes:number;sha256:string}>=[{id:crypto.randomUUID(),bytes:5,sha256:'a'.repeat(64)}]):ArchiveObjectReservation{return {stageId:crypto.randomUUID(),namespace:crypto.randomUUID(),sourceManifestHash:'b'.repeat(64),manifestJson:'{"format":"synthetic-test-manifest"}',createdAt:now,expiresAt:expires,targetRevision:1,records};}
function state(sqlite:ReturnType<typeof database>['sqlite']){return Object.fromEntries(['attachment_archive_stages','attachment_blob_namespaces','attachment_blob_objects','attachment_blob_fences','workspaces','workspace_mutations','audit_events','workspace_assertions'].map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));}
function object(sqlite:ReturnType<typeof database>['sqlite'],owner:string,size:number,extra:{purged?:boolean;namespace?:string;id?:string}={}){const namespace=extra.namespace??crypto.randomUUID(),id=extra.id??crypto.randomUUID();sqlite.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,NULL,?,NULL,?)').run(owner,attachmentStorageKey(namespace,id),id,namespace,size,'2020-01-01T00:00:00.000Z',extra.purged?now:null);return {namespace,id};}

test('archive reservation atomically charges physical objects and stage namespace without changing owner planning or mutation history',async()=>{
 const {db,sqlite}=await fixture();try{const before=state(sqlite),value=input([{id:crypto.randomUUID(),bytes:7,sha256:'a'.repeat(64)},{id:crypto.randomUUID(),bytes:0,sha256:'b'.repeat(64)}]);const reserved=await reserveArchiveObjects(db,'a',value);assert.deepEqual(reserved.usage,{bytes:7,files:2});assert.equal(reserved.records[0].storageKey,attachmentStorageKey(value.namespace,value.records[0].id));assert.deepEqual(state(sqlite).workspaces,before.workspaces);assert.deepEqual(state(sqlite).workspace_mutations,before.workspace_mutations);assert.deepEqual(state(sqlite).audit_events,before.audit_events);assert.deepEqual(state(sqlite).workspace_assertions,[]);const stage=sqlite.prepare('SELECT * FROM attachment_archive_stages').get()!;assert.equal(stage.status,'preparing');assert.equal(stage.manifest_json,value.manifestJson);assert.equal(stage.source_manifest_hash,value.sourceManifestHash);assert.equal(stage.import_id,null);assert.equal(sqlite.prepare('SELECT purpose FROM attachment_blob_namespaces').get()!.purpose,'archive-stage');for(const row of sqlite.prepare('SELECT * FROM attachment_blob_objects').all()){assert.equal(row.verified_at,null);assert.equal(row.purged_at,null);}assert.deepEqual(await readPhysicalAttachmentUsage(db,'b'),{bytes:0,files:0});}finally{sqlite.close();}
});

test('expired/failed stage objects and retired metadata stay charged until physical purge; over-limit reads remain honest and readonly',async()=>{
 const {db,sqlite}=await fixture();try{const expired=input();expired.createdAt='2020-01-01T00:00:00.000Z';expired.expiresAt='2020-01-01T01:00:00.000Z';await reserveArchiveObjects(db,'a',expired);sqlite.prepare("UPDATE attachment_archive_stages SET status='failed'").run();object(sqlite,'a',20);object(sqlite,'a',50,{purged:true});object(sqlite,'b',ATTACHMENT_POLICY.ownerBytes+1);const changes=sqlite.prepare('SELECT total_changes() AS n').get()!.n;assert.deepEqual(await readPhysicalAttachmentUsage(db,'a'),{bytes:25,files:2});assert.deepEqual(await readPhysicalAttachmentUsage(db,'b'),{bytes:ATTACHMENT_POLICY.ownerBytes+1,files:1});assert.equal(sqlite.prepare('SELECT total_changes() AS n').get()!.n,changes);const before=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'b',input()),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);}finally{sqlite.close();}
});

test('count and byte headroom are enforced atomically including expired objects and owner-isolated capacity',async()=>{
 const {db,sqlite}=await fixture();try{object(sqlite,'a',ATTACHMENT_POLICY.ownerBytes-5);await reserveArchiveObjects(db,'a',input());assert.deepEqual(await readPhysicalAttachmentUsage(db,'a'),{bytes:ATTACHMENT_POLICY.ownerBytes,files:2});const before=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'a',input()),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);await reserveArchiveObjects(db,'b',input());assert.deepEqual(await readPhysicalAttachmentUsage(db,'b'),{bytes:5,files:1});}finally{sqlite.close();}
 const f=await fixture();try{for(let n=0;n<499;n++)object(f.sqlite,'a',0);const before=state(f.sqlite);await assert.rejects(reserveArchiveObjects(f.db,'a',input([{id:crypto.randomUUID(),bytes:0,sha256:'a'.repeat(64)},{id:crypto.randomUUID(),bytes:0,sha256:'a'.repeat(64)}])),ArchiveObjectReservationError);assert.deepEqual(state(f.sqlite),before);await reserveArchiveObjects(f.db,'a',input([{id:crypto.randomUUID(),bytes:0,sha256:'a'.repeat(64)}]));assert.deepEqual(await readPhysicalAttachmentUsage(f.db,'a'),{bytes:0,files:500});}finally{f.sqlite.close();}
});

test('active archive stage cap counts preparing and verified only until expiry',async()=>{
 const {db,sqlite}=await fixture();try{for(let n=0;n<8;n++){const value=input([]);await reserveArchiveObjects(db,'a',value);if(n%2)sqlite.prepare("UPDATE attachment_archive_stages SET status='verified' WHERE user_id='a' AND id=?").run(value.stageId);}const before=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'a',input([])),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);sqlite.prepare("UPDATE attachment_archive_stages SET expires_at=? WHERE id=(SELECT id FROM attachment_archive_stages LIMIT 1)").run(now);await reserveArchiveObjects(db,'a',input([]));assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM attachment_archive_stages').get()!.n,9);}finally{sqlite.close();}
});

test('stale workspace revision and late quota races reject without any reservation effects',async()=>{
 const {db,sqlite}=await fixture();try{const stale=input();stale.targetRevision=2;const before=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'a',stale),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);let afterRace:ReturnType<typeof state>|undefined;const raced:SqlDatabase={...db,async batch(statements){object(sqlite,'a',ATTACHMENT_POLICY.ownerBytes);afterRace=state(sqlite);return db.batch(statements);}};await assert.rejects(reserveArchiveObjects(raced,'a',input()),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),afterRace);}finally{sqlite.close();}
});

for(const table of ['attachment_archive_stages','attachment_blob_namespaces','attachment_blob_objects'] as const)test(`injected ${table} write failure rolls the entire reservation back`,async()=>{
 const {db,sqlite}=await fixture();try{sqlite.exec(`CREATE TRIGGER fail_reservation BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic reservation failure'); END;`);const before=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'a',input()),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);}finally{sqlite.close();}
});

test('stage IDs, namespace reuse across owners and retained ID/key fences never admit object reservations',async()=>{
 const {db,sqlite}=await fixture();try{const used=input();await reserveArchiveObjects(db,'a',used);for(const [owner,value]of [['a',{...input(),stageId:used.stageId}],['b',{...input(),namespace:used.namespace}]]as const){const before=state(sqlite);await assert.rejects(reserveArchiveObjects(db,owner,value),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);}
 const value=input(),fencedId=value.records[0].id;sqlite.prepare('INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) VALUES(?,?,?,?,?,?,?)').run('a',attachmentStorageKey(crypto.randomUUID(),fencedId),fencedId,crypto.randomUUID(),'permanent-fence-token',now,now);const before=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'a',value),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);
 const keyFence=input();sqlite.prepare('INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) VALUES(?,?,?,?,?,?,NULL)').run('b',attachmentStorageKey(keyFence.namespace,keyFence.records[0].id),crypto.randomUUID(),crypto.randomUUID(),'foreign-key-fence',now);const fenced=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'a',keyFence),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),fenced);
 }finally{sqlite.close();}
});

test('strict reservation validation rejects forged extras, duplicate records, unsafe TTL and oversized UTF-8 manifests before writes',async()=>{
 const {db,sqlite}=await fixture();try{const good=input(),before=state(sqlite);for(const value of [{...good,owner:'forged'},{...good,stageId:'not-a-uuid'},{...good,namespace:good.stageId},{...good,records:[good.records[0],good.records[0]]},{...good,records:[{...good.records[0],bytes:-1}]},{...good,records:[{...good.records[0],bytes:ATTACHMENT_POLICY.fileBytes+1}]},{...good,records:[{...good.records[0],sha256:'bad'}]},{...good,expiresAt:now},{...good,expiresAt:'2026-10-18T13:00:00.001Z'},{...good,createdAt:'2026-02-31T12:00:00.000Z'},{...good,manifestJson:'[]'},{...good,manifestJson:'{malformed'},{...good,manifestJson:JSON.stringify({text:'é'.repeat(4_000_000)})}]){await assert.rejects(reserveArchiveObjects(db,'a',value as ArchiveObjectReservation));assert.deepEqual(state(sqlite),before);}await assert.rejects(readPhysicalAttachmentUsage(db,''));await assert.rejects(reserveArchiveObjects(db,'',good));}finally{sqlite.close();}
});

test('maximum-size record selection admits all 500 objects in one bounded batch without truncation',async()=>{
 const {db,sqlite}=await fixture();try{const records=Array.from({length:500},()=>({id:crypto.randomUUID(),bytes:0,sha256:'a'.repeat(64)}));let calls=0;const measured:SqlDatabase={...db,async batch(statements){calls++;assert.ok(statements.length<40,'bulk reservation keeps statement count bounded independently of attachment count');return db.batch(statements);}};const result=await reserveArchiveObjects(measured,'a',input(records));assert.equal(calls,1);assert.equal(result.records.length,500);assert.deepEqual(await readPhysicalAttachmentUsage(db,'a'),{bytes:0,files:500});assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_assertions').get()!.n,0);}finally{sqlite.close();}
});

test('invalid charged-byte metadata cannot create apparent quota headroom',async()=>{
 const {db,sqlite}=await fixture();try{object(sqlite,'a',-5);const before=state(sqlite);await assert.rejects(readPhysicalAttachmentUsage(db,'a'),/unavailable/);await assert.rejects(reserveArchiveObjects(db,'a',input()),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);}finally{sqlite.close();}
});

test('existing attachment identity cannot change immutable length or known digest under a fresh namespace',async()=>{
 const {db,sqlite}=await fixture();try{const id=crypto.randomUUID();object(sqlite,'a',5,{id});sqlite.prepare('UPDATE attachment_blob_objects SET sha256=? WHERE user_id=? AND attachment_id=?').run('a'.repeat(64),'a',id);const before=state(sqlite);
 for(const record of [{id,bytes:6,sha256:'a'.repeat(64)},{id,bytes:5,sha256:'b'.repeat(64)}]){await assert.rejects(reserveArchiveObjects(db,'a',input([record])),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);}
 }finally{sqlite.close();}
});

test('identical fresh copies preserve logical identity while charging every unpurged physical key',async()=>{
 const {db,sqlite}=await fixture();try{const id=crypto.randomUUID(),record={id,bytes:5,sha256:'a'.repeat(64)};object(sqlite,'a',5,{id});sqlite.prepare('UPDATE attachment_blob_objects SET sha256=? WHERE user_id=? AND attachment_id=?').run(record.sha256,'a',id);await reserveArchiveObjects(db,'a',input([record]));await reserveArchiveObjects(db,'a',input([record]));assert.deepEqual(await readPhysicalAttachmentUsage(db,'a'),{bytes:15,files:3});assert.equal(sqlite.prepare('SELECT COUNT(DISTINCT storage_key) AS n FROM attachment_blob_objects WHERE user_id=? AND attachment_id=?').get('a',id)!.n,3);assert.ok(sqlite.prepare('SELECT source_import_id FROM attachment_blob_namespaces').all().every(row=>row.source_import_id===null),'archive stages are not metadata import identities');
 }finally{sqlite.close();}
});

test('purged identity remains binding and nullable historical digest permits only identical byte length',async()=>{
 const {db,sqlite}=await fixture();try{const known=crypto.randomUUID();object(sqlite,'a',5,{id:known,purged:true});sqlite.prepare('UPDATE attachment_blob_objects SET sha256=? WHERE user_id=? AND attachment_id=?').run('a'.repeat(64),'a',known);assert.deepEqual(await readPhysicalAttachmentUsage(db,'a'),{bytes:0,files:0});const before=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'a',input([{id:known,bytes:5,sha256:'b'.repeat(64)}])),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),before);
 const unknown=crypto.randomUUID();object(sqlite,'a',7,{id:unknown,purged:true});await reserveArchiveObjects(db,'a',input([{id:unknown,bytes:7,sha256:'c'.repeat(64)}]));assert.deepEqual(await readPhysicalAttachmentUsage(db,'a'),{bytes:7,files:1});const after=state(sqlite);await assert.rejects(reserveArchiveObjects(db,'a',input([{id:unknown,bytes:8,sha256:'c'.repeat(64)}])),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),after);
 }finally{sqlite.close();}
});

test('a conflicting identity inserted immediately before the reservation batch prevents every staged write',async()=>{
 const {db,sqlite}=await fixture();try{const value=input();let afterRace:ReturnType<typeof state>|undefined;const raced:SqlDatabase={...db,async batch(statements){object(sqlite,'a',value.records[0].bytes,{id:value.records[0].id});sqlite.prepare('UPDATE attachment_blob_objects SET sha256=? WHERE user_id=? AND attachment_id=?').run('c'.repeat(64),'a',value.records[0].id);afterRace=state(sqlite);return db.batch(statements);}};await assert.rejects(reserveArchiveObjects(raced,'a',value),ArchiveObjectReservationError);assert.deepEqual(state(sqlite),afterRace);
 }finally{sqlite.close();}
});
