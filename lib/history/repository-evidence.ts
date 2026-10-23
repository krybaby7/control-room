import type {RepositoryEvidenceSnapshot,SourceContext} from './contracts.ts';
import {RepositoryEvidenceSnapshotSchema} from './validation.ts';
import {canonicalRepositoryIdentity} from './association.ts';
import {contentHash} from '../canonical-json.ts';
export interface ImmutableRepositoryEvidence{ownerId:string;snapshot:RepositoryEvidenceSnapshot;bytes:Uint8Array;requiredContentAvailable:boolean;stale:boolean}
export interface RepositoryProof{snapshotId:string;digest:string;stage:'implemented'|'verified'|'released'|'unknown';unknowns:string[]}
/** A root-supplied supported reader retains bytes before this pure verifier.
 * No transcript command, URL or model instruction is executed here. */
export async function verifyRepositoryEvidence(ownerId:string,context:SourceContext,reference:{snapshotId:string;digest:string},evidence:ImmutableRepositoryEvidence):Promise<RepositoryProof>{
 const snapshot=RepositoryEvidenceSnapshotSchema.parse(evidence.snapshot);
 if(evidence.ownerId!==ownerId||snapshot.id!==reference.snapshotId||snapshot.contentDigest!==reference.digest||await contentHash(evidence.bytes)!==snapshot.contentDigest)throw Error('Repository snapshot owner or immutable digest differs.');
 const result:RepositoryProof={snapshotId:snapshot.id,digest:snapshot.contentDigest,stage:'unknown',unknowns:[]};
 const url=new URL(snapshot.sourceUrl);if(url.protocol!=='https:'||url.username||url.password)throw Error('Repository evidence URL is unsafe.');
 if(snapshot.availability!=='complete'||!evidence.requiredContentAvailable||evidence.stale){result.unknowns.push('Repository evidence is missing or stale.');return result;}
 const repository=context.repositoryIdentity&&canonicalRepositoryIdentity(context.repositoryIdentity),actual=canonicalRepositoryIdentity(snapshot.repositoryIdentity);
 if(!repository||repository!==actual||!context.commit||!snapshot.candidate||context.commit!==snapshot.candidate){result.unknowns.push('Repository candidate or identity is unknown or differs from this claim.');return result;}
 if(snapshot.kind==='check'&&snapshot.conclusion==='success')result.stage='verified';
 else if(snapshot.kind==='deployment'&&snapshot.conclusion==='success'&&snapshot.environment!==null)result.stage='released';
 else if(snapshot.kind==='commit'||snapshot.kind==='pull_request'&&snapshot.conclusion==='merged')result.stage='implemented';
 else result.unknowns.push('Snapshot does not establish a successful result.');
 return result;
}
