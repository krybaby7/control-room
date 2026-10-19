import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
const now='2026-10-18T12:00:00.000Z';
const migrationRoot=new URL('../drizzle/',import.meta.url);
const names=()=>readdirSync(migrationRoot).filter(name=>name.endsWith('.sql')).sort();
function migrationFixture(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const name of names().filter(name=>Number(name.slice(0,4))<=7))db.exec(readFileSync(new URL(name,migrationRoot),'utf8'));return db;}
function upgrade(db:DatabaseSync){for(const name of names().filter(name=>Number(name.slice(0,4))>=8))db.exec(readFileSync(new URL(name,migrationRoot),'utf8'));}
function audit(db:DatabaseSync,owner:string,id:string,ordinal:number,payload:string,kind='task.update',entityType='task',entityId:string|null='task-legacy'){
 db.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,?,NULL,NULL,?,?,?,?,?)').run(owner,id,ordinal,kind,entityType,entityId,now,payload);
}
const normalized=['evidence_records','evidence_links','decisions','attachments'] as const;

test('Phase3 migration preserves legacy owner IDs, payload bytes, hashes and revisions while projecting only known audit metadata',()=>{
 const db=migrationFixture();try{
  for(const owner of ['owner-a','owner-b'])for(const table of normalized)db.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,?,?,?)`).run(owner,'same-original-id',7,` { "legacy": "${owner}:${table}", "unrecognized": [1, null] } `,'legacy-hash-kept');
  const canonical=JSON.stringify({origin:'owner',actorId:'owner-a',sourceRef:'synthetic-source',undoOf:'prior-event',changes:[{path:['tasks','task-legacy'],before:{exists:true,value:{projectId:'previous-project'}},after:{exists:true,value:{projectId:'next-project'}}}]});
  audit(db,'owner-a','canonical-event',0,canonical);audit(db,'owner-a','unknown-origin',1,JSON.stringify({origin:'unrecognized-legacy-origin',actorId:42,sourceRef:{invalid:true},undoOf:false}));audit(db,'owner-a','malformed-event',2,'{ malformed legacy JSON');
  audit(db,'owner-a','imported-claim',3,JSON.stringify({sourceClaim:{origin:'owner',actorId:'foreign-claim',projectId:'forged-project',changes:[{after:{value:{projectId:'another-forged-project'}}}]}}),'imported-history','historical-claim',null);
  audit(db,'owner-a','project-event',4,JSON.stringify({origin:'system'}),'project.archive','project','direct-project');audit(db,'owner-b','canonical-event',0,JSON.stringify({origin:'connector',actorId:'connector-principal',projectId:'owner-b-project'}));
  const prior=new Map(normalized.map(table=>[table,db.prepare(`SELECT user_id,id,row_revision,payload_json,content_hash FROM ${table} ORDER BY user_id,id`).all()]));const oldAudit=db.prepare('SELECT user_id,event_id,payload_json FROM audit_events ORDER BY user_id,event_id').all();upgrade(db);
  for(const table of normalized)assert.deepEqual(db.prepare(`SELECT user_id,id,row_revision,payload_json,content_hash FROM ${table} ORDER BY user_id,id`).all(),prior.get(table));assert.deepEqual(db.prepare('SELECT user_id,event_id,payload_json FROM audit_events ORDER BY user_id,event_id').all(),oldAudit);
  assert.deepEqual({...db.prepare('SELECT origin,actor_id,source_ref,undo_of FROM audit_events WHERE user_id=? AND event_id=?').get('owner-a','canonical-event')},{origin:'owner',actor_id:'owner-a',source_ref:'synthetic-source',undo_of:'prior-event'});
  for(const event of ['unknown-origin','malformed-event','imported-claim'])assert.deepEqual({...db.prepare('SELECT origin,actor_id,source_ref,undo_of FROM audit_events WHERE user_id=? AND event_id=?').get('owner-a',event)},{origin:null,actor_id:null,source_ref:null,undo_of:null});
  for(const owner of ['owner-a','owner-b'])assert.deepEqual({...db.prepare('SELECT evidence_id,evidence_version,subject_type,subject_id,requirement_id,relation FROM evidence_links WHERE user_id=?').get(owner)},{evidence_id:null,evidence_version:null,subject_type:null,subject_id:null,requirement_id:null,relation:null},'legacy link payloads do not acquire invented typed mirrors');
  assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const projects=(owner:string,event:string)=>db.prepare('SELECT project_id FROM audit_project_links WHERE user_id=? AND event_id=? ORDER BY project_id').all(owner,event).map(row=>row.project_id);
  assert.deepEqual(projects('owner-a','canonical-event'),['next-project','previous-project']);assert.deepEqual(projects('owner-a','project-event'),['direct-project']);assert.deepEqual(projects('owner-a','imported-claim'),[]);assert.deepEqual(projects('owner-b','canonical-event'),['owner-b-project']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_source_namespaces').get()!.n,0,'private namespaces are not inferred from legacy owner payloads');
 }finally{db.close();}
});

test('canonical scalar project move audit backfill indexes both prior and next projects',()=>{
 const db=migrationFixture();try{audit(db,'owner-a','scalar-move',0,JSON.stringify({origin:'owner',actorId:'owner-a',changes:[{path:['tasks','task-legacy','projectId'],before:{exists:true,value:'previous-project'},after:{exists:true,value:'next-project'}}]}),'task.move');upgrade(db);assert.deepEqual(db.prepare('SELECT project_id FROM audit_project_links WHERE user_id=? AND event_id=? ORDER BY project_id').all('owner-a','scalar-move').map(row=>row.project_id),['next-project','previous-project']);}finally{db.close();}
});

test('version uniqueness and foreign keys bind evidence and decision parents to the same owner',()=>{
 const db=migrationFixture();upgrade(db);try{
  for(const owner of ['owner-a','owner-b'])db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash,current_version) VALUES(?,?,1,?,?,1)').run(owner,'evidence-shared','{}','head-hash');
  const evidenceVersion=db.prepare('INSERT INTO evidence_versions(user_id,id,row_revision,payload_json,content_hash,evidence_id,version,recorded_at) VALUES(?,?,1,?,?,?,?,?)');
  evidenceVersion.run('owner-a','version-shared','{}','hash','evidence-shared',1,now);evidenceVersion.run('owner-b','version-shared','{}','hash','evidence-shared',1,now);
  assert.throws(()=>evidenceVersion.run('owner-a','different-row','{}','hash','evidence-shared',1,now),/UNIQUE constraint/);
  db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('owner-b','foreign-only','{}','hash');assert.throws(()=>evidenceVersion.run('owner-a','foreign-version','{}','hash','foreign-only',1,now),/FOREIGN KEY constraint/);
  for(const owner of ['owner-a','owner-b'])db.prepare('INSERT INTO decision_records(user_id,id,row_revision,payload_json,content_hash,current_version) VALUES(?,?,1,?,?,1)').run(owner,'decision-shared','{}','head-hash');
  const decisionVersion=db.prepare('INSERT INTO decision_versions(user_id,id,row_revision,payload_json,content_hash,decision_id,version,recorded_at,status) VALUES(?,?,1,?,?,?,?,?,?)');
  decisionVersion.run('owner-a','version-shared','{}','hash','decision-shared',1,now,'draft');decisionVersion.run('owner-b','version-shared','{}','hash','decision-shared',1,now,'draft');assert.throws(()=>decisionVersion.run('owner-a','different-row','{}','hash','decision-shared',1,now,'draft'),/UNIQUE constraint/);
  db.prepare('INSERT INTO decision_records(user_id,id,row_revision,payload_json,content_hash,current_version) VALUES(?,?,1,?,?,1)').run('owner-b','foreign-decision','{}','hash');assert.throws(()=>decisionVersion.run('owner-a','foreign-version','{}','hash','foreign-decision',1,now,'draft'),/FOREIGN KEY constraint/);
  audit(db,'owner-a','scoped-event',0,'{}');assert.throws(()=>db.prepare('INSERT INTO audit_project_links(user_id,event_id,project_id) VALUES(?,?,?)').run('owner-b','scoped-event','project'),/FOREIGN KEY constraint/);
  // Immutability remains a compiler contract; these assertions concern actual DB uniqueness/FKs only.
 }finally{db.close();}
});

test('malformed legacy audit change shapes survive upgrade without interpreting primitive or encoded project claims',()=>{
 const db=migrationFixture();try{
  const payloads=[JSON.stringify({changes:['ordinary text','{"path":["projectId"],"after":{"value":"encoded-project"}}',7,null,true,['projectId','nested-project'],[],{path:'projectId',after:{value:'scalar-path-project'}},{path:['unrelated'],after:{value:'not-a-project'}}]},null,2),JSON.stringify({changes:'not-an-array'}),JSON.stringify({changes:null}),JSON.stringify(['untyped','legacy','audit'])];
  payloads.forEach((payload,index)=>audit(db,'owner-a',`malformed-shape-${index}`,index,payload));const before=db.prepare('SELECT event_id,payload_json FROM audit_events ORDER BY event_id').all();upgrade(db);assert.deepEqual(db.prepare('SELECT event_id,payload_json FROM audit_events ORDER BY event_id').all(),before);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_project_links').get()!.n,0);for(let index=0;index<payloads.length;index++)assert.equal(db.prepare('SELECT origin FROM audit_events WHERE event_id=?').get(`malformed-shape-${index}`)!.origin,null);
 }finally{db.close();}
});

test('evidence link rebuild preserves unknown legacy mirrors and enforces exact owner/version foreign keys with foreign keys enabled',()=>{
 const db=migrationFixture();try{
  const legacyPayload=' { "oldLink": "unchanged bytes", "opaqueReference": null } ';db.prepare('INSERT INTO evidence_links(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,7,?,?)').run('owner-a','legacy-link',legacyPayload,'old-hash');upgrade(db);assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);const legacy=db.prepare('SELECT * FROM evidence_links WHERE user_id=? AND id=?').get('owner-a','legacy-link')!;assert.equal(legacy.payload_json,legacyPayload);assert.equal(legacy.row_revision,7);assert.equal(legacy.content_hash,'old-hash');for(const key of ['evidence_id','evidence_version','subject_type','subject_id','requirement_id','relation'])assert.equal(legacy[key],null,key);
  for(const owner of ['owner-a','owner-b'])db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash,current_version) VALUES(?,?,1,?,?,1)').run(owner,'same-evidence','{}','hash');
  const version=db.prepare('INSERT INTO evidence_versions(user_id,id,row_revision,payload_json,content_hash,evidence_id,version,recorded_at) VALUES(?,?,1,?,?,?,?,?)');version.run('owner-a','owner-a-version','{}','hash','same-evidence',1,now);version.run('owner-b','owner-b-version','{}','hash','same-evidence',2,now);
  db.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('owner-b','foreign-only','{}','hash');version.run('owner-b','foreign-version','{}','hash','foreign-only',1,now);
  const link=db.prepare('INSERT INTO evidence_links(user_id,id,row_revision,payload_json,content_hash,evidence_id,evidence_version,subject_type,subject_id,relation) VALUES(?,?,1,?,?,?,?,?,?,?)');const insert=(owner:string,key:string,evidenceId:string,evidenceVersion:number)=>link.run(owner,key,JSON.stringify({id:key,evidenceId,evidenceVersion,subject:{type:'task',id:'synthetic-task'},requirementId:null,relation:'supports'}),'hash',evidenceId,evidenceVersion,'task','synthetic-task','supports');
  assert.throws(()=>insert('owner-a','wrong-owner','foreign-only',1),/FOREIGN KEY constraint/);assert.throws(()=>insert('owner-a','foreign-version-only','same-evidence',2),/FOREIGN KEY constraint/);assert.throws(()=>insert('owner-a','missing-version','same-evidence',99),/FOREIGN KEY constraint/);insert('owner-a','correct-a','same-evidence',1);insert('owner-b','correct-b','same-evidence',2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_links').get()!.n,3);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
