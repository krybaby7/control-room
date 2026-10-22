import type {AssociationRule,SourceContext} from './contracts.ts';
import type {Workspace} from '../types.ts';
import {AssociationRuleSchema,SourceContextSchema} from './validation.ts';

/** Native IDs are only meaningful within the enrolled source. */
export const associationTarget=(sourceId:string,nativeId:string)=>JSON.stringify([sourceId,nativeId]);
/** GitHub repository identities are case insensitive. Other hosts retain case;
 * aliases between different providers require an explicit owner rule. */
export function canonicalRepositoryIdentity(raw:string):string|null{
 try{
  const value=raw.replace(/^git@([^:]+):/u,'ssh://git@$1/');
  const url=new URL(value.includes('://')?value:'https://'+value);
  if(!['https:','ssh:'].includes(url.protocol)||url.password||url.search||url.hash||url.port||url.username&&!(url.protocol==='ssh:'&&url.username==='git'))return null;
  const path=url.pathname.replace(/^\/+|\/+$/gu,'').replace(/\.git$/u,'');
  if(!path||path.split('/').some(part=>!part||part==='.'||part==='..')||/%|\s/u.test(path))return null;
  const host=url.hostname.toLowerCase();return host+'/'+(host==='github.com'?path.toLowerCase():path);
 }catch{return null;}
}
export interface AssociationInput{
 workspace:Workspace;context:SourceContext;ownerRules:readonly AssociationRule[];
 verifiedRepositoryRules?:readonly AssociationRule[];
 /** Server-bound provenance check; imported rule payloads alone are not grants. */
 trustRule?:(rule:AssociationRule)=>boolean;
 /** Independent provider metadata proof; owner-command provenance is not this proof. */
 trustVerifiedRepositoryRule?:(rule:AssociationRule)=>boolean;
 suggestions?:readonly {projectId:string;areaId:string|null;citationRef:string}[];
}
export type AssociationResult={status:'resolved'|'unclassified';projectId:string;areaId:string|null;ruleIds:string[];unknowns:string[]}|{status:'ambiguous'|'unresolved';projectId:null;areaId:null;ruleIds:string[];unknowns:string[]};
export function resolveAssociation(input:AssociationInput):AssociationResult{
 const context=SourceContextSchema.parse(input.context),repo=context.repositoryIdentity===null?null:canonicalRepositoryIdentity(context.repositoryIdentity);
 const valid=(rule:AssociationRule)=>input.workspace.projects.some(p=>p.id===rule.projectId)&&(rule.areaId===null||input.workspace.areas?.some(a=>a.id===rule.areaId&&a.projectId===rule.projectId));
 const repositoryTargetMatches=(target:string)=>{try{const pair:unknown=JSON.parse(target);return Array.isArray(pair)&&pair.length===2&&pair[0]===context.sourceId&&typeof pair[1]==='string'&&repo!==null&&canonicalRepositoryIdentity(pair[1])===repo;}catch{return false;}};
 const matches=(rule:AssociationRule)=>rule.scope==='messages'?rule.targetIds.includes(associationTarget(context.sourceId,context.messageRevisionId)):rule.scope==='conversation'?rule.targetIds.includes(associationTarget(context.sourceId,context.conversationId)):repo!==null&&rule.targetIds.some(repositoryTargetMatches);
 const owner=input.ownerRules.map(rule=>AssociationRuleSchema.parse(rule)).filter(rule=>input.trustRule?.(rule)===true&&valid(rule)&&matches(rule));
 const verified=(input.verifiedRepositoryRules??[]).map(rule=>AssociationRuleSchema.parse(rule)).filter(rule=>rule.scope==='repository'&&input.trustVerifiedRepositoryRule?.(rule)===true&&valid(rule)&&matches(rule));
 const tiers=[owner.filter(r=>r.scope==='messages'),owner.filter(r=>r.scope==='conversation'),owner.filter(r=>r.scope==='repository'),verified];
 const selected=tiers.find(t=>t.length>0)??[];
 const destinations=new Map(selected.map(rule=>[JSON.stringify([rule.projectId,rule.areaId]),rule]));
 if(destinations.size===1){const rule=[...destinations.values()][0];return {status:rule.areaId===null?'unclassified':'resolved',projectId:rule.projectId,areaId:rule.areaId,ruleIds:selected.map(r=>r.id).sort(),unknowns:[]};}
 return {status:destinations.size>1?'ambiguous':'unresolved',projectId:null,areaId:null,ruleIds:selected.map(r=>r.id).sort(),unknowns:[destinations.size>1?'Conflicting association rules require owner review.':input.suggestions?.length?'Cited association suggestions await an owner rule.':'Source has no verified project association.']};
}
