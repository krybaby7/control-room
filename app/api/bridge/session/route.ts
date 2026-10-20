import {createManualSitesIngress} from '../../../../lib/devices/private-ingress';
import {env} from 'cloudflare:workers';
import {handleDeviceHttp} from '../../../../lib/devices/http';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleDeviceHttp('session',request,{db:env.DB??null,ingress:createManualSitesIngress(env.CONTROL_ROOM_MANUAL_SITES_WINDOW),now:()=>new Date().toISOString()});}
