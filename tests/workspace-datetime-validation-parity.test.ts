import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {z} from 'zod';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {legacyWorkspaceFixture} from './helpers/workspace.ts';
const at='2026-10-17T12:00:00.000Z',sourceUrl=new URL('../lib/workspace-validation.ts',import.meta.url),source=await readFile(sourceUrl,'utf8');
const optimized="const stamp = z.string().regex(z.datetimeRegex({precision:null,offset:true,local:false}), 'Invalid datetime');";
assert.equal(source.split(optimized).length,2);
// Entire previous parser, with identical actual dependencies and prior stamp.
const previous=stripTypeScriptTypes(source.replace(optimized,'const stamp = z.string().datetime({ offset: true });')).replace(/from '([^']+)'/gu,(_,path:string)=>`from '${path.startsWith('.')?new URL(path,sourceUrl).href:import.meta.resolve(path)}'`);
const legacy=await import('data:text/javascript;base64,'+Buffer.from(previous).toString('base64')) as {parseWorkspaceExport:typeof parseWorkspaceExport};
function result(parser:typeof parseWorkspaceExport,value:unknown,savedAt:string|undefined){try{return {accepted:true,value:parser(structuredClone(value),savedAt)};}catch(error){return {accepted:false,message:error instanceof Error?error.message:String(error)};}}
function parity(value:unknown,savedAt?:string){const anchor=arguments.length>=2?savedAt:at;const expected=result(legacy.parseWorkspaceExport,value,anchor),actual=result(parseWorkspaceExport,value,anchor);assert.deepEqual(actual,expected);return actual;}
function fixture(){const value=createSeedWorkspace(at);value.activity=[{id:'activity',text:'Synthetic activity',at,projectId:null}];return value;}
function assign(value:unknown,path:(string|number)[],replacement:unknown){let parent=value as Record<string|number,unknown>;for(const key of path.slice(0,-1))parent=parent[key] as Record<string|number,unknown>;parent[path.at(-1)!]=replacement;}
const paths:(string|number)[][]=[['projects',0,'archivedAt'],['milestones',0,'updatedAt'],['milestones',0,'archivedAt'],['tasks',0,'createdAt'],['tasks',0,'updatedAt'],['tasks',0,'completedAt'],['captures',0,'createdAt'],['activity',0,'at']];
const corpus:unknown[]=[at,'2024-02-29T23:59:59Z','2000-02-29T00:00:00Z','0000-02-29T00:00:00Z','1900-02-29T00:00:00Z','2023-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-12-31T23:59:59.123456789Z','2026-10-17T12:30Z','2026-10-17T12:30:00+03:30','2026-10-17T12:30:00-0330','2026-10-17T12:30:00+99:99','2026-10-17T12:30:00+9999','2026-10-17T12:30:00+3:00','2026-10-17T12:30:00','2026-10-17T12:30:00z','2026-10-17 12:30:00Z','2026-10-17T24:00:00Z','2026-10-17T23:60:00Z','2026-10-17T23:59:60Z','2026-10-17T12:30:00.Z','2026-10-17T12:30:00.0Z',at+'\n',at+'\r\n','\n'+at,' '+at,at+' ',at+'\u2028','',null,undefined,42,{},[],new Date(at)];
test('locked datetime options and pattern are exactly the library-generated validator',()=>{
 const original=z.string().datetime({offset:true});assert.deepEqual(original._def.checks,[{kind:'datetime',precision:null,offset:true,local:false}]);
 const regex=z.datetimeRegex({precision:null,offset:true,local:false});assert.equal(regex.flags,'');
 for(const value of corpus){const old=original.safeParse(value),next=z.string().regex(regex,'Invalid datetime').safeParse(value);assert.equal(next.success,old.success);if(!old.success&&!next.success)assert.equal(next.error.issues[0].message,old.error.issues[0].message);}
});
test('every stamp field preserves exact full-parser output and first refusal across datetime quirks',()=>{
 for(const path of paths)for(const stamp of corpus){const value=fixture();if(path.at(-1)==='completedAt'&&stamp!==null&&stamp!==undefined){value.tasks[0].status='done';value.tasks[0].dependsOn=[];value.tasks[0].blocker='';}assign(value,path,stamp);parity(value);}
});
test('nullable and optional stamp absence, multiple-issue order, and repeated parses stay unchanged',()=>{
 for(const path of paths){const value=fixture();let parent:unknown=value;for(const key of path.slice(0,-1))parent=(parent as Record<string|number,unknown>)[key];delete (parent as Record<string|number,unknown>)[path.at(-1)!];parity(value);}
 const value=fixture();value.projects[0].archivedAt='invalid-first';value.tasks[0].createdAt='invalid-later';const refused=parity(value);assert.match(refused.message!,/Invalid workspace projects.0.archivedAt: Invalid datetime/);
 for(let i=0;i<10;i++){assert.equal(parity(fixture()).accepted,true);const bad=fixture();bad.tasks[0].updatedAt='invalid';assert.equal(parity(bad).accepted,false);}
});
test('savedAt and wrapper anchors retain exact validation, migration and weekly behavior',()=>{
 for(const savedAt of corpus){for(const version of [1,2,3] as const){const value=legacyWorkspaceFixture(version,at);value.tasks[0].weekly=true;parity(value,savedAt as string|undefined);parity({workspace:value,updatedAt:savedAt},undefined);}}
});
