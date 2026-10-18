import {env} from 'cloudflare:workers';
import {handleDeviceHttp} from '../../../../lib/devices/http';
import {unavailablePrivateIngress} from '../../../../lib/devices/contracts';
import {ingestHeartbeat} from '../../../../lib/runtime/store';
import {pruneRuntime} from '../../../../lib/runtime/retention';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleDeviceHttp('heartbeat',request,{db:env.DB??null,ingress:unavailablePrivateIngress,now:()=>new Date().toISOString(),ingest:ingestHeartbeat,afterHeartbeat:(db,principal,now)=>pruneRuntime(db,principal.ownerId,now,{limit:100})});}
