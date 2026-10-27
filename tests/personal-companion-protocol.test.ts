import test from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../shared/personal-repository.mjs';
import {database} from './helpers/sqlite.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {changePersonalState,personalDeviceView,personalOwnerView} from '../lib/personal-repository-store.ts';

const now='2026-10-27T12:00:00.000Z',later='2026-10-27T12:00:05.000Z';
const id='11111111-1111-4111-8111-111111111111';
const current={protocol:1,kinds:['browse','analyze','brief'] as const};
const framing={projectId:'p1',projectName:'Synthetic',framing:'Owner framing.',includeTaskPlan:false,milestones:[],tasks:[],totalMilestones:0,totalTasks:0,workspaceRevision:1};
const repo={key:'repo',name:'Synthetic',head:'a'.repeat(40),dirty:false,hasPreviousAnalysis:false};
function queued(kind:'browse'|'analyze'|'brief'='brief'){
 const s=protocol.initialPersonalState('synthetic-pc');s.repositories=[repo];
 const action=kind==='browse'?{action:kind,requestId:id}:{action:kind,requestId:id,projectId:'p1',repositoryKey:'repo',provider:'codex' as const};
 return protocol.transitionPersonalState(s,action,now,'owner',{framing});
}

test('companion declaration is bounded and strict, and omitted declaration remains accepted',()=>{
 assert.deepEqual(protocol.parseDeviceAction({action:'poll'}),{action:'poll'});
 assert.deepEqual(protocol.parseDeviceAction({action:'poll',companion:current}),{action:'poll',companion:current});
 assert.deepEqual((protocol.parseDeviceAction({action:'poll',companion:{protocol:0,kinds:[]}}) as Extract<protocol.PersonalDeviceAction,{action:'poll'}>).companion,{protocol:0,kinds:[]});
 for(const companion of [null,[],{}, {...current,secret:'no'}, {...current,protocol:-1},{...current,protocol:256},{...current,protocol:1.5},{...current,protocol:'1'},{...current,kinds:['brief','brief']},{...current,kinds:['future']},{...current,kinds:['browse','analyze','brief','brief']},{...current,release:'x'.repeat(65)},{...current,release:'private/path'},{...current,release:''}])assert.throws(()=>protocol.parseDeviceAction({action:'poll',companion}));
 const release={...current,release:'20261027-reviewed1'};
 assert.deepEqual((protocol.parseDeviceAction({action:'poll',companion:release}) as Extract<protocol.PersonalDeviceAction,{action:'poll'}>).companion,release);
 assert.throws(()=>protocol.parseDeviceAction({action:'fail',requestId:id,error:'unsupported',companion:current}));
});

test('legacy poll fails queued briefing immediately without claiming it',()=>{
 const s=protocol.transitionPersonalState(queued(),{action:'poll'},now,'device');
 assert.equal(s.requests[0].status,'failed');assert.equal(s.requests[0].error,'companion_outdated');
 assert.equal(s.requests[0].claimedAt,null);assert.match(s.requests[0].errorDetail!,/brief.*protocol 1/u);
 assert.equal(personalDeviceView(s).job,null);
});

for(const kind of ['browse','analyze'] as const)test(`legacy companion still claims ${kind}`,()=>{
 const s=protocol.transitionPersonalState(queued(kind),{action:'poll'},now,'device');
 assert.equal(s.requests[0].status,'claimed');assert.equal(personalDeviceView(s).job?.kind,kind);
});

test('current declaration claims a briefing with unchanged ten-minute window',()=>{
 const s=protocol.transitionPersonalState(queued(),{action:'poll',companion:current},now,'device');
 assert.equal(s.requests[0].status,'claimed');assert.equal(s.requests[0].claimedAt,now);
 assert.equal(Date.parse(s.requests[0].expiresAt)-Date.parse(now),protocol.PERSONAL_LIMITS.briefMs);
 assert.equal(personalDeviceView(s).job?.kind,'brief');
});

for(const companion of [{protocol:0,kinds:['brief']},{protocol:1,kinds:['browse','analyze']},{protocol:1,kinds:[]}] satisfies protocol.PersonalCompanionDeclaration[])test(`declared unsupported briefing is failed (${JSON.stringify(companion)})`,()=>{
 const s=protocol.transitionPersonalState(queued(),{action:'poll',companion},now,'device');
 assert.equal(s.requests[0].error,'companion_outdated');assert.equal(s.requests[0].claimedAt,null);
});

test('legacy poll cannot receive or interrupt a briefing already claimed by a capable companion',()=>{
 const claimed=protocol.transitionPersonalState(queued(),{action:'poll',companion:current},now,'device');
 const legacy=protocol.transitionPersonalState(claimed,{action:'poll'},later,'device');
 assert.equal(personalDeviceView(legacy).job,null);assert.deepEqual(legacy.requests,claimed.requests);
 const resumed=protocol.transitionPersonalState(legacy,{action:'poll',companion:current},later,'device');
 assert.deepEqual(resumed.requests,claimed.requests);assert.equal(personalDeviceView(resumed).job?.id,id);
});

test('automatic admission also requires its own companion declaration',()=>{
 let s=protocol.initialPersonalState('synthetic-pc');s.repositories=[repo];
 s=protocol.transitionPersonalState(s,{action:'keep-current',projectId:'p1',repositoryKey:'repo',provider:'codex',enabled:true},now,'owner');
 const action={action:'auto-brief' as const,requestId:id,projectId:'p1',fingerprint:'f'.repeat(64)};
 // A previous capable poll cannot lend its declaration to another process with the same credential.
 const seen=protocol.transitionPersonalState(s,{action:'poll',companion:current},now,'device');
 const legacy=protocol.transitionPersonalState(seen,action,now,'device',{framing});
 assert.equal(legacy.requests[0].status,'failed');assert.equal(legacy.requests[0].error,'companion_outdated');assert.equal(legacy.requests[0].claimedAt,null);
 const capable=protocol.transitionPersonalState(s,{...action,companion:current},now,'device',{framing});
 assert.equal(capable.requests[0].status,'claimed');assert.equal(personalDeviceView(capable).job?.id,id);
});

test('all historical saved error codes still parse without migration or byte changes',()=>{
 for(const error of ['deadline_exceeded','cancelled','folder_unavailable','provider_unavailable','analysis_failed','interrupted','disconnected']){
  const s=queued('browse');s.requests[0].status='failed';s.requests[0].error=error;
  assert.deepEqual(protocol.validatePersonalState(s),s);
 }
 const s=protocol.transitionPersonalState(queued('browse'),{action:'poll'},now,'device');
 const failed=protocol.transitionPersonalState(s,{action:'fail',requestId:id,error:'unsupported'},now,'device');
 assert.equal(protocol.validatePersonalState(failed).requests[0].error,'unsupported');
});

test('store old-then-current polls persist fast failure and expose last companion and raw check-in time',async()=>{
 const f=database(),c={version:1 as const,ownerId:'synthetic-owner',deviceId:'synthetic-pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 try{
  const payload=canonical(queued());
  await f.db.prepare('INSERT INTO personal_repository_state(user_id,id,row_revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?)').bind(c.ownerId,c.deviceId,payload,await contentHash(payload),now).run();
  const legacy=await changePersonalState(f.db,c,{action:'poll'},'device',now);
  assert.equal(legacy.requests[0].error,'companion_outdated');assert.equal(personalDeviceView(legacy).job,null);
  const old=await personalOwnerView(f.db,c,now);assert.equal(old.companion?.legacy,true);assert.equal(old.companion?.protocol,null);assert.equal(old.companion?.lastSeenAt,now);
  const modern=await changePersonalState(f.db,c,{action:'poll',companion:current},'device',later);
  assert.equal(modern.requests[0].status,'failed');assert.equal(modern.requests[0].claimedAt,null);assert.equal(personalDeviceView(modern).job,null);
  const view=await personalOwnerView(f.db,c,later);assert.equal(view.companion?.legacy,false);assert.equal(view.companion?.protocol,1);assert.equal(view.companion?.lastSeenAt,later);
  const before=f.sqlite.prepare('SELECT row_revision,payload_json FROM personal_repository_state').get()!;
  await changePersonalState(f.db,c,{action:'poll',companion:current},'device','2026-10-27T12:00:10.000Z');
  const after=f.sqlite.prepare('SELECT row_revision,payload_json FROM personal_repository_state').get()!;
  assert.deepEqual(after,before);assert.equal((await personalOwnerView(f.db,c,later)).companion?.lastSeenAt,'2026-10-27T12:00:10.000Z');
 }finally{f.sqlite.close();}
});
