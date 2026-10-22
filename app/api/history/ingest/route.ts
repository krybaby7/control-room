import {env} from 'cloudflare:workers';
import {handleHistoryTransport} from '../../../../lib/history/http';
export const dynamic='force-dynamic';
/** No supported renewable native private-ingress binding is available in this
 * deployment yet. Keep this separate history scope closed until one is verified. */
export function POST(request:Request){return handleHistoryTransport('ingest',request,{db:env.DB??null,now:()=>new Date().toISOString()});}
