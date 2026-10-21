import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonalConnector} from '../companion/personal-connector.mjs';
const config={siteOrigin:'https://adami-project-control-center.roundmoth32.chatgpt.site',siteServiceToken:'service-token',deviceKey:'device-key',deviceId:'device'};
const syntheticReport=id=>({format:'control-room-project-analysis',version:1,repository:{key:'fixture',name:'Fixture',head:'a'.repeat(40),dirty:false,snapshotSha256:'b'.repeat(64),files:1,bytes:1,includedChanges:true,excludedFiles:0},run:{id,provider:'codex',requestedModel:'gpt-6.1-sol',observedModel:null,startedAt:'2026-10-21T00:00:00.000Z',completedAt:'2026-10-21T00:00:01.000Z',mode:'read-only',source:'personal-pc-connector'},summary:'Synthetic report.',architecture:[],findings:[],suggestedTasks:[],limitations:[]});
test('browse cancellation delivered once; duplicate job never invokes picker again',async()=>{const dir=await mkdtemp(join(tmpdir(),'connector-'));let picks=0;const calls=[];const job={id:'11111111-1111-4111-8111-111111111111',kind:'browse',expiresAt:new Date(Date.now()+60000).toISOString()};try{const connector=await createPersonalConnector({config,stateDirectory:dir,picker:async()=>{picks++;return {status:'cancelled'};},fetch:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return new Response(JSON.stringify(JSON.parse(options.body).action==='poll'?{job}:{ok:true}));}});await connector.tick();await connector.tick();assert.equal(picks,1);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers.Authorization,'Bearer device-key');assert.equal(calls[0].options.headers['OAI-Sites-Authorization'],'Bearer service-token');assert.ok(calls.some(call=>call.body.action==='fail'));await connector.close();}finally{await rm(dir,{recursive:true,force:true});}});
test('unknown origin rejected before network',async()=>{await assert.rejects(createPersonalConnector({config:{...config,siteOrigin:'https://example.com'},stateDirectory:'unused'}));});
test('close waits for an in-flight poll and prevents its late claim from opening the picker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'connector-close-'));let picks=0,pollSignal,releasePoll,announcePoll;
 const pollStarted=new Promise(resolve=>{announcePoll=resolve;}),pollResponse=new Promise(resolve=>{releasePoll=resolve;});
 try{
  const connector=await createPersonalConnector({config,stateDirectory:dir,picker:async()=>{picks++;return {status:'cancelled'};},fetch:async(url,options)=>{
   if(JSON.parse(options.body).action!=='poll')return new Response(JSON.stringify({ok:true}));
   pollSignal=options.signal;announcePoll();return new Response(JSON.stringify(await pollResponse));
  }});
  const ticking=connector.tick();await pollStarted;let closed=false;const closing=connector.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false,'close must wait for the pending poll to settle');assert.equal(pollSignal.aborted,true,'close must abort the pending transport');
  releasePoll({job:{id:'44444444-4444-4444-8444-444444444444',kind:'browse',expiresAt:new Date(Date.now()+60000).toISOString()}});
  await Promise.allSettled([ticking,closing]);assert.equal(closed,true);assert.equal(picks,0);
 }finally{releasePoll?.({job:null});await rm(dir,{recursive:true,force:true});}
});
test('a conflict retains a completed report for delivery retry while polling continues',async()=>{
 const {writeFile,readFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'connector-conflict-'));
 const id='55555555-5555-4555-8555-555555555555',report={format:'control-room-project-analysis',version:1,repository:{key:'fixture',name:'Fixture',head:'a'.repeat(40),dirty:false,snapshotSha256:'b'.repeat(64),files:1,bytes:1,includedChanges:true,excludedFiles:0},run:{id,provider:'codex',requestedModel:'gpt-6.1-sol',observedModel:null,startedAt:'2026-10-21T00:00:00.000Z',completedAt:'2026-10-21T00:00:01.000Z',mode:'read-only',source:'personal-pc-connector'},summary:'Synthetic report.',architecture:[],findings:[],suggestedTasks:[],limitations:[]},delivery={action:'complete',requestId:id,report};let attempts=0,polls=0;
 try{
  await writeFile(join(dir,'personal-job-receipts.json'),JSON.stringify({[id]:{status:'terminal',delivery,delivered:false}}));
  const connector=await createPersonalConnector({config,stateDirectory:dir,fetch:async(url,options)=>{
   if(JSON.parse(options.body).action==='poll'){polls++;return new Response(JSON.stringify({job:null}));}
   attempts++;return attempts===1?new Response(JSON.stringify({error:'Personal PC state changed. Retry the same request.'}),{status:409}):new Response(JSON.stringify({ok:true}));
  }});
  await connector.tick();let saved=JSON.parse(await readFile(join(dir,'personal-job-receipts.json'),'utf8'));
  assert.equal(saved[id].delivered,false);assert.deepEqual(saved[id].delivery,delivery);assert.equal(polls,1);
  await connector.tick();await connector.close();saved=JSON.parse(await readFile(join(dir,'personal-job-receipts.json'),'utf8'));
  assert.equal(attempts,2);assert.equal(saved[id].delivered,true);assert.equal(polls,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('confirmed report delivery leaves a private backup and compact replay tombstone across restart',async()=>{
 const {writeFile,readFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'connector-compact-'));
 const id='66666666-6666-4666-8666-666666666666',report=syntheticReport(id),job={id,kind:'analyze',repositoryKey:report.repository.key,provider:'codex',requestedModel:'gpt-6.1-sol',expiresAt:new Date(Date.now()+60000).toISOString()};let calls=0,deliveries=0;
 try{
  const file=join(dir,'personal-job-receipts.json');await writeFile(file,JSON.stringify({[id]:{status:'terminal',job,delivery:{action:'complete',requestId:id,report},delivered:false}}));
  const options={config,stateDirectory:dir,analyze:async()=>{calls++;throw new Error('Replayed analysis must not run.');},fetch:async(url,options)=>{const body=JSON.parse(options.body);if(body.action==='poll')return new Response(JSON.stringify({job}));deliveries++;assert.deepEqual(body.report,report);return new Response(JSON.stringify({ok:true}));}};
  const first=await createPersonalConnector(options);await first.tick();await first.close();
  const receipts=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(receipts[id],{status:'terminal',delivered:true,repositoryKey:'fixture'});assert.ok(Buffer.byteLength(JSON.stringify(receipts))<200);
  const backup=JSON.parse(await readFile(join(dir,id+'.json'),'utf8'));assert.equal(backup.status,'completed');assert.deepEqual(backup.report,report);
  const second=await createPersonalConnector(options);await second.tick();await second.close();assert.equal(calls,0);assert.equal(deliveries,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('journal capacity is checked before writing an unreadable file or starting another request',async()=>{
 const {writeFile,readFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'connector-journal-bound-'));let picks=0;
 try{
  const rows={},limit=8*1024*1024;let bytes=2,index=0;
  for(;;){const id=(index++).toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000',row={status:'terminal',delivered:true},size=Buffer.byteLength(JSON.stringify({[id]:row}))-2+(index===1?0:1);if(bytes+size>limit-1000)break;rows[id]=row;bytes+=size;}
  const file=join(dir,'personal-job-receipts.json'),original=JSON.stringify(rows);await writeFile(file,original);
  const connector=await createPersonalConnector({config,stateDirectory:dir,picker:async()=>{picks++;return {status:'cancelled'};},fetch:async(url,options)=>new Response(JSON.stringify(JSON.parse(options.body).action==='poll'?{job:{id:'ffffffff-ffff-4fff-8fff-ffffffffffff',kind:'browse',expiresAt:new Date(Date.now()+60000).toISOString()}}:{ok:true}))});
  await assert.rejects(connector.tick(),/journal is full/);await connector.close();assert.equal(picks,0);assert.equal(await readFile(file,'utf8'),original);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('failed delivery is retried after restart without repeating picker',async()=>{const dir=await mkdtemp(join(tmpdir(),'connector-'));let picks=0,failDelivery=true;const job={id:'22222222-2222-4222-8222-222222222222',kind:'browse',expiresAt:new Date(Date.now()+60000).toISOString()};const options={config,stateDirectory:dir,picker:async()=>{picks++;return {status:'cancelled'};},fetch:async(url,options)=>{const body=JSON.parse(options.body);if(body.action==='fail'&&failDelivery)throw new Error('offline');return new Response(JSON.stringify(body.action==='poll'?{job}:{ok:true}));}};try{const first=await createPersonalConnector(options);await assert.rejects(first.tick());await first.close();failDelivery=false;const second=await createPersonalConnector(options);await second.tick();await second.close();assert.equal(picks,1);}finally{await rm(dir,{recursive:true,force:true});}});
test('restart fails an already persisted running receipt without invoking picker',async()=>{const {writeFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'connector-'));const id='33333333-3333-4333-8333-333333333333';let picks=0;const sent=[];try{await writeFile(join(dir,'personal-job-receipts.json'),JSON.stringify({[id]:{status:'running'}}));const connector=await createPersonalConnector({config,stateDirectory:dir,picker:async()=>{picks++;},fetch:async(url,options)=>{const body=JSON.parse(options.body);sent.push(body);return new Response(JSON.stringify(body.action==='poll'?{job:null}:{ok:true}));}});await connector.tick();await connector.close();assert.equal(picks,0);assert.ok(sent.some(row=>row.error==='interrupted'&&row.requestId===id));}finally{await rm(dir,{recursive:true,force:true});}});
test('encrypted configuration roundtrips through injected protection without plaintext disk',async()=>{const {savePersonalCredentials,loadPersonalCredentials}=await import('../companion/personal-credentials.mjs');const {readFile}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'credentials-'));try{await savePersonalCredentials(config,{stateDirectory:dir,secureDirectory:async()=>{},protect:async text=>Buffer.from(text).toString('base64')});assert.ok(!(await readFile(join(dir,'personal-connection.dat'),'utf8')).includes('service-token'));assert.deepEqual(await loadPersonalCredentials({stateDirectory:dir,unprotect:async text=>Buffer.from(text,'base64').toString()}),config);}finally{await rm(dir,{recursive:true,force:true});}});

test('poll includes pre-existing registered repository metadata without local paths',async()=>{const {execFileSync}=await import('node:child_process');const {writeFile,realpath}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'registry-'));const root=await realpath(await mkdtemp(join(tmpdir(),'registry-repo-')));try{execFileSync('git',['init',root],{stdio:'ignore'});await writeFile(join(root,'main.js'),'export const x=1;');execFileSync('git',['-C',root,'add','.']);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture'],{stdio:'ignore'});await writeFile(join(dir,'repositories.json'),JSON.stringify([root]));let body;const connector=await createPersonalConnector({config,stateDirectory:dir,fetch:async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({job:null}));}});await connector.tick();await connector.close();assert.equal(body.repositories.length,1);assert.equal(body.repositories[0].hasPreviousAnalysis,false);assert.equal(Object.hasOwn(body.repositories[0],'root'),false);assert.ok(!JSON.stringify(body).includes(root));}finally{await rm(dir,{recursive:true,force:true});await rm(root,{recursive:true,force:true});}});
