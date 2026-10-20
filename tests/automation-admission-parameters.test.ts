import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import type {SqlDatabase,SqlStatement} from '../lib/workspace-store.ts';
import {scheduledSourceServiceScenario,scheduledSourceServiceFixture} from '../scripts/test-scheduled-source-d1.mjs';
import {admitDueAutomation,readAutomationRuntime} from '../lib/automations/store.ts';

/** Enforce D1's real per-statement parameter limit while forwarding every SQL operation. */
function parameterBounded(db:SqlDatabase,beforeAdmission?:()=>void){
 const statements=new WeakMap<SqlStatement,{sql:string;parameters:number}>();const admissionParameters:number[]=[];
 const wrapped:SqlDatabase={prepare(sql){const statement=db.prepare(sql);return new Proxy(statement,{get(target,key){if(key==='bind')return(...values:(string|number|null)[])=>{assert.ok(values.length<=100,'Native D1 permits at most 100 bound parameters per statement.');const bound=target.bind(...values);statements.set(bound,{sql,parameters:values.length});return bound;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});},async batch(batch){const admission=batch.map(statement=>statements.get(statement)).find(value=>value?.sql.includes('INSERT INTO workspace_command_guards')&&value.sql.includes('automation_admission_values'));if(admission){admissionParameters.push(admission.parameters);beforeAdmission?.();}return db.batch(batch);}};
 return {db:wrapped,admissionParameters};
}
test('scheduled native service completes bounded pages and exact replay within D1 parameter limits',async()=>{
 const f=database();try{const bounded=parameterBounded(f.db);await scheduledSourceServiceScenario(bounded.db,'synthetic-bound-source');assert.deepEqual(bounded.admissionParameters,[4]);}finally{f.sqlite.close();}
});
test('compacted admission still atomically rechecks both authorities, source body and workspace revision',async()=>{
 for(const defect of ['automation','source','body','revision']){
  const f=database();try{
   const fixture=await scheduledSourceServiceFixture(f.db,'synthetic-bound-race');
   const before=await readAutomationRuntime(f.db,fixture.owner,fixture.scheduleId);let fired=false;
   const bounded=parameterBounded(f.db,()=>{assert.equal(fired,false);fired=true;
    if(defect==='automation')f.sqlite.prepare('UPDATE integration_service_principals SET revoked_at=? WHERE user_id=? AND id=?').run(fixture.now(),fixture.owner,fixture.principal.principalId);
    if(defect==='source')f.sqlite.prepare('UPDATE source_access_grants SET revoked_at=? WHERE user_id=?').run(fixture.now(),fixture.owner);
    if(defect==='body')f.sqlite.prepare("UPDATE source_targets SET payload_json=json_set(payload_json,'$.providerResourceId',?) WHERE user_id=?").run('synthetic/changed?literal',fixture.owner);
    if(defect==='revision')f.sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run(fixture.owner);
   });
   const result=await admitDueAutomation(bounded.db,fixture.owner,fixture.scheduleId,{now:fixture.now(),principalId:fixture.principal.principalId});
   assert.equal(fired,true,defect);assert.deepEqual(bounded.admissionParameters,[4]);assert.deepEqual(result,{status:'blocked',reason:'changed_or_duplicate'});
   for(const table of ['workspace_job_intents','integration_jobs','automation_occurrence_claims','workspace_command_guards'])assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(fixture.owner)!.n,0,defect);
   assert.deepEqual(await readAutomationRuntime(f.db,fixture.owner,fixture.scheduleId),before);
  }finally{f.sqlite.close();}
 }
});
