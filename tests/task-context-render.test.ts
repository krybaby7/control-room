import {searchPlanning} from '../lib/planning-search.ts';
import {parseImportedGithubReport} from '../shared/github-analysis.mjs';
import {PROJECT_BASELINES} from '../lib/project-baselines.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {workspaceFixture,projectFixture,taskFixture,milestoneFixture} from './helpers/workspace.ts';
const directory=await mkdtemp(join(process.cwd(),'.task-context-render-'));
let search:typeof import('../components/search-view'),github:typeof import('../components/github-repository-onboarding'),graph:typeof import('../components/task-graph-view'),ui:typeof import('../components/ui'),bulk:typeof import('../components/task-bulk-actions'),weekly:typeof import('../components/weekly-planning-view'),milestone:typeof import('../components/milestone-workspace'),editor:typeof import('../components/task-editor'),capture:typeof import('../components/capture-editors'),next:typeof import('../components/next-up-panel'),recurrence:typeof import('../components/recurrence-removal'),baseline:typeof import('../components/project-baseline'),roadmap:typeof import('../components/history-roadmap-editor');
try{
 const names=['search-view','github-repository-onboarding','task-graph-view','ui','task-bulk-actions','weekly-planning-view','milestone-workspace','task-editor','capture-editors','next-up-panel','recurrence-removal','project-baseline','history-roadmap-editor'];
 for(const name of names)await build({entryPoints:[`components/${name}.tsx`],outfile:join(directory,`${name}.cjs`),bundle:true,platform:'node',format:'cjs',packages:'external',jsx:'automatic',logLevel:'silent'});
 const require=createRequire(import.meta.url);[search,github,graph,ui,bulk,weekly,milestone,editor,capture,next,recurrence,baseline,roadmap]=names.map(name=>require(join(directory,`${name}.cjs`)));
}finally{await rm(directory,{recursive:true,force:true});}
const noop=()=>{},save=async()=>assert.fail('render cannot mutate'),now='2026-10-22T12:00:00.000Z';
const android=taskFixture('android',{title:'Inspect one result',areaId:'android',workType:'testing',milestoneId:'milestone-1'}),planning=taskFixture('planning',{title:'Inspect another result',areaId:'planning',workType:'planning',milestoneId:'milestone-1'}),map=taskFixture('map',{title:'Inspect mapped result',areaId:'map',workType:'review',milestoneId:'milestone-1'}),legacy=taskFixture('legacy',{title:'Legacy record',milestoneId:'milestone-1'});
const workspace=workspaceFixture({schemaVersion:5,projects:[projectFixture({name:'TAMENNI',repositories:[{name:'Synthetic selected repository',url:`https://github.com/${PROJECT_BASELINES[0].repositories[0]}`}]})],areas:[{id:'android',projectId:'p1',name:'Android testing',aliases:[],order:0,archivedAt:null},{id:'planning',projectId:'p1',name:'Planning',aliases:[],order:1,archivedAt:null},{id:'map',projectId:'p1',name:'Map',aliases:[],order:2,archivedAt:null}],milestones:[milestoneFixture()],tasks:[android,planning,map,legacy]});
function context(html:string,label:string){assert.ok(html.includes(`aria-label="${label}"`),`missing shared accessible context ${label}`);assert.ok(html.includes(label),`missing visible context ${label}`);}
function classified(html:string){for(const label of ['TAMENNI / Android testing / Testing','TAMENNI / Planning / Planning','TAMENNI / Map / Review','TAMENNI / Unclassified / Other'])context(html,label);}
test('actual shared context keeps explicit classifications and legacy unknowns without title inference',()=>{
 classified(workspace.tasks.map(task=>renderToStaticMarkup(createElement(ui.TaskContext,{task,workspace}))).join(''));
 const foreign={...android,projectId:'other'};const html=renderToStaticMarkup(createElement(ui.TaskContext,{task:foreign,workspace}));context(html,'Unknown project / Unclassified / Testing');assert.ok(!html.includes('Android testing'));
});
test('bulk selection, weekly selection and milestone linked/prerequisite titles render full shared context',()=>{
 classified(renderToStaticMarkup(createElement(bulk.TaskBulkActions,{workspace,revision:1,onCommand:save,onTask:noop})));
 classified(renderToStaticMarkup(createElement(weekly.WeeklyPlanningView,{workspace,revision:1,initialWeek:'2026-10-19',onCommand:save,onTask:noop})));
 classified(renderToStaticMarkup(createElement(milestone.MilestoneWorkspace,{workspace,revision:1,milestone:workspace.milestones[0],onTask:noop,onEdit:noop,onNewTask:noop,onCommand:save,onBack:noop})));
});
test('task details, prerequisite picker, roadmap picker and capture conversion show actual draft context',()=>{
 const html=renderToStaticMarkup(createElement(editor.TaskEditor,{workspace,revision:1,task:android,projectId:'p1',onSave:save,onClose:noop}));classified(html);
 const scope={id:'scope',projectId:'p1',areaId:'android',revision:1,agreedAt:null,checkpoints:[{id:'check',label:'Check',acceptance:'Explicit criteria',mandatory:true,milestoneId:null,taskIds:[]}]};
 context(renderToStaticMarkup(createElement(roadmap.HistoryRoadmapEditor,{workspace,projectId:'p1',areaId:'android',areaName:'Android testing',scope,tasks:workspace.tasks,onSave:save,onClose:noop})),'TAMENNI / Android testing / Testing');
 const converted=renderToStaticMarkup(createElement(capture.ConvertEditor,{workspace,capture:{id:'capture',title:'Android testing is only prose',body:'Map Review are prose too',projectId:'p1',kind:'idea',status:'inbox',sourceUrl:null,createdAt:now,convertedTaskId:null},onSave:save,onClose:noop}));context(converted,'TAMENNI / Unclassified / Other');assert.ok(!converted.includes('aria-label="TAMENNI / Android testing / Testing"'));
});
test('next-up absence diagnostics, archived occurrence review and baseline proposals retain context',()=>{
 const done={...android,status:'done' as const,completedAt:now},doneWorkspace={...workspace,tasks:[done]};context(renderToStaticMarkup(createElement(next.NextUpPanel,{workspace:doneWorkspace,onProject:noop,onTask:noop,onPin:noop,onProjects:noop,busy:false})),'TAMENNI / Android testing / Testing');
 const archived={...android,status:'archived' as const};context(renderToStaticMarkup(createElement(recurrence.RecurrenceRemoval,{workspace,task:archived,revision:1,occurrence:{id:'occurrence',rowRevision:1,value:{ruleId:'rule',occurrenceDate:'2026-10-22',taskId:archived.id,disposition:'created'}},onCommand:save})),'TAMENNI / Android testing / Testing');
 const html=renderToStaticMarkup(createElement(baseline.ProjectBaseline,{workspace,project:workspace.projects[0],busy:false}));context(html,'TAMENNI / Unclassified / Other');assert.ok(html.includes('specific next-step proposals'));
});

test('dependency graph node/link titles and GitHub task proposals use explicit context without prose inference',()=>{
 const connected={...workspace,tasks:[{...android,dependsOn:[planning.id,map.id,legacy.id]},planning,map,legacy]};classified(renderToStaticMarkup(createElement(graph.TaskGraphView,{workspace:connected,task:connected.tasks[0],onTask:noop})));
 const report=parseImportedGithubReport(new TextEncoder().encode(JSON.stringify({format:'control-room-github-analysis',version:1,repository:{fullName:'owner/repo',url:'https://github.com/owner/repo',head:'a'.repeat(40)},run:{id:'00000000-0000-4000-8000-000000000001',provider:'codex',requestedModel:'gpt-6.1-sol',observedModel:null,startedAt:now,completedAt:now,mode:'read-only',source:'codex-cloud-handoff'},manifest:[{path:'src/main.js',sha256:'b'.repeat(64),lines:2}],summary:'Synthetic review.',architecture:[],findings:[],suggestedTasks:[{title:'Android testing Map Review are only prose',notes:'Owner chooses classification.'}],limitations:['Static source review only.']})));
 const html=renderToStaticMarkup(createElement(github.GithubReportPreview,{report,projectId:'p1',workspace,onReviewTask:noop}));context(html,'TAMENNI / Unclassified / Other');assert.ok(!html.includes('aria-label="TAMENNI / Android testing / Testing"'));assert.ok(html.includes('require review'));
});

test('search renders actual task classifications and matches all saved context tokens without relabeling prose',()=>{
 const selected={...workspace,tasks:[{...android,workType:'planning' as const},map,legacy]};assert.deepEqual(searchPlanning(selected,{entityTypes:['task'],query:'TAMENNI Android testing Planning'}).items.map(task=>task.id),[android.id]);assert.deepEqual(searchPlanning(selected,{entityTypes:['task'],query:'TAMENNI Map Review'}).items.map(task=>task.id),[map.id]);
 const html=renderToStaticMarkup(createElement(search.SearchView,{workspace:selected,revision:1,onOpen:noop,initialQuery:'TAMENNI Android testing Planning'}));context(html,'TAMENNI / Android testing / Planning');assert.ok(!html.includes('aria-label="TAMENNI / Map / Review"'));
 const prose={...workspace,tasks:[{...legacy,title:'Android testing Planning Map Review prose'}]};context(renderToStaticMarkup(createElement(search.SearchView,{workspace:prose,revision:1,onOpen:noop,initialQuery:'Android testing Planning'})),'TAMENNI / Unclassified / Other');
});

test('frozen weekly context never borrows a current task classification and marks its missing historical fields',()=>{
 const html=renderToStaticMarkup(createElement(weekly.FrozenWeeklyTaskContext,{projectId:android.projectId,workspace}));context(html,'TAMENNI / Unclassified / Other');assert.ok(html.includes('Historical classification was not recorded.'));assert.ok(!html.includes('Android testing'));assert.ok(!html.includes(' / Testing'));
});
