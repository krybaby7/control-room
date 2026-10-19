import {spawnSync} from 'node:child_process';
import {cliUnitChildArguments} from './fixtures/cli-unit-child.mjs';
import {canonicalMkdtemp as mkdtemp} from './fixtures/private-state.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {runBridgeOnce,main,readMaskedSecret,doctorBridge,nodeVersionStatus,requireSupportedNode} from '../src/cli.mjs';
/** Preserve the same functional assertions in a child with an explicit unit-only
 * Windows guard loader; Linux exercises the actual no-op platform boundary. */
function runWindowsCliUnitCase(name){
 if(process.platform!=='win32'||process.env.CONTROL_ROOM_UNIT_CLI_STATE==='synthetic-only')return false;
 const pattern='^'+name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')+'$';
 const unitEnvironment={...process.env,CONTROL_ROOM_UNIT_CLI_STATE:'synthetic-only'};delete unitEnvironment.NODE_TEST_CONTEXT;
 const child=spawnSync(process.execPath,cliUnitChildArguments(import.meta.url,pattern),{env:unitEnvironment,encoding:'utf8',timeout:30000,maxBuffer:65536});
 assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(child.error,undefined);return true;
}
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
const stamp='2026-10-18T12:00:00.000Z',session={deviceId:'device',bootId:'boot',generation:2},config={deviceId:'device',bridgeVersion:'0.1.0',pcCommandCenter:{enabled:true,instanceId:'pc',selectedGpuId:null,selectedGpuAlias:null}};
function window(){return {windowId:'synthetic-window',bootId:'boot',generation:2,sequence:1,issuedAt:stamp,expiresAt:'2026-10-18T12:00:30.000Z'};}
function receipt(heartbeat,classification='live'){return {bootId:heartbeat.bootId,generation:heartbeat.generation,sequence:heartbeat.sequence,heartbeatHash:createHash('sha256').update(canonical(heartbeat)).digest('hex'),classification};}
test('window precedes actual sample and confirmed fresh receipt precedes unchanged historical spool',async()=>{
  const events=[],old={schemaVersion:1,deviceId:'device',bootId:'old-boot',generation:1,sequence:9,sentAt:'2026-10-17T00:00:00.000Z',bridgeVersion:'0.1.0',observations:[]};
  const outbox={
    async enqueue(item){events.push('persist');assert.equal(item.heartbeatBytes,canonical(JSON.parse(item.heartbeatBytes)));assert.equal(JSON.parse(item.heartbeatBytes).sequence,1);return {id:'new'};},
    async ack(id,options){events.push('ack-'+id);assert.equal(options.classification,id==='new'?'live':'history');},
    async pending(){events.push('pending');return [{id:'old',heartbeatBytes:canonical(old),liveWindowId:'old-window'}];}
  };
  const transport={async liveWindow(body){events.push('window');assert.deepEqual(body,{bootId:'boot',generation:2,sequence:1});return window();},async heartbeat(envelope){events.push(envelope.delivery);if(envelope.delivery==='history'){assert.deepEqual(envelope.heartbeat,old);assert.equal(canonical(envelope.heartbeat),canonical(old),'historical retry keeps exact canonical payload bytes');assert.equal(envelope.liveWindowId,null,'history never carries a live window or promotes a queued payload');assert.equal(receipt(envelope.heartbeat,'history').heartbeatHash,createHash('sha256').update(canonical(old)).digest('hex'));}return receipt(envelope.heartbeat,envelope.delivery);}};
  await runBridgeOnce({config,session,sequence:1,outbox,transport,now:()=>stamp,sample:async()=>{events.push('sample');return {source:'pc-command-center'};}});
  assert.deepEqual(events,['window','sample','persist','live','ack-new','pending','history','ack-old']);
});
test('network uncertainty and forged content hash preserve persisted item without draining history',async()=>{
  for(const failure of ['network','hash']){
    let drained=false,persisted=false,acked=false;
    const transport={async liveWindow(){return window();},async heartbeat(envelope){if(failure==='network')throw new Error('uncertain');return {...receipt(envelope.heartbeat),heartbeatHash:'a'.repeat(64)};}};
    await assert.rejects(runBridgeOnce({config,session,sequence:1,transport,now:()=>stamp,sample:async()=>({}),outbox:{async enqueue(){persisted=true;return {id:'new'};},async ack(){acked=true;},async pending(){drained=true;return [];}}}));
    assert.equal(persisted,true);assert.equal(acked,false);assert.equal(drained,false);
  }
});
test('an expired live window delivered as history never unlocks old spool',async()=>{
  let drained=false;
  await runBridgeOnce({config,session,sequence:1,now:()=>stamp,sample:async()=>({}),transport:{async liveWindow(){return window();},async heartbeat(envelope){return receipt(envelope.heartbeat,'history');}},outbox:{async enqueue(){return {id:'new'};},async ack(id,{classification}){assert.equal(classification,'history');},async pending(){drained=true;return [];}}});
  assert.equal(drained,false);
});
test('invalid window stops before collecting hardware or writing an outbox',async()=>{
  let sampled=false;
  await assert.rejects(runBridgeOnce({config,session,sequence:1,now:()=>stamp,sample:async()=>{sampled=true;},transport:{async liveWindow(){return {...window(),sequence:0};}},outbox:{}}),/Live window/);
  assert.equal(sampled,false);
});
test('masked one-use prompt restores terminal state and never echoes the secret',async()=>{
  const input=new EventEmitter(),output=[];input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};input.resume=()=>{};input.pause=()=>{};
  const promise=readMaskedSecret(input,{write:value=>output.push(value)});input.emit('data',Buffer.from('synthetic-one-use\r'));
  assert.equal(await promise,'synthetic-one-use');assert.equal(input.isRaw,false);assert.equal(output.join('').includes('synthetic-one-use'),false);
});
test('CLI rejects arbitrary commands, secret argv, and relative config before platform access',async()=>{
  for(const args of [['enroll','--secret','never-argv'],['shell','anything'],['run','--config','relative.json'],['run','--config','/synthetic.json','--token','never-argv']])await assert.rejects(main(args));
});

test('actual configured run-once uses a dedicated SQLite outbox and only closed cloud requests',async()=>{
 if(runWindowsCliUnitCase('actual configured run-once uses a dedicated SQLite outbox and only closed cloud requests'))return;
  const {writeFile,mkdir,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{DEFAULT_CONFIG}=await import('../src/config.mjs');
  const directory=await mkdtemp(join(tmpdir(),'synthetic-bridge-cli-')),path=join(directory,'config.json'),requests=[];
  const active={...structuredClone(DEFAULT_CONFIG),cloudBaseUrl:'https://private.example',pcCommandCenter:{enabled:true,instanceId:'synthetic-pc',selectedGpuId:null,selectedGpuAlias:null}};
  try{
    await writeFile(path,JSON.stringify(active));await mkdir(join(directory,'.control-room-bridge'));await writeFile(join(directory,'.control-room-bridge','credentials.dpapi'),'synthetic-ciphertext');
    const credential={deviceId:'synthetic-device',credentialId:'synthetic-credential',deviceCredential:'synthetic-secret',expiresAt:'2099-01-01T00:00:00Z'};
    const ingressAdapter={async getHeaders(){return {headers:{'x-synthetic-private':'synthetic'},expiresAt:'2099-01-01T00:00:00Z'};}};
    await main(['run','--once','--config',path],{
      credentialStore:{async load(){return credential;}},ingressAdapter,now:()=>stamp,
      sample:async()=>({source:'pc-command-center',instanceId:'synthetic-pc',observedAt:null,reportedAgeSeconds:null,state:'unavailable',diagnostic:'source_unreachable',metrics:null}),
      transportOptions:{now:()=>Date.parse(stamp),fetchImpl:async(url,options)=>{
        const body=JSON.parse(options.body);requests.push({path:new URL(url).pathname,body});
        if(url.endsWith('/session'))return Response.json({deviceId:credential.deviceId,bootId:body.bootId,generation:1,bridgeVersion:'0.1.0',createdAt:stamp});
        if(url.endsWith('/live-window'))return Response.json({windowId:'synthetic-window',...body,issuedAt:stamp,expiresAt:'2026-10-18T12:00:30.000Z'});
        if(url.endsWith('/heartbeat'))return Response.json(receipt(body.heartbeat));
        throw new Error('Unexpected endpoint');
      }}
    });
    assert.deepEqual(requests.map(request=>request.path),['/api/bridge/session','/api/bridge/live-window','/api/bridge/heartbeat']);
    assert.deepEqual(Object.keys(requests[0].body).sort(),['bootId','bridgeVersion']);
    assert.deepEqual(Object.keys(requests[1].body).sort(),['bootId','generation','sequence']);
    assert.equal(requests[2].body.heartbeat.observations[0].metrics,null);
    const {Outbox}=await import('../src/outbox.mjs'),outbox=await Outbox.open({directory:join(directory,'.control-room-bridge','outbox')});
    try{assert.equal((await outbox.status()).records,0);}finally{await outbox.close();}
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('enrollment secret is received only through prompt dependency and never printed or saved as configuration',async()=>{
 if(runWindowsCliUnitCase('enrollment secret is received only through prompt dependency and never printed or saved as configuration'))return;
  const {writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{DEFAULT_CONFIG}=await import('../src/config.mjs');
  const directory=await mkdtemp(join(tmpdir(),'synthetic-bridge-enroll-')),path=join(directory,'config.json'),printed=[],saved=[];
  const config={...structuredClone(DEFAULT_CONFIG),cloudBaseUrl:'https://private.example'};
  try{
    await writeFile(path,JSON.stringify(config));
    await main(['enroll','--config',path],{readSecret:async()=>'synthetic-one-use',print:value=>printed.push(value),credentialStore:{async save(value){saved.push(value);}},ingressAdapter:{async getHeaders(){return {headers:{'x-synthetic':'fixture'},expiresAt:'2099-01-01T00:00:00Z'};}},transportOptions:{fetchImpl:async(url,options)=>{
      assert.equal(new URL(url).pathname,'/api/bridge/enroll');assert.deepEqual(JSON.parse(options.body),{secret:'synthetic-one-use',bridgeVersion:config.bridgeVersion});
      return Response.json({deviceId:'synthetic-device',credentialId:'synthetic-credential',deviceCredential:'synthetic-device-secret',expiresAt:'2099-01-01T00:00:00Z'});
    }}});
    assert.equal(saved.length,1);assert.equal(Object.hasOwn(saved[0],'secret'),false);assert.equal(printed.join('').includes('synthetic-one-use'),false);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),config);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('cross-device retained history is not sent or deleted and cannot hide current-device history',async()=>{
  const foreign={schemaVersion:1,deviceId:'previous-device',bootId:'foreign-boot',generation:1,sequence:4,sentAt:stamp,bridgeVersion:'0.1.0',observations:[]};
  const current={...foreign,deviceId:'device',bootId:'current-old-boot',sequence:8};
  const delivered=[],acked=[];
  const foreignRows=Array.from({length:238},(_,i)=>({id:'foreign-'+i,heartbeatBytes:canonical({...foreign,sequence:i+1}),liveWindowId:null}));
  const transport={async liveWindow(){return window();},async heartbeat(envelope){delivered.push(envelope);return receipt(envelope.heartbeat,envelope.delivery);}};
  const outbox={async enqueue(){return {id:'new'};},async ack(id){acked.push(id);},async pending({limit}){assert.equal(limit,240);return [...foreignRows,{id:'current-old',heartbeatBytes:canonical(current),liveWindowId:null}];}};
  await runBridgeOnce({config,session,sequence:1,transport,outbox,now:()=>stamp,sample:async()=>({})});
  assert.equal(delivered.length,2);assert.equal(delivered[0].delivery,'live');assert.equal(delivered[1].heartbeat.deviceId,'device');assert.equal(delivered[1].heartbeat.bootId,'current-old-boot');assert.deepEqual(acked,['new','current-old']);
});

test('CLI forwards explicit local GPU selection and uploads only its owner alias',async()=>{
 const active={...config,pcCommandCenter:{enabled:true,instanceId:'pc',selectedGpuId:'raw-local-gpu-1',selectedGpuAlias:'owner-primary'}};
 let uploaded;
 await runBridgeOnce({config:active,session,sequence:1,now:()=>stamp,sample:async selection=>{
  assert.equal(selection.selectedGpuId,'raw-local-gpu-1');assert.equal(selection.selectedGpuAlias,'owner-primary');
  return {source:'pc-command-center',instanceId:'pc',selectedGpuAlias:selection.selectedGpuAlias,observedAt:null,reportedAgeSeconds:null,state:'unavailable',diagnostic:'source_unreachable',metrics:null};
 },outbox:{async enqueue(){return {id:'new'};},async ack(){},async pending(){return [];}},transport:{async liveWindow(){return window();},async heartbeat(envelope){uploaded=envelope;return receipt(envelope.heartbeat);}}});
 assert.equal(uploaded.heartbeat.observations[0].selectedGpuAlias,'owner-primary');assert.equal(canonical(uploaded).includes('raw-local-gpu-1'),false);
});

test('doctor checks actual Node and produces a bounded redacted read-only report',async()=>{
 const {DEFAULT_CONFIG}=await import('../src/config.mjs');
 const active={...structuredClone(DEFAULT_CONFIG),cloudBaseUrl:'https://private.example',deviceId:'synthetic-device',pcCommandCenter:{enabled:true,instanceId:'pc-command-center',selectedGpuId:'raw-local-gpu',selectedGpuAlias:'owner-primary'}};
 let sampled=0,credentialReads=0,ingressReads=0;
 const report=await doctorBridge({config:active,now:()=>stamp,credentialStore:{async load(){credentialReads++;return {deviceId:'synthetic-device',credentialId:'synthetic-credential',deviceCredential:'private-device-secret',expiresAt:'2099-01-01T00:00:00Z'};}},ingressAdapter:{async getHeaders(context){ingressReads++;assert.equal(context.url,'https://private.example/api/bridge/heartbeat');assert.equal(context.method,'POST');assert.equal(context.signal.aborted,false);return {headers:{'x-synthetic-private':'private-ingress-secret'},expiresAt:'2099-01-01T00:00:00Z'};}},sample:async selection=>{
  sampled++;assert.equal(selection.selectedGpuId,'raw-local-gpu');assert.equal(selection.selectedGpuAlias,'owner-primary');return {source:'pc-command-center',state:'ready',diagnostic:'ok',metrics:{cpuPercent:73.2345},hostname:'private-host',prompt:'private-prompt'};
 }});
 assert.equal(report.node.status,'supported');assert.ok(report.node.major>=24);assert.doesNotThrow(()=>requireSupportedNode());assert.equal(nodeVersionStatus('22.1.0').status,'unsupported');assert.equal(nodeVersionStatus('untrusted').status,'unsupported');
 assert.equal(report.configuration.status,'valid');assert.equal(report.credential.status,'available');assert.deepEqual(report.collector,{status:'available',state:'ready',diagnostic:'ok'});assert.equal(report.privateIngress.status,'available');assert.equal(report.cloudTransport.status,'configured');assert.equal(report.cloudConnectionVerified,false);assert.equal(report.windowsAcceptanceVerified,false);
 assert.equal(sampled,1);assert.equal(credentialReads,1);assert.equal(ingressReads,1);
 for(const privateValue of ['private-device-secret','private-ingress-secret','raw-local-gpu','private-host','private-prompt','73.2345'])assert.equal(JSON.stringify(report).includes(privateValue),false);
});
test('doctor default ingress never calls cloud transport; invalid config is typed and never reveals file content',async()=>{
 if(runWindowsCliUnitCase('doctor default ingress never calls cloud transport; invalid config is typed and never reveals file content'))return;
 const {writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{DEFAULT_CONFIG}=await import('../src/config.mjs');
 const directory=await mkdtemp(join(tmpdir(),'synthetic-doctor-')),path=join(directory,'config.json'),printed=[];let reads=0,cloudCalls=0;
 try{
  await writeFile(path,JSON.stringify({...structuredClone(DEFAULT_CONFIG),cloudBaseUrl:'https://private.example'}));
  const dependencies={print:line=>printed.push(line),credentialStore:{async load(){reads++;return null;}},sample:async()=>{throw new Error('Disabled sample must not run');},transportOptions:{fetchImpl:async()=>{cloudCalls++;throw new Error('No cloud diagnostic mutation allowed');}}};
  const report=await main(['doctor','--config',path],dependencies);assert.equal(report.credential.reason,'missing');assert.equal(report.privateIngress.reason,'unsupported');assert.equal(report.collector.status,'disabled');assert.equal(cloudCalls,0);assert.equal(reads,1);
  await writeFile(path,'{"token":"private-invalid-config"');const invalid=await main(['doctor','--config',path],dependencies);assert.equal(invalid.configuration.reason,'invalid_or_unreadable');assert.equal(reads,1);assert.equal(cloudCalls,0);assert.equal(printed.join('').includes('private-invalid-config'),false);assert.equal(printed.join('').includes(directory),false);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('doctor reports missing, expired, mismatched and unsupported protected credentials without raw errors',async()=>{
 const {DEFAULT_CONFIG}=await import('../src/config.mjs'),base={...structuredClone(DEFAULT_CONFIG),cloudBaseUrl:'https://private.example',deviceId:'synthetic-device'};
 const cases=[
  [async()=>null,'missing'],
  [async()=>({deviceId:'synthetic-device',credentialId:'synthetic-credential',deviceCredential:'never-print',expiresAt:'2000-01-01T00:00:00Z'}),'expired_or_invalid'],
  [async()=>({deviceId:'other-device',credentialId:'synthetic-credential',deviceCredential:'never-print',expiresAt:'2099-01-01T00:00:00Z'}),'device_mismatch'],
  [async()=>{throw Object.assign(new Error('C:/private/never-print'),{code:'windows_current_user_protection_unavailable'});},'protection_unavailable']
 ];
 for(const [load,reason] of cases){const report=await doctorBridge({config:base,credentialStore:{load},sample:async()=>{throw new Error();},now:()=>stamp});assert.equal(report.credential.status,'unavailable');assert.equal(report.credential.reason,reason);assert.equal(JSON.stringify(report).includes('never-print'),false);}
 const invalid=await doctorBridge({config:{...base,pcCommandCenter:{...base.pcCommandCenter,url:'http://127.0.0.1:1'}},credentialStore:{async load(){throw new Error('Should not load');}},sample:async()=>{throw new Error('Should not sample');}});
 assert.equal(invalid.configuration.status,'unavailable');
});
test('doctor private ingress renewal is finite, aborts hung read and cannot claim cloud reachability',async()=>{
 const {DEFAULT_CONFIG}=await import('../src/config.mjs');let signal;
 const start=Date.now(),report=await doctorBridge({config:{...structuredClone(DEFAULT_CONFIG),cloudBaseUrl:'https://private.example'},credentialStore:{async load(){return null;}},ingressAdapter:{getHeaders(context){signal=context.signal;return new Promise(()=>{});}},now:()=>stamp});
 assert.equal(report.privateIngress.status,'unavailable');assert.equal(report.privateIngress.reason,'credentials_unavailable');assert.equal(signal.aborted,true);assert.ok(Date.now()-start<3500);assert.equal(report.cloudConnectionVerified,false);
});
