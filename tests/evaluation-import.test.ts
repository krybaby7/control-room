import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvaluationSummary,evaluationDedupKey,selectNewEvaluationObservations,validateEvaluationObservation,evaluationRunObservationSchema} from '../lib/agents/evaluation-import.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {readFile} from 'node:fs/promises';
import {projectLabImport} from '../bridge/src/agent-lab-import.mjs';
const now='2026-10-18T12:00:02.000Z';
const context={ownerId:'synthetic-owner-a',deviceId:'synthetic-device-a',sourceInstance:'synthetic-lab',observedAt:now,sourceFormatVersion:1 as const};
function run(id='fixture-run-1'){return {id,taskId:'incident-evidence-v1',taskVersion:1,fixtureHash:'a'.repeat(64),provider:'codex',requestedModel:'gpt-6-luna',observedModel:null,modelVerified:false,runtimeVersion:'fixture-runtime',runtimeToolPolicy:'native-sandbox',promptMode:'structured',effort:'medium',status:'blocked',grade:null,review:{verdict:'pending',minutes:null,corrections:null},usage:null,createdAt:'2026-10-18T12:00:00Z',finishedAt:'2026-10-18T12:00:01Z'};}
const source=(runs:unknown[]=[run()])=>({version:'0.1.0',queue:{paused:true,activeId:null},runs});
test('strict Agent Lab projection retains blocked/unknown source claims and excludes raw state, paths, tokens and transcripts',async()=>{
 const raw={...source([{...run(),providerExecutable:'C:/private/provider.exe',transcript:'private-transcript',error:'private-error',grade:{passed:true,providerReady:true}}]),csrfToken:'private-csrf',settings:{providerHome:'C:/private/home'},recommendation:'private-recommendation',reportMarkdown:'private-markdown'};
 const [record]=await normalizeEvaluationSummary(raw,context);
 assert.equal(record.status,'blocked');assert.equal(record.grade,null);assert.equal(record.usage,null);assert.equal(record.observedModel,null);assert.equal(record.modelVerified,false);assert.equal(record.historical,true);assert.equal(record.sourceClaimsOnly,true);
 const output=JSON.stringify(record);for(const value of ['private-','C:/','csrfToken','transcript','recommendation','providerReady','synthetic-owner-a'])assert.equal(output.includes(value),false);
 assert.deepEqual(await validateEvaluationObservation(record),record);assert.throws(()=>evaluationRunObservationSchema.parse({...record,providerReady:true}));
});
test('identity is owner/device/instance/run scoped while content dedup is stable across ordering and observed-at changes',async()=>{
 const first=await normalizeEvaluationSummary(source([run('fixture-b'),run('fixture-a')]),context),second=await normalizeEvaluationSummary(source([run('fixture-a'),run('fixture-b')]),{...context,observedAt:'2026-10-18T13:00:00Z'});
 assert.deepEqual(first.map(row=>row.id),second.map(row=>row.id));assert.deepEqual(selectNewEvaluationObservations(second,first),[]);
 const key={ownerId:context.ownerId,deviceId:context.deviceId,sourceInstance:context.sourceInstance,runId:'fixture-run-1'},original=await evaluationDedupKey(key);
 for(const patch of [{ownerId:'synthetic-owner-b'},{deviceId:'synthetic-device-b'},{sourceInstance:'another-lab'},{runId:'fixture-run-2'}])assert.notEqual(await evaluationDedupKey({...key,...patch}),original);
});
test('corrected upstream outcome appends a new deterministic historical observation without replacing the prior body',async()=>{
 const [original]=await normalizeEvaluationSummary(source(),context),updatedRun={...run(),status:'completed',observedModel:'gpt-6-luna',modelVerified:true,review:{verdict:'passed',minutes:2,corrections:1},usage:{inputTokens:17,outputTokens:3,runtimeSeconds:1}};
 const [updated]=await normalizeEvaluationSummary(source([updatedRun]),{...context,observedAt:'2026-10-18T13:00:00Z'});
 assert.equal(updated.identityKey,original.identityKey);assert.notEqual(updated.id,original.id);assert.notEqual(updated.outcomeHash,original.outcomeHash);assert.notEqual(updated.cohortHash,original.cohortHash);
 assert.deepEqual(selectNewEvaluationObservations([updated],[original]),[updated]);assert.equal(original.status,'blocked');assert.equal(updated.status,'completed');assert.equal(updated.grade,null);assert.equal(updated.historical,true);
 await assert.rejects(validateEvaluationObservation({...updated,status:'failed'}));assert.throws(()=>selectNewEvaluationObservations([{...original,status:'failed'}],[original]));
});
test('unknown metrics stay null, unsupported grade stays null and human verdict never becomes task acceptance',async()=>{
 const [record]=await normalizeEvaluationSummary(source([{...run(),status:'completed',usage:{inputTokens:'unknown',outputTokens:-1,runtimeSeconds:'unknown',costDollars:500,savingsDollars:1000},review:{verdict:'accepted',minutes:'unknown',corrections:-2},grade:{score:100,maxScore:100}}]),context);
 assert.deepEqual(record.usage,{inputTokens:null,outputTokens:null,runtimeSeconds:null});assert.deepEqual(record.review,{verdict:'accepted',minutes:null,corrections:null});assert.equal(record.grade,null);assert.equal(Object.hasOwn(record,'accepted'),false);assert.equal(Object.hasOwn(record,'costDollars'),false);
});
test('unsupported versions, duplicate runs, unsafe machine IDs, contradictory model identity and malformed clocks fail closed',async()=>{
 await assert.rejects(normalizeEvaluationSummary(source(),{...context,sourceFormatVersion:2} as unknown as typeof context));
 await assert.rejects(normalizeEvaluationSummary(source([run(),run()]),context));
 for(const changed of [{...run(),id:'C:/private/run'},{...run(),status:'approved_to_execute'},{...run(),modelVerified:true},{...run(),observedModel:'other-model',modelVerified:true},{...run(),createdAt:'2026-02-30T00:00:00Z'},{...run(),finishedAt:'2026-10-17T00:00:00Z'}])await assert.rejects(normalizeEvaluationSummary(source([changed]),context));
});
test('byte, structure and raw UTF8 limits are enforced without retaining source content',async()=>{
 await assert.rejects(normalizeEvaluationSummary(source(Array.from({length:201},(_,i)=>run('run-'+i))),context));
 await assert.rejects(normalizeEvaluationSummary({...source(),transcript:'x'.repeat(262145)},context));
 await assert.rejects(normalizeEvaluationSummary(new Uint8Array([255]),context));
 const unsafe=JSON.parse('{"version":"0.1.0","runs":[],"__proto__":{}}');await assert.rejects(normalizeEvaluationSummary(unsafe,context));
 assert.deepEqual(await normalizeEvaluationSummary(JSON.stringify(source([])),context),[]);
});

test('legacy evaluation bodies and canonical hashes remain byte-identical when optional projection fields are absent',async()=>{
 const [record]=await normalizeEvaluationSummary(source(),context),{id:runId,...rest}=run(),expected={runId,...rest};
 for(const key of ['sourceStatus','sourceInputSha256','objective'])assert.equal(Object.hasOwn(record,key),false,key);
 assert.equal(record.outcomeHash,await contentHash(canonical({sourceFormatVersion:1,labVersion:'0.1.0',run:expected})));
 assert.deepEqual(await validateEvaluationObservation(JSON.parse(canonical(record))),record);
});
test('local selected-run projection is accepted natively as historical objective claims without owner task or model authority',async()=>{
 const raw=await readFile(new URL('./fixtures/agents/lab-wire-synthetic.json',import.meta.url)),projected=projectLabImport(raw,{kind:'summary',sourceInstance:'synthetic-lab',selectedRunIds:['synthetic-objective-pass']});
 const upload=projected.upload;assert.ok(upload);if(!upload)return;
 const [record]=await normalizeEvaluationSummary(upload,context);
 assert.equal(record.status,'completed');assert.equal(record.sourceStatus,'passed');assert.deepEqual(record.objective,{assessable:true,passed:true,score:2,checksPassed:2,checksTotal:2});assert.match(record.sourceInputSha256!,/^[a-f0-9]{64}$/);
 assert.equal(record.grade,null);assert.equal(record.usage,null);assert.equal(record.sourceClaimsOnly,true);assert.equal(record.historical,true);assert.equal(Object.hasOwn(record,'accepted'),false);
 assert.deepEqual(await validateEvaluationObservation(record),record);
 const [later]=await normalizeEvaluationSummary(upload,{...context,observedAt:'2026-10-19T01:00:00Z'});assert.equal(later.id,record.id);assert.equal(later.outcomeHash,record.outcomeHash);
 const changed={...upload,runs:upload.runs.map(row=>({...row,sourceInputSha256:'b'.repeat(64)}))};const [correction]=await normalizeEvaluationSummary(changed,context);assert.notEqual(correction.id,record.id);assert.equal(correction.identityKey,record.identityKey);
});
test('objective summaries are closed, bounded and consistent with the explicitly retained original source status',async()=>{
 const base={...run(),status:'completed',sourceStatus:'passed',sourceInputSha256:'c'.repeat(64),objective:{assessable:true,passed:true,score:1,checksPassed:2,checksTotal:2}};
 for(const patch of [{sourceStatus:'failed'},{sourceStatus:'approved'},{sourceInputSha256:'not-a-digest'},{objective:{...base.objective,checksPassed:3}},{objective:{...base.objective,checksTotal:201}},{objective:{...base.objective,checksTotal:null}},{objective:{...base.objective,ready:true}},{objective:{...base.objective,assessable:false}}])await assert.rejects(normalizeEvaluationSummary(source([{...base,...patch}]),context));
 const [record]=await normalizeEvaluationSummary(source([base]),context);await assert.rejects(validateEvaluationObservation({...record,objective:{...record.objective!,passed:false}}));
});
