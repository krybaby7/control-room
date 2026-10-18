import test from 'node:test';
import assert from 'node:assert/strict';
import {readImportResponseBytes,readImportResponseJson,IMPORT_RESPONSE_BYTES} from '../lib/import-response.ts';
const encoder=new TextEncoder();
function chunked(parts:Uint8Array[],headers?:HeadersInit){return new Response(new ReadableStream<Uint8Array>({start(controller){for(const part of parts)controller.enqueue(part);controller.close();}}),{headers});}
test('streamed JSON accepts split multibyte UTF-8 and bounded binary downloads preserve exact bytes',async()=>{
 const bytes=encoder.encode('{"title":"café"}'),split=bytes.indexOf(0xc3)+1;
 assert.deepEqual(await readImportResponseJson(chunked([bytes.slice(0,split),bytes.slice(split)],{'Content-Length':String(bytes.length)}),{maxBytes:bytes.length}),{title:'café'});
 const original=new Uint8Array([0,255,1,2]);assert.deepEqual(await readImportResponseBytes(chunked([original.slice(0,2),original.slice(2)]),{maxBytes:4}),original);assert.equal(IMPORT_RESPONSE_BYTES,8_000_000);
});
test('oversized declared response is cancelled before body accumulation and invalid lengths fail closed',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{headers:{'Content-Length':'65'}});
 await assert.rejects(readImportResponseBytes(response,{maxBytes:64}),/exceeds its byte limit/);assert.equal(cancelled,true);
 for(const length of ['-1','1.5','not-a-number','9007199254740992'])await assert.rejects(readImportResponseBytes(chunked([],{ 'Content-Length':length}),{maxBytes:64}));
});
test('chunked and misleading short headers cannot bypass streaming limits and cancel unread tails',async()=>{
 const cases:Array<HeadersInit|undefined>=[undefined,{'Content-Length':'1'},{'Content-Length':'1','Content-Encoding':'gzip'}];for(const headers of cases){let cancelled=false,pulls=0;const response=new Response(new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(16));},cancel(){cancelled=true;}}),{headers});await assert.rejects(readImportResponseBytes(response,{maxBytes:20}),/exceeds its byte limit/);assert.equal(cancelled,true);assert.ok(pulls<=4,'Reader must stop pulling at the bounded overflow');}
});
test('truncated declared bodies, invalid UTF-8, incomplete JSON and trailing bytes are never accepted',async()=>{
 await assert.rejects(readImportResponseBytes(chunked([encoder.encode('short')],{'Content-Length':'10'}),{maxBytes:20}),/length differs/);
 await assert.rejects(readImportResponseBytes(new Response(null,{headers:{'Content-Length':'1'}})),/length differs/);
 for(const bytes of [new Uint8Array([0xc3]),encoder.encode('{"partial":'),new Uint8Array([...encoder.encode('{"valid":true}'),255])])await assert.rejects(readImportResponseJson(chunked([bytes]),{maxBytes:64}),/complete valid UTF-8 JSON/);
 assert.deepEqual(await readImportResponseJson(chunked([encoder.encode('{"decoded":true}')],{'Content-Length':'2','Content-Encoding':'gzip'}),{maxBytes:64}),{decoded:true});
});
test('caller cancellation interrupts a hung body, cancels its reader and releases the lock',async()=>{
 const controller=new AbortController();let cancelled=false;const response=new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}));const reading=readImportResponseBytes(response,{maxBytes:64,signal:controller.signal});const reason=new Error('Synthetic session expired');controller.abort(reason);await assert.rejects(reading,error=>error===reason);assert.equal(cancelled,true);assert.equal(response.body!.locked,false);
 let preCancelled=false;const already=new AbortController();already.abort(reason);await assert.rejects(readImportResponseBytes(new Response(new ReadableStream<Uint8Array>({cancel(){preCancelled=true;}})),{signal:already.signal}),error=>error===reason);assert.equal(preCancelled,true);
});
test('response limit options reject unsafe or expanded limits before any allocation',async()=>{
 for(const maxBytes of [0,-1,1.5,Infinity,IMPORT_RESPONSE_BYTES+1])await assert.rejects(readImportResponseBytes(new Response('small'),{maxBytes}),/Invalid import response limit/);
});
