import type {CollectionEnvelope,CollectionPage,InventoryMembership,IngestReceipt} from './contracts.ts';
import {canonicalEnvelopeDigest,validateCollectionEnvelope,type VerifiedObject,type RetainedReferences,IngestReceiptSchema,CollectionEnvelopeSchema,MAX_PAGE_METADATA_BYTES} from './validation.ts';
export type CollectionPhase='inventory'|'content'|'complete';
/** Private bounded operational continuation; not a new transport codec. A storage
 * implementation must persist this alongside existing sync-run/job state. */
export interface CollectionContinuation {
 ownerId:string;sourceId:string;epoch:string;scopeRevision:number;generation:string;runId:string;revision:number;
 phase:CollectionPhase;inventoryCursor:string|null;contentCursor:string|null;segmentCursor:string|null;
 failedItems:readonly {id:string;cursor:string|null;attempts:number;retryAt:string}[];
 pending:CollectionEnvelope|null;lastAttemptAt:string|null;lastInventorySuccessAt:string|null;lastContentSuccessAt:string|null;
}
export interface CollectionPorts {
 load():Promise<CollectionContinuation>;
 read(state:CollectionContinuation,signal:AbortSignal):Promise<CollectionPage>;
 /** CAS persists exact bytes before submission. A retry uses this pending page. */
 savePending(expected:CollectionContinuation,envelope:CollectionEnvelope):Promise<void>;
 /** Pure reader progress derived from the pending page, replayed identically after crash. */
 contentProgress?(state:CollectionContinuation,page:CollectionPage):Pick<CollectionContinuation,'segmentCursor'|'failedItems'>;
 verify(envelope:CollectionEnvelope):Promise<{objects:VerifiedObject[];retained:RetainedReferences}>;
 /** Atomic existing page-CAS receipt + membership + next continuation. Must check
  * replay before old-cursor rejection and authenticate owner/scope/epoch again. */
 commitPageAtomic(expected:CollectionContinuation,envelope:CollectionEnvelope,digest:string,memberships:InventoryMembership[],next:CollectionContinuation):Promise<IngestReceipt>;
}
function identity(state:CollectionContinuation){return JSON.stringify([state.ownerId,state.sourceId,state.epoch,state.scopeRevision,state.generation]);}
export async function collectionContentRunId(generation:string):Promise<string>{return 'content:'+await canonicalEnvelopeDigest({generation});}
async function assertPhaseRun(state:CollectionContinuation){const expected=state.phase==='inventory'?state.generation:await collectionContentRunId(state.generation);if(state.runId!==expected)throw Error('Collection phase run identity differs');}
/** Each invocation uses at most the configured page/time budget, loading durable
 * state after every acknowledgement. A lost acknowledgement is safe to retry. */
export async function collectHistoryPages(ports:CollectionPorts,options:{signal:AbortSignal;now:()=>string;maxPages?:number;maxMs?:number}):Promise<{pages:number;continuation:CollectionContinuation}>{
 const maxPages=options.maxPages??5,maxMs=options.maxMs??20_000;if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100||!Number.isFinite(maxMs)||maxMs<=0||maxMs>20_000)throw Error('Invalid collection budget');
 const start=Date.parse(options.now());if(!Number.isFinite(start))throw Error('Invalid collection clock');let state=await ports.load();await assertPhaseRun(state);const initial=identity(state);let pages=0;
 while(pages<maxPages&&Date.parse(options.now())-start<maxMs){options.signal.throwIfAborted();if(identity(state)!==initial)throw Error('Collection scope changed');await assertPhaseRun(state);if(state.phase==='complete')break;
  if(state.failedItems.length>250)throw Error('Failed item continuation exceeds bound');
  if(!state.pending&&state.phase==='content'&&state.contentCursor===null&&state.segmentCursor===null&&state.failedItems.length>0&&state.failedItems.every(item=>Date.parse(item.retryAt)>Date.parse(options.now())))break;
  const phaseBefore=state.phase,runBefore=state.runId;const cursor=state.phase==='inventory'?state.inventoryCursor:state.contentCursor;
  let envelope=state.pending;
  if(!envelope){const page=await ports.read(structuredClone(state),options.signal);envelope={protocolVersion:1,epoch:state.epoch,scopeRevision:state.scopeRevision,page};CollectionEnvelopeSchema.parse(envelope);if(new TextEncoder().encode(JSON.stringify(envelope)).length>MAX_PAGE_METADATA_BYTES)throw Error('Collection page exceeds transport bounds');await ports.savePending(state,envelope);state=await ports.load();if(identity(state)!==initial)throw Error('Collection scope changed');if(state.phase!==phaseBefore||state.runId!==runBefore)throw Error('Collection phase changed outside commit');if(!state.pending||await canonicalEnvelopeDigest(state.pending)!==await canonicalEnvelopeDigest(envelope))throw Error('Pending collection CAS differs');envelope=state.pending;}
  const page=envelope.page;if(envelope.epoch!==state.epoch||envelope.scopeRevision!==state.scopeRevision||page.sourceId!==state.sourceId||page.runId!==state.runId||page.previousCursor!==cursor)throw Error('Collection page scope or cursor differs');
  if(page.nextCursor===cursor&&page.nextCursor!==null)throw Error('Collection cursor did not advance');
  if(state.phase==='inventory'&&page.nextCursor===null&&!page.inventoryExhausted)throw Error('Inventory has no continuation or exhaustion proof');
  const verified=await ports.verify(envelope);if(verified.retained.authenticatedOwnerId!==state.ownerId)throw Error('Collection owner differs');validateCollectionEnvelope(envelope,verified.objects,verified.retained);
  const at=options.now(),next:CollectionContinuation={...state,revision:state.revision+1,pending:null,lastAttemptAt:at};
  if(state.phase==='inventory'){next.inventoryCursor=page.nextCursor;if(page.inventoryExhausted){if(page.nextCursor!==null)throw Error('Exhausted inventory still has cursor');next.phase='content';next.runId=await collectionContentRunId(state.generation);next.contentCursor=null;next.segmentCursor=null;next.lastInventorySuccessAt=at;}}
  else {const progress=ports.contentProgress?.(structuredClone(state),page);if(progress){if(progress.failedItems.length>250||progress.failedItems.some(item=>!item.id||!Number.isSafeInteger(item.attempts)||item.attempts<1||!Number.isFinite(Date.parse(item.retryAt))))throw Error('Invalid failed item continuation');next.segmentCursor=progress.segmentCursor;next.failedItems=progress.failedItems;}next.contentCursor=page.nextCursor;if(page.nextCursor===null&&next.segmentCursor===null&&next.failedItems.length===0){next.phase='complete';next.lastContentSuccessAt=at;}}
  const memberships=state.phase==='inventory'?page.conversations.map(row=>({codecVersion:1 as const,sourceId:state.sourceId,epoch:state.epoch,scopeRevision:state.scopeRevision,generation:state.generation,conversationId:row.id,archived:row.archived,observedAt:at})):[];
  const digest=await canonicalEnvelopeDigest(envelope),receipt=IngestReceiptSchema.parse(await ports.commitPageAtomic(state,envelope,digest,memberships,next));
  if(receipt.sourceId!==state.sourceId||receipt.epoch!==state.epoch||receipt.scopeRevision!==state.scopeRevision||receipt.pageId!==page.pageId||receipt.pageDigest!==digest||receipt.committedCursor!==page.nextCursor)throw Error('Collection acknowledgement differs');
  pages++;state=await ports.load();if(identity(state)!==initial)throw Error('Collection scope changed');if(state.runId!==next.runId||state.phase!==next.phase)throw Error('Collection phase transition differs');await assertPhaseRun(state);
 }
 if(identity(state)!==initial)throw Error('Collection scope changed');return {pages,continuation:state};
}
