import test from 'node:test';
import assert from 'node:assert/strict';
import {runProjectBriefing} from '../companion/briefing-run.mjs';
import {validateProjectBriefing} from '../shared/project-briefing.mjs';
const id='55555555-5555-4555-8555-555555555555';
const plan={revision:3,project:{id:'p1',name:'Trade Graph',goal:'First live trial',description:''},milestones:[{title:'Full cycle',status:'active',targetDate:null}],tasks:[{title:'Reconcile results',status:'doing',horizon:'now',dueDate:null,milestone:0,blocked:false,completedAt:null}],totals:{tasks:1,open:1,done:0,omitted:0}};
const evidence={identity:{root:'/tmp/repo',key:'repo-b',name:'trade-graph',head:'c'.repeat(40),dirty:false},branch:'main',bundle:{repository:{},window:{},localBranches:[],cloudBranches:[],uncommitted:{files:0,paths:[],summary:null},pullRequests:null,chats:[]},summary:{window:{since:'2026-10-07T12:00:00.000Z',until:'2026-10-21T12:00:00.000Z'},local:{branch:'main',commits:3,branches:1,latestCommitAt:'2026-10-21T09:00:00.000Z',uncommittedFiles:0},cloud:{status:'fetched',remote:'github.com/example/trade-graph',branches:1,commits:2,latestCommitAt:'2026-10-20T09:00:00.000Z',pullRequests:null,openPullRequests:null,fetchedAt:'2026-10-21T12:00:00.000Z'},chats:[{provider:'codex',status:'not-found',sessions:0,messages:0,latestAt:null},{provider:'claude',status:'included',sessions:1,messages:4,latestAt:'2026-10-21T08:00:00.000Z'}],plan:null,inputSha256:'7'.repeat(64)},fingerprint:'8'.repeat(64)};
const content=()=>({headline:'The full cycle works; reconciliation is still open.',status:{level:'on-track',reason:'One piece left.'},recentWork:[{title:'Full cycle',outcome:'finished',when:'2026-10-21',where:'local',detail:'Runs end to end.',evidence:['abc1234']}],unfinished:[],done:['Full cycle'],notDone:['Reconcile results'],decisionsNeeded:[],nextSteps:['Finish reconciliation.'],limitations:['Synthetic.']});
test('a briefing run packs evidence once, calls one provider and returns a validated briefing with its fingerprint',async()=>{
 let collected=0,prompts=[];const now=()=>'2026-10-21T12:00:00.000Z';
 const result=await runProjectBriefing({root:'/tmp/repo',requestId:id,provider:'claude',plan,origin:'auto'},{now,collect:async()=>{collected++;return evidence;},runners:{claude:async({prompt})=>{prompts.push(prompt);return {content:content(),observedModel:'claude-opus-5-5'};}}});
 assert.equal(collected,1);assert.equal(prompts.length,1);assert.ok(prompts[0].includes('Reconcile results'));
 assert.deepEqual(validateProjectBriefing(result.briefing),result.briefing);assert.equal(result.fingerprint,'8'.repeat(64));
 assert.equal(result.briefing.run.origin,'auto');assert.equal(result.briefing.run.observedModel,'claude-opus-5-5');assert.equal(result.briefing.project.name,'Trade Graph');assert.equal(result.briefing.repository.key,'repo-b');
 assert.deepEqual(result.briefing.evidence.plan,{revision:3,milestones:1,tasks:1});assert.equal(result.briefing.limitations.length,3);assert.match(result.briefing.limitations[1],/nothing was run or tested/);
});
test('invalid provider, plan, model identity or content fail closed without retry',async()=>{
 let calls=0;const run=(provider,runner,patch={})=>runProjectBriefing({root:'/tmp/repo',requestId:id,provider,plan:{...plan,...patch}},{collect:async()=>evidence,runners:{codex:async()=>{calls++;return runner();},claude:async()=>{calls++;return runner();}}});
 await assert.rejects(runProjectBriefing({root:'/tmp/repo',requestId:'bad',provider:'codex',plan},{}),/Invalid finite/);
 await assert.rejects(run('codex',()=>({content:content(),observedModel:'gpt-5'})),/Observed model differs/);
 await assert.rejects(run('codex',()=>({content:{...content(),headline:''},observedModel:null})),/Invalid project briefing/);
 await assert.rejects(run('claude',()=>({content:content()}),{project:{id:'p2',name:'Other',goal:'',description:''},tasks:[{...plan.tasks[0],milestone:3}]}),/Invalid project briefing/);
 assert.equal(calls,2);
});
