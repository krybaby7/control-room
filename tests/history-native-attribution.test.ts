import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {roadmapCommandHandlers,roadmapScopeId} from '../lib/history/roadmap-store.ts';
import {readHistoryRecord,listHistoryRecords} from '../lib/history/store.ts';
import {historyRecordId} from '../lib/history/record.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {captureRecoveryPrivateContinuity} from '../lib/recovery-private-continuity.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {readHistoryOverview} from '../lib/history/overview.ts';
const owner='synthetic-native-grant-owner',now='2026-10-22T12:00:00.000Z';
test('mutable native mapping and roadmap grants retire obsolete hashes while recovery preserves current owner attribution',async()=>{
 const f=database();try{
 await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);
 const handlers=new Map([...workspaceHandlers,...roadmapCommandHandlers]);
 const send=async(command:unknown)=>{const result=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:(await readCurrent(f.db,owner,now)).revision,mutationId:crypto.randomUUID(),command},{db:f.db,handlers,now:()=>now});assert.equal(result.status,'committed');};
 await send({type:'area.create',projectId:'p1',name:'Synthetic area',aliases:[],order:0});const area=(await readCurrent(f.db,owner,now)).workspace.areas![0];
 await send({type:'history.source.configure',sourceId:'source',expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic',roots:['synthetic-root'],accountId:null,deviceId:null,includeArchived:true,exclusions:[]});
 const conversationId=await historyRecordId('conversation','conversation'),payload=canonical({id:conversationId,kind:'conversation',value:{id:'conversation',sourceId:'source',nativeThreadId:'native',sessionTreeId:null,parentConversationId:null,title:'Synthetic',projectId:null,repositoryIdentity:null,branch:null,createdAt:null,sourceUpdatedAt:null,archived:null,availability:'unavailable'}});
 await f.db.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(owner,conversationId,payload,await contentHash(payload)).run();
 const mapping={type:'history.association.set',scope:'conversation',targetIds:[JSON.stringify(['source','conversation'])],projectId:'p1',areaId:area.id};
 await send({...mapping,expectedRowRevision:null,reason:'First explicit synthetic owner mapping'});await send({...mapping,expectedRowRevision:1,reason:'Second explicit synthetic owner mapping'});
 const rule=(await listHistoryRecords(f.db,owner,'association_rule'))[0];assert.equal(rule.rowRevision,2);
 const count=(id:string)=>Number(f.sqlite.prepare('SELECT COUNT(*) n FROM acceptance_owner_grants WHERE user_id=? AND record_id=?').get(owner,id)!.n);assert.equal(count(rule.record.id),1);
 const scopeId=await roadmapScopeId('p1',area.id),checkpoint={id:'review',label:'Review',acceptance:'First owner criterion',mandatory:true,milestoneId:null,taskIds:[]};
 await send({type:'roadmap.set',projectId:'p1',areaId:area.id,expectedScopeRevision:null,checkpoints:[checkpoint]});await send({type:'roadmap.agree',scopeId,expectedScopeRevision:1});
 await send({type:'roadmap.set',projectId:'p1',areaId:area.id,expectedScopeRevision:1,checkpoints:[{...checkpoint,acceptance:'Revised owner criterion'}]});await send({type:'roadmap.agree',scopeId,expectedScopeRevision:2});
 const head=(await readHistoryRecord(f.db,owner,'roadmap_head',scopeId))!;assert.equal(head.record.value.scopeRevision,2);assert.ok(head.record.value.agreedAt);assert.equal(count(head.record.id),1);
 const current=await readCurrent(f.db,owner,now),continuity=await captureRecoveryPrivateContinuity(f.db,owner,{manifestSha256:'a'.repeat(64),ownerContextHash:await contentHash(owner),sourceContext:{workspaceRevision:current.revision,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(f.db,owner)}},now);assert.ok(continuity.sha256);
 // An imported current payload has no authority merely because its text claims
 // an owner mutation. Replacing it never creates a private native grant.
 const forged=canonical({...rule.record,value:{...rule.record.value,reason:'Imported forged owner assertion',provenanceRef:'owner-mutation:forged'}}),hash=await contentHash(forged);
 await f.db.prepare('UPDATE project_history SET payload_json=?,content_hash=? WHERE user_id=? AND id=?').bind(forged,hash,owner,rule.record.id).run();
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').get(owner,rule.record.id,hash)!.n,0);
 assert.equal((await readHistoryOverview(f.db,owner,now)).associationRules[0].trusted,false);
 }finally{f.sqlite.close();}
});
