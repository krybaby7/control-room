import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {projectFixture,workspaceFixture} from './helpers/workspace.ts';
let personal:typeof import('../components/personal-repository-onboarding'),wrapper:typeof import('../components/repository-onboarding');
// Compile real client modules in-process: no browser or subprocess is needed for these render checks.
const hooks=registerHooks({resolve(specifier,context,next){const candidate=specifier.startsWith('@/')?pathToFileURL(resolve(process.cwd(),specifier.slice(2))).href:specifier.startsWith('.')?new URL(specifier,context.parentURL).href:null;if(candidate?.startsWith('file:')&&!extname(fileURLToPath(candidate))){for(const extension of ['.ts','.tsx','.mts'])if(existsSync(fileURLToPath(candidate)+extension))return {url:candidate+extension,shortCircuit:true};}return next(specifier,context);},load(url,context,next){if(/\.(?:tsx|ts|mts)$/.test(url)&&!url.includes('/node_modules/'))return {format:'module',source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);}});
try{personal=await import('../components/personal-repository-onboarding.tsx');wrapper=await import('../components/repository-onboarding.tsx');}finally{hooks.deregister();}
const props={envelope:{workspace:workspaceFixture(),revision:1,updatedAt:'2026-10-27T12:00:00.000Z'},busy:false,pending:false,onCommand:async()=>assert.fail('render must not mutate'),onCreateProject:async()=>assert.fail('render must not create')};
const repositories=['bound','free','archived'].map(key=>({key,name:key,head:'a'.repeat(40),dirty:false,hasPreviousAnalysis:false}));
test('This PC appears first and its default view keeps technical analysis closed',()=>{
 const html=renderToStaticMarkup(createElement(wrapper.RepositoryOnboarding,props));
 assert.ok(html.indexOf('>This PC<')<html.indexOf('>Codex Cloud<'));
 assert.match(html,/<details[^>]*><summary>More: technical analysis<\/summary>/);
 assert.doesNotMatch(html,/<details[^>]*open[^>]*><summary>More: technical analysis/);
 assert.match(html,/>Add a folder from this PC<\/button>/);
 assert.doesNotMatch(html,/Brief this project/);
});
test('plain folder rows show actual ownership including archived ownership',()=>{
 const projects=[projectFixture({name:'Bound project',personalRepositoryKeys:['bound']}),projectFixture({id:'old',name:'Old project',personalRepositoryKeys:['archived'],archivedAt:'2026-10-26T12:00:00.000Z'})];
 const html=renderToStaticMarkup(createElement(personal.PersonalRepositoryFolders,{repositories,projects,reason:null,adding:null,destinations:{},onAdding:()=>{},onDestination:()=>{},onLink:()=>{},onCreate:()=>{}}));
 assert.match(html,/<a[^>]*href="\/\?view=projects&amp;entity=project&amp;id=p1"[^>]*>Bound project<\/a>/);
 assert.match(html,/In archived project Old project\. Restore it from Projects\./);
 assert.equal((html.match(/>Add to project…<\/button>/g)??[]).length,1);
 assert.match(html,/Not in a project/);
 assert.doesNotMatch(html,/Analyze|Brief this project|Working folder|first analysis/);
});
test('folder chooser offers active projects below four folders and a new project',()=>{
 const projects=[projectFixture({id:'room',name:'Room'}),projectFixture({id:'full',name:'Full',personalRepositoryKeys:['1','2','3','4']}),projectFixture({id:'old',name:'Old',archivedAt:'2026-10-26T12:00:00.000Z'})];
 const html=renderToStaticMarkup(createElement(personal.PersonalRepositoryFolders,{repositories:[repositories[1]],projects,reason:null,adding:'free',destinations:{},onAdding:()=>{},onDestination:()=>{},onLink:()=>{},onCreate:()=>{}}));
 assert.match(html,/<option value="room">Room<\/option>/);assert.match(html,/<option value="new">New project from this folder…<\/option>/);
 assert.doesNotMatch(html,/<option value="(?:full|old)"/);
 assert.match(html,/<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"[^>]*>Add folder to project/);
 assert.match(html,/Choose a project first\./);
});
test('disabled folder actions expose one visible linked reason',()=>{
 const html=renderToStaticMarkup(createElement(personal.PersonalRepositoryFolders,{repositories:[repositories[1]],projects:[],reason:'Wait for the current save to finish.',adding:null,destinations:{},onAdding:()=>{},onDestination:()=>{},onLink:()=>{},onCreate:()=>{}}));
 const id=html.match(/aria-describedby="([^"]+)"/)?.[1];assert.ok(id);assert.ok(html.includes(`id="${id}"`));assert.match(html,/Wait for the current save to finish\./);
});
test('completed analysis explicit save retry stays enabled for an uncertain pending save',()=>{
 const html=renderToStaticMarkup(createElement(personal.PersonalCompletedSaveButton,{savedLoaded:true,saving:false,busy:false,pending:true,onRetry:()=>{}}));
 assert.match(html,/>Retry saving completed analysis<\/button>/);assert.doesNotMatch(html,/disabled=/);
 const loading=renderToStaticMarkup(createElement(personal.PersonalCompletedSaveButton,{savedLoaded:false,saving:false,busy:false,pending:true,onRetry:()=>{}}));
 assert.match(loading,/<button[^>]*disabled=""[^>]*aria-describedby=/);assert.match(loading,/Load saved reports before saving\./);
});

test('PC connection renders current and outdated last-poll state without hiding online status',()=>{
 const companion={protocol:null,kinds:['browse','analyze'],legacy:true,lastSeenAt:'2026-10-27T12:00:00Z'};
 const html=renderToStaticMarkup(createElement(personal.PersonalCompanionConnection,{companion}));
 const current=renderToStaticMarkup(createElement(personal.PersonalCompanionConnection,{companion:{...companion,protocol:1,kinds:['brief'],legacy:false,release:'27'}}));
 assert.match(current,/PC app: current/);assert.match(current,/Release 27/);assert.match(current,/Check-in version 1/);
 assert.match(html,/PC app: out of date — update it/);assert.match(html,/Last check-in/);
 const failure=renderToStaticMarkup(createElement(personal.PersonalRepositoryJobFailure,{job:{id:'synthetic',kind:'brief',status:'failed',error:'companion_outdated'}}));
 assert.ok(failure.includes("Your Control Room PC app is out of date, so it couldn&#x27;t run this briefing."));assert.match(failure,/Close the old PC app/);
});
