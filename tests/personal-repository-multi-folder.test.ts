import test from 'node:test';
import assert from 'node:assert/strict';
import {initialPersonalState,transitionPersonalState,parseOwnerAction,parseDeviceAction,parsePolicies} from '../shared/personal-repository.mjs';
const now='2026-10-26T12:00:00.000Z',id='11111111-1111-4111-8111-111111111111';
const framing={projectId:'p1',projectName:'Project',framing:'One whole project.',includeTaskPlan:false,milestones:[],tasks:[],totalMilestones:0,totalTasks:0,workspaceRevision:1};
function state(){const s=initialPersonalState('pc');s.repositories=['app','map'].map(key=>({key,name:key,head:'a'.repeat(40),dirty:false,hasPreviousAnalysis:false}));return s;}
test('new briefing pins all server supplied folders and rejects client folder arrays',()=>{
 const s=transitionPersonalState(state(),{action:'brief',requestId:id,projectId:'p1',repositoryKey:'app',provider:'codex'},now,'owner',{framing,repositoryKeys:['app','map']});
 assert.deepEqual(s.requests[0].repositoryKeys,['app','map']);
 assert.throws(()=>parseOwnerAction({action:'brief',requestId:id,projectId:'p1',repositoryKey:'app',repositoryKeys:['map'],provider:'codex'}));
});
test('keep-current updates one project policy even when the legacy selector changes',()=>{
 let s=transitionPersonalState(state(),{action:'keep-current',projectId:'p1',repositoryKey:'app',provider:'codex',enabled:true},now,'owner',{repositoryKeys:['app','map']});
 s=transitionPersonalState(s,{action:'keep-current',projectId:'p1',repositoryKey:'map',provider:'claude',enabled:true},now,'owner',{repositoryKeys:['app','map']});
 assert.equal(s.policies.length,1);assert.deepEqual(s.policies[0].repositoryKeys,['app','map']);
 assert.throws(()=>parsePolicies([s.policies[0],{...s.policies[0],repositoryKey:'map'}]));
 const a=parseDeviceAction({action:'auto-brief',requestId:id,projectId:'p1',fingerprint:'f'.repeat(64)});
 s=transitionPersonalState(s,a,now,'device',{framing,repositoryKeys:['app','map']});assert.deepEqual(s.requests[0].repositoryKeys,['app','map']);
});
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,projectFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {changePersonalState,personalDeviceView} from '../lib/personal-repository-store.ts';
import {briefingFixture} from './fixtures/briefing.ts';
test('server projects complete folder list and framing, completion updates both folders',async()=>{
 const f=database();try{
 const c={version:1 as const,ownerId:'synthetic-multi',deviceId:'pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 await loadWorkspace(f.db,c.ownerId,()=>workspaceFixture({projects:[projectFixture({name:'Trade Graph',framing:'The app and map work together.',personalRepositoryKeys:['repo-b','map']})]}),now);
 await changePersonalState(f.db,c,{action:'poll',repositories:['repo-b','map'].map(key=>({key,name:key,head:'a'.repeat(40),dirty:false,hasPreviousAnalysis:false}))},'device',now);
 await assert.rejects(changePersonalState(f.db,c,{action:'brief',requestId:id,projectId:'p1',provider:'claude',repositoryKeys:['map']},'owner',now));
 await changePersonalState(f.db,c,{action:'brief',requestId:id,projectId:'p1',provider:'claude'},'owner',now);
 let s=await changePersonalState(f.db,c,{action:'poll'},'device',now);const job=personalDeviceView(s).job!;
 assert.deepEqual(job.repositoryKeys,['repo-b','map']);assert.equal(job.framing?.framing,'The app and map work together.');
 const b=briefingFixture({},id),framing=job.framing!;
 b.evidence.framing={workspaceRevision:framing.workspaceRevision,characters:framing.framing.length,includeTaskPlan:false,totalMilestones:framing.totalMilestones,totalTasks:framing.totalTasks,includedMilestones:0,includedTasks:0};
 await assert.rejects(changePersonalState(f.db,c,{action:'complete',requestId:id,briefing:b},'device',now));
 b.repositories.push({...b.repository,key:'map',name:'Map lab',head:'d'.repeat(40),dirty:true});b.evidence.repositories.push({...structuredClone(b.evidence.repositories[0]),key:'map',name:'Map lab'});
 s=await changePersonalState(f.db,c,{action:'complete',requestId:id,briefing:b},'device',now);
 assert.equal(s.repositories[0].head,b.repository.head);assert.equal(s.repositories[1].head,'d'.repeat(40));assert.equal(s.repositories[1].dirty,true);
 }finally{f.sqlite.close();}
});

test('device polling reprojects enabled project folders after membership changes and disables archived policies',async()=>{
 const f=database();try{
 const c={version:1 as const,ownerId:'synthetic-policy',deviceId:'pc',keyHash:'a'.repeat(64),siteOrigin:'https://example.chatgpt.site'};
 await loadWorkspace(f.db,c.ownerId,()=>workspaceFixture({projects:[projectFixture({personalRepositoryKeys:['app']})]}),now);
 const repositories=['app','map'].map(key=>({key,name:key,head:'a'.repeat(40),dirty:false,hasPreviousAnalysis:false}));
 await changePersonalState(f.db,c,{action:'poll',repositories},'device',now);
 await changePersonalState(f.db,c,{action:'keep-current',projectId:'p1',provider:'codex',enabled:true},'owner',now);
 f.sqlite.prepare("UPDATE workspaces SET revision=revision+1,content=json_set(content,'$.projects[0].personalRepositoryKeys',json_array('app','map')) WHERE user_id=?").run(c.ownerId);
 let s=await changePersonalState(f.db,c,{action:'poll'},'device',now);assert.deepEqual(personalDeviceView(s).policies[0].repositoryKeys,['app','map']);
 s=await changePersonalState(f.db,c,{action:'poll',repositories:[repositories[0]]},'device',now);assert.equal(personalDeviceView(s).policies.length,0);assert.equal(s.policies[0].enabled,true);
 f.sqlite.prepare("UPDATE workspaces SET revision=revision+1,content=json_set(content,'$.projects[0].archivedAt',?) WHERE user_id=?").run(now,c.ownerId);
 s=await changePersonalState(f.db,c,{action:'poll',repositories},'device',now);assert.equal(s.policies[0].enabled,false);assert.equal(personalDeviceView(s).policies.length,0);
 }finally{f.sqlite.close();}
});

test('modern disabled policy does not reserve a removed folder against another project',()=>{
 const policy={repositoryKey:'app',repositoryKeys:['app'],projectId:'old',provider:'codex',enabled:false,minIntervalMinutes:120,updatedAt:now,lastBriefAt:null,lastAttemptAt:null,lastFingerprint:null};
 assert.equal(parsePolicies([policy,{...policy,projectId:'new',enabled:true}]).length,2);
});
