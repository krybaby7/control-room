import {z} from 'zod';
import {canonical} from '../canonical-json.ts';
import type {CommandHandler,MutationPlan} from '../workspace-transaction.ts';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {historyRecordId} from './record.ts';
import {historyAnalysisAuthorizationSchema,prepareHistoryAnalysisAuthorization} from './analysis-journal.ts';
const digest=z.string().regex(/^[a-f0-9]{64}$/u),stamp=z.string().datetime({offset:true}),mutation=z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);
export const historyAnalysisCommandSchema=z.union([historyAnalysisAuthorizationSchema,z.object({type:z.literal('history.analysis.revoke'),scopeHash:digest,reason:z.string().trim().min(1).max(4000)}).strict()]);
export type HistoryAnalysisCommand=z.infer<typeof historyAnalysisCommandSchema>;
const source=z.object({sourceId:z.string().min(1).max(128),epoch:z.string().min(1),scopeRevision:z.number().int().positive().safe(),rowRevision:z.number().int().positive().safe(),contentHash:digest}).strict();
const common={ownerId:z.string().min(1).max(256),mutationId:mutation,now:stamp,scopeHash:digest};
const consent=z.object({policy_hash:digest,provider:z.string().min(1).max(128),model:z.string().min(1).max(200),max_cost_micros:z.number().int().positive().safe(),created_at:stamp,expires_at:stamp,revoked_at:z.null()}).strict();
const controlSchema=z.discriminatedUnion('action',[
 z.object({...common,action:z.literal('authorize'),privacyScope:z.literal('selected_history'),policyHash:digest,sources:z.array(source).min(1).max(100),executionEpoch:z.number().int().nonnegative().safe(),policyRow:z.object({id:z.literal('analysis'),row_revision:z.number().int().positive().safe(),content_hash:digest,payload_json:z.string().min(1)}).strict(),consent}).strict(),
 z.object({...common,action:z.literal('revoke'),reason:z.string().min(1).max(4000)}).strict(),
]);
export type HistoryAnalysisConsentControl=z.infer<typeof controlSchema>;
const nativeControls=new WeakMap<object,string>();
function native(control:HistoryAnalysisConsentControl):HistoryAnalysisConsentControl{
 if(control.action==='authorize'){Object.freeze(control.consent);Object.freeze(control.policyRow);for(const row of control.sources)Object.freeze(row);Object.freeze(control.sources);}Object.freeze(control);nativeControls.set(control,canonical(control));return control;
}
function requireNative(raw:unknown,owner:string,commandType:string,bindings:readonly (string|number|null)[],now:string){
 if(!raw||typeof raw!=='object'||!nativeControls.has(raw))throw Error('A native prepared history analysis consent control is required.');
 const control=controlSchema.parse(raw);if(nativeControls.get(raw)!==canonical(control)||control.ownerId!==owner||control.now!==now||bindings[0]!==owner||bindings[1]!==control.mutationId||commandType!==`history.analysis.${control.action}`)throw Error('History analysis consent owner, command or native proof differs.');return control;
}
export const historyAnalysisCommandHandler:CommandHandler={async prepare(ctx):Promise<MutationPlan>{
 const command=historyAnalysisCommandSchema.parse(ctx.command),mutationId=mutation.parse(ctx.mutationId);stamp.parse(ctx.now);let control:HistoryAnalysisConsentControl;
 if(command.type==='history.analysis.authorize'){
  const prepared=await prepareHistoryAnalysisAuthorization(ctx);
  // Historical journal identity includes semantic metadata. Live consent only
  // accepts the existing exact physical-row pins; its strict codec stays closed.
  const sources=prepared.sources.map(({sourceId,epoch,scopeRevision,rowRevision,contentHash})=>({sourceId,epoch,scopeRevision,rowRevision,contentHash}));control=native(controlSchema.parse({ownerId:ctx.userId,mutationId,now:ctx.now,scopeHash:prepared.scopeHash,action:'authorize',privacyScope:'selected_history',policyHash:prepared.policyHash,sources,executionEpoch:prepared.executionEpoch,policyRow:prepared.policyRow,consent:prepared.consent}));
  return plan(control,prepared.preconditions,ctx);
 }
 control=native(controlSchema.parse({ownerId:ctx.userId,mutationId,now:ctx.now,scopeHash:command.scopeHash,action:'revoke',reason:command.reason}));return plan(control,[],ctx);
}};
function plan(control:HistoryAnalysisConsentControl,preconditions:NonNullable<MutationPlan['preconditions']>,ctx:Parameters<CommandHandler['prepare']>[0]):MutationPlan&{historyAnalysisConsent:HistoryAnalysisConsentControl}{
 const detail=control.action==='authorize'?{action:'authorize',privacyScope:'selected_history',scopeHash:control.scopeHash,policyHash:control.policyHash,selectedSources:control.sources.map(({sourceId,epoch,scopeRevision})=>({sourceId,epoch,scopeRevision})),provider:control.consent.provider,model:control.consent.model,maxCostMicros:control.consent.max_cost_micros,expiresAt:control.consent.expires_at}:{action:'revoke',scopeHash:control.scopeHash,reason:control.reason};
 return {planningAfter:ctx.before.workspace,writes:[],jobs:[],preconditions,historyAnalysisConsent:control,events:[{id:crypto.randomUUID(),kind:ctx.command.type,entityType:'history-analysis-consent',entityId:control.scopeHash,changes:[{path:['history-analysis-consent-actions',control.mutationId],before:{exists:false,value:null},after:{exists:true,value:detail as unknown as JsonValue}}],origin:'owner',actorId:ctx.userId,occurredAt:ctx.now,sourceRef:'history-analysis-consent:'+control.scopeHash,undoOf:null}]};
}
/** ROOT compiler only. Native controls never survive JSON/import cloning. All
 * authority assertions, upsert/revoke and postcondition share its transaction. */
export async function compileHistoryAnalysisConsent(db:SqlDatabase,owner:string,raw:unknown,commandType:string,claim:string,bindings:readonly (string|number|null)[],now:string):Promise<SqlStatement[]>{
 if(raw===undefined)return [];stamp.parse(now);if(!claim||/[;\0]/u.test(claim))throw Error('A server command claim is required.');const control=requireNative(raw,owner,commandType,bindings,now),statements:SqlStatement[]=[];
 const assert=(label:string,sql:string,values:(string|number|null)[])=>{statements.push(db.prepare(`INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${sql} THEN 1 ELSE 0 END WHERE ${claim}`).bind(owner,label,...values,...bindings));statements.push(db.prepare(`DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=? AND ${claim}`).bind(owner,label,...bindings));};
 if(control.action==='revoke'){
  statements.push(db.prepare(`UPDATE review_analysis_consents SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND policy_hash=? AND ${claim}`).bind(now,owner,control.scopeHash,...bindings));
  assert('history-analysis-revoked-'+control.scopeHash,'NOT EXISTS(SELECT 1 FROM review_analysis_consents WHERE user_id=? AND policy_hash=? AND revoked_at IS NULL)',[owner,control.scopeHash]);return statements;
 }
 if(control.scopeHash!==control.consent.policy_hash||control.policyHash!==control.policyRow.content_hash||control.consent.created_at!==now||Date.parse(control.consent.expires_at)<=Date.parse(now))throw Error('History analysis consent exact scope differs.');
 const references=[];for(const selected of control.sources)references.push({id:await historyRecordId('source',selected.sourceId),revision:selected.rowRevision,hash:selected.contentHash});
 const policy="EXISTS(SELECT 1 FROM review_settings WHERE user_id=? AND id='analysis' AND setting_kind='analysis' AND row_revision=? AND content_hash=? AND payload_json=?)",sources="NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN project_history retained ON retained.user_id=? AND retained.id=json_extract(expected.value,'$.id') WHERE retained.id IS NULL OR retained.row_revision<>json_extract(expected.value,'$.revision') OR retained.content_hash<>json_extract(expected.value,'$.hash'))",epoch='COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=?';
 assert('history-analysis-authority-'+control.scopeHash,`(${policy}) AND (${sources}) AND (${epoch})`,[owner,control.policyRow.row_revision,control.policyHash,control.policyRow.payload_json,canonical(references),owner,owner,control.executionEpoch]);
 const value=control.consent;
 // Authority stays outside recoverable data. This finite owner pool includes
 // ordinary review consents; each retained row reserves 32 bytes for revocation.
 const proposed={policy_hash:value.policy_hash,provider:value.provider,model:value.model,max_cost_micros:value.max_cost_micros,created_at:value.created_at,expires_at:value.expires_at,revoked_at:null},proposedBytes=new TextEncoder().encode(canonical(proposed)).length;
 if(proposedBytes>1024)throw Error('History analysis consent authority row exceeds its finite pool.');
 const encoded="length(CAST(json_object('policy_hash',policy_hash,'provider',provider,'model',model,'max_cost_micros',max_cost_micros,'created_at',created_at,'expires_at',expires_at,'revoked_at',revoked_at) AS BLOB))",newRows='CASE WHEN EXISTS(SELECT 1 FROM review_analysis_consents WHERE user_id=? AND policy_hash=?) THEN 0 ELSE 1 END';
 assert('history-analysis-authority-capacity-'+control.scopeHash,`(SELECT COUNT(*) FROM review_analysis_consents WHERE user_id=?)+(${newRows})<=100 AND NOT EXISTS(SELECT 1 FROM review_analysis_consents WHERE user_id=? AND ${encoded}>1024) AND (SELECT COALESCE(SUM(${encoded}),0) FROM review_analysis_consents WHERE user_id=?)+?+32*((SELECT COUNT(*) FROM review_analysis_consents WHERE user_id=?)+(${newRows}))<=131072`,[owner,owner,control.scopeHash,owner,owner,proposedBytes,owner,owner,control.scopeHash]);
 statements.push(db.prepare(`INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at,revoked_at) SELECT ?,?,?,?,?,?,?,NULL WHERE ${claim} ON CONFLICT(user_id,policy_hash) DO UPDATE SET provider=excluded.provider,model=excluded.model,max_cost_micros=excluded.max_cost_micros,created_at=excluded.created_at,expires_at=excluded.expires_at,revoked_at=NULL`).bind(owner,value.policy_hash,value.provider,value.model,value.max_cost_micros,value.created_at,value.expires_at,...bindings));
 assert('history-analysis-authorized-'+control.scopeHash,'EXISTS(SELECT 1 FROM review_analysis_consents WHERE user_id=? AND policy_hash=? AND provider=? AND model=? AND max_cost_micros=? AND created_at=? AND expires_at=? AND revoked_at IS NULL)',[owner,value.policy_hash,value.provider,value.model,value.max_cost_micros,value.created_at,value.expires_at]);return statements;
}
export const historyAnalysisCommandHandlers=new Map(['history.analysis.authorize','history.analysis.revoke'].map(type=>[type,historyAnalysisCommandHandler]));
