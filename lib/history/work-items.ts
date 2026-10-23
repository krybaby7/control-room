import type {HistoryWorkItem,WorkItemEvent} from './contracts.ts';
import {HistoryWorkItemSchema,WorkItemEventSchema,digest as digestSchema} from './validation.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {requireValidatedClaim,type ValidatedHistoryClaim} from './claims.ts';
import {z} from 'zod';
export interface WorkItemOperation{
 operationId:string;inputDigest:string;workItemId:string;claimIds:string[];
 kind:'create'|'link'|'observe-finished'|'cancel'|'supersede'|'reopen';
 newItem?:HistoryWorkItem;replacementId?:string;
}
export interface ReconcileInput{
 ownerId:string;sourceWatermark:string;now:string;items:readonly HistoryWorkItem[];
 events:readonly WorkItemEvent[];claims:readonly ValidatedHistoryClaim[];operations:readonly WorkItemOperation[];
 /** Explicit cited/continuation scope proof; semantic similarity alone cannot resolve items. */
 scopeMatches:(item:HistoryWorkItem,claims:readonly ValidatedHistoryClaim[],operation:WorkItemOperation)=>boolean;
}
export interface ReconcileProposal{items:HistoryWorkItem[];events:WorkItemEvent[];expectedRowRevisions:Record<string,number|null>;sourceWatermark:string;requiresAtomicPublication:true}
const operationSchema=z.object({operationId:z.string().min(1).max(1024),inputDigest:digestSchema,workItemId:z.string().min(1).max(1024),claimIds:z.array(z.string().min(1)).min(1).max(100),kind:z.enum(['create','link','observe-finished','cancel','supersede','reopen']),newItem:HistoryWorkItemSchema.optional(),replacementId:z.string().min(1).optional()}).strict().refine(op=>op.kind==='create'?op.newItem!==undefined&&op.replacementId===undefined:op.kind==='supersede'?op.replacementId!==undefined&&op.newItem===undefined:op.newItem===undefined&&op.replacementId===undefined,'Operation payload differs from kind');
/** Omission is never a resolution. This computes proposals only; the integrator
 * must compare planning/source inputs and publish rows/events/head atomically. */
export async function reconcileWorkItems(input:ReconcileInput):Promise<ReconcileProposal>{
 if(!input.ownerId||!input.sourceWatermark||!Number.isFinite(Date.parse(input.now)))throw Error('Pinned owner and watermark required.');
 const items=new Map<string,HistoryWorkItem>(),events=new Map<string,WorkItemEvent>(),claims=new Map<string,ValidatedHistoryClaim>(),expected:Record<string,number|null>={};
 for(const value of input.items){const item=HistoryWorkItemSchema.parse(value);if(items.has(item.id))throw Error('Duplicate work item identity.');items.set(item.id,item);}
 for(const value of input.events){const event=WorkItemEventSchema.parse(value);if(events.has(event.operationId))throw Error('Duplicate operation identity.');events.set(event.operationId,event);}
 for(const claim of input.claims){requireValidatedClaim(claim,input.ownerId,input.sourceWatermark);if(claims.has(claim.claim.id))throw Error('Duplicate claim identity.');claims.set(claim.claim.id,claim);}
 const added:WorkItemEvent[]=[];
 for(const raw of input.operations){
  const op=operationSchema.parse(raw);
  digestSchema.parse(op.inputDigest);if(!op.operationId||!op.workItemId||new Set(op.claimIds).size!==op.claimIds.length||!op.claimIds.length)throw Error('Operation needs exact cited identity.');
  const cited=op.claimIds.map(id=>{const claim=claims.get(id);if(!claim)throw Error('Unknown validated operation claim.');return claim;});
  const prior=events.get(op.operationId);
  const operationDigest=await contentHash(canonical(op));
  // Stored event.inputDigest pins the entire operation, including its claimed input digest.
  if(prior){if(prior.inputDigest!==operationDigest||prior.workItemId!==op.workItemId||canonical(prior.claimIds)!==canonical(op.claimIds))throw Error('Operation replay identity differs.');continue;}
  let item=items.get(op.workItemId);
  if(op.kind==='create'){
   if(item||!op.newItem||op.newItem.id!==op.workItemId)throw Error('Create requires a new stable item identity.');
   item=HistoryWorkItemSchema.parse(op.newItem);
   if(item.state!=='open'||item.taskId!==null||item.rowRevision!==1||item.supersededById!==null||canonical(item.claimIds)!==canonical(op.claimIds))throw Error('Extraction cannot create task links or accepted state.');
   if(item.disposition==='requested'&&!cited.some(c=>c.claim.kind==='intent'&&c.requestSupported&&c.citations.some(span=>span.role==='user')))throw Error('Requested work needs a cited user intent.');
  }else if(!item)throw Error('Work item does not exist.');
  if(cited.some(c=>c.claim.projectId!==item!.projectId||c.claim.areaId!==item!.areaId)||!input.scopeMatches(structuredClone(item),cited,op))throw Error('Work item scope is ambiguous or differs.');
  if(op.kind==='observe-finished'&&!cited.some(c=>c.completionSupported&&['implementation','verification','release'].includes(c.claim.kind)))throw Error('Observed finish needs scoped successful resolution evidence.');
  if(op.kind==='cancel'&&!cited.some(c=>c.claim.kind==='cancellation'))throw Error('Cancellation needs cited provenance.');
  if(op.kind==='reopen'&&!cited.some(c=>c.claim.kind==='intent'&&c.requestSupported))throw Error('Reopen needs cited intent.');
  if(op.kind==='supersede'){
   const replacement=op.replacementId?items.get(op.replacementId):null;
   if(!replacement||replacement.id===item.id||replacement.projectId!==item.projectId||replacement.areaId!==item.areaId||!cited.some(c=>c.claim.kind==='supersession'))throw Error('Supersession requires a retained same-scope replacement.');
   const seen=new Set([item.id]);let current:HistoryWorkItem|undefined=replacement;
   while(current){if(seen.has(current.id))throw Error('Supersession cycle is invalid.');seen.add(current.id);if(current.supersededById===null)break;current=items.get(current.supersededById);if(!current)throw Error('Supersession replacement chain is unavailable.');}
  }
  if(op.kind==='observe-finished'&&item.state!=='open'||op.kind==='reopen'&&item.state==='open'||['cancel','supersede'].includes(op.kind)&&item.state==='superseded')throw Error('Work item transition requires explicit current state.');
  if(!Object.hasOwn(expected,item.id))expected[item.id]=op.kind==='create'?null:item.rowRevision;
  const state=op.kind==='observe-finished'?'observed_finished':op.kind==='cancel'?'cancelled':op.kind==='supersede'?'superseded':op.kind==='reopen'?'open':item.state;
  item={...item,state,claimIds:[...new Set([...item.claimIds,...op.claimIds])],supersededById:op.kind==='supersede'?op.replacementId!:op.kind==='reopen'?null:item.supersededById,rowRevision:op.kind==='create'?1:item.rowRevision+1};
  items.set(item.id,item);
  const event:WorkItemEvent={id:'event:'+await contentHash(canonical([input.ownerId,op.operationId])),workItemId:item.id,operationId:op.operationId,inputDigest:operationDigest,claimIds:[...op.claimIds],state,recordedAt:input.now};
  events.set(op.operationId,event);added.push(event);
 }
 return {items:[...items.values()].sort((a,b)=>a.id.localeCompare(b.id)),events:added,expectedRowRevisions:expected,sourceWatermark:input.sourceWatermark,requiresAtomicPublication:true};
}
