import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reviewCommandSchema,reviewCommandTypes,reviewCommandHandler} from '../lib/reviews/commands.ts';
import {assembleReview} from '../lib/reviews/assemble.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {nextOccurrence} from '../lib/automations/schedule.ts';
import type {AutomationSchedule} from '../lib/automations/contracts.ts';
import type {ReviewAcknowledgement,NotificationEvent,NotificationPreferences,AnalysisPolicy,ReviewAssemblyInput} from '../lib/reviews/contracts.ts';
import type {PrepareContext,MutationPlan} from '../lib/workspace-transaction.ts';
import type {RegisteredOwnerTable,ModuleRow} from '../lib/workspace-modules.ts';
import {workspaceFixture,projectFixture,taskFixture} from './helpers/workspace.ts';
const now='2026-10-18T12:00:00.000Z';
const scheduleInput={kind:'daily_review' as const,timezone:'Africa/Cairo' as const,enabled:true,recurrence:{frequency:'daily' as const,localTime:'09:00'},sourceId:null,projectIds:['p1'],catchUp:'latest_only' as const};
const prefs:NotificationPreferences={id:'notifications',mutedKinds:['stale'],mutedSourceIds:[],quietHours:{enabled:false,timezone:'Africa/Cairo',start:'22:00',end:'08:00'},externalDelivery:'disabled'};
const policy:AnalysisPolicy={id:'analysis',enabled:false,provider:null,model:null,maxCostDollars:null,maxInputBytes:10000,maxOutputTokens:1000,timeoutMs:10000};
async function fixture(){
 const workspace=workspaceFixture({projects:[projectFixture(),projectFixture({id:'p2',name:'Other',color:'teal'})],tasks:[taskFixture()]});
 const rows=new Map<string,ModuleRow>();let canResume=false;
 async function put(table:RegisteredOwnerTable,value:unknown,rowRevision=1,id?:string){const key=id??(value as {id:string}).id;const row={id:key,row_revision:rowRevision,payload_json:JSON.stringify(value),content_hash:await contentHash(canonical(value))};rows.set(`${table}:${key}`,row);return row;}
 const context:PrepareContext={userId:'owner',mutationId:'review-command-fixture-0001',before:{workspace,revision:1,updatedAt:now},command:{type:'reviews.request',projectIds:['p1'],filterDigest:'a'.repeat(64)},now,query:{async get(table,id){return rows.get(`${table}:${id}`)??null;},async list(table,{after='',limit=100}={}){return [...rows.entries()].filter(([key])=>key.startsWith(`${table}:`)).map(([,row])=>row).filter(row=>row.id>after).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).slice(0,limit);}},async readImport(){throw new Error('No import authority');},automationRuntime:{async canResume(){return canResume;}}};
 async function prepare(command:unknown){return reviewCommandHandler.prepare({...context,command:reviewCommandSchema.parse(command)});}
 async function persist(plan:MutationPlan){for(const write of plan.writes){assert.notEqual(write.operation,'delete');await put(write.table,write.value,(write.expectedRowRevision??0)+1,write.id);}}
 async function snapshot(projectIds=['p1']){const input:ReviewAssemblyInput={envelope:context.before,projectIds,filterDigest:'a'.repeat(64),operationalWatermarks:{},observations:[],sourceTargets:[],sourceStates:[],evidence:[],evidenceLinks:[],decisions:[],assessments:[],auditRecords:[],now};const snapshot=await assembleReview(input);const row=await put('review_snapshots',snapshot);return {snapshot,row};}
 async function schedule(patch:Partial<AutomationSchedule>={}){const value:AutomationSchedule={...scheduleInput,id:'schedule',configurationVersion:1,createdAt:now,updatedAt:now,archivedAt:null,...patch};await put('automation_schedules',value);return value;}
 return {context,workspace,rows,put,prepare,persist,snapshot,schedule,setResume(value:boolean){canResume=value;}};
}
test('review request is stable for the same durable owner mutation/scope, and does not assemble or change planning',async()=>{
 const f=await fixture(),command={type:'reviews.request',projectIds:['p2','p1'],filterDigest:'a'.repeat(64)},first=await f.prepare(command),second=await f.prepare({...command,projectIds:['p1','p2']});
 assert.deepEqual(first.jobs,second.jobs);assert.equal(first.jobs[0].kind,'review_generate');assert.deepEqual(first.jobs[0].payload,{snapshotId:first.reviewJobs![0].snapshotId,scope:{projectIds:['p1','p2'],filterDigest:'a'.repeat(64)}});assert.equal(first.reviewJobs![0].intentId,first.jobs[0].id);assert.deepEqual(first.planningAfter,f.workspace);assert.deepEqual(first.writes,[]);assert.deepEqual(first.reviewGrants,[]);
 const old=first.jobs[0].id;f.context.mutationId='review-command-fixture-0002';assert.notEqual((await f.prepare(command)).jobs[0].id,old);delete f.context.mutationId;await assert.rejects(f.prepare(command),/durable/);await assert.rejects(f.prepare({...command,projectIds:['foreign']}),/owner projects/);
});
test('acknowledgement pins exact snapshot/scope and only included fact/event identities, with a separate owner grant',async()=>{
 const f=await fixture(),{snapshot,row}=await f.snapshot(),command={type:'reviews.acknowledge',snapshotId:snapshot.id,snapshotHash:row.content_hash};const before=structuredClone(snapshot),plan=await f.prepare(command),ack=plan.writes[0].value as unknown as ReviewAcknowledgement;
 assert.equal(plan.writes[0].table,'review_acknowledgements');assert.equal(plan.writes[0].operation,'insert');assert.deepEqual(ack.scope,snapshot.scope);assert.deepEqual(ack.coveredFactIds,snapshot.coverage.includedFactIds);assert.deepEqual(ack.coveredEventIds,snapshot.coverage.includedEventIds);assert.deepEqual(plan.reviewGrants,[{id:ack.id,hash:await contentHash(canonical(ack)),snapshotId:snapshot.id,snapshotHash:row.content_hash}]);assert.deepEqual(snapshot,before);assert.deepEqual(plan.planningAfter,f.workspace);assert.ok(plan.preconditions!.some(value=>value.id===snapshot.id&&value.expectedHash===row.content_hash));
 await f.persist(plan);const explicitlyAgain=await f.prepare(command);assert.deepEqual(explicitlyAgain.writes,[]);assert.equal(explicitlyAgain.reviewGrants!.length,1);assert.equal((await f.prepare({type:'reviews.request',projectIds:['p1'],filterDigest:'a'.repeat(64)})).reviewGrants!.length,0);
});
test('truncated snapshot acknowledgement never consumes omitted fact/event ranges or another project',async()=>{
 const f=await fixture();f.workspace.tasks=Array.from({length:510},(_,index)=>taskFixture(`task-${index}`));const {snapshot,row}=await f.snapshot(['p1']);assert.equal(snapshot.coverage.complete,false);const plan=await f.prepare({type:'reviews.acknowledge',snapshotId:snapshot.id,snapshotHash:row.content_hash}),ack=plan.writes[0].value as unknown as ReviewAcknowledgement;
 assert.equal(ack.coveredFactIds.length,500);assert.equal(snapshot.coverage.remainingFacts,11);assert.deepEqual(ack.coveredEventIds,[]);assert.deepEqual(ack.scope.projectIds,['p1']);assert.equal(Object.hasOwn(ack,'operationalWatermarks'),false);
});
test('acknowledgement rejects stale hashes, foreign snapshots and inconsistent frozen provenance',async()=>{
 const f=await fixture(),{snapshot,row}=await f.snapshot();await assert.rejects(f.prepare({type:'reviews.acknowledge',snapshotId:snapshot.id,snapshotHash:'f'.repeat(64)}),/snapshot hash differs/);await assert.rejects(f.prepare({type:'reviews.acknowledge',snapshotId:'foreign',snapshotHash:row.content_hash}),/missing/);
 snapshot.planningRecords[0].value.name='Tampered frozen body';const corrupt=await f.put('review_snapshots',snapshot);await assert.rejects(f.prepare({type:'reviews.acknowledge',snapshotId:snapshot.id,snapshotHash:corrupt.content_hash}),/planning citation hash differs/);
});
test('notification read/unread uses exact immutable owner content and private read extension only',async()=>{
 const f=await fixture(),value:NotificationEvent={id:'notification',dedupKey:'a'.repeat(64),kind:'blocker',severity:'warning',projectId:'p1',sourceId:null,title:'Synthetic blocker',body:'Recorded blocker',href:'/?view=projects',createdAt:now,factIds:[],snapshotRef:null,observationRefs:[],evidenceRefs:[]},row=await f.put('notification_events',value);
 for(const read of [true,false]){const plan=await f.prepare({type:'notifications.read',id:value.id,contentHash:row.content_hash,read});assert.deepEqual(plan.notificationReads,[{id:value.id,hash:row.content_hash,read}]);assert.deepEqual(plan.writes,[]);assert.deepEqual(plan.planningAfter,f.workspace);assert.equal(plan.events[0].origin,'owner');}
 await assert.rejects(f.prepare({type:'notifications.read',id:value.id,contentHash:'f'.repeat(64),read:true}),/notification content hash/);await assert.rejects(f.prepare({type:'notifications.read',id:'foreign',contentHash:row.content_hash,read:true}),/missing/);
});
test('notification preferences/settings use explicit absence or row revision CAS and cannot enable external delivery',async()=>{
 const f=await fixture(),command={type:'notifications.preferences',value:prefs,expectedRowRevision:null},created=await f.prepare(command);assert.equal(created.writes[0].id,'notifications');assert.equal(created.writes[0].operation,'insert');await f.persist(created);await assert.rejects(f.prepare(command),/settings changed/);await assert.rejects(f.prepare({...command,expectedRowRevision:2}),/settings changed/);
 const updated=await f.prepare({...command,value:{...prefs,mutedKinds:[]},expectedRowRevision:1});assert.equal(updated.writes[0].operation,'update');assert.ok(updated.preconditions!.some(value=>value.id==='notifications'&&value.expectedRowRevision===1));assert.equal(reviewCommandSchema.safeParse({...command,value:{...prefs,externalDelivery:'email'}}).success,false);
 await assert.rejects(f.prepare({...command,value:{...prefs,mutedSourceIds:['foreign']},expectedRowRevision:1}),/missing/);
});
test('analysis policy records exact provider/model/budget only; no spending grant, job or provider invocation is created',async()=>{
 const f=await fixture();assert.equal(reviewCommandSchema.safeParse({type:'analysis.configure',value:{...policy,enabled:true},expectedRowRevision:null}).success,false);
 const configured=await f.prepare({type:'analysis.configure',value:{...policy,enabled:true,provider:'explicit-provider',model:'exact-model',maxCostDollars:0.01},expectedRowRevision:null});assert.equal(configured.writes[0].id,'analysis');assert.deepEqual(configured.jobs,[]);assert.deepEqual(configured.reviewGrants,[]);assert.deepEqual(configured.automationControls,[]);assert.deepEqual(configured.planningAfter,f.workspace);
 await assert.rejects(f.prepare({type:'analysis.configure',value:policy,expectedRowRevision:1}),/settings changed/);
});
test('new schedules use server identities/clock and always start paused despite enabled selection',async()=>{
 const f=await fixture(),before=structuredClone(f.workspace),plan=await f.prepare({type:'automations.create',value:scheduleInput}),schedule=plan.writes[0].value as unknown as AutomationSchedule;
 assert.match(schedule.id,/^[a-f0-9-]{36}$/);assert.equal(schedule.configurationVersion,1);assert.equal(schedule.createdAt,now);assert.equal(schedule.updatedAt,now);assert.equal(schedule.archivedAt,null);assert.deepEqual(plan.automationControls,[{scheduleId:schedule.id,configurationHash:await contentHash(canonical(schedule)),action:'pause',nextDueAt:nextOccurrence(schedule,now)}]);assert.deepEqual(plan.jobs,[]);assert.deepEqual(f.workspace,before);
 await assert.rejects(f.prepare({type:'automations.create',value:{...scheduleInput,projectIds:['foreign']}}),/owner projects/);f.workspace.projects[0].archivedAt=now;await assert.rejects(f.prepare({type:'automations.create',value:scheduleInput}),/owner projects/);
});
test('schedule edits preserve ID/creation and pause with incremented full configuration hash; stale edits reject',async()=>{
 const f=await fixture(),before=await f.schedule(),plan=await f.prepare({type:'automations.update',id:before.id,expectedRowRevision:1,patch:{enabled:false}}),after=plan.writes[0].value as unknown as AutomationSchedule;
 assert.equal(after.id,before.id);assert.equal(after.createdAt,before.createdAt);assert.equal(after.configurationVersion,2);assert.equal(after.enabled,false);assert.equal(plan.automationControls![0].action,'pause');assert.equal(plan.automationControls![0].configurationHash,await contentHash(canonical(after)));assert.notEqual(plan.automationControls![0].configurationHash,await contentHash(canonical(before)));
 await assert.rejects(f.prepare({type:'automations.update',id:before.id,expectedRowRevision:2,patch:{enabled:false}}),/row changed/);await f.persist(plan);await assert.rejects(f.prepare({type:'automations.resume',id:before.id,expectedRowRevision:2}),/Enable an active/);
});
test('explicit resume requires active enabled owner schedule and actual injected unattended authorization',async()=>{
 const f=await fixture(),schedule=await f.schedule(),command={type:'automations.resume',id:schedule.id,expectedRowRevision:1};await assert.rejects(f.prepare(command),/authority is unavailable/);f.setResume(true);const resumed=await f.prepare(command);assert.deepEqual(resumed.writes,[]);assert.equal(resumed.automationControls![0].action,'resume');assert.equal(resumed.automationControls![0].configurationHash,await contentHash(canonical(schedule)));assert.deepEqual(resumed.jobs,[]);
 delete f.context.automationRuntime;await assert.rejects(f.prepare(command),/authority is unavailable/);f.workspace.projects[0].archivedAt=now;await assert.rejects(f.prepare(command),/owner projects/);
});
test('pause/archive remain reducing owner actions and never resume archived or disabled schedules',async()=>{
 const f=await fixture(),schedule=await f.schedule(),paused=await f.prepare({type:'automations.pause',id:schedule.id,expectedRowRevision:1});assert.equal(paused.automationControls![0].action,'pause');assert.deepEqual(paused.writes,[]);
 const archived=await f.prepare({type:'automations.archive',id:schedule.id,expectedRowRevision:1});assert.equal((archived.writes[0].value as unknown as AutomationSchedule).archivedAt,now);assert.equal(archived.automationControls![0].action,'pause');await f.persist(archived);f.setResume(true);await assert.rejects(f.prepare({type:'automations.resume',id:schedule.id,expectedRowRevision:2}),/active schedule/);await assert.rejects(f.prepare({type:'automations.update',id:schedule.id,expectedRowRevision:2,patch:{enabled:true}}),/Archived schedules/);
});
test('source schedules require exact owned source/connection/provider/project and cannot configure unsupported cadence',async()=>{
 const f=await fixture(),value={...scheduleInput,kind:'source_refresh',sourceId:'source',recurrence:{frequency:'interval',minutes:30,anchorAt:now}};await assert.rejects(f.prepare({type:'automations.create',value}),/missing/);
 await f.put('source_connections',{id:'connection',provider:'documents',label:'Manual',accessMode:'interactive',enabled:true,archivedAt:null});await f.put('source_targets',{id:'source',connectionId:'connection',projectId:'p1',kind:'document',providerResourceId:'document',canonicalUrl:null,selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null});
 const plan=await f.prepare({type:'automations.create',value});assert.equal(plan.automationControls![0].action,'pause');assert.ok(plan.preconditions!.some(value=>value.id==='source'));assert.ok(plan.preconditions!.some(value=>value.id==='connection'));assert.equal(reviewCommandSchema.safeParse({type:'automations.create',value:{...value,recurrence:{...value.recurrence,minutes:1}}}).success,false);
});
test('closed command schemas reject client IDs, timestamps, unsafe patches, repeated scope IDs and arbitrary settings',()=>{
 for(const command of [{type:'automations.create',value:{...scheduleInput,id:'forged'}},{type:'automations.update',id:'schedule',expectedRowRevision:1,patch:{}},{type:'automations.update',id:'schedule',expectedRowRevision:1,patch:{configurationVersion:999}},{type:'automations.resume',id:'schedule'},{type:'reviews.request',projectIds:['p1','p1'],filterDigest:'a'.repeat(64)},{type:'reviews.acknowledge',snapshotId:'review',snapshotHash:'a'.repeat(64),coveredFactIds:['forged']},{type:'analysis.configure',value:{...policy,paidConsent:true},expectedRowRevision:null}])assert.equal(reviewCommandSchema.safeParse(command).success,false);
 assert.equal(reviewCommandTypes.length,10);
});
test('stored tampered hash and mismatched logical identity reject without preparing effects',async()=>{
 const f=await fixture(),schedule=await f.schedule();f.rows.get('automation_schedules:schedule')!.content_hash='f'.repeat(64);await assert.rejects(f.prepare({type:'automations.pause',id:schedule.id,expectedRowRevision:1}),/content hash differs/);await f.put('automation_schedules',{...schedule,id:'other'},1,schedule.id);await assert.rejects(f.prepare({type:'automations.pause',id:schedule.id,expectedRowRevision:1}),/identity differs/);
});
