import test from 'node:test';
import assert from 'node:assert/strict';
import {withAnalysisSlot,runRepositoryAnalysis} from '../companion/analysis-run.mjs';
import {createProviderReadiness} from '../companion/provider-readiness.mjs';
import {analysisBundle} from '../companion/snapshot.mjs';
test('one process-wide slot rejects competing inference and releases after failure',async()=>{let release;const active=withAnalysisSlot(()=>new Promise(resolve=>{release=resolve;}));await assert.rejects(withAnalysisSlot(async()=>{}),/already active/);release();await active;await assert.rejects(withAnalysisSlot(async()=>{throw new Error('fixture');}),/fixture/);assert.equal(await withAnalysisSlot(async()=>42),42);});
test('readiness probes are bounded cached and never invoke analysis',async()=>{let codex=0,claude=0,now=0;const readiness=createProviderReadiness({now:()=>now,discoverCodex:async()=>{codex++;},discoverClaude:async()=>{claude++;throw new Error('fixture');},discoverPowerShell:async()=>{}});assert.deepEqual(await readiness(),{codex:{ready:true,detail:'ready'},claude:{ready:false,detail:'unavailable'}});await readiness();assert.equal(codex,1);assert.equal(claude,1);now=61000;await readiness();assert.equal(codex,2);});
test('runner rejects unknown provider before snapshot or chat access',async()=>{let reads=0;await assert.rejects(runRepositoryAnalysis({root:'unused',requestId:crypto.randomUUID(),provider:'unknown',source:'personal-pc-connector'},{snapshot:async()=>{reads++;}}));assert.equal(reads,0);});
const pack=()=>({root:'C:\\synthetic',key:'synthetic',name:'Fixture',head:'a'.repeat(40),dirty:true,sha256:'b'.repeat(64),entries:[{path:'main.js',content:'export const answer=1;',sha256:'c'.repeat(64),bytes:22,modified:true}],bytes:22,excludedFiles:0});
const content=()=>({summary:'Synthetic source.',architecture:[{name:'Module',description:'One constant.',paths:['main.js']}],findings:[{path:'main.js',line:1,sha256:'c'.repeat(64),claim:'Exports a constant.'}],suggestedTasks:[],limitations:[]});
test('both providers produce validated personal reports using one invocation and supplied snapshot only',async()=>{for(const provider of ['codex','claude']){let calls=0,chats=0;const report=await runRepositoryAnalysis({root:'C:\\synthetic',requestId:crypto.randomUUID(),provider},{snapshot:async()=>pack(),collectChats:async()=>{chats++;return undefined;},analyzers:{[provider]:async()=>{calls++;return {content:content(),observedModel:provider==='codex'?'gpt-6.1-sol':'claude-sonnet-4-6'};}}});assert.equal(calls,1);assert.equal(chats,1);assert.equal(report.run.source,'personal-pc-connector');assert.equal(report.run.requestedModel,provider==='codex'?'gpt-6.1-sol':'claude-code-default');}});
test('invalid citation fails without inference retry',async()=>{let calls=0;await assert.rejects(runRepositoryAnalysis({root:'C:\\synthetic',requestId:crypto.randomUUID(),provider:'codex'},{snapshot:async()=>pack(),collectChats:async()=>undefined,analyzers:{codex:async()=>{calls++;const value=content();value.findings[0].line=999;return {content:value};}}}),/citation/);assert.equal(calls,1);});

test('architecture can identify manifest paths without claiming their unshown contents were inspected',async()=>{
 const snapshot=pack();snapshot.entries=Array.from({length:24},(_,i)=>({path:`src/part-${String(i).padStart(2,'0')}.js`,content:'x'.repeat(12000),sha256:'c'.repeat(64),bytes:12000,modified:false}));snapshot.bytes=288000;
 const path=snapshot.entries.at(-1).path;assert.ok(!analysisBundle(snapshot).excerpts.some(row=>row.path===path));
 const value={...content(),architecture:[{name:'Inventory module',description:'A module listed in the supplied inventory.',paths:[path]}],findings:[]};
 const input={root:'C:\\synthetic',requestId:crypto.randomUUID(),provider:'claude'};
 const options={snapshot:async()=>snapshot,collectChats:async()=>undefined,analyzers:{claude:async()=>({content:value,observedModel:'claude-opus-5-5'})}};
 const report=await runRepositoryAnalysis(input,options);assert.equal(report.architecture[0].paths[0],path);assert.ok(report.limitations.some(text=>text.includes('inventory')));
 value.architecture[0].paths=['missing/file.js'];await assert.rejects(runRepositoryAnalysis({...input,requestId:crypto.randomUUID()},options),/architecture path/);
});
