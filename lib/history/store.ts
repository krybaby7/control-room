import {recoverMessageObservation,recoverSegmentObservation,reopenHistoryGap,resolveMissingTranscriptGap,type ConversationTraversalProof} from './recovery-observations.ts';
import {privateRowGrowth,type PrivateGrowth} from '../private-capacity.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import type {ModuleRow} from '../workspace-modules.ts';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import type {CollectionEnvelope,IngestReceipt,InventoryMembership} from './contracts.ts';
import {CollectionEnvelopeSchema,InventoryMembershipSchema,canonicalEnvelopeDigest,validateCollectionEnvelope} from './validation.ts';
import {finalizedHistoryObjectsGuard,type HistoryObjectSqlGuard} from './object-store.ts';
import {historyRecordId,parseHistoryRecord,HistoryCursorValueSchema,HistoryReceiptValueSchema,HistoryRunValueSchema,type HistoryRecord,type HistoryRecordKind,type HistoryRecordValue} from './record.ts';
export interface StoredHistoryRecord<K extends HistoryRecordKind=HistoryRecordKind>{record:HistoryRecord<K>;rowRevision:number;contentHash:string;streamSequence:number}
interface PhysicalHistoryRow extends ModuleRow {stream_sequence:number}
function authenticated(owner:string){if(!owner||owner.length>256)throw Error('An authenticated history owner is required.');}
async function decode<K extends HistoryRecordKind>(row:PhysicalHistoryRow,kind:K,logicalId?:string):Promise<StoredHistoryRecord<K>>{
 const record=parseHistoryRecord(JSON.parse(row.payload_json));
 if(record.id!==row.id||record.kind!==kind||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||!Number.isSafeInteger(row.stream_sequence)||row.stream_sequence<0||await contentHash(canonical(record))!==row.content_hash)throw Error('Stored history identity or digest differs.');
 const value=record.value;
 if('id'in value&&record.id!==await historyRecordId(kind,kind==='roadmap_scope'&&'revision'in value?`${value.id}@${value.revision}`:value.id)||logicalId!==undefined&&record.id!==await historyRecordId(kind,logicalId))throw Error('Stored history logical identity differs.');
 return {record:record as HistoryRecord<K>,rowRevision:row.row_revision,contentHash:row.content_hash,streamSequence:row.stream_sequence};
}
export async function readHistoryRecord<K extends HistoryRecordKind>(db:SqlDatabase,owner:string,kind:K,logicalId:string):Promise<StoredHistoryRecord<K>|null>{
 authenticated(owner);const id=await historyRecordId(kind,logicalId);
 const row=await db.prepare('SELECT id,row_revision,payload_json,content_hash,stream_sequence FROM project_history WHERE user_id=? AND id=?').bind(owner,id).first<PhysicalHistoryRow>();
 return row?decode(row,kind,logicalId):null;
}
/** after is the opaque physical id returned on the preceding page. */
export async function listHistoryRecords<K extends HistoryRecordKind>(db:SqlDatabase,owner:string,kind:K,options:{after?:string;limit?:number}={}):Promise<StoredHistoryRecord<K>[]>{
 authenticated(owner);await historyRecordId(kind,'validate');const limit=options.limit??100;
 if(!Number.isSafeInteger(limit)||limit<1||limit>200||options.after!==undefined&&(!options.after.startsWith(kind+':')||options.after.length>128))throw Error('Invalid history page.');
 const rows=(await db.prepare('SELECT id,row_revision,payload_json,content_hash,stream_sequence FROM project_history WHERE user_id=? AND id>=? AND id<? AND id>? ORDER BY id LIMIT ?').bind(owner,kind+':',kind+';',options.after??'',limit).all<PhysicalHistoryRow>()).results;
 let bytes=0;for(const row of rows)if((bytes+=new TextEncoder().encode(row.payload_json).byteLength)>2*1024*1024)throw Error('History read exceeds metadata byte bound.');
 return Promise.all(rows.map(row=>decode(row,kind)));
}
export interface HistoryProposedRow {id:string;value:HistoryRecord;rowRevision:number;previous:StoredHistoryRecord|null;streamSequence:number}
export interface HistoryAdmissionContext {
 additionalPrivateGrowth?:readonly PrivateGrowth[];
 owner:string;now:string;mutationId:string;planningRevision:number;watermark:number;
 rows:HistoryProposedRow[];
 guard:string;guardBindings:(string|number|null)[];
 job?:{id:string;kind:'area_analysis';dedupeKey:string;payload:Record<string,unknown>;executionEpoch:number};
}
export interface NativeHistoryOverlay {
 readonly database:SqlDatabase;readonly owner:string;readonly sourceId:string;readonly epoch:string;readonly scopeRevision:number;readonly executionEpoch:number;readonly runId:string;readonly observedConversationIds:readonly string[];readonly planningRevision:number;readonly receipt:IngestReceipt;
 readonly rows:readonly {record:HistoryRecord;revision:number;hash:string;previous:{id:string;revision:number;hash:string}|null}[];
}
const nativeAdmissionContexts=new WeakMap<object,{seal:string;overlay:NativeHistoryOverlay}>();
/** Only the actual ingestion admission callback receives this identity. JSON,
 * copied contexts and changed row proposals never acquire a postimage witness. */
export function requireNativeHistoryOverlay(context:unknown,owner:string):NativeHistoryOverlay{
 if(!context||typeof context!=='object')throw Error('Native history admission context required.');const found=nativeAdmissionContexts.get(context);if(!found||found.seal!==canonical(context)||found.overlay.owner!==owner)throw Error('Native history admission context identity or seal differs.');return found.overlay;
}
export interface HistoryIngestOptions {
 now:string;
 /** Server-bound acquisition phase: content pages do not create another inventory generation. */
 inventoryMemberships?:readonly InventoryMembership[];
 /** Trusted server completed-traversal proofs; never accept these from upload JSON. */
 completedTraversals?:readonly ConversationTraversalProof[];
 authorityGuard?:HistoryObjectSqlGuard;
 /** Required server dependency: quote all proposed rows/jobs against recoverability and
  * return PRE-DML assertions using this exact transient claim, or throw. */
 prepareAdmission(context:HistoryAdmissionContext):Promise<SqlStatement[]>;
 /** Test seam. Production adapters must not expose this to a wire caller. */
 beforeCommit?:()=>Promise<void>;
}
export type HistoryIngestResult={status:'committed'|'replayed';receipt:IngestReceipt}|{status:'conflict'};
function generationMatches(value:{epoch:string;scopeRevision:number;executionEpoch:number},envelope:CollectionEnvelope,epoch:number){return value.epoch===envelope.epoch&&value.scopeRevision===envelope.scopeRevision&&value.executionEpoch===epoch;}
export async function ingestHistoryPage(db:SqlDatabase,owner:string,input:unknown,options:HistoryIngestOptions):Promise<HistoryIngestResult>{
 authenticated(owner);
 if(!options||typeof options.prepareAdmission!=='function'||!Number.isFinite(Date.parse(options.now)))throw Error('History ingestion requires bounded recovery admission and a valid clock.');
 const envelope=CollectionEnvelopeSchema.parse(input),page=envelope.page;
 if(new TextEncoder().encode(canonical(envelope)).byteLength>2*1024*1024)throw Error('History envelope exceeds transport bounds.');
 if(page.inventoryExhausted&&page.nextCursor!==null)throw Error('Exhausted history inventory requires a terminal null cursor.');
 const source=await readHistoryRecord(db,owner,'source',page.sourceId);
 if(!source)throw Error('History source is unavailable.');
 const globalEpoch=(await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(owner).first<{epoch:number}>())?.epoch??0;
 if(source.record.value.paused||source.record.value.removedAt!==null||!generationMatches(source.record.value,envelope,globalEpoch))throw Error('History source generation or execution epoch differs.');
 const authority=options.authorityGuard;
 if(authority&&!await db.prepare(`SELECT 1 WHERE ${authority.sql}`).bind(...authority.params).first())throw Error('History source authority is unavailable.');
 const pageDigest=await canonicalEnvelopeDigest(envelope),receiptLogical=await contentHash(canonical([page.sourceId,envelope.epoch,envelope.scopeRevision,page.pageId]));
 const receiptExisting=await readHistoryRecord(db,owner,'ingest_page',receiptLogical);
 if(receiptExisting){const saved=receiptExisting.record.value;if(saved.acknowledgement.pageDigest!==pageDigest||saved.runId!==page.runId)throw Error('History page identity digest differs.');if(saved.executionEpoch!==globalEpoch)throw Error('History receipt execution epoch differs.');return {status:'replayed',receipt:saved.acknowledgement};}
 const cursor=await readHistoryRecord(db,owner,'cursor',page.sourceId),cursorCurrent=cursor&&generationMatches(cursor.record.value,envelope,globalEpoch)?cursor:null;
 if((cursorCurrent?.record.value.cursor??null)!==page.previousCursor)return {status:'conflict'};
 const runLogical=await contentHash(canonical([page.sourceId,envelope.epoch,envelope.scopeRevision,page.runId]));
 const run=await readHistoryRecord(db,owner,'sync_run',runLogical);
 if(run&&(!generationMatches(run.record.value,envelope,globalEpoch)||run.record.value.inventoryExhausted))throw Error('History run generation is closed or differs.');
 if(cursorCurrent&&cursorCurrent.record.value.runId!==page.runId&&page.previousCursor!==null)throw Error('History cursor belongs to another run.');
 const retainedConversations=new Map<string,StoredHistoryRecord<'conversation'>>(),retainedMessages=new Map<string,StoredHistoryRecord<'message'>>();
 const conversationIds=new Set([...page.messages.map(row=>row.conversationId),...page.segments.map(row=>row.conversationId),...page.gaps.flatMap(row=>row.conversationId?[row.conversationId]:[]),...page.conversations.flatMap(row=>row.parentConversationId?[row.parentConversationId]:[])]);
 for(const attachment of page.attachments){const row=await readHistoryRecord(db,owner,'message',attachment.messageRevisionId);if(row){retainedMessages.set(attachment.messageRevisionId,row);conversationIds.add(row.record.value.conversationId);}}
 for(const id of conversationIds){const row=await readHistoryRecord(db,owner,'conversation',id);if(row){if(row.record.value.sourceId!==page.sourceId)throw Error('Foreign retained conversation source.');retainedConversations.set(id,row);}}
 for(const row of retainedMessages.values())if(!retainedConversations.has(row.record.value.conversationId)&&!page.conversations.some(c=>c.id===row.record.value.conversationId&&c.sourceId===page.sourceId))throw Error('Foreign retained message source.');
 const objectGuard=finalizedHistoryObjectsGuard({ownerId:owner,sourceId:page.sourceId,epoch:envelope.epoch,scopeRevision:envelope.scopeRevision},page.objectManifest);
 if(!await db.prepare(`SELECT 1 WHERE ${objectGuard.sql}`).bind(...objectGuard.params).first())throw Error('History object is not finalized.');
 validateCollectionEnvelope(envelope,page.objectManifest,{authenticatedOwnerId:owner,conversations:[...retainedConversations].map(([id])=>({id,ownerId:owner,sourceId:page.sourceId})),messages:[...retainedMessages].map(([id])=>({id,ownerId:owner,sourceId:page.sourceId}))});
 for(const conversation of page.conversations)if(conversation.parentConversationId&&!page.conversations.some(c=>c.id===conversation.parentConversationId)&&!retainedConversations.has(conversation.parentConversationId))throw Error('Foreign parent conversation.');
 const retainedSegments:StoredHistoryRecord<'segment'>[]=[];
 for(const segment of page.segments)if(segment.inheritedFromSegmentId){
  const within=page.segments.find(row=>row.id===segment.inheritedFromSegmentId),retained=within?null:await readHistoryRecord(db,owner,'segment',segment.inheritedFromSegmentId),parent=within??retained?.record.value;
  const missingProof=page.gaps.some(gap=>gap.sourceId===page.sourceId&&gap.conversationId===segment.conversationId&&gap.kind==='missing_segment'&&gap.resolvedAt===null);
  // A fork may inherit the original segment from a different conversation in
  // this source. Missing lineage is retained as an explicit gap, never complete.
  if(parent&&parent.sourceId!==page.sourceId||!parent&&!missingProof)throw Error('Foreign or unexplained missing inherited segment.');
  if(segment.inheritedRange?.unit==='bytes'){
   if(parent?.bytes!==null&&parent?.bytes!==undefined&&segment.inheritedRange.end>parent.bytes)throw Error('Inherited segment range exceeds retained bytes.');
   if((!parent||parent.bytes===null)&&!missingProof)throw Error('Unknown inherited byte range requires an explicit missing segment gap.');
  }
  if(retained)retainedSegments.push(retained);
 }
 const planning=(await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>());if(!planning)throw Error('History owner workspace is unavailable.');
 const head=await db.prepare("SELECT revision,last_sequence FROM operational_stream_heads WHERE user_id=? AND stream_id='history'").bind(owner).first<{revision:number;last_sequence:number}>();
 const sequence=(head?.last_sequence??0)+1;if(!Number.isSafeInteger(sequence)||sequence<1)throw Error('History operational watermark exceeded.');
 const receipt:IngestReceipt={sourceId:page.sourceId,epoch:envelope.epoch,scopeRevision:envelope.scopeRevision,pageId:page.pageId,pageDigest,committedCursor:page.nextCursor,watermark:String(sequence),committedAt:options.now};
 const nativeGuards:Array<{sql:string;params:(string|number|null)[]}>=[];
 for(const conversation of page.conversations){
  const id=await historyRecordId('conversation',conversation.id),predicate="user_id=? AND json_extract(payload_json,'$.kind')='conversation' AND json_extract(payload_json,'$.value.sourceId')=? AND json_extract(payload_json,'$.value.nativeThreadId')=?",params=[owner,conversation.sourceId,conversation.nativeThreadId];
  const existing=(await db.prepare('SELECT id,row_revision,payload_json,content_hash,stream_sequence FROM project_history WHERE '+predicate+' LIMIT 2').bind(...params).all<PhysicalHistoryRow>()).results;
  if(existing.length>1||existing.some(row=>row.id!==id))throw Error('Native conversation identity already has a different history ID.');
  for(const row of existing)await decode(row,'conversation',conversation.id);
  nativeGuards.push({sql:'NOT EXISTS(SELECT 1 FROM project_history WHERE '+predicate+' AND id<>?)',params:[...params,id]});
 }
 for(const message of page.messages){
  const id=await historyRecordId('message',message.id),predicate="user_id=? AND json_extract(payload_json,'$.kind')='message' AND json_extract(payload_json,'$.value.conversationId')=? AND json_extract(payload_json,'$.value.nativeMessageId')=? AND json_extract(payload_json,'$.value.revisionDigest')=?",params=[owner,message.conversationId,message.nativeMessageId,message.revisionDigest];
  const existing=(await db.prepare('SELECT id,row_revision,payload_json,content_hash,stream_sequence FROM project_history WHERE '+predicate+' LIMIT 2').bind(...params).all<PhysicalHistoryRow>()).results;
  if(existing.length>1||existing.some(row=>row.id!==id))throw Error('Native message revision identity already has a different history ID.');
  for(const row of existing)await decode(row,'message',message.id);
  nativeGuards.push({sql:'NOT EXISTS(SELECT 1 FROM project_history WHERE '+predicate+' AND id<>?)',params:[...params,id]});
 }
 const rows:HistoryProposedRow[]=[],unchanged:StoredHistoryRecord[]=[];
 async function propose<K extends HistoryRecordKind>(kind:K,logicalId:string,value:HistoryRecordValue<K>,mutable=false){
  const id=await historyRecordId(kind,logicalId);let record=parseHistoryRecord({id,kind,value});const previous=await readHistoryRecord(db,owner,kind,logicalId);
  if(previous&&canonical(previous.record)===canonical(record)){unchanged.push(previous);return;}
  if(previous&&previous.record.kind===record.kind){
   // First-observed clocks and opaque physical keys are acquisition metadata,
   // not a different immutable provider revision. Fresh bytes still passed the
   // current source/object guards above; keep the original retained record.
   const comparable=(candidate:HistoryRecord)=>{
    if(candidate.kind==='message'){const {observedAt,bodyObjectKey,...value}=candidate.value;void observedAt;void bodyObjectKey;return {kind:candidate.kind,value};}
    if(candidate.kind==='segment'||candidate.kind==='attachment'){const {objectKey,...value}=candidate.value;void objectKey;return {kind:candidate.kind,value};}
    if(candidate.kind==='gap'){const {detectedAt,...value}=candidate.value;void detectedAt;return {kind:candidate.kind,value};}
    return candidate;
   };
   if(canonical(comparable(previous.record))===canonical(comparable(record))){unchanged.push(previous);return;}
  }
  if(previous&&!mutable){
   const conversationId=record.kind==='message'||record.kind==='segment'?record.value.conversationId:null;
   const conversation=conversationId?(page.conversations.find(value=>value.id===conversationId)??retainedConversations.get(conversationId)?.record.value):null;
   const context=conversation?{sourceId:page.sourceId,conversation,verifiedObjects:page.objectManifest}:null;
   const promoted=record.kind==='message'&&previous.record.kind==='message'&&context?recoverMessageObservation(previous.record.value,record.value,context):record.kind==='segment'&&previous.record.kind==='segment'&&context?recoverSegmentObservation(previous.record.value,record.value,context):record.kind==='gap'&&previous.record.kind==='gap'?reopenHistoryGap(previous.record.value,record.value):null;
   if(!promoted)throw Error('Immutable history record identity differs.');
   record=parseHistoryRecord({id,kind,value:promoted});
  }
  rows.push({id,value:record,rowRevision:(previous?.rowRevision??0)+1,previous,streamSequence:sequence});
 }
 for(const value of page.conversations){const prior=await readHistoryRecord(db,owner,'conversation',value.id);if(prior&&(prior.record.value.sourceId!==value.sourceId||prior.record.value.nativeThreadId!==value.nativeThreadId))throw Error('Immutable conversation identity differs.');await propose('conversation',value.id,value,true);}
 for(const value of page.messages)await propose('message',value.id,value);
 for(const value of page.segments)await propose('segment',value.id,value);
 for(const value of page.attachments)await propose('attachment',value.id,value);
 for(const value of page.gaps){if(value.resolvedAt!==null)throw Error('Gap resolution requires retained owner provenance.');await propose('gap',value.id,value);}
 if(options.completedTraversals){
  if(options.completedTraversals.length>100)throw Error('Completed traversal proof count exceeds bound.');
  for(const proof of options.completedTraversals){
   const conversation=page.conversations.find(value=>value.id===proof.conversationId);if(!conversation)continue;
   const gaps=(await db.prepare("SELECT id,row_revision,payload_json,content_hash,stream_sequence FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind')='gap' AND json_extract(payload_json,'$.value.sourceId')=? AND json_extract(payload_json,'$.value.conversationId')=? AND json_extract(payload_json,'$.value.kind')='missing_transcript' AND json_extract(payload_json,'$.value.resolvedAt') IS NULL ORDER BY id LIMIT 100").bind(owner,page.sourceId,conversation.id).all<PhysicalHistoryRow>()).results;
   for(const row of gaps){const original=await decode(row,'gap');const resolution=await resolveMissingTranscriptGap({originalGap:original.record.value,serverGenerated:true,sourceId:page.sourceId,conversation,segments:page.segments,messages:page.messages,attachments:page.attachments,currentGaps:page.gaps,verifiedObjects:page.objectManifest,receipt,now:options.now,runId:page.runId,traversalProof:proof});if(!resolution)continue;await propose('gap',resolution.gapUpdate.id,resolution.gapUpdate,true);await propose('gap',resolution.provenanceMarker.id,resolution.provenanceMarker);}
  }
 }
 const memberships=options.inventoryMemberships??page.conversations.map(value=>({codecVersion:1 as const,sourceId:page.sourceId,epoch:envelope.epoch,scopeRevision:envelope.scopeRevision,generation:page.runId,conversationId:value.id,archived:value.archived,observedAt:options.now}));
 if(memberships.length>1000||new Set(memberships.map(member=>member.conversationId)).size!==memberships.length)throw Error('Inventory membership exceeds page bounds or repeats.');
 for(const input of memberships){const membership=InventoryMembershipSchema.parse(input);if(membership.sourceId!==page.sourceId||membership.epoch!==envelope.epoch||membership.scopeRevision!==envelope.scopeRevision||!page.conversations.some(value=>value.id===membership.conversationId&&value.archived===membership.archived))throw Error('Inventory membership differs from admitted page.');await propose('inventory_membership',await contentHash(canonical([page.sourceId,envelope.epoch,envelope.scopeRevision,membership.generation,membership.conversationId])),membership,true);}
 await propose('cursor',page.sourceId,HistoryCursorValueSchema.parse({sourceId:page.sourceId,epoch:envelope.epoch,scopeRevision:envelope.scopeRevision,executionEpoch:globalEpoch,cursor:page.nextCursor,watermark:sequence,lastPageId:page.pageId,runId:page.runId}),true);
 // Run logical ID is a digest; its value.id uses that same immutable identity.
 await propose('sync_run',runLogical,HistoryRunValueSchema.parse({id:runLogical,sourceId:page.sourceId,epoch:envelope.epoch,scopeRevision:envelope.scopeRevision,executionEpoch:globalEpoch,inventoryExhausted:page.inventoryExhausted,lastPageId:page.pageId,watermark:sequence,updatedAt:options.now}),true);
 await propose('ingest_page',receiptLogical,HistoryReceiptValueSchema.parse({acknowledgement:receipt,executionEpoch:globalEpoch,runId:page.runId}));
 if(rows.length+unchanged.length>1500)throw Error('History page record count exceeds atomic bound.');
 const mutationId='history_'+receiptLogical,token=crypto.randomUUID(),guard='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)',guardBindings=[owner,mutationId,token];
 const statements:SqlStatement[]=[];
 const assertion=(sql:string,bindings:(string|number|null)[],gated=true)=>db.prepare(`INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${sql} THEN 1 ELSE 0 END${gated?` WHERE ${guard}`:''}`).bind(owner,mutationId,...bindings,...(gated?guardBindings:[]));
 // An unconditional CHECK ensures losing the first CAS is a transaction failure,
 // rather than a zero-row write followed by successful unrelated effects.
 statements.push(assertion('EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=? AND row_revision=? AND content_hash=?) AND EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?) AND COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=?',[owner,source.record.id,source.rowRevision,source.contentHash,owner,planning.revision,owner,globalEpoch],false));
 statements.push(db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) VALUES(?,?,?,1)').bind(...guardBindings));
 if(authority)statements.push(assertion(authority.sql,authority.params));
 for(const native of nativeGuards)statements.push(assertion(native.sql,native.params));
 statements.push(assertion(objectGuard.sql,objectGuard.params));
 if(head)statements.push(assertion("EXISTS(SELECT 1 FROM operational_stream_heads WHERE user_id=? AND stream_id='history' AND revision=? AND last_sequence=?)",[owner,head.revision,head.last_sequence]));else statements.push(assertion("NOT EXISTS(SELECT 1 FROM operational_stream_heads WHERE user_id=? AND stream_id='history')",[owner]));
 const checked=new Set<string>();
 for(const existing of [source,...retainedConversations.values(),...retainedMessages.values(),...retainedSegments,...unchanged,...rows.flatMap(row=>row.previous?[row.previous]:[])]){if(checked.has(existing.record.id))continue;checked.add(existing.record.id);statements.push(assertion('EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=? AND row_revision=? AND content_hash=?)',[owner,existing.record.id,existing.rowRevision,existing.contentHash]));}
 if(cursor)statements.push(assertion('EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=? AND row_revision=? AND content_hash=?)',[owner,cursor.record.id,cursor.rowRevision,cursor.contentHash]));
 if(!cursor)statements.push(assertion('NOT EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=?)',[owner,await historyRecordId('cursor',page.sourceId)]));
 if(run)statements.push(assertion('EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=? AND row_revision=? AND content_hash=?)',[owner,run.record.id,run.rowRevision,run.contentHash]));else statements.push(assertion('NOT EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=?)',[owner,await historyRecordId('sync_run',runLogical)]));
 for(const row of rows)if(!row.previous)statements.push(assertion('NOT EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=?)',[owner,row.id]));
 // A re-enrolled source may upload equivalent bytes that correctly retain an
 // earlier immutable key. After this exact page commits, unreferenced settled
 // new objects become abandoned (never physical deletion in this transaction).
 const retainedKeys=new Set<string>();for(const proposed of [...rows.map(row=>row.value),...unchanged.map(row=>row.record)]){const value=proposed.value as unknown as Record<string,unknown>;for(const field of ['bodyObjectKey','objectKey'])if(typeof value[field]==='string')retainedKeys.add(value[field] as string);}
 const candidates=page.objectManifest.filter(manifest=>!retainedKeys.has(manifest.key)).map(manifest=>manifest.key);
 const unused:string[]=[];if(candidates.length){const referenced=(await db.prepare("SELECT DISTINCT candidate.value key FROM json_each(?) candidate JOIN project_history record ON record.user_id=? AND (json_extract(record.payload_json,'$.value.bodyObjectKey')=candidate.value OR json_extract(record.payload_json,'$.value.objectKey')=candidate.value)").bind(canonical(candidates),owner).all<{key:string}>()).results;const used=new Set(referenced.map(row=>row.key));unused.push(...candidates.filter(key=>!used.has(key)));}
 const unitGrowth=privateRowGrowth('history_object_ledger',{status:'ready'},{status:'abandoned'}),additionalPrivateGrowth=unused.length?[{...unitGrowth,bytes:unitGrowth.bytes*unused.length}]:[];
 const jobId='history_analysis_'+receiptLogical,job={id:jobId,kind:'area_analysis' as const,dedupeKey:receiptLogical,payload:{sourceId:page.sourceId,epoch:envelope.epoch,scopeRevision:envelope.scopeRevision,watermark:sequence,pageId:page.pageId},executionEpoch:globalEpoch};
 const admissionContext:HistoryAdmissionContext={owner,now:options.now,mutationId,planningRevision:planning.revision,watermark:sequence,rows,guard,guardBindings,job,additionalPrivateGrowth};
 const overlayRows=await Promise.all(rows.map(async row=>({record:structuredClone(row.value),revision:row.rowRevision,hash:await contentHash(canonical(row.value)),previous:row.previous?{id:row.previous.record.id,revision:row.previous.rowRevision,hash:row.previous.contentHash}:null})));
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};freeze(overlayRows);const immutableReceipt=structuredClone(receipt);freeze(immutableReceipt);
 nativeAdmissionContexts.set(admissionContext,{seal:canonical(admissionContext),overlay:Object.freeze({database:db,owner,sourceId:page.sourceId,epoch:envelope.epoch,scopeRevision:envelope.scopeRevision,executionEpoch:globalEpoch,runId:page.runId,observedConversationIds:Object.freeze(page.conversations.map(value=>value.id)),planningRevision:planning.revision,receipt:immutableReceipt,rows:overlayRows})});
 statements.push(...await options.prepareAdmission(admissionContext));
 requireNativeHistoryOverlay(admissionContext,owner);
 for(const row of rows){const payload=canonical(row.value),hash=await contentHash(payload);if(row.previous)statements.push(db.prepare(`UPDATE project_history SET row_revision=?,payload_json=?,content_hash=?,stream_sequence=? WHERE user_id=? AND id=? AND row_revision=? AND ${guard}`).bind(row.rowRevision,payload,hash,sequence,owner,row.id,row.previous.rowRevision,...guardBindings));else statements.push(db.prepare(`INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash,stream_sequence) SELECT ?,?,?,?,?,? WHERE ${guard}`).bind(owner,row.id,row.rowRevision,payload,hash,sequence,...guardBindings));}
 if(unused.length)statements.push(db.prepare(`UPDATE history_object_ledger SET status='abandoned' WHERE user_id=? AND source_id=? AND epoch=? AND scope_revision=? AND status='ready' AND pending_token IS NULL AND purged_at IS NULL AND key IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM project_history record WHERE record.user_id=history_object_ledger.user_id AND (json_extract(record.payload_json,'$.value.bodyObjectKey')=history_object_ledger.key OR json_extract(record.payload_json,'$.value.objectKey')=history_object_ledger.key)) AND ${guard}`).bind(owner,page.sourceId,envelope.epoch,envelope.scopeRevision,canonical(unused),...guardBindings));
 statements.push(db.prepare(`INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) SELECT ?,'history',?,? WHERE ${guard} ON CONFLICT(user_id,stream_id) DO UPDATE SET revision=excluded.revision,last_sequence=excluded.last_sequence`).bind(owner,(head?.revision??0)+1,sequence,...guardBindings));
 statements.push(db.prepare(`INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) SELECT ?,?,'area_analysis',?,?,?,'pending',?,0 WHERE ${guard}`).bind(owner,jobId,receiptLogical,canonical(job.payload),options.now,globalEpoch,...guardBindings));
 statements.push(assertion("EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=? AND stream_sequence=?) AND EXISTS(SELECT 1 FROM operational_stream_heads WHERE user_id=? AND stream_id='history' AND last_sequence=?) AND EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?)",[owner,await historyRecordId('ingest_page',receiptLogical),sequence,owner,sequence,owner,planning.revision]));
 statements.push(db.prepare(`DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=? AND ${guard}`).bind(owner,mutationId,...guardBindings));
 statements.push(db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...guardBindings));
 await options.beforeCommit?.();
 try{await db.batch(statements);return {status:'committed',receipt};}catch(error){
  const saved=await readHistoryRecord(db,owner,'ingest_page',receiptLogical);if(saved)return ingestHistoryPage(db,owner,envelope,{...options,beforeCommit:undefined});
  if(/assertion_valid|CHECK constraint failed|UNIQUE constraint failed: workspace_command_guards/u.test(String(error)))return {status:'conflict'};
  throw error;
 }
}
