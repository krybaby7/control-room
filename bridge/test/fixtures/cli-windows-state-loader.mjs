/** Isolated child-process UNIT loader. It replaces only the fixed Windows state
 * guard for three injected CLI orchestration cases. This is not ACL evidence;
 * native ACL/DPAPI acceptance runs separately without this loader. */
import {registerHooks} from 'node:module';
if(process.env.CONTROL_ROOM_UNIT_CLI_STATE!=='synthetic-only')throw Error('unit_cli_loader_requires_explicit_child');
const target=new URL('../../src/windows-state.mjs',import.meta.url).href;
registerHooks({load(url,context,next){if(url!==target)return next(url,context);return {format:'module',shortCircuit:true,source:`
import {dirname,join,basename,isAbsolute} from 'node:path';
export async function ensurePrivateWindowsState({configPath,stateDirectory}){
 if(!isAbsolute(configPath)||basename(configPath)!=='config.json'||!/^synthetic-(?:bridge-cli|bridge-enroll|doctor)-/u.test(basename(dirname(configPath)))||stateDirectory!==join(dirname(configPath),'.control-room-bridge'))throw Error('unit_cli_scope_required');
 return {status:'synthetic-unit-only'};
}
`};}});
