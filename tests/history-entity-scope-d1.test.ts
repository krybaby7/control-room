import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import {workspaceFixture,taskFixture,milestoneFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readHistoryPage,type HistoryCursorSecurity} from '../lib/history.ts';
import {canonical} from '../lib/canonical-json.ts';
import type {AuditEventDraft,JsonValue} from '../lib/workspace-protocol.ts';
const owner='synthetic-native-history-owner',foreign='synthetic-native-history-foreign',badOwner='synthetic-native-history-malformed',now='2026-10-18T12:00:00.000Z';
const security:HistoryCursorSecurity={secret:new Uint8Array(32).fill(53),now:()=>now};
function historical(id:string,patch:Partial<AuditEventDraft>={}):AuditEventDraft{
 const value=milestoneFixture({id:'native-original',title:'Retained native original'});
 return {id,kind:'milestone.create',entityType:'milestone',entityId:null,changes:[{path:['milestones',value.id],before:{exists:false,value:null},after:{exists:true,value:value as unknown as JsonValue}}],origin:'owner',actorId:owner,occurredAt:now,sourceRef:null,undoOf:null,...patch};
}
test('actual27-migration D1 retains historical NULL identity and bulk-member scope with exact frozen pagination and no rewritten claims',{timeout:120000},async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated native history proof")}}',d1Databases:{DB:'synthetic-native-history'}});
 try{
  const db=await mf.getD1Database('DB'),migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();assert.equal(migrations.length,27);
  for(const name of migrations)for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();
  for(const user of [owner,foreign,badOwner])await loadWorkspace(db,user,()=>workspaceFixture({tasks:[taskFixture('native-first'),taskFixture('native-second')]}),now);
  const bulk=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'task.bulk',ids:['native-first','native-second'],patch:{priority:'high'}}},{db,handlers:workspaceHandlers,now:()=>now});assert.ok(bulk.status!=='conflict');
  const bulkBefore=await db.prepare("SELECT entity_id,payload_json FROM audit_events WHERE user_id=? AND kind='task.bulk'").bind(owner).first<{entity_id:string|null;payload_json:string}>();assert.ok(bulkBefore);assert.equal(bulkBefore.entity_id,null);
  for(const id of ['native-first','native-second']){
   const page=await readHistoryPage(db,owner,{filters:{entityType:'task',entityId:id}},security);
   assert.equal(page.entries.length,1);assert.equal(page.entries[0].entityId,null);assert.equal(page.entries[0].event!.entityId,null);assert.equal(page.entries[0].derivedEntityId,id);assert.equal(page.entries[0].kind,'task.bulk');
  }
  const insert=async(user:string,events:AuditEventDraft[],offset=100)=>{
   await db.prepare("INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,origin,actor_id,source_ref,undo_of,payload_json) SELECT ?,json_extract(value,'$.id'),1,CAST(key AS INTEGER)+?,json_extract(value,'$.kind'),json_extract(value,'$.entityType'),json_extract(value,'$.entityId'),json_extract(value,'$.occurredAt'),json_extract(value,'$.origin'),json_extract(value,'$.actorId'),json_extract(value,'$.sourceRef'),json_extract(value,'$.undoOf'),value FROM json_each(?)").bind(user,offset,canonical(events)).run();
  };
  await insert(owner,Array.from({length:55},(_,index)=>historical('native-retained-'+String(index).padStart(3,'0'))));
  await insert(foreign,[historical('foreign-original',{actorId:foreign})]);
  const change=historical('template').changes[0];
  await insert(owner,[
   historical('native-unknown',{kind:'imported-history'}),
   historical('native-ambiguous',{changes:[change,change]}),
   historical('native-field-path',{changes:[{...change,path:['milestones','native-original','title']}]}),
   historical('native-wrong-type',{entityType:'task'})
  ],200);
  await db.prepare("INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,'native-legacy',1,300,'milestone.create','milestone',NULL,?,?)").bind(owner,now,canonical({origin:'owner',changes:['primitive legacy source',7],text:'Original retained summary'})).run();
  const before=(await db.prepare('SELECT * FROM audit_events WHERE user_id=? ORDER BY event_id').bind(owner).all()).results;
  const seen:string[]=[];let cursor:string|null=null,pages=0;
  do{
   const page=await readHistoryPage(db,owner,{filters:{entityType:'milestone',entityId:'native-original'},...(cursor?{cursor}:{})},security);pages++;
   assert.equal(page.workspaceRevision,2);
   for(const entry of page.entries){assert.equal(entry.entityId,null);assert.equal(entry.event!.entityId,null);assert.equal(entry.derivedEntityId,'native-original');assert.ok(entry.id.startsWith('native-retained-'));seen.push(entry.id);}
   cursor=page.nextCursor;
  }while(cursor);
  assert.equal(pages,2);assert.equal(seen.length,55);assert.equal(new Set(seen).size,55);
  assert.equal((await readHistoryPage(db,foreign,{filters:{entityType:'task',entityId:'native-first'}},security)).entries.length,0);
  assert.equal((await readHistoryPage(db,owner,{filters:{entityId:'native-original'}},security)).entries.length,0);
  assert.deepEqual((await db.prepare('SELECT * FROM audit_events WHERE user_id=? ORDER BY event_id').bind(owner).all()).results,before);
  assert.deepEqual(await db.prepare("SELECT entity_id,payload_json FROM audit_events WHERE user_id=? AND kind='task.bulk'").bind(owner).first(),bulkBefore);
  const malformed=historical('native-malformed',{actorId:badOwner});malformed.changes[0].after.value={id:'different-original'};await insert(badOwner,[malformed]);
  const malformedBefore=await db.prepare("SELECT * FROM audit_events WHERE user_id=? AND event_id='native-malformed'").bind(badOwner).first();
  await assert.rejects(readHistoryPage(db,badOwner,{filters:{entityType:'milestone',entityId:'native-original'}},security),/Derived history attribution/);
  assert.deepEqual(await db.prepare("SELECT * FROM audit_events WHERE user_id=? AND event_id='native-malformed'").bind(badOwner).first(),malformedBefore);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').bind(owner).first<{n:number}>())!.n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').bind(badOwner).first<{n:number}>())!.n,0);
 }finally{await mf.dispose();}
});
