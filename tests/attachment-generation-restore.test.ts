import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {ownerAttachmentServices} from '../lib/attachment-services.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {createR2BlobStore,stageAttachmentUpload,readReadyAttachment,type AttachmentBucket} from '../lib/attachments.ts';
import {attachmentRecordSchema} from '../lib/evidence-module.ts';
import {resolveAttachmentNamespace} from '../lib/attachment-namespace-access.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {writeAttachmentArchive} from '../lib/attachment-archive-export.ts';
import {stageAttachmentArchive} from '../lib/attachment-archive-staging.ts';
import {criteriaHash} from '../lib/evidence-requirements.ts';
import {stageImport} from '../lib/import-staging.ts';
const now='2026-10-18T12:00:00.000Z';let serial=0;
/** LABELLED FAKE private R2: local bytes only, not deployed storage evidence. */
class LabelledFakeBucket implements AttachmentBucket {objects=new Map<string,{bytes:Uint8Array;mime:string;sha:string}>();failNext=false;deletes=0;async put(key:string,bytes:Uint8Array,options:{onlyIf:{etagDoesNotMatch:string};httpMetadata:{contentType:string};customMetadata:{sha256:string}}){if(this.failNext){this.failNext=false;throw new Error('Injected fake R2 PUT failure');}if(this.objects.has(key))return null;this.objects.set(key,{bytes:bytes.slice(),mime:options.httpMetadata.contentType,sha:options.customMetadata.sha256});return {size:bytes.length};}async head(key:string){const o=this.objects.get(key);return o?{size:o.bytes.length,httpMetadata:{contentType:o.mime},customMetadata:{sha256:o.sha}}:null;}async get(key:string){const o=this.objects.get(key);return o?{size:o.bytes.length,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(o.bytes.slice());c.close();}}),httpMetadata:{contentType:o.mime},customMetadata:{sha256:o.sha}}:null;}async delete(key:string){this.deletes++;this.objects.delete(key);}}
async function run(f:{db:SqlDatabase;bucket:LabelledFakeBucket},command:unknown,revision?:number,db=f.db){return executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:revision??(await readCurrent(f.db,'a',now)).revision,mutationId:`generation-restore-integration-${++serial}`,command},{db,now:()=>now,handlers:workspaceHandlers,...await ownerAttachmentServices(f.db,'a',now,f.bucket)});}
async function active(f:{db:SqlDatabase}){const row=(await ownerReader(f.db,'a').list('attachments'))[0];return attachmentRecordSchema.parse(JSON.parse(row.payload_json));}
async function setup(){const fixture=database(),f={...fixture,bucket:new LabelledFakeBucket()};await loadWorkspace(f.db,'a',()=>createSeedWorkspace(now),now);await run(f,{type:'attachment.reserve',value:{filename:'source.txt',mimeType:'text/plain',expectedBytes:5}});const original=await active(f),namespace=(await getWorkspaceNamespaces(f.db,'a'))!.blobNamespace;const store=createR2BlobStore(f.bucket);assert.equal((await stageAttachmentUpload('a',original,new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('hello'));c.close();}}),store,{ownerNamespace:namespace,now})).status,'staged');await run(f,{type:'attachment.finalize',id:original.id});await run(f,{type:'evidence.create',value:{basis:'documented-result',scope:'implementation',title:'Original source',statement:'Preserved exact bytes',observedAt:now,candidate:'a',environment:'fixture',sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[original.id]}});const subject={type:'project' as const,id:(await readCurrent(f.db,'a',now)).workspace.projects[0].id};await run(f,{type:'acceptance.record',value:{subject,decision:'accepted',statement:'Explicit owner assessment before archive',candidate:null,criteriaHash:await criteriaHash(subject,[]),evidenceRefs:[],exceptions:[],supersedesId:null}});return {...f,original:await active(f)};}
async function archive(f:Awaited<ReturnType<typeof setup>>){const bundle=await exportWorkspaceBundle(f.db,'a',{now:()=>now});return writeAttachmentArchive(bundle,[await active(f)],async id=>{const record=await active(f);assert.equal(id,record.id);const namespace=await resolveAttachmentNamespace(f.db,'a',record);assert.ok(namespace);return (await readReadyAttachment('a',record,createR2BlobStore(f.bucket),{ownerNamespace:namespace,now})).bytes;});}

function command(stage:Awaited<ReturnType<typeof stageAttachmentArchive>>,revision:number){return {type:'workspace.import.commit',importId:stage.stage.id,hash:stage.stage.hash,targetRevision:revision,mode:'replace'};}
async function bytes(f:Awaited<ReturnType<typeof setup>>){const record=await active(f),namespace=await resolveAttachmentNamespace(f.db,'a',record);assert.ok(namespace);return (await readReadyAttachment('a',record,createR2BlobStore(f.bucket),{ownerNamespace:namespace,now})).bytes;}

import {createAttachmentCleanupStore} from '../lib/attachment-cleanup-store.ts';
import {runAttachmentCleanup} from '../lib/attachment-jobs.ts';
test('reviewed native archive restores identical logical attachment into a fresh generation after a synthetic confirmed-purge history',async()=>{const f=await setup();try{
 const original=f.original,zipBytes=new Uint8Array(await new Response(await archive(f)).arrayBuffer()),bundle=await exportWorkspaceBundle(f.db,'a',{now:()=>now}),oldEvidence=(await ownerReader(f.db,'a').list('evidence_versions')).map(r=>({id:r.id,payload:r.payload_json})),namespace=(await getWorkspaceNamespaces(f.db,'a'))!.blobNamespace,token=crypto.randomUUID();
 // Explicit historical fixture removes current evidence references; saved ZIP retains their exact immutable history.
 f.sqlite.prepare("DELETE FROM evidence_versions WHERE user_id='a'").run();f.sqlite.prepare("DELETE FROM evidence_records WHERE user_id='a'").run();
 await run(f,{type:'attachment.retire',id:original.id,reason:'owner-delete'});
 // Seed previously confirmed cleanup, rather than claiming this test executed the physical cleanup runner.
 f.bucket.objects.delete(original.storageKey);
 f.sqlite.prepare("INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) VALUES('a',?,?,?,?,?,?)").run(original.storageKey,original.id,namespace,token,now,now);
 f.sqlite.prepare("UPDATE attachment_blob_objects SET purged_at=? WHERE user_id='a' AND storage_key=?").run(now,original.storageKey);
 const revision=(await readCurrent(f.db,'a',now)).revision;
 const raw=await stageImport(f.db,'a',new TextEncoder().encode(JSON.stringify(bundle)),now);
 await assert.rejects(run(f,{type:'workspace.import.commit',importId:raw.id,hash:raw.hash,targetRevision:revision,mode:'replace'},revision));
 assert.equal((await readCurrent(f.db,'a',now)).revision,revision);
 const stage=await stageAttachmentArchive(f.db,'a',new ReadableStream<Uint8Array>({start(c){c.enqueue(zipBytes);c.close();}}),{store:createR2BlobStore(f.bucket),now:()=>now,targetRevision:revision});
 const staged=attachmentRecordSchema.parse((stage.stage.bundle!.modules.attachments.records[0] as {value:unknown}).value);
 assert.notEqual(staged.storageKey,original.storageKey);assert.equal(await resolveAttachmentNamespace(f.db,'a',staged),null);
 assert.equal((await run(f,command(stage,revision),revision)).status,'committed');
 const restored=await active(f);assert.equal(restored.id,original.id);assert.equal(restored.sha256,original.sha256);assert.equal(restored.expectedBytes,original.expectedBytes);assert.equal(restored.storageKey,staged.storageKey);assert.equal(new TextDecoder().decode(await bytes(f)),'hello');
 assert.deepEqual((await ownerReader(f.db,'a').list('evidence_versions')).map(r=>({id:r.id,payload:r.payload_json})),oldEvidence);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM acceptance_owner_grants WHERE user_id='a'").get()!.n,0);
 assert.equal(f.sqlite.prepare("SELECT purged_at FROM attachment_blob_fences WHERE storage_key=?").get(original.storageKey)!.purged_at,now);
 const freshLedger=f.sqlite.prepare('SELECT * FROM attachment_blob_objects WHERE storage_key=?').get(restored.storageKey)!;assert.equal(freshLedger.purged_at,null);assert.equal(freshLedger.sha256,original.sha256);assert.equal(freshLedger.verified_at,now);
 const deletes=f.bucket.deletes,cleanup=createAttachmentCleanupStore(f.db,'a',{ownerNamespace:namespace,now:()=>now});
 assert.equal(await cleanup.complete({attachmentId:original.id,storageKey:original.storageKey,token}),true);
 const retry=await runAttachmentCleanup({attachmentId:original.id,storageKey:original.storageKey,sha256:original.sha256,reason:'owner-delete'},{ownerNamespace:namespace,metadata:cleanup,blobs:createR2BlobStore(f.bucket)});
 assert.equal(retry.status,'purged');assert.equal(f.bucket.deletes,deletes);assert.equal(new TextDecoder().decode(await bytes(f)),'hello');assert.equal(f.bucket.objects.has(restored.storageKey),true);

 }finally{f.sqlite.close();}});
