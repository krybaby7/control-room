import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadClient} from './helpers/render-client.ts';
import {buildDashboardModel} from '../lib/dashboard/model.ts';
import {dashboardFixture,NOW,okFeeds} from './fixtures/dashboard.ts';
import {briefingFixtureV1,briefingFixtureV2,briefingFixtureV3} from './fixtures/briefing.ts';
import {validateProjectBriefing} from '../shared/project-briefing.mjs';
import type {SavedProjectBriefing} from '../lib/project-briefing-client.ts';
import type {DashboardFixture} from './fixtures/dashboard.ts';
// Compile the actual client leaves, then render their pure presentation with React.
const home=await loadClient<typeof import('../components/home-briefings')>(new URL('../components/home-briefings.tsx',import.meta.url));
const projectBriefing=await loadClient<typeof import('../components/project-briefing')>(new URL('../components/project-briefing.tsx',import.meta.url));
const needs=await loadClient<typeof import('../components/needs-you-view')>(new URL('../components/needs-you-view.tsx',import.meta.url));
const advanced=await loadClient<typeof import('../components/advanced-view')>(new URL('../components/advanced-view.tsx',import.meta.url));
const noop=()=>{};
const feed={brief:async()=>{},keepCurrent:async()=>{},retrySave:async()=>{},notices:{},working:{},choosingFolder:false};
function model(fixture:DashboardFixture,briefings:SavedProjectBriefing[]=fixture.briefings){return buildDashboardModel({now:NOW,workspace:fixture.workspace,jobs:fixture.jobs,jobDetails:{},runtime:fixture.runtime,connector:fixture.connector,localReports:fixture.localReports,cloudReports:fixture.cloudReports,briefings,feeds:okFeeds()});}
async function briefed(){const fixture=await dashboardFixture();fixture.workspace.projects[1].personalRepositoryKeys=['repo-b'];return {fixture,value:model(fixture)};}
const card=(tile:ReturnType<typeof model>['projects'][number],extra:Record<string,unknown>={})=>renderToStaticMarkup(createElement(home.HomeCard,{tile,now:NOW,feed,busy:false,loading:false,onOpenProject:noop,onProjectFolders:noop,onNeedsYou:noop,...extra}));
const text=(html:string)=>html.replace(/<[^>]+>/g,' ').replace(/&#x27;/g,"'").replace(/\s+/g,' ');

test('a Home card answers the aim, where it stands, what needs the owner and the next step with one primary action',async()=>{
 const {value}=await briefed(),html=card(value.projects[1]),plain=text(html);
 for(const value of ['Trade Graph','On track','The aim right now','Run one full trading cycle on the test account','Where we\'re at','The aim is a full cycle on the test account','Needs you','Approve the first live trial budget.','Next step','Review and merge the reconciliation draft.','Refresh briefing','Open project'])assert.ok(plain.includes(value),`missing ${value}`);
 assert.equal((html.match(/class="button primary"/g)??[]).length,1,'one primary action per card');
 for(const clutter of ['progressbar','mc-light','mc-meter','LVL','tokens','Milestones','Tasks done','Live operations','Mission log'])assert.ok(!html.includes(clutter),`Home card must not show ${clutter}`);
 assert.ok(plain.indexOf('The aim right now')<plain.indexOf('Where we\'re at')&&plain.indexOf('Where we\'re at')<plain.indexOf('Needs you')&&plain.indexOf('Needs you')<plain.indexOf('Next step'),'reads in the owner\'s job order');
});
test('a Home card without a briefing shows the owner goal, the plan\'s next step and a disabled briefing with its visible reason',async()=>{
 const {value}=await briefed(),tile=value.projects[0],html=card(tile),plain=text(html);
 assert.ok(plain.includes('Your goal'));assert.ok(plain.includes('No briefing yet.'));assert.ok(plain.includes('Next step from your plan'));
 const button=html.match(/<button[^>]*>Brief this project<\/button>/)?.[0];assert.ok(button,'Brief this project');assert.ok(button.includes('disabled'));
 const described=button.match(/aria-describedby="([^"]+)"/)?.[1];assert.ok(described,'the disabled reason is linked');
 assert.match(html,new RegExp(`id="${described}"[^>]*>Add a folder first\\.`));assert.ok(html.includes('>Add a folder</button>'));
});
test('a Home card keeps three briefing requests and points to the rest in Needs you',async()=>{
 const fixture=await dashboardFixture(),briefing={...fixture.briefings[0],briefing:{...fixture.briefings[0].briefing,needsYou:['One','Two','Three','Four','Five']}},value=model(fixture,[briefing]);
 const plain=text(card(value.projects[1]));
 for(const item of ['One','Two','Three'])assert.ok(plain.includes(item));assert.ok(!plain.includes('Four'));assert.ok(plain.includes('2 more in Needs you'));
});
test('saved briefings of every version still read on Home and the project page',async()=>{
 for(const [label,raw] of [['version 1',briefingFixtureV1()],['version 2',briefingFixtureV2()],['version 3',briefingFixtureV3()]] as const){
  const fixture=await dashboardFixture(),briefing=validateProjectBriefing(raw),value=model(fixture,[{evidenceId:`evidence-${label}`,version:1,projectId:fixture.projectB,briefing,recordedAt:NOW}]),tile=value.projects[1];
  const homeText=text(card(tile)),pageText=text(renderToStaticMarkup(createElement(projectBriefing.ProjectBriefingBody,{tile,now:NOW,feed,busy:false,loading:false})));
  for(const plain of [homeText,pageText]){assert.ok(plain.includes(briefing.aim),`${label} aim`);assert.ok(plain.includes('Approve the first live trial budget.'),`${label} needs you`);assert.ok(plain.includes('Review and merge the reconciliation draft.'),`${label} next step`);assert.ok(plain.includes('Refresh briefing'),`${label} action`);}
 }
});
test('the project page briefing puts the aim, standing, intentions, needs and next steps first and keeps evidence in folds',async()=>{
 const {value}=await briefed(),html=renderToStaticMarkup(createElement(projectBriefing.ProjectBriefingBody,{tile:value.projects[1],now:NOW,feed,busy:false,loading:false})),plain=text(html);
 const order=['The aim right now','Where it stands','Your intentions, newest first','Needs you','Next steps','Refresh briefing','Project map and how the plan changed','How this briefing was put together','Briefing settings'].map(value=>plain.indexOf(value));
 assert.ok(order.every(index=>index>=0),JSON.stringify(order));assert.deepEqual(order,[...order].sort((a,b)=>a-b));
 assert.ok(plain.indexOf('a1b2c3d')>plain.indexOf('How this briefing was put together'),'references stay behind the evidence fold');
 assert.ok(/<details[^>]*><summary>How this briefing was put together<\/summary>/.test(html)&&!/<details[^>]*open/.test(html),'technical folds start closed');
 assert.equal((html.match(/class="button primary"/g)??[]).length,1,'one primary action');
 for(const option of ['Codex','Claude Code (not signed in)'])assert.ok(plain.includes(option),`assistant option ${option}`);assert.ok(plain.includes('Keep this briefing current'));
});
test('Needs you lists every waiting item by project, without the old eight-item cap, and opens its source',async()=>{
 const fixture=await dashboardFixture(),briefing={...fixture.briefings[0],briefing:{...fixture.briefings[0].briefing,needsYou:Array.from({length:9},(_,index)=>`Synthetic decision ${index+1}`)}},value=model(fixture,[briefing]);
 const opened:string[]=[],groups=needs.needsYouGroups(value,fixture.workspace,{onProject:project=>opened.push(`project:${project.id}`),onTask:task=>opened.push(`task:${task.id}`),onAgents:()=>opened.push('agents'),onInbox:()=>opened.push('inbox'),onAttention:()=>opened.push('attention')});
 const trade=groups.find(group=>group.key===fixture.projectB),tamenni=groups.find(group=>group.key===fixture.projectA);assert.ok(trade&&tamenni);
 assert.equal(trade.items.filter(item=>item.detail==='Raised by the latest briefing.').length,9);
 const details=groups.flatMap(group=>group.items.map(item=>item.detail));
 for(const detail of ['Waiting for your review.','An assistant task is waiting for your go-ahead.','An assistant run ended without a clear result. Check what happened.','Pinned for an earlier week and still open.','File them, turn them into tasks or archive them.'])assert.ok(details.includes(detail),`missing ${detail}`);
 assert.ok(details.some(detail=>/^Was due /.test(detail)),'overdue work shows its due date');
 assert.ok(groups.flatMap(group=>group.items).some(item=>item.title==='1 captured idea to sort'));
 trade.items[0].open();tamenni.items.find(item=>item.detail==='Waiting for your review.')!.open();groups.flatMap(group=>group.items).find(item=>item.detail.startsWith('An assistant task'))!.open();
 assert.deepEqual(opened,[`project:${fixture.projectB}`,`task:${fixture.workspace.tasks.find(task=>task.projectId===fixture.projectA&&task.status==='review')!.id}`,'agents']);
 const html=renderToStaticMarkup(createElement(needs.NeedsYouContent,{groups,briefings:'ok',onAttention:noop})),total=groups.reduce((sum,group)=>sum+group.items.length,0);
 assert.ok(text(html).includes(`${total} things wait on you.`));assert.ok(html.includes('Open Attention'));
 const empty=text(renderToStaticMarkup(createElement(needs.NeedsYouContent,{groups:[],briefings:'ok',onAttention:noop})));assert.ok(empty.includes('Nothing waits on you right now.'));assert.ok(empty.includes('All clear'));
});
test('Advanced reaches every detailed tool with a plain description and shows connection details',()=>{
 const labels={lanes:'Project lanes',today:'Mission control',weekly:'Weekly planning',search:'Search',attention:'Attention',inbox:'Inbox',bulk:'Change many tasks at once',history:'History',evidence:'Evidence & decisions',sources:'Sources, export and restore','local-analysis':'Repositories',reviews:'Briefs & automations',runtime:'Runtime',agents:'Agents'} as const;
 const html=renderToStaticMarkup(createElement(advanced.AdvancedView,{labels,onOpen:noop,liveUpdates:'Live updates: polling (streaming unverified)',savedLine:'Last saved now'}));
 for(const label of Object.values(labels))assert.match(html.replace(/&amp;/g,'&'),new RegExp(`<button[^>]*aria-describedby="[^"]+"[^>]*>${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}<svg`),label);
 assert.equal((html.match(/<button/g)??[]).length,Object.keys(labels).length);
 for(const value of ['Connection details','Live updates: polling (streaming unverified)','Last saved now'])assert.ok(html.includes(value));
});
