import type { LocalAnalysisReport } from './local-analysis.mjs';
export interface GithubAnalysisReport extends Pick<LocalAnalysisReport,'summary'|'architecture'|'findings'|'suggestedTasks'|'limitations'> {
 format:'control-room-github-analysis';version:1;
 repository:{fullName:string;url:string;head:string};
 run:{id:string;provider:'codex';requestedModel:'gpt-6.1-sol';observedModel:'gpt-6.1-sol'|null;startedAt:string;completedAt:string;mode:'read-only';source:'codex-cloud-handoff'};
 manifest:{path:string;sha256:string;lines:number}[];
}
export const GITHUB_ANALYSIS_MARKER:'control-room-github-analysis-v1';
export const githubAnalysisSchema:Record<string,unknown>;
export function parseGithubRepository(input:string):{fullName:string;url:string};
export function validateGithubAnalysis(value:unknown):GithubAnalysisReport;
export function parseImportedGithubReport(bytes:Uint8Array):GithubAnalysisReport;
export function buildGithubCloudHandoff(input:{repository:string;requestId:string;createdAt:string}):{requestId:string;repository:{fullName:string;url:string};prompt:string};
export function canonicalGithubRepositoryUrl(input:string):string|null;
