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
const actions={onProject:noop,onTask:noop,onTaskId:noop,onPin:noop,onProjects:noop,onAgents:noop,onRuntime:noop,onRepositories:noop,onInbox:noop,onAttention:noop,onWeekly:noop,busy:false};
async function model(){const fixture=await dashboardFixture();return {fixture,model:buildDashboardModel({now:NOW,workspace:fixture.workspace,jobs:fixture.jobs,jobDetails:{'job-running':{provider:'codex',events:fixture.events['job-running']}},runtime:fixture.runtime,connector:fixture.connector,localReports:fixture.localReports,cloudReports:fixture.cloudReports,feeds:okFeeds()})};}
test('HUD renders device, app readiness, agent and attention lights with plain-language detail',async()=>{
 const {model:value}=await model();
 const html=renderToStaticMarkup(createElement(panels.HudStrip,{model:value,actions}));
 for(const text of ['PC online','Workstation','CPU','31%','Personal PC app online','Codex: Ready','Claude Code: Sign-in needed','2 working · 1 awaiting approval · 1 to reconcile','Private access window closed','5 items need you','checked 15:00 Cairo'])assert.ok(html.includes(text),`missing ${text}`);
 assert.ok(html.includes('mc-light tone-live'));
});
test('project tiles show live progress, chat coverage, usage totals and the next action',async()=>{
 const {model:value}=await model();
 const html=renderToStaticMarkup(createElement(panels.ProjectTile,{tile:value.projects[0],now:NOW,actions}));
 for(const text of ['TAMENNI','LVL 2','Agent working now','Executing with the model',' 3/8','5m 0s','Codex','gpt-6.1-sol','on Workstation','Where we&#x27;re at','TMNI @ ddddddd','uncommitted changes','4 messages','last 3 h ago','No matching chat','12.4k in · 3.1k out · 1 run','Next action','Recent activity','Updated task: Define Android device acceptance','1 in review','1 overdue','1 this week'])assert.ok(html.includes(text),`missing ${text}`);
 assert.ok(!html.includes('b'.repeat(40)),'commit hashes are shortened');assert.ok(!html.includes(value.projects[0].agent.jobs[0].id),'raw job identifiers are not shown on the tile');
 const idle=renderToStaticMarkup(createElement(panels.ProjectTile,{tile:value.projects[1],now:NOW,actions}));
 for(const text of ['Trade Graph','Analysis of trade-graph · Running on this PC','Claude Code','Codex Cloud handoff','No agent run recorded'])assert.ok(idle.includes(text),`missing ${text}`);
});
test('operations, attention and log panels render honest empty and populated states',async()=>{
 const {model:value,fixture}=await model();
 const ops=renderToStaticMarkup(createElement(panels.OperationsPanel,{model:value,actions}));
 for(const text of ['Live operations','Inspect project','Running','tokens are reported when the run completes','Recent runs','Succeeded','12.4k in · 3.1k out','3m 1s','1 artifact · accepted','Analysis of trade-graph'])assert.ok(ops.includes(text),`missing ${text}`);
 const attention=renderToStaticMarkup(createElement(panels.AttentionPanel,{model:value,actions}));
 for(const text of ['Needs you','Execution outcome is uncertain','Overdue since 2026-10-01','Waiting for your review decision','Agent job proposal waiting for approval','1 capture in the inbox'])assert.ok(attention.includes(text),`missing ${text}`);
 const log=renderToStaticMarkup(createElement(panels.MissionLog,{log:value.log,now:NOW,actions}));
 assert.ok(log.includes('15 min ago'));assert.ok(log.includes('Created task: Inspect a complete trading cycle'));
 const empty=buildDashboardModel({now:NOW,workspace:fixture.workspace,jobs:null,jobDetails:{},runtime:null,connector:null,localReports:[],cloudReports:[],feeds:{jobs:{status:'failed',checkedAt:NOW,message:'x'},runtime:{status:'loading',checkedAt:null},connector:{status:'unconfigured',checkedAt:NOW},local:{status:'ok',checkedAt:NOW},cloud:{status:'ok',checkedAt:NOW}}});
 const emptyOps=renderToStaticMarkup(createElement(panels.OperationsPanel,{model:empty,actions}));
 assert.ok(emptyOps.includes('No agent is working right now'));
 const warning=renderToStaticMarkup(createElement(panels.FeedWarning,{model:empty}));
 assert.ok(warning.includes('could not be read (jobs)'));
 const week=renderToStaticMarkup(createElement(panels.WeekPanel,{workspace:fixture.workspace,now:NOW,actions}));
 assert.ok(week.includes('This week'));assert.ok(week.includes('1 completed this week'));
});
