import type {ProjectBriefing,CompactPlan} from '../../shared/project-briefing.mjs';
/** Synthetic briefing and plan. Names, dates and text are invented; nothing here is owner data. */
export const BRIEFING_AT='2026-10-21T12:00:00.000Z';
export function briefingFixture(patch:Partial<ProjectBriefing>={},runId='44444444-4444-4444-8444-444444444444'):ProjectBriefing{
 return {format:'control-room-project-briefing',version:1,
  project:{id:'p1',name:'Trade Graph'},
  repository:{key:'repo-b',name:'trade-graph',head:'c'.repeat(40),branch:'main',dirty:false},
  run:{id:runId,provider:'claude',requestedModel:'claude-code-default',observedModel:'claude-opus-5-5',startedAt:'2026-10-21T11:50:00.000Z',completedAt:'2026-10-21T11:55:00.000Z',mode:'read-only',source:'personal-pc-connector',origin:'owner'},
  evidence:{window:{since:'2026-10-07T11:50:00.000Z',until:'2026-10-21T11:50:00.000Z'},local:{branch:'main',commits:12,branches:3,latestCommitAt:'2026-10-21T09:00:00.000Z',uncommittedFiles:2},cloud:{status:'fetched',remote:'github.com/example/trade-graph',branches:4,commits:9,latestCommitAt:'2026-10-20T22:10:00.000Z',pullRequests:3,openPullRequests:1,fetchedAt:'2026-10-21T11:50:10.000Z'},chats:[{provider:'codex',status:'included',sessions:3,messages:18,latestAt:'2026-10-21T08:30:00.000Z'},{provider:'claude',status:'included',sessions:2,messages:11,latestAt:'2026-10-20T21:00:00.000Z'}],plan:{revision:3,milestones:4,tasks:17},inputSha256:'5'.repeat(64)},
  headline:'The trading graph can now run a full cycle end to end; reconciliation of results is the last piece before the first live trial.',
  status:{level:'on-track',reason:'Core cycle works; one unfinished piece remains before trial.'},
  recentWork:[{title:'Full trading cycle runs end to end',outcome:'finished',when:'2026-10-21',where:'local',detail:'A complete cycle from signal to order now completes on the test account.',evidence:['a1b2c3d','main']},{title:'Reconciliation of results',outcome:'unfinished',when:'2026-10-20',where:'cloud',detail:'Matching orders against account statements was started in the cloud and is not merged yet.',evidence:['PR #12','claude/reconcile']}],
  unfinished:[{title:'Reconciliation of results',remaining:'Review the cloud draft, then merge it after one more test run.',where:'cloud'}],
  done:['Signal generation','Order placement on the test account'],notDone:['Reconciliation of results','First live trial'],
  decisionsNeeded:['Approve the first live trial budget.'],nextSteps:['Review and merge the reconciliation draft.','Schedule the first live trial.'],
  limitations:['Based on recent commits, branches, pull requests and chats; nothing was executed or tested.'],
  ...patch};
}
export function planFixture(patch:Partial<CompactPlan>={}):CompactPlan{
 return {revision:3,project:{id:'p1',name:'Trade Graph',goal:'Run a first live trial safely.',description:''},milestones:[{title:'Full cycle on the test account',status:'active',targetDate:null}],tasks:[{title:'Reconcile results',status:'doing',horizon:'now',dueDate:null,milestone:0,blocked:false,completedAt:null}],totals:{tasks:1,open:1,done:0,omitted:0},...patch};
}
