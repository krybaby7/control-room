import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {getOrCreateWorkspaceNamespaces,getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';

test('server-generated namespaces and 32-byte secrets are stable, private and owner-scoped',async()=>{
 const {db,sqlite}=database();try{
  assert.equal(await getWorkspaceNamespaces(db,'synthetic-a'),null);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_source_namespaces').get()!.n,0);
  const first=await getOrCreateWorkspaceNamespaces(db,'synthetic-a');assert.equal(first.cursorSecret.byteLength,32);assert.notEqual(first.auditNamespace,first.blobNamespace);assert.ok(!first.auditNamespace.includes('synthetic-a'));assert.ok(!first.blobNamespace.includes('synthetic-a'));assert.deepEqual(await getOrCreateWorkspaceNamespaces(db,'synthetic-a'),first);assert.deepEqual(await getWorkspaceNamespaces(db,'synthetic-a'),first);
  const other=await getOrCreateWorkspaceNamespaces(db,'synthetic-b');assert.notEqual(other.auditNamespace,first.auditNamespace);assert.notEqual(other.blobNamespace,first.blobNamespace);assert.notDeepEqual(other.cursorSecret,first.cursorSecret);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_source_namespaces').get()!.n,2);
  const expected=first.cursorSecret.slice();first.cursorSecret.fill(0);assert.deepEqual((await getWorkspaceNamespaces(db,'synthetic-a'))!.cursorSecret,expected);
 }finally{sqlite.close();}
});
test('simultaneous initialization returns the single authoritative persisted winner',async()=>{
 const {db,sqlite}=database();try{
  const values=await Promise.all(Array.from({length:24},()=>getOrCreateWorkspaceNamespaces(db,'synthetic-race')));for(const value of values)assert.deepEqual(value,values[0]);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_source_namespaces WHERE user_id=?').get('synthetic-race')!.n,1);assert.deepEqual(await getWorkspaceNamespaces(db,'synthetic-race'),values[0]);
 }finally{sqlite.close();}
});
test('persisted malformed authority fails closed without rotating or exposing private values',async()=>{
 for(const change of [{audit_namespace:'owner-derived-identifier'},{blob_namespace:'not-a-uuid'},{cursor_secret:'sensitive-malformed-secret'},{cursor_secret:'aa'.repeat(31)},{cursor_secret:'zz'.repeat(32)}]){
  const {db,sqlite}=database();try{
   await getOrCreateWorkspaceNamespaces(db,'synthetic-corrupt');const [column,value]=Object.entries(change)[0] as [string,string];sqlite.prepare(`UPDATE workspace_source_namespaces SET ${column}=? WHERE user_id=?`).run(value,'synthetic-corrupt');const before=sqlite.prepare('SELECT * FROM workspace_source_namespaces WHERE user_id=?').get('synthetic-corrupt');await assert.rejects(getWorkspaceNamespaces(db,'synthetic-corrupt'),/^Error: Workspace namespace configuration is invalid\.$/);await assert.rejects(getOrCreateWorkspaceNamespaces(db,'synthetic-corrupt'),/^Error: Workspace namespace configuration is invalid\.$/);assert.deepEqual(sqlite.prepare('SELECT * FROM workspace_source_namespaces WHERE user_id=?').get('synthetic-corrupt'),before);
  }finally{sqlite.close();}
 }
});
test('invalid owner is rejected and a storage failure never returns unpersisted candidates',async()=>{
 const {db,sqlite}=database();try{
  for(const owner of ['', '   '])await assert.rejects(getOrCreateWorkspaceNamespaces(db,owner),/authenticated owner/);sqlite.exec("CREATE TRIGGER reject_namespace BEFORE INSERT ON workspace_source_namespaces BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");await assert.rejects(getOrCreateWorkspaceNamespaces(db,'synthetic-storage-failure'),/synthetic storage failure/);assert.equal(await getWorkspaceNamespaces(db,'synthetic-storage-failure'),null);
 }finally{sqlite.close();}
});
