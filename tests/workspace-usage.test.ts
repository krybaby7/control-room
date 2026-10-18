import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {readWorkspaceUsage,RECEIPT_RETENTION_POLICY} from '../lib/workspace-usage.ts';
import {type SqlDatabase} from '../lib/workspace-store.ts';
const now='2026-10-18T12:00:00.000Z';
const old='2026-08-01T12:00:00.000Z';
const future='2026-11-01T12:00:00.000Z';
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
function fixtures(){
 const result=database();const {sqlite}=result;
 for(const owner of ['private-owner-a','private-owner-b']){
  sqlite.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run(owner,'{}',1,now);
  for(const [id,at]of [['legacy-receipt-0001',old],[`m1_${'a'.repeat(32)}_${'b'.repeat(32)}`,now]])sqlite.prepare('INSERT INTO workspace_mutations VALUES (?,?,?,?,?)').run(owner,id,'c'.repeat(64),2,at);
  for(const [epoch,status,retired]of [['a'.repeat(32),'active',null],['b'.repeat(32),'retired',now]])sqlite.prepare('INSERT INTO workspace_mutation_epochs VALUES (?,?,?,?,?)').run(owner,epoch,status,old,retired);
  for(const [id,expiry]of [['active-draft',future],['expired-draft',now]])sqlite.prepare('INSERT INTO workspace_drafts VALUES (?,?,?,?,?)').run(owner,id,1,JSON.stringify({text:'مرحبا 👋'}),expiry);
  for(const [id,expiry,rawBytes]of [['active-import',future,3],['expired-import',now,5]] as const){sqlite.prepare('INSERT INTO workspace_imports VALUES (?,?,?,?,?,?,?)').run(owner,id,'c'.repeat(64),old,expiry,rawBytes,'{}');sqlite.prepare('INSERT INTO workspace_import_chunks VALUES (?,?,?,?)').run(owner,id,0,'YWJj');}
  sqlite.prepare('INSERT INTO workspace_backups VALUES (?,?,?,?,?,?,?,?,?,?)').run(owner,'snapshot',1,now,'manual',123,'c'.repeat(64),'{}','ready',1);
  sqlite.prepare('INSERT INTO evidence_records VALUES (?,?,?,?,?)').run(owner,'evidence',1,JSON.stringify({text:'é🙂'}),'c'.repeat(64));
  sqlite.prepare("INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,kind,entity_type,occurred_at,payload_json) VALUES (?, ?,1,0,'fixture','workspace',?,?)").run(owner,'event',now,'{}');
 }
 sqlite.prepare('INSERT INTO workspace_mutations VALUES (?,?,?,?,?)').run('private-owner-b','foreign-extra-receipt','d'.repeat(64),3,now);
 return result;
}

test('owner usage reports receipt bytes, recent retry counts, epoch tombstones and explicit disabled maintenance policy',async()=>{
 const {db}=fixtures();const usage=await readWorkspaceUsage(db,'private-owner-a',now);
 assert.equal(usage.receipts.count,2);assert.equal(usage.receipts.legacyCount,1);assert.equal(usage.receipts.epochCount,1);assert.equal(usage.receipts.recentCount,1);assert.equal(usage.receipts.olderCount,1);assert.equal(usage.receipts.recentSince,'2026-09-18T12:00:00.000Z');
 assert.equal(usage.receipts.bytes,bytes('legacy-receipt-0001')+bytes(`m1_${'a'.repeat(32)}_${'b'.repeat(32)}`)+128+bytes(now)+bytes(old)+16);
 assert.equal(usage.epochs.count,2);assert.equal(usage.epochs.activeCount,1);assert.equal(usage.epochs.retiredCount,1);assert.ok(usage.epochs.bytes>0);
 assert.deepEqual(usage.receiptPolicy,RECEIPT_RETENTION_POLICY);assert.equal(usage.receiptPolicy.legacyReceiptRetention,'indefinite');assert.equal(usage.receiptPolicy.epochTombstoneRetention,'permanent');assert.equal(usage.receiptPolicy.bulkDetailCompaction,'internal-only-after-retirement-and-draft-guard');assert.equal(usage.receiptPolicy.automaticPruning,false);assert.equal(usage.receiptPolicy.automaticEpochRetirement,false);
});

test('draft/import/backup capacities separate retained expired bytes from active quota and use UTF-8 byte counts',async()=>{
 const {db}=fixtures();const usage=await readWorkspaceUsage(db,'private-owner-a',now);
 assert.equal(usage.drafts.count,2);assert.equal(usage.drafts.activeCount,1);assert.equal(usage.drafts.expiredCount,1);assert.equal(usage.drafts.activeBytes,bytes('active-draft')+bytes(JSON.stringify({text:'مرحبا 👋'}))+bytes(future)+8);assert.equal(usage.drafts.bytes,usage.drafts.activeBytes+usage.drafts.expiredBytes);assert.equal(usage.drafts.limits.activeCount,100);assert.equal(usage.drafts.limits.perDraftBytes,65536);
 assert.equal(usage.imports.count,2);assert.equal(usage.imports.activeCount,1);assert.equal(usage.imports.expiredCount,1);assert.equal(usage.imports.bytes,8);assert.equal(usage.imports.activeBytes,3);assert.equal(usage.imports.expiredBytes,5);assert.ok(usage.imports.storedBytes>usage.imports.bytes);assert.equal(usage.imports.limits.activeCount,8);
 assert.equal(usage.backups.count,1);assert.equal(usage.backups.bytes,123);assert.equal(usage.backups.pinnedCount,1);assert.equal(usage.backups.readyCount,1);assert.equal(usage.backups.limits.count,10);
 assert.equal(usage.modules.find(row=>row.module==='evidence_records')!.bytes,bytes('evidence')+bytes(JSON.stringify({text:'é🙂'}))+64+8);assert.equal(usage.audit.count,1);
});

test('A/B aggregate isolation never exposes owners, mutation IDs, epoch IDs, raw content or private record identifiers',async()=>{
 const {db}=fixtures();const a=await readWorkspaceUsage(db,'private-owner-a',now);const b=await readWorkspaceUsage(db,'private-owner-b',now);assert.equal(a.receipts.count,2);assert.equal(b.receipts.count,3);
 const output=JSON.stringify([a,b]);for(const secret of ['private-owner-a','private-owner-b','legacy-receipt-0001','foreign-extra-receipt','a'.repeat(32),'مرحبا','é🙂','active-import']){assert.ok(!output.includes(secret),secret);}
 const injection=await readWorkspaceUsage(db,"private-owner-a' OR 1=1 --",now);assert.equal(injection.receipts.count,0);assert.equal(injection.backups.count,0);assert.equal(injection.modules.reduce((total,row)=>total+row.count,0),0);
});

test('usage issues only bound SELECT queries and does not prune any aged receipt, tombstone, expired draft or staged import',async()=>{
 const {db,sqlite}=fixtures();const queries:string[]=[];const readOnly:SqlDatabase={...db,prepare(sql){queries.push(sql);assert.match(sql,/^SELECT\b/);const statement=db.prepare(sql);const bind=statement.bind.bind(statement);statement.bind=(...values)=>{assert.equal(values.at(-1),'private-owner-a');return bind(...values);};return statement;},async batch(){throw new Error('Usage must never run a mutation batch');}};
 const before=sqlite.prepare('SELECT count(*) AS n FROM workspace_drafts').get()!.n;await readWorkspaceUsage(readOnly,'private-owner-a',now);assert.ok(queries.length>9);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_drafts').get()!.n,before);assert.equal(sqlite.prepare("SELECT count(*) AS n FROM workspace_mutation_epochs WHERE status='retired'").get()!.n,2);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_imports').get()!.n,4);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_mutations').get()!.n,5);
});

test('empty authenticated owner has zero usage and invalid identity/time fail before querying',async()=>{
 const {db}=database();const usage=await readWorkspaceUsage(db,'new-owner',now);assert.equal(usage.planning.count,0);assert.equal(usage.receipts.bytes,0);assert.equal(usage.epochs.count,0);assert.equal(usage.drafts.activeCount,0);assert.equal(usage.imports.storedBytes,0);assert.equal(usage.backups.bytes,0);assert.ok(usage.modules.every(row=>row.count===0&&row.bytes===0));await assert.rejects(readWorkspaceUsage(db,'',now),/authenticated owner/);await assert.rejects(readWorkspaceUsage(db,'owner','invalid'),/timestamp/);
});

