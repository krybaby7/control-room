import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {ownerReader,OWNER_TABLES} from '../lib/workspace-modules.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {validateNormalizedMergePlan} from '../lib/normalized-merge-control.ts';
import {baselineControlStatements} from '../lib/baselines/transaction-controls.ts';
import {reviewControlStatements} from '../lib/reviews/transaction-controls.ts';
import type {MutationPlan} from '../lib/workspace-transaction.ts';
const now='2026-10-18T12:00:00.000Z',owner='compiler-merge-owner';
async function fixture(){
 const f=database(),before=await loadWorkspace(f.db,owner,()=>workspaceFixture(),now),rows=[];
 const query=ownerReader(f.db,owner);for(const module of OWNER_TABLES)for(const row of await query.list(module,{limit:200}))rows.push({module,id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,references:[]});
 const referenceSnapshot={coveredModules:[...OWNER_TABLES],rows,digest:await contentHash(canonical({coveredModules:[...OWNER_TABLES],rows}))};
 const value={id:'new-head',currentVersion:1,archivedAt:null},hash=await contentHash(canonical(value)),importHash='a'.repeat(64),reviewHash='b'.repeat(64);
 const plan:MutationPlan={normalizedMerge:{importHash,reviewHash,rows:[{module:'evidence',table:'evidence_records',id:value.id,beforeHash:null,afterHash:hash,disposition:'insert'}],verifiedAttachments:[]},referenceSnapshot,importSource:{id:'stage',hash:importHash},planningAfter:before.workspace,writes:[{table:'evidence_records',id:value.id,operation:'insert',expectedRowRevision:null,value}],events:[{id:'merge-event',kind:'workspace.import.commit',entityType:'workspace',entityId:null,changes:[],origin:'owner',actorId:owner,occurredAt:now,sourceRef:importHash,undoOf:null}],jobs:[],backup:{reason:'restore'},restoreEpoch:true};
 const command={type:'workspace.import.commit',mode:'merge',importId:'stage',hash:importHash,targetRevision:before.revision,normalizedReviewHash:reviewHash};
 return {...f,before,plan,command};
}
test('compiler admits exact insert-only merge and rejects hidden authority or changed reviewed body',async()=>{
 const f=await fixture();try{
  await validateNormalizedMergePlan(f.db,owner,f.before.revision,f.command,f.plan);
  await assert.rejects(()=>validateNormalizedMergePlan(f.db,owner,f.before.revision,f.command,{...f.plan,decisionGrants:[{id:'untrusted',version:1,hash:'c'.repeat(64)}]}));
  await assert.rejects(()=>validateNormalizedMergePlan(f.db,owner,f.before.revision,f.command,{...f.plan,writes:[{...f.plan.writes[0],value:{id:'new-head',currentVersion:2,archivedAt:null}}]}));
  await assert.rejects(()=>validateNormalizedMergePlan(f.db,owner,f.before.revision,{...f.command,normalizedReviewHash:'d'.repeat(64)},f.plan));
 }finally{f.sqlite.close();}
});
test('normalized merge preserves native baseline and read grants while full restore still revokes them',async()=>{
 const f=await fixture();try{
  // Inspect generated statements: native acknowledgement/read grants must never
  // be dropped merely because unrelated imported proposal rows are appended.
  const collect=async(plan:MutationPlan)=>{
   const sql:string[]=[];const db={...f.db,prepare:(source:string)=>{sql.push(source);return f.db.prepare(source);}};
   await baselineControlStatements(db,owner,plan,'workspace.import.commit','1',[],now);
   await reviewControlStatements(db,owner,plan,'workspace.import.commit','1',[],now);
   return sql.join('\n');
  };
  const merge=await collect(f.plan);assert.doesNotMatch(merge,/DELETE FROM (project_baseline_heads|review_ack_grants|notification_read_state)/u);assert.match(merge,/DELETE FROM review_analysis_consents/u);assert.match(merge,/DELETE FROM automation_capabilities/u);
  const full={...f.plan};delete full.normalizedMerge;const restore=await collect(full);assert.match(restore,/DELETE FROM project_baseline_heads/u);assert.match(restore,/DELETE FROM review_ack_grants/u);assert.match(restore,/DELETE FROM notification_read_state/u);
 }finally{f.sqlite.close();}
});
