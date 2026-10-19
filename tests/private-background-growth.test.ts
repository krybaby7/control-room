import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {admitDueAutomation} from '../lib/automations/store.ts';
import {claimReviewJob,reviewConfigurationHash} from '../lib/reviews/job-store.ts';
import type {AutomationSchedule} from '../lib/automations/contracts.ts';
const now='2026-10-18T12:00:00.000Z';
/** Synthetic private principal/capability rows test SQL authority only; not live unattended proof. */
async function fixture(patch:Partial<AutomationSchedule>={},nextDueAt='2026-10-15T06:00:00.000Z'){
 const f=database(),workspace=createSeedWorkspace(now);await loadWorkspace(f.db,'synthetic-a',()=>workspace,now);await loadWorkspace(f.db,'synthetic-b',()=>workspace,now);f.sqlite.exec('PRAGMA foreign_keys=ON');const schedule:AutomationSchedule={id:'synthetic-schedule',kind:'daily_review',timezone:'Africa/Cairo',enabled:true,configurationVersion:1,recurrence:{frequency:'daily',localTime:'09:00'},sourceId:null,projectIds:[workspace.projects[0].id],catchUp:'latest_only',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',archivedAt:null,...patch},hash=await contentHash(canonical(schedule));
 f.sqlite.prepare('INSERT INTO automation_schedules(user_id,id,row_revision,payload_json,content_hash,kind,enabled,configuration_version,source_id,archived_at) VALUES(?,?,1,?,?,?,1,1,?,?)').run('synthetic-a',schedule.id,canonical(schedule),hash,schedule.kind,schedule.sourceId,schedule.archivedAt);f.sqlite.prepare('INSERT INTO automation_runtime(user_id,schedule_id,configuration_hash,operational_revision,execution_epoch,paused,next_due_at,principal_ref) VALUES(?,?,?,1,0,0,?,?)').run('synthetic-a',schedule.id,hash,nextDueAt,'synthetic-principal');f.sqlite.prepare("INSERT INTO integration_service_principals(user_id,id,token_hash,scope_json,expires_at,revoked_at,renewable_verified_at) VALUES(?,?,?,'[\"automation:run\"]',?,NULL,?)").run('synthetic-a','synthetic-principal','a'.repeat(64),'2027-01-01T00:00:00Z','2026-01-01T00:00:00Z');f.sqlite.prepare("INSERT INTO automation_capabilities(user_id,kind,resource_id,principal_ref,verified_at,expires_at,proof_kind) VALUES(?,?,?,?,?,?,'live-unattended')").run('synthetic-a',schedule.kind,schedule.id,'synthetic-principal','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z');const admit=(at=now)=>admitDueAutomation(f.db,'synthetic-a',schedule.id,{now:at,principalId:'synthetic-principal'});return {...f,workspace,schedule,hash,admit};
}
function pressure(sqlite:ReturnType<typeof database>['sqlite'],owner:string){
 const query=sqlite.prepare('INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,1,?,?)'),payload='x'.repeat(1024*1024);for(let index=0;index<64;index++)query.run(owner,'synthetic-pressure-'+index,payload,'2026-10-19T12:00:00.000Z');
}
test('scheduled admission refuses full private profile before intent/occurrence/runtime growth and isolates other owners',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());pressure(f.sqlite,'synthetic-b');assert.equal((await f.admit()).status,'admitted');
 const full=await fixture();t.after(()=>full.sqlite.close());pressure(full.sqlite,'synthetic-a');const before=full.sqlite.prepare('SELECT * FROM automation_runtime').all();assert.deepEqual(await full.admit(),{status:'blocked',reason:'private_recovery_capacity'});
 for(const table of ['workspace_job_intents','integration_jobs','automation_occurrence_claims'])assert.equal(full.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get()!.n,0);
 assert.deepEqual(full.sqlite.prepare('SELECT * FROM automation_runtime').all(),before);
});
test('late private growth at schedule batch and review lease update leaves no partial rows or false started state',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());const before=f.sqlite.prepare('SELECT * FROM automation_runtime').all();let ran=false;
 const racing:SqlDatabase={prepare:f.db.prepare.bind(f.db),async batch(statements){if(!ran){ran=true;pressure(f.sqlite,'synthetic-a');}return f.db.batch(statements);}};
 const result=await admitDueAutomation(racing,'synthetic-a',f.schedule.id,{now,principalId:'synthetic-principal'});assert.equal(result.status,'blocked');assert.deepEqual(f.sqlite.prepare('SELECT * FROM automation_runtime').all(),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents').get()!.n,0);
 const review=database();t.after(()=>review.sqlite.close());const scope={projectIds:['synthetic-project'],filterDigest:'a'.repeat(64)},hash=await reviewConfigurationHash(scope);
 review.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES('synthetic-review','intent','review_generate','review-dedup',?,?,'pending',0,0)").run(canonical({snapshotId:'snapshot',scope}),now);
 review.sqlite.prepare("INSERT INTO integration_jobs(user_id,intent_id,source_id,job_subject_kind,subject_id,configuration_hash,operational_revision,attempt_count) VALUES('synthetic-review','intent',NULL,'review','snapshot',?,1,0)").run(hash);
 const wrapped:SqlDatabase={prepare:review.db.prepare.bind(review.db),async batch(statements){pressure(review.sqlite,'synthetic-review');return review.db.batch(statements);}};
 assert.equal(await claimReviewJob(wrapped,'synthetic-review','intent',{now}),null);assert.equal(review.sqlite.prepare('SELECT COUNT(*) n FROM integration_job_attempts').get()!.n,0);assert.equal(review.sqlite.prepare('SELECT lease_token FROM integration_jobs').get()!.lease_token,null);assert.equal(review.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'pending');
});
