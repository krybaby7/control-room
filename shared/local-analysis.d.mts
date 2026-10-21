export interface LocalAnalysisReport {
 format:'control-room-project-analysis';version:1;
 repository:{key:string;name:string;head:string;dirty:boolean;snapshotSha256:string;files:number;bytes:number;includedChanges:true;excludedFiles:number};
 run:{id:string;provider:'codex';requestedModel:'gpt-6.1-sol';observedModel:'gpt-6.1-sol'|null;startedAt:string;completedAt:string;mode:'read-only';source:'paired-local-companion'};
 summary:string;architecture:{name:string;description:string;paths:string[]}[];
 findings:{path:string;line:number;sha256:string;claim:string}[];
 suggestedTasks:{title:string;notes:string}[];limitations:string[];
}
export type Report=LocalAnalysisReport;
export const LOCAL_ANALYSIS_MARKER:'control-room-local-analysis-v1';
export const LOCAL_ANALYSIS_MAX_CHARACTERS:9600;
export const reportContentSchema:Record<string,unknown>;
export const localAnalysisSchema:Record<string,unknown>;
export function validateLocalAnalysis(value:unknown):LocalAnalysisReport;
export function validateReportContent(value:unknown):Pick<LocalAnalysisReport,'summary'|'architecture'|'findings'|'suggestedTasks'|'limitations'>;
