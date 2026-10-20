import {createHash} from 'node:crypto';
import {canonical,contentHash} from './canonical-json.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {attachmentStorageKey,readReadyAttachment,type BlobStore} from './attachments.ts';
import {attachmentArchivePath} from './attachment-archive-export.ts';
import {readStoredArchive,writeStoredArchive} from './attachment-archive.ts';
import {inspectAttachmentManifest} from './attachment-manifest.ts';
import {getWorkspaceNamespaces} from './workspace-namespaces.ts';
import {verifyFrozenRecoveryDatabase,assertRecoveryBlobCopyEligible,type RecoveryMaintenanceReceipt} from './recovery-maintenance.ts';
import type {RecoveryPrivateScalar} from './recovery-private-transform.ts';
type Row=Record<string,RecoveryPrivateScalar>;
/** Privileged OFFLINE package sink. IDs are generated here, not request paths.
 * write must consume the stream; open must read the actual saved artifact.
 * This is not an uncharged application-bucket upload or a hosted route. */
export interface RecoveryArtifactSink {write(id:string,stream:ReadableStream<Uint8Array>):Promise<void>;open(id:string):Promise<ReadableStream<Uint8Array>>}
export interface RecoveryAttachmentProof {readonly files:number;readonly bytes:number;readonly stagingArtifacts:readonly {id:string;stageId:string;sha256:string;bytes:number;included:number;notWritten:number;excluded:number}[]}
interface Internal {source:SqlDatabase;target:SqlDatabase;sourceOperation:string;targetOperation:string;root:string;revision:number;extraRows:{attachment_blob_objects:Row[];attachment_upload_attempts:Row[]};recheck:()=>Promise<void>}
const proofs=new WeakMap<object,Internal>();
const objectColumns='storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at',attemptColumns='token,attachment_id,storage_key,created_at,settled_at';
async function boundedProof<T>(operation:()=>Promise<T>,ms:number,signal?:AbortSignal):Promise<T>{
 if(!Number.isSafeInteger(ms)||ms<1||ms>1200000)throw new Error('Invalid private recovery verification deadline.');
 let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{};
 const stop=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error('Private recovery byte verification deadline exceeded or was cancelled.'));timer=setTimeout(abort,ms);signal?.addEventListener('abort',abort,{once:true});});
 try{if(signal?.aborted)throw new Error('Private recovery byte verification was cancelled.');return await Promise.race([Promise.resolve().then(operation),stop]);}finally{if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
const encoder=new TextEncoder(),maxArtifactBytes=208*1024*1024,maxAllArtifactBytes=320*1024*1024;
async function root(db:SqlDatabase,receipt:RecoveryMaintenanceReceipt){const row=await db.prepare('SELECT private_hash,write_revision FROM operator_recovery_maintenance WHERE singleton=1 AND operation_id=? AND owner_id=?').bind(receipt.operationId,receipt.ownerId).first<{private_hash:string|null;write_revision:number}>();if(!row?.private_hash||!/^[a-f0-9]{64}$/.test(row.private_hash))throw new Error('Actual bound recovery private root is unavailable.');return row;}
async function currentFiles(source:SqlDatabase,target:SqlDatabase,owner:string,sourceReceipt:RecoveryMaintenanceReceipt,sourceStore:BlobStore,targetStore:BlobStore){
 const a=await getWorkspaceNamespaces(source,owner),b=await getWorkspaceNamespaces(target,owner);if(!a||!b||a.blobNamespace===b.blobNamespace)throw new Error('Fresh attachment namespace is required.');
 if(await source.prepare('SELECT namespace FROM attachment_blob_namespaces WHERE namespace=? LIMIT 1').bind(b.blobNamespace).first()||await source.prepare('SELECT namespace FROM attachment_blob_objects WHERE namespace=? LIMIT 1').bind(b.blobNamespace).first())throw new Error('Target attachment namespace reuses source physical history.');
 const originals=(await source.prepare("SELECT id,row_revision,payload_json,content_hash FROM attachments WHERE user_id=? AND json_valid(payload_json) AND json_extract(payload_json,'$.status')='ready' ORDER BY id LIMIT 501").bind(owner).all<{id:string;row_revision:number;payload_json:string;content_hash:string}>()).results;
 const targetCount=await target.prepare("SELECT COUNT(*) count FROM attachments WHERE user_id=? AND json_valid(payload_json) AND json_extract(payload_json,'$.status')='ready'").bind(owner).first<{count:number}>();
 if(originals.length>500||targetCount?.count!==originals.length)throw new Error('Original ready attachment set differs at target.');
 const objects:Row[]=[],attempts:Row[]=[];let bytes=0;
 for(const original of originals){
  const record=attachmentRecordSchema.parse(JSON.parse(original.payload_json));if(record.id!==original.id||await contentHash(canonical(record))!==original.content_hash)throw new Error('Frozen ready attachment metadata differs.');
  await assertRecoveryBlobCopyEligible(source,sourceReceipt,record.storageKey);
  const selected=await target.prepare('SELECT row_revision,payload_json,content_hash FROM attachments WHERE user_id=? AND id=?').bind(owner,record.id).first<{row_revision:number;payload_json:string;content_hash:string}>();
  if(!selected)throw new Error('Original attachment is missing at target.');
  const copy=attachmentRecordSchema.parse(JSON.parse(selected.payload_json)),expected={...record,storageKey:attachmentStorageKey(b.blobNamespace,record.id)};
  if(selected.row_revision!==original.row_revision||canonical(copy)!==canonical(expected)||await contentHash(canonical(copy))!==selected.content_hash)throw new Error('Ready attachment content or identity changed during recovery.');
  const namespace=record.storageKey.split('/')[1];if(!namespace||record.storageKey!==attachmentStorageKey(namespace,record.id))throw new Error('Frozen attachment key differs.');
  const oldBytes=await readReadyAttachment(owner,record,sourceStore,{ownerNamespace:namespace,now:sourceReceipt.createdAt}),newBytes=await readReadyAttachment(owner,copy,targetStore,{ownerNamespace:b.blobNamespace,now:sourceReceipt.createdAt});
  if(oldBytes.metadata.sha256!==newBytes.metadata.sha256||oldBytes.bytes.length!==newBytes.bytes.length)throw new Error('Actual replacement attachment bytes differ.');
  const object=await target.prepare('SELECT '+objectColumns+' FROM attachment_blob_objects WHERE user_id=? AND storage_key=?').bind(owner,copy.storageKey).first<Row>();
  if(!object||object.attachment_id!==record.id||object.namespace!==b.blobNamespace||object.bytes!==record.expectedBytes||object.sha256!==record.sha256||typeof object.verified_at!=='string'||!Number.isFinite(Date.parse(object.verified_at))||object.purged_at!==null)throw new Error('Verified fresh attachment ledger differs.');
  const uploads=(await target.prepare('SELECT '+attemptColumns+' FROM attachment_upload_attempts WHERE user_id=? AND storage_key=? ORDER BY token LIMIT 2').bind(owner,copy.storageKey).all<Row>()).results;
  if(uploads.length!==1||uploads[0].attachment_id!==record.id||typeof uploads[0].settled_at!=='string'||!Number.isFinite(Date.parse(uploads[0].settled_at)))throw new Error('Fresh replacement PUT lacks a definitive original token settlement.');
  objects.push({...object});attempts.push({...uploads[0]});bytes+=record.expectedBytes;
 }
 return {objects,attempts,bytes};
}
interface StageRow {id:string;namespace:string;source_manifest_hash:string;manifest_json:string;created_at:string;expires_at:string;status:string}
interface FileClaim {id:string;bytes:number;sha256:string;path:string;availability:'included'|'not-written'|'excluded-fenced';record:ReturnType<typeof attachmentRecordSchema.parse>}
async function stageFiles(source:SqlDatabase,owner:string,stage:StageRow,store:BlobStore):Promise<FileClaim[]>{
 const manifest:unknown=JSON.parse(stage.manifest_json);if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||await contentHash(canonical(manifest))!==stage.source_manifest_hash)throw new Error('Original staged manifest differs.');
 const modules=(manifest as {modules?:unknown}).modules;if(!modules||typeof modules!=='object'||Array.isArray(modules))throw new Error('Original staged module claims are unavailable.');
 const inspection=inspectAttachmentManifest(modules as Parameters<typeof inspectAttachmentManifest>[0]);if(inspection.unresolvedLegacy)throw new Error('Legacy staged attachment bytes need a reviewed typed adapter.');
 const moduleRecords=((modules as Record<string,{records?:unknown[]}>).attachments?.records??[]),records=new Map<string,ReturnType<typeof attachmentRecordSchema.parse>>();
 for(const raw of moduleRecords){const row=raw as {id?:unknown;value?:unknown},record=attachmentRecordSchema.parse(row.value);if(row.id!==record.id)throw new Error('Original staged attachment identity differs.');if(record.status==='ready')records.set(record.id,record);}
 const ledger=(await source.prepare('SELECT '+objectColumns+' FROM attachment_blob_objects WHERE user_id=? AND namespace=? ORDER BY attachment_id LIMIT 501').bind(owner,stage.namespace).all<Row>()).results;
 if(ledger.length>500||ledger.length!==inspection.entries.length||records.size!==inspection.entries.length)throw new Error('Original staged physical reservation set differs.');
 const files:FileClaim[]=[];
 for(const entry of inspection.entries){
  const record=records.get(entry.id),object=ledger.find(row=>row.attachment_id===entry.id),key=attachmentStorageKey(stage.namespace,entry.id);
  if(!record||!object||object.storage_key!==key||object.namespace!==stage.namespace||object.bytes!==entry.bytes||object.sha256!==entry.sha256)throw new Error('Original stage physical identity differs.');
  const excluded=object.purged_at!==null||Boolean(await source.prepare('SELECT storage_key FROM attachment_blob_fences WHERE storage_key=? LIMIT 1').bind(key).first())||Boolean(await source.prepare('SELECT storage_key FROM attachment_archive_cleanup_claims WHERE storage_key=? LIMIT 1').bind(key).first());
  const path=await attachmentArchivePath(entry.id);
  if(excluded){files.push({id:entry.id,bytes:entry.bytes,sha256:entry.sha256,path,availability:'excluded-fenced',record:{...record,storageKey:key}});continue;}
  const head=await store.head(key);if(!head){if(object.verified_at!==null)throw new Error('Previously verified staged bytes are missing.');files.push({id:entry.id,bytes:entry.bytes,sha256:entry.sha256,path,availability:'not-written',record:{...record,storageKey:key}});continue;}
  await readReadyAttachment(owner,{...record,storageKey:key},store,{ownerNamespace:stage.namespace,now:stage.created_at});
  files.push({id:entry.id,bytes:entry.bytes,sha256:entry.sha256,path,availability:'included',record:{...record,storageKey:key}});
 }
 return files;
}
async function verifySavedArtifact(sink:RecoveryArtifactSink,id:string,manifest:unknown,files:FileClaim[]){
 const opened=await sink.open(id),reader=opened.getReader(),hash=createHash('sha256');let bytes=0;
 const measured=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(next.done){reader.releaseLock();controller.close();return;}bytes+=next.value.byteLength;if(bytes>maxArtifactBytes)throw new Error('Private staging artifact exceeds its limit.');hash.update(next.value);controller.enqueue(next.value);}catch(error){void reader.cancel().catch(()=>{});controller.error(error);}},async cancel(){await reader.cancel();}});
 const expected=new Map(files.filter(file=>file.availability==='included').map(file=>[file.path,file]));let first=true,seen=0;
 for await(const entry of readStoredArchive(measured)){
  if(first){first=false;if(entry.path!=='manifest.json'||canonical(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(entry.bytes)))!==canonical(manifest))throw new Error('Saved private staging manifest differs.');continue;}
  const file=expected.get(entry.path);if(!file||entry.bytes.length!==file.bytes||await contentHash(entry.bytes)!==file.sha256)throw new Error('Saved original stage bytes differ.');expected.delete(entry.path);seen++;
 }
 if(first||expected.size||seen!==files.filter(file=>file.availability==='included').length)throw new Error('Saved original stage artifact is incomplete.');
 return {bytes,sha256:hash.digest('hex')};
}
/** Verifies actual native R2 bytes and saves original staged files into a private
 * offline package. Nothing is imported, accepted, granted or dispatched. */
export async function proveRecoveryAttachments(source:SqlDatabase,sourceReceipt:RecoveryMaintenanceReceipt,target:SqlDatabase,targetReceipt:RecoveryMaintenanceReceipt,options:{sourceStore:BlobStore;targetStore:BlobStore;artifacts?:RecoveryArtifactSink;deadlineMs?:number;signal?:AbortSignal}):Promise<RecoveryAttachmentProof>{
 const ms=options.deadlineMs??600000,until=Date.now()+ms;
 return boundedProof(async()=>{
 const check=()=>{if(Date.now()>=until||options.signal?.aborted)throw new Error('Private recovery byte verification deadline exceeded or was cancelled.');};
 await verifyFrozenRecoveryDatabase(source,sourceReceipt);
 if(sourceReceipt.ownerId!==targetReceipt.ownerId||sourceReceipt.manifestSha256!==targetReceipt.manifestSha256)throw new Error('Recovery attachment binding differs.');
 const sourceRoot=await root(source,sourceReceipt),targetRoot=await root(target,targetReceipt);if(sourceRoot.private_hash!==targetRoot.private_hash)throw new Error('Recovery private roots differ.');
 const owner=sourceReceipt.ownerId,current=await currentFiles(source,target,owner,sourceReceipt,options.sourceStore,options.targetStore);
 const stages=(await source.prepare('SELECT id,namespace,source_manifest_hash,manifest_json,created_at,expires_at,status FROM attachment_archive_stages WHERE user_id=? ORDER BY id LIMIT 100001').bind(owner).all<StageRow>()).results;
 if(stages.length>100000||stages.length&&!options.artifacts)throw new Error('A private offline staging artifact sink is required.');
 const saved:RecoveryAttachmentProof['stagingArtifacts'][number][]=[],checks:Array<()=>Promise<void>>=[];let total=0;
 for(const stage of stages){
  check();const registry=await source.prepare("SELECT purpose FROM attachment_blob_namespaces WHERE user_id=? AND namespace=?").bind(owner,stage.namespace).first<{purpose:string}>();
  if(registry?.purpose!=='archive-stage')throw new Error('Original stage namespace ownership differs.');
  const files=await stageFiles(source,owner,stage,options.sourceStore),id=crypto.randomUUID()+'.zip';
  const manifest={format:'control-room-private-staging-recovery',version:1,authority:'inspection-only',privateContinuitySha256:sourceRoot.private_hash,stageId:stage.id,sourceManifestHash:stage.source_manifest_hash,sourceStatus:stage.status,createdAt:stage.created_at,expiresAt:stage.expires_at,files:files.map(file=>({id:file.id,bytes:file.bytes,sha256:file.sha256,path:file.path,availability:file.availability})),limitations:['Private staging recovery data; not a workspace import or physical access grant.','Original manifest and raw import bytes retain their exact IDs in the separate sealed private continuity package.','Not-written and permanently fenced files are never fabricated or resurrected.']};
  async function* entries(){yield {path:'manifest.json',bytes:encoder.encode(JSON.stringify(manifest))};for(const file of files)if(file.availability==='included'){const actual=await readReadyAttachment(owner,file.record,options.sourceStore,{ownerNamespace:stage.namespace,now:stage.created_at});yield {path:file.path,bytes:actual.bytes};}}
  await options.artifacts!.write(id,writeStoredArchive(entries()));
  const descriptor=await verifySavedArtifact(options.artifacts!,id,manifest,files);total+=descriptor.bytes;if(total>maxAllArtifactBytes)throw new Error('Private staging artifact package exceeds its aggregate limit.');
  saved.push({id,stageId:stage.id,...descriptor,included:files.filter(file=>file.availability==='included').length,notWritten:files.filter(file=>file.availability==='not-written').length,excluded:files.filter(file=>file.availability==='excluded-fenced').length});
  checks.push(async()=>{const actual=await verifySavedArtifact(options.artifacts!,id,manifest,files);if(actual.bytes!==descriptor.bytes||actual.sha256!==descriptor.sha256)throw new Error('Sealed private staging artifact changed.');});
 }
 check();const proof=Object.freeze({files:current.objects.length,bytes:current.bytes,stagingArtifacts:Object.freeze(saved.map(value=>Object.freeze(value)))});
 proofs.set(proof,{source,target,sourceOperation:sourceReceipt.operationId,targetOperation:targetReceipt.operationId,root:sourceRoot.private_hash!,revision:targetRoot.write_revision,extraRows:{attachment_blob_objects:current.objects,attachment_upload_attempts:current.attempts},async recheck(){return boundedProof(async()=>{const again=await currentFiles(source,target,owner,sourceReceipt,options.sourceStore,options.targetStore);if(canonical({objects:again.objects,attempts:again.attempts})!==canonical({objects:current.objects,attempts:current.attempts}))throw new Error('Verified fresh attachment generation changed.');for(const check of checks)await check();},ms,options.signal);}});
 return proof;
 },ms,options.signal);
}
/** Only proof objects produced by actual verification above are accepted. JSON,
 * copies, hashes and imported historical rows never establish byte authority. */
export async function readRecoveryAttachmentProof(proof:RecoveryAttachmentProof|undefined,source:SqlDatabase,sourceReceipt:RecoveryMaintenanceReceipt,target:SqlDatabase,targetReceipt:RecoveryMaintenanceReceipt):Promise<Internal['extraRows']>{
 const stages=await source.prepare('SELECT COUNT(*) count FROM attachment_archive_stages WHERE user_id=?').bind(sourceReceipt.ownerId).first<{count:number}>(),ready=await source.prepare("SELECT COUNT(*) count FROM attachments WHERE user_id=? AND json_valid(payload_json) AND json_extract(payload_json,'$.status')='ready'").bind(sourceReceipt.ownerId).first<{count:number}>();
 if(!proof){if(stages?.count||ready?.count)throw new Error('Actual sealed attachment/staging recovery proof is required.');return {attachment_blob_objects:[],attachment_upload_attempts:[]};}
 const internal=proofs.get(proof),targetRoot=await root(target,targetReceipt),sourceRoot=await root(source,sourceReceipt);
 if(!internal||internal.source!==source||internal.target!==target||internal.sourceOperation!==sourceReceipt.operationId||internal.targetOperation!==targetReceipt.operationId||internal.root!==sourceRoot.private_hash||internal.root!==targetRoot.private_hash||internal.revision!==targetRoot.write_revision)throw new Error('Actual native recovery byte proof differs.');
 if(proof.stagingArtifacts.length!==stages?.count||proof.files!==ready?.count)throw new Error('Native recovery byte proof omits original records.');
 await internal.recheck();return structuredClone(internal.extraRows);
}
