import type {EvidenceSubject} from './evidence-contract.ts';
import {evidenceSubjectHref,parseEvidenceSubjectLink,type ParsedEvidenceSubjectLink} from './evidence-subject-links.ts';
/** Read-only filter intent, never ownership or undo authority. */
export function historySubjectHref(subject:EvidenceSubject):string {
 const params=new URLSearchParams(evidenceSubjectHref(subject).slice(2));params.set('view','history');return '/?'+params;
}
/** Root-local URL parameters only; reuse the strict subject contract unchanged. */
export function parseHistorySubjectLink(params:URLSearchParams):ParsedEvidenceSubjectLink {
 if(params.getAll('view').length!==1||params.get('view')!=='history')return {status:'unavailable'};
 const selected=new URLSearchParams(params);selected.set('view','evidence');return parseEvidenceSubjectLink(selected);
}
