import test from 'node:test';
import assert from 'node:assert/strict';
import {runProjectBriefing} from '../companion/briefing-run.mjs';
import {validateProjectBriefing} from '../shared/project-briefing.mjs';
const id='55555555-5555-4555-8555-555555555555';
const framing={projectId:'p1',projectName:'Trade Graph',framing:'First live trial',includeTaskPlan:true,milestones:[{title:'Full cycle',status:'active',targetDate:null}],tasks:[{title:'Reconcile results',status:'doing',horizon:'now',dueDate:null,milestone:0,blocked:false,completedAt:null}],totalMilestones:1,totalTasks:1,workspaceRevision:3};
const evidence={identity:{root:'/tmp/repo',key:'repo-b',name:'trade-graph',head:'c'.repeat(40),dirty:false},branch:'main',bundle:{repository:{},window:{},localBranches:[],cloudBranches:[],uncommitted:{files:0,paths:[],summary:null},pullRequests:null,chats:[]},summary:{window:{since:'2026-10-07T12:00:00.000Z',until:'2026-10-21T12:00:00.000Z'},local:{branch:'main',commits:3,branches:1,latestCommitAt:'2026-10-21T09:00:00.000Z',uncommittedFiles:0},cloud:{status:'fetched',remote:'github.com/example/trade-graph',branches:1,commits:2,latestCommitAt:'2026-10-20T09:00:00.000Z',pullRequests:null,openPullRequests:null,fetchedAt:'2026-10-21T12:00:00.000Z'},chats:[{provider:'codex',status:'not-found',sessions:0,messages:0,latestAt:null},{provider:'claude',status:'included',sessions:1,messages:4,latestAt:'2026-10-21T08:00:00.000Z'}],framing:null,ownerTurns:{sessions:1,turns:4,characters:300,earliestAt:'2026-10-20T08:00:00.000Z',latestAt:'2026-10-21T08:00:00.000Z'},previous:null,inputSha256:'7'.repeat(64)},fingerprint:'8'.repeat(64)};
const content=()=>({fitOrDrift:'The visible work fits the project frame.',aim:'Finish reconciliation before the trial.',status:{level:'on-track',reason:'One piece left.'},leftOff:['The full cycle works; reconciliation is still open.'],areas:[{id:'cycle',name:'Full cycle',state:'proven',done:1,total:1,note:'runs end to end'},{id:'reconcile',name:'Reconciliation',state:'open',done:0,total:1,note:'not started'}],links:[{from:'cycle',to:'reconcile'}],aimArea:'reconcile',intentions:[{date:'2026-10-21',title:'Run a full cycle',outcome:'Runs end to end.',state:'reached',source:'local-claude',area:'cycle',bend:null,evidence:['abc1234']}],open:['Reconciliation'],needsYou:[],tried:[],done:['Full cycle'],notDone:['Reconcile results'],nextSteps:['Finish reconciliation.'],limitations:['Synthetic.']});
const previous={runId:'33333333-3333-4333-8333-333333333333',until:'2026-10-18T12:00:00.000Z',aim:'Earlier aim',areas:[],links:[],aimArea:null,intentions:[{date:'2026-10-12',title:'Earlier intention',outcome:'Done.',state:'reached',source:'plan',area:null,bend:null,evidence:[]}],open:[],needsYou:[]};
test('framing run omits task records by default and records exactly what evidence was included',async()=>{
 const framing={projectId:'p1',projectName:'Trade Graph',framing:'Serve independent shops.',includeTaskPlan:false,milestones:[],tasks:[],totalMilestones:3,totalTasks:9,workspaceRevision:4};
 let calls=0;
 const result=await runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing},{collect:async()=>evidence,runners:{claude:async({prompt})=>{calls++;assert.ok(prompt.includes(framing.framing));return {content:{...content(),fitOrDrift:'The visible work fits the stated purpose.'}};}},now:()=>'2026-10-21T12:00:00.000Z'});
 assert.equal(calls,1);assert.equal(result.briefing.version,4);assert.deepEqual(result.briefing.evidence.framing,{workspaceRevision:4,characters:24,includeTaskPlan:false,totalMilestones:3,totalTasks:9,includedMilestones:0,includedTasks:0});assert.ok(!Object.hasOwn(result.briefing.evidence,'plan'));
 let collected=0;await assert.rejects(runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing:{...framing,framing:'x'.repeat(10001)}},{collect:async()=>{collected++;return evidence;}}));assert.equal(collected,0);
});
test('a briefing run packs evidence once, calls one provider and returns a validated briefing with its fingerprint',async()=>{
 let collected=0,prompts=[],seenPrevious=[];const now=()=>'2026-10-21T12:00:00.000Z';
 const result=await runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing,origin:'auto',previous},{now,collect:async(root,options)=>{collected++;seenPrevious.push(options.previous);return {...evidence,summary:{...evidence.summary,previous:{runId:previous.runId,until:previous.until,intentions:previous.intentions.length}}};},runners:{claude:async({prompt})=>{prompts.push(prompt);return {content:content(),observedModel:'claude-opus-5-5'};}}});
 assert.equal(collected,1);assert.equal(prompts.length,1);assert.ok(prompts[0].includes('Reconcile results'));assert.ok(prompts[0].includes('Earlier intention'),'the previous ledger reaches the model');assert.deepEqual(seenPrevious,[{...previous,fitOrDrift:'This earlier briefing did not assess whether the work fits your project framing.'}]);
 assert.equal(result.briefing.version,4);assert.deepEqual(result.briefing.evidence.previous,{runId:previous.runId,until:previous.until,intentions:1});
 assert.deepEqual(validateProjectBriefing(result.briefing),result.briefing);assert.equal(result.fingerprint,'8'.repeat(64));
 assert.equal(result.briefing.run.origin,'auto');assert.equal(result.briefing.run.observedModel,'claude-opus-5-5');assert.equal(result.briefing.project.name,'Trade Graph');assert.equal(result.briefing.repository.key,'repo-b');
 assert.deepEqual(result.briefing.evidence.framing,{workspaceRevision:3,characters:16,includeTaskPlan:true,totalMilestones:1,totalTasks:1,includedMilestones:1,includedTasks:1});assert.equal(result.briefing.limitations.length,3);assert.match(result.briefing.limitations[1],/nothing was run or tested/);
});
test('invalid provider, plan, model identity or content fail closed without retry',async()=>{
 let calls=0;const run=(provider,runner,patch={})=>runProjectBriefing({root:'/tmp/repo',requestId:id,provider,framing:{...framing,...patch}},{collect:async()=>evidence,runners:{codex:async()=>{calls++;return runner();},claude:async()=>{calls++;return runner();}}});
 await assert.rejects(runProjectBriefing({root:'/tmp/repo',requestId:'bad',provider:'codex',framing},{}),/Invalid finite/);
 await assert.rejects(run('codex',()=>({content:content(),observedModel:'gpt-5'})),/Observed model differs/);
 await assert.rejects(run('codex',()=>({content:{...content(),aim:''},observedModel:null})),/Invalid project briefing/);
 await assert.rejects(runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing,previous:{...previous,runId:id}},{collect:async()=>evidence,runners:{claude:async()=>{calls++;return {content:content()};}}}),/Invalid finite/);
 await assert.rejects(runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing,previous:{...previous,links:[{from:'a',to:'b'}]}},{collect:async()=>evidence,runners:{claude:async()=>{calls++;return {content:content()};}}}),/Invalid project briefing/);
 await assert.rejects(run('claude',()=>({content:content()}),{projectId:'p2',tasks:[{...framing.tasks[0],milestone:3}]}),/Invalid project briefing/);
 assert.equal(calls,2);
});
test('synthetic model stub receives cloud owner evidence once and returns cloud provenance',async()=>{
 const cloudSession={provider:'claude-cloud',source:'cloud',sessionId:'cloud-fixture',title:'Reconciliation',origin:'repository-handoff',latestAt:'2026-10-21T08:00:00.000Z',turns:['Finish the cloud-only reconciliation.'],truncated:false,sinceLastBriefing:false};
 const cloudTurns=[{provider:'claude-cloud',status:'included',sessions:1,turns:1},{provider:'codex-cloud',status:'not-found',sessions:0,turns:0}];
 let calls=0,seenPrompt='';
 const result=await runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing},{collect:async()=>({...evidence,bundle:{...evidence.bundle,ownerTurns:[cloudSession]},summary:{...evidence.summary,cloudTurns}}),runners:{claude:async({prompt})=>{calls++;seenPrompt=prompt;const generated=content();generated.intentions[0]={...generated.intentions[0],title:'Finish reconciliation',source:'cloud',cloudProvider:'claude-cloud'};return {content:generated};}},now:()=>'2026-10-21T12:00:00.000Z'});
 assert.equal(calls,1);assert.ok(seenPrompt.includes('Finish the cloud-only reconciliation.'));assert.ok(seenPrompt.includes('repository-handoff'));assert.deepEqual(result.briefing.evidence.cloudTurns,cloudTurns);assert.equal(result.briefing.intentions[0].source,'cloud');assert.equal(result.briefing.intentions[0].cloudProvider,'claude-cloud');
});

test('new cloud intentions need a retained owner source while previous cloud rows can carry forward',async()=>{
 const generated=content();generated.intentions[0]={...generated.intentions[0],source:'cloud',cloudProvider:'codex-cloud'};
 const run=(output,prior=null)=>runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing,previous:prior},{collect:async()=>evidence,runners:{claude:async()=>({content:output})},now:()=>'2026-10-21T12:00:00.000Z'});
 await assert.rejects(run(generated),/Cloud intention has no matching owner-turn source/);
 delete generated.intentions[0].cloudProvider;
 await assert.rejects(run(generated),/Cloud intention has no matching owner-turn source/);
 const carried={...previous,areas:generated.areas,links:generated.links,intentions:generated.intentions};
 const result=await run(generated,carried);
 assert.equal(result.briefing.intentions[0].source,'cloud');
 assert.equal(result.briefing.intentions[0].cloudProvider,undefined);
});

test('task records cannot create intentions and historical plan rows retain their original provenance',async()=>{
 const generated=content();generated.intentions[0]={...generated.intentions[0],source:'plan'};
 const run=(output,prior=null)=>runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing,previous:prior},{collect:async()=>evidence,runners:{claude:async()=>({content:output})},now:()=>'2026-10-21T12:00:00.000Z'});
 await assert.rejects(run(generated),/New intentions cannot come from framing or task records/);
 const carried={...previous,areas:generated.areas,links:generated.links,intentions:generated.intentions};
 assert.equal((await run(generated,carried)).briefing.intentions[0].source,'plan');
 const missing=content();delete missing.fitOrDrift;await assert.rejects(run(missing),/Invalid project briefing/);
});

test('two folders produce one project report and one model call with folder provenance',async()=>{
 const repositories=[{key:'repo-b',root:'/tmp/one'},{key:'repo-c',root:'/tmp/two'}];let collected=0,calls=0;
 const coverage=key=>({key,name:key==='repo-b'?evidence.identity.name:key,local:evidence.summary.local,cloud:evidence.summary.cloud,chats:evidence.summary.chats,ownerTurns:evidence.summary.ownerTurns});
 const pack={...evidence,identities:repositories.map(row=>({...evidence.identity,key:row.key,name:row.key==='repo-b'?evidence.identity.name:row.key,branch:'main'})),bundle:{repositories:repositories.map(row=>({repositoryKey:row.key,name:row.key,chats:[],localBranches:[],cloudBranches:[]})),ownerTurns:[]},summary:{...evidence.summary,repositories:repositories.map(row=>coverage(row.key))}};
 const result=await runProjectBriefing({repositories,requestId:id,provider:'claude',framing},{collectProject:async(rows)=>{collected++;assert.deepEqual(rows,repositories);return pack;},runners:{claude:async({prompt})=>{calls++;assert.ok(prompt.includes('repo-b')&&prompt.includes('repo-c'));const generated=content();generated.areas[0].repositoryKey='repo-c';generated.intentions[0].repositoryKey='repo-c';return {content:generated};}}});
 assert.equal(collected,1);assert.equal(calls,1);assert.deepEqual(result.briefing.repositories.map(row=>row.key),['repo-b','repo-c']);assert.equal(result.briefing.intentions[0].repositoryKey,'repo-c');
});

test('cloud ledger from a removed folder carries as historical project scope',async()=>{
 const old={...previous,intentions:[{...content().intentions[0],source:'cloud',cloudProvider:'codex-cloud',repositoryKey:'removed-folder',area:null}]};
 let calls=0;const result=await runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',framing,previous:old},{collect:async()=>structuredClone(evidence),runners:{claude:async()=>{calls++;const generated=content();generated.intentions=[{...old.intentions[0]}];delete generated.intentions[0].repositoryKey;return {content:generated};}}});
 assert.equal(calls,1);assert.equal(result.briefing.intentions[0].cloudProvider,'codex-cloud');assert.equal(result.briefing.intentions[0].repositoryKey,undefined);
});
