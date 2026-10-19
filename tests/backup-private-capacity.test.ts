import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {runScheduledMetadataBackup} from '../lib/automations/backup-store.ts';
import {claimScheduledBackupJob} from '../lib/automations/backup-job-store.ts';
const now='2026-10-18T12:00:00.000Z',principal={ownerId:'a',principalId:'synthetic-principal'};
/** Synthetic private registration exercises local SQL only, not real unattended activation. */
async function fixture(){
 const f=database();for(const owner of ['a','b'])await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);
 const schedule={id:'backup-schedule',kind:'backup',timezone:'Africa/Cairo',enabled:true,configurationVersion:1,recurrence:{frequency:'daily',localTime:'09:00'},sourceId:null,projectIds:[],catchUp:'latest_only',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',archivedAt:null},hash=await contentHash(canonical(schedule)),intentId='backup-intent',backupId='00000000-0000-4000-8000-000000000001',dueAt='2026-10-18T06:00:00.000Z';
 f.sqlite.prepare('INSERT INTO automation_schedules(user_id,id,row_revision,payload_json,content_hash,kind,enabled,configuration_version) VALUES(?,?,1,?,?,?,1,1)').run('a',schedule.id,canonical(schedule),hash,'backup');
 f.sqlite.prepare('INSERT INTO automation_runtime(user_id,schedule_id,configuration_hash,operational_revision,execution_epoch,paused,next_due_at,principal_ref) VALUES(?,?,?,1,0,0,?,?)').run('a',schedule.id,hash,'2026-10-19T06:00:00.000Z',principal.principalId);
 f.sqlite.prepare('INSERT INTO integration_service_principals(user_id,id,token_hash,scope_json,expires_at,renewable_verified_at) VALUES(?,?,?,?,?,?)').run('a',principal.principalId,'a'.repeat(64),'["automation:run"]','2027-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 f.sqlite.prepare("INSERT INTO automation_capabilities(user_id,kind,resource_id,principal_ref,verified_at,expires_at,proof_kind) VALUES(?,'backup',?,?,?,?,'live-unattended')").run('a',schedule.id,principal.principalId,'2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z');
 const payload={backupId};
 f.sqlite.prepare('INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,?,?,?,?,?,0,0)').run('a',intentId,'workspace_backup',intentId,canonical(payload),now,'pending');
 f.sqlite.prepare("INSERT INTO integration_jobs(user_id,intent_id,source_id,job_subject_kind,subject_id,schedule_id,schedule_configuration_hash,occurrence_due_at,configuration_hash,operational_revision) VALUES(?,?,NULL,'backup',?,?,?,?,?,1)").run('a',intentId,backupId,schedule.id,hash,dueAt,await contentHash(canonical(payload)));
 f.sqlite.prepare('INSERT INTO automation_occurrence_claims(user_id,schedule_id,due_at,intent_id,configuration_hash,execution_epoch,admitted_at,missed_periods,principal_ref) VALUES(?,?,?,?,?,0,?,0,?)').run('a',schedule.id,dueAt,intentId,hash,now,principal.principalId);
 return {...f,intentId,backupId,schedule};
}

function fillPrivateDrafts(f:Awaited<ReturnType<typeof fixture>>,owner:string){
 const insert=f.sqlite.prepare('INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,1,?,?)'),payload='x'.repeat(1024*1024);
 for(let index=0;index<64;index++)insert.run(owner,'synthetic-private-capacity-'+index,payload,'2026-10-19T12:00:00.000Z');
}
test('full private metadata refuses backup lease before any attempt; foreign-owner usage does not consume this owner budget',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());fillPrivateDrafts(f,'b');assert.ok(await claimScheduledBackupJob(f.db,principal,f.intentId,{now}));
 const full=await fixture();t.after(()=>full.sqlite.close());fillPrivateDrafts(full,'a');
 assert.equal(await claimScheduledBackupJob(full.db,principal,full.intentId,{now}),null);
 assert.equal(full.sqlite.prepare('SELECT COUNT(*) n FROM integration_job_attempts').get()!.n,0);
 assert.equal(full.sqlite.prepare('SELECT status FROM workspace_job_intents WHERE user_id=? AND id=?').get('a',full.intentId)!.status,'pending');
 assert.equal(full.sqlite.prepare('SELECT COUNT(*) n FROM workspace_backups').get()!.n,0);
});
test('late private growth rolls back the whole scheduled backup terminal transaction without false success or deleting pressure data',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());let batches=0;
 const db:SqlDatabase={prepare:f.db.prepare.bind(f.db),async batch(statements){if(++batches===2)fillPrivateDrafts(f,'a');return f.db.batch(statements);}};
 const result=await runScheduledMetadataBackup(db,principal,f.intentId,{now:()=>now});
 assert.notEqual(result.status,'completed');assert.notEqual(result.status,'replayed');
 for(const table of ['workspace_backups','automation_occurrences'])assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get()!.n,0);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='backup.generated'").get()!.n,0);
 assert.equal(f.sqlite.prepare("SELECT last_success_at FROM automation_runtime WHERE user_id='a'").get()!.last_success_at,null);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workspace_drafts WHERE user_id='a'").get()!.n,64);
});
