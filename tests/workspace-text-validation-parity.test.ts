import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createSeedWorkspace} from '../lib/seed.ts';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {legacyWorkspaceFixture} from './helpers/workspace.ts';

// Differential oracle retains the entire prior parser, restoring the old
// ID and text validators. All imports resolve to the same actual dependencies.
const sourceUrl=new URL('../lib/workspace-validation.ts',import.meta.url);
const source=await readFile(sourceUrl,'utf8');
const optimized='required ? z.string().max(max).regex(/\\S/u, \'Invalid input\') : z.string().max(max)';
assert.equal(source.split(optimized).length,2);
const optimizedId=String.raw`z.string().min(1).max(128).regex(/^\S(?:[\s\S]*\S)?(?![\s\S])/u, 'Invalid input')`;
assert.equal(source.split(optimizedId).length,2);
const legacySource=source.replace(optimized,'z.string().max(max).refine(s => !required || s.trim().length > 0)').replace(optimizedId,'z.string().min(1).max(128).refine(s => s.trim() === s)');
const resolved=stripTypeScriptTypes(legacySource).replace(/from '([^']+)'/gu,(_,path:string)=>`from '${path.startsWith('.')?new URL(path,sourceUrl).href:import.meta.resolve(path)}'`);
const legacy=await import('data:text/javascript;base64,'+Buffer.from(resolved).toString('base64')) as {parseWorkspaceExport:typeof parseWorkspaceExport};
const at='2026-10-17T12:00:00.000Z';
function outcome(parser:typeof parseWorkspaceExport,value:unknown){try{return {accepted:true,value:parser(structuredClone(value),at)};}catch(error){return {accepted:false,message:error instanceof Error?error.message:String(error)};}}
function parity(value:unknown){const expected=outcome(legacy.parseWorkspaceExport,value),actual=outcome(parseWorkspaceExport,value);assert.deepEqual(actual,expected);return actual;}
const optionalFields:Array<{path:(string|number)[];max:number}>=[
 {path:['projects',0,'description'],max:5000},{path:['projects',0,'goal'],max:5000},
 {path:['milestones',0,'description'],max:5000},{path:['milestones',0,'acceptance'],max:5000},{path:['milestones',0,'evidence'],max:5000},
 {path:['tasks',0,'notes'],max:10000},{path:['tasks',0,'blocker'],max:1000},{path:['tasks',0,'evidence'],max:5000},
 {path:['captures',0,'body'],max:10000},
];
function assign(value:unknown,path:(string|number)[],replacement:unknown){let parent=value as Record<string|number,unknown>;for(const key of path.slice(0,-1))parent=parent[key] as Record<string|number,unknown>;parent[path.at(-1)!]=replacement;}
function fixture(){const value=createSeedWorkspace(at);if(!value.captures.length)value.captures=[{id:'capture',title:'Capture',body:'',projectId:null,kind:'idea',sourceUrl:null,status:'inbox',createdAt:at,convertedTaskId:null}];return value;}
test('optional owner text preserves exact accepted values and old refusal messages at every field bound',()=>{
 for(const {path,max} of optionalFields)for(const text of ['', ' \t\n\u00a0\ufeff', 'ع😀', '\ud800', 'x'.repeat(max),'x'.repeat(max+1),null,42,{},[]]){
  const value=fixture();assign(value,path,text);const result=parity(value);
  if(typeof text==='string'&&text.length<=max)assert.equal(result.accepted,true,JSON.stringify(path));else {assert.equal(result.accepted,false);assert.match(result.message!,new RegExp('Invalid workspace '+path.join('\\.')));}
 }
});
test('required text retains whitespace, primitive, length, and first-issue ordering refusals',()=>{
 for(const path of [['projects',0,'name'],['milestones',0,'title'],['tasks',0,'title'],['captures',0,'title']] as (string|number)[][])for(const text of ['', ' \t\n\u00a0\ufeff',null,42,'x'.repeat(201)]){const value=fixture();assign(value,path,text);assert.equal(parity(value).accepted,false);}
 const value=fixture();value.projects[0].name='';value.tasks[0].notes='x'.repeat(10001);value.tasks[0].title='';const result=parity(value);assert.match(result.message!,/Invalid workspace projects.0.name/);
});
test('schema strictness and legacy migrations preserve complete parser parity',()=>{
 for(const version of [1,2,3] as const){const value=legacyWorkspaceFixture(version,at);assert.equal(parity(value).accepted,true);}
 for(const path of [[],['tasks',0],['projects',0],['captures',0]] as (string|number)[][]){const value=fixture();let target:unknown=value;for(const key of path)target=(target as Record<string|number,unknown>)[key];(target as Record<string,unknown>).unexpected='field';assert.equal(parity(value).accepted,false);}
 const value=fixture();value.tasks[0].notes='x'.repeat(10001);value.projects[0].description=42 as unknown as string;assert.equal(parity(value).accepted,false);
});
test('ID trim equality and required text preserve every ECMAScript whitespace and exact first issue',()=>{
 const whitespace=Array.from('\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff');
 for(const character of whitespace){
  for(const id of [character+'id','id'+character,character,'id'+character+'inside']){const value=fixture();value.captures[0].id=id;assert.equal(parity(value).accepted,id.startsWith('id')&&id.endsWith('inside'));}
  const empty=fixture();empty.tasks[0].title=character;assert.equal(parity(empty).accepted,false);
  const retained=fixture();retained.tasks[0].title=character+'title'+character;const result=parity(retained);assert.equal(result.accepted,true);if(result.accepted)assert.equal(result.value!.tasks[0].title,retained.tasks[0].title);
 }
 for(const id of ['', 'x'.repeat(128),'x'.repeat(129),'\u200b','\u0085','\ud800','x\n','x\r\n']){const value=fixture();value.captures[0].id=id;parity(value);}
 const value=fixture();value.captures[0].id=' '+ 'x'.repeat(128);const result=parity(value);assert.match(result.message!,/at most 128/);
});
