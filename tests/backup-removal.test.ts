import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareBackupRemoval,prepareBackupRemovalCommand,type BackupRemovalReader} from '../lib/backup-removal.ts';
import type {BackupManifest} from '../lib/workspace-backups.ts';
import type {PrepareContext} from '../lib/workspace-transaction.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
const now='2026-10-18T12:00:00.000Z';
function point(id:string,revision=1,createdAt=now):BackupManifest{return {id,ownerScope:'a',sourceRevision:revision,reason:'manual',createdAt,formatVersion:1,bytes:1,sha256:(id==='first'?'a':'b').repeat(64),storageKind:'d1',storageKey:id,status:'ready',expiresAt:null,completeModules:['planning','audit_events'],missingAttachments:[]};}
const first=point('first'),second=point('second',2);
function context(list:BackupManifest[]=[first,second]):PrepareContext & {backups:BackupRemovalReader} {
 const workspace=createSeedWorkspace(now);
 return {userId:'a',before:{workspace,revision:3,updatedAt:now},command:{type:'workspace.backup.remove',id:first.id,sha256:first.sha256,targetRevision:3},now,query:{async get(){return null;},async list(){return [];}},async readImport(){throw new Error('Not used');},backups:{async list(){return list.map(manifest=>({...manifest,pinned:true}));},async get(id){const manifest=list.find(item=>item.id===id);return manifest?{manifest,bundle:{format:'control-room',bundleVersion:1,exportedAt:now,source:{workspaceRevision:manifest.sourceRevision,planningSchemaVersion:workspace.schemaVersion,moduleWatermarks:{},sourceHashes:{}},planning:workspace,modules:{},attachments:[],completeness:'metadata-only'},content:'x',pinned:true}:null;}}};
}
test('sole, older, failed or incomplete recovery points cannot authorize removal',()=>{
 for(const list of [[first],[first,point('older',1,'2026-10-17T12:00:00.000Z')],[first,{...second,status:'failed' as const}],[first,{...second,missingAttachments:['missing']}],[first,{...second,ownerScope:'b'}]])assert.throws(()=>prepareBackupRemoval(list,'first',first.sha256),/newer/);
 assert.throws(()=>prepareBackupRemoval([first,second],'first','c'.repeat(64)),/digest/);assert.throws(()=>prepareBackupRemoval([first,first,second],'first',first.sha256),/Duplicate/);
});
test('newer revision or later same-revision snapshot permits explicit pinned/manual removal without eviction',async()=>{
 const list=[first,second];const original=structuredClone(list);const selected=prepareBackupRemoval(list,'first',first.sha256);assert.equal(selected.newer.id,'second');selected.newer.id='client edit';assert.deepEqual(list,original);
 assert.equal(prepareBackupRemoval([first,point('later',1,'2026-10-18T12:00:01.000Z')],'first',first.sha256).newer.id,'later');
 const ctx=context();const plan=await prepareBackupRemovalCommand(ctx);assert.deepEqual(plan.backupRemoval,{id:'first',sha256:first.sha256,newerId:'second',newerSha256:second.sha256});assert.equal(plan.planningAfter,ctx.before.workspace);assert.deepEqual(plan.writes,[]);assert.deepEqual(plan.jobs,[]);assert.equal(plan.backup,undefined);assert.equal(plan.events[0].actorId,'a');assert.equal((await ctx.backups.list()).length,2);
});
test('stale, malformed, foreign owner, missing and changed independently verified lookup rejects',async()=>{
 const base=context();for(const patch of [{command:{...base.command,targetRevision:2}},{command:{...base.command,sha256:'c'.repeat(64)}},{command:{...base.command,approval:true}},{userId:'b'},{backups:undefined}])await assert.rejects(prepareBackupRemovalCommand({...base,...patch}));
 await assert.rejects(prepareBackupRemovalCommand({...base,backups:{...base.backups,async get(){return null;}}}),/available/);
 const originalGet=base.backups.get;await assert.rejects(prepareBackupRemovalCommand({...base,backups:{...base.backups,async get(id){const result=await originalGet(id);return result?{...result,manifest:{...result.manifest,ownerScope:'b'}}:null;}}}),/available/);
 await assert.rejects(prepareBackupRemovalCommand({...base,backups:{...base.backups,async get(id){const result=await originalGet(id);return result&&id==='second'?{...result,manifest:{...result.manifest,sha256:'c'.repeat(64)}}:result;}}}),/changed/);
});
