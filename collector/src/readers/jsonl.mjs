import {createReadStream} from 'node:fs';
export const JSONL_LIMITS=Object.freeze({maxBytes:16*1024*1024,maxLineBytes:1024*1024,maxRecords:10000,maxDepth:64});
export function readerLimits(options={}){const result={};for(const [key,fallback]of Object.entries(JSONL_LIMITS)){const value=options[key]??fallback;if(!Number.isSafeInteger(value)||value<1||value>fallback)throw new RangeError('Invalid bounded JSONL limit.');result[key]=value;}return result;}
function boundedDepth(value,limit){const pending=[[value,1]];while(pending.length){const [node,depth]=pending.pop();if(depth>limit)return false;if(node&&typeof node==='object')for(const child of Object.values(node))if(child&&typeof child==='object')pending.push([child,depth+1]);}return true;}
/** No diagnostic contains source bytes, absolute paths, provider text or exception text. */
export async function* readJsonl(input,options={}){
 const limits=readerLimits(options),signal=options.signal;
 signal?.throwIfAborted();
 const stream=typeof input==='string'?createReadStream(input,{signal,highWaterMark:64*1024}):input;
 let pending=Buffer.alloc(0),total=0,line=0,offset=0,records=0;
 function decode(buffer,final){
  line++;const start=offset;offset+=buffer.length+(final?0:1);
  if(buffer.length&&buffer.at(-1)===13)buffer=buffer.subarray(0,-1);
  if(!buffer.length)return null;
  if(++records>limits.maxRecords)return {kind:'gap',code:'record_limit',line,offset:start,terminal:true};
  if(buffer.length>limits.maxLineBytes)return {kind:'gap',code:'line_byte_limit',line,offset:start,terminal:true};
  let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{return {kind:'gap',code:'invalid_utf8',line,offset:start};}
  try{value=JSON.parse(text);}catch{return {kind:'gap',code:final&&options.allowPartialFinalLine!==false?'partial_final_line':'invalid_json',line,offset:start};}
  if(!boundedDepth(value,limits.maxDepth))return {kind:'gap',code:'depth_limit',line,offset:start};
  return {kind:'record',value,line,offset:start,bytes:buffer.length};
 }
 try{
  for await(const raw of stream){
   signal?.throwIfAborted();const chunk=Buffer.from(raw),remaining=limits.maxBytes-total,limited=chunk.length>remaining,accepted=limited?chunk.subarray(0,Math.max(0,remaining)):chunk;total+=accepted.length;
   pending=Buffer.concat([pending,accepted]);let end;
   while((end=pending.indexOf(10))>=0){const event=decode(pending.subarray(0,end),false);pending=pending.subarray(end+1);if(event){yield event;if(event.terminal)return;}}
   if(pending.length>limits.maxLineBytes){yield {kind:'gap',code:'line_byte_limit',line:line+1,offset,terminal:true};return;}
   if(limited){yield {kind:'gap',code:'decompressed_byte_limit',line:line+1,offset,terminal:true};return;}
  }
  signal?.throwIfAborted();if(pending.length){const event=decode(pending,true);if(event)yield event;}
 }finally{if(typeof input==='string')stream.destroy();}
}
