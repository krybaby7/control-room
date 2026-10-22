import type {HistoryAdapter} from '../contracts.ts';
import {createReadOnlyCloudAdapter,type ReadOnlyCloudPort} from './codex-cloud.ts';
/** Compliance remote sessions are Cowork, not Claude Code cloud. Teleport resumes
 * and changes the checkout. Neither may be substituted for this read-only port. */
export function claudeCodeCloudAdapter(sourceId:string,scopeLabel:string,port?:ReadOnlyCloudPort):HistoryAdapter {
 const adapter=createReadOnlyCloudAdapter('claude_code_cloud',sourceId,scopeLabel,port);
 if(port)return adapter;
 return {...adapter,async capability(){return {...await adapter.capability(),contentRead:'unsupported' as const,limitation:'Claude Code cloud is excluded from the examined Compliance transcript API. Teleport is a branch/session-changing continuation, not a read-only collector. No alternative supported read-only integration is verified.'};}};
}
