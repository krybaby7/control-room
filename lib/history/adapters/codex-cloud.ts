import type {HistoryAdapter, SourceCapability, CollectionPage, HistorySourceKind} from '../contracts.ts';
import {CollectionPageSchema, SourceCapabilitySchema, MAX_PAGE_METADATA_BYTES} from '../validation.ts';
/** An installed integration supplies this port; no endpoint or credentials are inferred. */
export interface ReadOnlyCloudPort {
 readPage(cursor:string|null,signal:AbortSignal):Promise<unknown>;
 proof:SourceCapability;
 access:'interactive'|'renewable';
 freshProcessReadVerified:boolean;
 renewalAndRevocationVerified:boolean;
}
export function createReadOnlyCloudAdapter(kind:HistorySourceKind,sourceId:string,scopeLabel:string,port?:ReadOnlyCloudPort):HistoryAdapter {
 const baseline:SourceCapability={sourceId,kind,scopeLabel,inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'No supported account-scoped read-only integration has been verified. Empty CLI inventory is not proof of exhaustion.'};
 const capability=port?SourceCapabilitySchema.parse({...port.proof,unattendedRead:port.proof.unattendedRead&&port.access==='renewable'&&port.freshProcessReadVerified&&port.renewalAndRevocationVerified}):baseline;
 if(capability.kind!==kind||capability.sourceId!==sourceId||capability.scopeLabel!==scopeLabel)throw Error('Cloud capability scope differs');
 return {async capability(){return structuredClone(capability);},async readPage(cursor,signal):Promise<CollectionPage>{
  signal.throwIfAborted();if(!port||capability.inventory==='unsupported'||capability.contentRead==='unsupported')throw Error(capability.limitation??'Cloud history read unsupported');
  const page=CollectionPageSchema.parse(await port.readPage(cursor,signal));signal.throwIfAborted();
  if(page.sourceId!==sourceId||page.previousCursor!==cursor)throw Error('Cloud page source or cursor differs');
  if(new TextEncoder().encode(JSON.stringify(page)).length>MAX_PAGE_METADATA_BYTES)throw Error('Cloud page exceeds transport bounds');
  if(page.inventoryExhausted&&capability.inventory!=='verified')throw Error('Unverified inventory cannot certify exhaustion');
  return page;
 }};
}
export function codexCloudAdapter(sourceId:string,scopeLabel:string,port?:ReadOnlyCloudPort):HistoryAdapter{return createReadOnlyCloudAdapter('codex_cloud',sourceId,scopeLabel,port);}
