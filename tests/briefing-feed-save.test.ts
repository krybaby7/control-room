import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import {loadClient} from './helpers/render-client.ts';
import {dashboardFixture,NOW} from './fixtures/dashboard.ts';
import type {WorkspaceCommand} from '../lib/workspace-protocol.ts';
import {WorkspaceRequestError} from '../lib/workspace-client.ts';

const {useBriefingFeed,useFeedModel}=await loadClient<typeof import('../components/briefing-feed')>(new URL('../components/briefing-feed.ts',import.meta.url));
type Deps=readonly unknown[]|undefined;
const same=(a:Deps,b:Deps)=>!!a&&!!b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
const internals=(React as unknown as {__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:{H:unknown}}).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
/** A tiny dispatcher runs the real hook's state, effects and external subscriptions, including
 * cleanup/remount. No save logic is copied here; network and browser events are the only seams. */
class HookProbe<T>{
 private slots:{value?:unknown;deps?:Deps;cleanup?:(()=>void)|void}[]=[];private cursor=0;private effects:(()=>void)[]=[];private active=true;private queued=false;value!:T;
 private readonly hook:()=>T;
 constructor(hook:()=>T){this.hook=hook;this.render();}
 private slot(){return this.slots[this.cursor++]??(this.slots[this.cursor-1]={});}
 private schedule=()=>{if(!this.active||this.queued)return;this.queued=true;queueMicrotask(()=>{this.queued=false;if(this.active)this.render();});};
 private dispatcher={
  useState:<V,>(initial:V|(()=>V))=>{const slot=this.slot();if(!('value'in slot))slot.value=typeof initial==='function'?(initial as ()=>V)():initial;return [slot.value,(next:V|((value:V)=>V))=>{const value=typeof next==='function'?(next as (value:V)=>V)(slot.value as V):next;if(!Object.is(value,slot.value)){slot.value=value;this.schedule();}}];},
  useRef:<V,>(initial:V)=>{const slot=this.slot();return slot.value??(slot.value={current:initial});},
  useMemo:<V,>(create:()=>V,deps:Deps)=>{const slot=this.slot();if(!same(slot.deps,deps)){slot.value=create();slot.deps=deps;}return slot.value;},
  useCallback:<V,>(callback:V,deps:Deps)=>this.dispatcher.useMemo(()=>callback,deps),
  useContext:()=>false,
  useEffect:(effect:()=>void|(()=>void),deps:Deps)=>{const slot=this.slot();if(!same(slot.deps,deps)){slot.deps=deps;this.effects.push(()=>{slot.cleanup?.();slot.cleanup=effect();});}},
  useSyncExternalStore:<V,>(subscribe:(listener:()=>void)=>()=>void,current:()=>V)=>{this.dispatcher.useEffect(()=>subscribe(this.schedule),[subscribe]);return current();},
 };
 private render(){this.cursor=0;const previous=internals.H;internals.H=this.dispatcher;try{this.value=this.hook();}finally{internals.H=previous;}for(const effect of this.effects.splice(0))effect();}
 unmount(){this.active=false;for(const slot of this.slots)slot.cleanup?.();}
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function flush(){for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));}
async function scenario(){
 const fixture=await dashboardFixture();
 const report={...fixture.briefings[0].briefing,run:{...fixture.briefings[0].briefing.run,id:'55555555-5555-4555-8555-555555555555'}};
 const completed={projectId:fixture.projectB,requestId:'synthetic-request',briefingSha256:'a'.repeat(64),briefing:report};
 const saved=[...fixture.briefings],connector={...fixture.connector,jobs:[],completedBriefing:completed};
 const originalFetch=globalThis.fetch,originalWindow=globalThis.window,originalDocument=globalThis.document;
 const windowEvents=Object.assign(new EventTarget(),{setInterval:()=>0,clearInterval:()=>{}});
 Object.assign(globalThis,{window:windowEvents,document:Object.assign(new EventTarget(),{visibilityState:'visible'})});
 globalThis.fetch=(async(input:RequestInfo|URL)=>{
  const routes:Record<string,unknown>={'/api/jobs':{...fixture.jobs,jobs:[]},'/api/runtime':{revision:3,ingress:'unverified',generatedAt:NOW,configurations:[],devices:[]},'/api/personal-repositories':connector,'/api/project-briefings':{revision:3,asOf:NOW,briefings:saved},'/api/local-analysis':{revision:3,asOf:NOW,reports:[]},'/api/github-analysis':{revision:3,asOf:NOW,reports:[]}};
  assert.ok(String(input) in routes,String(input));return new Response(JSON.stringify(routes[String(input)]),{status:200,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 const options={workspace:fixture.workspace,revision:3,busy:false,reports:false};
 const probes:HookProbe<unknown>[]=[];
 const anchor=new HookProbe(()=>useFeedModel(options));probes.push(anchor);await flush();
 const mount=(onCommand:(command:WorkspaceCommand)=>Promise<boolean>,sendAction:NonNullable<Parameters<typeof useBriefingFeed>[0]['sendAction']>)=>{const probe=new HookProbe(()=>useBriefingFeed({...options,onCommand,sendAction}));probes.push(probe);return probe;};
 return {fixture,report,saved,completed,anchor,mount,expire:()=>windowEvents.dispatchEvent(new Event('control-room-session-expired')),cleanup:()=>{windowEvents.dispatchEvent(new Event('control-room-session-expired'));for(const probe of probes)probe.unmount();globalThis.fetch=originalFetch;Object.assign(globalThis,{window:originalWindow,document:originalDocument});}};
}

test('Home save commits, then project remount with stale feed shares its held acknowledgment',async()=>{
 const s=await scenario(),ack=deferred<void>();let saves=0,acks=0;
 const save=async()=>{saves++;return true;},send=async()=>{acks++;await ack.promise;return {} as never;};
 try{
  const home=s.mount(save,send);await flush();assert.equal(saves,1);assert.equal(acks,1);
  home.unmount();const project=s.mount(save,send);await flush();
  assert.equal(saves,1,'navigation after commit must not issue another evidence save');assert.equal(acks,1,'the remount joins the in-flight ack');
  const retry=project.value.retrySave(s.fixture.projectB);await flush();assert.equal(saves,1);assert.equal(acks,1);ack.resolve();await retry;
 }finally{ack.resolve();s.cleanup();}
});

test('a lost save response survives navigation and retries the exact original command explicitly',async()=>{
 const s=await scenario(),commands:WorkspaceCommand[]=[];let acks=0;
 const save=async(command:WorkspaceCommand)=>{commands.push(command);return commands.length>1;},send=async()=>{acks++;return {} as never;};
 try{
  const home=s.mount(save,send);await flush();assert.equal(commands.length,1);assert.equal(acks,0);
  home.unmount();s.saved[0]={...s.saved[0],version:9};s.anchor.value.source.refreshSoon();await flush();
  const project=s.mount(save,send);await flush();
  assert.equal(commands.length,1,'unknown saves never retry automatically on navigation');assert.equal(project.value.notices[s.fixture.projectB]?.retry,true,'the original retry remains available');
  await project.value.retrySave(s.fixture.projectB);await flush();assert.equal(commands.length,2);assert.equal(commands[1],commands[0]);assert.equal(Object.isFrozen(commands[0]),true);assert.equal(acks,1);
 }finally{s.cleanup();}
});

test('confirmed save with failed ack retries ack only even after saved feed replaces unsaved model',async()=>{
 const s=await scenario();let saves=0,acks=0;
 const save=async()=>{saves++;return true;},send=async()=>{acks++;if(acks===1)throw new Error('Synthetic ack response lost');return {} as never;};
 try{
  const home=s.mount(save,send);await flush();home.unmount();
  s.saved[0]={...s.saved[0],briefing:s.report,version:2};s.anchor.value.source.refreshSoon();await flush();
  const project=s.mount(save,send);await flush();assert.equal(project.value.model.projects.find(p=>p.project.id===s.fixture.projectB)?.briefing.unsaved,null);
  assert.equal(acks,1,'ack retry is explicit across navigation');assert.equal(project.value.notices[s.fixture.projectB]?.retry,true);
  await Promise.all([project.value.retrySave(s.fixture.projectB),project.value.retrySave(s.fixture.projectB)]);await flush();
  assert.equal(saves,1,'a confirmed save is never submitted again');assert.equal(acks,2,'concurrent retry clicks send one ack');
  project.unmount();s.mount(save,send);await flush();assert.equal(acks,2,'acknowledged stale connector data is not acknowledged again');assert.equal(saves,1);
 }finally{s.cleanup();}
});

test('a conclusive save rejection releases the command for a reviewed explicit retry',async()=>{
 const s=await scenario(),commands:WorkspaceCommand[]=[];
 const save=async(command:WorkspaceCommand)=>{commands.push(command);if(commands.length===1)throw new WorkspaceRequestError('Synthetic conflict',409,'revision_conflict',true);return true;};
 try{
  const home=s.mount(save,async()=>({} as never));await flush();s.saved[0]={...s.saved[0],version:8};s.anchor.value.source.refreshSoon();await flush();
  await home.value.retrySave(s.fixture.projectB);assert.equal(commands.length,2);assert.notEqual(commands[1],commands[0]);assert.equal((commands[1] as {expectedVersion?:number}).expectedVersion,8);
 }finally{s.cleanup();}
});

test('session expiry forgets private recovery and blocks a pending save from acknowledging',async()=>{
 const s=await scenario(),saveResult=deferred<boolean>();let acks=0;
 try{
  s.mount(()=>saveResult.promise,async()=>{acks++;return {} as never;});await flush();s.expire();saveResult.resolve(true);await flush();assert.equal(acks,0,'an expired request cannot continue into the PC channel');
 }finally{s.cleanup();}
});

test('concurrent mounts and acknowledged stale results share a single completed request',async()=>{
 const s=await scenario(),result=deferred<boolean>();let saves=0,acks=0;
 const save=async()=>{saves++;return result.promise;},send=async()=>{acks++;return {} as never;};
 try{
  const home=s.mount(save,send),mission=s.mount(save,send);await flush();assert.equal(saves,1);assert.equal(acks,0);
  result.resolve(true);await flush();assert.equal(acks,1);assert.equal(s.anchor.value.source.current().snapshot.connector?.completedBriefing?.requestId,s.completed.requestId,'the connector deliberately stays stale');
  home.unmount();mission.unmount();const project=s.mount(save,send);await flush();await project.value.retrySave(s.fixture.projectB);
  assert.equal(saves,1);assert.equal(acks,1,'an acknowledged result stays guarded through remount and explicit calls');
 }finally{result.resolve(true);s.cleanup();}
});

test('an unconfirmed command still reconciles explicitly when its saved run becomes visible',async()=>{
 const s=await scenario(),commands:WorkspaceCommand[]=[];let acks=0;
 const save=async(command:WorkspaceCommand)=>{commands.push(command);return commands.length>1;};
 try{
  const home=s.mount(save,async()=>{acks++;return {} as never;});await flush();home.unmount();s.saved[0]={...s.saved[0],briefing:s.report,version:2};s.anchor.value.source.refreshSoon();await flush();
  const project=s.mount(save,async()=>{acks++;return {} as never;});await flush();assert.equal(commands.length,1);assert.equal(project.value.notices[s.fixture.projectB]?.retry,true);
  await project.value.retrySave(s.fixture.projectB);assert.equal(commands[1],commands[0]);assert.equal(acks,1);
 }finally{s.cleanup();}
});

test('expiry with no remaining feed reader still invalidates a pending save continuation',async()=>{
 const s=await scenario(),result=deferred<boolean>();let acks=0;
 try{
  const home=s.mount(()=>result.promise,async()=>{acks++;return {} as never;});await flush();home.unmount();s.anchor.unmount();s.expire();result.resolve(true);await flush();assert.equal(acks,0);
 }finally{result.resolve(true);s.cleanup();}
});

test('a completed save does not hide the working state of a new briefing request',async()=>{
 const s=await scenario(),request=deferred<void>();
 try{
  const home=s.mount(async()=>true,async action=>{if(action.action!=='ack')await request.promise;return {} as never;});await flush();
  const pending=home.value.brief(s.fixture.projectB,'repo-b','codex');await flush();assert.equal(home.value.working[s.fixture.projectB],true);request.resolve();await pending;
 }finally{request.resolve();s.cleanup();}
});
