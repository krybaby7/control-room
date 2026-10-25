import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {buildDashboardModel} from '../lib/dashboard/model.ts';
import {dashboardFixture,NOW,okFeeds} from './fixtures/dashboard.ts';
// Compile the actual client leaf, then render its pure presentation with React.
const directory=await mkdtemp(join(process.cwd(),'.mission-control-render-'));
let panels:typeof import('../components/mission-control-panels');
try{await build({entryPoints:['components/mission-control-panels.tsx'],outfile:join(directory,'panels.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',jsx:'automatic',logLevel:'silent'});panels=createRequire(import.meta.url)(join(directory,'panels.cjs'));}
finally{await rm(directory,{recursive:true,force:true});}
const noop=()=>{};
const actions={onProject:noop,onTask:noop,onTaskId:noop,onPin:noop,onProjects:noop,onAgents:noop,onRuntime:noop,onRepositories:noop,onInbox:noop,onAttention:noop,onWeekly:noop,busy:false,onBrief:noop,onKeepCurrent:noop,onRetrySave:noop,briefingNotices:{},briefingWorking:{}};
async function model(){const fixture=await dashboardFixture();return {fixture,model:buildDashboardModel({now:NOW,workspace:fixture.workspace,jobs:fixture.jobs,jobDetails:{'job-running':{provider:'codex',events:fixture.events['job-running']}},runtime:fixture.runtime,connector:fixture.connector,localReports:fixture.localReports,cloudReports:fixture.cloudReports,briefings:fixture.briefings,feeds:okFeeds()})};}
test('HUD renders device, app readiness, agent and attention lights with plain-language detail',async()=>{
 const {model:value}=await model();
 const html=renderToStaticMarkup(createElement(panels.HudStrip,{model:value,actions}));
 for(const text of ['PC online','Workstation','CPU','31%','Personal PC app online','Codex: Ready','Claude Code: Sign-in needed','2 working · 1 awaiting approval · 1 to reconcile','Private access window closed','6 items need you','checked 15:00 Cairo'])assert.ok(html.includes(text),`missing ${text}`);
 assert.ok(html.includes('mc-light tone-live'));
});
test('project tiles show live progress, chat coverage, usage totals and the next action',async()=>{
 const {model:value,fixture}=await model();
 const html=renderToStaticMarkup(createElement(panels.ProjectTile,{tile:value.projects[0],now:NOW,actions,workspace:fixture.workspace}));
 for(const text of ['TAMENNI','LVL 2','Agent working now','Executing with the model',' 3/8','5m 0s','Codex','gpt-6.1-sol','on Workstation','No briefing yet','Brief this project','Technical analysis for your engineers','TMNI @ ddddddd','uncommitted changes','4 messages','last 3 h ago','No matching chat','12.4k in · 3.1k out · 1 run','Next action','Recent activity','Updated task: Define Android device acceptance','1 in review','1 overdue','1 this week'])assert.ok(html.includes(text),`missing ${text}`);
 assert.ok(!html.includes('b'.repeat(40)),'commit hashes are shortened');assert.ok(!html.includes(value.projects[0].agent.jobs[0].id),'raw job identifiers are not shown on the tile');
 const idle=renderToStaticMarkup(createElement(panels.ProjectTile,{tile:value.projects[1],now:NOW,actions,workspace:fixture.workspace}));
 for(const text of ['Trade Graph','Analysis of trade-graph · Running on this PC','Claude Code','Codex Cloud handoff','No agent run recorded','Where we&#x27;re at','On track','as of 50 min ago','Run one full trading cycle on the test account','The aim right now','Where the project stands','CURRENT AIM','Reconciliation','Your intentions, newest first','Reached.','In progress.','new since 18 Oct','a Codex chat on your PC','The plan changed here','How the plan changed along the way','Needs you','Approve the first live trial budget.','Still open','Next steps','What was tried and did not work','Refresh briefing','Keep current · Claude Code, at most every 2 h','How this briefing was put together','12 local commits'])assert.ok(idle.includes(text),`missing ${text}`);
 assert.ok(idle.indexOf('a1b2c3d')>idle.indexOf('How this briefing was put together'),'evidence references stay behind the details fold');assert.ok(idle.includes('PR #12'),'evidence references are kept for the owner to check');
});
test('operations, attention and log panels render honest empty and populated states',async()=>{
 const {model:value,fixture}=await model();
 const ops=renderToStaticMarkup(createElement(panels.OperationsPanel,{model:value,actions}));
 for(const text of ['Live operations','Inspect project','Running','tokens are reported when the run completes','Recent runs','Succeeded','12.4k in · 3.1k out','3m 1s','1 artifact · accepted','Analysis of trade-graph'])assert.ok(ops.includes(text),`missing ${text}`);
 const attention=renderToStaticMarkup(createElement(panels.AttentionPanel,{model:value,actions}));
 for(const text of ['Needs you','Execution outcome is uncertain','Overdue since 2026-10-01','Waiting for your review decision','Agent job proposal waiting for approval','Approve the first live trial budget.','Raised by the project briefing','1 capture in the inbox'])assert.ok(attention.includes(text),`missing ${text}`);
 const log=renderToStaticMarkup(createElement(panels.MissionLog,{log:value.log,now:NOW,actions}));
 assert.ok(log.includes('15 min ago'));assert.ok(log.includes('Created task: Inspect a complete trading cycle'));
 const empty=buildDashboardModel({now:NOW,workspace:fixture.workspace,jobs:null,jobDetails:{},runtime:null,connector:null,localReports:[],cloudReports:[],briefings:[],feeds:{jobs:{status:'failed',checkedAt:NOW,message:'x'},runtime:{status:'loading',checkedAt:null},connector:{status:'unconfigured',checkedAt:NOW},local:{status:'ok',checkedAt:NOW},cloud:{status:'ok',checkedAt:NOW},briefings:{status:'ok',checkedAt:NOW}}});
 const unconfigured=renderToStaticMarkup(createElement(panels.ProjectTile,{tile:empty.projects[0],now:NOW,actions,workspace:fixture.workspace}));
 assert.ok(unconfigured.includes('Connect your PC under Repositories'));assert.ok(!unconfigured.includes('Brief this project</button>')||unconfigured.includes('disabled'));
 const emptyOps=renderToStaticMarkup(createElement(panels.OperationsPanel,{model:empty,actions}));
 assert.ok(emptyOps.includes('No agent is working right now'));
 const warning=renderToStaticMarkup(createElement(panels.FeedWarning,{model:empty}));
 assert.ok(warning.includes('could not be read (jobs)'));
 const week=renderToStaticMarkup(createElement(panels.WeekPanel,{workspace:fixture.workspace,now:NOW,actions}));
 assert.ok(week.includes('This week'));assert.ok(week.includes('1 completed this week'));
});

test('an unmapped project offers the registered folder without selecting it or enabling a briefing',async()=>{
 const {model:value}=await model();
 const tile=value.projects[0];
 assert.equal(tile.briefing.repositoryKey,null);
 const html=renderToStaticMarkup(createElement(panels.BriefingCard,{tile,now:NOW,actions}));
 assert.ok(html.includes('Folder on your PC'));
 assert.ok(html.includes('<option value="" selected="">Choose a folder</option>'));
 assert.ok(html.includes('<option value="repo-b">trade-graph</option>'));
 assert.match(html,/<button[^>]*disabled=""[^>]*>[\s\S]*?Brief this project<\/button>/);
});
