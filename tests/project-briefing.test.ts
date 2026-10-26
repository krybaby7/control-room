import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,projectFixture,taskFixture,FIXTURE_AT} from './helpers/workspace.ts';
import {loadWorkspace,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {projectBriefingCommandHandlers} from '../lib/project-briefing-handler.ts';
import {readProjectBriefings} from '../lib/project-briefing-store.ts';
import {contentHash,canonical} from '../lib/canonical-json.ts';
import {changePersonalState,personalOwnerView,personalDeviceView} from '../lib/personal-repository-store.ts';
import {initialPersonalState,transitionPersonalState,parseOwnerAction,parseDeviceAction,validatePersonalState,PERSONAL_LIMITS} from '../shared/personal-repository.mjs';
import {briefingFixture,briefingFixtureV2,planFixture} from './fixtures/briefing.ts';
import type {ProjectFraming} from '../shared/project-briefing.mjs';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',now='2026-10-21T12:00:00.000Z';
const framingFixture=()=>({projectId:'p1',projectName:'Trade Graph',framing:'Owner framing.',includeTaskPlan:false,milestones:[],tasks:[],totalMilestones:1,totalTasks:1,workspaceRevision:3});
function stampFraming(briefing:ReturnType<typeof briefingFixture>,framing:ProjectFraming){return {...briefing,evidence:{...briefing.evidence,framing:{workspaceRevision:framing.workspaceRevision,characters:framing.framing.trim()?framing.framing.length:0,includeTaskPlan:framing.includeTaskPlan,totalMilestones:framing.totalMilestones,totalTasks:framing.totalTasks,includedMilestones:framing.milestones.length,includedTasks:framing.tasks.length}}};}
const later=(minutes:number)=>new Date(Date.parse(now)+minutes*60000).toISOString();
const repo={key:'repo-b',name:'trade-graph',head:'c'.repeat(40),dirty:false,hasPreviousAnalysis:false};
async function setup(){const {db,sqlite}=database();for(const owner of ['owner-a','owner-b'])await loadWorkspace(db,owner,()=>workspaceFixture({projects:[projectFixture({name:'Trade Graph',framing:'Owner framing.'}),projectFixture({id:'p2'})],tasks:[taskFixture('t1',{status:'doing'})]}),FIXTURE_AT);let serial=0;const save=(owner:string,revision:number,command:unknown)=>executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:revision,mutationId:'briefing-mutation-'+String(++serial).padStart(4,'0'),command},{db,now:()=>FIXTURE_AT,handlers:projectBriefingCommandHandlers});return{db,sqlite,save};}
test('a briefing is private immutable evidence per project and repository; refresh appends a version',async()=>{
 const {db,sqlite,save}=await setup();
 await save('owner-a',1,{type:'project-briefing.save',projectId:'p1',briefing:briefingFixture()});
 const first=await readProjectBriefings(db,'owner-a');assert.equal(first.briefings.length,1);assert.equal(first.briefings[0].projectId,'p1');assert.equal((await readProjectBriefings(db,'owner-b')).briefings.length,0);
 // A second active briefing for the same project and repository must be an explicit refresh.
 await assert.rejects(save('owner-a',2,{type:'project-briefing.save',projectId:'p1',briefing:briefingFixture({},other)}),/requires its evidence ID/);
 await save('owner-a',2,{type:'project-briefing.save',projectId:'p1',evidenceId:first.briefings[0].evidenceId,expectedVersion:1,briefing:briefingFixture({},other)});
 const current=await readProjectBriefings(db,'owner-a');assert.equal(current.briefings.length,1);assert.equal(current.briefings[0].version,2);assert.equal(current.briefings[0].briefing.run.id,other);
 assert.equal(sqlite.prepare("select count(*) n from evidence_versions where user_id='owner-a'").get()!.n,2);
 assert.equal(JSON.parse(String(sqlite.prepare("select content from workspaces where user_id='owner-a'").get()!.content)).tasks.length,1);
 await assert.rejects(save('owner-a',3,{type:'project-briefing.save',projectId:'p1',evidenceId:first.briefings[0].evidenceId,expectedVersion:2,briefing:briefingFixture({},other)}),/already saved/);
 await assert.rejects(save('owner-a',3,{type:'project-briefing.save',projectId:'p2',briefing:briefingFixture({},'33333333-3333-4333-8333-333333333333')}),/another project/);
 await assert.rejects(save('owner-a',3,{type:'project-briefing.save',projectId:'p1',evidenceId:first.briefings[0].evidenceId,expectedVersion:2,briefing:briefingFixture({repository:{...briefingFixture().repository,key:'other-repo'}},'33333333-3333-4333-8333-333333333333')}),/repository identity/);
 assert.equal((await readProjectBriefings(db,'owner-a')).briefings[0].version,2);
});
test('owner briefing request carries server-projected framing; the device completes it and acknowledgment needs a saved copy',async()=>{
 const {db,save}=await setup();const c={version:1 as const,ownerId:'owner-a',deviceId:'synthetic-pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 await changePersonalState(db,c,{action:'poll',repositories:[repo]},'device',now);
 await assert.rejects(changePersonalState(db,c,{action:'brief',requestId:id,projectId:'missing',repositoryKey:'repo-b',provider:'claude'},'owner',now),/active project/);
 await changePersonalState(db,c,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'claude'},'owner',now);
 await changePersonalState(db,c,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'claude'},'owner',now);
 await assert.rejects(changePersonalState(db,c,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'codex'},'owner',now));
 const owner=await personalOwnerView(db,c,now);assert.equal(owner.jobs.length,1);assert.equal(owner.jobs[0].kind,'brief');assert.equal(Object.hasOwn(owner.jobs[0],'plan'),false);assert.equal(Object.hasOwn(owner.jobs[0],'framing'),false);assert.equal(owner.completedBriefing,null);
 const claimed=await changePersonalState(db,c,{action:'poll'},'device',now);const device=personalDeviceView(claimed);
 assert.equal(device.job?.kind,'brief');assert.equal(device.job?.framing?.projectId,'p1');assert.equal(device.job?.framing?.projectName,'Trade Graph');assert.equal(device.job?.framing?.framing,'Owner framing.');assert.equal(device.job?.framing?.includeTaskPlan,false);assert.deepEqual(device.job?.framing?.tasks,[]);assert.equal(device.job?.framing?.totalTasks,1);assert.equal(Object.hasOwn(device.job!,'plan'),false);assert.equal(device.job?.origin,'owner');
 assert.equal(Date.parse(device.job!.expiresAt)-Date.parse(now),PERSONAL_LIMITS.briefMs);
 const briefing=stampFraming(briefingFixture({},id),device.job!.framing!);
 await assert.rejects(changePersonalState(db,c,{action:'complete',requestId:id,briefing:briefingFixture({project:{id:'p2',name:'Other'}},id)},'device',now));
 await changePersonalState(db,c,{action:'complete',requestId:id,briefing,fingerprint:'f'.repeat(64)},'device',now);
 await changePersonalState(db,c,{action:'complete',requestId:id,briefing},'device',now);
 const completed=await personalOwnerView(db,c,now);assert.equal(completed.completedBriefing?.projectId,'p1');assert.deepEqual(completed.completedBriefing?.briefing,briefing);assert.equal(completed.repositories[0].head,briefing.repository.head);
 const briefingSha256=await contentHash(canonical(briefing)),ack={action:'ack',requestId:id,runId:id,reportSha256:briefingSha256};
 await assert.rejects(changePersonalState(db,c,ack,'owner',now),/Save this report/);
 await save('owner-a',1,{type:'project-briefing.save',projectId:'p1',briefing});
 await changePersonalState(db,c,ack,'owner',now);
 assert.equal((await personalOwnerView(db,c,now)).completedBriefing,null);
});
test('keep-current policies admit device briefings only when due, changed and idle',async()=>{
 let s=initialPersonalState('pc');s.repositories=[repo];
 const framing=framingFixture();
 assert.throws(()=>transitionPersonalState(s,parseOwnerAction({action:'keep-current',repositoryKey:'unknown',projectId:'p1',provider:'codex',enabled:true}),now,'owner'));
 s=transitionPersonalState(s,parseOwnerAction({action:'keep-current',repositoryKey:'repo-b',projectId:'p1',provider:'codex',enabled:true}),now,'owner');
 assert.deepEqual(s.policies,[{repositoryKey:'repo-b',projectId:'p1',provider:'codex',enabled:true,minIntervalMinutes:PERSONAL_LIMITS.defaultIntervalMinutes,updatedAt:now,lastBriefAt:null,lastAttemptAt:null,lastFingerprint:null}]);
 const auto=parseDeviceAction({action:'auto-brief',requestId:id,repositoryKey:'repo-b',fingerprint:'1'.repeat(64)});
 assert.throws(()=>transitionPersonalState(s,auto,now,'device'),/invalid/u);
 s=transitionPersonalState(s,auto,now,'device',{framing});
 assert.equal(s.requests[0].status,'claimed');assert.equal(s.requests[0].origin,'auto');assert.equal(s.requests[0].provider,'codex');assert.equal(s.requests[0].requestedModel,'gpt-6.1-sol');assert.equal(s.policies[0].lastAttemptAt,now);
 // Idempotent re-send and refusal of a second concurrent automatic briefing.
 assert.deepEqual(transitionPersonalState(s,auto,now,'device',{framing}),s);
 assert.throws(()=>transitionPersonalState(s,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'2'.repeat(64)}),now,'device',{framing}),/not admitted/);
 const briefing=stampFraming(briefingFixture({run:{...briefingFixture().run,id,provider:'codex',requestedModel:'gpt-6.1-sol',observedModel:null,origin:'auto'}},id),framing);
 s=transitionPersonalState(s,parseDeviceAction({action:'complete',requestId:id,briefing}),later(5),'device');s.requests[0].reportSha256=await contentHash(canonical(briefing));
 assert.equal(s.requests[0].status,'completed');assert.equal(s.policies[0].lastBriefAt,later(5));assert.equal(s.policies[0].lastFingerprint,'1'.repeat(64));
 // Same fingerprint or too soon: not due. Later with new work: due again.
 assert.throws(()=>transitionPersonalState(s,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'1'.repeat(64)}),later(200),'device',{framing}),/not due/);
 assert.throws(()=>transitionPersonalState(s,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'2'.repeat(64)}),later(30),'device',{framing}),/not due/);
 const due=transitionPersonalState(s,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'2'.repeat(64)}),later(200),'device',{framing});
 assert.equal(due.requests.length,2);assert.equal(due.requests[1].status,'claimed');
 // Switching the policy off keeps its history but admits nothing.
 const off=transitionPersonalState(s,parseOwnerAction({action:'keep-current',repositoryKey:'repo-b',projectId:'p1',provider:'codex',enabled:false}),later(1),'owner');
 assert.equal(off.policies[0].enabled,false);assert.equal(off.policies[0].lastBriefAt,later(5));
 assert.throws(()=>transitionPersonalState(off,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'2'.repeat(64)}),later(200),'device',{framing}),/not admitted/);
 // The completed unsaved briefing survives clean-up; the device view never carries the briefing body.
 assert.equal(transitionPersonalState(s,parseOwnerAction({action:'clear-finished'}),later(6),'owner').requests.length,1);
 assert.equal(Object.hasOwn(personalDeviceView(s),'policies'),true);
 // Legacy state without policies stays valid and unchanged until the first transition.
 const legacy=initialPersonalState('pc') as unknown as Record<string,unknown>;delete legacy.policies;assert.equal(Object.hasOwn(validatePersonalState(legacy),'policies'),false);
 assert.deepEqual(transitionPersonalState(legacy as never,parseDeviceAction({action:'poll'}),now,'device').policies,[]);
});
test('automatic briefing through the store projects the policy project and refuses archived projects',async()=>{
 const {db}=await setup();const c={version:1 as const,ownerId:'owner-a',deviceId:'synthetic-pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 await changePersonalState(db,c,{action:'poll',repositories:[repo]},'device',now);
 await changePersonalState(db,c,{action:'keep-current',repositoryKey:'repo-b',projectId:'p1',provider:'claude',enabled:true,minIntervalMinutes:60},'owner',now);
 await assert.rejects(changePersonalState(db,c,{action:'auto-brief',requestId:id,repositoryKey:'other',fingerprint:'1'.repeat(64)},'device',now),/not admitted/);
 const admitted=await changePersonalState(db,c,{action:'auto-brief',requestId:id,repositoryKey:'repo-b',fingerprint:'1'.repeat(64)},'device',now);
 const device=personalDeviceView(admitted);assert.equal(device.job?.id,id);assert.equal(device.job?.framing?.projectId,'p1');assert.equal(device.policies.length,1);assert.equal(device.policies[0].minIntervalMinutes,60);
 const owner=await personalOwnerView(db,c,now);assert.equal(owner.policies.length,1);assert.equal(Object.hasOwn(owner.policies[0],'lastFingerprint'),false);assert.equal(owner.jobs[0].origin,'auto');
});

test('owner and device commands reject client-supplied framing and plans',()=>{
 const owner={action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'claude'};
 assert.throws(()=>parseOwnerAction({...owner,framing:framingFixture()}));
 assert.throws(()=>parseOwnerAction({...owner,plan:planFixture()}));
 assert.throws(()=>parseDeviceAction({action:'auto-brief',requestId:id,repositoryKey:'repo-b',fingerprint:'1'.repeat(64),framing:framingFixture()}));
});
test('new briefing admissions require framing matched to the project',()=>{
 const state=initialPersonalState('pc');state.repositories=[repo];
 const owner=parseOwnerAction({action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'codex'});
 assert.throws(()=>transitionPersonalState(state,owner,now,'owner',{plan:planFixture()} as never));
 assert.throws(()=>transitionPersonalState(state,owner,now,'owner',{framing:{...framingFixture(),projectId:'p2'}}));
 const admitted=transitionPersonalState(state,owner,now,'owner',{framing:framingFixture()});
 assert.deepEqual(admitted.requests[0].framing,framingFixture());assert.equal(Object.hasOwn(admitted.requests[0],'plan'),false);
});

test('new briefing completion and persisted state bind every framing coverage field to the admitted job',()=>{
 const initial=initialPersonalState('pc');initial.repositories=[repo];
 const plan=planFixture(),framing={...framingFixture(),includeTaskPlan:true,milestones:plan.milestones,tasks:plan.tasks};
 const admitted=transitionPersonalState(initial,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'claude'},now,'owner',{framing});
 const claimed=transitionPersonalState(admitted,{action:'poll'},now,'device');
 const matching=stampFraming(briefingFixture({},id),framing);
 const complete=(briefing:unknown)=>transitionPersonalState(claimed,parseDeviceAction({action:'complete',requestId:id,briefing}),now,'device');
 const completed=complete(matching);completed.requests[0].reportSha256='a'.repeat(64);assert.deepEqual(validatePersonalState(completed),completed);
 const edits=[
  (b:typeof matching)=>{b.project.name='Different project name';},
  (b:typeof matching)=>{b.evidence.framing.workspaceRevision++;},
  (b:typeof matching)=>{b.evidence.framing.characters++;},
  (b:typeof matching)=>{b.evidence.framing.includeTaskPlan=false;b.evidence.framing.includedMilestones=0;b.evidence.framing.includedTasks=0;},
  (b:typeof matching)=>{b.evidence.framing.totalMilestones++;},
  (b:typeof matching)=>{b.evidence.framing.totalTasks++;},
  (b:typeof matching)=>{b.evidence.framing.includedMilestones=0;},
  (b:typeof matching)=>{b.evidence.framing.includedTasks=0;},
 ];
 for(const edit of edits){const forged=structuredClone(matching);edit(forged);assert.throws(()=>complete(forged),`completion accepted ${edit.toString()}`);const stored=structuredClone(completed);stored.requests[0].briefing=forged;assert.throws(()=>validatePersonalState(stored),`persisted state accepted ${edit.toString()}`);}
 assert.throws(()=>complete({...matching,evidence:{...matching.evidence,framing:null}}));
 assert.throws(()=>complete(briefingFixtureV2({run:{...briefingFixtureV2().run,id}})));
 const blank={...framing,framing:' \n\t '},blankAdmission=transitionPersonalState(initial,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'claude'},now,'owner',{framing:blank}),blankClaim=transitionPersonalState(blankAdmission,{action:'poll'},now,'device');
 assert.equal(transitionPersonalState(blankClaim,{action:'complete',requestId:id,briefing:stampFraming(briefingFixture({},id),blank)},now,'device').requests[0].status,'completed');
});
test('legacy briefing state remains hash-stable while active legacy jobs fail before dispatch',()=>{
 const state=initialPersonalState('pc');state.repositories=[repo];
 state.requests.push({id,kind:'brief',status:'queued',createdAt:now,expiresAt:later(10),claimedAt:null,projectId:'p1',repositoryKey:'repo-b',provider:'codex',requestedModel:'gpt-6.1-sol',origin:'owner',plan:planFixture()});
 assert.deepEqual(validatePersonalState(state),state);
 assert.equal(personalDeviceView({...state,requests:[{...state.requests[0],status:'claimed'}]}).job,null);
 const polled=transitionPersonalState(state,{action:'poll'},now,'device');
 assert.equal(polled.requests[0].status,'failed');assert.equal(polled.requests[0].error,'interrupted');assert.equal(personalDeviceView(polled).job,null);
 assert.deepEqual(polled.requests[0].plan,state.requests[0].plan);
});

test('server admissions preserve archived folder associations until the owner restores the mapped project',async()=>{
 const f=database();try{
  const c={version:1 as const,ownerId:'archived-mapping-owner',deviceId:'mapping-pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
  await loadWorkspace(f.db,c.ownerId,()=>workspaceFixture({projects:[projectFixture({personalRepositoryKey:'repo-b',archivedAt:now}),projectFixture({id:'p2'})]}),now);
  await changePersonalState(f.db,c,{action:'poll',repositories:[repo]},'device',now);
  for(const action of ['brief','analyze','keep-current']){
   const command=action==='keep-current'?{action,projectId:'p2',repositoryKey:'repo-b',provider:'codex',enabled:true}:{action,requestId:id,projectId:'p2',repositoryKey:'repo-b',provider:'codex'};
   await assert.rejects(changePersonalState(f.db,c,command,'owner',now),/associated/);
  }
 }finally{f.sqlite.close();}
});

test('server admissions respect durable folder associations for manual and automatic briefing',async()=>{
 const f=database();try{
 const c={version:1 as const,ownerId:'mapping-owner',deviceId:'mapping-pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 await loadWorkspace(f.db,c.ownerId,()=>workspaceFixture({projects:[projectFixture({personalRepositoryKey:'repo-b'}),projectFixture({id:'p2'})]}),now);
 await changePersonalState(f.db,c,{action:'poll',repositories:[repo,{...repo,key:'other'}]},'device',now);
 for(const action of ['brief','analyze','keep-current']){
 const command=action==='keep-current'?{action,projectId:'p1',repositoryKey:'other',provider:'codex',enabled:true}:{action,requestId:id,projectId:'p1',repositoryKey:'other',provider:'codex'};
 await assert.rejects(changePersonalState(f.db,c,command,'owner',now),/associated/);
 }
 await assert.rejects(changePersonalState(f.db,c,{action:'brief',requestId:id,projectId:'p2',repositoryKey:'repo-b',provider:'codex'},'owner',now),/associated/);
 await changePersonalState(f.db,c,{action:'keep-current',projectId:'p1',repositoryKey:'repo-b',provider:'codex',enabled:true},'owner',now);
 f.sqlite.prepare("UPDATE workspaces SET revision=revision+1,content=json_set(content,'$.projects[0].personalRepositoryKey','other') WHERE user_id=?").run(c.ownerId);
 await assert.rejects(changePersonalState(f.db,c,{action:'auto-brief',requestId:id,repositoryKey:'repo-b',fingerprint:'1'.repeat(64)},'device',now),/associated/);
 }finally{f.sqlite.close();}
});

test('historical personal briefing digests remain acknowledgeable after their validated projection is saved',async()=>{
 const {db,save,sqlite}=await setup();try{
 const c={version:1 as const,ownerId:'owner-a',deviceId:'legacy-pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 const briefing=briefingFixtureV2({run:{...briefingFixtureV2().run,id}}),reportSha256=await contentHash(canonical(briefing));
 const state=initialPersonalState(c.deviceId);state.repositories=[repo];state.requests.push({id,kind:'brief',status:'completed',createdAt:now,expiresAt:now,claimedAt:now,projectId:'p1',repositoryKey:'repo-b',provider:'claude',requestedModel:briefing.run.requestedModel,origin:'owner',plan:planFixture(),briefing:briefing as never,reportSha256});
 const payload=canonical(state);await db.prepare('INSERT INTO personal_repository_state(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(c.ownerId,c.deviceId,payload,await contentHash(payload)).run();
 assert.equal((await personalOwnerView(db,c,now)).completedBriefing?.briefingSha256,reportSha256);
 await save(c.ownerId,1,{type:'project-briefing.save',projectId:'p1',briefing});
 await changePersonalState(db,c,{action:'ack',requestId:id,runId:id,reportSha256},'owner',now);
 assert.equal((await personalOwnerView(db,c,now)).completedBriefing,null);
 }finally{sqlite.close();}
});

test('a briefing admission retries the workspace fence and projects the latest framing',async()=>{
 const f=database();try{
 const c={version:1 as const,ownerId:'framing-race',deviceId:'race-pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 await loadWorkspace(f.db,c.ownerId,()=>workspaceFixture({projects:[projectFixture({framing:'Old framing.'})]}),now);
 await changePersonalState(f.db,c,{action:'poll',repositories:[repo]},'device',now);
 let raced=false;const db:SqlDatabase={prepare(sql){const statement=f.db.prepare(sql);const wrap:SqlStatement={bind(...values){statement.bind(...values);return wrap;},first:()=>statement.first(),all:()=>statement.all(),async run(){if(!raced&&sql.startsWith('UPDATE personal_repository_state SET row_revision')){raced=true;f.sqlite.prepare("UPDATE workspaces SET revision=revision+1,content=json_set(content,'$.projects[0].framing','New framing.') WHERE user_id=?").run(c.ownerId);}return statement.run();}};return wrap;},batch:statements=>f.db.batch(statements)};
 const admitted=await changePersonalState(db,c,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'codex'},'owner',now);
 assert.equal(raced,true);assert.equal(admitted.requests[0].framing?.workspaceRevision,2);assert.equal(admitted.requests[0].framing?.framing,'New framing.');
 }finally{f.sqlite.close();}
});
