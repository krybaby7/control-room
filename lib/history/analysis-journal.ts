import {requireValidatedClaim,type ValidatedHistoryClaim} from './claims.ts';
import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {privateInsertGrowth,privateUpdateGrowth} from '../private-growth.ts';
import {requirePrivateCapacity,PrivateCapacityError,type PrivateGrowth} from '../private-capacity.ts';
import {ownerReader,type OwnerScopedReader,type ModuleRow,type RowPrecondition} from '../workspace-modules.ts';
import type {PrepareContext} from '../workspace-transaction.ts';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import {analysisPolicySchema} from '../reviews/validation.ts';
import {historyRecordId,parseHistoryRecord} from './record.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/u),id=z.string().trim().min(1).max(128),stamp=z.string().datetime({offset:true});
const ownerSchema=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
const sourceIdsSchema=z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length,'Selected sources must be unique.');
export interface HistoryAnalysisCondition {sql:string;bindings:(string|number|null)[]}
const sourceRefSchema=z.object({sourceId:id,epoch:z.string().min(1),scopeRevision:z.number().int().positive().safe(),rowRevision:z.number().int().positive().safe(),contentHash:digest}).strict();
const usageSchema=z.object({inputTokens:z.number().int().nonnegative().safe().nullable(),outputTokens:z.number().int().nonnegative().safe().nullable(),costDollars:z.number().finite().nonnegative().nullable()}).strict();
const attestationSchema=z.object({claimHash:digest,completionSupported:z.boolean(),requestSupported:z.boolean(),unknownsDigest:digest}).strict();
export type HistoryAnalysisAttestation=z.infer<typeof attestationSchema>;
const completionSchema=z.object({attestations:z.array(attestationSchema).max(250).optional(),claimHashes:z.array(digest).max(250),checkpointDigest:digest,usage:usageSchema}).strict();
const journalSchema=z.object({format:z.literal('history-analysis-journal/v1'),privacyScope:z.literal('selected_history'),requestId:z.string().regex(/^history-analysis-v1:[a-f0-9]{64}$/u),scopeHash:digest,policyHash:digest,sources:z.array(sourceRefSchema).min(1).max(100),executionEpoch:z.number().int().nonnegative().safe(),privateSnapshotHash:digest,inputDigest:digest,sourceWatermarkHash:digest,chunkHash:digest,inputBytes:z.number().int().nonnegative().safe(),provider:z.string().min(1),model:z.string().min(1),reservedMicros:z.number().int().nonnegative().safe(),state:z.enum(['uncertain','completed']),createdAt:stamp,updatedAt:stamp,completion:completionSchema.nullable()}).strict();
export type HistoryAnalysisJournal=z.infer<typeof journalSchema>;
interface LedgerRow {id:string;intent_id:string|null;snapshot_id:string;snapshot_hash:string;policy_hash:string;provider:string;model:string;input_digest:string;state:string;reserved_micros:number;measured_cost_micros:number|null;created_at:string;updated_at:string;result_id:string|null;result_hash:string|null;payload_json:string|null}
export const historyAnalysisAuthorizationSchema=z.object({type:z.literal('history.analysis.authorize'),privacyScope:z.literal('selected_history'),sourceIds:sourceIdsSchema,policyHash:digest,scopeHash:digest,expiresAt:stamp}).strict();
export type HistoryAnalysisAuthorizationCommand=z.infer<typeof historyAnalysisAuthorizationSchema>;
function micros(dollars:number){const value=Math.ceil(dollars*1_000_000);if(!Number.isSafeInteger(value)||value<0)throw Error('Analysis cost cannot be represented safely.');return value;}
function and(clauses:readonly string[]):string {if(!clauses.length)return '1';if(clauses.length===1)return '('+clauses[0]+')';const middle=Math.floor(clauses.length/2);return '('+and(clauses.slice(0,middle))+' AND '+and(clauses.slice(middle))+')';}
async function validRow(row:ModuleRow){if(await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw Error('Analysis authority row integrity differs.');}
/** Native private authority preview only. No bodies or credentials enter this scope. */
export async function describeHistoryAnalysisScope(query:OwnerScopedReader,selected:readonly string[],executionEpoch:number){
 const sourceIds=sourceIdsSchema.parse(selected).sort();if(!Number.isSafeInteger(executionEpoch)||executionEpoch<0)throw Error('Current history execution epoch is required.');
 const policyRow=await query.get('review_settings','analysis');if(!policyRow)throw Error('An enabled analysis policy is required.');await validRow(policyRow);
 const policy=analysisPolicySchema.parse(JSON.parse(policyRow.payload_json));if(!policy.enabled||!policy.provider||!policy.model||policy.maxCostDollars===null)throw Error('An exact enabled analysis policy is required.');
 const policyHash=await contentHash(canonical(policy)),sources:z.infer<typeof sourceRefSchema>[]=[],preconditions:RowPrecondition[]=[{table:'review_settings',id:'analysis',expectedRowRevision:policyRow.row_revision,expectedHash:policyRow.content_hash}];
 for(const sourceId of sourceIds){
  const physical=await historyRecordId('source',sourceId),row=await query.get('project_history',physical);if(!row)throw Error('Selected history source is unavailable for this owner.');await validRow(row);const record=parseHistoryRecord(JSON.parse(row.payload_json));
  if(record.id!==physical||record.kind!=='source'||record.value.id!==sourceId||record.value.removedAt!==null||record.value.executionEpoch!==executionEpoch)throw Error('Selected history source identity or execution epoch differs.');
  sources.push({sourceId,epoch:record.value.epoch,scopeRevision:record.value.scopeRevision,rowRevision:row.row_revision,contentHash:row.content_hash});preconditions.push({table:'project_history',id:physical,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});
 }
 const scopeHash=await contentHash(canonical(['history-analysis-consent-v1','selected_history',policyHash,sources.map(({sourceId,epoch,scopeRevision})=>({sourceId,epoch,scopeRevision}))]));
 return {policy,policyHash,scopeHash,sources,executionEpoch,preconditions,policyRow};
}
/** Returns values for the ROOT owner-command compiler. It never writes consent. */
export async function prepareHistoryAnalysisAuthorization(ctx:PrepareContext){
 const command=historyAnalysisAuthorizationSchema.parse(ctx.command);if(!ctx.mutationId||!ctx.historyRuntime)throw Error('Native owner authorization context is required.');
 const now=stamp.parse(ctx.now);if(Date.parse(command.expiresAt)<=Date.parse(now))throw Error('History analysis consent must expire in the future.');
 const scope=await describeHistoryAnalysisScope(ctx.query,command.sourceIds,await ctx.historyRuntime.executionEpoch());if(command.policyHash!==scope.policyHash||command.scopeHash!==scope.scopeHash)throw Error('Review the current exact policy and selected history scope.');
 return {...scope,consent:{policy_hash:scope.scopeHash,provider:scope.policy.provider!,model:scope.policy.model!,max_cost_micros:micros(scope.policy.maxCostDollars!),created_at:now,expires_at:command.expiresAt,revoked_at:null},provenanceRef:'owner-mutation:'+ctx.mutationId};
}
async function currentScope(db:SqlDatabase,owner:string,sourceIds:readonly string[]){
 const epoch=(await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(owner).first<{epoch:number}>())?.epoch??0;
 return describeHistoryAnalysisScope(ownerReader(db,owner),sourceIds,epoch);
}
async function authorityFor(owner:string,scope:Awaited<ReturnType<typeof describeHistoryAnalysisScope>>,now:string){
 const references=[];for(const source of scope.sources)references.push({id:await historyRecordId('source',source.sourceId),rowRevision:source.rowRevision,contentHash:source.contentHash});
 const proof=authorityBase(owner,scope,now);
 proof.clauses.push("NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN project_history retained ON retained.user_id=? AND retained.id=json_extract(expected.value,'$.id') WHERE retained.id IS NULL OR retained.row_revision<>json_extract(expected.value,'$.rowRevision') OR retained.content_hash<>json_extract(expected.value,'$.contentHash'))");
 proof.bindings.push(canonical(references),owner);return {sql:and(proof.clauses),bindings:proof.bindings};
}

function authorityBase(owner:string,scope:Awaited<ReturnType<typeof describeHistoryAnalysisScope>>,now:string){return {clauses:["EXISTS(SELECT 1 FROM review_settings WHERE user_id=? AND id='analysis' AND setting_kind='analysis' AND row_revision=? AND content_hash=? AND payload_json=?)",'COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=?',"EXISTS(SELECT 1 FROM review_analysis_consents WHERE user_id=? AND policy_hash=? AND provider=? AND model=? AND max_cost_micros=? AND revoked_at IS NULL AND julianday(created_at)<=julianday(?) AND julianday(expires_at)>julianday(?))"],bindings:[owner,scope.policyRow.row_revision,scope.policyHash,scope.policyRow.payload_json,owner,scope.executionEpoch,owner,scope.scopeHash,scope.policy.provider!,scope.policy.model!,micros(scope.policy.maxCostDollars!),now,now] as (string|number|null)[]};}
const reservationSchema=z.object({sourceIds:sourceIdsSchema,privateSnapshotHash:digest,inputDigest:digest,sourceWatermarkHash:digest,chunkHash:digest,inputBytes:z.number().int().nonnegative().safe(),provider:z.string().min(1).max(128),model:z.string().min(1).max(200),quoteUpperBoundDollars:z.number().finite().nonnegative(),now:stamp}).strict();
export type HistoryAnalysisReservation=z.infer<typeof reservationSchema>;
export type HistoryAnalysisReservationResult={status:'admitted'|'uncertain'|'replayed';requestId:string;journal:HistoryAnalysisJournal}|{status:'budget_exhausted';reason:'not_authorized'|'budget_or_capacity';requestId:string|null};
async function ledgerRow(db:SqlDatabase,owner:string,requestId:string){return db.prepare('SELECT * FROM review_analysis_requests WHERE user_id=? AND id=?').bind(owner,requestId).first<LedgerRow>();}
async function journalFromRow(row:LedgerRow,owner:string){const journal=journalSchema.parse(JSON.parse(row.payload_json??'null'));if(journal.completion?.attestations&&canonical(journal.completion.attestations.map(item=>item.claimHash))!==canonical(journal.completion.claimHashes))throw Error('History analysis semantic attestation hashes differ.');if(row.payload_json!==canonical(journal)||new Set(journal.sources.map(source=>source.sourceId)).size!==journal.sources.length||canonical(journal.sources.map(source=>source.sourceId))!==canonical(journal.sources.map(source=>source.sourceId).sort())||journal.scopeHash!==await contentHash(canonical(['history-analysis-consent-v1','selected_history',journal.policyHash,journal.sources.map(({sourceId,epoch,scopeRevision})=>({sourceId,epoch,scopeRevision}))])))throw Error('History analysis journal canonical scope differs.');if(row.created_at!==journal.createdAt||row.updated_at!==journal.updatedAt||journal.state==='uncertain'&&(journal.completion!==null||row.measured_cost_micros!==null||row.result_id!==null||row.result_hash!==null)||journal.state==='completed'&&(journal.completion===null||row.result_id!==journal.completion.checkpointDigest||row.measured_cost_micros!==(journal.completion.usage.costDollars===null?null:micros(journal.completion.usage.costDollars))))throw Error('History analysis journal state differs.');if(journal.requestId!=='history-analysis-v1:'+await contentHash(canonical(['history-analysis-v1',owner,journal.scopeHash,journal.privateSnapshotHash,journal.inputDigest,journal.sourceWatermarkHash,journal.chunkHash,journal.provider,journal.model]))||journal.state==='completed'&&row.result_hash!==await contentHash(canonical(journal.completion)))throw Error('History analysis journal digest differs.');if(row.id!==journal.requestId||row.snapshot_id!==journal.chunkHash||row.snapshot_hash!==journal.privateSnapshotHash||row.policy_hash!==journal.scopeHash||row.provider!==journal.provider||row.model!==journal.model||row.input_digest!==journal.inputDigest||row.reserved_micros!==journal.reservedMicros||row.state!==journal.state||!Number.isSafeInteger(row.reserved_micros)||row.reserved_micros<0||row.measured_cost_micros!==null&&(!Number.isSafeInteger(row.measured_cost_micros)||row.measured_cost_micros<0||row.measured_cost_micros>row.reserved_micros))throw Error('History analysis journal identity differs.');return journal;}
const completedReadSchema=z.object({requestId:z.string().regex(/^history-analysis-v1:[a-f0-9]{64}$/u),inputDigest:digest,checkpointDigest:digest,sourceIds:sourceIdsSchema}).strict();
/** Native retained-output trust only. This does not grant new spending or consent. */
export async function readCompletedHistoryAnalysis(db:SqlDatabase,owner:string,raw:z.infer<typeof completedReadSchema>):Promise<HistoryAnalysisJournal|null>{
 ownerSchema.parse(owner);const input=completedReadSchema.parse(raw);try{
  const row=await ledgerRow(db,owner,input.requestId);if(!row||row.state!=='completed')return null;const journal=await journalFromRow(row,owner);
  if(journal.inputDigest!==input.inputDigest||journal.completion?.checkpointDigest!==input.checkpointDigest)return null;
  const epoch=(await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(owner).first<{epoch:number}>())?.epoch??0;if(epoch!==journal.executionEpoch)return null;
  const ids=[...input.sourceIds].sort();if(canonical(ids)!==canonical(journal.sources.map(source=>source.sourceId)))return null;
  const query=ownerReader(db,owner);for(const source of journal.sources){
   const physical=await historyRecordId('source',source.sourceId),retained=await query.get('project_history',physical);if(!retained)return null;await validRow(retained);const record=parseHistoryRecord(JSON.parse(retained.payload_json));
   if(record.id!==physical||record.kind!=='source'||record.value.id!==source.sourceId||record.value.removedAt!==null||record.value.executionEpoch!==epoch||record.value.epoch!==source.epoch||record.value.scopeRevision!==source.scopeRevision||retained.row_revision!==source.rowRevision||retained.content_hash!==source.contentHash)return null;
  }
  return journal;
 }catch{return null;}
}
/** Spending admission only; no provider calls and no transcript bytes. Existing
 * uncertain requests are never admitted for a second paid attempt. */
export async function reserveHistoryAnalysis(db:SqlDatabase,owner:string,raw:HistoryAnalysisReservation):Promise<HistoryAnalysisReservationResult>{
 ownerSchema.parse(owner);const input=reservationSchema.parse(raw);let scope:Awaited<ReturnType<typeof currentScope>>;
 try{scope=await currentScope(db,owner,input.sourceIds);}catch{return {status:'budget_exhausted',reason:'not_authorized',requestId:null};}
 if(input.provider!==scope.policy.provider||input.model!==scope.policy.model||input.inputBytes>scope.policy.maxInputBytes||input.quoteUpperBoundDollars>scope.policy.maxCostDollars!)return {status:'budget_exhausted',reason:'not_authorized',requestId:null};
 const requestId='history-analysis-v1:'+await contentHash(canonical(['history-analysis-v1',owner,scope.scopeHash,input.privateSnapshotHash,input.inputDigest,input.sourceWatermarkHash,input.chunkHash,input.provider,input.model]));
 const proof=await authorityFor(owner,scope,input.now);if(!await db.prepare('SELECT 1 WHERE '+proof.sql).bind(...proof.bindings).first())return {status:'budget_exhausted',reason:'not_authorized',requestId};
 async function previous(){const row=await ledgerRow(db,owner,requestId);if(!row)return null;const journal=await journalFromRow(row,owner);if(journal.inputDigest!==input.inputDigest||journal.scopeHash!==scope.scopeHash||journal.policyHash!==scope.policyHash||journal.privateSnapshotHash!==input.privateSnapshotHash||journal.chunkHash!==input.chunkHash||journal.sourceWatermarkHash!==input.sourceWatermarkHash||journal.inputBytes!==input.inputBytes||canonical(journal.sources)!==canonical(scope.sources)||journal.executionEpoch!==scope.executionEpoch)throw Error('History analysis request identity differs.');return {status:journal.state==='completed'?'replayed' as const:'uncertain' as const,requestId,journal};}
 // The extraction identity excludes global watermark/prior-work context. A
 // possibly paid call remains uncertain even when unrelated chat changes those.
 async function uncertainExtraction():Promise<HistoryAnalysisReservationResult|null>{
  const candidates=(await db.prepare("SELECT * FROM review_analysis_requests WHERE user_id=? AND policy_hash=? AND snapshot_id=? AND state='uncertain' AND id GLOB 'history-analysis-v1:*' ORDER BY created_at,id LIMIT 101").bind(owner,scope.scopeHash,input.chunkHash).all<LedgerRow>()).results;
  if(candidates.length>100)return {status:'budget_exhausted',reason:'not_authorized',requestId};
  let retained:HistoryAnalysisJournal|null=null;
  for(const row of candidates){let value:HistoryAnalysisJournal;try{value=await journalFromRow(row,owner);}catch{return {status:'budget_exhausted',reason:'not_authorized',requestId:row.id};}
   if(value.scopeHash!==scope.scopeHash||value.chunkHash!==input.chunkHash)return {status:'budget_exhausted',reason:'not_authorized',requestId:row.id};
   if(value.executionEpoch===scope.executionEpoch&&!retained)retained=value;
  }
  return retained?{status:'uncertain',requestId:retained.requestId,journal:retained}:null;
 }
 const blocked=await uncertainExtraction();if(blocked)return blocked;
 const retained=await previous();if(retained)return retained;
 const reserved=micros(input.quoteUpperBoundDollars),journal=journalSchema.parse({format:'history-analysis-journal/v1',privacyScope:'selected_history',requestId,scopeHash:scope.scopeHash,policyHash:scope.policyHash,sources:scope.sources,executionEpoch:scope.executionEpoch,privateSnapshotHash:input.privateSnapshotHash,inputDigest:input.inputDigest,sourceWatermarkHash:input.sourceWatermarkHash,chunkHash:input.chunkHash,inputBytes:input.inputBytes,provider:input.provider,model:input.model,reservedMicros:reserved,state:'uncertain',createdAt:input.now,updatedAt:input.now,completion:null}),payload=canonical(journal);
 let capacity:Awaited<ReturnType<typeof requirePrivateCapacity>>;try{capacity=await requirePrivateCapacity(db,owner,{growth:[await privateInsertGrowth(db,'review_analysis_requests',{id:requestId,intent_id:null,snapshot_id:input.chunkHash,snapshot_hash:input.privateSnapshotHash,policy_hash:scope.scopeHash,provider:input.provider,model:input.model,input_digest:input.inputDigest,state:'uncertain',reserved_micros:reserved,measured_cost_micros:null,created_at:input.now,updated_at:input.now,result_id:null,result_hash:null,payload_json:payload})]});}catch(error){if(error instanceof PrivateCapacityError)return {status:'budget_exhausted',reason:'budget_or_capacity',requestId};throw error;}
 const valid="NOT EXISTS(SELECT 1 FROM review_analysis_requests WHERE user_id=? AND (typeof(reserved_micros)<>'integer' OR reserved_micros<0 OR (measured_cost_micros IS NOT NULL AND (typeof(measured_cost_micros)<>'integer' OR measured_cost_micros<0 OR measured_cost_micros>reserved_micros))))";
 const extraction="NOT EXISTS(SELECT 1 FROM review_analysis_requests WHERE user_id=? AND policy_hash=? AND snapshot_id=? AND state='uncertain' AND id GLOB 'history-analysis-v1:*' AND CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json,'$.executionEpoch')='integer' THEN json_extract(payload_json,'$.executionEpoch')=? ELSE 1 END ELSE 1 END)";
 const budget="(SELECT COALESCE(SUM(CASE WHEN state='completed' AND measured_cost_micros IS NOT NULL THEN measured_cost_micros ELSE reserved_micros END),0) FROM review_analysis_requests WHERE user_id=?)+?<=?";
 let result;try{result=await db.prepare(`INSERT INTO review_analysis_requests(user_id,id,intent_id,snapshot_id,snapshot_hash,policy_hash,provider,model,input_digest,state,reserved_micros,measured_cost_micros,created_at,updated_at,result_id,result_hash,payload_json) SELECT ?,?,NULL,?,?,?,?,?,?,'uncertain',?,NULL,?,?,NULL,NULL,? WHERE ${and([proof.sql,capacity.sql,'NOT EXISTS(SELECT 1 FROM review_analysis_requests WHERE user_id=? AND id=?)',extraction,valid,budget])}`).bind(owner,requestId,input.chunkHash,input.privateSnapshotHash,scope.scopeHash,input.provider,input.model,input.inputDigest,reserved,input.now,input.now,payload,...proof.bindings,...capacity.bindings,owner,requestId,owner,scope.scopeHash,input.chunkHash,scope.executionEpoch,owner,owner,reserved,micros(scope.policy.maxCostDollars!)).run();}catch{return await uncertainExtraction()??{status:'uncertain',requestId,journal};}
 if(result.meta.changes===1)return {status:'admitted',requestId,journal};return await uncertainExtraction()??await previous()??{status:'budget_exhausted',reason:'budget_or_capacity',requestId};
}

export interface PreparedHistoryAnalysisCompletion {
 readonly ownerId:string;readonly requestId:string;readonly inputDigest:string;
 readonly attestations?:readonly HistoryAnalysisAttestation[];readonly claimHashes:readonly string[];readonly checkpointDigest:string;readonly completionDigest:string;
 readonly growth:readonly PrivateGrowth[];readonly condition:HistoryAnalysisCondition;readonly postcondition:HistoryAnalysisCondition;
 statement(db:SqlDatabase,guardSql:string,guardBindings:readonly (string|number|null)[]):SqlStatement;
}
const preparedCompletions=new WeakMap<object,string>();
function sealValue(port:PreparedHistoryAnalysisCompletion){return canonical({ownerId:port.ownerId,requestId:port.requestId,inputDigest:port.inputDigest,...(port.attestations?{attestations:port.attestations}:{}),claimHashes:port.claimHashes,checkpointDigest:port.checkpointDigest,completionDigest:port.completionDigest,growth:port.growth,condition:port.condition,postcondition:port.postcondition});}
/** The publication transaction accepts only this module's native prepared port,
 * never an object or arbitrary UPDATE callback returned by a model/import. */
export function requirePreparedHistoryAnalysisCompletion(port:unknown,ownerId:string,inputDigest:string):PreparedHistoryAnalysisCompletion{
 if(!port||typeof port!=='object'||!preparedCompletions.has(port))throw Error('A native prepared history analysis journal completion is required.');
 const prepared=port as PreparedHistoryAnalysisCompletion;if(prepared.ownerId!==ownerId||prepared.inputDigest!==inputDigest||preparedCompletions.get(port)!==sealValue(prepared))throw Error('History analysis completion owner or immutable seal differs.');return prepared;
}
const finalizationSchema=z.object({requestId:z.string().regex(/^history-analysis-v1:[a-f0-9]{64}$/u),inputDigest:digest,claimHashes:z.array(digest).max(250),checkpointDigest:digest,usage:usageSchema,now:stamp}).strict();
export type HistoryAnalysisFinalization=z.infer<typeof finalizationSchema>;
/** Read/prepare only. The caller MUST conjoin condition and private capacity,
 * execute statement, and assert postcondition in its publication transaction. */
export async function prepareHistoryAnalysisCompletion(db:SqlDatabase,ownerId:string,raw:HistoryAnalysisFinalization,options:{validatedClaims?:readonly ValidatedHistoryClaim[]}={}):Promise<PreparedHistoryAnalysisCompletion>{
 ownerSchema.parse(ownerId);const input=finalizationSchema.parse(raw),row=await ledgerRow(db,ownerId,input.requestId);if(!row)throw Error('History analysis must be durably reserved first.');const previous=await journalFromRow(row,ownerId);
 if(previous.inputDigest!==input.inputDigest)throw Error('History analysis completion input differs.');
 const claimHashes=[...input.claimHashes].sort();if(new Set(claimHashes).size!==claimHashes.length)throw Error('Duplicate analysis claim hash.');
 const scope=await currentScope(db,ownerId,previous.sources.map(source=>source.sourceId));
 if(scope.scopeHash!==previous.scopeHash||scope.policyHash!==previous.policyHash||scope.executionEpoch!==previous.executionEpoch||canonical(scope.sources)!==canonical(previous.sources)||scope.policy.provider!==previous.provider||scope.policy.model!==previous.model)throw Error('History analysis policy or selected source scope changed.');
 if(input.usage.outputTokens!==null&&input.usage.outputTokens>scope.policy.maxOutputTokens)throw Error('History analysis output token usage exceeds policy.');
 const measured=input.usage.costDollars===null?null:micros(input.usage.costDollars);
 if(measured!==null&&(measured>row.reserved_micros||input.usage.costDollars!>scope.policy.maxCostDollars!))throw Error('History analysis measured cost exceeds its reservation.');
 if(Date.parse(input.now)<Date.parse(previous.createdAt))throw Error('History analysis completion precedes reservation.');
 let attestations:HistoryAnalysisAttestation[]|undefined;
 if(options.validatedClaims!==undefined){
  attestations=[];for(const wrapper of options.validatedClaims){requireValidatedClaim(wrapper,ownerId,wrapper.sourceWatermark);if(await contentHash(wrapper.sourceWatermark)!==previous.sourceWatermarkHash)throw Error('Validated claim input watermark differs from reservation.');attestations.push({claimHash:await contentHash(canonical(wrapper.claim)),completionSupported:wrapper.completionSupported,requestSupported:wrapper.requestSupported,unknownsDigest:await contentHash(canonical(wrapper.unknowns))});}
  attestations.sort((a,b)=>a.claimHash.localeCompare(b.claimHash));if(canonical(attestations.map(item=>item.claimHash))!==canonical(claimHashes))throw Error('Native validated claims differ from exact completion claim hashes.');
 }
 const completion=completionSchema.parse({...(attestations?{attestations}:{}),claimHashes,checkpointDigest:input.checkpointDigest,usage:input.usage}),completionDigest=await contentHash(canonical(completion));
 if(previous.state==='completed'&&(canonical(previous.completion)!==canonical(completion)||row.result_hash!==completionDigest||row.measured_cost_micros!==measured))throw Error('A completed history analysis result is immutable.');
 const journal=journalSchema.parse({...previous,state:'completed',updatedAt:previous.state==='completed'?previous.updatedAt:input.now,completion}),payload=canonical(journal),proof=await authorityFor(ownerId,scope,input.now);
 if(!await db.prepare('SELECT 1 WHERE '+proof.sql).bind(...proof.bindings).first())throw Error('Current selected-history consent is unavailable.');
 const rowCondition='EXISTS(SELECT 1 FROM review_analysis_requests WHERE user_id=? AND id=? AND snapshot_hash=? AND policy_hash=? AND provider=? AND model=? AND input_digest=? AND state=? AND reserved_micros=? AND measured_cost_micros IS ? AND payload_json IS ? AND result_id IS ? AND result_hash IS ? AND updated_at=?)',rowBindings:(string|number|null)[]=[ownerId,input.requestId,row.snapshot_hash,row.policy_hash,row.provider,row.model,row.input_digest,row.state,row.reserved_micros,row.measured_cost_micros,row.payload_json,row.result_id,row.result_hash,row.updated_at];
 const condition={sql:and([proof.sql,rowCondition]),bindings:[...proof.bindings,...rowBindings]},postcondition={sql:"EXISTS(SELECT 1 FROM review_analysis_requests WHERE user_id=? AND id=? AND input_digest=? AND state='completed' AND reserved_micros=? AND measured_cost_micros IS ? AND result_id=? AND result_hash=? AND payload_json=?)",bindings:[ownerId,input.requestId,input.inputDigest,row.reserved_micros,measured,input.checkpointDigest,completionDigest,payload] as (string|number|null)[]};
 const growth=Object.freeze([Object.freeze(await privateUpdateGrowth(db,ownerId,'review_analysis_requests','id=?',[input.requestId],{state:'completed',measured_cost_micros:measured,updated_at:journal.updatedAt,result_id:input.checkpointDigest,result_hash:completionDigest,payload_json:payload}))]);
 const frozenCondition=Object.freeze({sql:condition.sql,bindings:Object.freeze(condition.bindings) as unknown as (string|number|null)[]}),frozenPostcondition=Object.freeze({sql:postcondition.sql,bindings:Object.freeze(postcondition.bindings) as unknown as (string|number|null)[]});
 const port:PreparedHistoryAnalysisCompletion=Object.freeze({ownerId,requestId:input.requestId,inputDigest:input.inputDigest,...(attestations?{attestations:Object.freeze(attestations.map(item=>Object.freeze(item)))}:{}),claimHashes:Object.freeze(claimHashes),checkpointDigest:input.checkpointDigest,completionDigest,growth,condition:frozenCondition,postcondition:frozenPostcondition,
  statement(database:SqlDatabase,guardSql:string,guardBindings:readonly (string|number|null)[]){
   requirePreparedHistoryAnalysisCompletion(port,ownerId,input.inputDigest);if(!guardSql||/[;\0]/u.test(guardSql))throw Error('A server publication transaction guard is required.');
   return database.prepare(`UPDATE review_analysis_requests SET state='completed',measured_cost_micros=?,updated_at=?,result_id=?,result_hash=?,payload_json=? WHERE user_id=? AND id=? AND input_digest=? AND ${condition.sql} AND (${guardSql})`).bind(measured,journal.updatedAt,input.checkpointDigest,completionDigest,payload,ownerId,input.requestId,input.inputDigest,...condition.bindings,...guardBindings);
  }});
 preparedCompletions.set(port,sealValue(port));return port;
}
