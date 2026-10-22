import {test,expect,type BrowserContext} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {fixtureOrigin,setFixtureSession} from '../e2e/helpers';
const profile={name:'controlled-mobile-network-and-cpu',latencyMilliseconds:150,downloadBytesPerSecond:200000,uploadBytesPerSecond:93750,cpuSlowdown:4};
if(process.env.CI)expect(process.env.CONTROL_ROOM_SOURCE_COMMIT).toMatch(/^[a-f0-9]{40}$/);
const percentile=(values:number[],fraction:number)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*fraction)-1)];
test('actual cold-page first usable and normal-navigation main-thread budgets',async({browser},info)=>{
 test.setTimeout(8*60*1000);
 expect(new URL(fixtureOrigin).hostname).toBe('127.0.0.1');
 const report:{source:string;scope:string;profile:typeof profile;samples:unknown[];budgets:Record<string,number>;limitations:string[];status:string}={source:process.env.CONTROL_ROOM_SOURCE_COMMIT??'local-source-not-recorded',scope:'isolated-built-worker-real-chromium',profile,samples:[],budgets:{firstUsableP95Milliseconds:3000,normalNavigationLongTaskMaximumMilliseconds:200},limitations:['Cold browser contexts and uncached page assets; local Worker process is already started. This does not measure a hosted Worker cold start.','CDP applies actual response latency, throughput and 4x CPU throttling. This is a controlled profile, not a physical phone or live mobile network.','Default small owner workspace. The separate real SQLite/D1 benchmark measures the near-bound metadata case.','First usable requires saved workspace status, the default Your projects heading and visible enabled Capture +. History may remain explicitly loading or unverified.','No provider, device, job execution or owner mutation is authorized.'],status:'running'};
 const usable:number[]=[],longTasks:number[]=[];
 try{
 for(let sample=0;sample<5;sample++){
  let context:BrowserContext|null=null;
  try{
   context=await browser.newContext({baseURL:fixtureOrigin,viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();
   await setFixtureSession(page,'a');
   const cdp=await context.newCDPSession(page);
   await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:profile.latencyMilliseconds,downloadThroughput:profile.downloadBytesPerSecond,uploadThroughput:profile.uploadBytesPerSecond,connectionType:'cellular3g'});
   await cdp.send('Emulation.setCPUThrottlingRate',{rate:profile.cpuSlowdown});
   let bytes=0,requests=0,ownerPosts=0;cdp.on('Network.loadingFinished',event=>{bytes+=event.encodedDataLength;});page.on('request',request=>{requests++;if(request.method()==='POST'&&['/api/workspace','/api/devices/enroll'].includes(new URL(request.url()).pathname))ownerPosts++;});
   await page.addInitScript(()=>{
    const value={longTasks:[] as {startTime:number;duration:number}[],supported:PerformanceObserver.supportedEntryTypes.includes('longtask'),firstUsableAt:null as number|null,savedStatusAt:null as number|null,captureEnabledAt:null as number|null,lanesVisibleAt:null as number|null};
    (window as unknown as {controlledPerformance:typeof value}).controlledPerformance=value;
    const ready=()=>{if(value.firstUsableAt!==null)return;const saved=Array.from(document.querySelectorAll<HTMLElement>('[role="status"]')).some(node=>/^Last saved /.test(node.textContent??'')&&node.getClientRects().length>0),lanes=Array.from(document.querySelectorAll<HTMLElement>('.project-lanes h1')).some(node=>node.textContent?.trim()==='Your projects'&&node.getClientRects().length>0),capture=Array.from(document.querySelectorAll<HTMLButtonElement>('.project-lanes button')).find(node=>node.textContent?.trim()==='Capture +'&&!node.disabled&&node.getClientRects().length>0);if(saved&&value.savedStatusAt===null)value.savedStatusAt=performance.now();if(capture&&value.captureEnabledAt===null)value.captureEnabledAt=performance.now();if(lanes&&value.lanesVisibleAt===null)value.lanesVisibleAt=performance.now();if(saved&&lanes&&capture)value.firstUsableAt=performance.now();};
    const observer=new MutationObserver(ready);observer.observe(document,{childList:true,subtree:true,attributes:true,characterData:true});document.addEventListener('DOMContentLoaded',ready,{once:true});
    if(value.supported)new PerformanceObserver(list=>{for(const item of list.getEntries())value.longTasks.push({startTime:item.startTime,duration:item.duration});}).observe({type:'longtask',buffered:true});
   });
   await page.goto('/',{waitUntil:'domcontentloaded'});
   await expect(page.getByRole('status').filter({hasText:/^Last saved /})).toBeVisible();
   await expect(page.getByRole('heading',{name:'Your projects',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Capture +',exact:true})).toBeEnabled();
   const firstUsable=await page.evaluate(()=>(window as unknown as {controlledPerformance:{firstUsableAt:number|null}}).controlledPerformance.firstUsableAt);expect(firstUsable).not.toBeNull();expect(firstUsable!).toBeGreaterThan(0);usable.push(firstUsable!);
   const initialDiagnostics=await page.evaluate(()=>{
    const value=(window as unknown as {controlledPerformance:{firstUsableAt:number|null;savedStatusAt:number|null;captureEnabledAt:number|null;lanesVisibleAt:number|null;longTasks:{startTime:number;duration:number}[]}}).controlledPerformance,ready=value.firstUsableAt!;
    const nav=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
    const phase=(start:number|undefined,end:number|undefined)=>start!==undefined&&end!==undefined&&end>0&&end>=start?end-start:null;
    const resources=performance.getEntriesByType('resource') as PerformanceResourceTiming[],completed=resources.filter(row=>row.responseEnd>0&&row.responseEnd<=ready),bounded=completed.slice(0,512);
    const categories:Record<string,{count:number;encodedBytes:number;transferBytes:number;durationSumMilliseconds:number;earliestStartMilliseconds:number;latestResponseEndMilliseconds:number}>={};
    for(const row of bounded){
     const path=new URL(row.name,location.href).pathname;
     const category=row.initiatorType==='script'?'script':row.initiatorType==='css'||path.endsWith('.css')?'stylesheet':path==='/api/workspace'?'workspace_api':path.startsWith('/api/')?'other_owner_api':row.initiatorType==='img'?'image':/\.(woff2?|ttf|otf)$/u.test(path)?'font':'other_resource';
     const item=categories[category]??={count:0,encodedBytes:0,transferBytes:0,durationSumMilliseconds:0,earliestStartMilliseconds:row.startTime,latestResponseEndMilliseconds:row.responseEnd};item.count++;item.encodedBytes+=row.encodedBodySize;item.transferBytes+=row.transferSize;item.durationSumMilliseconds+=row.duration;item.earliestStartMilliseconds=Math.min(item.earliestStartMilliseconds,row.startTime);item.latestResponseEndMilliseconds=Math.max(item.latestResponseEndMilliseconds,row.responseEnd);
    }
    const preReadyTasks=value.longTasks.filter(row=>row.startTime<ready);
    return {milestonesMilliseconds:{savedStatus:value.savedStatusAt,captureEnabled:value.captureEnabledAt,lanesVisible:value.lanesVisibleAt,firstUsable:ready},document:nav?{responseEndMilliseconds:nav.responseEnd,domInteractiveMilliseconds:nav.domInteractive,domContentLoadedEndMilliseconds:nav.domContentLoadedEventEnd||null,loadEndMilliseconds:nav.loadEventEnd||null,requestToFirstByteMilliseconds:phase(nav.requestStart,nav.responseStart),responseTransferMilliseconds:phase(nav.responseStart,nav.responseEnd),responseToDomInteractiveMilliseconds:phase(nav.responseEnd,nav.domInteractive),transferBytes:nav.transferSize,encodedBytes:nav.encodedBodySize}:null,completedBeforeReady:{count:completed.length,retainedCount:bounded.length,truncated:completed.length>512,categories},preReadyLongTasks:{count:preReadyTasks.length,sumMilliseconds:preReadyTasks.reduce((total,row)=>total+row.duration,0),maximumMilliseconds:preReadyTasks.length?Math.max(...preReadyTasks.map(row=>row.duration)):null,samples:preReadyTasks.slice(0,128),truncated:preReadyTasks.length>128}};
   });
   console.log(JSON.stringify({event:'controlled_initial_render',sample,profile,firstUsableMilliseconds:firstUsable,...initialDiagnostics}));
   const start=await page.evaluate(()=>performance.now()),navigation:Record<string,number>={};
   for(const [button,heading]of [['Agents','Agents'],['Runtime','Runtime'],['Sources','Context you can trace.'],['Today','Mission control'],['Project lanes','Your projects']]){
    const began=await page.evaluate(()=>performance.now());
    if(['Agents','Runtime','Sources'].includes(button)){const more=page.getByRole('navigation',{name:'Main navigation',exact:true}).locator('details');if(!await more.evaluate(node=>(node as HTMLDetailsElement).open))await more.locator('summary').tap();}
    await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:button,exact:true}).tap();
    await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
    navigation[button]=(await page.evaluate(()=>performance.now()))-began;
   }
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   const observed=await page.evaluate(from=>{const value=(window as unknown as {controlledPerformance:{supported:boolean;longTasks:{startTime:number;duration:number}[]}}).controlledPerformance;return {supported:value.supported,tasks:value.longTasks.filter(item=>item.startTime>=from),navigation:performance.getEntriesByType('navigation').map(item=>({duration:item.duration,transferSize:(item as PerformanceNavigationTiming).transferSize,encodedBodySize:(item as PerformanceNavigationTiming).encodedBodySize}))};},start);
   expect(observed.supported).toBe(true);expect(ownerPosts).toBe(0);
   const durations=observed.tasks.map(item=>item.duration);longTasks.push(...durations);
   report.samples.push({sample,firstUsableMilliseconds:firstUsable,initialDiagnostics,normalNavigationMilliseconds:navigation,normalNavigationLongTasks:observed.tasks,network:{requests,encodedTransferBytes:bytes,profileApplied:true},navigationTiming:observed.navigation,ownerMutationPosts:ownerPosts});
  }finally{await context?.close();}
 }
 const p50=percentile(usable,.5),p95=percentile(usable,.95),maximum=longTasks.length?Math.max(...longTasks):null;
 Object.assign(report,{firstUsable:{samples:usable,p50Milliseconds:p50,p95Milliseconds:p95},normalNavigationLongTasks:{count:longTasks.length,maximumMilliseconds:maximum,noneObserved:longTasks.length===0}});
 expect(p95,'Actual controlled mobile first usable p95').toBeLessThanOrEqual(3000);
 if(maximum!==null)expect(maximum,'Actual normal-navigation main-thread task maximum').toBeLessThanOrEqual(200);
 report.status='passed';
 }catch(error){report.status='failed';throw error;}
 finally{await mkdir('benchmark-results',{recursive:true});const body=JSON.stringify(report,null,2);await writeFile('benchmark-results/browser.json',body+'\n');await info.attach('controlled-browser-performance',{body,contentType:'application/json'});}
});

test('twenty real isolated cookie sessions retain same-owner CAS and owner isolation',async({browser},info)=>{
 test.setTimeout(5*60*1000);
 const contexts:BrowserContext[]=[],sessions:{page:import('@playwright/test').Page;owner:'a'|'b';input:{revision:number;mutationId:string;command:{type:string;id:string;patch:{body:string}}}}[]=[];
 const latencies:number[]=[];
 const concurrencyReport:Record<string,unknown>={source:process.env.CONTROL_ROOM_SOURCE_COMMIT??'local-source-not-recorded',scope:'twenty-actual-isolated-cookie-contexts',status:'running',sessions:20,responses:[] as unknown[],samplesMilliseconds:latencies};
 try{
  for(let index=0;index<20;index++){
   const context=await browser.newContext({baseURL:fixtureOrigin});contexts.push(context);const page=await context.newPage(),owner=index<10?'a':'b';
   await setFixtureSession(page,owner);
   let beforeResponse=await page.request.get('/api/workspace');expect(beforeResponse.status()).toBe(200);let before=await beforeResponse.json();
   if(index===0||index===10){
    const seedIdResponse=await page.request.post('/api/workspace/mutation-ids',{headers:{Origin:fixtureOrigin,'Content-Type':'application/json'},data:{}});expect(seedIdResponse.status()).toBe(200);const seedId=await seedIdResponse.json();
    const seedResponse=await page.request.post('/api/workspace',{headers:{Origin:fixtureOrigin,'Content-Type':'application/json'},data:{revision:before.revision,mutationId:seedId.mutationId,command:{type:'capture.create',capture:{title:'Synthetic concurrency fixture '+owner,body:'Explicit setup outside timed wave.',projectId:null,kind:'idea',sourceUrl:null}}}});expect(seedResponse.status()).toBe(200);
    beforeResponse=await page.request.get('/api/workspace');expect(beforeResponse.status()).toBe(200);before=await beforeResponse.json();
   }
   const capture=before.workspace.captures.find((row:{title:string})=>row.title==='Synthetic concurrency fixture '+owner);expect(capture).toBeDefined();
   const idResponse=await page.request.post('/api/workspace/mutation-ids',{headers:{Origin:fixtureOrigin,'Content-Type':'application/json'},data:{}});expect(idResponse.status()).toBe(200);const issued=await idResponse.json();expect(issued.mutationId).toMatch(/^m1_[a-f0-9]{32}_[a-f0-9]{32}$/);
   sessions.push({page,owner,input:{revision:before.revision,mutationId:issued.mutationId,command:{type:'capture.update',id:capture.id,patch:{body:'Synthetic concurrent cookie session '+owner+' '+index}}}});
  }
  const waveStart=performance.now();
  const results=await Promise.all(sessions.map(async(session,index)=>{const start=performance.now();const response=await session.page.request.post('/api/workspace',{headers:{Origin:fixtureOrigin,'Content-Type':'application/json'},data:session.input});const text=await response.text(),elapsed=performance.now()-start;expect(elapsed).toBeGreaterThan(0);latencies.push(elapsed);const diagnostic={session:index,status:response.status(),contentType:response.headers()['content-type']??null,responseBytes:new TextEncoder().encode(text).byteLength,elapsedMilliseconds:elapsed};(concurrencyReport.responses as unknown[]).push(diagnostic);console.log(JSON.stringify({event:'controlled_concurrent_response',...diagnostic}));let body:unknown=null,jsonValid=true;try{body=JSON.parse(text);}catch{jsonValid=false;}return {status:response.status(),body,jsonValid};}));
  expect(results.every(row=>row.jsonValid),'Every concurrent response must contain valid JSON; sanitized per-session diagnostics are attached.').toBe(true);
  Object.assign(concurrencyReport,{httpStatuses:results.map(row=>row.status),p50Milliseconds:percentile(latencies,.5),p95Milliseconds:percentile(latencies,.95)});
  expect(results.filter(row=>row.status===200)).toHaveLength(2);expect(results.filter(row=>row.status===409)).toHaveLength(18);
  for(const owner of ['a','b'] as const){
   const indices=sessions.flatMap((session,index)=>session.owner===owner?[index]:[]),winner=indices.find(index=>results[index].status===200);expect(winner).toBeDefined();
   const session=sessions[winner!],currentResponse=await session.page.request.get('/api/workspace'),current=await currentResponse.json();
   expect(current.revision).toBe(session.input.revision+1);expect(current.workspace.captures.find((row:{id:string})=>row.id===session.input.command.id).body).toBe(session.input.command.patch.body);
   expect(current.workspace.captures.some((row:{body:string})=>row.body.startsWith('Synthetic concurrent cookie session '+(owner==='a'?'b':'a')+' '))).toBe(false);
   const replay=await session.page.request.post('/api/workspace',{headers:{Origin:fixtureOrigin,'Content-Type':'application/json'},data:session.input});expect(replay.status()).toBe(200);
   expect((await (await session.page.request.get('/api/workspace')).json()).revision).toBe(current.revision);
   for(const index of indices){const outcome=await sessions[index].page.request.get('/api/workspace/mutations/'+encodeURIComponent(sessions[index].input.mutationId));expect(outcome.status()).toBe(200);const value=await outcome.json();expect(value.status).toBe(index===winner?'committed':'not-found');}
  }
  const report={source:process.env.CONTROL_ROOM_SOURCE_COMMIT??'local-source-not-recorded',scope:'twenty-actual-Chromium-context-cookie-jars-and-built-worker-D1',sessions:20,owners:2,sameRevisionContendersPerOwner:10,commits:2,revisionConflicts:18,originalReplayAdditionalRevisions:0,samplesMilliseconds:latencies,p50Milliseconds:percentile(latencies,.5),p95Milliseconds:percentile(latencies,.95),waveMilliseconds:performance.now()-waveStart,budgetP95Milliseconds:2000,networkProfile:'unthrottled loopback; separate first-usable test applies CDP mobile profile',limitations:['Two synthetic authenticated owners; no production identity or hosted network claim.','Actual HTTP central capture commands, receipts and D1 CAS; no job delivery or provider/executor throughput claim.']};
  Object.assign(concurrencyReport,report);
  expect(report.p95Milliseconds,'Actual twenty-session HTTP save p95').toBeLessThanOrEqual(2000);
 concurrencyReport.status='passed';
 }catch(error){concurrencyReport.status='failed';throw error;}
 finally{await mkdir('benchmark-results',{recursive:true});const body=JSON.stringify(concurrencyReport,null,2);await writeFile('benchmark-results/browser-concurrency.json',body+'\n');await info.attach('twenty-real-cookie-sessions',{body,contentType:'application/json'});await Promise.all(contexts.map(context=>context.close()));}
});
