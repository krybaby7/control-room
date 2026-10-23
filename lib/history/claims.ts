import type {HistoryClaim,SourceContext} from './contracts.ts';
import {HistoryClaimSchema} from './validation.ts';
import {resolveCitation,type ImmutableMessageBody,type VerifiedCitation} from './citations.ts';
import {verifyRepositoryEvidence,type ImmutableRepositoryEvidence,type RepositoryProof} from './repository-evidence.ts';
import {canonical} from '../canonical-json.ts';
export interface ClaimInputSnapshot{ownerId:string;sourceWatermark:string;messages:readonly ImmutableMessageBody[];repositories:readonly ImmutableRepositoryEvidence[];associations:readonly {messageRevisionId:string;projectId:string;areaId:string|null}[];contexts:readonly SourceContext[]}
export interface ValidatedHistoryClaim{claim:HistoryClaim;ownerId:string;sourceWatermark:string;citations:VerifiedCitation[];repositoryProofs:RepositoryProof[];unknowns:string[];completionSupported:boolean;requestSupported:boolean}
const validated=new WeakMap<object,string>();
export function requireValidatedClaim(value:ValidatedHistoryClaim,ownerId:string,watermark:string):void{if(validated.get(value)!==canonical(value)||value.ownerId!==ownerId||value.sourceWatermark!==watermark)throw Error('Claim was not validated at this owner watermark.');}
export interface ClaimSupportDecision{supported:boolean;contradictions:string[];completesScope?:boolean;requestsWork?:boolean}
/** Semantic support is a separately trusted, injected verifier, never an output
 * field that model text can set. Offsets alone do not prove a proposition. */
export async function validateClaim(raw:unknown,snapshot:ClaimInputSnapshot,verifySupport:(claim:HistoryClaim,citations:readonly VerifiedCitation[],proofs:readonly RepositoryProof[])=>Promise<ClaimSupportDecision>,trustOwnerContext:(context:SourceContext)=>Promise<boolean>=async()=>false):Promise<ValidatedHistoryClaim>{
 snapshot=structuredClone(snapshot);
 const claim=HistoryClaimSchema.parse(raw);
 if(!snapshot.ownerId||!snapshot.sourceWatermark||!claim.citations.length&&!claim.supportingEvidence.length)throw Error('Claim requires retained evidence.');
 const primary=snapshot.messages.find(body=>body.message.id===claim.context.messageRevisionId);
 if(!primary||primary.ownerId!==snapshot.ownerId||primary.sourceId!==claim.context.sourceId||primary.message.conversationId!==claim.context.conversationId)throw Error('Claim context is outside immutable job input.');
 if(!snapshot.associations.some(a=>a.messageRevisionId===claim.context.messageRevisionId&&a.projectId===claim.projectId&&a.areaId===claim.areaId))throw Error('Claim project or area has no resolved input association.');
 const contexts=snapshot.contexts.filter(c=>c.messageRevisionId===claim.context.messageRevisionId);
 if(!contexts.some(c=>canonical(c)===canonical(claim.context)))throw Error('Claim context was not retained in the immutable job input.');
 if(claim.context.basis==='owner_override'&&!await trustOwnerContext(structuredClone(claim.context)))throw Error('Owner context override requires native owner authority.');
 const citations:VerifiedCitation[]=[];
 for(const citation of claim.citations){const body=snapshot.messages.find(row=>row.message.id===citation.messageRevisionId);if(!body)throw Error('Claim citation is outside immutable job input.');citations.push(await resolveCitation(snapshot.ownerId,citation,body));}
 // Conversation-derived claims always preserve an original chat citation.
 if(!citations.some(c=>c.citation.messageRevisionId===claim.context.messageRevisionId))throw Error('Claim requires its original context citation.');
 const proofs:RepositoryProof[]=[];
 for(const ref of claim.supportingEvidence){const row=snapshot.repositories.find(r=>r.snapshot.id===ref.snapshotId);if(!row)throw Error('Claim repository evidence is outside immutable job input.');proofs.push(await verifyRepositoryEvidence(snapshot.ownerId,claim.context,ref,row));}
 const decision=await verifySupport(structuredClone(claim),structuredClone(citations),structuredClone(proofs));
 if(!decision.supported||decision.contradictions.length)throw Error('Claim is unsupported or contradicted by retained evidence.');
 if(claim.kind==='verification'&&claim.basis==='observed'&&!proofs.some(p=>p.stage==='verified')&&!citations.some(c=>c.role==='tool'))throw Error('Assistant assertions cannot establish observed verification.');
 if(claim.kind==='implementation'&&claim.basis==='observed'&&!proofs.some(p=>p.stage!=='unknown')&&!citations.some(c=>c.role==='tool'))throw Error('Assistant assertions cannot establish observed implementation.');
 if(claim.kind==='release'&&claim.basis==='observed'&&!proofs.some(p=>p.stage==='released'))throw Error('Release requires exact scoped deployment evidence.');
 const contextConflict=new Set(contexts.map(c=>canonical({repositoryIdentity:c.repositoryIdentity,branch:c.branch,commit:c.commit}))).size>1;
 const unknowns=[...proofs.flatMap(p=>p.unknowns),...(contextConflict?['Provider metadata and cited repository/branch/commit context conflict.']:[])];
 const result:ValidatedHistoryClaim={claim:structuredClone(claim),ownerId:snapshot.ownerId,sourceWatermark:snapshot.sourceWatermark,citations,repositoryProofs:proofs,unknowns,completionSupported:decision.completesScope===true&&!contextConflict,requestSupported:decision.requestsWork===true};validated.set(result,canonical(result));return result;
}
