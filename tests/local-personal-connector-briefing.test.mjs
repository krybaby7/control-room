import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createPersonalConnector as createConnector,validatePersonalConfig,TEST_ONLY_PERSONAL_CONNECTION_POLICY} from '../companion/personal-connector.mjs';
import {repositoryIdentity} from '../companion/snapshot.mjs';
const createPersonalConnector=options=>createConnector({...options,testPolicy:TEST_ONLY_PERSONAL_CONNECTION_POLICY});
const config={siteOrigin:'https://control-room-fixture.chatgpt.site',siteServiceToken:'service-token',deviceKey:'device-key',deviceId:'device'};
test('synthetic origin requires fixed policy identity and injected transport; production config stays strict',async()=>{
 const fetch=async()=>{throw Error('Rejected composition must not reach transport.');};
 assert.throws(()=>validatePersonalConfig(config),/Invalid private personal connection/);
 await assert.rejects(createConnector({config,fetch}),/Invalid private personal connection/);
 await assert.rejects(createConnector({config,testPolicy:TEST_ONLY_PERSONAL_CONNECTION_POLICY}),/injected test transport/);
 await assert.rejects(createConnector({config,fetch,testPolicy:{...TEST_ONLY_PERSONAL_CONNECTION_POLICY}}),/injected test transport/);
 await assert.rejects(createConnector({config:{...config,siteOrigin:'https://arbitrary.example.invalid'},fetch,testPolicy:TEST_ONLY_PERSONAL_CONNECTION_POLICY}),/Invalid private personal connection/);
});
const framing={projectId:'p1',projectName:'Trade Graph',framing:'Owner framing.',includeTaskPlan:false,milestones:[],tasks:[],totalMilestones:0,totalTasks:0,workspaceRevision:3};
const plan={revision:3,project:{id:'p1',name:'Trade Graph',goal:'',description:''},milestones:[],tasks:[],totals:{tasks:0,open:0,done:0,omitted:0}};
const briefingFor=(id,key,provider,origin)=>({format:'control-room-project-briefing',version:1,project:{id:'p1',name:'Trade Graph'},repository:{key,name:'repo',head:'a'.repeat(40),branch:'main',dirty:false},run:{id,provider,requestedModel:provider==='codex'?'gpt-6.1-sol':'claude-code-default',observedModel:null,startedAt:'2026-10-21T00:00:00.000Z',completedAt:'2026-10-21T00:00:01.000Z',mode:'read-only',source:'personal-pc-connector',origin},evidence:{window:{since:'2026-10-07T00:00:00.000Z',until:'2026-10-21T00:00:00.000Z'},local:{branch:'main',commits:1,branches:1,latestCommitAt:null,uncommittedFiles:0},cloud:{status:'no-remote',remote:null,branches:0,commits:0,latestCommitAt:null,pullRequests:null,openPullRequests:null,fetchedAt:null},chats:[],plan:{revision:3,milestones:0,tasks:0},inputSha256:'1'.repeat(64)},headline:'Synthetic.',status:{level:'unclear',reason:'Synthetic.'},recentWork:[],unfinished:[],done:[],notDone:[],decisionsNeeded:[],nextSteps:[],limitations:[]});
async function repo(){const root=await realpath(await mkdtemp(join(tmpdir(),'briefing-repo-')));execFileSync('git',['init','-q',root]);await writeFile(join(root,'main.js'),'export const x=1;');execFileSync('git',['-C',root,'add','.']);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','fixture']);return root;}
test('an owner briefing job runs once, delivers the briefing with its fingerprint and keeps a private backup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'connector-brief-')),root=await repo();const sent=[];let calls=0;
 try{
  const repository=await repositoryIdentity(root);await writeFile(join(dir,'repositories.json'),JSON.stringify([root]));
  const job={id:'66666666-6666-4666-8666-666666666666',kind:'brief',status:'claimed',repositoryKey:repository.key,projectId:'p1',provider:'claude',requestedModel:'claude-code-default',origin:'owner',framing,expiresAt:new Date(Date.now()+600000).toISOString()};
  const connector=await createPersonalConnector({config,stateDirectory:dir,readiness:async()=>({codex:{ready:false,detail:'unavailable'},claude:{ready:true,detail:'ready'}}),brief:async(input,{signal})=>{calls++;assert.equal(input.root,root);assert.deepEqual(input.framing,framing);assert.equal(input.origin,'owner');assert.ok(signal);return {briefing:briefingFor(input.requestId,input.framing&&repository.key,input.provider,input.origin),fingerprint:'9'.repeat(64)};},fetch:async(url,options)=>{assert.equal(url,config.siteOrigin+'/api/personal-repositories/device');const body=JSON.parse(options.body);if(body.action==='poll')return new Response(JSON.stringify({job,policies:[]}));sent.push(body);return new Response(JSON.stringify({ok:true}));}});
  await connector.tick();await connector.tick();await connector.close();
  assert.equal(calls,1);const delivered=sent.find(body=>body.action==='complete');assert.ok(delivered);assert.equal(delivered.briefing.run.id,job.id);assert.equal(delivered.fingerprint,'9'.repeat(64));assert.equal(delivered.briefing.repository.key,repository.key);
  const backup=JSON.parse(await readFile(join(dir,job.id+'.json'),'utf8'));assert.equal(backup.kind,'brief');assert.equal(backup.report.run.id,job.id);
  const receipts=JSON.parse(await readFile(join(dir,'personal-job-receipts.json'),'utf8'));assert.equal(receipts[job.id].delivered,true);assert.equal(receipts[job.id].repositoryKey,repository.key);
 }finally{await rm(dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
test('automatic briefings ask the server only when the policy is due and the work fingerprint changed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'connector-auto-')),root=await repo();const sent=[];let fingerprintValue='a'.repeat(64),clock=Date.now(),briefs=0,policy;
 try{
  const repository=await repositoryIdentity(root);await writeFile(join(dir,'repositories.json'),JSON.stringify([root]));
  policy={repositoryKey:repository.key,provider:'codex',minIntervalMinutes:60,lastBriefAt:null,lastAttemptAt:null,lastFingerprint:'a'.repeat(64)};
  let admitted=null;
  const connector=await createPersonalConnector({config,stateDirectory:dir,autoCheckMs:1000,now:()=>clock,readiness:async()=>({codex:{ready:true,detail:'ready'},claude:{ready:false,detail:'unavailable'}}),fingerprint:async()=>fingerprintValue,brief:async(input)=>{briefs++;assert.equal(input.origin,'auto');return {briefing:briefingFor(input.requestId,repository.key,'codex','auto'),fingerprint:fingerprintValue};},fetch:async(url,options)=>{assert.equal(url,config.siteOrigin+'/api/personal-repositories/device');const body=JSON.parse(options.body);sent.push(body);if(body.action==='poll')return new Response(JSON.stringify({job:admitted,policies:[policy]}));if(body.action==='auto-brief'){admitted={id:body.requestId,kind:'brief',status:'claimed',repositoryKey:body.repositoryKey,projectId:'p1',provider:'codex',requestedModel:'gpt-6.1-sol',origin:'auto',framing,expiresAt:new Date(clock+600000).toISOString()};return new Response(JSON.stringify({ok:true,job:admitted,policies:[policy]}));}if(body.action==='complete'){admitted=null;policy={...policy,lastBriefAt:new Date(clock).toISOString(),lastFingerprint:body.fingerprint};}return new Response(JSON.stringify({ok:true}));}});
  // Unchanged fingerprint: nothing is requested.
  await connector.tick();assert.equal(sent.filter(body=>body.action==='auto-brief').length,0);assert.equal(briefs,0);
  // New work appears; the next check is throttled, then admitted and executed once.
  fingerprintValue='b'.repeat(64);await connector.tick();assert.equal(sent.filter(body=>body.action==='auto-brief').length,0);
  clock+=2000;await connector.tick();assert.equal(sent.filter(body=>body.action==='auto-brief').length,1);assert.equal(briefs,1);
  const completed=sent.find(body=>body.action==='complete');assert.equal(completed.briefing.run.origin,'auto');assert.equal(completed.fingerprint,'b'.repeat(64));
  // Within the interval, even changed work waits; after it, a new fingerprint is briefed again.
  fingerprintValue='c'.repeat(64);clock+=2000;await connector.tick();assert.equal(briefs,1);
  clock+=61*60000;await connector.tick();assert.equal(sent.filter(body=>body.action==='auto-brief').length,2);assert.equal(briefs,2);
  await connector.close();
 }finally{await rm(dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
test('a refused automatic briefing and a missing briefing runner never execute anything',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'connector-refused-')),root=await repo();let briefs=0;const sent=[];
 try{
  const repository=await repositoryIdentity(root);await writeFile(join(dir,'repositories.json'),JSON.stringify([root]));
  const policy={repositoryKey:repository.key,provider:'codex',minIntervalMinutes:60,lastBriefAt:null,lastAttemptAt:null,lastFingerprint:null};
  const refused=await createPersonalConnector({config,stateDirectory:dir,autoCheckMs:0,fingerprint:async()=>'d'.repeat(64),brief:async()=>{briefs++;},fetch:async(url,options)=>{assert.equal(url,config.siteOrigin+'/api/personal-repositories/device');const body=JSON.parse(options.body);sent.push(body);if(body.action==='auto-brief')return new Response(JSON.stringify({error:'Automatic briefing is not due.',definitiveRejection:true}),{status:409});return new Response(JSON.stringify({job:null,policies:[policy]}));}});
  await refused.tick();await refused.close();assert.equal(sent.filter(body=>body.action==='auto-brief').length,1);assert.equal(briefs,0);
  const silent=await createPersonalConnector({config,stateDirectory:dir,autoCheckMs:0,fetch:async(url,options)=>{assert.equal(url,config.siteOrigin+'/api/personal-repositories/device');const body=JSON.parse(options.body);sent.push(body);return new Response(JSON.stringify({job:null,policies:[policy]}));}});
  await silent.tick();await silent.close();assert.equal(sent.filter(body=>body.action==='auto-brief').length,1);
 }finally{await rm(dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});

for(const payload of [{plan},{framing:{...framing,projectId:'p2'}},{framing:{...framing,includeTaskPlan:false,tasks:[{title:'Forbidden',status:'doing',horizon:'now',dueDate:null,milestone:null,blocked:false,completedAt:null}]}}])test('invalid or legacy briefing payload is rejected before receipt or runner '+JSON.stringify(payload),async()=>{
 const dir=await mkdtemp(join(tmpdir(),'connector-invalid-framing-')),root=await repo();let calls=0;
 try{
  const repository=await repositoryIdentity(root);await writeFile(join(dir,'repositories.json'),JSON.stringify([root]));
  const job={id:'77777777-7777-4777-8777-777777777777',kind:'brief',status:'claimed',repositoryKey:repository.key,projectId:'p1',provider:'codex',requestedModel:'gpt-6.1-sol',origin:'owner',expiresAt:new Date(Date.now()+600000).toISOString(),...payload};
  const connector=await createPersonalConnector({config,stateDirectory:dir,readiness:async()=>({codex:{ready:true,detail:'ready'},claude:{ready:false,detail:'unavailable'}}),brief:async()=>{calls++;throw Error('Must not execute');},fetch:async()=>new Response(JSON.stringify({job,policies:[]}))});
  await assert.rejects(connector.tick(),/Invalid personal job/);await connector.close();assert.equal(calls,0);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'personal-job-receipts.json'),'utf8')),{});
 }finally{await rm(dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});

test('an automatic admission with foreign framing is rejected before receipt or runner',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'connector-auto-framing-')),root=await repo();let calls=0;
 try{
 const repository=await repositoryIdentity(root);await writeFile(join(dir,'repositories.json'),JSON.stringify([root]));
 const policy={repositoryKey:repository.key,provider:'codex',minIntervalMinutes:60,lastBriefAt:null,lastAttemptAt:null,lastFingerprint:null};
 const connector=await createPersonalConnector({config,stateDirectory:dir,autoCheckMs:0,fingerprint:async()=>'e'.repeat(64),readiness:async()=>({codex:{ready:true,detail:'ready'},claude:{ready:false,detail:'unavailable'}}),brief:async()=>{calls++;throw Error('Must not execute');},fetch:async(url,options)=>{const body=JSON.parse(options.body);if(body.action==='poll')return new Response(JSON.stringify({job:null,policies:[policy]}));return new Response(JSON.stringify({job:{id:body.requestId,kind:'brief',status:'claimed',repositoryKey:repository.key,projectId:'p1',provider:'codex',requestedModel:'gpt-6.1-sol',origin:'auto',framing:{...framing,projectId:'p2'},expiresAt:new Date(Date.now()+600000).toISOString()}}));}});
 await assert.rejects(connector.tick(),/Invalid personal job/);await connector.close();assert.equal(calls,0);assert.deepEqual(JSON.parse(await readFile(join(dir,'personal-job-receipts.json'),'utf8')),{});
 }finally{await rm(dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}
});
