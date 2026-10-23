import {env} from 'cloudflare:workers';
import {handleHistoryTransport} from '../../../../lib/history/http';
import {historyPrivateBucket} from '../../../../lib/history/bucket';
export const dynamic='force-dynamic';
export function POST(request:Request){return handleHistoryTransport('objects',request,{db:env.DB??null,bucket:historyPrivateBucket(env.BUCKET),now:()=>new Date().toISOString()});}
