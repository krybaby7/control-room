import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {readOperationalHealth,handleOperationalHealth} from '../lib/operational-health.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {sourceConfigurationHash} from '../lib/background/job-store.ts';
import type {SourceConnection,SourceTarget} from '../lib/sources/contracts.ts';
const now='2026-10-19T12:00:00.000Z',old='2026-10-17T12:00:00.000Z';
async function exercise(db:SqlDatabase){
 await loadWorkspace(db,'health-owner',()=>workspaceFixture(),now);await loadWorkspace(db,'foreign-owner',()=>workspaceFixture(),now);
 const initial=await readOperationalHealth(db,'health-owner',now);assert.ok(initial.conditions.includes('backup_missing'));assert.equal(initial.backup.freshReadbackPerformed,false);assert.equal(initial.externalDelivery,'disabled');assert.equal(initial.readinessGuarantee,false);
 const connection:SourceConnection={id:'synthetic-connection',provider:'github',label:'Private secret label',accessMode:'interactive',enabled:true,archivedAt:null},target:SourceTarget={id:'synthetic-source',connectionId:connection.id,projectId:'p1',kind:'github_repository',providerResourceId:'private/resource',canonicalUrl:null,selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null};
 for(const [table,value] of [['source_connections',connection],['source_targets',target]] as const){const columns=moduleColumnNames(table),projection=await moduleProjection(table,value.id,value as unknown as JsonValue);await db.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash,${columns.join(',')}) VALUES(?,?,1,?,?,${columns.map(()=>'?').join(',')})`).bind('health-owner',value.id,canonical(value),await contentHash(canonical(value)),...columns.map(column=>projection[column])).run();}
 const config=await sourceConfigurationHash(connection,target);
 await db.prepare('INSERT INTO source_sync_state(user_id,source_id,operational_revision,configuration_hash,execution_epoch,paused,last_success_at,attempted_at) VALUES(?,?,1,?,0,0,?,?)').bind('health-owner',target.id,config,old,now).run();
 await db.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'source_refresh',?,'{}',?,'pending',0,0)").bind('health-owner','private-intent','private-dedupe',old).run();
 // A catalog fixture is explicitly NOT an R2 verification or recoverability proof.
 await db.prepare("INSERT INTO workspace_backups(user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) VALUES(?,?,1,?,'manual',2,?,'{}','ready',1)").bind('health-owner','private-backup',old,'a'.repeat(64)).run();
 const warning=await readOperationalHealth(db,'health-owner',now);
 assert.deepEqual(warning.conditions,['backup_old','jobs_overdue','sources_stale']);assert.equal(warning.sources.stale,1);assert.equal(warning.sources.oldestRecordedSuccessAgeSeconds,172800);assert.equal(warning.jobs.oldestDueAgeSeconds,172800);assert.equal(warning.backup.coverage,'metadata-only');assert.equal(warning.externalDelivery,'disabled');
 // Same-ID READY archive flags must not borrow a different metadata identity.
 await db.prepare("INSERT INTO backup_archives(user_id,id,namespace,intent_id,source_revision,source_sha256,metadata_content,metadata_bytes,execution_epoch,status,created_at,updated_at,zip_bytes,files,file_bytes,chunk_count,index_json,index_sha256) VALUES(?,?,?, ?,1,?, ?,2,0,'ready',?,?,0,0,0,0,NULL,NULL)").bind('health-owner','private-backup','synthetic-health-archive-namespace','synthetic-health-archive-intent','b'.repeat(64),'{}',old,old).run();
 assert.equal((await readOperationalHealth(db,'health-owner',now)).backup.coverage,'unknown','same ID with a different source digest is not recorded matching coverage');
 await db.prepare('UPDATE backup_archives SET source_sha256=?,metadata_content=? WHERE user_id=?').bind('a'.repeat(64),'{"different":true}','health-owner').run();
 assert.equal((await readOperationalHealth(db,'health-owner',now)).backup.coverage,'unknown','same digest with different metadata content is not matching coverage');
 await db.prepare('UPDATE backup_archives SET metadata_content=? WHERE user_id=?').bind('{}','health-owner').run();
 const matched=await readOperationalHealth(db,'health-owner',now);assert.equal(matched.backup.coverage,'files-recorded');assert.equal(matched.backup.freshReadbackPerformed,false,'even matched catalog identity is not live physical proof');
 const text=JSON.stringify(warning);for(const secret of ['health-owner','private-intent','private-dedupe','private-backup','private/resource','Private secret label',target.id,connection.id,config])assert.equal(text.includes(secret),false);
 const foreign=await readOperationalHealth(db,'foreign-owner',now);assert.equal(foreign.sources.selected,0);assert.equal(foreign.jobs.duePendingOrRunning,0);assert.equal(foreign.backup.lastRecordedCompleteAt,null);
 await db.prepare('UPDATE source_sync_state SET last_success_at=? WHERE user_id=?').bind('2026-10-20T12:00:00.000Z','health-owner').run();
 await db.prepare('UPDATE workspace_backups SET created_at=? WHERE user_id=?').bind('not-a-time','health-owner').run();
 await db.prepare('UPDATE workspace_job_intents SET not_before=? WHERE user_id=?').bind('bad-clock','health-owner').run();
 const unknown=await readOperationalHealth(db,'health-owner',now);assert.equal(unknown.sources.unknown,1);assert.equal(unknown.sources.withinRecordedAge,0);assert.equal(unknown.backup.ageSeconds,null);assert.equal(unknown.jobs.unknownClockCount,1);assert.equal(unknown.jobs.oldestDueAgeSeconds,null);assert.ok(unknown.conditions.includes('backup_clock_unknown'));assert.ok(unknown.conditions.includes('source_age_unknown'));
 await db.prepare('UPDATE source_sync_state SET last_success_at=?,configuration_hash=? WHERE user_id=?').bind(now,'b'.repeat(64),'health-owner').run();assert.equal((await readOperationalHealth(db,'health-owner',now)).sources.unknown,1,'changed selection cannot borrow old success');
 await assert.rejects(readOperationalHealth(db,'missing-owner',now));await assert.rejects(readOperationalHealth(db,'',now));
 const auth=async()=>null;assert.equal((await handleOperationalHealth(new Request('https://private.test/api/health'),{db,authenticateOwner:auth,now:()=>now})).status,401);
 assert.equal((await handleOperationalHealth(new Request('https://private.test/api/health?owner=foreign-owner'),{db,authenticateOwner:async()=>'health-owner',now:()=>now})).status,400);
 assert.equal((await handleOperationalHealth(new Request('https://private.test/api/health',{method:'POST',body:'{}'}),{db,authenticateOwner:async()=>'health-owner'})).status,405);
 const response=await handleOperationalHealth(new Request('https://private.test/api/health'),{db,authenticateOwner:async()=>'foreign-owner',now:()=>now});assert.equal(response.status,200);assert.match(response.headers.get('cache-control')!,/no-store/);assert.equal((await response.json() as {sources:{selected:number}}).sources.selected,0);
}
test('native SQLite synthetic health alert conditions are owner-only read-only and never delivered',async()=>{
 const f=database();try{await exercise(f.db);const before=Number(f.sqlite.prepare('SELECT total_changes() n').get()!.n);await readOperationalHealth(f.db,'health-owner',now);assert.equal(Number(f.sqlite.prepare('SELECT total_changes() n').get()!.n),before);}finally{f.sqlite.close();}
});
test('actual isolated D1 executes bounded health aggregates and synthetic alert evaluation without delivery',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{readdir,readFile}=await import('node:fs/promises');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic health fixture")}}',d1Databases:{DB:'synthetic-operational-health'}});
 try{const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort())for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();await exercise(db);}finally{await mf.dispose();}
});
