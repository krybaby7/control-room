import {resolveManualSitesAccess} from '../src/sites-access.mjs';
/** Fixed documented Sites header only; absent protected manual record is closed. */
export async function resolveExecutionPrivateIngress(origin,{configPath}={}){return resolveManualSitesAccess({origin,configPath});}
