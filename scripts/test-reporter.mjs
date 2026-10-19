import {inspect} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readdirSync} from 'node:fs';
// Diagnostics expose only static repository test basenames, never event paths.
const diagnosticFiles=new Set(readdirSync(new URL('../tests/',import.meta.url)).filter(name=>/^[A-Za-z0-9_.-]+\.test\.[cm]?[jt]s$/.test(name)));
diagnosticFiles.add('synthetic-reporter-slow.test.mjs');
function diagnosticFile(data){const raw=data.entryFile??data.file??data.name;if(typeof raw!=='string')return null;const name=raw.replaceAll('\\','/').split('/').at(-1);return diagnosticFiles.has(name)?name:null;}
// Native Node 24 event contract: https://nodejs.org/download/release/v24.21.0/docs/api/test.html
const DETAIL_LIMIT=12288;
function short(value,limit=1000){const text=typeof value==='string'?value:String(value??'');return text.length<=limit?text:text.slice(0,limit)+'[truncated]';}
function snapshot(value,depth=0,seen=new WeakSet(),budget={nodes:200}){
 if(--budget.nodes<0)return '[inspection bound]';
 if(value===null||typeof value==='number'||typeof value==='boolean')return value;
 if(typeof value==='string')return short(value,4096);
 if(typeof value!=='object')return short(typeof value==='undefined'?'[undefined]':typeof value);
 if(seen.has(value))return '[circular]';if(depth>5)return '[depth bound]';seen.add(value);
 const output={},preferred=['name','message','code','failureType','operator','actual','expected','stack','cause','errors'];
 const keys=[...new Set([...preferred,...Reflect.ownKeys(value).filter(key=>typeof key==='string').slice(0,20)])];
 for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor)continue;output[short(key,160)]='value'in descriptor?snapshot(descriptor.value,depth+1,seen,budget):'[accessor omitted]';}
 return output;
}
function errorDetails(error){
 try{return short(inspect(snapshot(error),{depth:7,colors:false,customInspect:false,getters:false,maxArrayLength:20,maxStringLength:4096,breakLength:120,compact:false}),DETAIL_LIMIT);}
 catch{return '[bounded error inspection unavailable]';}
}
function identity(data){return JSON.stringify([data.entryFile??data.file??'',data.testId??null,data.testId===undefined?data.line??null:null,data.testId===undefined?data.column??null:null,data.name??'',data.nesting??0]);}
function failure(data,stderr=''){
 const disposition=data.todo?'TEST TODO FAILURE':'TEST FAIL';
 return disposition+' '+JSON.stringify(short(data.name))+' '+JSON.stringify(short(data.file??data.entryFile??'<unknown>',1000))+':'+(data.line??'?')+':'+(data.column??'?')+'\n'+errorDetails(data.details?.error)+'\n'+(stderr?'TEST STDERR '+JSON.stringify(short(stderr,8192))+'\n':'');
}
/** Presentation only. Never changes scheduling, assertions, runner options or exit status. */
export default async function* reporter(events){
 let completed=0,failed=0;const displayed=new Set(),stderr=new Map(),active=new Set(),cases=new Map();
 const heartbeat=setInterval(()=>{if(active.size){const files=[...active].sort().slice(0,128);process.stdout.write('TEST FILE ACTIVE '+JSON.stringify(files)+'\n');process.stdout.write('TEST FILE PENDING '+JSON.stringify(files.map(file=>{const state=cases.get(file);return {file,dequeued:state?.dequeued??0,completed:state?.completed??0,pending:[...(state?.pending.values()??[])].slice(0,8),untracked:state?.overflow??0,pendingCount:(state?.pending.size??0)+(state?.overflow??0)};}))+'\n');}},15000);heartbeat.unref();
 try{for await(const event of events){
  const data=event.data??{},file=data.entryFile??data.file??'<unknown>',known=diagnosticFile(data);
  if(known&&(event.type==='test:dequeue'||event.type==='test:complete')&&Number.isSafeInteger(data.line)&&data.line>0&&data.line<=10000000&&Number.isSafeInteger(data.column)&&data.column>0&&data.column<=10000000){
   let state=cases.get(known);if(!state){state={dequeued:0,completed:0,pending:new Map(),overflow:0};cases.set(known,state);}
   const key=JSON.stringify([known,data.line,data.column,data.nesting??0,short(data.name,1000)]);if(event.type==='test:dequeue'){if(!state.pending.has(key)){state.dequeued++;if(state.pending.size<1024)state.pending.set(key,{line:data.line,column:data.column});else state.overflow++;}}else if(state.pending.delete(key))state.completed++;else if(state.overflow>0){state.overflow--;state.completed++;}
  }
  if(event.type==='test:dequeue'&&known&&!active.has(known)){active.add(known);yield 'TEST FILE START '+JSON.stringify(known)+'\n';}
  if((event.type==='test:summary'||event.type==='test:complete'&&data.nesting===0&&diagnosticFile({name:data.name})===known)&&known&&active.delete(known)){cases.delete(known);yield 'TEST FILE DONE '+JSON.stringify(known)+'\n';}
  if(event.type==='test:stderr'){if(!stderr.has(file)&&stderr.size>=128)stderr.delete(stderr.keys().next().value);stderr.set(file,(stderr.get(file)??'').concat(short(data.message,8192)).slice(-8192));}
  // test:complete is execution-ordered; test:fail may wait behind an earlier
  // long-running sibling. De-duplicate its later declaration-ordered twin.
  if(event.type==='test:complete'&&data.details?.passed===false){const key=identity(data);if(!displayed.has(key)){displayed.add(key);yield failure(data,stderr.get(file));}}
  if(event.type==='test:pass'||event.type==='test:fail'){
   completed++;if(event.type==='test:fail'){if(!data.todo)failed++;const key=identity(data);if(!displayed.has(key)){displayed.add(key);yield failure(data,stderr.get(file));}}
   if(completed%100===0)yield 'TEST PROGRESS '+JSON.stringify({results:completed,failedResults:failed})+'\n';
  }
  if(event.type==='test:summary'&&data.file===undefined)yield 'TEST SUMMARY '+JSON.stringify({counts:data.counts,duration_ms:data.duration_ms,success:data.success})+'\n';
 }}finally{clearInterval(heartbeat);}
}
async function selfTest(){
 const assert=(await import('node:assert/strict')).default,{mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileURLToPath}=await import('node:url'),{spawn}=await import('node:child_process');
 assert.equal(Number(process.versions.node.split('.')[0]),24,'Run this native reporter check with Node 24.');
 const directory=await mkdtemp(join(tmpdir(),'synthetic-node-reporter-')),reporterFile=fileURLToPath(import.meta.url);
 async function execute(file){
  const child=spawn(process.execPath,['--test','--test-reporter='+reporterFile,file],{stdio:['ignore','pipe','pipe'],shell:false});let output='',stderr='',liveFailure=false,timer;
  child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>1000000)child.kill();if(output.includes('TEST FAIL')&&!output.includes('TEST SUMMARY')&&child.exitCode===null)liveFailure=true;});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>1000000)child.kill();});
  try{const code=await new Promise((resolve,reject)=>{timer=setTimeout(()=>{child.kill();reject(new Error('Synthetic reporter subprocess did not settle.'));},25000);child.once('error',reject);child.once('close',resolve);});return {code,output,stderr,liveFailure};}finally{clearTimeout(timer);}
 }
 try{
  const failing=join(directory,'failure.test.mjs'),passing=join(directory,'pass.test.mjs'),broken=join(directory,'bootstrap.test.mjs');
  await writeFile(failing,"import test from 'node:test';import assert from 'node:assert/strict';\ntest('synthetic parent',async t=>{await t.test('synthetic nested assertion',()=>assert.equal('actual-synthetic','expected-synthetic'));await t.test('synthetic nested cause',()=>{throw new Error('synthetic wrapper',{cause:new Error('synthetic inner cause')});});});\ntest('synthetic late sibling',async()=>{await new Promise(resolve=>setTimeout(resolve,150));});\n");
  await writeFile(passing,"import test from 'node:test';\nfor(let index=0;index<101;index++)test('synthetic pass '+index,()=>{});\ntest('synthetic skipped',{skip:true},()=>{});test('synthetic todo',{todo:true},()=>{throw new Error('synthetic expected failure');});\n");
  await writeFile(broken,"import './synthetic-missing-module.mjs';\n");
  const failed=await execute(failing);assert.equal(failed.code,1);assert.equal(failed.liveFailure,true);assert.match(failed.output,/actual-synthetic/);assert.match(failed.output,/expected-synthetic/);assert.match(failed.output,/synthetic inner cause/);assert.match(failed.output,/TEST SUMMARY/);
  assert.equal(failed.output.split('\n').filter(line=>line.startsWith('TEST FAIL "synthetic nested assertion"')).length,1,'Immediate and ordered twins must not duplicate a failure.');
  const passed=await execute(passing);assert.equal(passed.code,0);assert.match(passed.output,/TEST PROGRESS/);assert.match(passed.output,/"skipped":1/);assert.match(passed.output,/"todo":1/);
  const slow=join(directory,'synthetic-reporter-slow.test.mjs');
  await writeFile(slow,"import test from 'node:test';\ntest('synthetic immediate file',()=>{});\ntest('synthetic slow file',async()=>{await new Promise(resolve=>setTimeout(resolve,15200));});\n");
  const delayed=await execute(slow);assert.equal(delayed.code,0);assert.match(delayed.output,/TEST FILE START \"synthetic-reporter-slow.test.mjs\"/);assert.match(delayed.output,/TEST FILE ACTIVE \["synthetic-reporter-slow.test.mjs"\]/);assert.match(delayed.output,/TEST FILE DONE \"synthetic-reporter-slow.test.mjs\"/);assert.match(delayed.output,/TEST FILE PENDING .*"file":"synthetic-reporter-slow.test.mjs","dequeued":2,"completed":1,"pending":\[\{"line":3,"column":1\}\],"untracked":0,"pendingCount":1/);assert.match(delayed.output,/TEST SUMMARY/);assert.equal(delayed.output.includes(directory),false,'file diagnostics never expose absolute paths');
  const bootstrap=await execute(broken);assert.equal(bootstrap.code,1);assert.match(bootstrap.output,/synthetic-missing-module/);assert.match(bootstrap.output,/TEST STDERR/);
  async function* bounded(){yield {type:'test:fail',data:{name:'synthetic bound',details:{error:new Error('x'.repeat(100000),{cause:new Error('synthetic cause')})}}};}
  let rendered='';for await(const part of reporter(bounded()))rendered+=part;assert.ok(rendered.length<DETAIL_LIMIT+3000);
  process.stdout.write('PASS native Node 24 reporter: immediate nested causes, bounded errors, unchanged failed/pass/skip/todo exit behavior and progress/summary.\n');
 }finally{await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3||process.argv[2]!=='--self-test')throw new Error('Use --self-test for the isolated reporter fixture.');
 await selfTest();
}
