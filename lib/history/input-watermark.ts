import {sourceSemanticValue} from './source-identity.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import type {HistoryRecord} from './record.ts';
const inputKinds=new Set(['source','conversation','message','segment','attachment','gap','alias','repository_evidence','association_rule','source_removal']);
/** Projection publication and receipt-only retries are not new semantic source
 * input. Source capability is operational evidence; every other source field
 * remains semantic input. The DB history head still fences atomic reads/publication separately. */
export async function historyInputWatermark(records:readonly HistoryRecord[]):Promise<string>{
 const inputs=records.filter(record=>inputKinds.has(record.kind)).map(record=>({id:record.id,value:record.kind==='source'?{...record,value:sourceSemanticValue(record.value)}:record})).sort((a,b)=>a.id.localeCompare(b.id));
 return 'history-input:'+await contentHash(canonical(inputs));
}
