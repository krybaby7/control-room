// Synthetic actual Miniflare D1 + R2 source retention and reviewed native restore.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {ownerAttachmentServices} from '../lib/attachment-services.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {attachmentRecordSchema} from '../lib/evidence-module.ts';
import {getWorkspaceNamespaces} from '../lib/workspace-namespaces.ts';
import {createR2BlobStore,stageAttachmentUpload,readReadyAttachment} from '../lib/attachments.ts';
import {beginUpload,finishUpload} from '../lib/attachment-upload-fences.ts';
import {exportWorkspaceBundle,parseWorkspaceBundle} from '../lib/workspace-export.ts';
import {writeAttachmentArchive} from '../lib/attachment-archive-export.ts';
import {stageAttachmentArchive} from '../lib/attachment-archive-staging.ts';
import {resolveAttachmentNamespace} from '../lib/attachment-namespace-access.ts';
import {importManualSource} from '../lib/sources/http.ts';
import {readSourceSyncState} from '../lib/sources/store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 or newer is required.');
const owner='synthetic-d1-retained-source-owner',now='2026-10-18T12:00:00.000Z',text='Synthetic owner-selected native source.\nAll source bytes retained in R2.\n',bytes=new TextEncoder().encode(text);
const stream=value=>new ReadableStream({start(controller){controller.enqueue(value.slice());controller.close();}});
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated source D1 R2 fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,r2Buckets:['BUCKET'],r2Persist:false,cf:false});
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET'),store=createR2BlobStore(bucket);
 const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort();for(const name of migrations){const source=await readFile(new URL(`../drizzle/${name}`,import.meta.url),'utf8');for(const sql of source.split('--> statement-breakpoint'))if(sql.trim())await db.prepare(sql.trim()).run();}
 await loadWorkspace(db,owner,()=>createSeedWorkspace(now),now);
 async function send(command){return executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:(await readCurrent(db,owner,now)).revision,mutationId:crypto.randomUUID(),command},{db,handlers:workspaceHandlers,now:()=>now,...await ownerAttachmentServices(db,owner,now,bucket)});}
 assert.equal((await send({type:'sources.connection.create',value:{provider:'documents',label:'Synthetic selected native document',accessMode:'interactive',enabled:true}})).status,'committed');
 const connection=(await ownerReader(db,owner).list('source_connections'))[0],project=(await readCurrent(db,owner,now)).workspace.projects[0];
 assert.equal((await send({type:'sources.target.create',value:{connectionId:connection.id,projectId:project.id,kind:'document',providerResourceId:'synthetic-document',canonicalUrl:null,selectedPaths:['source.txt'],staleAfterSeconds:600}})).status,'committed');
 const target=(await ownerReader(db,owner).list('source_targets'))[0];assert.equal((await readSourceSyncState(db,owner,target.id)).paused,true);
 assert.equal((await send({type:'sources.resume',id:target.id,expectedRowRevision:target.row_revision})).status,'committed');
 assert.equal((await send({type:'attachment.reserve',value:{filename:'source.txt',mimeType:'text/plain',expectedBytes:bytes.length}})).status,'committed');
 const row=(await ownerReader(db,owner).list('attachments'))[0],reserved=attachmentRecordSchema.parse(JSON.parse(row.payload_json)),namespace=(await getWorkspaceNamespaces(db,owner)).blobNamespace;
 const token=await beginUpload(db,owner,{record:reserved,rowRevision:row.row_revision,now,ownerNamespace:namespace});assert.ok(token);assert.equal((await stageAttachmentUpload(owner,reserved,stream(bytes),store,{ownerNamespace:namespace,now})).status,'staged');assert.equal(await finishUpload(db,owner,{token,now,definitivelySettled:true}),true);assert.equal((await send({type:'attachment.finalize',id:reserved.id})).status,'committed');
 const ready=attachmentRecordSchema.parse(JSON.parse((await ownerReader(db,owner).get('attachments',reserved.id)).payload_json)),sha256=await contentHash(bytes);assert.equal(ready.sha256,sha256);assert.deepEqual(new Uint8Array(await (await bucket.get(ready.storageKey)).arrayBuffer()),bytes);
 const before=await readCurrent(db,owner,now),stateBefore=await readSourceSyncState(db,owner,target.id),input={revision:before.revision,mutationId:crypto.randomUUID(),expectedRowRevision:target.row_revision,contentAttachmentId:ready.id,document:{metadata:{version:1,sourceId:'synthetic-document',sourceVersion:'revision-1',filename:'source.txt',contentType:'text/plain',sourceModifiedAt:null,canonicalUrl:null,extractionLimitations:[]},content:text}};
 const imported=await importManualSource(db,owner,target.id,input,()=>now);assert.equal(imported.status,'completed');const after=await readCurrent(db,owner,now);assert.equal(after.revision,before.revision+1);assert.deepEqual(after.workspace,before.workspace);const state=await readSourceSyncState(db,owner,target.id);assert.equal(state.operationalRevision,stateBefore.operationalRevision+2);assert.equal(state.lastSuccessAt,now);assert.equal((await importManualSource(db,owner,target.id,input,()=>now)).run.id,imported.run.id);assert.equal((await readCurrent(db,owner,now)).revision,after.revision);
 const observations=(await ownerReader(db,owner).list('source_observations')).map(row=>({id:row.id,payload:JSON.parse(row.payload_json)}));assert.equal(observations.length,1);assert.deepEqual(observations[0].payload.contentAttachmentRef,{id:ready.id,sha256,bytes:bytes.length});assert.equal(observations[0].payload.contentDigest,await contentHash(canonical(observations[0].payload.payload)));
 // The exact immutable observation is owner-citable context, never an automatic acceptance.
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM acceptance_records WHERE user_id=?').bind(owner).first()).n,0);
 const bundle=await exportWorkspaceBundle(db,owner,{now:()=>now});assert.doesNotThrow(()=>parseWorkspaceBundle(bundle));assert.equal(bundle.attachments[0].availability,'excluded');
 const zip=new Uint8Array(await new Response(writeAttachmentArchive(bundle,[ready],async id=>{assert.equal(id,ready.id);return (await readReadyAttachment(owner,ready,store,{ownerNamespace:namespace,now})).bytes;})).arrayBuffer());
 // A synthetic private grant exists only to prove restoration cannot recreate authority.
 await db.prepare('INSERT INTO source_access_grants(user_id,connection_id,mode,principal_ref,resource_scope_json,verified_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(owner,connection.id,'interactive','synthetic-principal','["synthetic-document"]',now,'2026-10-19T00:00:00.000Z').run();
 const revision=(await readCurrent(db,owner,now)).revision,staged=await stageAttachmentArchive(db,owner,stream(zip),{store,now:()=>now,targetRevision:revision});assert.equal(staged.archive.files,1);assert.equal((await send({type:'workspace.import.commit',importId:staged.stage.id,hash:staged.stage.hash,targetRevision:revision,mode:'replace'})).status,'committed');
 const restored=attachmentRecordSchema.parse(JSON.parse((await ownerReader(db,owner).get('attachments',ready.id)).payload_json)),restoredNamespace=await resolveAttachmentNamespace(db,owner,restored);assert.ok(restoredNamespace);assert.notEqual(restored.storageKey,ready.storageKey);assert.deepEqual((await readReadyAttachment(owner,restored,store,{ownerNamespace:restoredNamespace,now})).bytes,bytes);assert.equal(await contentHash(new Uint8Array(await (await bucket.get(restored.storageKey)).arrayBuffer())),sha256);
 assert.deepEqual((await ownerReader(db,owner).list('source_observations')).map(row=>({id:row.id,payload:JSON.parse(row.payload_json)})),observations);const restoredState=await readSourceSyncState(db,owner,target.id);assert.equal(restoredState.paused,true);assert.equal(restoredState.cursor,null);assert.equal(restoredState.etag,null);assert.ok(restoredState.executionEpoch>state.executionEpoch);assert.equal((await db.prepare('SELECT COUNT(*) n FROM source_access_grants WHERE user_id=?').bind(owner).first()).n,0);assert.equal((await db.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=? AND status IN ('pending','running','claimed') AND cancel_requested=0").bind(owner).first()).n,0);
 console.log(JSON.stringify({migrations:migrations.length,sourceImport:'explicit-owner',observations:observations.length,operationalRevision:state.operationalRevision,rawBytes:bytes.length,sha256,nativeArchive:'actual-R2-byte-verified',restore:'paused-no-grants-no-runnable-intents'}));
 console.log('PASS actual isolated Miniflare D1 + R2: owner source selection, attachment finalization, immutable retained observation, replay, full native archive and reviewed restore.');
}finally{await mf.dispose();}
