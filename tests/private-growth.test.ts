import {PRIVATE_PROFILE_TABLES} from '../lib/private-profile.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createPrivateGrowthContext,privateInsertGrowth,privateUpdateGrowth,combinePrivateGrowth} from '../lib/private-growth.ts';
import {privateRowGrowth} from '../lib/private-capacity.ts';
test('native schema hydration counts escaped UTF8 full defaults exactly, excluding only owner identity',async t=>{
 const f=database();t.after(()=>f.sqlite.close());
 const input={intent_id:'synthetic-intent',configuration_hash:'a'.repeat(64)},growth=await privateInsertGrowth(f.db,'integration_jobs',input);
 const full={intent_id:input.intent_id,source_id:null,job_subject_kind:'source',subject_id:null,schedule_id:null,schedule_configuration_hash:null,occurrence_due_at:null,configuration_hash:input.configuration_hash,operational_revision:1,lease_token:null,lease_expires_at:null,lease_access_mode:null,lease_principal_ref:null,attempt_count:0,retry_after:null};
 assert.deepEqual(growth,privateRowGrowth('integration_jobs',null,full));
 const escaped=await privateInsertGrowth(f.db,'workspace_drafts',{id:'synthetic-draft',row_revision:1,payload_json:'Arabic نص \\"escaped\\"',expires_at:'2026-10-19T12:00:00.000Z'});
 assert.deepEqual(escaped,privateRowGrowth('workspace_drafts',null,{id:'synthetic-draft',row_revision:1,payload_json:'Arabic نص \\"escaped\\"',expires_at:'2026-10-19T12:00:00.000Z'}));
});
test('unknown schema/default/columns/nonfinite data and missing required physical fields fail closed',async t=>{
 const f=database();t.after(()=>f.sqlite.close());
 await assert.rejects(()=>privateInsertGrowth(f.db,'workspace_drafts',{id:'x',row_revision:1,payload_json:'{}',expires_at:'x',unknown:'reject'}));
 await assert.rejects(()=>privateInsertGrowth(f.db,'workspace_drafts',{id:'x'}));
 await assert.rejects(()=>privateInsertGrowth(f.db,'workspace_drafts',{id:'x',row_revision:Infinity,payload_json:'{}',expires_at:'x'}));
 f.sqlite.exec('ALTER TABLE workspace_drafts ADD COLUMN unexpected TEXT');await assert.rejects(()=>privateInsertGrowth(f.db,'workspace_drafts',{id:'x',row_revision:1,payload_json:'{}',expires_at:'x'}));
 const other=database();t.after(()=>other.sqlite.close());const actual=other.db;
 const changed={...actual,prepare(sql:string){const statement=actual.prepare(sql);if(sql!=='PRAGMA table_info(integration_jobs)')return statement;return {...statement,async all<T>(){const rows=await statement.all<Record<string,unknown>>();return {...rows,results:rows.results.map(row=>row.name==='attempt_count'?{...row,dflt_value:'random()'}:row) as T[]};}};}};
 await assert.rejects(()=>privateInsertGrowth(changed,'integration_jobs',{intent_id:'x',configuration_hash:'a'.repeat(64)}));
});
test('update quotes conservative full after rows, rejects absence, and combines one growth entry per table without delete credit',async t=>{
 const f=database();t.after(()=>f.sqlite.close());f.sqlite.prepare('INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,?,?,?)').run('owner','draft',1,'large previous value','later');
 const quote=await privateUpdateGrowth(f.db,'owner','workspace_drafts','id=?',['draft'],{payload_json:'x'});
 assert.equal(quote.rows,0);assert.ok(quote.bytes>0);
 await assert.rejects(()=>privateUpdateGrowth(f.db,'foreign','workspace_drafts','id=?',['draft'],{payload_json:'x'}));
 assert.deepEqual(combinePrivateGrowth(quote,quote),[{table:'workspace_drafts',bytes:quote.bytes*2,rows:0}]);
 assert.throws(()=>combinePrivateGrowth({...quote,bytes:-1}));assert.throws(()=>combinePrivateGrowth({...quote,rows:Number.MAX_SAFE_INTEGER},{...quote,rows:1}));
});

test('growth hydration reuses only immutable schema metadata and invalidates it when actual schema changes',async t=>{
 const f=database();t.after(()=>f.sqlite.close());let pragmas=0;
 const db={...f.db,prepare(sql:string){if(sql.startsWith('PRAGMA table_info('))pragmas++;return f.db.prepare(sql);}};
 const input={id:'synthetic-draft',row_revision:1,payload_json:'{}',expires_at:'later'};
 const one=await privateInsertGrowth(db,'workspace_drafts',input),loaded=pragmas;assert.equal(loaded,PRIVATE_PROFILE_TABLES.length);
 const two=await privateInsertGrowth(db,'workspace_drafts',input);assert.deepEqual(two,one);assert.equal(pragmas,loaded);
 f.sqlite.exec('ALTER TABLE workspace_drafts ADD COLUMN unexpected_cache_change TEXT');
 await assert.rejects(()=>privateInsertGrowth(db,'workspace_drafts',input));assert.ok(pragmas>loaded);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_drafts').get()!.n,0);
});

test('one operation reuses only branded schema metadata and its exact guard fences late schema change',async t=>{
 const f=database();t.after(()=>f.sqlite.close());let fingerprints=0;
 const db={...f.db,prepare(sql:string){if(sql.includes('sqlite_master'))fingerprints++;return f.db.prepare(sql);}};
 const context=await createPrivateGrowthContext(db),reads=fingerprints;assert.ok(reads>0);assert.ok(Object.isFrozen(context));assert.ok(Object.isFrozen(context.guard.bindings));
 const input={id:'synthetic-context',row_revision:1,payload_json:'{}',expires_at:'later'};
 await privateInsertGrowth(db,'workspace_drafts',input,context);await privateInsertGrowth(db,'workspace_drafts',{...input,id:'synthetic-context-two'},context);assert.equal(fingerprints,reads);
 for(let index=0;index<3;index++)f.sqlite.prepare('INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,1,?,?)').run('owner','draft-'+index,'Arabic نص '+index,'later');
 const update=await privateUpdateGrowth(db,'owner','workspace_drafts','id LIKE ?',['draft-%'],{payload_json:'new'},false,context);assert.equal(update.rows,0);assert.ok(update.bytes>0);assert.equal(fingerprints,reads);
 await assert.rejects(()=>privateInsertGrowth(db,'workspace_drafts',input,{...context}));
 await assert.rejects(()=>privateInsertGrowth(f.db,'workspace_drafts',input,context));
 assert.ok(await db.prepare('SELECT 1 WHERE '+context.guard.sql).bind(...context.guard.bindings).first());
 f.sqlite.exec('ALTER TABLE workspace_drafts ADD COLUMN late_schema_change TEXT');
 const result=await db.prepare('UPDATE workspace_drafts SET row_revision=row_revision+1 WHERE user_id=? AND '+context.guard.sql).bind('owner',...context.guard.bindings).run();assert.equal(result.meta.changes,0);
 assert.equal(f.sqlite.prepare('SELECT MAX(row_revision) revision FROM workspace_drafts').get()!.revision,1);
});
test('standalone multirow UPDATE hydrates schema once rather than once per owner row',async t=>{
 const f=database();t.after(()=>f.sqlite.close());for(let index=0;index<4;index++)f.sqlite.prepare('INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,1,?,?)').run('owner','draft-'+index,'original','later');
 let fingerprints=0;const db={...f.db,prepare(sql:string){if(sql.includes('sqlite_master'))fingerprints++;return f.db.prepare(sql);}};
 await privateUpdateGrowth(db,'owner','workspace_drafts','id LIKE ?',['draft-%'],{payload_json:'new'});assert.equal(fingerprints,1);
});
