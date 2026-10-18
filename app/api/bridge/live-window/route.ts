import {env} from 'cloudflare:workers';
import {handleDeviceHttp} from '../../../../lib/devices/http';
import {unavailablePrivateIngress} from '../../../../lib/devices/contracts';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleDeviceHttp('live-window',request,{db:env.DB??null,ingress:unavailablePrivateIngress,now:()=>new Date().toISOString()});}
