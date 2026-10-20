import {fileURLToPath} from 'node:url';
/** Node ESM --import requires a URL on Windows, while the test file argument is
 * a native filesystem path. Keeping these representations separate also handles
 * spaces and encoded characters in checkout paths. */
export function cliUnitChildArguments(testModuleUrl,namePattern){return ['--import',new URL('./cli-windows-state-loader.mjs',import.meta.url).href,'--test','--test-name-pattern',namePattern,fileURLToPath(testModuleUrl)];}
