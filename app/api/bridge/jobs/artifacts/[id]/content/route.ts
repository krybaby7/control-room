import {env} from 'cloudflare:workers';
import {handleAgentArtifactHttp} from '../../../../../../../lib/agents/artifact-http';
export const dynamic='force-dynamic';
export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){return handleAgentArtifactHttp('content',request,{db:env.DB??null,bucket:env.BUCKET},(await params).id);}
