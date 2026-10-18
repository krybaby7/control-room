import { RequestError } from './api-guards.ts';
/** Browser-owner JSON ingress. Authority is always supplied separately by the server. */
export async function readOwnerJson(request:Request,maxBytes=65_536):Promise<Record<string,unknown>> {
  if(request.headers.get('origin')!==new URL(request.url).origin)throw new RequestError('Use this app to change private data.',403);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new RequestError('Use JSON.',415);
  const reader=request.body?.getReader();if(!reader)throw new RequestError('A JSON body is required.',400);
  let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new RequestError('This entry is too large.',413);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new RequestError('Invalid JSON.',400);}
  if(!value || typeof value!=='object' || Array.isArray(value))throw new RequestError('A JSON object is required.',400);
  return value as Record<string,unknown>;
}
