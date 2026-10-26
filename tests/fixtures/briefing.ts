import type {ProjectBriefing,ProjectBriefingV1,ProjectBriefingV2,CompactPlan,ProjectFraming} from '../../shared/project-briefing.mjs';
/** Synthetic briefing and plan. Names, dates and text are invented; nothing here is owner data. */
export const BRIEFING_AT='2026-10-21T12:00:00.000Z';
const identity=(runId:string)=>({
 project:{id:'p1',name:'Trade Graph'},
 repository:{key:'repo-b',name:'trade-graph',head:'c'.repeat(40),branch:'main',dirty:false},
 run:{id:runId,provider:'claude' as const,requestedModel:'claude-code-default' as const,observedModel:'claude-opus-5-5',startedAt:'2026-10-21T11:50:00.000Z',completedAt:'2026-10-21T11:55:00.000Z',mode:'read-only' as const,source:'personal-pc-connector' as const,origin:'owner' as const},
});
const evidenceV1=()=>({window:{since:'2026-10-07T11:50:00.000Z',until:'2026-10-21T11:50:00.000Z'},local:{branch:'main',commits:12,branches:3,latestCommitAt:'2026-10-21T09:00:00.000Z',uncommittedFiles:2},cloud:{status:'fetched' as const,remote:'github.com/example/trade-graph',branches:4,commits:9,latestCommitAt:'2026-10-20T22:10:00.000Z',pullRequests:3,openPullRequests:1,fetchedAt:'2026-10-21T11:50:10.000Z'},chats:[{provider:'codex' as const,status:'included' as const,sessions:3,messages:18,latestAt:'2026-10-21T08:30:00.000Z'},{provider:'claude' as const,status:'included' as const,sessions:2,messages:11,latestAt:'2026-10-20T21:00:00.000Z'}],plan:{revision:3,milestones:4,tasks:17},inputSha256:'5'.repeat(64)});
/** A version 3 report: the intention ledger with a map of two areas and one bend. */
export function briefingFixture(patch:Partial<ProjectBriefing>={},runId='44444444-4444-4444-8444-444444444444'):ProjectBriefing{
 return {format:'control-room-project-briefing',version:3,...identity(runId),
  evidence:{...Object.fromEntries(Object.entries(evidenceV1()).filter(([key])=>key!=='plan')) as Omit<ReturnType<typeof evidenceV1>,'plan'>,framing:{workspaceRevision:3,characters:37,includeTaskPlan:false,totalMilestones:4,totalTasks:17,includedMilestones:0,includedTasks:0},ownerTurns:{sessions:4,turns:23,characters:6100,earliestAt:'2026-10-12T09:00:00.000Z',latestAt:'2026-10-21T08:30:00.000Z'},previous:{runId:'00000000-0000-4000-8000-000000000003',until:'2026-10-18T11:50:00.000Z',intentions:3}},
  fitOrDrift:'The cycle fits the project purpose; reconciliation remains open.',
  aim:'Run one full trading cycle on the test account, then reconcile its results before any live trial.',
  status:{level:'on-track',reason:'Core cycle works; one unfinished piece remains before trial.'},
  leftOff:['The aim is a full cycle on the test account with reconciled results. The cycle now runs end to end; reconciling orders against statements is drafted in the cloud and not merged.','Your last exchange settled that the trial budget waits until reconciliation is in.'],
  areas:[{id:'signals',name:'Signals',state:'proven',done:2,total:2,note:'ran on real prices'},{id:'orders',name:'Order placement',state:'built',done:3,total:3,note:'test account only'},{id:'reconcile',name:'Reconciliation',state:'open',done:0,total:2,note:'cloud draft, not merged'}],
  links:[{from:'signals',to:'orders'},{from:'orders',to:'reconcile'}],aimArea:'reconcile',
  intentions:[
   {date:'2026-10-21',title:'Run a full trading cycle end to end',outcome:'A complete cycle from signal to order now completes on the test account.',state:'reached',source:'local-codex',area:'orders',bend:null,evidence:['a1b2c3d','main']},
   {date:'2026-10-20',title:'Reconcile results against account statements',outcome:'Started in the cloud as a draft; not merged yet.',state:'in-progress',source:'cloud',area:'reconcile',bend:null,evidence:['PR #12','claude/reconcile']},
   {date:'2026-10-14',title:'Go straight to a live trial after the first cycle',outcome:'You decided to reconcile results first.',state:'changed',source:'local-claude',area:'reconcile',bend:{from:'Live trial right after the first cycle',to:'Reconcile results before any live trial',why:'An unreconciled cycle cannot show whether the orders matched the statements.'},evidence:['chat 14 Oct']},
  ],
  open:['Reconciliation of results: review the cloud draft, then merge it after one more test run.'],
  needsYou:['Approve the first live trial budget.'],
  tried:['A one-minute signal interval: too many orders for the test account limits.'],
  done:['Signal generation','Order placement on the test account'],notDone:['Reconciliation of results','First live trial'],
  nextSteps:['Review and merge the reconciliation draft.','Schedule the first live trial.'],
  limitations:['Based on your own chat turns, recent commits, branches, pull requests and chats; nothing was executed or tested.'],
  ...patch};
}
/** The version 1 shape, kept to prove that saved reports still read. */
export function briefingFixtureV1(patch:Partial<ProjectBriefingV1>={},runId='44444444-4444-4444-8444-444444444444'):ProjectBriefingV1{
 return {format:'control-room-project-briefing',version:1,...identity(runId),evidence:evidenceV1(),
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

export function briefingFixtureV2(patch:Partial<ProjectBriefingV2>={}):ProjectBriefingV2{
 const current=briefingFixture(),content=Object.fromEntries(Object.entries(current).filter(([key])=>key!=='fitOrDrift')) as Omit<ProjectBriefing,'fitOrDrift'>,evidence=Object.fromEntries(Object.entries(content.evidence).filter(([key])=>key!=='framing')) as Omit<ProjectBriefing['evidence'],'framing'>;
 return {...content,version:2,evidence:{...evidence,plan:{revision:3,milestones:4,tasks:17}},...patch};
}
export function framingFixture(patch:Partial<ProjectFraming>={}):ProjectFraming{
 return {projectId:'p1',projectName:'Trade Graph',framing:'Reconcile results before a live trial.',includeTaskPlan:false,milestones:[],tasks:[],totalMilestones:1,totalTasks:1,workspaceRevision:3,...patch};
}
