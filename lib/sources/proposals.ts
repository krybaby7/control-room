import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema,evidenceIdSchema} from '../evidence-validation.ts';
import type {EvidenceRef} from '../evidence-contract.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {SOURCE_LIMITS,type SourceObservation,type SourceProposal,type ProposalEntityKind,type ProposedField} from './contracts.ts';
import {sourceObservationSchema,sourceProposalSchema,sourceUrlSchema} from './validation.ts';
const allowed={task:['title','notes','blocker','priority','horizon','sourceUrl','dueDate','estimateMinutes'],milestone:['title','description','acceptance','targetDate'],project:['name','description','goal'],capture:['title','body','sourceUrl']} as const;
export function isProposalFieldAllowed(kind:string,field:string):boolean{return Object.hasOwn(allowed,kind)&&(allowed[kind as ProposalEntityKind] as readonly string[]).includes(field);}
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{return new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}catch{return false;}});
function fieldValue(field:string,value:JsonValue):void{
 if(field==='priority'){z.enum(['high','normal','low']).parse(value);return;}if(field==='horizon'){z.enum(['now','next','later']).parse(value);return;}
 if(field==='sourceUrl'){z.string().max(2048).nullable().parse(value);sourceUrlSchema.nullable().parse(value);return;}if(field==='dueDate'||field==='targetDate'){day.nullable().parse(value);return;}
 if(field==='estimateMinutes'){z.number().int().min(1).max(10080).nullable().parse(value);return;}
 z.string().max(['title','name'].includes(field)?200:['description','acceptance','goal'].includes(field)?5000:field==='blocker'?1000:10000).refine(value=>!['title','name'].includes(field)||!!value.trim()).parse(value);
}
/** Shared owner-handler guard. This is a field allowlist, not permission to execute a proposal. */
export function assertProposalFieldsAllowed(kind:ProposalEntityKind,fields:readonly ProposedField[]):void{
 if(!Array.isArray(fields)||!fields.length||fields.length>10||new Set(fields.map(row=>row.field)).size!==fields.length)throw new Error('Invalid proposed field selection.');
 for(const row of fields){if(!isProposalFieldAllowed(kind,row.field))throw new Error('This planning field cannot be proposed from a source.');fieldValue(row.field,row.before);fieldValue(row.field,row.after);}
}
const json:z.ZodType<JsonValue>=z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(json),z.record(json)]));
export async function proposalDedupKey(value:{ownerId:string;sourceId:string;sourceRevision:string;entityId:string;fields:Record<string,JsonValue>}):Promise<string>{
 const parsed=z.object({ownerId:z.string().min(1).max(256),sourceId:evidenceIdSchema,sourceRevision:z.string().min(1).max(512),entityId:evidenceIdSchema,fields:z.record(json)}).strict().parse(value);
 if(!Object.keys(parsed.fields).length||Object.keys(parsed.fields).length>10||Object.keys(parsed.fields).some(key=>!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key)))throw new Error('Invalid proposal field tuple.');
 const text=canonical(parsed);if(new TextEncoder().encode(text).length>SOURCE_LIMITS.payloadBytes)throw new Error('Proposal identity exceeds its bound.');return contentHash(text);
}
export type SourceSuggestionCause={kind:'source_changed';previousContentDigest:string}|{kind:'stale_document';asOf:string;staleAfterSeconds:number}|{kind:'blocker';code:'source_unavailable'|'dependency_unverified'};
export interface SourceSuggestionBinding {observation:SourceObservation;entity:{kind:ProposalEntityKind;id:string};currentFields:Readonly<Record<string,JsonValue>>;evidenceRefs?:EvidenceRef[];cause?:SourceSuggestionCause}
const hash=z.string().regex(/^[a-f0-9]{64}$/),sha=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const causeSchema=z.discriminatedUnion('kind',[z.object({kind:z.literal('source_changed'),previousContentDigest:hash}).strict(),z.object({kind:z.literal('stale_document'),asOf:evidenceDateSchema,staleAfterSeconds:z.number().int().min(60).max(31536000)}).strict(),z.object({kind:z.literal('blocker'),code:z.enum(['source_unavailable','dependency_unverified'])}).strict()]);
function fact(observation:SourceObservation,cause?:SourceSuggestionCause):{kind:string;message:string}|null{
 const p=observation.payload;
 if(observation.origin==='historical-import')return null;
 if(observation.origin==='provider-read'&&p.kind==='check_run'&&p.signal==='check_failure'&&p.status==='completed'&&['failure','timed_out','cancelled','action_required','startup_failure'].includes(String(p.conclusion))&&p.headMatches===true&&typeof p.headSha==='string'&&sha.test(p.headSha)&&p.headSha===p.requestedHeadSha)return {kind:'check_failure',message:`Source check failure reported for commit ${p.headSha}. Review the source before changing task status.`};
 if(observation.origin==='provider-read'&&p.kind==='pull_request'&&p.signal==='merged_pr'&&p.merged===true&&p.state==='closed'&&typeof p.headSha==='string'&&sha.test(p.headSha))return {kind:'merged_pr',message:`A source pull request was merged at commit ${p.headSha}. Review the merged change and verify remaining work.`};
 if(!cause)return null;
 if(cause.kind==='source_changed'&&cause.previousContentDigest!==observation.contentDigest)return {kind:cause.kind,message:`Source content changed from digest ${cause.previousContentDigest} to ${observation.contentDigest}. Review the affected planning context.`};
 if(cause.kind==='stale_document'&&observation.sourceUpdatedAt&&Date.parse(cause.asOf)-Date.parse(observation.sourceUpdatedAt)>=cause.staleAfterSeconds*1000)return {kind:cause.kind,message:`The selected document has not been updated since ${observation.sourceUpdatedAt}. Review whether its planning context remains current.`};
 if(cause.kind==='blocker')return {kind:cause.kind,message:cause.code==='source_unavailable'?'The selected source is unavailable. Review this planning blocker.':'A source dependency remains unverified. Review this planning blocker.'};
 return null;
}
/** Causes and entity bindings are server-selected facts, never parsed from source prose or instructions.
 * Every output is an inferred pending suggestion; owner acceptance remains a separate receipt command. */
export async function generateSourceProposals(input:{ownerId:string;baseWorkspaceRevision:number;createdAt:string;bindings:readonly SourceSuggestionBinding[]}):Promise<SourceProposal[]>{
 z.string().min(1).max(256).parse(input.ownerId);z.number().int().positive().safe().parse(input.baseWorkspaceRevision);evidenceDateSchema.parse(input.createdAt);
 if(!Array.isArray(input.bindings)||input.bindings.length>SOURCE_LIMITS.runObservations)throw new Error('Suggestion run exceeds its bound.');
 const proposals=new Map<string,SourceProposal>();
 for(const binding of input.bindings){
  const observation=sourceObservationSchema.parse(binding.observation);if(await contentHash(canonical(observation.payload))!==observation.contentDigest)throw new Error('Immutable observation content digest differs.');
  const entity=z.object({kind:z.enum(['project','milestone','task','capture']),id:evidenceIdSchema}).strict().parse(binding.entity),cause=binding.cause?causeSchema.parse(binding.cause):undefined,signal=fact(observation,cause);if(!signal)continue;
  const field=entity.kind==='task'?(signal.kind==='check_failure'||signal.kind==='blocker'?'blocker':'notes'):entity.kind==='capture'?'body':'description',before=binding.currentFields[field];if(typeof before!=='string')throw new Error('A suggestion requires the exact current owner planning field.');
  fieldValue(field,before);if(before.split('\n\n').includes(signal.message))continue;const after=before?`${before}\n\n${signal.message}`:signal.message;if(after===before||after.length>(field==='blocker'?1000:field==='description'?5000:10000))continue;const fields=[{field,before,after}];assertProposalFieldsAllowed(entity.kind,fields);
  const dedupKey=await proposalDedupKey({ownerId:input.ownerId,sourceId:observation.sourceId,sourceRevision:observation.sourceRevision,entityId:entity.id,fields:{[field]:{before,after}}});
  const evidenceRefs=z.array(z.object({id:evidenceIdSchema,version:z.number().int().positive().safe()}).strict()).max(50).parse(binding.evidenceRefs??[]),previous=proposals.get(dedupKey);
  const refs=[...(previous?.observationRefs??[]),{id:observation.id,contentDigest:observation.contentDigest}],evidence=[...(previous?.evidenceRefs??[]),...evidenceRefs];
  if(new Set(refs.map(ref=>ref.id)).size!==new Set(refs.map(ref=>canonical(ref))).size)throw new Error('Conflicting immutable observation references.');
  const unique=<T>(rows:T[]):T[]=>[...new Map(rows.map(row=>[canonical(row),row])).entries()].sort(([a],[b])=>a===b?0:a<b?-1:1).map(([,row])=>row);
  const proposal=sourceProposalSchema.parse({id:`proposal-${dedupKey}`,sourceId:observation.sourceId,observationRefs:unique(refs),evidenceRefs:unique(evidence),entity,baseWorkspaceRevision:input.baseWorkspaceRevision,fields,rationale:`Inferred ${signal.kind} planning suggestion from immutable source metadata. Owner review is required; source statements do not grant approval or completion.`,confidence:'inferred',createdAt:input.createdAt,state:'pending',dedupKey,decision:null});proposals.set(dedupKey,proposal);
 }
 return [...proposals.values()].sort((a,b)=>a.dedupKey===b.dedupKey?0:a.dedupKey<b.dedupKey?-1:1);
}
