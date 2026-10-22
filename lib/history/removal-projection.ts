import {readCurrent,type SqlDatabase} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {parseHistoryRecord,type HistoryRecord} from './record.ts';
import {historyInputWatermark} from './input-watermark.ts';
import {publishHistoryProjection,type HistoryPublicationHead} from './publication.ts';
import {adoptAreaAnalysisJob,claimAreaAnalysisJob,finishAreaAnalysisJob,prepareAreaAnalysisProgress,readAreaAnalysisJob,type AreaAnalysisJob,type AreaAnalysisAuthority,type AnalysisJobSqlGuard} from './analysis-job-store.ts';
const semanticKinds=['source','conversation','message','segment','attachment','gap','alias','repository_evidence','association_rule','source_removal'];
export type RemovalProjectionResult={status:'removal_reprojected'|'continued';publicationId?:string}|{status:'conflict'|'unavailable'};
/** A removed-source pass retires current observations through the read boundary.
 * It preserves every retained work item, story, claim and native owner decision.
 * Empty receipt checkpoints describe this deterministic pass, never extraction
 * or source coverage. No bucket or provider capability is accepted. */
export async function runHistoryRemovalProjection(db:SqlDatabase,rawJob:AreaAnalysisJob,options:{authority?:AreaAnalysisAuthority;now:string;beforeCommit?:()=>Promise<void>}):Promise<RemovalProjectionResult>{
 const owner=rawJob.ownerId,original=rawJob.original;if(!owner||!('removalId'in original)||options.authority?.ownerId!==owner)return {status:'unavailable'};
 const current=await readCurrent(db,owner,options.now),rows=(await db.prepare('SELECT id,row_revision,payload_json,content_hash FROM project_history WHERE user_id=? ORDER BY id LIMIT 10001').bind(owner).all<{id:string;row_revision:number;payload_json:string;content_hash:string}>()).results;
 if(rows.length>10000)throw Error('Removal metadata bound exceeded.');let bytes=0;const records:HistoryRecord[]=[];
 for(const row of rows){if((bytes+=new TextEncoder().encode(row.payload_json).length)>8*1024*1024)throw Error('Removal metadata byte bound exceeded.');const record=parseHistoryRecord(JSON.parse(row.payload_json));if(record.id!==row.id||await contentHash(canonical(record))!==row.content_hash)throw Error('Removal metadata digest differs.');records.push(record);}
 const source=records.find(r=>r.kind==='source'&&r.value.id===original.sourceId),tombstone=records.find(r=>r.kind==='source_removal'&&r.value.id===original.removalId);
 if(source?.kind!=='source'||!source.value.removedAt||tombstone?.kind!=='source_removal'||tombstone.value.sourceId!==original.sourceId||source.value.executionEpoch!==rawJob.executionEpoch)return {status:'unavailable'};
 const conversations=new Set(records.filter((r):r is HistoryRecord<'conversation'>=>r.kind==='conversation'&&r.value.sourceId===original.sourceId).map(r=>r.value.id)),messages=new Set(records.filter((r):r is HistoryRecord<'message'>=>r.kind==='message'&&conversations.has(r.value.conversationId)).map(r=>r.value.id)),claims=new Set(records.filter((r):r is HistoryRecord<'claim'>=>r.kind==='claim'&&r.value.context.sourceId===original.sourceId).map(r=>r.value.id));
 const targets=new Map<string,{projectId:string;areaId:string|null}>();
 for(const r of records){let target:{projectId:string;areaId:string|null}|null=null;
  if(r.kind==='claim'&&claims.has(r.value.id))target=r.value;
  if(r.kind==='work_item'&&r.value.claimIds.some(id=>claims.has(id)))target=r.value;
  if(r.kind==='story'&&[...r.value.finished,...r.value.open,...r.value.next].some(entry=>entry.citations.some(c=>messages.has(c.messageRevisionId))||'claimIds'in entry&&entry.claimIds.some(id=>claims.has(id))))target=r.value;
  if(target&&current.workspace.projects.some(p=>p.id===target!.projectId&&p.archivedAt===null)&&(target.areaId===null||current.workspace.areas?.some(a=>a.id===target!.areaId&&a.projectId===target!.projectId&&a.archivedAt===null)))targets.set(canonical([target.projectId,target.areaId]),{projectId:target.projectId,areaId:target.areaId});
 }
 const selected=[...targets.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value),watermark=await historyInputWatermark(records),wholeDigest=await contentHash(canonical({kind:'source-removal-v1',sourceHash:await contentHash(canonical(source)),tombstoneHash:await contentHash(canonical(tombstone)),watermark,targets:selected,planningRevision:current.revision})),pin={watermark,inputDigest:wholeDigest};
 const vector=rows.filter(row=>semanticKinds.includes(records.find(r=>r.id===row.id)!.kind)).map(row=>[row.id,row.row_revision,row.content_hash]);
 const kinds=semanticKinds.map(kind=>"'"+kind+"'").join(',');
 const authority:AreaAnalysisAuthority={...options.authority,async pinGuardAt(candidate,now){if(canonical(candidate)!==canonical(pin))return null;const native=await options.authority!.pinGuardAt(candidate,now);if(!native)return null;const own:AnalysisJobSqlGuard={sql:`EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?) AND COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=? AND (SELECT json_group_array(json(row_value)) FROM (SELECT json_array(id,row_revision,content_hash) row_value FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind') IN (${kinds}) ORDER BY id))=?`,bindings:[owner,current.revision,owner,rawJob.executionEpoch,owner,canonical(vector)]};return {sql:'('+native.sql+') AND ('+own.sql+')',bindings:[...native.bindings,...own.bindings]};}};
 let job=await readAreaAnalysisJob(db,owner,rawJob.intentId);if(!job||canonical(job.original)!==canonical(original)||job.executionEpoch!==rawJob.executionEpoch)return {status:'unavailable'};
 if(!job.control)job=await adoptAreaAnalysisJob(db,owner,job.intentId,{authority,pin,now:options.now});
 if(!job)return {status:'conflict'};if(job.status==='succeeded')return canonical(job.control?.pin)===canonical(pin)?{status:'removal_reprojected'}:{status:'conflict'};
 if(job.status!=='running')job=await claimAreaAnalysisJob(db,owner,job.intentId,{authority,now:options.now});if(!job?.control)return {status:'conflict'};
 if(!selected.length){await options.beforeCommit?.();const finished=await finishAreaAnalysisJob(db,job,{authority,now:options.now,outcome:'complete',cursor:null,reservedRequestIds:job.control.reservedRequestIds});return finished?{status:'removal_reprojected'}:{status:'conflict'};}
 const cursor=job.control.cursor,index=cursor===null?0:/^removal:\d+$/u.test(cursor)?Number(cursor.slice(8)):NaN;if(!Number.isSafeInteger(index)||index<0||index>=selected.length)return {status:'conflict'};
 const target=selected[index],last=index===selected.length-1,inputDigest=await contentHash(canonical([wholeDigest,target])),checkpoint={id:'analysis:'+inputDigest,inputDigest,sourceWatermark:watermark,normalizationVersion:'unicode-v1',extractorVersion:'source-removal-v1',processedMessageRevisionIds:[],processedSegmentIds:[],affectedAreaIds:[],state:'complete' as const};
 const progress=await prepareAreaAnalysisProgress(db,job,{authority,now:options.now,inputDigest,outcome:last?'complete':'continue',cursor:last?null:'removal:'+(index+1),reservedRequestIds:job.control.reservedRequestIds});if(!progress)return {status:'conflict'};
 const head=await db.prepare("SELECT revision,last_sequence FROM operational_stream_heads WHERE user_id=? AND stream_id='history'").bind(owner).first<{revision:number;last_sequence:number}>(),historyHead:HistoryPublicationHead|null=head?{revision:head.revision,lastSequence:head.last_sequence}:null;
 const result=await publishHistoryProjection(db,owner,{planningRevision:current.revision,historyHead,historyInputWatermark:watermark,target,analysisInput:{inputDigest,normalizationVersion:'unicode-v1',extractorVersion:'source-removal-v1',associationVersion:'source-removal-v1',messageRevisionIds:[],segmentIds:[],repositorySnapshotIds:[]},checkpoint,validatedClaims:[],expectedRows:[]},{now:options.now,jobProgress:progress,beforeCommit:options.beforeCommit});
 return result.status==='committed'||result.status==='replayed'?{status:last?'removal_reprojected':'continued',publicationId:result.receipt.publicationId}:{status:result.status==='unavailable'?'unavailable':'conflict'};
}
