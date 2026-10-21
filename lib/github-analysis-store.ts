import {validateGithubAnalysis} from '../shared/github-analysis.mjs';
import {readEvidenceSnapshot} from './evidence-store.ts';
import {evidenceIdSchema} from './evidence-validation.ts';
import type {SqlDatabase} from './workspace-store.ts';
const MARKER='control-room-github-analysis-v1';
/** Uploaded Codex Cloud claims only; this read does not contact a model or verify its identity. */
export async function readGithubAnalyses(db:SqlDatabase,owner:string,projectId?:string){
 if(projectId!==undefined)evidenceIdSchema.parse(projectId);
 const snapshot=await readEvidenceSnapshot(db,owner,new Date().toISOString());
 const reports:Array<{evidenceId:string;version:number;projectId:string;report:ReturnType<typeof validateGithubAnalysis>;recordedAt:string}>=[];
 for(const head of snapshot.evidenceHeads){if(head.archivedAt!==null)continue;const version=snapshot.evidenceVersions.find(version=>version.id===head.id&&version.version===head.currentVersion);if(!version||version.sourceRecordId!==MARKER)continue;const report=validateGithubAnalysis(JSON.parse(version.statement));const links=snapshot.links.filter(link=>link.evidenceId===head.id&&link.evidenceVersion===head.currentVersion&&link.subject.type==='project'&&link.relation==='context');for(const link of links){if(projectId!==undefined&&link.subject.id!==projectId)continue;reports.push({evidenceId:head.id,version:head.currentVersion,projectId:link.subject.id,report,recordedAt:version.recordedAt});}}
 return{revision:snapshot.revision,asOf:snapshot.asOf,reports};
}
