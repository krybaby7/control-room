import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalExecutor} from '../executor/executor.mjs';
import {executorMain} from '../executor/cli.mjs';
test('production executor is disabled and never fabricates installation/process/model evidence',async()=>{
 const executor=createLocalExecutor();assert.equal(executor.enabled,false);assert.deepEqual(await executor.execute(),{status:'blocked',diagnostic:'not_installed',processStarted:false,processExitConfirmed:false,modelVerified:false});
 const probe=await executor.probeLocalExecution();assert.equal(probe.ready,false);assert.ok(probe.issues.includes('not_installed'));
});
test('executor CLI needs a separate explicit opt-in and still fails closed without reading local credentials/config',async()=>{
 for(const args of [[],['run'],['run','--config','/synthetic/missing'],['run','--enable-execution','--config','relative']]){const output=[];assert.equal(await executorMain(args,{write:text=>output.push(text)}),2);assert.equal(JSON.parse(output.join('')).diagnostic,'policy_blocked');}
 const path=process.platform==='win32'?'C:\\synthetic\\never-read.json':'/synthetic/never-read.json',output=[];assert.equal(await executorMain(['run','--enable-execution','--config',path],{write:text=>output.push(text)}),2);assert.equal(JSON.parse(output.join('')).diagnostic,'not_installed');assert.equal(output.join('').includes(path),false);
});
