#!/usr/bin/env node
import {ensurePrivateWindowsState} from './windows-state.mjs';
import {isAbsolute,dirname,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createBridgeTransport,unavailablePrivateIngress,BridgeTransportError} from './transport.mjs';
import {createCredentialStore} from './credentials.mjs';
import {BRIDGE_LIMITS,validateConfig} from './config.mjs';
import {resolveManualSitesAccess,saveManualSitesAccess,removeManualSitesAccess} from './sites-access.mjs';
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value);}
function identity(value){return typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u0020\u007f]/u.test(value);}
function receiptMatches(receipt,heartbeat){return receipt&&receipt.bootId===heartbeat.bootId&&receipt.generation===heartbeat.generation&&receipt.sequence===heartbeat.sequence&&['live','history'].includes(receipt.classification)&&receipt.heartbeatHash===createHash('sha256').update(canonical(heartbeat)).digest('hex');}
/** Never echo enrollment input, accept it in argv, or log it. */
export async function readMaskedSecret(input=process.stdin,output=process.stderr,{prompt='One-use enrollment secret: ',maxLength=512}={}){
  if(!input.isTTY||typeof input.setRawMode!=='function')throw new Error('Enrollment requires an interactive masked prompt.');
  if(typeof prompt!=='string'||!Number.isSafeInteger(maxLength)||maxLength<1||maxLength>8192)throw new Error('Invalid masked input policy.');output.write(prompt);const wasRaw=!!input.isRaw;input.setRawMode(true);input.resume();
  return new Promise((resolve,reject)=>{
    let secret='',finished=false;
    function finish(error){if(finished)return;finished=true;input.removeListener('data',data);input.removeListener('end',ended);input.setRawMode(wasRaw);input.pause();output.write('\n');if(error)reject(new Error('Enrollment input cancelled.'));else resolve(secret);}
    function ended(){finish(true);}
    function data(chunk){for(const character of chunk.toString('utf8')){if(character==='\r'||character==='\n'){finish();return;}if(character==='\u0003'){finish(true);return;}if(character==='\u007f'||character==='\b')secret=secret.slice(0,-1);else if(character>=' '){if(secret.length>=maxLength){finish(true);return;}secret+=character;}}}
    input.on('data',data);input.once('end',ended);
  });
}
/** Window issuance precedes sampling; only confirmed fresh delivery unlocks the old spool. */
export async function runBridgeOnce({config,session,sequence,transport,outbox,sample,now=()=>new Date().toISOString()}){
  const window=await transport.liveWindow({bootId:session.bootId,generation:session.generation,sequence});
  const at=Date.parse(now());
  if(!window||!identity(window.windowId)||window.bootId!==session.bootId||window.generation!==session.generation||window.sequence!==sequence||!Number.isFinite(at)||!Number.isFinite(Date.parse(window.issuedAt))||Date.parse(window.issuedAt)>at||!Number.isFinite(Date.parse(window.expiresAt))||Date.parse(window.expiresAt)<=at)throw new Error('Live window unavailable.');
  const observations=config.pcCommandCenter.enabled?[await sample({instanceId:config.pcCommandCenter.instanceId,selectedGpuId:config.pcCommandCenter.selectedGpuId,selectedGpuAlias:config.pcCommandCenter.selectedGpuAlias,now})]:[];
  const heartbeat={schemaVersion:1,deviceId:config.deviceId,bootId:session.bootId,generation:session.generation,sequence,sentAt:now(),bridgeVersion:config.bridgeVersion,observations};
  const item=await outbox.enqueue({heartbeatBytes:canonical(heartbeat),liveWindowId:window.windowId,windowExpiresAt:window.expiresAt,createdAt:now()});
  const receipt=await transport.heartbeat({schemaVersion:1,delivery:'live',liveWindowId:window.windowId,heartbeat});
  if(!receiptMatches(receipt,heartbeat))throw new Error('Heartbeat receipt differs.');
  await outbox.ack(typeof item==='string'?item:item.id,{classification:receipt.classification});
  if(receipt.classification!=='live')return receipt;
  for(const pending of await outbox.pending({now:now(),limit:240})){
    const original=JSON.parse(pending.heartbeatBytes);
    // The single globally bounded spool may retain a previous enrollment. Never
    // send its payload using a different device credential or delete it silently.
    // pending's limit equals the entire 240-record capacity, so skipping cannot
    // hide current-device records behind a foreign-device prefix.
    if(original.deviceId!==config.deviceId)continue;
    const received=await transport.heartbeat({schemaVersion:1,delivery:'history',liveWindowId:null,heartbeat:original});
    if(!receiptMatches(received,original))throw new Error('Historical receipt differs.');
    await outbox.ack(pending.id,{classification:received.classification});
  }
  return receipt;
}
function validCredential(value){
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===4&&['deviceId','credentialId','deviceCredential','expiresAt'].every(key=>Object.hasOwn(value,key))&&identity(value.deviceId)&&identity(value.credentialId)&&typeof value.deviceCredential==='string'&&value.deviceCredential.length>0&&value.deviceCredential.length<=4096&&!/[\r\n]/u.test(value.deviceCredential)&&Number.isFinite(Date.parse(value.expiresAt))&&Date.parse(value.expiresAt)>Date.now();
}
export function nodeVersionStatus(version=process.versions.node){
 const match=typeof version==='string'?/^(\d+)\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.exec(version):null;
 const major=match&&Number.isSafeInteger(Number(match[1]))?Number(match[1]):null;
 return {status:major!==null&&major>=24?'supported':'unsupported',major};
}
export function requireSupportedNode(){if(nodeVersionStatus().status!=='supported')throw new Error('Node 24 or newer is required.');}
async function boundedRead(work,milliseconds){
 const controller=new AbortController();let timer;
 try{return await Promise.race([Promise.resolve().then(()=>work(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Read unavailable.'));},milliseconds);})]);}
 finally{clearTimeout(timer);}
}
function unavailableDoctor(node){
 return {schemaVersion:1,node,configuration:{status:'unavailable',reason:'invalid_or_unreadable'},credential:{status:'unavailable',reason:'configuration_unavailable'},collector:{status:'unavailable',reason:'configuration_unavailable'},cloudTransport:{status:'unavailable',reason:'configuration_unavailable'},privateIngress:{status:'unavailable',reason:'configuration_unavailable'},cloudConnectionVerified:false,windowsAcceptanceVerified:false};
}
/** Read-only diagnostics. No enrollment/session/window/heartbeat call is made.
 * DPAPI uses only the existing fixed helper and private pipes. Local collector
 * requests still use the fixed numeric-loopback sampler; raw readings and
 * credentials never enter this report.
 */
export async function doctorBridge({config,credentialStore,ingressAdapter=unavailablePrivateIngress,sample,now=()=>new Date().toISOString()}){
 const node=nodeVersionStatus(),report=unavailableDoctor(node);try{config=validateConfig(config);}catch{return report;}report.configuration={status:'valid'};
 const current=Date.parse(now());if(!Number.isFinite(current))return {...report,configuration:{status:'unavailable',reason:'invalid_clock'}};
 report.cloudTransport=config.cloudBaseUrl===null?{status:'unavailable',reason:'not_configured'}:{status:'configured'};
 const [credential,collector,privateIngress]=await Promise.all([
  (async()=>{
   try{
    const value=await boundedRead(()=>credentialStore.load(),11000);
    if(value===null)return {status:'unavailable',reason:'missing'};
    if(!validCredential(value))return {status:'unavailable',reason:'expired_or_invalid'};
    if(config.deviceId!==null&&config.deviceId!==value.deviceId)return {status:'unavailable',reason:'device_mismatch'};
    return {status:'available'};
   }catch(error){return {status:'unavailable',reason:error?.code==='windows_current_user_protection_unavailable'||process.platform!=='win32'&&error?.code==='credential_read_failed'?'protection_unavailable':'protected_credential_unreadable'};}
  })(),
  (async()=>{
   if(!config.pcCommandCenter.enabled)return {status:'disabled',reason:'not_configured'};
   try{
    const observation=await boundedRead(()=>sample({instanceId:config.pcCommandCenter.instanceId,selectedGpuId:config.pcCommandCenter.selectedGpuId,selectedGpuAlias:config.pcCommandCenter.selectedGpuAlias,now}),2200);
    const states=['ready','warming','degraded','unavailable','disabled'],diagnostics=['ok','source_unreachable','source_stale','source_invalid','not_configured'];
    if(!observation||observation.source!=='pc-command-center'||!states.includes(observation.state)||!diagnostics.includes(observation.diagnostic))return {status:'unavailable',reason:'source_invalid'};
    return {status:observation.state==='unavailable'?'unavailable':observation.state==='disabled'?'disabled':'available',state:observation.state,diagnostic:observation.diagnostic};
   }catch{return {status:'unavailable',reason:'source_unreachable'};}
  })(),
  (async()=>{
   if(config.cloudBaseUrl===null)return {status:'unavailable',reason:'not_configured'};
   if(ingressAdapter===unavailablePrivateIngress)return {status:'unavailable',reason:'unsupported'};
   try{
    const path='/api/bridge/heartbeat',issued=await boundedRead(signal=>ingressAdapter.getHeaders({url:config.cloudBaseUrl+path,path,method:'POST',signal}),2000);
    const at=Date.parse(now());if(!issued||!Number.isFinite(at)||!Number.isFinite(Date.parse(issued.expiresAt))||Date.parse(issued.expiresAt)<=at)throw new Error();
    const headers=new Headers(issued.headers);
    if([...headers.keys()].length===0)throw new Error();
    for(const key of headers.keys())if(key==='cookie'||key==='x-control-room-device'||key==='content-type'||/authenticated-user|owner-id|forwarded|^host$|content-length/iu.test(key))throw new Error();
    return {status:'available'};
   }catch{return {status:'unavailable',reason:'credentials_unavailable'};}
  })()
 ]);
 report.credential=credential;report.collector=collector;report.privateIngress=privateIngress;return report;
}

export async function main(argv=process.argv.slice(2),dependencies={}){
  const [command,...flags]=argv;
  if(!['doctor','enroll','run','revoke-local','sites-access','sites-access-remove'].includes(command))throw new Error('Use doctor, enroll, run [--once], or revoke-local --config <absolute.json>.');
  let configPath=null,once=false,releaseUntil=null,ownerPrivateConfirmed=false;
  for(let i=0;i<flags.length;i++){if(flags[i]==='--config'&&configPath===null)configPath=flags[++i];else if(flags[i]==='--once'&&command==='run'&&!once)once=true;else if(flags[i]==='--until'&&command==='sites-access'&&releaseUntil===null)releaseUntil=flags[++i];else if(flags[i]==='--confirm-owner-private'&&command==='sites-access'&&!ownerPrivateConfirmed)ownerPrivateConfirmed=true;else throw new Error('Unsupported bridge option.');}
  if(!configPath||!isAbsolute(configPath))throw new Error('An absolute --config path is required.');
  const print=dependencies.print??(text=>process.stdout.write(text+'\n'));
  if(command==='run'||command==='enroll')requireSupportedNode();
  const stateDirectory=join(dirname(configPath),'.control-room-bridge');
  const {readConfig}=await import('./config.mjs');let config;
  try{await ensurePrivateWindowsState({configPath,stateDirectory});config=command==='doctor'?await boundedRead(()=>readConfig(configPath),2200):await readConfig(configPath);}catch(error){if(command!=='doctor')throw error;const report=unavailableDoctor(nodeVersionStatus());print(JSON.stringify(report));return report;}
  if(command==='sites-access'){if(!ownerPrivateConfirmed||releaseUntil===null)throw new Error('A current native owner-private confirmation and finite --until are required.');const bearer=await(dependencies.readSitesBearer??(()=>readMaskedSecret(process.stdin,process.stderr,{prompt:'Sites service bearer (masked): ',maxLength:8192})))();const result=await saveManualSitesAccess({configPath,origin:config.cloudBaseUrl,releaseUntil,bearer,ownerPrivateConfirmed,store:dependencies.sitesCredentialStore});print(JSON.stringify(result));return result;}
  if(command==='sites-access-remove'){const result=await removeManualSitesAccess({configPath});print(JSON.stringify(result));return result;}
  const store=dependencies.credentialStore??createCredentialStore({path:join(stateDirectory,'credentials.dpapi')});
  if(command==='revoke-local'){await store.remove();print('Local protected credential removed. Revoke the device in Control Room to revoke server access.');return;}
  const ingress=dependencies.ingressAdapter??await resolveManualSitesAccess({configPath,origin:config.cloudBaseUrl});
  if(ingress?.mode==='manual-owner-private-sites'&&command==='run'&&!once)throw new Error('Manual Sites access permits run --once only.');
  if(command==='doctor'){const {samplePcCommandCenter}=await import('./pc-command-center.mjs');const report=await doctorBridge({config,credentialStore:store,ingressAdapter:ingress,sample:dependencies.sample??samplePcCommandCenter,now:dependencies.now});print(JSON.stringify(report));return report;}
  if(!config.cloudBaseUrl)throw new Error('Configure a private cloud origin first.');
  if(command==='enroll'){
    const secret=await(dependencies.readSecret??readMaskedSecret)();
    const transport=createBridgeTransport({baseUrl:config.cloudBaseUrl,ingressAdapter:ingress,...dependencies.transportOptions});
    const issued=await transport.enroll({secret,bridgeVersion:config.bridgeVersion});
    if(!validCredential(issued))throw new Error('Enrollment response invalid.');
    await store.save(issued);print('Enrollment credential protected for this Windows user.');return;
  }
  const credential=await store.load();
  if(!validCredential(credential))throw new Error('A current protected device credential is required.');
  if(config.deviceId!==null&&config.deviceId!==credential.deviceId)throw new Error('Configured device differs from protected credential.');
  const activeConfig={...config,deviceId:credential.deviceId},transport=createBridgeTransport({baseUrl:config.cloudBaseUrl,deviceCredential:credential.deviceCredential,ingressAdapter:ingress,...dependencies.transportOptions}),bootId=randomUUID();
  const session=await transport.session({bootId,bridgeVersion:config.bridgeVersion});
  if(session.deviceId!==credential.deviceId||session.bootId!==bootId||!Number.isSafeInteger(session.generation)||session.generation<1)throw new Error('Session response invalid.');
  const {Outbox}=await import('./outbox.mjs'),{samplePcCommandCenter}=await import('./pc-command-center.mjs');
  const outbox=dependencies.outbox??await Outbox.open({directory:join(stateDirectory,'outbox')}),sleep=dependencies.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  let sequence=1;
  try{
    do{
      try{await runBridgeOnce({config:activeConfig,session,sequence:sequence++,transport,outbox,sample:dependencies.sample??samplePcCommandCenter,now:dependencies.now});}
      catch(error){if(once||!(error instanceof BridgeTransportError)||!['network_uncertain','server_uncertain','rate_limited'].includes(error.code))throw error;await sleep(Math.max(BRIDGE_LIMITS.sampleEveryMs,Math.min(60000,error.retryAfterMs??BRIDGE_LIMITS.sampleEveryMs)));continue;}
      if(!once)await sleep(BRIDGE_LIMITS.sampleEveryMs);
    }while(!once);
  }finally{await outbox.close?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stderr.write('Bridge stopped. Check configuration, protected credentials, private ingress, and cloud device access.\n');process.exitCode=1;});
