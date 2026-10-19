import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {projectLabImport,projectLabRun,projectLabReport,importLabMain,LAB_IMPORT_LIMITS} from '../src/agent-lab-import.mjs';
const fixture=JSON.parse(await readFile(new URL('../../tests/fixtures/agents/lab-wire-synthetic.json',import.meta.url),'utf8'));
const bytes=value=>Buffer.from(JSON.stringify(value)),options={kind:'summary',sourceInstance:'synthetic-selected-lab',selectedRunIds:['synthetic-objective-pass']};
const objective={assessable:true,passed:true,score:2,checksPassed:2,checksTotal:2};
function comparison(){return {provider:'codex',runtimeVersion:'synthetic-runtime',runtimeToolPolicy:'synthetic-policy',taskId:'synthetic-task',taskVersion:1,fixtureHash:'b'.repeat(64),taskMode:'read',promptMode:'structured',effort:'medium',requestedModel:'synthetic-model',samples:2,finished:2,assessable:1,objectiveFailures:0,blocked:1,passed:1,accepted:1,rejected:0,reviewed:1,reviewMinuteRecords:1,correctionRecords:1,usageReported:0,verifiedModels:0,statuses:{passed:1,blocked:1},reviewMinutes:3,corrections:0,meanDurationMs:10,markdown:'SYNTHETIC_PRIVATE_PROSE',usage:[{costDollars:99}]};}
test('selected actual-shape synthetic runs project before transport, preserve objective versus human/model claims and never infer cost',()=>{
 const result=projectLabImport(bytes(fixture),options),run=result.upload.runs[0];
 assert.equal(run.status,'completed');assert.equal(run.sourceStatus,'passed');assert.deepEqual(run.objective,objective);assert.equal(run.review.verdict,'accepted');assert.equal(run.modelVerified,true);assert.equal(run.usage,null);assert.equal(run.grade,null);assert.equal(run.createdAt,fixture.runs[0].createdAt);
 assert.equal(result.sourceInputSha256,createHash('sha256').update(bytes(fixture)).digest('hex'));assert.match(run.sourceInputSha256,/^[a-f0-9]{64}$/u);
 const output=JSON.stringify(result);for(const field of ['SYNTHETIC_PRIVATE','csrfToken','runtimeExecutable','finalText','costDollars','savings','synthetic-runtime-failure'])assert.equal(output.includes(field),false,field);
 assert.equal(Object.hasOwn(run,'accepted'),false);assert.equal(Object.hasOwn(run,'ready'),false);assert.equal(Object.hasOwn(result,'command'),false);
});
test('ungraded runtime failure remains not assessed; malformed grade and contradictory source outcomes refuse',()=>{
 const failure=projectLabRun(fixture.runs[1]);assert.equal(failure.sourceStatus,'failed');assert.equal(failure.objective,null);assert.equal(failure.provider,null);assert.equal(failure.modelVerified,false);
 for(const patch of [{grade:{passed:true,score:1,checks:[{passed:'true'}]}},{grade:{passed:false,score:0,checks:[]}},{grade:{passed:true,score:Infinity,checks:[]}},{status:'accepted_for_execution'},{finishedAt:'2026-10-18T00:00:00Z'}])assert.throws(()=>projectLabRun({...fixture.runs[0],...patch}));
 const blocked=projectLabRun({...fixture.runs[0],status:'blocked',runtimeBlock:{reason:'SYNTHETIC_PRIVATE'},grade:{passed:true}});assert.deepEqual(blocked.objective,{assessable:false,passed:null,score:null,checksPassed:null,checksTotal:null});
 const mismatch=projectLabRun({...fixture.runs[0],observedModel:'synthetic-other'});assert.equal(mismatch.modelVerified,false);
});
test('explicit selection is bounded, unique and source-existing; secret extras are discarded and accepted secret identifiers refused',()=>{
 for(const selectedRunIds of [[],['missing'],['synthetic-objective-pass','synthetic-objective-pass'],Array(201).fill('x')])assert.throws(()=>projectLabImport(bytes(fixture),{...options,selectedRunIds}));
 assert.throws(()=>projectLabImport(bytes({...fixture,runs:[fixture.runs[0],fixture.runs[0]]}),options));
 assert.throws(()=>projectLabImport(bytes({...fixture,runs:[{...fixture.runs[0],requestedModel:'ghp_'+ 'A'.repeat(30)}]}),options));
 const edited=structuredClone(fixture);edited.runs[1].error='SYNTHETIC_OTHER_PRIVATE';const first=projectLabImport(bytes(fixture),options),second=projectLabImport(bytes(edited),options);assert.deepEqual(second.upload,first.upload);assert.notEqual(second.sourceInputSha256,first.sourceInputSha256);
});
test('actual-shape report cohorts retain denominators and all statuses but cannot become per-run upload or readiness',()=>{
 const raw={comparisons:[comparison()],markdown:'SYNTHETIC_PRIVATE',recommendations:[{text:'SYNTHETIC_PRIVATE'}]},result=projectLabImport(bytes(raw),{kind:'report',sourceInstance:'synthetic-selected-lab'});
 assert.equal(result.kind,'report');assert.equal(Object.hasOwn(result,'upload'),false);assert.equal(result.cohorts[0].counts.assessable,1);assert.equal(result.cohorts[0].counts.passed,1);assert.equal(result.cohorts[0].counts.samples,2);assert.equal(result.cohorts[0].costDollars,null);assert.equal(result.cohorts[0].usage,null);assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);
 assert.equal(projectLabReport({comparisons:[{...comparison(),runtimeVersion:null}]}).cohorts[0].cohortSha256,null);
 for(const row of [{...comparison(),passed:2},{...comparison(),accepted:2},{...comparison(),statuses:{passed:1}},{...comparison(),verifiedModels:3}])assert.throws(()=>projectLabReport({comparisons:[row]}));
 const secret='ghp_'+'A'.repeat(30);for(const field of ['requestedModel','runtimeVersion','taskId'])assert.throws(()=>projectLabReport({comparisons:[{...comparison(),[field]:secret}]}));
 const ignored=projectLabReport({comparisons:[{...comparison(),runtimeExecutable:secret}],markdown:secret,csrfToken:secret});assert.equal(JSON.stringify(ignored).includes(secret),false);
 assert.throws(()=>projectLabReport({comparisons:[comparison(),comparison()]}));
 const largeReport={comparisons:Array.from({length:100},(_,index)=>({...comparison(),taskId:'synthetic-cohort-'+index+'x'.repeat(80),runtimeVersion:'synthetic-runtime-'+'x'.repeat(80)}))};assert.ok(bytes(largeReport).length<LAB_IMPORT_LIMITS.bytes);assert.throws(()=>projectLabReport(largeReport));assert.throws(()=>projectLabImport(bytes(largeReport),{kind:'report',sourceInstance:'synthetic-selected-lab'}));
 const changed=projectLabReport({comparisons:[{...comparison(),fixtureHash:'c'.repeat(64)}]});assert.notEqual(changed.cohorts[0].cohortSha256,result.cohorts[0].cohortSha256);
});
test('UTF8, JSON depth/nodes, byte and final upload bounds refuse instead of truncating',()=>{
 assert.throws(()=>projectLabImport(Buffer.from([255]),options));assert.throws(()=>projectLabImport(Buffer.alloc(LAB_IMPORT_LIMITS.bytes+1),options));
 let nested={};for(let n=0;n<22;n++)nested={nested};assert.throws(()=>projectLabImport(bytes({...fixture,nested}),options));
 assert.throws(()=>projectLabImport(bytes({...fixture,extra:Array(10001).fill(null)}),options));assert.throws(()=>projectLabImport(bytes(JSON.parse('{"__proto__":{},"runs":[]}')),options));
 const large={version:'synthetic-1',runs:Array.from({length:120},(_,i)=>({...fixture.runs[0],id:'synthetic-run-'+i}))};assert.ok(bytes(large).length<LAB_IMPORT_LIMITS.bytes);assert.throws(()=>projectLabImport(bytes(large),{...options,selectedRunIds:large.runs.map(row=>row.id)}));
});
test('explicit local CLI only reads a bounded regular chosen file and emits projection; no service/cloud/provider operation exists',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'synthetic-lab-import-'));try{const path=join(directory,'selected.json');await writeFile(path,JSON.stringify(fixture));let output='';
 const result=await importLabMain(['--input',path,'--kind','summary','--instance','synthetic-selected-lab','--run','synthetic-objective-pass'],{write:value=>{output+=value;}});assert.deepEqual(JSON.parse(output),result);assert.equal(output.includes(path),false);assert.equal(output.includes('SYNTHETIC_PRIVATE'),false);
 for(const args of [['--input',path,'--kind','summary','--instance','synthetic-selected-lab','--url','https://remote.invalid'],['--input','relative.json','--kind','summary','--instance','synthetic-selected-lab'],['--input',directory,'--kind','summary','--instance','synthetic-selected-lab']])await assert.rejects(importLabMain(args,{write(){assert.fail('Refused input must not print.');}}));
 if(process.platform!=='win32'){const link=join(directory,'link.json');await symlink(path,link);await assert.rejects(importLabMain(['--input',link,'--kind','summary','--instance','synthetic-selected-lab','--run','synthetic-objective-pass']));}
 }finally{await rm(directory,{recursive:true,force:true});}
});
