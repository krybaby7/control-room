import {sourceSemanticDigest} from './source-identity.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import type {ClaimInputSnapshot} from './claims.ts';
import type {AnalysisCheckpoint,AssociationRule,HistoryClaim,HistorySegment,RepositoryEvidenceSnapshot,SourceContext} from './contracts.ts';
import {historyRecordId,parseHistoryRecord,type HistoryRecord,type HistoryRecordKind} from './record.ts';
import type {PrivateHistoryBucket} from './object-store.ts';
import {resolveAssociation} from './association.ts';
import {historyInputWatermark} from './input-watermark.ts';
import {readCompletedHistoryAnalysis} from './analysis-journal.ts';
import type {HistoryPublicationExpectedRow,HistoryPublicationHead} from './publication.ts';
import type {ImmutableRepositoryEvidence} from './repository-evidence.ts';
export interface HistoryAnalysisInputOptions {
 sourceIds:readonly string[];bucket:PrivateHistoryBucket;now:string;
 /** Independent server proof ports only. Imported rule/snapshot payloads are
  * never sufficient. No network/provider calls belong inside this loader. */
 verifiedRepositoryRules?:readonly AssociationRule[];
 trustVerifiedRepositoryRule?:(rule:AssociationRule)=>boolean;
 readVerifiedRepository?:(snapshot:RepositoryEvidenceSnapshot,maxBytes:number)=>Promise<ImmutableRepositoryEvidence|null>;
}
export interface HistoryAnalysisRowProof {physicalId:string;rowRevision:number;contentHash:string;streamSequence:number}
export interface LoadedHistoryAnalysisInput {
 retainedClaims:HistoryClaim[];checkpointProofs:{checkpointId:string;requestId:string;inputDigest:string;checkpointDigest:string;extractionDigest:string;sourceIds:string[]}[];
 snapshot:ClaimInputSnapshot;segments:HistorySegment[];checkpoints:AnalysisCheckpoint[];trustedCheckpointIds:string[];
 planningRevision:number;historyHead:HistoryPublicationHead|null;historyInputWatermark:string;executionEpoch:number;
 sourceRefs:{sourceId:string;epoch:string;scopeRevision:number;rowRevision:number;contentHash:string;semanticDigest?:string}[];
 expectedRows:HistoryPublicationExpectedRow[];rowProofs:HistoryAnalysisRowProof[];unknowns:string[];privateInputBytes:number;
}
interface Captured {record:HistoryRecord;logicalId:string;revision:number;hash:string;sequence:number}
async function logicalId(record:HistoryRecord):Promise<string>{
 if(record.kind==='cursor')return record.value.sourceId;
 if(record.kind==='ingest_page'){const r=record.value.acknowledgement;return contentHash(canonical([r.sourceId,r.epoch,r.scopeRevision,r.pageId]));}
 if(record.kind==='inventory_membership'){const r=record.value;return contentHash(canonical([r.sourceId,r.epoch,r.scopeRevision,r.generation,r.conversationId]));}
 return record.kind==='roadmap_scope'?`${record.value.id}@${record.value.revision}`:record.value.id;
}
async function head(db:SqlDatabase,owner:string):Promise<HistoryPublicationHead|null>{const row=await db.prepare("SELECT revision,last_sequence FROM operational_stream_heads WHERE user_id=? AND stream_id='history'").bind(owner).first<{revision:number;last_sequence:number}>();if(row&&(!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.last_sequence)||row.last_sequence<0))throw Error('Invalid history input head');return row?{revision:row.revision,lastSequence:row.last_sequence}:null;}
async function epoch(db:SqlDatabase,owner:string){const value=(await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(owner).first<{epoch:number}>())?.epoch??0;if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid execution epoch');return value;}
async function capture(db:SqlDatabase,owner:string):Promise<Captured[]>{
 const captured:Captured[]=[];let after='',bytes=0;
 for(;;){const rows=(await db.prepare('SELECT id,row_revision,payload_json,content_hash,stream_sequence FROM project_history WHERE user_id=? AND id>? ORDER BY id LIMIT 200').bind(owner,after).all<{id:string;row_revision:number;payload_json:string;content_hash:string;stream_sequence:number}>()).results;
  for(const row of rows){if(row.id<=after||captured.length>=10000||(bytes+=new TextEncoder().encode(row.payload_json).length)>8*1024*1024)throw Error('Analysis metadata exceeds bounded capacity');const record=parseHistoryRecord(JSON.parse(row.payload_json)),logical=await logicalId(record);if(record.id!==row.id||record.id!==await historyRecordId(record.kind,logical)||await contentHash(canonical(record))!==row.content_hash||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||!Number.isSafeInteger(row.stream_sequence)||row.stream_sequence<0)throw Error('Analysis record integrity or physical identity differs');captured.push({record,logicalId:logical,revision:row.row_revision,hash:row.content_hash,sequence:row.stream_sequence});after=row.id;}
  if(rows.length<200)return captured;
 }
}
/** Owner-scoped pinned private read. All retained revisions survive selection;
 * missing content is an explicit unavailable body, never a fabricated citation.
 * Publication still must guard these row/head/planning/source proofs atomically. */
export async function loadHistoryAnalysisInput(db:SqlDatabase,owner:string,options:HistoryAnalysisInputOptions):Promise<LoadedHistoryAnalysisInput>{
 if(!owner||owner.length>256||!Number.isFinite(Date.parse(options.now))||!Array.isArray(options.sourceIds)||!options.sourceIds.length||options.sourceIds.length>100||options.sourceIds.some(id=>typeof id!=='string'||!id||id.length>128)||new Set(options.sourceIds).size!==options.sourceIds.length)throw Error('Explicit owner and selected history sources required');
 const current=await readCurrent(db,owner,options.now),historyHead=await head(db,owner),executionEpoch=await epoch(db,owner),captured=await capture(db,owner),selected=new Set(options.sourceIds),records=captured.map(row=>row.record),watermark=await historyInputWatermark(records),unknowns:string[]=[];
 const sourceRefs:LoadedHistoryAnalysisInput['sourceRefs']=[];
 for(const sourceId of [...selected].sort()){const row=captured.find(row=>row.record.kind==='source'&&row.record.value.id===sourceId);if(!row||row.record.kind!=='source'||row.record.value.removedAt!==null||row.record.value.executionEpoch!==executionEpoch)throw Error('Selected owner source unavailable or execution epoch differs');sourceRefs.push({sourceId,epoch:row.record.value.epoch,scopeRevision:row.record.value.scopeRevision,rowRevision:row.revision,contentHash:row.hash,semanticDigest:await sourceSemanticDigest(row.record.value)});}
 const conversations=new Map(records.filter((record):record is HistoryRecord<'conversation'>=>record.kind==='conversation'&&selected.has(record.value.sourceId)).map(record=>[record.value.id,record.value]));
 const allConversations=new Set(records.filter((record):record is HistoryRecord<'conversation'>=>record.kind==='conversation').map(record=>record.value.id));
 for(const record of records)if(record.kind==='message'&&!allConversations.has(record.value.conversationId))throw Error('Retained message conversation identity is unavailable');
 for(const conversation of conversations.values())if(conversation.availability!=='complete')unknowns.push(`Conversation ${conversation.id} retained content is incomplete.`);
 for(const record of records){if(record.kind==='gap'&&selected.has(record.value.sourceId)&&record.value.resolvedAt===null)unknowns.push(`Gap ${record.value.id}: ${record.value.kind} remains unresolved.`);if(record.kind==='segment'&&selected.has(record.value.sourceId)&&record.value.availability!=='complete')unknowns.push(`Segment ${record.value.id} retained content is incomplete.`);}
 const grants=new Map<string,string>();
 for(const row of captured)if(row.record.kind==='association_rule'&&await db.prepare('SELECT 1 FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').bind(owner,row.record.id,row.hash).first())grants.set(row.record.id,row.hash);
 const rules=records.filter((record):record is HistoryRecord<'association_rule'>=>record.kind==='association_rule').map(record=>record.value),snapshot:ClaimInputSnapshot={ownerId:owner,sourceWatermark:watermark,messages:[],repositories:[],associations:[],contexts:[]};
 const messages:Array<ClaimInputSnapshot['messages'][number]>=[],contexts:SourceContext[]=[],associations:Array<ClaimInputSnapshot['associations'][number]>=[];let privateInputBytes=0;
 const readBytes=async(key:string,digest:string,bytes:number,sourceId:string):Promise<Uint8Array|null>=>{
  if(bytes>8*1024*1024-privateInputBytes)throw Error('Analysis private input exceeds 8 MiB bound');
  const owned=await db.prepare("SELECT 1 FROM history_object_ledger WHERE user_id=? AND source_id=? AND key=? AND sha256=? AND bytes=? AND status='ready' AND pending_token IS NULL AND purged_at IS NULL").bind(owner,sourceId,key,digest,bytes).first();if(!owned)return null;
  privateInputBytes+=bytes;
  try{const value=await options.bucket.get(key,bytes);if(!value||value.byteLength!==bytes||await contentHash(value)!==digest)return null;return value;}catch{return null;}
 };
 for(const record of records)if(record.kind==='message'){
  const message=record.value,conversation=conversations.get(message.conversationId);if(!conversation)continue;
  let text='',available=false;
  if(message.availability==='complete'){const bytes=await readBytes(message.bodyObjectKey,message.revisionDigest,message.contentBytes,conversation.sourceId);if(bytes)try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);available=true;}catch{ /* Unknown content remains unavailable. */ }}
  if(!available)unknowns.push(`Message ${message.id} immutable content is unavailable.`);
  messages.push({ownerId:owner,sourceId:conversation.sourceId,message,text,requiredContentAvailable:available});
  const context:SourceContext={sourceId:conversation.sourceId,conversationId:conversation.id,messageRevisionId:message.id,repositoryIdentity:conversation.repositoryIdentity,branch:conversation.branch,commit:null,basis:'provider_metadata'};contexts.push(context);
  const result=resolveAssociation({workspace:current.workspace,context,ownerRules:rules,trustRule:rule=>{const row=captured.find(row=>row.record.kind==='association_rule'&&row.record.value.id===rule.id);return !!row&&row.record.kind==='association_rule'&&grants.get(row.record.id)===row.hash;},verifiedRepositoryRules:options.verifiedRepositoryRules,trustVerifiedRepositoryRule:options.trustVerifiedRepositoryRule});
  if(result.projectId!==null)associations.push({messageRevisionId:message.id,projectId:result.projectId,areaId:result.areaId});else unknowns.push(...result.unknowns.map(unknown=>`Message ${message.id}: ${unknown}`));
 }
 snapshot.messages=messages;snapshot.contexts=contexts;snapshot.associations=associations;
 const repositories:ImmutableRepositoryEvidence[]=[],repoIds=new Set(contexts.flatMap(context=>context.repositoryIdentity?[context.repositoryIdentity]:[]));
 for(const record of records)if(record.kind==='repository_evidence'&&repoIds.has(record.value.repositoryIdentity)){
  if(!options.readVerifiedRepository){unknowns.push(`Repository evidence ${record.value.id} lacks independent verification.`);continue;}
  const evidence=await options.readVerifiedRepository(record.value,8*1024*1024-privateInputBytes);
  if(!evidence||evidence.ownerId!==owner||canonical(evidence.snapshot)!==canonical(record.value)||!evidence.requiredContentAvailable||evidence.stale||evidence.bytes.byteLength>8*1024*1024-privateInputBytes||await contentHash(evidence.bytes)!==record.value.contentDigest){unknowns.push(`Repository evidence ${record.value.id} is unavailable.`);continue;}privateInputBytes+=evidence.bytes.byteLength;repositories.push(evidence);
 }
 snapshot.repositories=repositories;
 const segments=records.filter((record):record is HistoryRecord<'segment'>=>record.kind==='segment'&&selected.has(record.value.sourceId)&&conversations.has(record.value.conversationId)).map(record=>record.value),checkpoints:AnalysisCheckpoint[]=[],trustedCheckpointIds:string[]=[],checkpointProofs:LoadedHistoryAnalysisInput['checkpointProofs']=[];
 for(const record of records)if(record.kind==='analysis_checkpoint'&&!record.value.id.startsWith('publication:')){
  const checkpoint=record.value;if(checkpoint.state!=='complete'||!['analysis:'+checkpoint.inputDigest,'analysis-complete:'+checkpoint.inputDigest].includes(checkpoint.id))continue;
  const digest=await contentHash(canonical(checkpoint)),journals=(await db.prepare("SELECT id,payload_json FROM review_analysis_requests WHERE user_id=? AND state='completed' AND result_id=? ORDER BY id LIMIT 101").bind(owner,digest).all<{id:string;payload_json:string|null}>()).results;if(journals.length>100)throw Error('Checkpoint journal proof exceeds bound');
  for(const journal of journals){
   if(!journal.payload_json||new TextEncoder().encode(journal.payload_json).length>256*1024)continue;
   let sourceIds:string[];try{const raw=JSON.parse(journal.payload_json);if(!Array.isArray(raw.sources)||raw.sources.length<1||raw.sources.length>100)continue;sourceIds=raw.sources.map((source:unknown)=>{if(!source||typeof source!=='object'||!('sourceId'in source)||typeof source.sourceId!=='string')throw Error('Invalid native checkpoint source');return source.sourceId;});if(sourceIds.some(source=>!selected.has(source))||new Set(sourceIds).size!==sourceIds.length)continue;}catch{continue;}
   const trusted=await readCompletedHistoryAnalysis(db,owner,{requestId:journal.id,inputDigest:checkpoint.inputDigest,checkpointDigest:digest,sourceIds});if(trusted&&trusted.sourceWatermarkHash===await contentHash(checkpoint.sourceWatermark)){checkpoints.push(checkpoint);trustedCheckpointIds.push(checkpoint.id);checkpointProofs.push({checkpointId:checkpoint.id,requestId:journal.id,inputDigest:checkpoint.inputDigest,checkpointDigest:digest,extractionDigest:trusted.chunkHash,sourceIds:sourceIds.sort()});break;}}

 }
 const after=await capture(db,owner),afterGrants=new Map<string,string>();for(const row of after)if(row.record.kind==='association_rule'&&await db.prepare('SELECT 1 FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').bind(owner,row.record.id,row.hash).first())afterGrants.set(row.record.id,row.hash);
 const rowProofs=captured.map(row=>({physicalId:row.record.id,rowRevision:row.revision,contentHash:row.hash,streamSequence:row.sequence}));
 if((await readCurrent(db,owner,options.now)).revision!==current.revision||canonical(await head(db,owner))!==canonical(historyHead)||await epoch(db,owner)!==executionEpoch||canonical(after.map(row=>({physicalId:row.record.id,rowRevision:row.revision,contentHash:row.hash,streamSequence:row.sequence})))!==canonical(rowProofs)||canonical([...afterGrants])!==canonical([...grants]))throw Error('Analysis input changed during pinned read');
 const retainedClaims=records.filter((record):record is HistoryRecord<'claim'>=>record.kind==='claim'&&selected.has(record.value.context.sourceId)&&conversations.has(record.value.context.conversationId)&&messages.some(message=>message.message.id===record.value.context.messageRevisionId&&message.message.conversationId===record.value.context.conversationId)).map(record=>record.value);
 return {retainedClaims,checkpointProofs,snapshot,segments,checkpoints,trustedCheckpointIds,planningRevision:current.revision,historyHead,historyInputWatermark:watermark,executionEpoch,sourceRefs,expectedRows:captured.map(row=>({kind:row.record.kind as HistoryRecordKind,logicalId:row.logicalId,rowRevision:row.revision,contentHash:row.hash})),rowProofs,unknowns:[...new Set(unknowns)],privateInputBytes};
}
