import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
export const EVALUATION_IMPORT_LIMITS=Object.freeze({sourceBytes:262144,runs:200,nodes:10000,depth:20});
const token=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),alias=token.max(64),hash=z.string().regex(/^[a-f0-9]{64}$/);
const count=z.number().int().nonnegative().safe(),metric=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const verdict=z.enum(['pending','accepted','rejected','needs-review','passed','failed','unknown']);
export const evaluationSourceStatusSchema=z.enum(['queued','running','completed','failed','timed_out','cancelled','blocked','rate_limited','interrupted']);
const reviewSchema=z.object({verdict,minutes:metric.nullable(),corrections:count.nullable()}).strict();
const usageSchema=z.object({inputTokens:count.nullable(),outputTokens:count.nullable(),runtimeSeconds:metric.nullable()}).strict();
export const evaluationSourceObjectiveSchema=z.object({assessable:z.boolean(),passed:z.boolean().nullable(),score:metric.nullable(),checksPassed:count.max(200).nullable(),checksTotal:count.max(200).nullable()}).strict().superRefine((value,ctx)=>{if((value.checksPassed===null)!==(value.checksTotal===null)||value.checksPassed!==null&&value.checksPassed>value.checksTotal!||value.assessable&&value.passed===null||!value.assessable&&(value.passed!==null||value.score!==null||value.checksTotal!==null))ctx.addIssue({code:'custom',message:'Objective source counts or assessment differ.'});});
const sourceRunBase=z.object({runId:token,taskId:token,taskVersion:z.number().int().positive().safe(),fixtureHash:hash,provider:token.nullable(),requestedModel:token.nullable(),observedModel:token.nullable(),modelVerified:z.boolean(),runtimeVersion:token.nullable(),runtimeToolPolicy:token.nullable(),promptMode:token.nullable(),effort:z.enum(['low','medium','high','xhigh','max','ultra']).nullable(),status:evaluationSourceStatusSchema,grade:z.null(),review:reviewSchema,usage:usageSchema.nullable(),createdAt:evidenceDateSchema,finishedAt:evidenceDateSchema.nullable(),sourceStatus:z.enum(['passed','queued','running','completed','failed','timed_out','cancelled','blocked','rate_limited','interrupted']).optional(),sourceInputSha256:hash.optional(),objective:evaluationSourceObjectiveSchema.nullable().optional()}).strict();
const sourceTimes=(value:z.infer<typeof sourceRunBase>)=>value.finishedAt===null||Date.parse(value.finishedAt)>=Date.parse(value.createdAt);
const sourceIdentity=(value:z.infer<typeof sourceRunBase>)=>!value.modelVerified||value.requestedModel!==null&&value.observedModel===value.requestedModel;
const objectiveConsistent=(value:z.infer<typeof sourceRunBase>)=>{if(value.sourceStatus!==undefined&&(value.sourceStatus==='passed'?'completed':value.sourceStatus)!==value.status)return false;const objective=value.objective;if(objective?.assessable&&(!['passed','failed'].includes(value.sourceStatus??'')||value.sourceStatus==='passed'&&objective.passed!==true||value.sourceStatus==='failed'&&objective.passed!==false))return false;return true;};
const sourceRunSchema=sourceRunBase.refine(sourceTimes,'Source finish precedes source creation.').refine(sourceIdentity,'A source verification claim requires a matching observed model.').refine(objectiveConsistent,'Objective source outcome differs.');
export const evaluationRunObservationSchema=sourceRunBase.extend({id:z.string().regex(/^evaluation_[a-f0-9]{64}$/),deviceId:token,sourceInstance:alias,observedAt:evidenceDateSchema,identityKey:hash,outcomeHash:hash,cohortHash:hash,sourceFormatVersion:z.literal(1),labVersion:token,historical:z.literal(true),sourceClaimsOnly:z.literal(true)}).strict().refine(sourceTimes,'Source finish precedes source creation.').refine(sourceIdentity,'A source verification claim requires a matching observed model.').refine(objectiveConsistent,'Objective source outcome differs.');
export type EvaluationRunObservation=z.infer<typeof evaluationRunObservationSchema>;
const contextSchema=z.object({ownerId:z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/u.test(v)),deviceId:token,sourceInstance:alias,observedAt:evidenceDateSchema,sourceFormatVersion:z.literal(1)}).strict();
export type EvaluationImportContext=z.infer<typeof contextSchema>;
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('Invalid Agent Lab summary object.');return value as Record<string,unknown>;}
function boundedSource(raw:unknown):Record<string,unknown>{
 let value=raw;
 if(typeof raw==='string'){if(new TextEncoder().encode(raw).byteLength>EVALUATION_IMPORT_LIMITS.sourceBytes)throw new Error('Evaluation summary exceeds byte bound.');value=JSON.parse(raw);}
 else if(raw instanceof Uint8Array){if(raw.byteLength>EVALUATION_IMPORT_LIMITS.sourceBytes)throw new Error('Evaluation summary exceeds byte bound.');value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}
 let nodes=0,bytes=0;
 const visit=(item:unknown,depth:number):void=>{
  if(++nodes>EVALUATION_IMPORT_LIMITS.nodes||depth>EVALUATION_IMPORT_LIMITS.depth)throw new Error('Evaluation summary exceeds structural bound.');
  if(typeof item==='string')bytes+=new TextEncoder().encode(item).byteLength;
  else if(typeof item==='number'){if(!Number.isFinite(item))throw new Error('Invalid source metric.');bytes+=24;}
  else if(item===null||typeof item==='boolean')bytes+=5;
  else if(Array.isArray(item)){for(const child of item)visit(child,depth+1);}
  else{const row=object(item);for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(row))){if(!Object.hasOwn(descriptor,'value')||['__proto__','constructor','prototype'].includes(key))throw new Error('Unsafe source JSON.');bytes+=new TextEncoder().encode(key).byteLength;visit(descriptor.value,depth+1);}}
  if(bytes>EVALUATION_IMPORT_LIMITS.sourceBytes)throw new Error('Evaluation summary exceeds byte bound.');
 };
 visit(value,0);return object(value);
}
function nullable<T>(schema:z.ZodType<T>,value:unknown):T|null{const result=schema.safeParse(value);return result.success?result.data:null;}
/** Owner/device scope is server-injected; source contents never supply identity. */
export async function evaluationDedupKey(input:{ownerId:string;deviceId:string;sourceInstance:string;runId:string}):Promise<string>{
 const context=contextSchema.omit({observedAt:true,sourceFormatVersion:true}).extend({runId:token}).strict().parse(input);
 return contentHash(canonical(['agent-lab',context.ownerId,context.deviceId,context.sourceInstance,context.runId]));
}
/** Only field-by-field source claims are retained. Legacy grade remains null;
 * optional objective summaries are bounded source claims, never independently
 * verified grades. Source-input digests are local claims, not server byte proof.
 * Neither completed nor modelVerified grants readiness, provider access, savings,
 * project acceptance, or permission to run a model.
 */
export async function normalizeEvaluationSummary(raw:unknown,input:EvaluationImportContext):Promise<EvaluationRunObservation[]>{
 const context=contextSchema.parse(input),source=boundedSource(raw),labVersion=token.parse(source.version);
 if(!Array.isArray(source.runs)||source.runs.length>EVALUATION_IMPORT_LIMITS.runs)throw new Error('Evaluation run bound exceeded.');
 const seen=new Set<string>(),result:EvaluationRunObservation[]=[];
 for(const value of source.runs){
  const row=object(value),runId=token.parse(row.id);if(seen.has(runId))throw new Error('Duplicate source run identity.');seen.add(runId);
  const review=row.review&&typeof row.review==='object'&&!Array.isArray(row.review)?object(row.review):{},usage=row.usage&&typeof row.usage==='object'&&!Array.isArray(row.usage)?object(row.usage):null;
  const run=sourceRunSchema.parse({runId,taskId:row.taskId,taskVersion:row.taskVersion,fixtureHash:row.fixtureHash,provider:nullable(token,row.provider),requestedModel:nullable(token,row.requestedModel),observedModel:nullable(token,row.observedModel),modelVerified:row.modelVerified===true,runtimeVersion:nullable(token,row.runtimeVersion),runtimeToolPolicy:nullable(token,row.runtimeToolPolicy),promptMode:nullable(token,row.promptMode),effort:nullable(sourceRunBase.shape.effort,row.effort),status:row.status,grade:null,review:{verdict:nullable(verdict,review.verdict)??'unknown',minutes:nullable(metric,review.minutes),corrections:nullable(count,review.corrections)},usage:usage===null?null:{inputTokens:nullable(count,usage.inputTokens),outputTokens:nullable(count,usage.outputTokens),runtimeSeconds:nullable(metric,usage.runtimeSeconds)},createdAt:row.createdAt,finishedAt:row.finishedAt??null,...(Object.hasOwn(row,'sourceStatus')?{sourceStatus:row.sourceStatus}:{}),...(Object.hasOwn(row,'sourceInputSha256')?{sourceInputSha256:row.sourceInputSha256}:{}),...(Object.hasOwn(row,'objective')?{objective:row.objective}:{})});
  const identityKey=await evaluationDedupKey({ownerId:context.ownerId,deviceId:context.deviceId,sourceInstance:context.sourceInstance,runId});
  const outcomeHash=await contentHash(canonical({sourceFormatVersion:context.sourceFormatVersion,labVersion,run}));
  const cohortHash=await contentHash(canonical({sourceFormatVersion:1,labVersion,taskId:run.taskId,taskVersion:run.taskVersion,fixtureHash:run.fixtureHash,provider:run.provider,requestedModel:run.requestedModel,observedModel:run.observedModel,modelVerified:run.modelVerified,runtimeVersion:run.runtimeVersion,runtimeToolPolicy:run.runtimeToolPolicy,promptMode:run.promptMode,effort:run.effort}));
  const id='evaluation_'+await contentHash(canonical([identityKey,outcomeHash]));
  result.push(evaluationRunObservationSchema.parse({...run,id,deviceId:context.deviceId,sourceInstance:context.sourceInstance,observedAt:context.observedAt,identityKey,outcomeHash,cohortHash,sourceFormatVersion:1,labVersion,historical:true,sourceClaimsOnly:true}));
 }
 return result.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}
/** Existing immutable bodies win exact repeats; corrected outcomes append with a
 * distinct deterministic ID. This is a pure proposal, not an owner-bound DB CAS.
 */
export function selectNewEvaluationObservations(candidates:readonly EvaluationRunObservation[],existing:readonly EvaluationRunObservation[]):EvaluationRunObservation[]{
 if(candidates.length>EVALUATION_IMPORT_LIMITS.runs||existing.length>10000)throw new Error('Evaluation history bound exceeded.');
 const index=new Map<string,EvaluationRunObservation>();for(const row of existing){const value=evaluationRunObservationSchema.parse(row);if(index.has(value.id))throw new Error('Duplicate evaluation history identity.');index.set(value.id,value);}
 const output:EvaluationRunObservation[]=[],seen=new Set<string>();
 for(const candidate of candidates){const value=evaluationRunObservationSchema.parse(candidate);if(seen.has(value.id))throw new Error('Duplicate evaluation proposal.');seen.add(value.id);const prior=index.get(value.id);if(prior){const {observedAt:priorAt,...priorBody}=prior,{observedAt:nextAt,...nextBody}=value;void priorAt;void nextAt;if(canonical(priorBody)!==canonical(nextBody))throw new Error('Immutable evaluation history differs.');continue;}output.push(structuredClone(value));}
 return output;
}

/** Portable integrity validation, not attestation of the original lab/provider.
 * identityKey is opaque historical provenance on import; it never grants owner
 * or device authority in a destination workspace.
 */
export async function validateEvaluationObservation(raw:unknown):Promise<EvaluationRunObservation>{
 const value=evaluationRunObservationSchema.parse(raw),run=sourceRunSchema.parse(Object.fromEntries(Object.keys(sourceRunBase.shape).filter(key=>Object.hasOwn(value,key)).map(key=>[key,Reflect.get(value,key)])));
 const outcomeHash=await contentHash(canonical({sourceFormatVersion:value.sourceFormatVersion,labVersion:value.labVersion,run}));
 const cohortHash=await contentHash(canonical({sourceFormatVersion:1,labVersion:value.labVersion,taskId:run.taskId,taskVersion:run.taskVersion,fixtureHash:run.fixtureHash,provider:run.provider,requestedModel:run.requestedModel,observedModel:run.observedModel,modelVerified:run.modelVerified,runtimeVersion:run.runtimeVersion,runtimeToolPolicy:run.runtimeToolPolicy,promptMode:run.promptMode,effort:run.effort}));
 if(outcomeHash!==value.outcomeHash||cohortHash!==value.cohortHash||value.id!=='evaluation_'+await contentHash(canonical([value.identityKey,value.outcomeHash])))throw new Error('Evaluation observation integrity differs.');
 return value;
}
