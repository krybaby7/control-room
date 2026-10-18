import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

export const BRIDGE_LIMITS=Object.freeze({sampleEveryMs:30000,localDeadlineMs:2000,responseBytes:262144,cloudDeadlineMs:10000,outboxBytes:8388608,outboxRecords:240,retryMinMs:5000,retryMaxMs:300000});
export const DEFAULT_CONFIG=Object.freeze({schemaVersion:1,cloudBaseUrl:null,deviceId:null,bridgeVersion:'0.1.0',pcCommandCenter:Object.freeze({enabled:false,instanceId:'pc-command-center',selectedGpuId:null}),adapters:Object.freeze(['agent-lab','trade-graph'].map(id=>Object.freeze({id,version:1,enabled:false,capabilities:Object.freeze([]),endpointAlias:id})))});
export function exactObject(value,keys){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Invalid object shape');
 return value;
}
export function opaqueId(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))throw new Error('Invalid opaque identifier');return value;}
export function timestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('Invalid timestamp');
 if(new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==value.slice(0,10))throw new Error('Invalid calendar date');
 return value;
}
export function canonicalJson(value,depth=0){
 if(depth>40)throw new Error('JSON nesting exceeds bound');
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(item=>canonicalJson(item,depth+1)).join(',')+']';
 if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(key=>{
  if(['__proto__','constructor','prototype'].includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))throw new Error('Unsafe JSON key');
  return JSON.stringify(key)+':'+canonicalJson(value[key],depth+1);
 }).join(',')+'}';
 throw new Error('Invalid JSON value');
}
export function validateConfig(value){
 exactObject(value,['schemaVersion','cloudBaseUrl','deviceId','bridgeVersion','pcCommandCenter','adapters']);
 if(value.schemaVersion!==1)throw new Error('Unsupported configuration');
 if(value.cloudBaseUrl!==null){if(typeof value.cloudBaseUrl!=='string')throw new Error('Invalid cloud origin');const url=new URL(value.cloudBaseUrl);if(url.protocol!=='https:'||url.origin!==value.cloudBaseUrl||url.username||url.password)throw new Error('Invalid cloud origin');}
 if(value.deviceId!==null)opaqueId(value.deviceId);
 if(typeof value.bridgeVersion!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.bridgeVersion))throw new Error('Invalid bridge version');
 const pc=exactObject(value.pcCommandCenter,['enabled','instanceId','selectedGpuId']);if(typeof pc.enabled!=='boolean')throw new Error('Invalid enabled flag');opaqueId(pc.instanceId);if(pc.selectedGpuId!==null)opaqueId(pc.selectedGpuId);
 if(!Array.isArray(value.adapters)||value.adapters.length!==2)throw new Error('Invalid disabled adapters');
 const ids=new Set();for(const adapter of value.adapters){exactObject(adapter,['id','version','enabled','capabilities','endpointAlias']);if(!['agent-lab','trade-graph'].includes(adapter.id)||ids.has(adapter.id)||adapter.version!==1||adapter.enabled!==false||adapter.endpointAlias!==adapter.id||!Array.isArray(adapter.capabilities)||adapter.capabilities.length)throw new Error('Unsupported adapter');ids.add(adapter.id);}
 return JSON.parse(canonicalJson(value));
}
export async function readConfig(path){
 if(typeof path!=='string'||!isAbsolute(path))throw new Error('Configuration path must be absolute');
 const file=await open(path,'r');try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>65536)throw new Error('Configuration exceeds bound');
  const chunks=[];let bytes=0;for await(const chunk of file.createReadStream({highWaterMark:4096,autoClose:false})){bytes+=chunk.length;if(bytes>65536)throw new Error('Configuration exceeds bound');chunks.push(chunk);}
  return validateConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
 }finally{await file.close();}
}
