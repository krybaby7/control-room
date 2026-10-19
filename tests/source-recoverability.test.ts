import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {claimIntegrationJob,sourceConfigurationHash} from '../lib/background/job-store.ts';
import {commitSourcePage,readSourceSyncState} from '../lib/sources/store.ts';
import {finishSourceRun} from '../lib/sources/run-store.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {RecoverabilityCapacityError} from '../lib/recoverability-admission.ts';
import type {SourceConnection,SourceTarget,SourcePage,SourceRunHistory,SourceProposal} from '../lib/sources/contracts.ts';
const now='2026-10-18T12:00:00.000Z',previous='2026-10-17T12:00:00.000Z';
async function fixture(){
 const f=database();await loadWorkspace(f.db,'owner',workspaceFixture,now);
 const connection:SourceConnection={id:'connection',provider:'documents',label:'Synthetic source',accessMode:'interactive',enabled:true,archivedAt:null},target:SourceTarget={id:'source',connectionId:'connection',projectId:'p1',kind:'document',providerResourceId:'synthetic-doc',canonicalUrl:null,selectedPaths:[],staleAfterSeconds:600,selectionVersion:1,archivedAt:null},hash=await sourceConfigurationHash(connection,target);
 f.sqlite.prepare('INSERT INTO source_connections(user_id,id,row_revision,payload_json,content_hash,provider,access_mode,enabled) VALUES(?,?,1,?,?,?,?,1)').run('owner',connection.id,canonical(connection),await contentHash(canonical(connection)),connection.provider,connection.accessMode);
 f.sqlite.prepare('INSERT INTO source_targets(user_id,id,row_revision,payload_json,content_hash,connection_id,project_id,kind,selection_version) VALUES(?,?,1,?,?,?,?,?,1)').run('owner',target.id,canonical(target),await contentHash(canonical(target)),connection.id,'p1',target.kind);
 f.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES('owner','intent','source_refresh','dedup',?,?,'pending',0,0)").run(canonical({sourceId:'source',configurationHash:hash}),now);
 f.sqlite.prepare("INSERT INTO integration_jobs(user_id,intent_id,source_id,configuration_hash,operational_revision,attempt_count) VALUES('owner','intent','source',?,1,0)").run(hash);
 f.sqlite.prepare("INSERT INTO source_sync_state(user_id,source_id,operational_revision,configuration_hash,execution_epoch,paused,cursor,etag,last_success_at,failure_count) VALUES('owner','source',1,?,0,0,'previous-cursor','previous-etag',?,0)").run(hash,previous);
 const claim=await claimIntegrationJob(f.db,'owner','intent',{authority:{mode:'manual',authenticatedOwner:'owner'},now});assert.ok(claim);
 const payload={text:'Observed العربية 😀 "quote" \\.'},page:SourcePage={observations:[{id:'observation',sourceId:'source',externalId:'external',sourceRevision:'revision',sourceUpdatedAt:null,observedAt:now,title:'New document',canonicalUrl:null,contentDigest:await contentHash(canonical(payload)),payload,origin:'manual-import'}],nextCursor:'new-cursor',nextEtag:'new-etag',unchanged:false};
 const run:SourceRunHistory={id:'run',sourceId:'source',startedAt:now,finishedAt:now,outcome:'unchanged',pages:1,observations:0,failure:null,retryAt:null,sourceRevision:'revision'};
 return {...f,claim,page,run};
}
function portable(f:ReturnType<typeof database>){return Object.fromEntries(['source_observations','source_proposals','source_sync_runs','integration_history','audit_events','workspaces','workspace_mutations'].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));}
async function fill(f:ReturnType<typeof database>,targetBytes:number){
 const set=async(text:string)=>{const value={text};f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?) ON CONFLICT(user_id,id) DO UPDATE SET payload_json=excluded.payload_json,content_hash=excluded.content_hash').run('owner','retained',canonical(value),await contentHash(canonical(value)));};
 await set('');const current=new TextEncoder().encode(JSON.stringify(await exportWorkspaceBundle(f.db,'owner',{now:()=>now}))).length;await set('x'.repeat(targetBytes-current));assert.equal(new TextEncoder().encode(JSON.stringify(await exportWorkspaceBundle(f.db,'owner',{now:()=>now}))).length,targetBytes);
}
test('dedup-resolved operational page inserts valid exact observations/proposals and preserves editor revision',async()=>{
 const f=await fixture();try{const observation=f.page.observations[0],proposal:SourceProposal={id:'proposal',sourceId:'source',observationRefs:[{id:observation.id,contentDigest:observation.contentDigest}],evidenceRefs:[],entity:{kind:'project',id:'p1'},baseWorkspaceRevision:1,fields:[{field:'description',before:'',after:'Suggested review only'}],rationale:'Inferred source change',confidence:'inferred',createdAt:now,state:'pending',dedupKey:'b'.repeat(64),decision:null};
  const first=await commitSourcePage(f.db,f.claim,{page:f.page,proposals:[proposal],now});assert.equal(first.status,'committed');if(first.status!=='committed')return;assert.equal(first.observationsInserted,1);assert.equal(first.proposalsInserted,1);
  const duplicate=await commitSourcePage(f.db,first.claim,{page:{...f.page,nextCursor:'later-cursor'},proposals:[proposal],now});assert.equal(duplicate.status,'committed');if(duplicate.status!=='committed')return;assert.equal(duplicate.observationsInserted,0);assert.equal(duplicate.proposalsInserted,0);assert.equal((await exportWorkspaceBundle(f.db,'owner',{now:()=>now})).source.workspaceRevision,1);assert.equal((await readSourceSyncState(f.db,'owner','source'))!.lastSuccessAt,previous);
 }finally{f.sqlite.close();}
});
test('full bundle ceiling refuses non-ASCII page before portable growth and privately pauses the same intent',async()=>{
 const f=await fixture();try{await fill(f,1790000);const payload={text:'界'.repeat(8000)},page={...f.page,observations:[{...f.page.observations[0],payload,contentDigest:await contentHash(canonical(payload))}]},before=portable(f);
  await assert.rejects(commitSourcePage(f.db,f.claim,{page,now}),error=>error instanceof RecoverabilityCapacityError&&error.paused===true);assert.deepEqual(portable(f),before);const state=await readSourceSyncState(f.db,'owner','source');assert.equal(state!.paused,true);assert.equal(state!.failure,'storage_capacity');assert.equal(state!.cursor,'previous-cursor');assert.equal(state!.lastSuccessAt,previous);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents').get()!.n,1);assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'pending');assert.equal(f.sqlite.prepare('SELECT lease_token FROM integration_jobs').get()!.lease_token,null);assert.equal(f.sqlite.prepare('SELECT failure FROM integration_job_attempts').get()!.failure,'storage_capacity');
 }finally{f.sqlite.close();}
});
test('unchanged terminal run cannot cross recovery ceiling or manufacture success/history',async()=>{
 const f=await fixture();try{await fill(f,1799500);const before=portable(f);await assert.rejects(finishSourceRun(f.db,f.claim,{run:f.run,now}),error=>error instanceof RecoverabilityCapacityError&&error.paused===true);assert.deepEqual(portable(f),before);const state=await readSourceSyncState(f.db,'owner','source');assert.equal(state!.lastSuccessAt,previous);assert.equal(state!.cursor,'previous-cursor');assert.equal(state!.paused,true);assert.equal(state!.failure,'storage_capacity');assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'pending');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents').get()!.n,1);
 }finally{f.sqlite.close();}
});
test('stream/editor/normalized set races invalidate both operational writer quotes before their own inserts',async()=>{
 for(const writer of ['page','run']as const)for(const race of ['stream','normalized','editor']as const){const f=await fixture();try{const before=portable(f),state=canonical(await readSourceSyncState(f.db,'owner','source'));let raced=false;const mutationStatements=new WeakSet<object>();const db={...f.db,prepare(sql:string){const statement=f.db.prepare(sql);if(/\bsource_(?:page|run)_authority\b/u.test(sql))mutationStatements.add(statement);return statement;},async batch(statements:Parameters<typeof f.db.batch>[0]){if(!raced&&statements.some(statement=>mutationStatements.has(statement))){raced=true;if(race==='stream')f.sqlite.prepare("INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES('owner','sources',1,7)").run();if(race==='normalized'){const value={text:'Concurrent normalized record'};f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('owner','concurrent',canonical(value),await contentHash(canonical(value)));}if(race==='editor')f.sqlite.prepare("UPDATE workspaces SET revision=revision+1 WHERE user_id='owner'").run();}return f.db.batch(statements);}};
  await assert.rejects(writer==='page'?commitSourcePage(db,f.claim,{page:f.page,now}):finishSourceRun(db,f.claim,{run:f.run,now}));assert.equal(raced,true,'Recovery race must target the source mutation batch.');assert.equal(canonical(await readSourceSyncState(f.db,'owner','source')),state);const after=portable(f);for(const table of ['source_observations','source_proposals','source_sync_runs','integration_history','audit_events'])assert.deepEqual(after[table],before[table],`${writer}/${race}/${table}`);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_command_guards').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT lease_token FROM integration_jobs').get()!.lease_token,f.claim.token);
 }finally{f.sqlite.close();}}
});
test('only a confirmed private capacity pause receives a terminal paused HTTP response',async()=>{
 const {sourceHttpFailure}=await import('../lib/sources/http.ts');
 const confirmed=sourceHttpFailure(new RecoverabilityCapacityError(true));assert.equal(confirmed.status,200);assert.deepEqual(await confirmed.json(),{status:'paused',reason:'storage_capacity'});assert.match(confirmed.headers.get('cache-control')!,/no-store/);
 for(const error of [new RecoverabilityCapacityError(false),new Error('private raw failure'),{paused:true,code:'recovery_capacity'}]){const uncertain=sourceHttpFailure(error);assert.equal(uncertain.status,503);const body=await uncertain.json();assert.deepEqual(body,{error:'Source data is temporarily unavailable.'});assert.equal(JSON.stringify(body).includes('paused'),false);}
});
