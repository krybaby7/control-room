const PATHS=Object.freeze({enroll:'/api/bridge/enroll',session:'/api/bridge/session',liveWindow:'/api/bridge/live-window',heartbeat:'/api/bridge/heartbeat'});
export class BridgeTransportError extends Error {
  constructor(code,{status=null,retryAfterMs=null}={}){super(code);this.name='BridgeTransportError';this.code=code;this.status=status;this.retryAfterMs=retryAfterMs;}
}
/** Install only a proven private-platform credential adapter. Browser credentials are never a fallback. */
export const unavailablePrivateIngress=Object.freeze({async getHeaders(){throw new BridgeTransportError('private_ingress_unavailable');}});
export function cloudOrigin(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new BridgeTransportError('invalid_cloud_origin');
  return url.origin;
}
function retryAfter(value,now){
  if(value===null)return null;
  const seconds=value.trim()===''?NaN:Number(value);
  const ms=Number.isFinite(seconds)&&seconds>=0?seconds*1000:Date.parse(value)-now;
  return Number.isFinite(ms)?Math.max(0,Math.min(ms,60000)):null;
}
function input(kind,value){
  const keys=kind==='enroll'?['secret','bridgeVersion']:kind==='session'?['bootId','bridgeVersion']:kind==='liveWindow'?['bootId','generation','sequence']:['schemaVersion','delivery','liveWindowId','heartbeat'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new BridgeTransportError('invalid_request');
}
async function readJson(response){
  let size=0;
  const chunks=[];
  if(!response.body)throw new BridgeTransportError('invalid_response');
  const reader=response.body.getReader();
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new BridgeTransportError('response_too_large');}chunks.push(Buffer.from(value));}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch(error){if(error instanceof BridgeTransportError)throw error;throw new BridgeTransportError('invalid_response');}
  finally{reader.releaseLock();}
}
async function privateHeaders(adapter,context){
  const controller=new AbortController();
  let timer;
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new BridgeTransportError('private_ingress_unavailable'));},10000);});
  try{return await Promise.race([Promise.resolve().then(()=>adapter.getHeaders({...context,signal:controller.signal})),expired]);}
  finally{clearTimeout(timer);}
}
export function createBridgeTransport({baseUrl,deviceCredential=null,ingressAdapter=unavailablePrivateIngress,fetchImpl=globalThis.fetch,now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),random=Math.random,maxAttempts=3}){
  const origin=cloudOrigin(baseUrl);
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>4)throw new BridgeTransportError('invalid_retry_limit');
  async function send(kind,payload){
    input(kind,payload);
    const path=PATHS[kind],body=JSON.stringify(payload);
    if(Buffer.byteLength(body)>65536)throw new BridgeTransportError('request_too_large');
    if(kind!=='enroll'&&(typeof deviceCredential!=='string'||!deviceCredential||deviceCredential.length>4096||/[\r\n]/u.test(deviceCredential)))throw new BridgeTransportError('device_credential_unavailable');
    const attempts=kind==='enroll'?1:maxAttempts;
    for(let attempt=0;attempt<attempts;attempt++){
      let ingress;
      try{ingress=await privateHeaders(ingressAdapter,{url:origin+path,method:'POST',path});}catch{throw new BridgeTransportError('private_ingress_unavailable');}
      if(!ingress||!Number.isFinite(Date.parse(ingress.expiresAt))||Date.parse(ingress.expiresAt)<=now())throw new BridgeTransportError('private_ingress_unavailable');
      const headers=new Headers(ingress.headers);
      if([...headers.keys()].length===0)throw new BridgeTransportError('private_ingress_unavailable');
      for(const key of headers.keys())if(key==='cookie'||key==='x-control-room-device'||key==='content-type'||/authenticated-user|owner-id|forwarded|^host$|content-length/iu.test(key))throw new BridgeTransportError('unsafe_ingress_headers');
      headers.set('content-type','application/json');
      if(kind!=='enroll')headers.set('x-control-room-device',deviceCredential);
      let response;
      try{response=await fetchImpl(origin+path,{method:'POST',headers,body,redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});}
      catch{
        if(attempt+1>=attempts)throw new BridgeTransportError('network_uncertain');
        await sleep(Math.min(5000,250*2**attempt+Math.floor(Math.max(0,Math.min(1,random()))*250)));
        continue;
      }
      if(response.ok)return readJson(response);
      await response.body?.cancel();
      if(response.status===401||response.status===403){try{await ingressAdapter.invalidate?.();}catch{}throw new BridgeTransportError('authentication_stopped',{status:response.status});}
      const delay=response.status===429?retryAfter(response.headers.get('retry-after'),now()):null;
      if((response.status===429||response.status>=500)&&attempt+1<attempts){
        await sleep(delay??Math.min(5000,250*2**attempt+Math.floor(Math.max(0,Math.min(1,random()))*250)));
        continue;
      }
      throw new BridgeTransportError(response.status===429?'rate_limited':response.status>=500?'server_uncertain':'request_rejected',{status:response.status,retryAfterMs:delay});
    }
  }
  return Object.freeze({enroll:payload=>send('enroll',payload),session:payload=>send('session',payload),liveWindow:payload=>send('liveWindow',payload),heartbeat:payload=>send('heartbeat',payload)});
}
