import type {CollectionEnvelope,IngestReceipt} from '../contracts.ts';
import {canonicalEnvelopeDigest,validateCollectionEnvelope,type RetainedReferences,type VerifiedObject} from '../validation.ts';
export interface ManualImportPorts {
 /** Must validate bytes from a bounded owner-authorized upload, never an inferred path. */
 verifyObjects(envelope:CollectionEnvelope):Promise<{objects:VerifiedObject[];retained:RetainedReferences}>;
 commit(envelope:CollectionEnvelope,digest:string,provenanceRef:string):Promise<IngestReceipt>;
}
import {CollectionEnvelopeSchema,MAX_PAGE_METADATA_BYTES,IngestReceiptSchema} from '../validation.ts';
/** Manual imports do not create or upgrade automatic source capability. Replay
 * identity and immutable provenance are enforced by the existing atomic ingest. */
export async function importManualHistory(input:unknown,provenanceRef:string,ports:ManualImportPorts):Promise<IngestReceipt>{
 if(!provenanceRef.trim()||provenanceRef.length>1024)throw Error('Manual import requires bounded provenance');
 if(new TextEncoder().encode(JSON.stringify(input)).length>MAX_PAGE_METADATA_BYTES)throw Error('Manual import page exceeds transport bounds');
 const envelope=CollectionEnvelopeSchema.parse(input),verified=await ports.verifyObjects(envelope);
 validateCollectionEnvelope(envelope,verified.objects,verified.retained);
 const digest=await canonicalEnvelopeDigest(envelope),receipt=IngestReceiptSchema.parse(await ports.commit(envelope,digest,provenanceRef));
 if(receipt.pageDigest!==digest||receipt.sourceId!==envelope.page.sourceId||receipt.pageId!==envelope.page.pageId||receipt.epoch!==envelope.epoch||receipt.scopeRevision!==envelope.scopeRevision||receipt.committedCursor!==envelope.page.nextCursor)throw Error('Manual import acknowledgement differs');
 return receipt;
}
