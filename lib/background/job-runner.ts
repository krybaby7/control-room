import {z} from 'zod';
import {readCurrent,type SqlDatabase} from '../workspace-store.ts';
import {generateSourceProposals,type SourceSuggestionBinding} from '../sources/proposals.ts';
import {sourceObservationSchema,sourceUrlSchema} from '../sources/validation.ts';
import type {SourceJobAuthority} from './job-contract.ts';
import type {SourceAdapter,SourceConnection,SourceTarget} from '../sources/contracts.ts';
import {sourceConnectionSchema,sourceTargetSchema} from '../sources/validation.ts';
import {evidenceDateSchema,evidenceIdSchema} from '../evidence-validation.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {claimIntegrationJob,isIntegrationJobClaimCurrent,sourceConfigurationHash} from './job-store.ts';
import {commitSourcePage} from '../sources/store.ts';
import {finishSourceRun} from '../sources/run-store.ts';
import {runSourceSync} from '../sources/sync.ts';
export interface IntegrationRunnerOptions {
 authority:SourceJobAuthority;now:()=>string;signal?:AbortSignal;automationPrincipal?:{ownerId:string;principalId:string};
 /** Server-owned adapter registry. Never accept an adapter/transport/credential from an HTTP body. */
 resolveAdapter?:(connection:SourceConnection,target:SourceTarget,authority:SourceJobAuthority)=>Promise<SourceAdapter|null>;
}
export type IntegrationRunnerResult=Awaited<ReturnType<typeof runSourceSync>>|{status:'blocked';reason:'unsupported'|'manual_import_required'|'unavailable'|'authority_changed'};
/** Runs exactly one existing foundation intent; no queue scans, provisioning or owner mutations. */
export async function runIntegrationJob(db:SqlDatabase,owner:string,intentId:string,options:IntegrationRunnerOptions):Promise<IntegrationRunnerResult>{
 if(!owner||owner.length>256||owner.trim()!==owner)throw new Error('An authenticated owner scope is required.');evidenceIdSchema.parse(intentId);const startedAt=evidenceDateSchema.parse(options.now());
 const row=await db.prepare('SELECT i.payload_json intent_json,t.payload_json target_json,t.content_hash target_hash,c.payload_json connection_json,c.content_hash connection_hash,j.configuration_hash FROM integration_jobs j JOIN workspace_job_intents i ON i.user_id=j.user_id AND i.id=j.intent_id JOIN source_targets t ON t.user_id=j.user_id AND t.id=j.source_id JOIN source_connections c ON c.user_id=t.user_id AND c.id=t.connection_id WHERE j.user_id=? AND j.intent_id=? AND i.kind=\'source_refresh\'').bind(owner,intentId).first<{intent_json:string;target_json:string;target_hash:string;connection_json:string;connection_hash:string;configuration_hash:string}>();
 if(!row)return {status:'blocked',reason:'unavailable'};
 let target:SourceTarget,connection:SourceConnection;
 try{const payload=z.object({sourceId:evidenceIdSchema,configurationHash:z.string().regex(/^[a-f0-9]{64}$/),manualImportHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(JSON.parse(row.intent_json));if(payload.manualImportHash!==undefined||options.authority.mode==='manual')return {status:'blocked',reason:'manual_import_required'};
  target=sourceTargetSchema.parse(JSON.parse(row.target_json));connection=sourceConnectionSchema.parse(JSON.parse(row.connection_json));if(target.id!==payload.sourceId||target.connectionId!==connection.id||payload.configurationHash!==row.configuration_hash||await contentHash(canonical(target))!==row.target_hash||await contentHash(canonical(connection))!==row.connection_hash||await sourceConfigurationHash(connection,target)!==row.configuration_hash)return {status:'blocked',reason:'authority_changed'};
 }catch{return {status:'blocked',reason:'unavailable'};}
 if(options.signal?.aborted)return {status:'blocked',reason:'unavailable'};
 const adapter=options.resolveAdapter?await options.resolveAdapter(connection,target,options.authority):null;if(!adapter)return {status:'blocked',reason:'unsupported'};
 const currentIntent=await db.prepare('SELECT payload_json FROM workspace_job_intents WHERE user_id=? AND id=?').bind(owner,intentId).first<{payload_json:string}>();if(currentIntent?.payload_json!==row.intent_json)return {status:'blocked',reason:'authority_changed'};
 const claim=await claimIntegrationJob(db,owner,intentId,{authority:options.authority,now:startedAt,...(options.automationPrincipal?{automationPrincipal:options.automationPrincipal}:{})});if(!claim||claim.sourceId!==target.id||claim.configurationHash!==row.configuration_hash)return {status:'blocked',reason:'authority_changed'};
 return runSourceSync({claim,target,startedAt},{adapter,now:options.now,signal:options.signal,isCurrent:(current,now)=>isIntegrationJobClaimCurrent(db,current,now),buildProposals:async(page,current)=>{
  const envelope=await readCurrent(db,current.ownerId,options.now()),bindings:SourceSuggestionBinding[]=[];
  for(const incoming of page.observations){
   let observation=incoming;
   const existing=(await db.prepare('SELECT id,payload_json,content_hash FROM source_observations WHERE user_id=? AND source_id=? AND external_id=? AND source_revision=? AND content_digest=? LIMIT 2').bind(current.ownerId,current.sourceId,incoming.externalId,incoming.sourceRevision,incoming.contentDigest).all<{id:string;payload_json:string;content_hash:string}>()).results;
   if(existing.length>1)throw new Error('Source observation identity is ambiguous.');
   if(existing.length){const row=existing[0],stored=sourceObservationSchema.parse(JSON.parse(row.payload_json));const semantic=(value:typeof stored)=>{const {id,observedAt,...fields}=value;void id;void observedAt;return canonical(fields);};
    if(stored.id!==row.id||stored.sourceId!==current.sourceId||await contentHash(canonical(stored))!==row.content_hash||await contentHash(canonical(stored.payload))!==stored.contentDigest||semantic(stored)!==semantic(incoming))throw new Error('Stored immutable source citation differs.');
    observation=stored;
   }
   const urls=[target.canonicalUrl,observation.canonicalUrl].filter((url):url is string=>url!==null&&sourceUrlSchema.safeParse(url).success);
   for(const task of envelope.workspace.tasks){if(task.projectId!==target.projectId||task.status==='archived'||task.sourceUrl===null||!sourceUrlSchema.safeParse(task.sourceUrl).success||!urls.includes(task.sourceUrl))continue;
    if(bindings.length>=100)throw new Error('Explicit source-task bindings exceed the page bound.');
    bindings.push({observation:structuredClone(observation),entity:{kind:'task',id:task.id},currentFields:{blocker:task.blocker,notes:task.notes}});
   }
  }
  return generateSourceProposals({ownerId:current.ownerId,baseWorkspaceRevision:envelope.revision,createdAt:options.now(),bindings});
 },commitPage:(current,input)=>commitSourcePage(db,current,input),finishRun:(current,input)=>finishSourceRun(db,current,input)});
}
