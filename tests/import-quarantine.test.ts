import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportQuarantine } from '../lib/import-quarantine.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { contentHash } from '../lib/workspace-export.ts';
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const now='2026-10-18T12:00:00.000Z';
test('invalid content is retained owner-scoped until bounded TTL with immutable digest',async()=>{
 let clock=1;const q=new ImportQuarantine({now:()=>clock,ttlMs:100,maxStages:1});const raw=new Uint8Array([255]);const stage=await q.stage('a',raw);raw[0]=0;
 assert.equal(stage.hash,await contentHash(new Uint8Array([255])));assert.equal(stage.diagnostics[0].code,'invalid-utf8-or-json');assert.deepEqual(q.download('a',stage.id),new Uint8Array([255]));assert.throws(()=>q.get('b',stage.id));await assert.rejects(q.stage('a',bytes({})),/capacity/);clock=101;assert.throws(()=>q.get('a',stage.id),/expired/);
});
test('legacy planning dry-run reports identities and stale preview; no active mutation',async()=>{
 const planning=createSeedWorkspace(now);const before=structuredClone(planning);planning.projects[0].goal='Reviewed import';const q=new ImportQuarantine();const stage=await q.stage('a',bytes(planning));assert.deepEqual(stage.diagnostics,[]);
 const current={workspace:before,revision:9,updatedAt:now};const preview=q.preview('a',stage.id,current);assert.deepEqual(preview.diff['planning.projects'].changed,[planning.projects[0].id]);assert.equal(current.workspace.projects[0].goal,before.projects[0].goal);assert.throws(()=>q.parsedForReview('a',stage.id,stage.hash,9,10),/stale/);const copy=q.parsedForReview('a',stage.id,stage.hash,9,9);copy.planning.projects[0].goal='client edit';assert.equal(q.get('a',stage.id).bundle!.planning.projects[0].goal,'Reviewed import');q.cancel('a',stage.id);assert.throws(()=>q.get('a',stage.id));
});
test('orphan references and unknown bundle versions stay quarantined',async()=>{
 const q=new ImportQuarantine();const planning=createSeedWorkspace(now);planning.tasks[0].projectId='missing';const stage=await q.stage('a',bytes(planning));assert.equal(stage.bundle,null);assert.equal(stage.diagnostics.length,1);const unknown=await q.stage('a',bytes({format:'control-room',bundleVersion:999}));assert.equal(unknown.bundle,null);
});
