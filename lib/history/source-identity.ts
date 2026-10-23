import {canonical,contentHash} from '../canonical-json.ts';
import type {HistorySourceValue} from './record.ts';
/** Capability is an operational observation. Every other source field remains
 * part of the semantic authority boundary, including configuration and pause. */
export function sourceSemanticValue(source:HistorySourceValue):Omit<HistorySourceValue,'capability'>{const {capability,...semantic}=source;void capability;return semantic;}
export async function sourceSemanticDigest(source:HistorySourceValue):Promise<string>{return contentHash(canonical(['history-source-semantic-v1',sourceSemanticValue(source)]));}
