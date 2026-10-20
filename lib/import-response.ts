/** Import reviews and original metadata downloads share the durable quarantine's byte bound. */
export const IMPORT_RESPONSE_BYTES=8_000_000;
export interface ImportResponseOptions {maxBytes?:number;signal?:AbortSignal}
export async function readImportResponseBytes(response:Response,options:ImportResponseOptions={}):Promise<Uint8Array<ArrayBuffer>>{
 const max=options.maxBytes??IMPORT_RESPONSE_BYTES;if(!Number.isSafeInteger(max)||max<1||max>IMPORT_RESPONSE_BYTES)throw new Error('Invalid import response limit.');
 const signal=options.signal??AbortSignal.timeout(15_000),length=response.headers.get('content-length');
 const cancel=(reason:unknown)=>{void response.body?.cancel(reason).catch(()=>{});};
 if(signal.aborted){cancel(signal.reason);throw signal.reason??new Error('Import response was cancelled.');}
 if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>max)){cancel('Import response byte limit');throw new Error('Import response exceeds its byte limit or declares an invalid length.');}
 const expected=length!==null&&(!response.headers.has('content-encoding')||response.headers.get('content-encoding')==='identity')?Number(length):null;
 if(!response.body){if(expected!==null&&expected!==0)throw new Error('Import response length differs from its declared length.');return new Uint8Array(0);}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 let onAbort=()=>{};
 const aborted=new Promise<never>((_,reject)=>{onAbort=()=>{const reason=signal.reason??new Error('Import response was cancelled.');reject(reason);void reader.cancel(reason).catch(()=>{});};signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();});
 try{for(;;){const item=await Promise.race([reader.read(),aborted]);if(item.done)break;if(!(item.value instanceof Uint8Array))throw new Error('Import response contains invalid byte chunks.');if(item.value.byteLength>max-size){void reader.cancel('Import response byte limit').catch(()=>{});throw new Error('Import response exceeds its byte limit.');}size+=item.value.byteLength;chunks.push(item.value.slice());}
  if(expected!==null&&size!==expected)throw new Error('Import response length differs from its declared length.');
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
 }catch(error){void reader.cancel(error).catch(()=>{});throw error;}finally{signal.removeEventListener('abort',onAbort);reader.releaseLock();}
}
export async function readImportResponseJson<T=unknown>(response:Response,options:ImportResponseOptions={}):Promise<T>{
 const bytes=await readImportResponseBytes(response,options);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as T;}catch{throw new Error('Import response is not complete valid UTF-8 JSON.');}
}
