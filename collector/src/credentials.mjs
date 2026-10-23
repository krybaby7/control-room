import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { privateDirectory, atomicPrivateJson, readPrivateJson, digest } from './spool.mjs';
/** Plaintext JSON is permitted only inside an OS-protected current-user directory.
 * Windows deployment must install the CurrentUser-DPAPI provider instead; no secret
 * is accepted in config, command arguments, logs, spool packets, or exports. */
export async function writeCredential(directory, value) {
    if (process.platform === 'win32')
        throw Error('Use current-user DPAPI enrollment from protected stdin');
    if (value.version !== 1 || !/^crh_[a-f0-9]{64}$/.test(value.token) || !value.sourceId || !value.epoch || !Number.isSafeInteger(value.scopeRevision) || value.scopeRevision < 1 || !Number.isFinite(Date.parse(value.expiresAt)))
        throw Error('Invalid history enrollment credential');
    await privateDirectory(directory);
    await atomicPrivateJson(join(directory, digest(value.sourceId) + '.json'), value);
}
export async function readCredential(directory, source, now = Date.now()) {
    let value;
    if (process.platform === 'win32') {
        const script = fileURLToPath(new URL('../windows/protect-credential.ps1', import.meta.url));
        const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-CredentialFile', join(directory, digest(source.sourceId) + '.dpapi'), '-Read'], { windowsHide: true, maxBuffer: 16384 });
        value = JSON.parse(result.stdout);
    }
    else
        value = await readPrivateJson(join(directory, digest(source.sourceId) + '.json'), 16384);
    if (value.version !== 1 || !/^crh_[a-f0-9]{64}$/.test(value.token) || value.sourceId !== source.sourceId || value.epoch !== source.epoch || value.scopeRevision !== source.scopeRevision || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now)
        throw Error('History enrollment expired or scope changed');
    return value;
}
/** Deliberately unavailable until the deployment supplies an independently verified
 * private Sites service-ingress provider. Application credentials are insufficient. */
export async function unavailablePrivateIngress() {
    throw Error('private_ingress_not_configured');
}
