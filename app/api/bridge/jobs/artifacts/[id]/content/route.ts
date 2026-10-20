import {createManualSitesIngress} from '../../../../../../../lib/devices/private-ingress';
import {env} from 'cloudflare:workers';
import {handleAgentArtifactHttp} from '../../../../../../../lib/agents/artifact-http';
export const dynamic='force-dynamic';
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){return handleAgentArtifactHttp('content',request,{db:env.DB??null,ingress:createManualSitesIngress(env.CONTROL_ROOM_MANUAL_SITES_WINDOW),bucket:env.BUCKET},(await params).id);}
