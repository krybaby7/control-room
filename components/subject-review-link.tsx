import type {EvidenceSubject} from '@/lib/evidence-contract';
import {evidenceSubjectHref} from '@/lib/evidence-subject-links';
export function SubjectReviewLink({subject,label='Review evidence and decisions'}:{subject:EvidenceSubject;label?:string}){return <a href={evidenceSubjectHref(subject)}>{label}</a>;}
