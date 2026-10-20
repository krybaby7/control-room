import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {database} from '../tests/helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {attachmentRecordSchema} from '../lib/evidence-module.ts';
import {createR2BlobStore,stageAttachmentUpload,readReadyAttachment,attachmentHash} from '../lib/attachments.ts';
import {beginUpload,finishUpload} from '../lib/attachment-upload-fences.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {writeAttachmentArchive} from '../lib/attachment-archive-export.ts';
import {stageAttachmentArchive} from '../lib/attachment-archive-staging.ts';
import {discardArchiveStage} from '../lib/attachment-archive-recovery.ts';
import {cleanupAbandonedArchive} from '../lib/attachment-archive-cleanup.ts';
import {resolveAttachmentNamespace} from '../lib/attachment-namespace-access.ts';
import {readPhysicalAttachmentUsage} from '../lib/attachment-physical-quota.ts';
assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 or newer is required.');
const owner='synthetic-isolated-recovery-owner',now='2026-10-18T12:00:00.000Z';
const bytes=new TextEncoder().encode('Synthetic native archive recovery fixture.\n');
const stream=value=>new ReadableStream({start(controller){controller.enqueue(value.slice());controller.close();}});
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated attachment recovery fixture");}};',compatibilityDate:'2026-05-15',r2Buckets:['FIXTURE_BUCKET'],r2Persist:false,cf:false});
let fixture,bucket;
try{
 fixture=database();const {db,sqlite}=fixture;bucket=await mf.getR2Bucket('FIXTURE_BUCKET');const store=createR2BlobStore(bucket);assert.equal(store.available,true);
 await loadWorkspace(db,owner,()=>createSeedWorkspace(now),now);const namespace=(await getWorkspaceNamespaces(db,owner)).blobNamespace;
 async function send(command){return executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:(await readCurrent(db,owner,now)).revision,mutationId:crypto.randomUUID(),command},{db,now:()=>now,handlers:workspaceHandlers,attachmentAccess:{ownerNamespace:namespace,store}});}
 async function attachment(id){const row=await ownerReader(db,owner).get('attachments',id);assert.ok(row);return {row,record:attachmentRecordSchema.parse(JSON.parse(row.payload_json))};}
 assert.equal((await send({type:'attachment.reserve',value:{filename:'recovery-fixture.txt',mimeType:'text/plain',expectedBytes:bytes.length}})).status,'committed');
 const reservedRow=(await ownerReader(db,owner).list('attachments'))[0],reserved=attachmentRecordSchema.parse(JSON.parse(reservedRow.payload_json));
 const uploadToken=await beginUpload(db,owner,{record:reserved,rowRevision:reservedRow.row_revision,now,ownerNamespace:namespace});assert.ok(uploadToken);
 const staged=await stageAttachmentUpload(owner,reserved,stream(bytes),store,{ownerNamespace:namespace,now});assert.equal(staged.status,'staged');assert.equal(await finishUpload(db,owner,{token:uploadToken,now,definitivelySettled:true}),true);
 assert.equal((await send({type:'attachment.finalize',id:reserved.id})).status,'committed');const original=(await attachment(reserved.id)).record,originalRow=(await attachment(reserved.id)).row;
 assert.deepEqual((await readReadyAttachment(owner,original,store,{ownerNamespace:namespace,now})).bytes,bytes);
 assert.deepEqual(await readPhysicalAttachmentUsage(db,owner),{files:1,bytes:bytes.length});
 const frozen=await exportWorkspaceBundle(db,owner,{now:()=>now});
 const zip=new Uint8Array(await new Response(writeAttachmentArchive(frozen,[original],async id=>{assert.equal(id,original.id);return (await readReadyAttachment(owner,original,store,{ownerNamespace:namespace,now})).bytes;})).arrayBuffer());
 assert.ok(zip.length>bytes.length);const digest=await attachmentHash(bytes),zipDigest=await attachmentHash(zip);
 async function stageArchive(){return stageAttachmentArchive(db,owner,stream(zip),{store,now:()=>now,targetRevision:(await readCurrent(db,owner,now)).revision});}
 const first=await stageArchive();assert.equal(first.archive.files,1);assert.equal(first.archive.bytes,bytes.length);assert.deepEqual(first.stage.diagnostics,[]);
 const firstObject=sqlite.prepare('SELECT storage_key,namespace,verified_at,purged_at FROM attachment_blob_objects WHERE user_id=? AND namespace=(SELECT namespace FROM attachment_archive_stages WHERE user_id=? AND id=?)').get(owner,owner,first.archive.id);assert.ok(firstObject);assert.notEqual(firstObject.namespace,namespace);assert.notEqual(firstObject.storage_key,original.storageKey);assert.equal(firstObject.verified_at,now);assert.deepEqual(new Uint8Array(await (await bucket.get(firstObject.storage_key)).arrayBuffer()),bytes);
 assert.deepEqual(await readPhysicalAttachmentUsage(db,owner),{files:2,bytes:bytes.length*2});assert.equal(await discardArchiveStage(db,owner,first.archive.id,now),true);assert.deepEqual(await readPhysicalAttachmentUsage(db,owner),{files:2,bytes:bytes.length*2});
 const cleaned=await cleanupAbandonedArchive(db,owner,first.archive.id,{store,now:()=>now});assert.deepEqual(cleaned,{status:'complete',purged:1});assert.equal(await bucket.head(firstObject.storage_key),null);assert.deepEqual(await readPhysicalAttachmentUsage(db,owner),{files:1,bytes:bytes.length});assert.deepEqual((await attachment(original.id)).row,originalRow);assert.deepEqual((await readReadyAttachment(owner,original,store,{ownerNamespace:namespace,now})).bytes,bytes);
 // A second real stage is explicitly reviewed and committed by the fixture owner command.
 const second=await stageArchive();const beforeCommit=(await readCurrent(db,owner,now)).revision;assert.equal((await send({type:'workspace.import.commit',importId:second.stage.id,hash:second.stage.hash,targetRevision:beforeCommit,mode:'replace'})).status,'committed');
 assert.equal(sqlite.prepare('SELECT status FROM attachment_archive_stages WHERE user_id=? AND id=?').get(owner,second.archive.id).status,'committed');
 const restored=(await attachment(original.id)).record,restoredNamespace=await resolveAttachmentNamespace(db,owner,restored);assert.ok(restoredNamespace);assert.notEqual(restoredNamespace,namespace);assert.notEqual(restored.storageKey,original.storageKey);assert.deepEqual((await readReadyAttachment(owner,restored,store,{ownerNamespace:restoredNamespace,now})).bytes,bytes);
 const protectedCleanup=await cleanupAbandonedArchive(db,owner,second.archive.id,{store,now:()=>now});assert.equal(protectedCleanup.status,'blocked');assert.ok(await bucket.head(restored.storageKey));assert.deepEqual(new Uint8Array(await (await bucket.get(original.storageKey)).arrayBuffer()),bytes);assert.deepEqual(await readPhysicalAttachmentUsage(db,owner),{files:2,bytes:bytes.length*2});
 console.log(JSON.stringify({bytes:bytes.length,sha256:digest,archiveBytes:zip.length,archiveSha256:zipDigest,discardedStage:'purged',original:'unchanged-after-orphan-cleanup',restored:'committed-and-byte-verified',committedStageCleanup:'blocked',physicalFiles:2}));
}finally{
 try{if(bucket){const all=await bucket.list();for(const object of all.objects)await bucket.delete(object.key);assert.equal((await bucket.list()).objects.length,0);}}
 finally{try{fixture?.sqlite.close();}finally{await mf.dispose();}}
}
console.log('PASS isolated Miniflare R2 + SQLite: native ZIP staging, discard, orphan deletion, physical quota, reviewed restore and committed-stage protection.');
