import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,projectFixture,taskFixture,FIXTURE_AT} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {projectBriefingCommandHandlers} from '../lib/project-briefing-handler.ts';
import {readProjectBriefings} from '../lib/project-briefing-store.ts';
import {contentHash,canonical} from '../lib/canonical-json.ts';
import {changePersonalState,personalOwnerView,personalDeviceView} from '../lib/personal-repository-store.ts';
import {initialPersonalState,transitionPersonalState,parseOwnerAction,parseDeviceAction,validatePersonalState,PERSONAL_LIMITS} from '../shared/personal-repository.mjs';
import {briefingFixture,planFixture} from './fixtures/briefing.ts';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',now='2026-10-21T12:00:00.000Z';
const later=(minutes:number)=>new Date(Date.parse(now)+minutes*60000).toISOString();
const repo={key:'repo-b',name:'trade-graph',head:'c'.repeat(40),dirty:false,hasPreviousAnalysis:false};
async function setup(){const {db,sqlite}=database();for(const owner of ['owner-a','owner-b'])await loadWorkspace(db,owner,()=>workspaceFixture({projects:[projectFixture({name:'Trade Graph'}),projectFixture({id:'p2'})],tasks:[taskFixture('t1',{status:'doing'})]}),FIXTURE_AT);let serial=0;const save=(owner:string,revision:number,command:unknown)=>executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:revision,mutationId:'briefing-mutation-'+String(++serial).padStart(4,'0'),command},{db,now:()=>FIXTURE_AT,handlers:projectBriefingCommandHandlers});return{db,sqlite,save};}
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
test('owner briefing request carries a server-projected plan; the device completes it and acknowledgment needs a saved copy',async()=>{
 const {db,save}=await setup();const c={version:1 as const,ownerId:'owner-a',deviceId:'synthetic-pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 await changePersonalState(db,c,{action:'poll',repositories:[repo]},'device',now);
 await assert.rejects(changePersonalState(db,c,{action:'brief',requestId:id,projectId:'missing',repositoryKey:'repo-b',provider:'claude'},'owner',now),/active project/);
 await changePersonalState(db,c,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'claude'},'owner',now);
 await changePersonalState(db,c,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'claude'},'owner',now);
 await assert.rejects(changePersonalState(db,c,{action:'brief',requestId:id,projectId:'p1',repositoryKey:'repo-b',provider:'codex'},'owner',now));
 const owner=await personalOwnerView(db,c,now);assert.equal(owner.jobs.length,1);assert.equal(owner.jobs[0].kind,'brief');assert.equal(Object.hasOwn(owner.jobs[0],'plan'),false);assert.equal(owner.completedBriefing,null);
 const claimed=await changePersonalState(db,c,{action:'poll'},'device',now);const device=personalDeviceView(claimed);
 assert.equal(device.job?.kind,'brief');assert.equal(device.job?.plan?.project.id,'p1');assert.equal(device.job?.plan?.project.name,'Trade Graph');assert.equal(device.job?.plan?.tasks[0].status,'doing');assert.equal(device.job?.origin,'owner');
 assert.equal(Date.parse(device.job!.expiresAt)-Date.parse(now),PERSONAL_LIMITS.briefMs);
 const briefing=briefingFixture({},id);
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
 const plan=planFixture();
 assert.throws(()=>transitionPersonalState(s,parseOwnerAction({action:'keep-current',repositoryKey:'unknown',projectId:'p1',provider:'codex',enabled:true}),now,'owner'));
 s=transitionPersonalState(s,parseOwnerAction({action:'keep-current',repositoryKey:'repo-b',projectId:'p1',provider:'codex',enabled:true}),now,'owner');
 assert.deepEqual(s.policies,[{repositoryKey:'repo-b',projectId:'p1',provider:'codex',enabled:true,minIntervalMinutes:PERSONAL_LIMITS.defaultIntervalMinutes,updatedAt:now,lastBriefAt:null,lastAttemptAt:null,lastFingerprint:null}]);
 const auto=parseDeviceAction({action:'auto-brief',requestId:id,repositoryKey:'repo-b',fingerprint:'1'.repeat(64)});
 assert.throws(()=>transitionPersonalState(s,auto,now,'device'),/invalid/u);
 s=transitionPersonalState(s,auto,now,'device',{plan});
 assert.equal(s.requests[0].status,'claimed');assert.equal(s.requests[0].origin,'auto');assert.equal(s.requests[0].provider,'codex');assert.equal(s.requests[0].requestedModel,'gpt-6.1-sol');assert.equal(s.policies[0].lastAttemptAt,now);
 // Idempotent re-send and refusal of a second concurrent automatic briefing.
 assert.deepEqual(transitionPersonalState(s,auto,now,'device',{plan}),s);
 assert.throws(()=>transitionPersonalState(s,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'2'.repeat(64)}),now,'device',{plan}),/not admitted/);
 const briefing=briefingFixture({run:{...briefingFixture().run,id,provider:'codex',requestedModel:'gpt-6.1-sol',observedModel:null,origin:'auto'}},id);
 s=transitionPersonalState(s,parseDeviceAction({action:'complete',requestId:id,briefing}),later(5),'device');s.requests[0].reportSha256=await contentHash(canonical(briefing));
 assert.equal(s.requests[0].status,'completed');assert.equal(s.policies[0].lastBriefAt,later(5));assert.equal(s.policies[0].lastFingerprint,'1'.repeat(64));
 // Same fingerprint or too soon: not due. Later with new work: due again.
 assert.throws(()=>transitionPersonalState(s,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'1'.repeat(64)}),later(200),'device',{plan}),/not due/);
 assert.throws(()=>transitionPersonalState(s,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'2'.repeat(64)}),later(30),'device',{plan}),/not due/);
 const due=transitionPersonalState(s,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'2'.repeat(64)}),later(200),'device',{plan});
 assert.equal(due.requests.length,2);assert.equal(due.requests[1].status,'claimed');
 // Switching the policy off keeps its history but admits nothing.
 const off=transitionPersonalState(s,parseOwnerAction({action:'keep-current',repositoryKey:'repo-b',projectId:'p1',provider:'codex',enabled:false}),later(1),'owner');
 assert.equal(off.policies[0].enabled,false);assert.equal(off.policies[0].lastBriefAt,later(5));
 assert.throws(()=>transitionPersonalState(off,parseDeviceAction({action:'auto-brief',requestId:other,repositoryKey:'repo-b',fingerprint:'2'.repeat(64)}),later(200),'device',{plan}),/not admitted/);
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
 const device=personalDeviceView(admitted);assert.equal(device.job?.id,id);assert.equal(device.job?.plan?.project.id,'p1');assert.equal(device.policies.length,1);assert.equal(device.policies[0].minIntervalMinutes,60);
 const owner=await personalOwnerView(db,c,now);assert.equal(owner.policies.length,1);assert.equal(Object.hasOwn(owner.policies[0],'lastFingerprint'),false);assert.equal(owner.jobs[0].origin,'auto');
});
