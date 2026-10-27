import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadClient} from './helpers/render-client.ts';
import {buildDashboardModel} from '../lib/dashboard/model.ts';
import {dashboardFixture,NOW,okFeeds} from './fixtures/dashboard.ts';
import {personalConnectorViewSchema} from '../lib/dashboard/contracts.ts';
import ts from 'typescript';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
// Compile the actual client leaf, then render its pure presentation with React.
const panels=await loadClient<typeof import('../components/mission-control-panels')>(new URL('../components/mission-control-panels.tsx',import.meta.url));
const noop=()=>{};
const actions={onProject:noop,onTask:noop,onTaskId:noop,onPin:noop,onProjects:noop,onAgents:noop,onRuntime:noop,onRepositories:noop,onInbox:noop,onAttention:noop,onWeekly:noop,busy:false,onBrief:noop,onKeepCurrent:noop,onAddFolder:noop,onRetrySave:noop,briefingNotices:{},briefingWorking:{}};
async function model(){const fixture=await dashboardFixture();fixture.workspace.projects[1].personalRepositoryKeys=['repo-b'];return {fixture,model:buildDashboardModel({now:NOW,workspace:fixture.workspace,jobs:fixture.jobs,jobDetails:{'job-running':{provider:'codex',events:fixture.events['job-running']}},runtime:fixture.runtime,connector:fixture.connector,localReports:fixture.localReports,cloudReports:fixture.cloudReports,briefings:fixture.briefings,feeds:okFeeds()})};}
test('Today shows the outdated PC state and complete fast-failure recovery words',async()=>{
 const fixture=await dashboardFixture();fixture.workspace.projects[1].personalRepositoryKeys=['repo-b'];
 const connector=personalConnectorViewSchema.parse({...fixture.connector,companion:{protocol:null,kinds:['browse','analyze'],legacy:true,lastSeenAt:NOW},jobs:[{id:'outdated-fixture',kind:'brief',status:'failed',createdAt:NOW,claimedAt:null,projectId:fixture.projectB,error:'companion_outdated'}]});
 const value=buildDashboardModel({now:NOW,workspace:fixture.workspace,jobs:fixture.jobs,jobDetails:{},runtime:fixture.runtime,connector,localReports:fixture.localReports,cloudReports:fixture.cloudReports,briefings:fixture.briefings,feeds:okFeeds()});
 const status=renderToStaticMarkup(createElement(panels.HudStrip,{model:value,actions}));
 assert.match(status,/PC app: out of date/u);
 const html=renderToStaticMarkup(createElement(panels.BriefingCard,{tile:value.projects[1],now:NOW,actions}));
 assert.ok(html.includes('Your Control Room PC app is out of date, so it couldn&#x27;t run this briefing. Close the old PC app; if it keeps happening, update the PC app.'));
 assert.doesNotMatch(html,/did not finish: Your Control Room/u);
});
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
 assert.ok(unconfigured.includes('Your PC is offline. Open the Control Room PC app on your PC.'));assert.ok(!unconfigured.includes('Brief this project</button>')||unconfigured.includes('disabled'));
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
 assert.ok(html.includes('Folders on your PC'));
 assert.ok(html.includes('No folders added yet.'));
 assert.ok(html.includes('Add folder'));
 assert.ok(!html.includes('Choose a folder</option>'));
 assert.match(html,/<button[^>]*disabled=""[^>]*>[\s\S]*?Brief this project<\/button>/);
});

test('v3 shows fit or drift immediately below the aim and captured framing provenance',async()=>{
 const {model:value}=await model(),tile=value.projects[1],report=tile.briefing.report!;
 report.version=4;report.fitOrDrift='The latest intentions fit your purpose; no drift was identified.';
 tile.briefing.evidenceLine+=' · Measured against your framing · Task plan excluded';
 const html=renderToStaticMarkup(createElement(panels.BriefingCard,{tile,now:NOW,actions}));
 assert.ok(html.includes(report.fitOrDrift));
 assert.ok(html.indexOf(report.fitOrDrift)>html.indexOf(report.aim));
 assert.ok(html.indexOf(report.fitOrDrift)<html.indexOf(report.leftOff[0]));
 assert.ok(html.includes('Measured against your framing'));assert.ok(html.includes('Task plan excluded'));
 report.evidence.framing=null;
 report.fitOrDrift='This earlier briefing did not assess whether the work fits your project framing. Some inherited text was shortened to fit the display limit.';
 tile.briefing.evidenceLine='Legacy source coverage';tile.briefing.evidenceCoverage=[];
 const legacy=renderToStaticMarkup(createElement(panels.BriefingCard,{tile,now:NOW,actions}));
 assert.ok(legacy.includes(report.fitOrDrift));assert.ok(!legacy.includes('Measured against your framing'));assert.ok(!legacy.includes('Task plan excluded'));
});

test('the briefing card identifies a cloud assistant and states cloud coverage in its basis fold',async()=>{
 const {fixture}=await model();
 const report=fixture.briefings[0].briefing;
 report.intentions[1].cloudProvider='codex-cloud';
 report.evidence.cloudTurns=[{provider:'claude-cloud',status:'not-found',sessions:0,turns:0},{provider:'codex-cloud',status:'included',sessions:1,turns:1}];
 const value=buildDashboardModel({now:NOW,workspace:fixture.workspace,jobs:fixture.jobs,jobDetails:{},runtime:fixture.runtime,connector:fixture.connector,localReports:fixture.localReports,cloudReports:fixture.cloudReports,briefings:fixture.briefings,feeds:okFeeds()});
 const html=renderToStaticMarkup(createElement(panels.BriefingCard,{tile:value.projects[1],now:NOW,actions}));
 assert.ok(html.includes('Said in a Codex cloud chat'));
 assert.ok(html.includes('no Claude Code cloud sessions were available'));
 assert.ok(html.indexOf('1 owner turn across 1 Codex cloud session')>html.indexOf('How this briefing was put together'));
});


test('multi-folder briefing renders folder map tags, coverage and the changed folder',async()=>{
 const {model:value}=await model(),tile=value.projects[1];
 tile.briefing.repositories=[{key:'app',name:'The app'},{key:'map',name:'Map lab'}];
 tile.briefing.ledger.areas[0].repositoryName='Map lab';
 tile.briefing.report!.repositories.push({...tile.briefing.report!.repository,key:'map',name:'Map lab'});
 tile.briefing.ledger.intentions[0].evidence=[{repositoryKey:'map',ref:'PR #12'}];
 tile.briefing.evidenceCoverage=[{key:'app',name:'The app',line:'2 local commits on 1 branch'},{key:'map',name:'Map lab',line:'3 local commits on 2 branches'}];
 tile.briefing.freshness={...tile.briefing.freshness,newWork:true,detail:'New commits in Map lab since this briefing.'};
 const html=renderToStaticMarkup(createElement(panels.BriefingCard,{tile,now:NOW,actions}));
 for(const text of ['Folder: Map lab','Coverage by folder','2 local commits on 1 branch','3 local commits on 2 branches','New commits in Map lab','Add folder','Map lab: PR #12'])assert.ok(html.includes(text),text);
});

test('disabled briefing controls explain the current reason through a visible description',async()=>{
 const {model:value}=await model(),tile=value.projects[1];
 tile.briefing.connector='away';tile.briefing.canRequest=false;
 const html=renderToStaticMarkup(createElement(panels.BriefingCard,{tile,now:NOW,actions}));
 assert.match(html,/<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"[^>]*>[\s\S]*?Refresh briefing/);
 assert.ok(html.includes('Your PC is offline. Open the Control Room PC app on your PC.'));
});
test('Today folder navigation stays available while its four folders can be reviewed',async()=>{
 const {model:value}=await model(),tile=value.projects[1];
 tile.briefing.repositories=['a','b','c','d'].map(key=>({key,name:key}));
 const html=renderToStaticMarkup(createElement(panels.BriefingCard,{tile,now:NOW,actions:{...actions,busy:true}}));
 const add=html.match(/<button[^>]*>Add folder<\/button>/)?.[0];assert.ok(add);assert.ok(!add.includes('disabled'));
 assert.ok(html.includes('A project can have up to four folders.'));
});
test('Today renders briefing controls immediately without injected helpers',async()=>{
 const {model:value}=await model(),tile=value.projects[1];
 const html=renderToStaticMarkup(createElement(panels.BriefingCard,{tile,now:NOW,actions}));
 for(const text of ['Folders on your PC','Add folder','Assistant','Refresh briefing','Keep current'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('Loading folder actions'));
});
test('new folder helpers stay outside the emitted static shell closure while Today stays deferred',()=>{
 const root=new URL('../',import.meta.url),seen=new Set<string>();
 function visit(file:URL){
  if(seen.has(file.href))return;
  seen.add(file.href);
  const source=readFileSync(file,'utf8');
  const emitted=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const ast=ts.createSourceFile(`${file.href}.js`,emitted,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  for(const statement of ast.statements){
   if(!ts.isImportDeclaration(statement)&&!ts.isExportDeclaration(statement))continue;
   const specifier=statement.moduleSpecifier;
   if(!specifier||!ts.isStringLiteral(specifier))continue;
   assert.doesNotMatch(specifier.text,/project-(?:action-reasons|assistant-preference|folder-picker)/,`${fileURLToPath(file)} must not statically import a new folder helper`);
   if(!specifier.text.startsWith('.')&&!specifier.text.startsWith('@/'))continue;
   const target=specifier.text.startsWith('@/')?new URL(specifier.text.slice(2),root):new URL(specifier.text,file);
   const resolved=['','.ts','.tsx','.mts','.mjs','.js','/index.ts','/index.tsx'].map(extension=>new URL(target.href+extension)).find(candidate=>existsSync(candidate)&&/\.(?:tsx?|mts|m?js)$/.test(candidate.pathname));
   assert.ok(resolved,`resolve static import ${specifier.text} from ${fileURLToPath(file)}`);
   visit(resolved);
  }
 }
 visit(new URL('../components/control-center.tsx',import.meta.url));
 for(const file of ['mission-control','mission-control-panels','briefing-card'])assert.ok(!seen.has(new URL(`../components/${file}.tsx`,import.meta.url).href),`${file} must stay deferred`);
});
