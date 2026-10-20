import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactFixture,artifactNow,artifactLater} from './fixtures/agent-artifact.ts';
import {authorizeAgentArtifactAttempt,readOwnedAgentArtifact,AgentArtifactStoreError} from '../lib/agents/artifact-store.ts';
import {prepareAttachmentReservation} from '../lib/attachments.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
const credentials=(f:Awaited<ReturnType<typeof artifactFixture>>)=>({attemptId:f.lease.attemptId,leaseToken:f.lease.leaseToken});
test('actual native SQLite claim yields owner/device/lease-bound proof with no planning mutation',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const before=f.sqlite.prepare('SELECT revision,content FROM workspaces WHERE user_id=?').get(f.owner),authorized=await authorizeAgentArtifactAttempt(f.db,f.principal,credentials(f),artifactNow);assert.equal(authorized.record.id,f.jobId);assert.ok(await f.db.prepare('SELECT 1 WHERE '+authorized.guard.sql).bind(...authorized.guard.bindings).first());assert.deepEqual(f.sqlite.prepare('SELECT revision,content FROM workspaces WHERE user_id=?').get(f.owner),before);await assert.rejects(authorizeAgentArtifactAttempt(f.db,f.principal,{...credentials(f),leaseToken:'f'.repeat(64)},artifactNow),error=>error instanceof AgentArtifactStoreError&&error.status===404);await assert.rejects(authorizeAgentArtifactAttempt(f.db,{...f.principal,ownerId:'foreign-synthetic-owner'},credentials(f),artifactNow),error=>error instanceof AgentArtifactStoreError&&error.status===401);
});
test('late cancellation, device revocation, restored epoch and rotated lease invalidate exact SQL proof',async t=>{
 for(const change of ['cancel','revoke','epoch','lease']){const f=await artifactFixture();t.after(()=>f.sqlite.close());const value=await authorizeAgentArtifactAttempt(f.db,f.principal,credentials(f),artifactNow);
  if(change==='cancel')f.sqlite.prepare('UPDATE agent_job_state SET cancel_requested_at=? WHERE user_id=? AND job_id=?').run(artifactNow,f.owner,f.jobId);
  if(change==='revoke')f.sqlite.prepare('UPDATE device_credentials SET revoked_at=? WHERE user_id=? AND id=?').run(artifactNow,f.owner,f.principal.credentialId);
  if(change==='epoch')f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=epoch+1 WHERE user_id=?').run(f.owner);
  if(change==='lease')f.sqlite.prepare('UPDATE job_attempts SET lease_token_hash=?,operational_revision=operational_revision+1 WHERE user_id=? AND id=?').run('e'.repeat(64),f.owner,f.lease.attemptId);
  assert.equal(await f.db.prepare('SELECT 1 WHERE '+value.guard.sql).bind(...value.guard.bindings).first(),null);await assert.rejects(authorizeAgentArtifactAttempt(f.db,f.principal,credentials(f),artifactNow));
 }
});
test('expired/cancelled/terminal slots and tampered native binding cannot authorize artifact mutation',async t=>{
 for(const change of ['expired','slot','terminal','historical']){const f=await artifactFixture();t.after(()=>f.sqlite.close());
  if(change==='slot')f.sqlite.prepare('UPDATE agent_device_slots SET released_at=? WHERE user_id=? AND device_id=?').run(artifactNow,f.owner,f.principal.deviceId);
  if(change==='terminal')f.sqlite.prepare("UPDATE job_attempts SET result_json='{}' WHERE user_id=? AND id=?").run(f.owner,f.lease.attemptId);
  if(change==='historical'){const record={...f.record,historical:true};f.sqlite.prepare('UPDATE agent_jobs SET payload_json=?,content_hash=? WHERE user_id=? AND id=?').run(canonical(record),await contentHash(canonical(record)),f.owner,f.jobId);}
  await assert.rejects(authorizeAgentArtifactAttempt(f.db,f.principal,credentials(f),change==='expired'?artifactLater(61):artifactNow));
 }
});
test('private attempt artifact binding guards exact metadata and does not treat reserved bytes as ready evidence',async t=>{
 const f=await artifactFixture();t.after(()=>f.sqlite.close());const namespaces=await getWorkspaceNamespaces(f.db,f.owner);assert.ok(namespaces);const bytes=new TextEncoder().encode('Synthetic result artifact only.\n'),sha=await contentHash('Synthetic result artifact only.\n'),record=prepareAttachmentReservation(f.owner,{filename:'synthetic-report.txt',mimeType:'text/plain',expectedBytes:bytes.length,uploadMutationId:'synthetic_artifact_binding_upload_001'},{bytes:0,files:0},{ownerNamespace:namespaces.blobNamespace,now:artifactNow});
 f.sqlite.prepare('INSERT INTO attachments(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(f.owner,record.id,canonical(record),await contentHash(canonical(record)));f.sqlite.prepare('INSERT INTO agent_artifacts(user_id,attempt_id,artifact_id,logical_type,sha256,bytes,created_at) VALUES(?,?,?,?,?,?,?)').run(f.owner,f.lease.attemptId,record.id,'summary',sha,bytes.length,artifactNow);
 const owned=await readOwnedAgentArtifact(f.db,f.principal,credentials(f),record.id,artifactNow);assert.equal(owned.attachment.status,'reserved');assert.equal(owned.material.sha256,sha);assert.ok(await f.db.prepare('SELECT 1 WHERE '+owned.material.guard.sql).bind(...owned.material.guard.bindings).first());f.sqlite.prepare('UPDATE agent_artifacts SET sha256=? WHERE user_id=? AND attempt_id=? AND artifact_id=?').run('e'.repeat(64),f.owner,f.lease.attemptId,record.id);assert.equal(await f.db.prepare('SELECT 1 WHERE '+owned.material.guard.sql).bind(...owned.material.guard.bindings).first(),null);await assert.rejects(readOwnedAgentArtifact(f.db,f.principal,credentials(f),'11111111-1111-4111-8111-111111111111',artifactNow),error=>error instanceof AgentArtifactStoreError&&error.status===404);
});
