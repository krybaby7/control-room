import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reviewSourceFreshness,reviewSourceWatermark} from '../lib/reviews/freshness.ts';
import type {SourceTarget,SourceSyncState,SourceObservation} from '../lib/sources/contracts.ts';
const now='2026-10-18T12:00:00.000Z';
const target:SourceTarget={id:'source',connectionId:'connection',projectId:'p1',kind:'document',providerResourceId:'document',canonicalUrl:null,selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null};
const state:SourceSyncState={sourceId:'source',operationalRevision:1,configurationHash:'a'.repeat(64),executionEpoch:0,paused:false,cursor:null,etag:null,attemptedAt:'2026-10-18T11:30:00.000Z',lastSuccessAt:'2026-10-18T11:00:00.000Z',lastSourceRevision:'revision',failure:null,retryAt:null,failureCount:0};
const observation:SourceObservation={id:'observation',sourceId:'source',externalId:'document',sourceRevision:'revision',sourceUpdatedAt:null,observedAt:'2026-10-18T11:00:00.000Z',title:'Source context',canonicalUrl:null,contentDigest:'b'.repeat(64),payload:{text:'Context'},origin:'manual-import'};
const read=(patch:Partial<Parameters<typeof reviewSourceFreshness>[0]>={})=>reviewSourceFreshness({target,state,observations:[observation],now,...patch});
test('freshness expires at the exact configured boundary without inventing source dates',()=>{
 assert.equal(read({now:'2026-10-18T11:59:59.999Z'}).reason,'fresh');
 const result=read();assert.equal(result.reason,'expired');assert.equal(result.ageSeconds,3600);assert.equal(result.sourceUpdatedAt,null);assert.equal(result.observedAt,observation.observedAt);assert.equal(result.lastSuccessAt,state.lastSuccessAt);assert.equal(result.attemptedAt,state.attemptedAt);
});
test('failed attempts and retry timestamps never replace the last good success',()=>{
 const failed={...state,failure:'rate_limited' as const,failureCount:1,retryAt:'2026-10-18T12:05:00.000Z',attemptedAt:now};
 const value=read({state:failed});assert.equal(value.reason,'failed');assert.equal(value.lastSuccessAt,state.lastSuccessAt);assert.equal(value.retryAt,failed.retryAt);assert.equal(value.failure,'rate_limited');
 assert.equal(read({state:{...state,lastSuccessAt:null},observations:[]}).reason,'never_succeeded');
});
test('paused/archived sources and clocks in the future remain visibly stale',()=>{
 assert.equal(read({state:{...state,paused:true}}).reason,'paused');assert.equal(read({target:{...target,archivedAt:now}}).reason,'archived');
 assert.equal(read({state:{...state,lastSuccessAt:'2026-10-18T12:00:01.000Z'}}).reason,'clock_mismatch');assert.equal(read({observations:[{...observation,observedAt:'2026-10-18T12:00:01.000Z'}]}).reason,'clock_mismatch');
});
test('source watermark hashes a sorted exact set, not merely its latest timestamp',async()=>{
 const a={id:'a',contentDigest:'a'.repeat(64)},b={id:'b',contentDigest:'b'.repeat(64)};
 assert.equal(await reviewSourceWatermark([a,b]),await reviewSourceWatermark([b,a,a]));assert.notEqual(await reviewSourceWatermark([a]),await reviewSourceWatermark([a,b]));assert.notEqual(await reviewSourceWatermark([a]),await reviewSourceWatermark([{...a,contentDigest:'c'.repeat(64)}]));
 await assert.rejects(reviewSourceWatermark([a,{...a,contentDigest:'c'.repeat(64)}]),/conflicting/);
});
test('cross-source state/observation identities fail closed',()=>{
 assert.throws(()=>read({state:{...state,sourceId:'foreign'}}),/exact source/);assert.throws(()=>read({observations:[{...observation,sourceId:'foreign'}]}),/another source/);
});
