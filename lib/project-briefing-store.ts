import {validateProjectBriefing,PROJECT_BRIEFING_MARKER} from '../shared/project-briefing.mjs';
import {readEvidenceSnapshot} from './evidence-store.ts';
import {evidenceIdSchema} from './evidence-validation.ts';
import type {SqlDatabase} from './workspace-store.ts';
export interface SavedProjectBriefing {evidenceId:string;version:number;projectId:string;briefing:ReturnType<typeof validateProjectBriefing>;recordedAt:string}
/** Uploaded personal PC claims only; this read does not contact a model or verify its identity. */
export async function readProjectBriefings(db:SqlDatabase,owner:string,projectId?:string){
 if(projectId!==undefined)evidenceIdSchema.parse(projectId);
 const snapshot=await readEvidenceSnapshot(db,owner,new Date().toISOString());
 const briefings:SavedProjectBriefing[]=[];
 for(const head of snapshot.evidenceHeads){if(head.archivedAt!==null)continue;const version=snapshot.evidenceVersions.find(version=>version.id===head.id&&version.version===head.currentVersion);if(!version||version.sourceRecordId!==PROJECT_BRIEFING_MARKER)continue;const briefing=validateProjectBriefing(JSON.parse(version.statement));const links=snapshot.links.filter(link=>link.evidenceId===head.id&&link.evidenceVersion===head.currentVersion&&link.subject.type==='project'&&link.relation==='context');for(const link of links){if(projectId!==undefined&&link.subject.id!==projectId)continue;briefings.push({evidenceId:head.id,version:head.currentVersion,projectId:link.subject.id,briefing,recordedAt:version.recordedAt});}}
 return{revision:snapshot.revision,asOf:snapshot.asOf,briefings};
}
