import {PRIVATE_REVOCATION_POOL} from '../lib/private-capacity.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand,type CommandHandlerRegistry} from '../lib/workspace-transaction.ts';
import {RECEIPT_CAPACITY,WorkspaceCapacityError,receiptCount} from '../lib/workspace-capacity.ts';
const now='2026-10-18T12:00:00.000Z',command={type:'fixture.capacity'};
const input=(mutationId='capacity-command-0001',expectedRevision=1)=>({protocolVersion:1,expectedRevision,mutationId,command});
const handlers:CommandHandlerRegistry=new Map([['fixture.capacity',{async prepare(context){
 const planningAfter=structuredClone(context.before.workspace);planningAfter.projects[0].goal='Explicit change at capacity boundary';
 return {planningAfter,writes:[],jobs:[],events:[{id:'capacity-event',kind:'fixture.capacity',entityType:'project',entityId:planningAfter.projects[0].id,changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}]};
}}]]);
const deps=(db:SqlDatabase)=>({db,handlers,now:()=>now});
async function fixture(){const f=database();for(const owner of ['a','b'])await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);return f;}
function seedReceipts(sqlite:ReturnType<typeof database>['sqlite'],owner:string,count:number){
 if(count<1)return;
 sqlite.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<?)
 INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at)
 SELECT ?,printf('00000000-0000-4000-8000-%012d',n),?,1,? FROM sequence`).run(count,owner,'a'.repeat(64),now);
 // Any unrequested eviction would make these tests fail, even if a later insert replaced its count.
 sqlite.exec("CREATE TRIGGER IF NOT EXISTS reject_receipt_deletion BEFORE DELETE ON workspace_mutations BEGIN SELECT RAISE(ABORT,'legacy receipts must remain'); END;");
}
function rows(sqlite:ReturnType<typeof database>['sqlite'],table:string,owner='a'){return sqlite.prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY 1,2`).all(owner);}
function effects(sqlite:ReturnType<typeof database>['sqlite'],owner='a'){return ['workspaces','audit_events','workspace_job_intents','workspace_command_guards','workspace_assertions'].map(table=>rows(sqlite,table,owner));}
test('hard receipt cap preserves every legacy receipt, planning and audit record',async()=>{
 const {db,sqlite}=await fixture();seedReceipts(sqlite,'a',RECEIPT_CAPACITY.hard);const before=effects(sqlite),receipts=rows(sqlite,'workspace_mutations');
 await assert.rejects(executeWorkspaceCommand('a',input(),deps(db)),error=>error instanceof WorkspaceCapacityError&&error.code==='receipt_capacity');
 assert.deepEqual(effects(sqlite),before);assert.deepEqual(rows(sqlite,'workspace_mutations'),receipts);assert.equal(await receiptCount(db,'a'),100000);sqlite.close();
});
test('unchanged replay at the hard cap succeeds exactly once despite stale expected revision',async()=>{
 const {db,sqlite}=await fixture();const first=await executeWorkspaceCommand('a',input(),deps(db));assert.equal(first.status,'committed');
 seedReceipts(sqlite,'a',RECEIPT_CAPACITY.hard-1);const before=effects(sqlite),receipts=rows(sqlite,'workspace_mutations');
 const replay=await executeWorkspaceCommand('a',input(),deps(db));assert.equal(replay.status,'replayed');assert.equal(replay.receipt.appliedRevision,2);
 assert.deepEqual(effects(sqlite),before);assert.deepEqual(rows(sqlite,'workspace_mutations'),receipts);assert.equal(rows(sqlite,'audit_events').length,1);sqlite.close();
});
test('one owner reaching capacity does not consume another owner quota',async()=>{
 const {db,sqlite}=await fixture();seedReceipts(sqlite,'a',RECEIPT_CAPACITY.hard);const a=effects(sqlite),receipts=rows(sqlite,'workspace_mutations');
 const result=await executeWorkspaceCommand('b',input(),deps(db));assert.equal(result.status,'committed');assert.equal(await receiptCount(db,'b'),1);assert.equal((await readCurrent(db,'b')).revision,2);
 assert.deepEqual(effects(sqlite),a);assert.deepEqual(rows(sqlite,'workspace_mutations'),receipts);sqlite.close();
});
test('late independent receipt pressure fills the hard cap at the actual mutation batch and rolls every intended effect back',async()=>{
 const {db,sqlite}=await fixture();seedReceipts(sqlite,'a',RECEIPT_CAPACITY.hard-PRIVATE_REVOCATION_POOL.rows-1);
 const before=effects(sqlite),receipts=rows(sqlite,'workspace_mutations'),lateIds=new Set<string>();let intercepted=false;
 const sqlByStatement=new WeakMap<import('../lib/workspace-store.ts').SqlStatement,string>();
 const raced:SqlDatabase={prepare(sql){const statement=db.prepare(sql);sqlByStatement.set(statement,sql);return statement;},async batch(statements){
  if(statements.some(statement=>sqlByStatement.get(statement)?.startsWith('INSERT INTO workspace_command_guards'))){
   assert.equal(intercepted,false);intercepted=true;
   const insert=sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)');
   for(let index=0;index<=PRIVATE_REVOCATION_POOL.rows;index++){const id='late-independent-receipt-'+index;lateIds.add(id);insert.run('a',id,'b'.repeat(64),1,now);}
  }
  return db.batch(statements);
 }};
 await assert.rejects(executeWorkspaceCommand('a',input(),deps(raced)),WorkspaceCapacityError);
 assert.equal(intercepted,true);assert.equal(lateIds.size,21);assert.deepEqual(effects(sqlite),before);
 assert.deepEqual(rows(sqlite,'workspace_mutations').filter(row=>!lateIds.has(row.mutation_id as string)),receipts);
 assert.equal(await receiptCount(db,'a'),RECEIPT_CAPACITY.hard);
 assert.equal(sqlite.prepare('SELECT mutation_id FROM workspace_mutations WHERE user_id=? AND mutation_id=?').get('a',input().mutationId),undefined);
 sqlite.close();
});
