import {env} from 'cloudflare:workers';
import {handleHistorySyncRequest} from '../../../../lib/history/sync-http';
export const dynamic='force-dynamic';
/** Supported native private service/read-only adapter bindings must be supplied
 * by the release integrator. Cookies and upload credentials are not runner proof. */
export async function POST(request:Request){return handleHistorySyncRequest(request,{db:env.DB??null,now:()=>new Date().toISOString()});}
