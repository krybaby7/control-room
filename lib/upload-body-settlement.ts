/** Discard small rejected transport bodies before replying, without buffering or staging them.
 * Larger/stalled bodies are cancelled with a separate bounded wait. No auth or storage authority. */
export async function settleUploadBody(body:ReadableStream<Uint8Array>|null,options:{maxBytes?:number;drainMs?:number;cancelMs?:number}={}):Promise<'empty'|'drained'|'cancelled'|'unsettled'>{
 const maxBytes=options.maxBytes??65_536,drainMs=options.drainMs??1000,cancelMs=options.cancelMs??250;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>65_536||!Number.isSafeInteger(drainMs)||drainMs<1||drainMs>1000||!Number.isSafeInteger(cancelMs)||cancelMs<1||cancelMs>250)throw new Error('Invalid upload settlement bounds.');
 if(!body)return 'empty';
 let reader:ReadableStreamDefaultReader<Uint8Array>;try{reader=body.getReader();}catch{return 'unsettled';}
 let timer:ReturnType<typeof setTimeout>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Upload discard deadline exceeded.')),drainMs);});
 try{
  let size=0;
  for(;;){const item=await Promise.race([reader.read(),expired]);if(item.done){reader.releaseLock();return 'drained';}if(!(item.value instanceof Uint8Array)||item.value.byteLength>maxBytes-size)break;size+=item.value.byteLength;}
 }catch{/* Failed and disconnected reads are cancelled below before the denial is sent. */}
 finally{clearTimeout(timer);}
 let cancelTimer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([Promise.resolve().then(()=>reader.cancel()).then(()=>'cancelled' as const,()=>'unsettled' as const),new Promise<'unsettled'>(resolve=>{cancelTimer=setTimeout(()=>resolve('unsettled'),cancelMs);})]);}
 finally{clearTimeout(cancelTimer);try{reader.releaseLock();}catch{/* A failed transport is already unavailable. */}}
}
