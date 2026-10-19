import {createManualSitesIngress} from '../../../../../lib/devices/private-ingress';
import {env} from 'cloudflare:workers';
import {handleAgentHttp} from '../../../../../lib/agents/http';
import {createAgentResultVerifier} from '../../../../../lib/agents/result-verifier';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleAgentHttp("reconcile",request,{db:env.DB??null,ingress:createManualSitesIngress(env.CONTROL_ROOM_MANUAL_SITES_WINDOW),...(env.DB?{verifyResult:createAgentResultVerifier({db:env.DB,bucket:env.BUCKET})}:{})});}
