import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import {readOperationalWatermarks} from '../operational-watermarks.ts';
import {SourceCapabilitySchema} from './validation.ts';
import type {SourceCapability} from './contracts.ts';
import type {HistoryRunnerAuthority} from './job-store.ts';
import {readHistoryRecord,type StoredHistoryRecord} from './store.ts';
import {historyRecoveryAdmission} from './admission.ts';
import {parseHistoryRecord,type HistorySourceValue} from './record.ts';
/** SERVER ONLY. The verifier performs actual supported reads and independent
 * fresh-process/renewal/revocation checks. Neither owner commands nor upload
 * capability declarations are implementations of this dependency. */
export interface HistoryCapabilityVerifier {
 verify(input:Readonly<{ownerId:string;source:HistorySourceValue;sourceRowRevision:number;sourceHash:string;configurationDigest:string;authority:Readonly<HistoryRunnerAuthority>;now:string}>):Promise<{capability:SourceCapability;expiresAt:string;freshProcessReadVerified:boolean;renewalAndRevocationVerified:boolean}|null>;
}
declare const evidenceBrand:unique symbol;
export interface PreparedHistoryCapabilityEvidence {readonly [evidenceBrand]:true;}
type Runtime={db:SqlDatabase;ownerId:string;source:StoredHistoryRecord<'source'>;authority:HistoryRunnerAuthority;capability:SourceCapability;expiresAt:string};
const prepared=new WeakMap<PreparedHistoryCapabilityEvidence,Runtime>();
function clock(value:string){return z.string().datetime({offset:true}).safeParse(value).success;}
async function guard(runtime:Runtime,now:string){
 const {authority:a,source,ownerId}=runtime,v=source.record.value;
 if(!clock(now)||!clock(a.verifiedAt)||!clock(a.expiresAt)||Date.parse(a.verifiedAt)>Date.parse(now)||Date.parse(a.expiresAt)<=Date.parse(now)||Date.parse(runtime.expiresAt)<=Date.parse(now)||runtime.capability.verifiedAt!==null&&Date.parse(runtime.capability.verifiedAt)>Date.parse(now)||!a.principalRef||a.principalRef.length>1024||a.ownerId!==ownerId||a.sourceId!==v.id||a.epoch!==v.epoch||a.scopeRevision!==v.scopeRevision||v.paused||v.removedAt!==null)return null;
 const principal=await a.guardAt(now);if(!principal?.sql)return null;
 return {sql:`EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=? AND row_revision=? AND content_hash=? AND payload_json=?) AND COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=? AND (${principal.sql})`,bindings:[ownerId,source.record.id,source.rowRevision,source.contentHash,canonical(source.record),ownerId,v.executionEpoch,...principal.bindings]};
}
/** No verifier means unavailable. Opaque evidence pins exact native source state
 * and DB identity; serializing or importing it cannot transfer verification. */
export async function prepareHistoryCapabilityEvidence(db:SqlDatabase,input:{ownerId:string;sourceId:string;now:()=>string;authority?:HistoryRunnerAuthority;verifier?:HistoryCapabilityVerifier}):Promise<PreparedHistoryCapabilityEvidence|null>{
 if(!input.authority||!input.verifier)return null;const at=input.now();if(!clock(at))return null;
 const source=await readHistoryRecord(db,input.ownerId,'source',input.sourceId);if(!source)return null;
 const initial:Runtime={db,ownerId:input.ownerId,source,authority:Object.freeze({...input.authority,guardAt:input.authority.guardAt.bind(input.authority)}),capability:source.record.value.capability,expiresAt:input.authority.expiresAt};
 const initialGuard=await guard(initial,at);if(!initialGuard||!await db.prepare('SELECT 1 WHERE '+initialGuard.sql).bind(...initialGuard.bindings).first())return null;
 const observation=await input.verifier.verify({ownerId:input.ownerId,source:structuredClone(source.record.value),sourceRowRevision:source.rowRevision,sourceHash:source.contentHash,configurationDigest:await contentHash(canonical(source.record.value.configuration)),authority:initial.authority,now:at});if(!observation)return null;
 const capability=SourceCapabilitySchema.parse(observation.capability),v=source.record.value,observedNow=input.now();if(!clock(observedNow))return null;
 if(capability.sourceId!==v.id||capability.kind!==v.configuration.kind||capability.scopeLabel!==v.capability.scopeLabel||!capability.verifiedAt||!capability.proofRef||!clock(observation.expiresAt)||Date.parse(observation.expiresAt)<=Date.parse(observedNow)||Date.parse(capability.verifiedAt)>Date.parse(observedNow)||Date.parse(capability.verifiedAt)<Date.parse(at))return null;
 if(capability.unattendedRead&&(initial.authority.renewable!==true||initial.authority.freshProcessReadVerified!==true||initial.authority.renewalAndRevocationVerified!==true||observation.freshProcessReadVerified!==true||observation.renewalAndRevocationVerified!==true))return null;
 const runtime={...initial,capability:structuredClone(capability),expiresAt:observation.expiresAt};const current=await guard(runtime,input.now());if(!current||!await db.prepare('SELECT 1 WHERE '+current.sql).bind(...current.bindings).first())return null;const after=input.now();if(!clock(after)||Date.parse(runtime.expiresAt)<=Date.parse(after)||Date.parse(runtime.authority.expiresAt)<=Date.parse(after)||Date.parse(runtime.authority.verifiedAt)>Date.parse(after)||capability.verifiedAt!==null&&Date.parse(capability.verifiedAt)>Date.parse(after))return null;
 const evidence=Object.freeze({}) as PreparedHistoryCapabilityEvidence;prepared.set(evidence,runtime);return evidence;
}
/** Publish only an independently verified server result. This never launches a
 * provider, enables a schedule, changes configuration or grants paid consent. */
export async function publishHistorySourceCapability(db:SqlDatabase,evidence:PreparedHistoryCapabilityEvidence,clockNow:()=>string):Promise<'committed'|'unchanged'|'unavailable'|'conflict'>{
 const runtime=prepared.get(evidence);if(!runtime||runtime.db!==db)throw Error('Native capability evidence required');
 const now=clockNow();const authority=await guard(runtime,now);if(!authority||!await db.prepare('SELECT 1 WHERE '+authority.sql).bind(...authority.bindings).first())return 'unavailable';
 const {ownerId:owner,source}=runtime,checkedNow=clockNow();if(!clock(checkedNow)||Date.parse(runtime.expiresAt)<=Date.parse(checkedNow)||Date.parse(runtime.authority.expiresAt)<=Date.parse(checkedNow)||Date.parse(runtime.authority.verifiedAt)>Date.parse(checkedNow)||runtime.capability.verifiedAt!==null&&Date.parse(runtime.capability.verifiedAt)>Date.parse(checkedNow))return 'unavailable';if(canonical(source.record.value.capability)===canonical(runtime.capability))return 'unchanged';
 const planning=await readCurrent(db,owner,now),watermarks=await readOperationalWatermarks(db,owner),sequence=(watermarks.history??0)+1;
 const head=await db.prepare("SELECT revision,last_sequence FROM operational_stream_heads WHERE user_id=? AND stream_id='history'").bind(owner).first<{revision:number;last_sequence:number}>();
 const record=parseHistoryRecord({...source.record,value:{...source.record.value,capability:runtime.capability}}),payload=canonical(record),hash=await contentHash(payload),mutationId='history_capability_'+crypto.randomUUID(),token=crypto.randomUUID(),gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)',gateBindings=[owner,mutationId,token];
 const assert=(sql:string,bindings:(string|number|null)[],gated=true)=>db.prepare(`INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${sql} THEN 1 ELSE 0 END${gated?' WHERE '+gate:''}`).bind(owner,mutationId,...bindings,...(gated?gateBindings:[]));
 const statements=[assert(authority.sql,authority.bindings,false),db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) VALUES(?,?,?,1)').bind(...gateBindings),assert('EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?)',[owner,planning.revision])];
 statements.push(head?assert("EXISTS(SELECT 1 FROM operational_stream_heads WHERE user_id=? AND stream_id='history' AND revision=? AND last_sequence=?)",[owner,head.revision,head.last_sequence]):assert("NOT EXISTS(SELECT 1 FROM operational_stream_heads WHERE user_id=? AND stream_id='history')",[owner]));
 statements.push(...await historyRecoveryAdmission(db)({owner,now,mutationId,planningRevision:planning.revision,watermark:sequence,rows:[{id:record.id,value:record,rowRevision:source.rowRevision+1,previous:source,streamSequence:sequence}],guard:gate,guardBindings:gateBindings}));
 statements.push(db.prepare(`UPDATE project_history SET row_revision=?,payload_json=?,content_hash=?,stream_sequence=? WHERE user_id=? AND id=? AND row_revision=? AND content_hash=? AND ${gate}`).bind(source.rowRevision+1,payload,hash,sequence,owner,record.id,source.rowRevision,source.contentHash,...gateBindings));
 statements.push(db.prepare(`INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) SELECT ?,'history',?,? WHERE ${gate} ON CONFLICT(user_id,stream_id) DO UPDATE SET revision=excluded.revision,last_sequence=excluded.last_sequence`).bind(owner,(head?.revision??0)+1,sequence,...gateBindings));
 statements.push(assert('EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND id=? AND row_revision=? AND content_hash=?)',[owner,record.id,source.rowRevision+1,hash]),db.prepare(`DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=? AND ${gate}`).bind(owner,mutationId,...gateBindings),db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...gateBindings));
 const fresh=await guard(runtime,clockNow());const finalNow=clockNow();if(!fresh||!clock(finalNow)||Date.parse(runtime.expiresAt)<=Date.parse(finalNow)||Date.parse(runtime.authority.expiresAt)<=Date.parse(finalNow)||Date.parse(runtime.authority.verifiedAt)>Date.parse(finalNow)||runtime.capability.verifiedAt!==null&&Date.parse(runtime.capability.verifiedAt)>Date.parse(finalNow))return 'unavailable';statements.unshift(assert(fresh.sql,fresh.bindings,false));
 try{await db.batch(statements);return 'committed';}catch(error){if(/assertion_valid|CHECK constraint failed|UNIQUE constraint failed: workspace_command_guards/u.test(String(error)))return 'conflict';throw error;}
}

import {scheduleHistoryOccurrence} from './scheduler.ts';
/** Release-integrator seam. Register the supported reader's server-owned verifier
 * and independent native principal resolver, then call this with an explicit due
 * occurrence. No production route supplies these bindings by default. Scheduling
 * revalidates principal/source state independently after capability publication. */
export async function verifyPublishAndScheduleHistory(db:SqlDatabase,input:Parameters<typeof prepareHistoryCapabilityEvidence>[1]&{kind:'history_import'|'history_reconcile';dueAt:string}):Promise<{publication:'committed'|'unchanged'|'unavailable'|'conflict';schedule:{status:'queued';intentId:string}|{status:'unavailable'}}>{
 const evidence=await prepareHistoryCapabilityEvidence(db,input);if(!evidence)return {publication:'unavailable',schedule:{status:'unavailable'}};
 const publication=await publishHistorySourceCapability(db,evidence,input.now);if(publication!=='committed'&&publication!=='unchanged')return {publication,schedule:{status:'unavailable'}};
 const schedule=await scheduleHistoryOccurrence(db,{ownerId:input.ownerId,sourceId:input.sourceId,kind:input.kind,dueAt:input.dueAt,now:input.now(),authority:input.authority});return {publication,schedule};
}
