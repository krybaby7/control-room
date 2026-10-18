import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {readPlanningModules,PLANNING_READ_KEYS} from '../lib/planning-read.ts';
import {canonical,contentHash} from '../lib/workspace-export.ts';
const now='2026-10-18T12:00:00.000Z';
async function fixture(){const result=database();for(const owner of ['a','b'])await loadWorkspace(result.db,owner,()=>createSeedWorkspace(now),now);return result;}
async function insertPlan(sqlite:ReturnType<typeof database>['sqlite'],owner:string,capacity=30){const value={weekStart:'2026-10-12',capacityMinutes:capacity,taskIds:[],revision:1};sqlite.prepare('INSERT INTO weekly_plans VALUES (?,?,?,?,?)').run(owner,value.weekStart,1,JSON.stringify(value),await contentHash(canonical(value)));return value;}

test('planning read returns exactly four bounded owner modules without full-export audit/backup coupling',async()=>{
 const {db,sqlite}=await fixture();await insertPlan(sqlite,'a');await insertPlan(sqlite,'b',999);
 sqlite.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,kind,entity_type,occurred_at,payload_json) SELECT 'a','synthetic-'||x,1,x,'fixture','task','2026-10-18T00:00:00Z','{}' FROM n");
 const queries:string[]=[];const restricted:SqlDatabase={...db,prepare(sql){queries.push(sql);assert.doesNotMatch(sql,/audit_events|workspace_backups|workspaces\.content/);return db.prepare(sql);}};const result=await readPlanningModules(restricted,'a');assert.deepEqual(Object.keys(result.modules),[...PLANNING_READ_KEYS]);assert.equal(result.modules.weekly_plans.records.length,1);assert.equal((result.modules.weekly_plans.records[0].value as {capacityMinutes:number}).capacityMinutes,30);assert.equal(result.revision,1);assert.ok(queries.length>8);assert.ok(!JSON.stringify(result).includes('999'));assert.equal(sqlite.prepare('SELECT count(*) AS n FROM audit_events').get()!.n,10001);
});

test('owner scoping and bound parameters reveal no foreign rows or owner identities',async()=>{
 const {db,sqlite}=await fixture();await insertPlan(sqlite,'b');assert.equal((await readPlanningModules(db,'a')).modules.weekly_plans.records.length,0);await assert.rejects(readPlanningModules(db,"a' OR 1=1 --"),/unavailable/);await assert.rejects(readPlanningModules(db,''),/signed-in/);const result=await readPlanningModules(db,'b');assert.equal(result.modules.weekly_plans.records.length,1);assert.ok(!JSON.stringify(result).includes('user_id'));
});

test('strict module row codecs reject bad hashes, row identities, unknown fields and malformed values',async()=>{
 const {db,sqlite}=await fixture();const value=await insertPlan(sqlite,'a');sqlite.prepare("UPDATE weekly_plans SET content_hash=? WHERE user_id='a'").run('0'.repeat(64));await assert.rejects(readPlanningModules(db,'a'),/digest/);sqlite.prepare("UPDATE weekly_plans SET content_hash=?,id='wrong' WHERE user_id='a'").run(await contentHash(canonical(value)));await assert.rejects(readPlanningModules(db,'a'),/identity/);
 const invalid={...value,unexpected:true};sqlite.prepare("UPDATE weekly_plans SET id=?,payload_json=?,content_hash=? WHERE user_id='a'").run(value.weekStart,JSON.stringify(invalid),await contentHash(canonical(invalid)));await assert.rejects(readPlanningModules(db,'a'));
});

test('same-revision module mutation between first and verification reads retries to one exact stable snapshot',async()=>{
 const {db,sqlite}=await fixture();const old=await insertPlan(sqlite,'a');const value={...old,capacityMinutes:70,revision:2};const hash=await contentHash(canonical(value));let reads=0;
 const raced:SqlDatabase={...db,prepare(sql){const statement=db.prepare(sql);if(sql.includes('FROM weekly_plans WHERE')){const all=statement.all.bind(statement);statement.all=async<T>()=>{const result=await all<T>();if(++reads===1)sqlite.prepare("UPDATE weekly_plans SET row_revision=2,payload_json=?,content_hash=? WHERE user_id='a'").run(JSON.stringify(value),hash);return result;};}return statement;}};
 const result=await readPlanningModules(raced,'a');assert.equal((result.modules.weekly_plans.records[0].value as {capacityMinutes:number}).capacityMinutes,70);assert.equal(result.modules.weekly_plans.records[0].rowRevision,2);assert.ok(reads>=4);
});

test('workspace revision changes during read retry instead of presenting a mixed revision',async()=>{
 const {db,sqlite}=await fixture();await insertPlan(sqlite,'a');let fired=false;const raced:SqlDatabase={...db,prepare(sql){const statement=db.prepare(sql);if(sql.includes('FROM recurrence_occurrences WHERE')){const all=statement.all.bind(statement);statement.all=async<T>()=>{const result=await all<T>();if(!fired){fired=true;sqlite.prepare("UPDATE workspaces SET revision=2 WHERE user_id='a'").run();}return result;};}return statement;}};assert.equal((await readPlanningModules(raced,'a')).revision,2);
});

test('continuously changing sources exhaust bounded retry attempts and never emit a mixed snapshot',async()=>{
 const {db,sqlite}=await fixture();const old=await insertPlan(sqlite,'a');let reads=0;const raced:SqlDatabase={...db,prepare(sql){const statement=db.prepare(sql);if(sql.includes('FROM weekly_plans WHERE')){const all=statement.all.bind(statement);statement.all=async<T>()=>{const result=await all<T>();const value={...old,capacityMinutes:++reads,revision:reads+1};sqlite.prepare("UPDATE weekly_plans SET row_revision=?,payload_json=?,content_hash=? WHERE user_id='a'").run(reads+1,JSON.stringify(value),await contentHash(canonical(value)));return result;};}return statement;}};await assert.rejects(readPlanningModules(raced,'a'),/changed during read/);assert.equal(reads,6);
});

test('planning reader rejects oversized bytes and excessive module rows before returning partial data',async()=>{
 const {db,sqlite}=await fixture();sqlite.prepare('INSERT INTO weekly_plans VALUES (?,?,?,?,?)').run('a','large',1,JSON.stringify({text:'x'.repeat(8_000_001)}),'a'.repeat(64));await assert.rejects(readPlanningModules(db,'a'),/bounded read limit/);sqlite.prepare('DELETE FROM weekly_plans').run();
 sqlite.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO weekly_plans(user_id,id,row_revision,payload_json,content_hash) SELECT 'a',printf('row-%05d',x),1,'{}','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' FROM n");await assert.rejects(readPlanningModules(db,'a'),/bounded read limit/);
});
