import { resolve, isAbsolute } from 'node:path';
import { atomicPrivateJson, readPrivateJson, privateDirectory } from './spool.mjs';
export const COLLECTOR_VERSION = '0.1.0';
export const TRUSTED_HISTORY_ORIGIN = 'https://adami-project-control-center.roundmoth32.chatgpt.site';
export function trustedOrigin(value, allowedOrigins = [TRUSTED_HISTORY_ORIGIN]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' || !allowedOrigins.includes(url.origin) || value !== url.origin)
        throw Error('Untrusted history service origin');
    return url.origin;
}
export function validateConfig(input, { allowedOrigins } = {}) {
    const keys = ['codecVersion', 'origin', 'stateDirectory', 'sources', 'scopes', 'reconcileIntervalMs', 'debounceMs', 'maxCatchUpLagMs'];
    if (!input || Object.keys(input).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(input, k)) || input.codecVersion !== 1)
        throw Error('Unknown collector configuration');
    trustedOrigin(input.origin, allowedOrigins);
    if (!isAbsolute(input.stateDirectory) || !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 32 || JSON.stringify(input.scopes) !== JSON.stringify(['history.read', 'history.ingest']))
        throw Error('Explicit history scopes and private state directory required');
    const seen = new Set();
    for (const s of input.sources) {
        if (Object.keys(s).sort().join(',') !== 'accountId,codecVersion,deviceId,epoch,exclusions,includeArchived,kind,normalizationVersion,parserVersion,roots,scopeRevision,sourceId' || typeof s.includeArchived !== 'boolean' || !Array.isArray(s.exclusions) || s.exclusions.length > 100 || s.exclusions.some(x => typeof x !== 'string' || !x || x.length > 1000) || s.codecVersion !== 1 || !['codex_local', 'claude_code_local'].includes(s.kind) || typeof s.sourceId !== 'string' || !s.sourceId || seen.has(s.sourceId) || typeof s.epoch !== 'string' || !s.epoch || !Number.isSafeInteger(s.scopeRevision) || s.scopeRevision < 1 || !Array.isArray(s.roots) || !s.roots.length || s.roots.length > 32 || s.roots.some(r => !isAbsolute(r)) || !s.parserVersion || !s.normalizationVersion)
            throw Error('Selected enrolled local source configuration required');
        seen.add(s.sourceId);
    }
    for (const [key, min, max] of [['reconcileIntervalMs', 1000, 3600000], ['debounceMs', 0, 60000], ['maxCatchUpLagMs', 1000, 86400000]])
        if (!Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max)
            throw Error('Invalid reconcile policy');
    return structuredClone(input);
}
export async function writeConfig(path, value, options) {
    const config = validateConfig(value, options);
    await privateDirectory(resolve(path, '..'));
    await atomicPrivateJson(path, config);
    return config;
}
export async function readConfig(path, options) {
    return validateConfig(await readPrivateJson(path), options);
}
