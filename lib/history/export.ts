import { z } from 'zod';
import { canonical, contentHash } from '../canonical-json.ts';
import { parsePlanningImport } from '../workspace-codec.ts';
import type { Workspace } from '../types.ts';
import type { ExportContext, PhysicalImportRows } from '../workspace-export.ts';
import { historyExportAdapter } from './module.ts';
import { historyRecordId, parseHistoryRecord, type HistoryRecord } from './record.ts';
import { readHistoryObject, stageHistoryObject, MAX_HISTORY_OBJECT_BYTES, type HistoryObjectDeps, type HistoryObjectManifest, type HistoryObjectScope } from './object-store.ts';
export const MAX_HISTORY_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_HISTORY_METADATA_BYTES = 8 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/), str = z.string().min(1).max(2048), count = z.number().int().nonnegative().safe();
const selectionSchema = z.object({
    rawSource: z.boolean(), messageBodies: z.boolean(), attachments: z.boolean(), repositoryEvidence: z.boolean(), redactedAnalysis: z.literal('not_available')
}).strict();
/** Redacted analysis objects have no authoritative object codec in S1. Their
 * absence is explicit; normalized message bodies are never labelled redacted. */
export type HistoryExportSelection = z.infer<typeof selectionSchema>;
const objectRefSchema = z.object({
    recordId: str, kind: z.enum(['message', 'segment', 'attachment', 'repository_evidence']), sourceId: str.nullable(), key: str.nullable(), sha256: hash.nullable(), bytes: count.nullable(), availability: z.enum(['included', 'missing', 'excluded']), reason: str.nullable()
}).strict();
const rowSchema = z.object({
    id: str, rowRevision: z.number().int().positive().safe(), contentHash: hash, value: z.unknown()
}).strict();
const moduleSchema = z.object({ schemaVersion: z.literal(1), records: z.array(rowSchema).max(10000) }).strict();
const manifestSchema = z.object({
    manifestVersion: z.literal(1), planningRevision: count, historyWatermark: str, sourceWatermarks: z.record(str), selection: selectionSchema, planningHash: hash, moduleHash: hash, objects: z.array(objectRefSchema).max(1000), completeness: z.enum(['included_available_objects', 'partial']), limitation: z.literal('Only selected retained objects are represented; this is not proof of complete provider history.')
}).strict();
const bundleSchema = z.object({
    format: z.literal('control-room-history'), bundleVersion: z.literal(1), planning: z.unknown(), module: moduleSchema, manifest: manifestSchema, manifestDigest: hash, objects: z.array(z.object({ key: str, base64: z.string().max(Math.ceil(MAX_HISTORY_OBJECT_BYTES / 3) * 4) }).strict()).max(1000)
}).strict();
export type HistoryBundle = z.infer<typeof bundleSchema>;
type PortableRow = HistoryBundle['module']['records'][number];
type ObjectReference = z.infer<typeof objectRefSchema>;
export interface HistorySnapshot {
    planning: Workspace;
    planningRevision: number;
    historyWatermark: string;
    sourceWatermarks: Record<string, string>;
}
export interface HistoryExportContext extends ExportContext {
    /** Server-bound reads, using this context's authenticated owner. Monotonic
     * revisions/watermarks must change on every relevant mutation (no ABA). */
    captureSnapshot(): Promise<HistorySnapshot>;
    objects: HistoryObjectDeps;
    resolveObject(key: string): Promise<{
        scope: HistoryObjectScope;
        manifest: HistoryObjectManifest;
    } | null>;
    selection: HistoryExportSelection;
}
function byteLength(value: unknown) { return new TextEncoder().encode(canonical(value)).byteLength; }
async function digest(value: unknown) { return contentHash(canonical(value)); }
function encode(bytes: Uint8Array): string { let text = ''; for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); }
function decode(base64: string): Uint8Array { if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    throw Error('Invalid object encoding.'); const text = atob(base64); if (text.length > MAX_HISTORY_OBJECT_BYTES)
    throw Error('History object exceeds bound.'); return Uint8Array.from(text, c => c.charCodeAt(0)); }
async function logicalId(row: HistoryRecord): Promise<string> {
    if (row.kind === 'roadmap_scope')
        return `${row.value.id}@${row.value.revision}`;
    if (row.kind === 'ingest_page') {
        const r = row.value.acknowledgement;
        return contentHash(canonical([r.sourceId, r.epoch, r.scopeRevision, r.pageId]));
    }
    if ('id' in row.value)
        return row.value.id;
    if (row.kind === 'cursor')
        return row.value.sourceId;
    if (row.kind === 'inventory_membership') {
        const v = row.value;
        return contentHash(canonical([v.sourceId, v.epoch, v.scopeRevision, v.generation, v.conversationId]));
    }
    throw Error('Unsupported history identity.');
}
async function validateRows(rows: PortableRow[], planning: Workspace): Promise<HistoryRecord[]> {
    const records: HistoryRecord[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const record = parseHistoryRecord(row.value);
        if (seen.has(row.id) || row.id !== record.id || row.id !== await historyRecordId(record.kind, await logicalId(record)) || row.contentHash !== await digest(record))
            throw Error('History module identity or digest differs.');
        seen.add(row.id);
        records.push(record);
    }
    historyExportAdapter.validateReferences?.({ planning, modules: { project_history: { schemaVersion: 1, records: rows } } }, rows);
    return records;
}
function references(records: HistoryRecord[]): ObjectReference[] {
    const conversations = new Map(records.filter(r => r.kind === 'conversation').map(r => [r.value.id, r.value]));
    const messages = new Map(records.filter(r => r.kind === 'message').map(r => [r.value.id, r.value]));
    const sourceForMessage = (id: string) => { const m = messages.get(id); return m ? conversations.get(m.conversationId)?.sourceId ?? null : null; };
    const refs: ObjectReference[] = [];
    for (const row of records) {
        let ref: ObjectReference | undefined;
        if (row.kind === 'message')
            ref = {
                recordId: row.id, kind: row.kind, sourceId: sourceForMessage(row.value.id), key: row.value.bodyObjectKey, sha256: row.value.revisionDigest, bytes: row.value.contentBytes, availability: 'missing', reason: 'Object not included.'
            };
        if (row.kind === 'segment')
            ref = {
                recordId: row.id, kind: row.kind, sourceId: row.value.sourceId, key: row.value.objectKey, sha256: row.value.sha256, bytes: row.value.bytes, availability: 'missing', reason: row.value.unavailableReason ?? 'Object not retained.'
            };
        if (row.kind === 'attachment')
            ref = {
                recordId: row.id, kind: row.kind, sourceId: sourceForMessage(row.value.messageRevisionId), key: row.value.objectKey, sha256: row.value.sha256, bytes: row.value.bytes, availability: 'missing', reason: row.value.unavailableReason ?? 'Object not retained.'
            };
        if (row.kind === 'repository_evidence')
            ref = {
                recordId: row.id, kind: row.kind, sourceId: null, key: row.value.bodyObjectKey, sha256: row.value.contentDigest, bytes: null, availability: 'missing', reason: 'Object not retained.'
            };
        if (ref)
            refs.push(ref);
    }
    return refs.sort((a, b) => a.recordId.localeCompare(b.recordId));
}
function selected(ref: ObjectReference, selection: HistoryExportSelection) { return ref.kind === 'message' ? selection.messageBodies : ref.kind === 'segment' ? selection.rawSource : ref.kind === 'attachment' ? selection.attachments : selection.repositoryEvidence; }
function metadata(bundle: HistoryBundle) { return { ...bundle, objects: bundle.objects.map(o => ({ key: o.key })) }; }
/** Buffered Node/offline artifact helper: the 64 MiB package bound is not a
 * proven hosted-worker memory bound. Hosted routes must use streaming/paged
 * transport or a separately measured lower limit.
 * Produces a bounded deterministic portable artifact. A changing snapshot aborts
 * rather than exporting planning/history from different watermarks. */
export async function exportHistoryBundle(ctx: HistoryExportContext): Promise<HistoryBundle> {
    if (!ctx.userId)
        throw Error('Authenticated owner required.');
    selectionSchema.parse(ctx.selection);
    const before = await ctx.captureSnapshot();
    if (before.planningRevision !== ctx.sourceRevision)
        throw Error('Planning snapshot changed.');
    const planning = parsePlanningImport(before.planning);
    const rows: PortableRow[] = [];
    let after: string | undefined;
    let rowBytes = 0;
    for (;;) {
        const page = await ctx.query.list('project_history', { after, limit: 200 });
        if (page.length > 200)
            throw Error('History metadata page exceeds bound.');
        for (const raw of page) {
            if (after !== undefined && raw.id <= after)
                throw Error('History metadata pagination differs.');
            after = raw.id;
            rowBytes += new TextEncoder().encode(raw.payload_json).byteLength;
            if (rowBytes > MAX_HISTORY_METADATA_BYTES || rows.length >= 10000)
                throw Error('History metadata exceeds byte or row bound.');
            const row = rowSchema.parse({
                id: raw.id, rowRevision: raw.row_revision, contentHash: raw.content_hash, value: JSON.parse(raw.payload_json)
            });
            historyExportAdapter.parseAndMigrate({ schemaVersion: 1, records: [row] });
            rows.push(row);
        }
        if (page.length < 200)
            break;
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    // Portable source selection is deliberately disconnected and redacted. No
    // credentials, roots, account IDs, active leases or owner grants are exported.
    for (const row of rows) {
        const r = parseHistoryRecord(row.value);
        if (r.kind === 'source') {
            r.value.configuration = {
                ...r.value.configuration, roots: [], accountId: null, deviceId: null, exclusions: []
            };
            r.value.paused = true;
            row.value = r;
            row.contentHash = await digest(r);
        }
    }
    const records = await validateRows(rows, planning), refs = references(records), data = new Map<string, string>();
    if (refs.length > 1000)
        throw Error('History object count exceeds bound.');
    let total = 0;
    for (const ref of refs) {
        if (!selected(ref, ctx.selection)) {
            ref.availability = 'excluded';
            ref.reason = 'Excluded by explicit export selection.';
            continue;
        }
        if (!ref.key || !ref.sha256)
            continue;
        const resolved = await ctx.resolveObject(ref.key);
        if (!resolved)
            continue;
        if (resolved.scope.ownerId !== ctx.userId || ref.sourceId !== null && resolved.scope.sourceId !== ref.sourceId || resolved.manifest.key !== ref.key || resolved.manifest.sha256 !== ref.sha256 || ref.bytes !== null && resolved.manifest.bytes !== ref.bytes)
            throw Error('History object owner, source or digest differs.');
        ref.sourceId = resolved.scope.sourceId;
        ref.bytes = resolved.manifest.bytes;
        if (!data.has(ref.key)) {
            const bytes = await readHistoryObject(ctx.objects, resolved.scope, resolved.manifest);
            total += bytes.byteLength;
            if (total > MAX_HISTORY_BUNDLE_BYTES * 3 / 4)
                throw Error('History bundle exceeds byte bound.');
            data.set(ref.key, encode(bytes));
        }
        ref.availability = 'included';
        ref.reason = null;
    }
    const portableModule = { schemaVersion: 1 as const, records: rows };
    const manifest: HistoryBundle['manifest'] = {
        manifestVersion: 1, planningRevision: before.planningRevision, historyWatermark: before.historyWatermark, sourceWatermarks: before.sourceWatermarks, selection: ctx.selection, planningHash: await digest(planning), moduleHash: await digest(portableModule), objects: refs, completeness: refs.every(r => r.availability === 'included') ? 'included_available_objects' : 'partial', limitation: 'Only selected retained objects are represented; this is not proof of complete provider history.'
    };
    const bundle: HistoryBundle = {
        format: 'control-room-history', bundleVersion: 1, planning, module: portableModule, manifest, manifestDigest: await digest(manifest), objects: [...data].sort(([a], [b]) => a.localeCompare(b)).map(([key, base64]) => ({ key, base64 }))
    };
    if (byteLength(metadata(bundle)) > MAX_HISTORY_METADATA_BYTES || byteLength(bundle) > MAX_HISTORY_BUNDLE_BYTES)
        throw Error('History bundle exceeds byte bound.');
    validateRetainedCitations(records, refs, data);
    if (canonical(before) !== canonical(await ctx.captureSnapshot()))
        throw Error('History snapshot changed during export.');
    return bundle;
}
/** Available immutable text validates cited Unicode spans. Missing/excluded text
 * remains explicitly unavailable evidence; it can never establish acceptance. */
function validateRetainedCitations(records: HistoryRecord[], refs: ObjectReference[], data: Map<string, string>): void {
    const messages = new Map(records.filter(r => r.kind === 'message').map(r => [r.value.id, r]));
    const text = new Map<string, string>();
    for (const ref of refs)
        if (ref.kind === 'message' && ref.availability === 'included')
            text.set(ref.recordId, new TextDecoder('utf-8', { fatal: true }).decode(decode(data.get(ref.key!)!)));
    const citations = records.flatMap(row => row.kind === 'claim' ? row.value.citations : row.kind === 'story' ? [...row.value.finished, ...row.value.open, ...row.value.next].flatMap(entry => entry.citations) : []);
    for (const citation of citations) {
        const message = messages.get(citation.messageRevisionId);
        if (!message || message.value.revisionDigest !== citation.revisionDigest)
            throw Error('History citation reference differs.');
        const body = text.get(message.id);
        if (body !== undefined && citation.end > Array.from(body).length)
            throw Error('History citation exceeds immutable Unicode text.');
    }
    const segments = new Map(records.filter(r => r.kind === 'segment').map(r => [r.value.id, r.value]));
    for (const segment of segments.values())
        if (segment.availability === 'complete' && segment.inheritedFromSegmentId !== null) {
            const parent = segments.get(segment.inheritedFromSegmentId);
            if (!parent || parent.sourceId !== segment.sourceId)
                throw Error('Inherited history segment is missing or foreign.');
            if (segment.inheritedRange?.unit === 'bytes' && (parent.bytes === null || segment.inheritedRange.end > parent.bytes))
                throw Error('Inherited history byte range exceeds retained segment.');
        }
}
/** Integrity is verified before any object staging or module mutation. */
export async function parseHistoryBundle(input: unknown): Promise<HistoryBundle> {
    if (byteLength(input) > MAX_HISTORY_BUNDLE_BYTES)
        throw Error('History bundle exceeds byte bound.');
    const bundle = bundleSchema.parse(input);
    if (byteLength(metadata(bundle)) > MAX_HISTORY_METADATA_BYTES)
        throw Error('History metadata exceeds byte bound.');
    const planning = parsePlanningImport(bundle.planning);
    if (await digest(bundle.manifest) !== bundle.manifestDigest || await digest(bundle.module) !== bundle.manifest.moduleHash || await digest(planning) !== bundle.manifest.planningHash)
        throw Error('History manifest or module digest differs.');
    const records = await validateRows(bundle.module.records, planning), expected = references(records), refs = bundle.manifest.objects;
    if (expected.length !== refs.length || new Set(refs.map(r => r.recordId)).size !== refs.length)
        throw Error('History object references differ.');
    for (const ref of refs) {
        const original = expected.find(e => e.recordId === ref.recordId);
        if (!original || original.kind !== ref.kind || original.key !== ref.key || original.sha256 !== ref.sha256 || original.bytes !== null && original.bytes !== ref.bytes || original.sourceId !== null && original.sourceId !== ref.sourceId)
            throw Error('History object reference differs.');
        if (ref.availability === 'included' && (!ref.key || !ref.sha256 || ref.bytes === null || ref.bytes > MAX_HISTORY_OBJECT_BYTES || ref.reason !== null) || ref.availability !== 'included' && !ref.reason)
            throw Error('History object availability differs.');
        if ((ref.availability === 'excluded') !== !selected(ref, bundle.manifest.selection))
            throw Error('History selection differs.');
    }
    const included = new Map<string, ObjectReference>();
    for (const ref of refs.filter(r => r.availability === 'included')) {
        const prior = included.get(ref.key!);
        if (prior && (prior.sha256 !== ref.sha256 || prior.bytes !== ref.bytes))
            throw Error('Conflicting history object reference.');
        included.set(ref.key!, ref);
    }
    if (new Set(bundle.objects.map(o => o.key)).size !== bundle.objects.length || included.size !== bundle.objects.length)
        throw Error('History object set differs.');
    for (const object of bundle.objects) {
        const ref = included.get(object.key);
        if (!ref)
            throw Error('Unexpected history object.');
        const bytes = decode(object.base64);
        if (bytes.length !== ref.bytes || await contentHash(bytes) !== ref.sha256)
            throw Error('History body digest differs.');
    }
    validateRetainedCitations(records, refs, new Map(bundle.objects.map(o => [o.key, o.base64])));
    if ((refs.every(r => r.availability === 'included') ? 'included_available_objects' : 'partial') !== bundle.manifest.completeness)
        throw Error('History completeness differs.');
    return { ...bundle, planning };
}
export interface HistoryRestoreContext {
    ownerId: string;
    objects: HistoryObjectDeps;
}
export interface HistoryRestoreProposal {
    planning: Workspace;
    replacement: PhysicalImportRows;
    module: HistoryBundle['module'];
    sourceManifest: HistoryBundle['manifest'];
    stagedObjects: HistoryObjectManifest[];
    requiresFreshEnrollment: true;
    transfersOwnerGrants: false;
    committed: false;
}
/** Helper only: the reviewed proposal must be admitted/committed by the existing
 * workspace command boundary. The root adapter preserves these staged source
 * epochs while keeping restored sources paused. No old owner key
 * is read during restore; only package bytes can enter the target bucket. */
export async function prepareHistoryRestore(input: unknown, ctx: HistoryRestoreContext): Promise<HistoryRestoreProposal> {
    if (!ctx.ownerId)
        throw Error('Authenticated restore owner required.');
    const bundle = await parseHistoryBundle(input), records = bundle.module.records.map(r => parseHistoryRecord(r.value));
    const sources = new Map<string, Extract<HistoryRecord, {
        kind: 'source';
    }>>();
    for (const row of records)
        if (row.kind === 'source') {
            const epoch = crypto.randomUUID(), scopeRevision = row.value.scopeRevision + 1;
            row.value = {
                ...row.value, epoch, scopeRevision, executionEpoch: row.value.executionEpoch + 1, paused: true, configuration: {
                    ...row.value.configuration, epoch, scopeRevision, roots: [], accountId: null, deviceId: null, exclusions: []
                }, capability: {
                    ...row.value.capability, inventory: 'unverified', contentRead: 'unverified', unattendedRead: false, verifiedAt: null, proofRef: null, limitation: 'Restored source requires fresh enrollment and scope verification.'
                }
            };
            sources.set(row.value.id, row);
        }
    const refs = new Map(bundle.manifest.objects.map(r => [r.recordId, r])), bodies = new Map(bundle.objects.map(o => [o.key, o.base64]));
    // Validate every target source binding before the first staging side effect.
    for (const ref of refs.values())
        if (ref.availability === 'included' && (!ref.sourceId || !sources.has(ref.sourceId)))
            throw Error('Restored object source is missing.');
    const stagedObjects: HistoryObjectManifest[] = [], rekeyed = new Map<string, HistoryObjectManifest>();
    try {
        for (const row of records) {
            const ref = refs.get(row.id);
            if (!ref)
                continue;
            let staged: HistoryObjectManifest | undefined;
            if (ref.availability === 'included') {
                const source = sources.get(ref.sourceId!)!, key = `${ref.sourceId}\0${ref.key}`;
                staged = rekeyed.get(key);
                if (!staged) {
                    staged = await stageHistoryObject(ctx.objects, {
                        ownerId: ctx.ownerId, sourceId: source.value.id, epoch: source.value.epoch, scopeRevision: source.value.scopeRevision, bytes: decode(bodies.get(ref.key!)!), sha256: ref.sha256!
                    });
                    stagedObjects.push(staged);
                    rekeyed.set(key, staged);
                }
            }
            if (row.kind === 'message')
                row.value = {
                    ...row.value, bodyObjectKey: staged?.key ?? `unavailable:${crypto.randomUUID()}`, availability: staged ? row.value.availability : 'unavailable'
                };
            if (row.kind === 'repository_evidence')
                row.value = {
                    ...row.value, bodyObjectKey: staged?.key ?? `unavailable:${crypto.randomUUID()}`, availability: staged ? row.value.availability : 'unavailable'
                };
            if (row.kind === 'segment' || row.kind === 'attachment')
                row.value = {
                    ...row.value, objectKey: staged?.key ?? null, sha256: staged?.sha256 ?? null, bytes: staged?.bytes ?? null, availability: staged ? row.value.availability : 'unavailable', unavailableReason: staged ? row.value.unavailableReason : `Portable history object ${ref.availability}: ${ref.reason}`
                };
        }
        // Runtime cursors are historical snapshots, not authorization. Discard them
        // so an old exhausted cursor cannot claim completeness after fresh enrollment.
        const restored = records.filter(r => r.kind !== 'cursor' && r.kind !== 'sync_run');
        const rows: PortableRow[] = await Promise.all(restored.map(async (value) => ({
            id: value.id, rowRevision: 1, value: parseHistoryRecord(value), contentHash: await digest(value)
        })));
        await validateRows(rows, parsePlanningImport(bundle.planning));
        return {
            planning: parsePlanningImport(bundle.planning), replacement: { table: 'project_history', records: rows.map(r => ({ id: r.id, value: r.value as PhysicalImportRows['records'][number]['value'] })) }, module: { schemaVersion: 1, records: rows }, sourceManifest: bundle.manifest, stagedObjects, requiresFreshEnrollment: true, transfersOwnerGrants: false, committed: false
        };
    }
    catch (error) {
        // Only this failed attempt's newly issued, settled keys may be abandoned.
        // No deletion occurs. The same SQL guard used by ingestion requires ready
        // objects, so a racing consumer either wins first (reference prevents abandon)
        // or loses its final guard. Old/live generations and pending PUTs are untouched.
        if (await ctx.objects.authorize().catch(() => false))
            for (const manifest of stagedObjects) {
                await ctx.objects.db.prepare("UPDATE history_object_ledger SET status='abandoned' WHERE user_id=? AND key=? AND sha256=? AND bytes=? AND status='ready' AND pending_token IS NULL AND NOT EXISTS(SELECT 1 FROM project_history WHERE user_id=? AND (json_extract(payload_json,'$.value.objectKey')=? OR json_extract(payload_json,'$.value.bodyObjectKey')=?))").bind(ctx.ownerId, manifest.key, manifest.sha256, manifest.bytes, ctx.ownerId, manifest.key, manifest.key).run().catch(() => undefined);
            }
        throw error;
    }
}
/** Legacy planning JSON remains supported by the existing migration codec. */
export function parseLegacyPlanningHistoryImport(input: unknown): Workspace { return parsePlanningImport(input); }
