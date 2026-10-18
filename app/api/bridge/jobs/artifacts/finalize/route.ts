import {env} from 'cloudflare:workers';
import {handleAgentArtifactHttp} from '../../../../../../lib/agents/artifact-http';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleAgentArtifactHttp('finalize',request,{db:env.DB??null,bucket:env.BUCKET});}
