import {readCurrent,type SqlDatabase} from '../workspace-store.ts';
import {resolveAssociation} from './association.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import type {LoadedHistoryAnalysisInput} from './analysis-input.ts';
import {readCompletedHistoryAnalysis} from './analysis-journal.ts';
import {validateClaim,type ValidatedHistoryClaim} from './claims.ts';
import {parseHistoryRecord} from './record.ts';
import {historyInputWatermark} from './input-watermark.ts';

/** Rehydrate native retained semantic decisions without inference. The loader is
 * a server-owned pinned input, never a deserialized request. Imported claims and
 * checkpoints alone cannot establish semantic support. Legacy native completions
 * establish support only, with both scope/request verdicts conservatively false.
 * New unrelated chats may change the global watermark: the journal still binds
 * its ORIGINAL checkpoint boundary, while every returned wrapper is revalidated
 * and sealed against the CURRENT immutable owner snapshot and native grants. */
export async function readNativeHistoryClaims(db:SqlDatabase,owner:string,input:LoadedHistoryAnalysisInput):Promise<ValidatedHistoryClaim[]>{
 if(!owner||input.snapshot.ownerId!==owner||input.snapshot.sourceWatermark!==input.historyInputWatermark)throw Error('Native claim owner or input watermark differs.');
 async function assertCurrent(){
  if((await readCurrent(db,owner)).revision!==input.planningRevision)throw Error('Native claim planning input changed.');
  const rows=(await db.prepare('SELECT id,row_revision,content_hash,payload_json,stream_sequence FROM project_history WHERE user_id=? ORDER BY id LIMIT 10001').bind(owner).all<{id:string;row_revision:number;content_hash:string;payload_json:string;stream_sequence:number}>()).results;
  if(rows.length>10000||canonical(rows.map(row=>({physicalId:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,streamSequence:row.stream_sequence})))!==canonical(input.rowProofs))throw Error('Native claim pinned rows changed.');
  const records=[];let bytes=0;for(const row of rows){if((bytes+=new TextEncoder().encode(row.payload_json).length)>8*1024*1024)throw Error('Native claim metadata bound exceeded.');const record=parseHistoryRecord(JSON.parse(row.payload_json));if(record.id!==row.id||await contentHash(canonical(record))!==row.content_hash)throw Error('Native claim row digest differs.');records.push(record);}
  if(await historyInputWatermark(records)!==input.historyInputWatermark)throw Error('Native claim source watermark changed.');return records;
 }
 const records=await assertCurrent(),workspace=(await readCurrent(db,owner)).workspace,nativeRuleIds=new Set<string>();
 for(const record of records)if(record.kind==='association_rule'&&await db.prepare('SELECT 1 FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').bind(owner,record.id,await contentHash(canonical(record))).first())nativeRuleIds.add(record.value.id);
 const result:ValidatedHistoryClaim[]=[];
 for(const claim of input.retainedClaims){
  const retained=records.find(record=>record.kind==='claim'&&record.value.id===claim.id);if(!retained||retained.kind!=='claim'||canonical(retained.value)!==canonical(claim))continue;
  const association=resolveAssociation({workspace,context:claim.context,ownerRules:records.filter(r=>r.kind==='association_rule').map(r=>r.value),trustRule:rule=>nativeRuleIds.has(rule.id)});
  if(association.projectId!==claim.projectId||association.areaId!==claim.areaId)continue;
  let available=true;for(const citation of claim.citations){const body=input.snapshot.messages.find(body=>body.message.id===citation.messageRevisionId);if(!body||!await db.prepare("SELECT 1 FROM history_object_ledger WHERE user_id=? AND source_id=? AND key=? AND sha256=? AND bytes=? AND status='ready' AND pending_token IS NULL AND purged_at IS NULL").bind(owner,body.sourceId,body.message.bodyObjectKey,body.message.revisionDigest,body.message.contentBytes).first()){available=false;break;}}if(!available)continue;
  const hash=await contentHash(canonical(claim));
  for(const proof of input.checkpointProofs){
   const checkpoint=input.checkpoints.find(value=>value.id===proof.checkpointId);if(!checkpoint||checkpoint.id.startsWith('publication:')||checkpoint.extractorVersion!==claim.extractorVersion||await contentHash(canonical(checkpoint))!==proof.checkpointDigest)continue;
   const journal=await readCompletedHistoryAnalysis(db,owner,{requestId:proof.requestId,inputDigest:proof.inputDigest,checkpointDigest:proof.checkpointDigest,sourceIds:proof.sourceIds});if(!journal||journal.sourceWatermarkHash!==await contentHash(checkpoint.sourceWatermark)||!journal.completion?.claimHashes.includes(hash))continue;
   const attestation=journal.completion.attestations?.find(value=>value.claimHash===hash);
   try{
    // Recheck owner, immutable bytes, exact context, association and repository
    // stage before restoring a native decision. No semantic default-true port.
    const support=await validateClaim(claim,input.snapshot,async()=>({supported:true,contradictions:[]}));
    if(attestation&&attestation.unknownsDigest!==await contentHash(canonical(support.unknowns)))continue;
    const validated=await validateClaim(claim,input.snapshot,async()=>({supported:true,contradictions:[],completesScope:attestation?.completionSupported===true,requestsWork:attestation?.requestSupported===true}));
    result.push(validated);break;
   }catch{ /* Unavailable, changed, foreign or overridden evidence stays unknown. */ }
  }
 }
 await assertCurrent();return result;
}
