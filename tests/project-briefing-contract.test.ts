import test from 'node:test';
import assert from 'node:assert/strict';
import {validateProjectBriefing,validateBriefingContent,compactPlan,validateCompactPlan,COMPACT_PLAN_MAX_CHARACTERS,PROJECT_BRIEFING_MAX_CHARACTERS} from '../shared/project-briefing.mjs';
import {briefingFixture} from './fixtures/briefing.ts';
import {workspaceFixture,projectFixture,taskFixture,milestoneFixture,FIXTURE_AT} from './helpers/workspace.ts';
test('a complete briefing validates and round-trips without extra fields',()=>{
 const value=briefingFixture();assert.deepEqual(validateProjectBriefing(value),value);
 for(const edit of ([v=>{(v as unknown as {extra:number}).extra=1;},v=>{v.run.origin='device' as never;},v=>{v.recentWork[0].when='2026-13-01';},v=>{v.run.observedModel='gpt-6.1-sol';},v=>{v.evidence.cloud.status='no-remote';},v=>{v.evidence.chats[0].sessions=0;},v=>{v.run.completedAt='2026-10-21T11:00:00.000Z';},v=>{v.headline='';},v=>{v.status.level='done' as never;}] as ((v:ReturnType<typeof briefingFixture>)=>void)[])){const broken=briefingFixture();edit(broken);assert.throws(()=>validateProjectBriefing(broken));}
 assert.throws(()=>validateProjectBriefing({...briefingFixture(),done:Array.from({length:8},()=>'x'.repeat(160)),notDone:Array.from({length:8},()=>'y'.repeat(160)),recentWork:Array.from({length:8},()=>({title:'t'.repeat(120),outcome:'finished',when:null,where:'local',detail:'d'.repeat(240),evidence:['e'.repeat(60),'f'.repeat(60),'g'.repeat(60)]}))}),/report size/);
 assert.ok(JSON.stringify(briefingFixture()).length<PROJECT_BRIEFING_MAX_CHARACTERS);
});
test('model content is validated on its own with bounded prose and evidence refs',()=>{
 const content={headline:'Short.',status:{level:'unclear',reason:'Not enough evidence.'},recentWork:[],unfinished:[],done:[],notDone:[],decisionsNeeded:[],nextSteps:[],limitations:[]};
 assert.deepEqual(validateBriefingContent(content),content);
 assert.throws(()=>validateBriefingContent({...content,recentWork:[{title:'x',outcome:'finished',when:null,where:'local',detail:'d',evidence:['1','2','3','4']}]}));
 assert.throws(()=>validateBriefingContent({...content,headline:'x'.repeat(241)}));
});
test('compact plan keeps open work first, maps milestones and never exceeds its budget',()=>{
 const tasks=[...Array.from({length:45},(_,i)=>taskFixture(`open-${i}`,{title:`Open task ${i} ${'detail '.repeat(12)}`,status:i%3===0?'doing':'todo',milestoneId:i%2?'milestone-1':null,blocker:i===42?'Waiting on a vendor':'',updatedAt:new Date(Date.parse(FIXTURE_AT)+i*1000).toISOString()})),...Array.from({length:15},(_,i)=>taskFixture(`done-${i}`,{title:`Done task ${i}`,status:'done',completedAt:new Date(Date.parse(FIXTURE_AT)-i*3600_000).toISOString()})),taskFixture('archived',{status:'archived'})];
 const workspace=workspaceFixture({projects:[projectFixture({goal:'g'.repeat(500),description:'d'.repeat(400)})],milestones:[milestoneFixture(),milestoneFixture({id:'milestone-2',title:'Later',sortKey:1,status:'achieved',targetDate:'2026-11-01'})],tasks});
 const plan=compactPlan(workspace,'p1',7);
 assert.equal(plan.revision,7);assert.equal(plan.project.goal.length,400);assert.equal(plan.project.description.length,300);
 assert.deepEqual(plan.milestones.map(row=>row.status),['planned','achieved']);
 assert.ok(plan.tasks.length<=40);assert.ok(JSON.stringify(plan).length<=COMPACT_PLAN_MAX_CHARACTERS);
 assert.equal(plan.tasks[0].status,'doing');assert.ok(plan.tasks.every(row=>row.title.length<=120));
 assert.ok(plan.tasks.some(row=>row.milestone===0));assert.ok(plan.tasks.some(row=>row.blocked));
 assert.equal(plan.totals.tasks,60);assert.equal(plan.totals.open,45);assert.equal(plan.totals.done,15);assert.equal(plan.totals.omitted,60-plan.tasks.length);
 assert.deepEqual(validateCompactPlan(plan),plan);
 assert.throws(()=>compactPlan(workspace,'missing',1));
 assert.throws(()=>validateCompactPlan({...plan,tasks:[{...plan.tasks[0],milestone:5}]}));
});
