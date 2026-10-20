import test from 'node:test';import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {deriveAttachmentManifest} from '../lib/attachment-manifest.ts';
import {writeAttachmentArchive} from '../lib/attachment-archive-export.ts';
import {readStoredArchive} from '../lib/attachment-archive.ts';
import {inspectAttachmentArchive} from '../lib/attachment-archive-import.ts';
import {stageAttachmentArchive} from '../lib/attachment-archive-staging.ts';
import {reserveArchiveObjects} from '../lib/attachment-physical-quota.ts';
import {resolveAttachmentNamespace} from '../lib/attachment-namespace-access.ts';
import {stageImport,readStagedImport} from '../lib/import-staging.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {captureRecoveryPrivateContinuity,validateRecoveryPrivateContinuity} from '../lib/recovery-private-continuity.ts';
import {inactiveRecoveryDatabase,installRecoveryPrivateContinuity} from '../lib/recovery-install.ts';
import {inspectRecoveryMaintenanceSchema,freezeRecoveryDatabase,bindFrozenPrivateContinuity,prepareInactiveRecoveryTarget,recoveryTargetInventorySha256,markRecoveryTargetReady} from '../lib/recovery-maintenance.ts';
import {proveRecoveryAttachments,type RecoveryArtifactSink} from '../lib/recovery-attachments.ts';
import type {BlobStore,BlobMetadata} from '../lib/attachments.ts';
import type {AttachmentRecord} from '../lib/evidence-contract.ts';
const now='2026-10-18T12:00:00.000Z';
/** Explicit synthetic blob and offline-file sinks, not hosted/provider evidence. */
class SyntheticBlobStore implements BlobStore {
 available = true; objects = new Map<string, { bytes: Uint8Array; metadata: BlobMetadata }>(); puts = 0; afterPut?: () => void;
 corrupt = false; rejectAfterWrite = false;
 async put(key: string, bytes: Uint8Array, metadata: BlobMetadata): Promise<'stored' | 'exists'> { this.puts++; if (this.objects.has(key)) return 'exists'; this.objects.set(key, { bytes: this.corrupt ? new Uint8Array(bytes.length) : bytes.slice(), metadata: { ...metadata } }); this.afterPut?.(); if (this.rejectAfterWrite) throw new Error('ambiguous synthetic PUT'); return 'stored'; }
 async head(key: string) { return this.objects.get(key)?.metadata ?? null; }
 async get(key: string) { const object = this.objects.get(key); return object ? { metadata: { ...object.metadata }, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(object.bytes); c.close(); } }) } : null; }
 async delete() { throw new Error('staging must never delete objects'); }
}
async function archiveFixture() {
 const f = database(); await loadWorkspace(f.db, 'synthetic', () => createSeedWorkspace(now), now);
 const bundle = await exportWorkspaceBundle(f.db, 'synthetic', { now: () => now });
 const bytes = new TextEncoder().encode('synthetic archive source');
 const record: AttachmentRecord = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'ready', filename: 'original.txt', mimeType: 'text/plain', expectedBytes: bytes.length, actualBytes: bytes.length, sha256: await contentHash(bytes), storageKey: 'attachments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: now, expiresAt: now, readyAt: now, uploadMutationId: 'synthetic-original-upload', quarantineReason: null };
 bundle.modules.attachments.records = [{ id: record.id, rowRevision: 7, contentHash: await contentHash(canonical(record)), value: record }];
 bundle.modules.attachment_usage.records = [{ id: 'quota', rowRevision: 1, contentHash: 'a'.repeat(64), value: { files: 1, bytes: bytes.length } }];
 bundle.attachments = deriveAttachmentManifest(bundle.modules);
 const store = new SyntheticBlobStore();
 return { ...f, bundle, bytes, record, store, stream: () => writeAttachmentArchive(bundle, [record], async () => bytes), options: { store, now: () => now, targetRevision: 1 } };
}
class SyntheticOfflineSink implements RecoveryArtifactSink{
 objects=new Map<string,Uint8Array>();
 async write(id:string,stream:ReadableStream<Uint8Array>){assert.match(id,/^[a-f0-9-]+\.zip$/);assert.equal(this.objects.has(id),false);this.objects.set(id,new Uint8Array(await new Response(stream).arrayBuffer()));}
 async open(id:string){const bytes=this.objects.get(id);if(!bytes)throw new Error('Synthetic offline artifact absent.');return new Response(bytes.slice()).body!;}
}
async function retainedSource(mode:'valid'|'corrupt'|'fenced'='valid'){
 const f=await archiveFixture(),owner='synthetic';
 const first=await stageAttachmentArchive(f.db,owner,f.stream(),f.options),second=await stageAttachmentArchive(f.db,owner,f.stream(),f.options);
 // Native staging is real above. This labelled retained committed-row fixture
 // models prior owner acceptance without performing another workspace restore.
 f.sqlite.prepare("UPDATE attachment_archive_stages SET status='committed' WHERE id=?").run(second.archive.id);
 let originalManifest='';for await(const entry of readStoredArchive(f.stream()))if(entry.path==='manifest.json')originalManifest=new TextDecoder().decode(entry.bytes);
 const preparingId=crypto.randomUUID(),preparingNamespace=crypto.randomUUID();
 await reserveArchiveObjects(f.db,owner,{stageId:preparingId,namespace:preparingNamespace,sourceManifestHash:await contentHash(canonical(JSON.parse(originalManifest))),manifestJson:originalManifest,createdAt:now,expiresAt:'2026-10-18T13:00:00.000Z',targetRevision:1,records:[{id:f.record.id,bytes:f.bytes.length,sha256:f.record.sha256!}]});
 const raw=new TextEncoder().encode(JSON.stringify({schemaVersion:999,originalOwnerInput:'Original مرحبا 😀 é — retain exact UTF8 bytes, including invalid planning diagnostics.'}));
 const rawStage=await stageImport(f.db,owner,raw,now);
 f.sqlite.prepare("INSERT INTO review_analysis_requests(user_id,id,intent_id,snapshot_id,snapshot_hash,policy_hash,provider,model,input_digest,state,reserved_micros,measured_cost_micros,created_at,updated_at,result_id,result_hash,payload_json) VALUES(?,?,NULL,?,?,?,?,?,?,'unknown',54321,NULL,?,?,NULL,NULL,?)").run(owner,'synthetic-unknown-paid-request','synthetic-original-snapshot','a'.repeat(64),'b'.repeat(64),'synthetic-disabled-provider','synthetic-pinned-model','c'.repeat(64),now,now,'{"originalRequest":"unknown paid outcome — not retried"}');
 f.sqlite.prepare("INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)").run(owner,'b'.repeat(64),'synthetic-disabled-provider','synthetic-pinned-model',100000,now,'2026-10-19T12:00:00.000Z');
 const object=f.sqlite.prepare('SELECT * FROM attachment_blob_objects WHERE namespace=(SELECT namespace FROM attachment_archive_stages WHERE id=?)').get(first.archive.id)!;
 if(mode==='corrupt')f.store.objects.get(String(object.storage_key))!.bytes[0]^=1;
 if(mode==='fenced')f.sqlite.prepare('INSERT INTO attachment_archive_cleanup_claims(user_id,storage_key,stage_id,namespace,token,created_at,purged_at) VALUES(?,?,?,?,?,?,NULL)').run(owner,object.storage_key,first.archive.id,object.namespace,crypto.randomUUID(),now);
 return {...f,owner,first,second,preparingId,raw,rawStage};
}
async function restore(f:Awaited<ReturnType<typeof retainedSource>>){
 const target=database(),current=await readCurrent(f.db,f.owner,now),schema=await inspectRecoveryMaintenanceSchema(f.db),manifestSha256='d'.repeat(64),ownerContextHash=await contentHash(f.owner);
 const sourceContext={workspaceRevision:current.revision,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(f.db,f.owner)};
 const frozen=await freezeRecoveryDatabase(f.db,{operationId:crypto.randomUUID(),token:'e'.repeat(64),ownerId:f.owner,manifestSha256,ownerContextHash,schemaFingerprint:schema.schemaFingerprint,sourceContext,now});
 const value=await captureRecoveryPrivateContinuity(f.db,f.owner,{manifestSha256,ownerContextHash,sourceContext},now);await bindFrozenPrivateContinuity(f.db,frozen,value,value.sha256);
 const destination=await prepareInactiveRecoveryTarget(target.db,f.db,frozen,{operationId:crypto.randomUUID(),token:'f'.repeat(64),expectedPrivateSha256:value.sha256}),db=inactiveRecoveryDatabase(target.db,destination);
 await loadWorkspace(db,f.owner,()=>current.workspace,now);await installRecoveryPrivateContinuity(f.db,frozen,target.db,destination,value,value.sha256);
 return {...target,db,destination,frozen,value,rawTarget:target.db};
}
test('original Unicode chunks, committed/unfinished archive history and unknown paid charges survive with actual sealed files and no grants',async()=>{
 const f=await retainedSource(),r=await restore(f);try{
  assert.deepEqual((await readStagedImport(r.rawTarget,f.owner,f.rawStage.id,now)).raw,f.raw);
  for(const table of ['workspace_imports','workspace_import_chunks','review_analysis_requests']as const)assert.deepEqual(r.sqlite.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all(),table);
  assert.equal(r.sqlite.prepare("SELECT state FROM review_analysis_requests").get()!.state,'unknown');assert.equal(r.sqlite.prepare("SELECT reserved_micros FROM review_analysis_requests").get()!.reserved_micros,54321);assert.equal(r.sqlite.prepare("SELECT measured_cost_micros FROM review_analysis_requests").get()!.measured_cost_micros,null);
  assert.equal(r.sqlite.prepare('SELECT COUNT(*) count FROM review_analysis_consents').get()!.count,0);
  assert.equal(r.sqlite.prepare('SELECT status FROM attachment_archive_stages WHERE id=?').get(f.first.archive.id)!.status,'failed');
  assert.equal(r.sqlite.prepare('SELECT status FROM attachment_archive_stages WHERE id=?').get(f.second.archive.id)!.status,'committed');
  assert.equal(r.sqlite.prepare("SELECT COUNT(*) count FROM attachment_blob_namespaces WHERE purpose<>'recovery-history'").get()!.count,0);
  const committedObject=f.sqlite.prepare('SELECT storage_key FROM attachment_blob_objects WHERE namespace=(SELECT namespace FROM attachment_archive_stages WHERE id=?)').get(f.second.archive.id)!;assert.equal(await resolveAttachmentNamespace(r.rawTarget,f.owner,{...f.record,storageKey:String(committedObject.storage_key)}),null);
  const sink=new SyntheticOfflineSink(),proof=await proveRecoveryAttachments(f.db,r.frozen,r.rawTarget,r.destination,{sourceStore:f.store,targetStore:f.store,artifacts:sink});
  assert.equal(proof.stagingArtifacts.length,3);assert.equal(proof.stagingArtifacts.reduce((sum,row)=>sum+row.included,0),2);assert.equal(proof.stagingArtifacts.reduce((sum,row)=>sum+row.notWritten,0),1);
  for(const artifact of proof.stagingArtifacts){let files=0;for await(const entry of readStoredArchive(await sink.open(artifact.id)))if(entry.path!=='manifest.json'){files++;assert.deepEqual(entry.bytes,f.bytes);}assert.equal(files,artifact.included);}
  const inventorySha256=await recoveryTargetInventorySha256(r.rawTarget,r.destination),expected={privateSha256:r.value.sha256,inventorySha256,actualInventorySha256:()=>recoveryTargetInventorySha256(r.rawTarget,r.destination)};
  await assert.rejects(markRecoveryTargetReady(r.rawTarget,f.db,r.frozen,r.destination,{...expected,attachmentProof:structuredClone(proof)}),/native recovery byte proof/);
  const artifact=proof.stagingArtifacts[0],original=sink.objects.get(artifact.id)!.slice();sink.objects.get(artifact.id)![original.length-1]^=1;
  await assert.rejects(markRecoveryTargetReady(r.rawTarget,f.db,r.frozen,r.destination,{...expected,attachmentProof:proof}));
  assert.equal(r.sqlite.prepare('SELECT state FROM operator_recovery_maintenance').get()!.state,'target-inactive');
  sink.objects.set(artifact.id,original);await markRecoveryTargetReady(r.rawTarget,f.db,r.frozen,r.destination,{...expected,attachmentProof:proof});
  assert.equal(r.sqlite.prepare('SELECT COUNT(*) count FROM attachments').get()!.count,0,'staged claims never become active attachments');
  assert.equal(r.sqlite.prepare('SELECT COUNT(*) count FROM workspace_job_intents').get()!.count,0);
  // This private staged-input recovery ZIP is honestly not an accepted native
  // workspace archive; an owner must explicitly reconstruct/review/import later.
  await assert.rejects(inspectAttachmentArchive(await sink.open(artifact.id),async()=>assert.fail('No import staging expected')));
 }finally{f.sqlite.close();r.sqlite.close();}
});
test('corrupt original staged bytes cannot produce a trusted artifact or ready target',async()=>{
 const f=await retainedSource('corrupt'),r=await restore(f);try{await assert.rejects(proveRecoveryAttachments(f.db,r.frozen,r.rawTarget,r.destination,{sourceStore:f.store,targetStore:f.store,artifacts:new SyntheticOfflineSink()}));assert.equal(r.sqlite.prepare('SELECT state FROM operator_recovery_maintenance').get()!.state,'target-inactive');assert.equal(r.sqlite.prepare('SELECT COUNT(*) count FROM attachments').get()!.count,0);}finally{f.sqlite.close();r.sqlite.close();}
});
test('permanently fenced staged keys stay excluded and no historical JSON can mint byte authority',async()=>{
 const f=await retainedSource('fenced'),r=await restore(f);try{const sink=new SyntheticOfflineSink(),proof=await proveRecoveryAttachments(f.db,r.frozen,r.rawTarget,r.destination,{sourceStore:f.store,targetStore:f.store,artifacts:sink});assert.equal(proof.stagingArtifacts.reduce((sum,row)=>sum+row.excluded,0),1);assert.equal(r.sqlite.prepare('SELECT COUNT(*) count FROM attachment_archive_cleanup_claims').get()!.count,1);assert.equal(r.sqlite.prepare("SELECT COUNT(*) count FROM attachment_blob_namespaces WHERE purpose='archive-stage'").get()!.count,0);const inventorySha256=await recoveryTargetInventorySha256(r.rawTarget,r.destination);await markRecoveryTargetReady(r.rawTarget,f.db,r.frozen,r.destination,{privateSha256:r.value.sha256,inventorySha256,attachmentProof:proof,actualInventorySha256:()=>recoveryTargetInventorySha256(r.rawTarget,r.destination)});}finally{f.sqlite.close();r.sqlite.close();}
});
test('tampered retained raw bytes fail the independently trusted private digest and exact source input validation',async()=>{
 const f=await retainedSource(),r=await restore(f);try{const changed=structuredClone(r.value),chunk=changed.tables.workspace_import_chunks.find(row=>row.import_id===f.rawStage.id)!;chunk.content_base64=btoa('different original bytes');const body=Object.fromEntries(Object.entries(changed).filter(([key])=>key!=='sha256'));changed.sha256=await contentHash(canonical(body));await assert.rejects(validateRecoveryPrivateContinuity(changed,{sha256:changed.sha256,manifestSha256:changed.manifestSha256,ownerContextHash:changed.ownerContextHash,sourceContext:changed.sourceContext,ownerId:f.owner}),/Retained original input/);}finally{f.sqlite.close();r.sqlite.close();}
});

test('cancelled offline artifact write returns no byte authority and leaves the inactive owner records intact',async()=>{
 const f=await retainedSource(),r=await restore(f);try{
  const controller=new AbortController(),sink:RecoveryArtifactSink={async write(){controller.abort();return new Promise<void>(()=>{});},async open(){throw new Error('No sealed artifact exists.');}};
  await assert.rejects(proveRecoveryAttachments(f.db,r.frozen,r.rawTarget,r.destination,{sourceStore:f.store,targetStore:f.store,artifacts:sink,signal:controller.signal}),/cancelled/);
  assert.equal(controller.signal.aborted,true);assert.equal(r.sqlite.prepare('SELECT state FROM operator_recovery_maintenance').get()!.state,'target-inactive');
  assert.equal(r.sqlite.prepare('SELECT COUNT(*) count FROM workspace_imports').get()!.count,r.value.tables.workspace_imports.length);
 }finally{f.sqlite.close();r.sqlite.close();}
});
