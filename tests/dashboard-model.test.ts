import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDashboardModel,providerForModel,type DashboardInputs} from '../lib/dashboard/model.ts';
import {dashboardFixture,NOW,okFeeds} from './fixtures/dashboard.ts';
async function inputs(overrides:Partial<DashboardInputs>={}):Promise<DashboardInputs>{
 const fixture=await dashboardFixture();
 return {now:NOW,workspace:fixture.workspace,jobs:fixture.jobs,jobDetails:{'job-running':{provider:'codex',events:fixture.events['job-running']}},runtime:fixture.runtime,connector:fixture.connector,localReports:fixture.localReports,cloudReports:fixture.cloudReports,feeds:okFeeds(),...overrides};
}
test('HUD reflects PC heartbeat, personal app readiness, agent counts and attention',async()=>{
 const model=buildDashboardModel(await inputs());
 assert.equal(model.hud.pc.state,'online');assert.equal(model.hud.pc.deviceLabel,'Workstation');assert.equal(model.hud.pc.metrics?.cpu,31.4);assert.equal(model.hud.pc.metricsAgeSeconds,16);assert.equal(model.hud.pc.tone,'good');
 assert.equal(model.hud.connector.state,'online');assert.deepEqual(model.hud.connector.providers.map(row=>[row.id,row.ready,row.detail]),[['codex',true,'Ready'],['claude',false,'Sign-in needed']]);
 assert.deepEqual({running:model.hud.agents.running,queued:model.hud.agents.queued,awaitingApproval:model.hud.agents.awaitingApproval,reconcile:model.hud.agents.reconcile,personalActive:model.hud.agents.personalActive,tone:model.hud.agents.tone},{running:1,queued:0,awaitingApproval:1,reconcile:1,personalActive:1,tone:'live'});
 assert.equal(model.hud.agents.label,'2 working · 1 awaiting approval · 1 to reconcile');
 assert.equal(model.hud.cloud.execution.diagnostic,'private_ingress_unavailable');assert.equal(model.hud.cloud.execution.enabled,false);assert.equal(model.hud.cloud.reportCount,1);
 // review + approval + reconcile + overdue + inbox; the carried-over pin is listed but not counted.
 assert.equal(model.hud.attention.total,5);assert.equal(model.hud.attention.tone,'bad');
 assert.deepEqual(model.attention.map(item=>item.kind),['reconcile','overdue','review','approval','inbox','carry']);
});
test('project tiles show live agent progress, briefing with chats, tokens and next action',async()=>{
 const model=buildDashboardModel(await inputs());
 const [a,b]=model.projects;
 assert.equal(a.agent.state,'running');assert.equal(a.agent.jobs.length,1);
 const job=a.agent.jobs[0];
 assert.equal(job.stage,'executing');assert.equal(job.stageLabel,'Executing with the model');assert.equal(job.percent,38);assert.equal(job.completedUnits,3);assert.equal(job.totalUnits,8);
 assert.equal(job.provider,'codex');assert.equal(job.observedModel,'gpt-6.1-sol');assert.equal(job.deviceLabel,'Workstation');assert.equal(job.elapsedSeconds,300);assert.equal(job.timePercent,100);assert.equal(job.eventCount,4);assert.equal(job.location,'pc');
 assert.equal(a.briefing?.kind,'local');assert.equal(a.briefing?.providerLabel,'Codex');assert.equal(a.briefing?.repositoryName,'TMNI');assert.equal(a.briefing?.dirty,true);assert.equal(a.briefing?.chats?.length,2);
 assert.deepEqual(a.briefing?.chats?.map(chat=>[chat.provider,chat.status,chat.messages]),[['codex','included',4],['claude','not-found',0]]);
 assert.ok(a.briefing!.excerpt.startsWith('The last chats focused'));assert.ok(a.briefing!.excerpt.length<=224);
 assert.deepEqual(a.tokens,{input:12400,output:3100,runs:1,reported:1});assert.equal(a.lastRunAt,'2026-10-21T11:59:00.000Z');
 assert.equal(a.progress.milestonesDone,1);assert.equal(a.progress.milestonesTotal,5);assert.equal(a.progress.tasksDone,1);assert.equal(a.progress.inReview,1);assert.equal(a.progress.inProgress,1);assert.equal(a.progress.overdue,1);assert.equal(a.progress.weeklyPinned,1);assert.equal(a.progress.blocked,1);
 assert.equal(a.level,2);assert.equal(a.milestone?.status,'active');
 assert.equal(a.activity.length,2);assert.equal(a.activity[0].text,'Updated task: Define Android device acceptance');
 assert.ok(a.nextAction);assert.equal(a.nextAction!.task.projectId,a.project.id);
 // Project B: the personal PC analysis counts as an agent working, cloud report is the only briefing.
 assert.equal(b.agent.state,'running');assert.equal(b.agent.personal.length,1);assert.equal(b.agent.personal[0].providerLabel,'Claude Code');assert.ok(b.agent.personal[0].label.startsWith('Analysis of trade-graph'));
 assert.equal(b.briefing?.kind,'cloud');assert.equal(b.briefing?.chats,null);assert.equal(b.briefing?.repositoryName,'krybaby7/trade-graph');
 assert.deepEqual(b.tokens,{input:0,output:0,runs:0,reported:0});
});
test('operations list active work first and summarise recent runs with recorded usage',async()=>{
 const model=buildDashboardModel(await inputs());
 assert.deepEqual(model.operations.active.map(job=>job.id),['job-running']);
 assert.deepEqual(model.operations.recent.map(job=>[job.id,job.tokens,job.runtimeSeconds,job.accepted,job.modelVerified]),[['job-done',{input:12400,output:3100},181.5,true,true]]);
 assert.equal(model.operations.personal.filter(job=>job.active).length,1);
 assert.deepEqual(model.log.map(entry=>entry.id).slice(0,3),['act-a1','act-a2','act-b1']);
 assert.equal(model.log[0].projectName,'TAMENNI');
});
test('idle project without reports or runs stays honest',async()=>{
 const base=await inputs({jobs:{revision:3,generatedAt:NOW,budgets:[],jobs:[],evaluations:[],nextJobAfter:null,nextEvaluationAfter:null,execution:{enabled:false,diagnostic:'not_configured'}},jobDetails:{},connector:{...(await dashboardFixture()).connector,jobs:[]},localReports:[],cloudReports:[]});
 const model=buildDashboardModel(base);
 for(const tile of model.projects){assert.equal(tile.agent.state,'idle');assert.equal(tile.agent.label,'No agent working');assert.equal(tile.briefing,null);assert.equal(tile.lastRunAt,null);}
 assert.equal(model.hud.agents.label,'No agent working');assert.equal(model.hud.agents.tone,'idle');assert.equal(model.operations.recent.length,0);
 assert.equal(model.hud.cloud.execution.label,'Execution not configured');
});
test('missing feeds degrade to unknown or unconfigured states instead of pretending',async()=>{
 const failed={status:'failed' as const,checkedAt:NOW,message:'boom'},loading={status:'loading' as const,checkedAt:null};
 const model=buildDashboardModel(await inputs({runtime:null,connector:null,jobs:null,feeds:{...okFeeds(),runtime:failed,connector:{status:'unconfigured',checkedAt:NOW},jobs:loading}}));
 assert.equal(model.hud.pc.state,'unknown');assert.equal(model.hud.connector.state,'unconfigured');assert.equal(model.hud.connector.providers[0].detail,'Unknown');
 assert.equal(model.hud.cloud.execution.label,'Reading execution state…');assert.equal(model.operations.active.length,0);
 const noDevices=buildDashboardModel(await inputs({runtime:{devices:[]}}));
 assert.equal(noDevices.hud.pc.state,'not-enrolled');
 const stale=await inputs();stale.runtime={devices:[{...stale.runtime!.devices[0],connectivity:'stale',lastLiveReceivedAt:'2026-10-21T11:57:00.000Z'}]};
 assert.equal(buildDashboardModel(stale).hud.pc.state,'stale');assert.equal(buildDashboardModel(stale).hud.pc.heartbeatAgeSeconds,180);
 const away=await inputs();away.connector={...away.connector!,online:false,lastSeenAt:'2026-10-21T11:50:00.000Z'};
 assert.equal(buildDashboardModel(away).hud.connector.state,'away');assert.match(buildDashboardModel(away).hud.connector.detail,/10 min ago/);
});
test('model derivation is deterministic for the same inputs and clock',async()=>{
 const value=await inputs();
 assert.deepEqual(JSON.parse(JSON.stringify(buildDashboardModel(value))),JSON.parse(JSON.stringify(buildDashboardModel(value))));
 assert.equal(providerForModel('claude-code-default'),'claude');assert.equal(providerForModel('gpt-6.1-sol'),'codex');
});
