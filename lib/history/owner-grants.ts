import type {HistoryRecord} from './record.ts';
/** Shared compiler/quota predicate: only these explicit owner commands mint a
 * native proof. Imported records and operational analysis never pass it. */
export function createsHistoryOwnerGrant(type:string,record:HistoryRecord,operation:string,now:string,mutationId:string):boolean{
 return type==='roadmap.agree'&&record.kind==='roadmap_head'&&operation==='update'&&record.value.agreedAt===now
  ||type==='checkpoint.assess'&&record.kind==='checkpoint_assessment'&&operation==='insert'&&record.value.recordedAt===now
  ||type==='history.association.set'&&record.kind==='association_rule'&&['insert','update'].includes(operation)&&record.value.provenanceRef==='owner-mutation:'+mutationId;
}
