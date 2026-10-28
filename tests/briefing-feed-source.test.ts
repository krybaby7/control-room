import test from 'node:test';
import assert from 'node:assert/strict';
import {loadClient} from './helpers/render-client.ts';
import {emptyFeedSnapshot,type FeedSnapshot} from '../lib/dashboard/feed.ts';

// The shared feed only needs window and document events; stand them in for the browser.
const page=globalThis as unknown as {window?:EventTarget;document?:EventTarget&{visibilityState:string}};
page.window??=new EventTarget();page.document??=Object.assign(new EventTarget(),{visibilityState:'visible'});
const {FeedSource}=await loadClient<typeof import('../components/briefing-feed')>(new URL('../components/briefing-feed.ts',import.meta.url));
async function flush(){for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));}
function recorder(){
 const calls:{includeSlow:boolean;reports:boolean|undefined}[]=[];
 const read=async(previous:FeedSnapshot,options:{includeSlow:boolean;reports?:boolean})=>{calls.push({includeSlow:options.includeSlow,reports:options.reports});const next=emptyFeedSnapshot();next.feeds.briefings={status:'ok',checkedAt:'2026-10-28T07:00:00.000Z'};return next;};
 return {calls,read};
}

test('several readers share one feed: one read to start, one per new revision, none after the last leaves',async()=>{
 const {calls,read}=recorder(),source=new FeedSource(read as never);
 const home=source.acquire(false),menu=source.acquire(false);await flush();
 assert.equal(calls.length,1,'a second reader joins the running feed instead of starting another');
 assert.equal(source.current().snapshot.feeds.briefings.status,'ok');
 source.observeRevision(4);source.observeRevision(4);await flush();
 assert.equal(calls.length,1,'the revision seen at start needs no second read');
 source.observeRevision(5);source.observeRevision(5);await flush();
 assert.equal(calls.length,2,'both readers see revision 5; the feed re-reads once');assert.equal(calls[1].includeSlow,true);
 home();home();menu();await flush();
 source.refresh();source.refreshSoon();await flush();
 assert.equal(calls.length,2,'no reads after the last reader releases');
});

test('saved technical reports are read only while a reader that shows them is open',async()=>{
 const {calls,read}=recorder(),source=new FeedSource(read as never);
 const home=source.acquire(false);await flush();assert.deepEqual(calls.map(call=>call.reports),[false]);
 const mission=source.acquire(true);await flush();assert.deepEqual(calls.map(call=>call.reports),[false,true],'opening Mission control reads the reports at once');
 mission();source.refreshSoon();await flush();assert.deepEqual(calls.map(call=>call.reports),[false,true,false]);
 home();
});

test('opening Mission control during a briefing-only read keeps the queued technical-report read',async()=>{
 const calls:{includeSlow:boolean;reports:boolean|undefined}[]=[];
 let complete!:()=>void;
 const source=new FeedSource(async(previous:FeedSnapshot,options:{includeSlow:boolean;reports?:boolean})=>{calls.push({includeSlow:options.includeSlow,reports:options.reports});if(calls.length===1)await new Promise<void>(resolve=>{complete=resolve;});return previous;});
 const home=source.acquire(false);await flush();
 const mission=source.acquire(true);await flush();
 assert.deepEqual(calls,[{includeSlow:true,reports:false}],'the existing read is not overlapped');
 try{complete();await flush();assert.deepEqual(calls,[{includeSlow:true,reports:false},{includeSlow:true,reports:true}],'Mission control gets slow reports immediately after Home finishes');}
 finally{mission();home();}
});

test('an expired session stops the shared feed and forgets what it read',async()=>{
 const {calls,read}=recorder(),source=new FeedSource(read as never),release=source.acquire(false);await flush();
 assert.equal(source.current().snapshot.feeds.briefings.status,'ok');
 page.window!.dispatchEvent(new Event('control-room-session-expired'));await flush();
 assert.equal(source.current().snapshot.feeds.briefings.status,'loading');assert.deepEqual(source.current().snapshot.briefings,[]);
 source.refresh();await flush();assert.equal(calls.length,1,'no read after expiry');
 release();
});
