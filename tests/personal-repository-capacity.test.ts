import {PERSONAL_COMPANION_PROTOCOL,PERSONAL_COMPANION_KINDS} from '../shared/personal-repository.mjs';
const companion={protocol:PERSONAL_COMPANION_PROTOCOL,kinds:PERSONAL_COMPANION_KINDS};
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {briefingFixture,planFixture} from './fixtures/briefing.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {handlePersonalRepositoryHttp} from '../lib/personal-repository-http.ts';
import {changePersonalState,personalOwnerView,personalDeviceView} from '../lib/personal-repository-store.ts';
import {initialPersonalState,validatePersonalState,PERSONAL_LIMITS,type PersonalState} from '../shared/personal-repository.mjs';
import {personalRepositoryExportAdapter} from '../lib/personal-repository-module.ts';
import {ownerReader} from '../lib/workspace-modules.ts';

const now='2026-10-21T12:00:00.000Z',origin='https://example.chatgpt.site';
const configuration={version:1 as const,ownerId:'capacity-owner',deviceId:'capacity-pc',keyHash:'a'.repeat(64),siteOrigin:origin};
const requestId='11111111-1111-4111-8111-111111111111',resultId='22222222-2222-4222-8222-222222222222';
function history(count:number):PersonalState {
 const state=initialPersonalState(configuration.deviceId);
 state.repositories=[{key:'repo-b',name:'Synthetic',head:'c'.repeat(40),dirty:false,hasPreviousAnalysis:false}];
 state.requests=Array.from({length:count},(_,i)=>({id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),kind:'browse',status:'completed',createdAt:now,expiresAt:now,claimedAt:now}));
 return state;
}
async function seed(db:SqlDatabase,state:PersonalState){
 const payload=canonical(state);
 await db.prepare('INSERT INTO personal_repository_state(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(configuration.ownerId,configuration.deviceId,payload,await contentHash(payload)).run();
 await loadWorkspace(db,configuration.ownerId,()=>{const workspace=workspaceFixture();workspace.projects[0].personalRepositoryKeys=['repo-b'];return workspace;},now);
}
const post=(action:unknown)=>new Request(origin+'/api/personal-repositories',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(action)});

for(const count of [20,100])for(const action of ['browse','analyze','brief'] as const){
 test(`${action} admits new requests after ${count} finished requests without clearing history or unsaved results`,async()=>{
  const f=database();try{
   const state=history(count),briefing=briefingFixture({},resultId);
   state.requests[0]={id:resultId,kind:'brief',status:'completed',createdAt:now,expiresAt:now,claimedAt:now,projectId:'p1',repositoryKey:'repo-b',provider:'claude',requestedModel:briefing.run.requestedModel,origin:'owner',plan:planFixture(),briefing,reportSha256:await contentHash(canonical(briefing))};
   await seed(f.db,state);
   const command=action==='browse'?{action,requestId}:{action,requestId,projectId:'p1',repositoryKey:'repo-b',provider:'claude'};
   const deps={db:f.db,configuration:JSON.stringify(configuration),ownerId:configuration.ownerId,now:()=>now};
   const response=await handlePersonalRepositoryHttp(post(command),'owner',deps);
   assert.equal(response.status,200,JSON.stringify(await response.json()));
   const stored=JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM personal_repository_state').get()!.payload_json));
   assert.deepEqual(stored.requests.slice(0,count),state.requests);
   assert.equal(stored.requests.length,count+1);
   assert.equal(stored.requests.at(-1).id,requestId);
   if(action==='brief'){assert.equal(stored.requests.at(-1).framing.projectId,'p1');assert.equal(stored.requests.at(-1).framing.includeTaskPlan,false);assert.equal(Object.hasOwn(stored.requests.at(-1),'plan'),false);}
   assert.deepEqual((await personalOwnerView(f.db,configuration,now)).completedBriefing?.briefing,briefing);
   assert.equal((await handlePersonalRepositoryHttp(post(command),'owner',deps)).status,200);
   const polled=await changePersonalState(f.db,configuration,{action:'poll',companion},'device',now);
   assert.equal(polled.requests.length,count+1);
   assert.equal(personalDeviceView(polled).job?.id,requestId);
   assert.equal(personalDeviceView(await changePersonalState(f.db,configuration,{action:'poll',companion},'device',now)).job?.id,requestId);
  }finally{f.sqlite.close();}
 });
}

test('automatic briefing admits after 100 finished requests and still refuses a concurrent run',async()=>{
 const f=database();try{
  const state=history(100);await seed(f.db,state);
  await changePersonalState(f.db,configuration,{action:'keep-current',projectId:'p1',repositoryKey:'repo-b',provider:'codex',enabled:true},'owner',now);
  const command={action:'auto-brief',companion,requestId,repositoryKey:'repo-b',fingerprint:'f'.repeat(64)};
  const admitted=await changePersonalState(f.db,configuration,command,'device',now);
  assert.deepEqual(admitted.requests.slice(0,100),state.requests);
  assert.equal(admitted.requests.length,101);
  assert.equal(personalDeviceView(admitted).job?.id,requestId);
  assert.equal((await changePersonalState(f.db,configuration,command,'device',now)).requests.length,101);
  await assert.rejects(changePersonalState(f.db,configuration,{...command,requestId:resultId},'device',now),/not admitted/);
 }finally{f.sqlite.close();}
});

test('large request histories still validate every identity and retain the payload byte bound',()=>{
 const state=history(100);assert.deepEqual(validatePersonalState(state),state);
 const duplicate=structuredClone(state);duplicate.requests[99].id=duplicate.requests[0].id;assert.throws(()=>validatePersonalState(duplicate));
 const malformed=structuredClone(state);malformed.requests[99].status='invalid' as never;assert.throws(()=>validatePersonalState(malformed));
 const oversized=history(Math.ceil(PERSONAL_LIMITS.stateBytes/100));
 assert.ok(Buffer.byteLength(JSON.stringify(oversized))>PERSONAL_LIMITS.stateBytes);
 assert.throws(()=>validatePersonalState(oversized));
});

test('backup round-trips more than 20 requests and restores disconnected without replay',async()=>{
 const f=database();try{
  const state=history(100);state.requests[99]={...state.requests[99],status:'queued',claimedAt:null,expiresAt:'2026-10-21T12:10:00.000Z'};
  await seed(f.db,state);
  const rows=await personalRepositoryExportAdapter.exportRows({userId:configuration.ownerId,sourceRevision:1,query:ownerReader(f.db,configuration.ownerId),db:f.db});
  const parsed=personalRepositoryExportAdapter.parseAndMigrate({schemaVersion:1,records:rows});
  const replaced=await personalRepositoryExportAdapter.prepareReplace!({planning:workspaceFixture(),modules:{}},parsed);
  const restored=replaced[0].records[0].value as unknown as PersonalState;
  assert.equal(restored.connected,false);
  assert.deepEqual(restored.requests.slice(0,99),state.requests.slice(0,99));
  assert.equal(restored.requests[99].id,state.requests[99].id);
  assert.equal(restored.requests[99].status,'failed');
  assert.equal(restored.requests.length,100);
 }finally{f.sqlite.close();}
});
