import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readReviewRun} from '../lib/reviews/request.ts';
import {RequestError} from '../lib/api-guards.ts';
const url='https://fixture.invalid/api/reviews/run';
function request(body:unknown,headers:Record<string,string>={}){return new Request(url,{method:'POST',headers:{Origin:'https://fixture.invalid','Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});}
const rejects=(status:number)=>(error:unknown)=>error instanceof RequestError&&error.status===status;
test('review run accepts one exact bounded intent and mixed-case JSON media type',async()=>{
 assert.deepEqual(await readReviewRun(request({intentId:'synthetic-review-intent'})),{intentId:'synthetic-review-intent'});
 assert.deepEqual(await readReviewRun(request({intentId:'synthetic-review-intent'},{'Content-Type':'Application/JSON; charset=utf-8'})),{intentId:'synthetic-review-intent'});
});
test('review run rejects absent/foreign origins and unsupported media types before consuming content',async()=>{
 for(const origin of ['https://foreign.invalid','null',''])await assert.rejects(readReviewRun(request({intentId:'intent'},{Origin:origin})),rejects(403));
 await assert.rejects(readReviewRun(request({intentId:'intent'},{'Content-Type':'text/plain'})),rejects(415));
 await assert.rejects(readReviewRun(new Request(url,{method:'POST',headers:{Origin:'https://fixture.invalid','Content-Type':'application/json'}})),rejects(400));
});
test('review run rejects malformed JSON/fatal UTF8 and all owner/principal/configuration injection',async()=>{
 for(const value of ['', '{', 'null', '[]', '{}', JSON.stringify({intentId:''}),JSON.stringify({intentId:'i'.repeat(129)}),JSON.stringify({intentId:'intent',ownerId:'foreign'}),JSON.stringify({intentId:'intent',principalRef:'forged'}),JSON.stringify({intentId:'intent',snapshotId:'forged'}),JSON.stringify({intentId:'intent',configurationHash:'a'.repeat(64)})])await assert.rejects(readReviewRun(request(value)),rejects(400));
 const invalid=new Request(url,{method:'POST',headers:{Origin:'https://fixture.invalid','Content-Type':'application/json'},body:new Uint8Array([0x7b,0xff,0x7d])});await assert.rejects(readReviewRun(invalid),rejects(400));
});
test('review run enforces actual streamed byte bound despite a misleading content-length and cancels overflow',async()=>{
 let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(' '.repeat(1025)));},cancel(){cancelled=true;}});
 const input=new Request(url,{method:'POST',headers:{Origin:'https://fixture.invalid','Content-Type':'application/json','Content-Length':'2'},body:stream,duplex:'half'} as RequestInit);
 await assert.rejects(readReviewRun(input),rejects(413));assert.equal(cancelled,true);
});
test('stalled review request cancels at its actual 15-second deadline using a fake timer, without wall-clock waiting',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});let cancelled=false;
 try{const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),input=new Request(url,{method:'POST',headers:{Origin:'https://fixture.invalid','Content-Type':'application/json'},body,duplex:'half'} as RequestInit),work=readReviewRun(input),check=assert.rejects(work,rejects(408));context.mock.timers.tick(15000);await check;assert.equal(cancelled,true);}finally{context.mock.timers.reset();}
});
