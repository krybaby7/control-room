import type {OwnerScopedReader} from '../workspace-modules.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {parseHistoryRecord} from './record.ts';
/** Removal is an explicit logical tombstone. Physical bytes remain protected
 * until a separately verified private backup and retention cleanup are available. */
export async function previewHistoryRemoval(query:OwnerScopedReader,sourceId:string){
 const rows:Array<{id:string;row_revision:number;content_hash:string}>=[],records=[];let after='';
 for(;;){const page=await query.list('project_history',{after,limit:200});for(const row of page){rows.push({id:row.id,row_revision:row.row_revision,content_hash:row.content_hash});records.push(parseHistoryRecord(JSON.parse(row.payload_json)));after=row.id;}if(page.length<200)break;if(rows.length>10000)throw Error('Removal impact exceeds the bounded review limit.');}
 const conversations=new Set(records.flatMap(r=>r.kind==='conversation'&&r.value.sourceId===sourceId?[r.value.id]:[]));
 const messages=new Set(records.flatMap(r=>r.kind==='message'&&conversations.has(r.value.conversationId)?[r.value.id]:[]));
 const claims=new Set(records.flatMap(r=>r.kind==='claim'&&(r.value.context.sourceId===sourceId||r.value.citations.some(c=>messages.has(c.messageRevisionId)))?[r.value.id]:[]));
 const counts={conversations:conversations.size,messages:messages.size,claims:claims.size,stories:records.filter(r=>r.kind==='story'&&[...r.value.finished,...r.value.open,...r.value.next].some(entry=>entry.citations.some(c=>messages.has(c.messageRevisionId))||('claimIds' in entry&&entry.claimIds.some(id=>claims.has(id))))).length,assessments:records.filter(r=>r.kind==='checkpoint_assessment'&&r.value.claimIds.some(id=>claims.has(id))).length};
 const digest=await contentHash(canonical({sourceId,rows,counts}));
 return {sourceId,digest,counts,rows,retention:'physical_bytes_retained_pending_verified_backup' as const};
}
