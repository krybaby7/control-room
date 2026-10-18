// Isolated synthetic actual-Miniflare D1 SQL parser probe; no owner data or network.
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { database } from '../tests/helpers/sqlite.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { loadWorkspace } from '../lib/workspace-store.ts';
import { executeWorkspaceCommand } from '../lib/workspace-transaction.ts';
import { workspaceHandlers } from '../lib/workspace-handlers.ts';
import { attachmentGenerationSql, attachmentPriorGenerationSql, attachmentGenerationPredicate } from '../lib/attachment-generation.ts';
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("synthetic");}}', compatibilityDate: '2026-05-15', d1Databases: ['DB', 'COMPILER_DB'], d1Persist: false, cf: false });
try {
 const db = await mf.getD1Database('DB');
 for (const [table, columns] of Object.entries({
  attachment_blob_fences:'user_id TEXT,attachment_id TEXT,storage_key TEXT,namespace TEXT,created_at TEXT,purged_at TEXT',
  attachment_blob_objects:'user_id TEXT,attachment_id TEXT,storage_key TEXT,namespace TEXT,bytes INTEGER,sha256 TEXT,created_at TEXT,verified_at TEXT,purged_at TEXT',
  attachment_blob_namespaces:'user_id TEXT,namespace TEXT,purpose TEXT',
  attachment_upload_attempts:'user_id TEXT,attachment_id TEXT,settled_at TEXT',
  attachment_archive_cleanup_claims:'storage_key TEXT',
  attachment_archive_stages:'user_id TEXT,namespace TEXT,status TEXT,import_id TEXT,import_hash TEXT,target_revision INTEGER,expires_at TEXT',
  workspaces:'user_id TEXT,revision INTEGER',
  attachments:'user_id TEXT,id TEXT,storage_key TEXT,expected_bytes INTEGER,sha256 TEXT,status TEXT',
  evidence_versions:'user_id TEXT,payload_json TEXT',
 })) await db.prepare(`CREATE TABLE ${table}(${columns})`).run();
 const fields = {owner:'a.user_id',attachmentId:'a.id',storageKey:'a.storage_key',bytes:'a.expected_bytes',sha256:'a.sha256'};
 const review = {id:'generation_review.id',hash:'generation_review.hash',targetRevision:'generation_review.revision',now:'generation_review.now'};
 const predicate = attachmentGenerationSql(fields, review);
 const source = "(SELECT '' AS id,'' AS hash,1 AS revision,'2026-10-18T00:00:00.000Z' AS now) generation_review";
 const fenceCondition = `NOT EXISTS (SELECT 1 FROM attachments a CROSS JOIN ${source} JOIN attachment_blob_fences f ON f.user_id=a.user_id AND (f.attachment_id=a.id OR f.storage_key=a.storage_key) WHERE a.user_id='synthetic' AND a.status IN ('reserved','ready') AND (f.storage_key=a.storage_key OR a.status<>'ready' OR NOT ${predicate}))`;
 const evidenceCondition = `NOT EXISTS (SELECT 1 FROM evidence_versions e JOIN json_each(e.payload_json,'$.attachmentIds') ref JOIN attachment_blob_fences f ON f.user_id=e.user_id AND f.attachment_id=ref.value CROSS JOIN ${source} WHERE e.user_id='synthetic' AND NOT EXISTS(SELECT 1 FROM attachments a WHERE a.user_id=e.user_id AND a.id=ref.value AND a.status='ready' AND ${predicate}))`;
 const materialized = `WITH admitted_generations AS MATERIALIZED (SELECT a.user_id,a.id,a.storage_key FROM attachments a CROSS JOIN ${source} WHERE a.user_id='synthetic' AND a.status='ready' AND ${predicate}) SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evidence_versions e JOIN json_each(e.payload_json,'$.attachmentIds') ref JOIN attachment_blob_fences f ON f.user_id=e.user_id AND f.attachment_id=ref.value LEFT JOIN admitted_generations admitted ON admitted.user_id=e.user_id AND admitted.id=ref.value WHERE e.user_id='synthetic' AND admitted.id IS NULL) THEN 1 ELSE 0 END AS valid`;
 const backup=attachmentGenerationPredicate('synthetic',{attachmentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',storageKey:'attachments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bytes:5,sha256:'a'.repeat(64)});
 await db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attachment_blob_fences WHERE user_id=? AND (attachment_id=? OR storage_key=?)) OR ${backup.sql} THEN 1 ELSE 0 END AS valid`).bind('synthetic','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','synthetic-key',...backup.bindings).all();
 console.log('PASS compiler retained-backup predicate assertion');
 const probes = [
  ['limit calibration (101 AND terms)', `SELECT ${Array.from({length:101},()=> '1').join(' AND ')} AS valid`, true],
  ['root MATERIALIZED evidence assertion', materialized, false],
  ['prior helper', `SELECT ${attachmentPriorGenerationSql(fields)} AS valid FROM attachments a`, false],
  ['full helper', `SELECT ${predicate} AS valid FROM attachments a CROSS JOIN ${source}`, false],
  ['compiler attachment fence assertion', `SELECT CASE WHEN ${fenceCondition} THEN 1 ELSE 0 END AS valid`, false],
  ['legacy nested evidence assertion', `SELECT CASE WHEN ${evidenceCondition} THEN 1 ELSE 0 END AS valid`, false],
  ['representative receipt claim plus assertion', `SELECT CASE WHEN (${Array.from({length:12},()=> '1=1').join(' AND ')}) AND ${evidenceCondition} THEN 1 ELSE 0 END AS valid`, false],
 ];
 let failed = false;
 for (const [label,sql,expectedError] of probes) {
  try { await db.prepare(sql).all(); if(expectedError===true) throw new Error('D1 depth calibration unexpectedly accepted'); console.log(`PASS ${label} (${sql.length} SQL bytes)`); }
  catch(error) { if(expectedError && /Expression tree is too large/.test(String(error))) console.log(`PASS ${label}: actual D1 depth100 enforced`); else { failed=true;console.error(`FAIL ${label}: ${error}`); } }
 }
 const compilerDb = await mf.getD1Database('COMPILER_DB');
 const fixture = database();
 try {
  for (const row of fixture.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()) await compilerDb.prepare(row.sql).run();
 } finally { fixture.sqlite.close(); }
 const owner='synthetic-d1-compiler-proof', now='2026-10-18T12:00:00.000Z';
 const before = await loadWorkspace(compilerDb,owner,()=>createSeedWorkspace(now),now);
 try {
  const result = await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:before.revision,mutationId:'synthetic-d1-compiler-proof-0001',command:{type:'project.edit',id:before.workspace.projects[0].id,patch:{goal:'Synthetic D1 parser verification'}}},{db:compilerDb,now:()=>now,handlers:workspaceHandlers});
  assert.equal(result.status,'committed'); console.log('PASS actual source executeWorkspaceCommand project.edit on isolated Miniflare D1');
 } catch(error) {failed=true;console.error('FAIL actual source compiler',error);}
 assert.equal(failed,false,'Generation predicates must parse under actual D1 expression depth100.');
} finally { await mf.dispose(); }
