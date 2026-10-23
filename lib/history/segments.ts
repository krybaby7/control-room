import type { Availability, HistorySegment, HistoryAttachment } from './contracts.ts';
export { HistorySegmentSchema, HistoryAttachmentSchema } from './validation.ts';
/** Private metadata obtained from finalized retained bytes under the authenticated
 * owner AND source. recordCount is the parsed source segment count, not messages
 * emitted after filtering. Unknown counts cannot prove record-range bounds. */
export interface VerifiedSegmentMetadata {
    id: string;
    verified: true;
    bytes: number;
    recordCount: number | null;
}
/** Invoke after envelope/object verification. This also checks inherited bounds
 * against verified metadata; mere segment presence never proves completeness. */
export function contentComplete(
    segments: readonly Pick<HistorySegment, 'id' | 'availability' | 'inheritedFromSegmentId' | 'inheritedRange'>[],
    attachments: readonly Pick<HistoryAttachment, 'availability'>[],
    messages: readonly { availability: Availability }[],
    verifiedSegments: readonly VerifiedSegmentMetadata[] = [],
): boolean {
    const byId = new Map(segments.map(s => [s.id, s]));
    const metadata = new Map(verifiedSegments.map(s => [s.id, s]));
    if (byId.size !== segments.length || metadata.size !== verifiedSegments.length) return false;
    const validCount = (n: number) => Number.isSafeInteger(n) && n >= 0;
    for (const segment of segments) {
        const visited = new Set<string>();
        let current: typeof segment | undefined = segment;
        while (current) {
            const verified = metadata.get(current.id);
            if (current.availability !== 'complete' || visited.has(current.id) || !verified?.verified || !validCount(verified.bytes)) return false;
            visited.add(current.id);
            if ((current.inheritedFromSegmentId === null) !== (current.inheritedRange === null)) return false;
            if (current.inheritedFromSegmentId === null) break;
            const range = current.inheritedRange!;
            const parent = metadata.get(current.inheritedFromSegmentId);
            const limit = range.unit === 'bytes' ? parent?.bytes : parent?.recordCount;
            if (!parent?.verified || limit == null || !validCount(limit) || !validCount(range.start) || !validCount(range.end) || range.start >= range.end || range.end > limit) return false;
            current = byId.get(current.inheritedFromSegmentId);
            if (!current) return false;
        }
    }
    return [...attachments, ...messages].every(row => row.availability === 'complete');
}
