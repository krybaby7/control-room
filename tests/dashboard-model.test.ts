import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDashboardModel,providerForModel,type DashboardInputs} from '../lib/dashboard/model.ts';
import {dashboardFixture,NOW,okFeeds} from './fixtures/dashboard.ts';
async function inputs(overrides:Partial<DashboardInputs>={}):Promise<DashboardInputs>{
 const fixture=await dashboardFixture();
 return {now:NOW,workspace:fixture.workspace,jobs:fixture.jobs,jobDetails:{'job-running':{provider:'codex',events:fixture.events['job-running']}},runtime:fixture.runtime,connector:fixture.connector,localReports:fixture.localReports,cloudReports:fixture.cloudReports,briefings:fixture.briefings,feeds:okFeeds(),...overrides};
}
test('HUD reflects PC heartbeat, personal app readiness, agent counts and attention',async()=>{
 const model=buildDashboardModel(await inputs());
 assert.equal(model.hud.pc.state,'online');assert.equal(model.hud.pc.deviceLabel,'Workstation');assert.equal(model.hud.pc.metrics?.cpu,31.4);assert.equal(model.hud.pc.metricsAgeSeconds,16);assert.equal(model.hud.pc.tone,'good');
 assert.equal(model.hud.connector.state,'online');assert.deepEqual(model.hud.connector.providers.map(row=>[row.id,row.ready,row.detail]),[['codex',true,'Ready'],['claude',false,'Sign-in needed']]);
 assert.deepEqual({running:model.hud.agents.running,queued:model.hud.agents.queued,awaitingApproval:model.hud.agents.awaitingApproval,reconcile:model.hud.agents.reconcile,personalActive:model.hud.agents.personalActive,tone:model.hud.agents.tone},{running:1,queued:0,awaitingApproval:1,reconcile:1,personalActive:1,tone:'live'});
 assert.equal(model.hud.agents.label,'2 working · 1 awaiting approval · 1 to reconcile');
 assert.equal(model.hud.cloud.execution.diagnostic,'private_ingress_unavailable');assert.equal(model.hud.cloud.execution.enabled,false);assert.equal(model.hud.cloud.reportCount,1);
 // review + approval + reconcile + overdue + briefing decision + inbox; the carried-over pin is listed but not counted.
 assert.equal(model.hud.attention.total,6);assert.equal(model.hud.attention.tone,'bad');
 assert.deepEqual(model.attention.map(item=>item.kind),['reconcile','overdue','review','approval','decision','inbox','carry']);
 assert.equal(model.attention.find(item=>item.kind==='decision')?.title,'Approve the first live trial budget.');
});
test('project tiles show live agent progress, briefing with chats, tokens and next action',async()=>{
 const model=buildDashboardModel(await inputs());
 const [a,b]=model.projects;
 assert.equal(a.agent.state,'running');assert.equal(a.agent.jobs.length,1);
 const job=a.agent.jobs[0];
 assert.equal(job.stage,'executing');assert.equal(job.stageLabel,'Executing with the model');assert.equal(job.percent,38);assert.equal(job.completedUnits,3);assert.equal(job.totalUnits,8);
 assert.equal(job.provider,'codex');assert.equal(job.observedModel,'gpt-6.1-sol');assert.equal(job.deviceLabel,'Workstation');assert.equal(job.elapsedSeconds,300);assert.equal(job.timePercent,100);assert.equal(job.eventCount,4);assert.equal(job.location,'pc');
 assert.equal(a.analysis?.kind,'local');assert.equal(a.analysis?.providerLabel,'Codex');assert.equal(a.analysis?.repositoryName,'TMNI');assert.equal(a.analysis?.dirty,true);assert.equal(a.analysis?.chats?.length,2);
 assert.deepEqual(a.analysis?.chats?.map(chat=>[chat.provider,chat.status,chat.messages]),[['codex','included',4],['claude','not-found',0]]);
 assert.ok(a.analysis!.excerpt.startsWith('The last chats focused'));assert.ok(a.analysis!.excerpt.length<=224);
 // Project A has no briefing yet; the PC knows one folder, so it is offered but not assumed.
 assert.equal(a.briefing.state,'none');assert.equal(a.briefing.report,null);assert.equal(a.briefing.status.label,'No briefing yet');assert.equal(a.briefing.repositoryKey,null);assert.equal(a.briefing.canRequest,true);assert.equal(a.briefing.policy,null);
 assert.deepEqual(a.tokens,{input:12400,output:3100,runs:1,reported:1});assert.equal(a.lastRunAt,'2026-10-21T11:59:00.000Z');
 assert.equal(a.progress.milestonesDone,1);assert.equal(a.progress.milestonesTotal,5);assert.equal(a.progress.tasksDone,1);assert.equal(a.progress.inReview,1);assert.equal(a.progress.inProgress,1);assert.equal(a.progress.overdue,1);assert.equal(a.progress.weeklyPinned,1);assert.equal(a.progress.blocked,1);
 assert.equal(a.level,2);assert.equal(a.milestone?.status,'active');
 assert.equal(a.activity.length,2);assert.equal(a.activity[0].text,'Updated task: Define Android device acceptance');
 assert.ok(a.nextAction);assert.equal(a.nextAction!.task.projectId,a.project.id);
 // Project B: the personal PC analysis counts as an agent working, cloud report is the only briefing.
 assert.equal(b.agent.state,'running');assert.equal(b.agent.personal.length,1);assert.equal(b.agent.personal[0].providerLabel,'Claude Code');assert.ok(b.agent.personal[0].label.startsWith('Analysis of trade-graph'));
 assert.equal(b.analysis?.kind,'cloud');assert.equal(b.analysis?.chats,null);assert.equal(b.analysis?.repositoryName,'krybaby7/trade-graph');
 const brief=b.briefing;assert.equal(brief.state,'ready');assert.equal(brief.source,'saved');assert.equal(brief.version,1);assert.equal(brief.status.label,'On track');assert.equal(brief.status.tone,'good');
 assert.deepEqual(brief.work.map(row=>[row.outcomeLabel,row.whereLabel,row.when]),[['Finished','on your PC','2026-10-21'],['Unfinished','in the cloud','2026-10-20']]);
 assert.equal(brief.freshness.newWork,false);assert.equal(brief.providerLabel,'Claude Code');assert.equal(brief.originLabel,'on your request');
 assert.equal(brief.evidenceLine,'12 local commits on 3 branches and 2 uncommitted files · 9 cloud commits on 4 GitHub branches, 1 open of 3 pull requests · 3 Codex chats and 2 Claude Code chats · 4 milestones and 17 tasks from your plan');
 assert.deepEqual(brief.policy,{repositoryKey:'repo-b',provider:'claude',enabled:true,minIntervalMinutes:120,lastBriefAt:'2026-10-21T11:05:00.000Z'});assert.equal(brief.repositoryName,'trade-graph');assert.equal(brief.canRequest,true);assert.equal(brief.unsaved,null);
 assert.deepEqual(b.tokens,{input:0,output:0,runs:0,reported:0});
});
test('briefing folder defaults require a project association even with one registered folder',async()=>{
 const base=await inputs(),projectA=base.workspace.projects[0].id;
 const unmapped=buildDashboardModel(base).projects[0].briefing;
 assert.equal(unmapped.repositoryKey,null,'another project’s saved briefing and policy must not supply the sole folder');
 assert.equal(unmapped.policy,null);assert.equal(unmapped.canRequest,true);assert.match(unmapped.requestHint!,/Choose which folder/);
 const local={...base.localReports[0],report:{...base.localReports[0].report,repository:{...base.localReports[0].report.repository,key:'repo-b'}}};
 assert.equal(buildDashboardModel({...base,localReports:[local]}).projects[0].briefing.repositoryKey,'repo-b');
 const policy={...base.connector!.policies![0],projectId:projectA};
 assert.equal(buildDashboardModel({...base,localReports:[],connector:{...base.connector!,policies:[policy]}}).projects[0].briefing.repositoryKey,'repo-b');
 assert.equal(buildDashboardModel(base).projects[1].briefing.repositoryKey,'repo-b','the saved project briefing keeps its mapped folder');
 const foreignLocal={...local,projectId:base.workspace.projects[1].id};
 assert.equal(buildDashboardModel({...base,localReports:[foreignLocal]}).projects[0].briefing.repositoryKey,null);
});

test('briefing request availability requires an online ready assistant and no active briefing',async()=>{
 const base=await inputs();
 for(const connector of [{...base.connector!,online:false},{...base.connector!,connected:false},{...base.connector!,providers:{codex:{ready:false,detail:'auth_required' as const},claude:{ready:false,detail:'auth_required' as const}}}]){
  assert.equal(buildDashboardModel({...base,connector}).projects[0].briefing.canRequest,false);
 }
 for(const status of ['queued','claimed'] as const){
  const job={id:'active-brief',kind:'brief',status,createdAt:NOW,projectId:base.workspace.projects[0].id,repositoryKey:'repo-b',provider:'codex' as const};
  assert.equal(buildDashboardModel({...base,connector:{...base.connector!,jobs:[job]}}).projects[0].briefing.canRequest,false);
 }
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
 for(const tile of model.projects){assert.equal(tile.agent.state,'idle');assert.equal(tile.agent.label,'No agent working');assert.equal(tile.analysis,null);assert.equal(tile.lastRunAt,null);}
 assert.equal(model.hud.agents.label,'No agent working');assert.equal(model.hud.agents.tone,'idle');assert.equal(model.operations.recent.length,0);
 assert.equal(model.hud.cloud.execution.label,'Execution not configured');
});
test('missing feeds degrade to unknown or unconfigured states instead of pretending',async()=>{
 const failed={status:'failed' as const,checkedAt:NOW,message:'boom'},loading={status:'loading' as const,checkedAt:null};
 const model=buildDashboardModel(await inputs({runtime:null,connector:null,jobs:null,feeds:{...okFeeds(),runtime:failed,connector:{status:'unconfigured',checkedAt:NOW},jobs:loading}}));
 assert.equal(model.hud.pc.state,'unknown');assert.equal(model.hud.connector.state,'unconfigured');assert.equal(model.hud.connector.providers[0].detail,'Unknown');
 assert.equal(model.projects[1].briefing.state,'ready');assert.equal(model.projects[1].briefing.canRequest,false);assert.match(model.projects[1].briefing.requestHint!,/Connect your PC/);assert.equal(model.projects[1].briefing.freshness.newWork,false);
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
test('a briefing completed on the PC is shown and marked unsaved; new work and active jobs are reflected',async()=>{
 const base=await inputs(),fixture={connector:base.connector!,briefings:base.briefings,projectB:base.briefings[0].projectId};
 const fresh={...fixture.briefings[0].briefing,run:{...fixture.briefings[0].briefing.run,id:'77777777-7777-4777-8777-777777777777',completedAt:'2026-10-21T11:58:00.000Z',origin:'auto' as const},headline:'Fresh from the PC.'};
 const connector={...fixture.connector,repositories:[{...fixture.connector.repositories[0],head:'f'.repeat(40)}],completedBriefing:{requestId:'77777777-7777-4777-8777-777777777777',projectId:fixture.projectB,briefing:fresh,briefingSha256:'a'.repeat(64)}};
 const model=buildDashboardModel({...base,connector});
 const brief=model.projects[1].briefing;
 assert.equal(brief.source,'completed');assert.equal(brief.report?.headline,'Fresh from the PC.');assert.deepEqual(brief.unsaved,{requestId:'77777777-7777-4777-8777-777777777777',briefingSha256:'a'.repeat(64)});assert.equal(brief.originLabel,'kept current automatically');assert.equal(brief.version,null);
 assert.equal(brief.freshness.newWork,true);assert.match(brief.freshness.detail!,/New commits/);
 const queued={...fixture.connector,completedBriefing:null,jobs:[{id:'88888888-8888-4888-8888-888888888888',kind:'brief',status:'queued' as const,createdAt:'2026-10-21T11:59:00.000Z',claimedAt:null,projectId:fixture.projectB,repositoryKey:'repo-b',provider:'codex' as const,requestedModel:'gpt-6.1-sol',origin:'owner' as const}]};
 const waiting=buildDashboardModel({...base,connector:queued}).projects[1].briefing;
 assert.equal(waiting.state,'queued');assert.equal(waiting.activeJob?.providerLabel,'Codex');assert.equal(waiting.canRequest,false);assert.equal(waiting.report?.headline,fixture.briefings[0].briefing.headline,'the saved briefing stays visible while a refresh runs');
 const failed={...queued,jobs:[{...queued.jobs[0],status:'failed' as const,createdAt:'2026-10-21T11:59:00.000Z',error:'provider_unavailable'}]};
 const tile=buildDashboardModel({...base,connector:failed}).projects[1].briefing;
 assert.equal(tile.state,'ready');assert.match(tile.lastFailure!.reason,/not signed in/);
 // A tampered completed briefing is ignored rather than displayed.
 const tampered={...connector,completedBriefing:{...connector.completedBriefing,briefing:{...fresh,headline:''}}};
 assert.equal(buildDashboardModel({...base,connector:tampered}).projects[1].briefing.source,'saved');
});
