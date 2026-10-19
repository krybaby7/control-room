import {mkdtemp as createTemporary,realpath} from 'node:fs/promises';
import {mkdtempSync as createTemporarySync,realpathSync} from 'node:fs';
/** Portable fixture paths must satisfy production lexical/canonical guards even
 * when Windows TEMP uses an 8.3 alias. This does not relax any production guard. */
export const canonicalMkdtemp=async prefix=>realpath(await createTemporary(prefix));
export const canonicalMkdtempSync=prefix=>realpathSync(createTemporarySync(prefix));
/** Synthetic unit-only verifier. Never Windows ACL/protection evidence; native
 * acceptance tests use the real fixed Windows ACL verifier instead. */
export async function unitPrivateStateVerifier(){}
