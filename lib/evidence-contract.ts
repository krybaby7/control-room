/** Owner scope and actor authority are injected by the server, never supplied here. */
export type EvidenceBasis='observed-artifact'|'documented-result'|'owner-statement'|'connector-observation';
export type ClaimScope='implementation'|'software-verification'|'physical-acceptance'|'operation'|'release-acceptance'|'economics';
export interface EvidenceSubject {type:'project'|'milestone'|'task'|'capture';id:string}
export interface EvidenceRef {id:string;version:number}
export interface VersionedRecordHead {id:string;currentVersion:number;archivedAt:string|null}
export interface EvidenceVersion {
 id:string;version:number;basis:EvidenceBasis;scope:ClaimScope;title:string;statement:string;
 observedAt:string|null;recordedAt:string;candidate:string|null;environment:string|null;
 sourceUrl:string|null;sourceRevision:string|null;sourceRecordId:string|null;
 sourceObservationRef?:{id:string;contentDigest:string};
 attachmentIds:string[];supersedesVersion:number|null;
}
export type EvidenceInput=Omit<EvidenceVersion,'id'|'version'|'recordedAt'|'supersedesVersion'>;
export interface EvidenceLink {id:string;evidenceId:string;evidenceVersion:number;subject:EvidenceSubject;requirementId:string|null;relation:'supports'|'contradicts'|'context'}
export type EvidenceCommand=
 |{type:'evidence.create';value:EvidenceInput}
 |{type:'evidence.revise';id:string;expectedVersion:number;value:EvidenceInput}
 |{type:'evidence.archive'|'evidence.restore';id:string}
 |{type:'evidence.link';value:Omit<EvidenceLink,'id'>}
 |{type:'evidence.unlink';id:string}
 |{type:'evidence.migrate-legacy';subject:EvidenceSubject};
export interface RequirementCriteria {id:string;label:string;scope:ClaimScope;required:boolean;maxAgeDays:number|null;candidate:string|null;requireAttachment:boolean}
export interface EvidenceRequirement extends RequirementCriteria {subject:EvidenceSubject;archivedAt:string|null}
export interface AcceptanceEvidenceRef extends EvidenceRef {requirementId:string;relation:'supports'|'contradicts'|'context';historical:boolean}
export interface AcceptanceException {decisionId:string;decisionVersion:number;scope:ClaimScope;expiresAt:string;requirementIds:string[]}
export interface AcceptanceRecord {
 id:string;subject:EvidenceSubject;decision:'accepted'|'rejected'|'needs-review';statement:string;
 candidate:string|null;criteriaHash:string;evidenceRefs:AcceptanceEvidenceRef[];recordedAt:string;
 supersedesId:string|null;exceptions:AcceptanceException[];
}
export interface DecisionOption {id:string;label:string;description:string}
export interface DecisionVersion {
 id:string;version:number;title:string;question:string;options:DecisionOption[];selectedOptionId:string|null;
 rationale:string;status:'draft'|'decided'|'superseded';decidedAt:string|null;reviewOn:string|null;
 subjects:EvidenceSubject[];evidenceRefs:EvidenceRef[];sourceCaptureId:string|null;sourceUrl:string|null;
 supersedesDecisionId:string|null;supersedesVersion:number|null;recordedAt:string;
 exception:{scope:ClaimScope;expiresAt:string;requirementIds:string[]}|null;
 /** Server-captured comparison context; imported copies are contextual, never grants. */
 criteriaBasis?:{subject:EvidenceSubject;hash:string}[];
}
export type DecisionInput=Omit<DecisionVersion,'id'|'version'|'status'|'decidedAt'|'recordedAt'|'supersedesVersion'|'exception'|'criteriaBasis'>;
export interface AttachmentRecord {
 id:string;status:'reserved'|'ready'|'quarantined'|'deleted';filename:string;mimeType:string;
 expectedBytes:number;actualBytes:number|null;sha256:string|null;storageKey:string;
 createdAt:string;expiresAt:string;readyAt:string|null;uploadMutationId:string;
 quarantineReason:string|null;
}
export const EVIDENCE_LIMITS=Object.freeze({activeRecords:10_000,statementCharacters:10_000,titleCharacters:200,urlCharacters:2048,attachmentsPerVersion:50,linksPerSubject:200,optionsPerDecision:32,subjectLinksPerDecision:200});
