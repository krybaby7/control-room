import type {SourceCapability,SourceConfiguration,InventoryMembership,ConversationRecord,MessageRevision,HistorySegment,HistoryAttachment,HistoryGap,CoverageSnapshot} from './contracts.ts';
import {CoverageSnapshotSchema} from './validation.ts';
import {inventoryMatchesScope} from './source-scope.ts';
import {contentComplete,type VerifiedSegmentMetadata} from './segments.ts';
import {historyFreshness,type FreshnessInput} from './freshness.ts';
export interface CommittedCoverageRows {
 /** Resolved under authenticated owner by storage. Never accept wire membership. */
 ownerId:string;scope:SourceConfiguration;generation:string;capability:SourceCapability;
 memberships:readonly InventoryMembership[];conversations:readonly ConversationRecord[];messages:readonly MessageRevision[];
 segments:readonly HistorySegment[];attachments:readonly HistoryAttachment[];gaps:readonly HistoryGap[];
 verifiedSegments:readonly VerifiedSegmentMetadata[];
 /** IDs for which a content traversal (including empty history) was committed. */
 contentSweptConversationIds:readonly string[];
 inventoryExhausted:boolean;lastInventorySuccessAt:string|null;lastContentSuccessAt:string|null;
 freshness:FreshnessInput;
}
export interface CoverageDetail {
 retainedOutsideGeneration:number;archived:number;archiveUnknown:number;exclusions:string[];
 historicalDenominator:null;oldestKnownAt:string|null;newestKnownAt:string|null;unknownDateConversations:number;
 segments:number;attachments:number;segmentGaps:number;attachmentGaps:number;parserErrors:number;
}
/** Only committed epoch/generation membership contributes to the discovered
 * denominator. Retained omissions remain visible separately and are never deleted. */
export function projectHistoryCoverage(input:CommittedCoverageRows):{snapshot:CoverageSnapshot;detail:CoverageDetail}{
 const {scope,capability}=input;if(!input.ownerId||capability.sourceId!==scope.sourceId||capability.kind!==scope.kind)throw Error('Coverage owner/source scope differs');
 const memberships=input.memberships.filter(row=>inventoryMatchesScope(row,scope,input.generation));
 const ids=new Set(memberships.map(row=>row.conversationId));
 const conversations=input.conversations.filter(row=>row.sourceId===scope.sourceId),byId=new Map(conversations.map(row=>[row.id,row]));
 const messages=input.messages.filter(row=>ids.has(row.conversationId)),messageIds=new Set(messages.map(row=>row.id));
 const segments=input.segments.filter(row=>row.sourceId===scope.sourceId&&ids.has(row.conversationId));
 const attachments=input.attachments.filter(row=>messageIds.has(row.messageRevisionId));
 const gaps=input.gaps.filter(row=>row.sourceId===scope.sourceId&&row.resolvedAt===null&&(row.conversationId===null||ids.has(row.conversationId)));
 const swept=new Set(input.contentSweptConversationIds);let complete=0,partial=0,unavailable=0;
 for(const id of ids){const conversation=byId.get(id),ownMessages=messages.filter(row=>row.conversationId===id),ownSegments=segments.filter(row=>row.conversationId===id),ownMessageIds=new Set(ownMessages.map(row=>row.id)),ownAttachments=attachments.filter(row=>ownMessageIds.has(row.messageRevisionId));
  if(!conversation||conversation.availability==='unavailable'){unavailable++;continue;}
  const ownGaps=gaps.some(row=>row.conversationId===id||row.conversationId===null);
  // Include referenced parent segments when checking inherited range completeness.
  const lineage=new Map(ownSegments.map(row=>[row.id,row]));let changed=true;
  while(changed){changed=false;for(const row of lineage.values()){if(row.inheritedFromSegmentId&&!lineage.has(row.inheritedFromSegmentId)){const parent=input.segments.find(candidate=>candidate.sourceId===scope.sourceId&&candidate.id===row.inheritedFromSegmentId);if(parent){lineage.set(parent.id,parent);changed=true;}}}}
  if(conversation.availability==='complete'&&swept.has(id)&&!ownGaps&&contentComplete([...lineage.values()],ownAttachments,ownMessages,input.verifiedSegments))complete++;else partial++;
 }
 const inventoryComplete=input.inventoryExhausted&&capability.inventory==='verified'&&input.lastInventorySuccessAt!==null&&!gaps.some(row=>row.kind==='inventory'||row.kind==='scope'||row.kind==='access');
 const snapshot:CoverageSnapshot={sourceId:scope.sourceId,scopeLabel:capability.scopeLabel,inventoryComplete,contentComplete:inventoryComplete&&capability.contentRead==='verified'&&input.lastContentSuccessAt!==null&&partial===0&&unavailable===0&&gaps.length===0,discovered:ids.size,complete,partial,unavailable,unresolvedGaps:gaps.length,lastInventorySuccessAt:input.lastInventorySuccessAt,lastContentSuccessAt:input.lastContentSuccessAt,status:'unverified'};
 snapshot.status=historyFreshness(snapshot,capability,input.freshness);CoverageSnapshotSchema.parse(snapshot);
 const current=[...ids].map(id=>byId.get(id)).filter((row):row is ConversationRecord=>!!row),dates=current.flatMap(row=>[row.createdAt,row.sourceUpdatedAt]).filter((date):date is string=>date!==null).sort((a,b)=>Date.parse(a)-Date.parse(b));
 return {snapshot,detail:{retainedOutsideGeneration:conversations.filter(row=>!ids.has(row.id)).length,archived:memberships.filter(row=>row.archived===true).length,archiveUnknown:memberships.filter(row=>row.archived===null).length,exclusions:[...scope.exclusions],historicalDenominator:null,oldestKnownAt:dates[0]??null,newestKnownAt:dates.at(-1)??null,unknownDateConversations:current.filter(row=>row.createdAt===null&&row.sourceUpdatedAt===null).length,segments:segments.length,attachments:attachments.length,segmentGaps:gaps.filter(row=>row.kind==='missing_segment').length,attachmentGaps:gaps.filter(row=>row.kind==='attachment').length,parserErrors:gaps.filter(row=>row.kind==='parse').length}};
}
