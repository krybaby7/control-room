#!/usr/bin/env node
import {isAbsolute,dirname,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createBridgeTransport,unavailablePrivateIngress,BridgeTransportError} from './transport.mjs';
import {createCredentialStore} from './credentials.mjs';
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';return JSON.stringify(value);}
function identity(value){return typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u0020\u007f]/u.test(value);}
function receiptMatches(receipt,heartbeat){return receipt&&receipt.bootId===heartbeat.bootId&&receipt.generation===heartbeat.generation&&receipt.sequence===heartbeat.sequence&&['live','history'].includes(receipt.classification)&&receipt.heartbeatHash===createHash('sha256').update(canonical(heartbeat)).digest('hex');}
/** Never echo enrollment input, accept it in argv, or log it. */
export async function readMaskedSecret(input=process.stdin,output=process.stderr){
  if(!input.isTTY||typeof input.setRawMode!=='function')throw new Error('Enrollment requires an interactive masked prompt.');
  output.write('One-use enrollment secret: ');const wasRaw=!!input.isRaw;input.setRawMode(true);input.resume();
  return new Promise((resolve,reject)=>{
    let secret='',finished=false;
    function finish(error){if(finished)return;finished=true;input.removeListener('data',data);input.removeListener('end',ended);input.setRawMode(wasRaw);input.pause();output.write('\n');if(error)reject(new Error('Enrollment input cancelled.'));else resolve(secret);}
    function ended(){finish(true);}
    function data(chunk){for(const character of chunk.toString('utf8')){if(character==='\r'||character==='\n'){finish();return;}if(character==='\u0003'){finish(true);return;}if(character==='\u007f'||character==='\b')secret=secret.slice(0,-1);else if(character>=' '&&secret.length<512)secret+=character;}}
    input.on('data',data);input.once('end',ended);
  });
}
/** Window issuance precedes sampling; only confirmed fresh delivery unlocks the old spool. */
export async function runBridgeOnce({config,session,sequence,transport,outbox,sample,now=()=>new Date().toISOString()}){
  const window=await transport.liveWindow({bootId:session.bootId,generation:session.generation,sequence});
  const at=Date.parse(now());
  if(!window||!identity(window.windowId)||window.bootId!==session.bootId||window.generation!==session.generation||window.sequence!==sequence||!Number.isFinite(at)||!Number.isFinite(Date.parse(window.issuedAt))||Date.parse(window.issuedAt)>at||!Number.isFinite(Date.parse(window.expiresAt))||Date.parse(window.expiresAt)<=at)throw new Error('Live window unavailable.');
  const observations=config.pcCommandCenter.enabled?[await sample({instanceId:config.pcCommandCenter.instanceId,selectedGpuId:config.pcCommandCenter.selectedGpuId,now})]:[];
  const heartbeat={schemaVersion:1,deviceId:config.deviceId,bootId:session.bootId,generation:session.generation,sequence,sentAt:now(),bridgeVersion:config.bridgeVersion,observations};
  const item=await outbox.enqueue({heartbeatBytes:canonical(heartbeat),liveWindowId:window.windowId,windowExpiresAt:window.expiresAt,createdAt:now()});
  const receipt=await transport.heartbeat({schemaVersion:1,delivery:'live',liveWindowId:window.windowId,heartbeat});
  if(!receiptMatches(receipt,heartbeat))throw new Error('Heartbeat receipt differs.');
  await outbox.ack(typeof item==='string'?item:item.id,{classification:receipt.classification});
  if(receipt.classification!=='live')return receipt;
  for(const pending of await outbox.pending({now:now(),limit:240})){
    const original=JSON.parse(pending.heartbeatBytes);
    const received=await transport.heartbeat({schemaVersion:1,delivery:'history',liveWindowId:pending.liveWindowId,heartbeat:original});
    if(!receiptMatches(received,original))throw new Error('Historical receipt differs.');
    await outbox.ack(pending.id,{classification:received.classification});
  }
  return receipt;
}
function validCredential(value){
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===4&&['deviceId','credentialId','deviceCredential','expiresAt'].every(key=>Object.hasOwn(value,key))&&identity(value.deviceId)&&identity(value.credentialId)&&typeof value.deviceCredential==='string'&&value.deviceCredential.length>0&&value.deviceCredential.length<=4096&&!/[\r\n]/u.test(value.deviceCredential)&&Number.isFinite(Date.parse(value.expiresAt))&&Date.parse(value.expiresAt)>Date.now();
}
export async function main(argv=process.argv.slice(2),dependencies={}){
  const [command,...flags]=argv;
  if(!['doctor','enroll','run','revoke-local'].includes(command))throw new Error('Use doctor, enroll, run [--once], or revoke-local --config <absolute.json>.');
  let configPath=null,once=false;
  for(let i=0;i<flags.length;i++){if(flags[i]==='--config'&&configPath===null)configPath=flags[++i];else if(flags[i]==='--once'&&command==='run'&&!once)once=true;else throw new Error('Unsupported bridge option.');}
  if(!configPath||!isAbsolute(configPath))throw new Error('An absolute --config path is required.');
  const {readConfig}=await import('./config.mjs'),config=await readConfig(configPath),stateDirectory=join(dirname(configPath),'.control-room-bridge');
  const store=dependencies.credentialStore??createCredentialStore({path:join(stateDirectory,'credentials.dpapi')}),print=dependencies.print??(text=>process.stdout.write(text+'\n'));
  if(command==='revoke-local'){await store.remove();print('Local protected credential removed. Revoke the device in Control Room to revoke server access.');return;}
  const ingress=dependencies.ingressAdapter??unavailablePrivateIngress;
  if(command==='doctor'){const report={cloudConfigured:config.cloudBaseUrl!==null,privateIngressAdapterConfigured:ingress!==unavailablePrivateIngress};print('Collector is read-only. A configured adapter is not proof of live private ingress or Windows acceptance.');return report;}
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
      catch(error){if(once||!(error instanceof BridgeTransportError)||!['network_uncertain','server_uncertain','rate_limited'].includes(error.code))throw error;await sleep(Math.max(10000,Math.min(60000,error.retryAfterMs??10000)));continue;}
      if(!once)await sleep(10000);
    }while(!once);
  }finally{await outbox.close?.();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.stderr.write('Bridge stopped. Check configuration, protected credentials, private ingress, and cloud device access.\n');process.exitCode=1;});
