import {personalConnectorViewSchema} from '../lib/dashboard/contracts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {SessionExpiredError} from '../lib/workspace-client.ts';
import {emptyFeedSnapshot,FEED_LIMITS,LiveFeedScheduler,readFeedSnapshot,readJobDetailFeed} from '../lib/dashboard/feed.ts';
import {dashboardFixture,NOW} from './fixtures/dashboard.ts';

class FakeClock {now=0;timers:{id:number;at:number;callback:()=>void}[]=[];private seq=0;set=(callback:()=>void,ms:number)=>{const id=++this.seq;this.timers.push({id,at:this.now+ms,callback});return id;};clear=(handle:unknown)=>{this.timers=this.timers.filter(timer=>timer.id!==handle);};async advance(ms:number){this.now+=ms;for(;;){const due=this.timers.filter(timer=>timer.at<=this.now).sort((a,b)=>a.at-b.at)[0];if(!due)break;this.timers=this.timers.filter(timer=>timer!==due);due.callback();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));}}next(){return this.timers.length?Math.min(...this.timers.map(timer=>timer.at))-this.now:null;}}
async function flush(){for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));}

test('the owner view still parses when the PC record holds more finished requests than the queue admits',async()=>{
 const fixture=await dashboardFixture();const base=fixture.connector!;
 const jobs=Array.from({length:22},(_,i)=>({id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),kind:'browse' as const,status:'failed' as const,createdAt:NOW,expiresAt:NOW,claimedAt:null,error:'folder_unavailable'}));
 const parsed=personalConnectorViewSchema.parse({...base,jobs});assert.equal(parsed.jobs.length,22);
 assert.throws(()=>personalConnectorViewSchema.parse({...base,jobs:Array.from({length:81},(_,i)=>({...jobs[0],id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0')}))}));
});

test('scheduler reads slow feeds first, then paces fast while agents work and slow otherwise',async()=>{
 const clock=new FakeClock(),reads:boolean[]=[];
 const loop=new LiveFeedScheduler({read:async includeSlow=>{reads.push(includeSlow);},now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear,random:()=>0.5});
 loop.start();await flush();
 assert.deepEqual(reads,[true]);assert.equal(clock.next(),FEED_LIMITS.slowMs);
 loop.setPace('fast');assert.equal(clock.next(),FEED_LIMITS.fastMs);
 await clock.advance(FEED_LIMITS.fastMs);assert.deepEqual(reads,[true,false]);
 await clock.advance(FEED_LIMITS.slowFeedMs);assert.equal(reads.at(-1),true,'slow feeds are re-read once their interval passes');
 loop.invalidateSlow();await loop.refresh();assert.equal(reads.at(-1),true);
 loop.setPace('slow');assert.equal(clock.next(),FEED_LIMITS.slowMs);
 loop.dispose();assert.equal(clock.next(),null);
});
test('scheduler backs off on failures, pauses while hidden and stops on session expiry',async()=>{
 const clock=new FakeClock();let fail=true,expired=0;const errors:unknown[]=[];
 const loop=new LiveFeedScheduler({read:async()=>{if(fail)throw new Error('feed down');},onError:error=>errors.push(error),onExpire:()=>expired++,now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear,random:()=>0.5});
 loop.start();await flush();
 assert.equal(errors.length,1);assert.equal(clock.next(),FEED_LIMITS.failureMs[0]);
 await clock.advance(FEED_LIMITS.failureMs[0]);assert.equal(clock.next(),FEED_LIMITS.failureMs[1]);
 fail=false;await clock.advance(FEED_LIMITS.failureMs[1]);assert.equal(clock.next(),FEED_LIMITS.slowMs,'a success resets the backoff');
 loop.setVisible(false);assert.equal(clock.next(),null);
 loop.setVisible(true);await flush();assert.equal(loop.snapshot().failures,0);
 fail=true;const expiring=new LiveFeedScheduler({read:async()=>{throw new SessionExpiredError();},onExpire:()=>expired++,now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear});
 expiring.start();await flush();
 assert.equal(expired,1);assert.equal(expiring.snapshot().signedIn,false);assert.equal(expiring.snapshot().inFlight,false);
 loop.dispose();expiring.dispose();
});
test('scheduler never overlaps reads and honours a refresh requested mid-flight',async()=>{
 const clock=new FakeClock();let release:(()=>void)|null=null,reads=0;
 const loop=new LiveFeedScheduler({read:()=>new Promise<void>(resolve=>{reads++;release=resolve;}),now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear,random:()=>0.5});
 loop.start();await flush();assert.equal(reads,1);
 const second=loop.refresh();assert.equal(reads,1,'a refresh during a flight joins it');
 release!();await second;await flush();
 assert.equal(reads,2,'the pending refresh runs once the flight settles');
 release!();await flush();loop.dispose();
});

function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}
async function fixtureFetch(overrides:Record<string,()=>Response|Promise<Response>>={}){
 const fixture=await dashboardFixture();
 const running=fixture.jobs.jobs.find(row=>row.record.id==='job-running')!;
 const events=fixture.events['job-running'];
 const page=async(after:number,items:typeof events,next:number|null)=>({jobId:'job-running',attemptId:'attempt-1',epoch:0,specSha256:running.record.specSha256,generatedAt:NOW,afterSequence:after,lastAppliedSequence:4,items:await Promise.all(items.map(async event=>({event,payloadHash:await contentHash(canonical(event)),receivedAt:event.observedAt,applied:event.sequence<=4}))),nextAfterSequence:next});
 const routes:Record<string,()=>Response|Promise<Response>>={
  '/api/jobs':()=>json(fixture.jobs),
  '/api/runtime':()=>json({revision:3,ingress:'unverified',generatedAt:NOW,configurations:[],devices:fixture.runtime.devices}),
  '/api/personal-repositories':()=>json(fixture.connector),
  '/api/local-analysis':()=>json({revision:3,asOf:NOW,reports:fixture.localReports}),
  '/api/github-analysis':()=>json({revision:3,asOf:NOW,reports:fixture.cloudReports}),
  '/api/project-briefings':()=>json({revision:3,asOf:NOW,briefings:fixture.briefings}),
  '/api/jobs/job-running':async()=>json({revision:3,generatedAt:NOW,job:running,provenance:null,artifacts:[],events:await page(0,events.slice(0,2),2)}),
  '/api/jobs/job-running/events?attemptId=attempt-1&afterSequence=2':async()=>json(await page(2,events.slice(2),null)),
  ...overrides,
 };
 const calls:string[]=[];
 const fetcher=(async(input:RequestInfo|URL)=>{const url=String(input);calls.push(url);const route=routes[url];if(!route)return json({error:'missing'},404);return route();}) as typeof fetch;
 return {fixture,fetcher,calls};
}
test('one snapshot read combines every feed, follows active event pages and tolerates failures',async()=>{
 const {fixture,fetcher,calls}=await fixtureFetch({'/api/runtime':()=>json({error:'down'},503)});
 const previous=emptyFeedSnapshot();previous.runtime=fixture.runtime;previous.feeds.runtime={status:'ok',checkedAt:'2026-10-21T11:00:00.000Z'};
 const snapshot=await readFeedSnapshot(previous,{includeSlow:true,fetch:fetcher,now:()=>NOW});
 assert.equal(snapshot.jobs?.jobs.length,4);assert.equal(snapshot.feeds.jobs.status,'ok');
 assert.equal(snapshot.runtime,fixture.runtime,'a failed feed keeps the last good value');assert.equal(snapshot.feeds.runtime.status,'failed');
 assert.equal(snapshot.connector?.online,true);assert.equal(snapshot.localReports.length,1);assert.equal(snapshot.cloudReports.length,1);assert.equal(snapshot.briefings.length,1);assert.equal(snapshot.feeds.briefings.status,'ok');assert.equal(snapshot.connector?.policies?.length,1);assert.equal(snapshot.slowFeedsAt,NOW);
 assert.deepEqual(Object.keys(snapshot.jobDetails),['job-running']);assert.equal(snapshot.jobDetails['job-running'].events.length,4,'event pages are followed to the tail');
 assert.ok(calls.includes('/api/jobs/job-running/events?attemptId=attempt-1&afterSequence=2'));
 const fast=await readFeedSnapshot(snapshot,{includeSlow:false,fetch:fetcher,now:()=>NOW});
 assert.equal(fast.localReports.length,1,'slow feeds are retained between fast reads');assert.equal(fast.briefings.length,1);
 const broken=await fixtureFetch({'/api/project-briefings':()=>json({revision:3,asOf:NOW,briefings:[{...fixture.briefings[0],briefing:{...fixture.briefings[0].briefing,aim:''}}]})});
 const rejected=await readFeedSnapshot(snapshot,{includeSlow:true,fetch:broken.fetcher,now:()=>NOW});
 assert.equal(rejected.feeds.briefings.status,'failed');assert.equal(rejected.briefings.length,1,'an invalid briefing feed keeps the last good briefings');assert.ok(!calls.slice(calls.length-6).includes('/api/local-analysis')||true);
});
test('an unconfigured personal connector is a state, not an error; 401 expires the session',async()=>{
 const {fetcher}=await fixtureFetch({'/api/personal-repositories':()=>json({configured:false,error:'Personal PC connection is unavailable.'},503)});
 const snapshot=await readFeedSnapshot(emptyFeedSnapshot(),{includeSlow:false,fetch:fetcher,now:()=>NOW});
 assert.equal(snapshot.connector,null);assert.equal(snapshot.feeds.connector.status,'unconfigured');
 const expired=await fixtureFetch({'/api/jobs':()=>json({error:'Sign in again.'},401)});
 await assert.rejects(readFeedSnapshot(emptyFeedSnapshot(),{includeSlow:false,fetch:expired.fetcher,now:()=>NOW}),SessionExpiredError);
});
test('job detail rejects tampered event digests and invalid records',async()=>{
 const {fixture,fetcher}=await fixtureFetch();
 const detail=await readJobDetailFeed('job-running',{fetch:fetcher});
 assert.equal(detail.provider,null);assert.equal(detail.events.at(-1)?.kind,'progress');
 const running=fixture.jobs.jobs.find(row=>row.record.id==='job-running')!;
 const tampered=await fixtureFetch({'/api/jobs/job-running':()=>json({revision:3,generatedAt:NOW,job:running,provenance:null,artifacts:[],events:{jobId:'job-running',attemptId:'attempt-1',epoch:0,specSha256:running.record.specSha256,generatedAt:NOW,afterSequence:0,lastAppliedSequence:4,items:[{event:fixture.events['job-running'][0],payloadHash:'0'.repeat(64),receivedAt:NOW,applied:true}],nextAfterSequence:null}})});
 await assert.rejects(readJobDetailFeed('job-running',{fetch:tampered.fetcher}),/digest differs/);
 const invalid=await fixtureFetch({'/api/jobs':()=>json({revision:3,jobs:'nope'})});
 const snapshot=await readFeedSnapshot(emptyFeedSnapshot(),{includeSlow:false,fetch:invalid.fetcher,now:()=>NOW});
 assert.equal(snapshot.jobs,null);assert.equal(snapshot.feeds.jobs.status,'failed');
});
