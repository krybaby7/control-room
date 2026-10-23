/** Operational event identity is independent of display polling and planning.
 * The event must be appended in the same transaction as a changed source watermark. */
export interface SourceWatermarkChange {ownerId:string;sourceId:string;epoch:string;scopeRevision:number;previousWatermark:string|null;watermark:string;committedAt:string;}
export function sourceWatermarkChange(input:SourceWatermarkChange):SourceWatermarkChange|null {
 if(!input.ownerId||!input.sourceId||!input.epoch||!Number.isSafeInteger(input.scopeRevision)||input.scopeRevision<1||!input.watermark||!Number.isFinite(Date.parse(input.committedAt)))throw Error('Invalid committed source watermark');
 return input.previousWatermark===input.watermark?null:structuredClone(input);
}
export interface ChangeConsumerPort {
 /** Reads only committed outbox entries after the analysis consumer checkpoint. */
 pending(limit:number):Promise<SourceWatermarkChange[]>;
 /** Existing analysis job dedup + checkpoint/outbox acknowledgement atomically.
  * Returns false for an already consumed event, never mutates planning/editor data. */
 enqueueAndAcknowledge(event:SourceWatermarkChange):Promise<boolean>;
}
export async function deliverHistoryChanges(port:ChangeConsumerPort,limit=100):Promise<number>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>250)throw Error('Invalid change delivery budget');const events=await port.pending(limit);if(events.length>limit)throw Error('Change reader exceeded budget');let delivered=0;
 for(const event of events){if(sourceWatermarkChange(event)&&await port.enqueueAndAcknowledge(event))delivered++;}return delivered;
}
