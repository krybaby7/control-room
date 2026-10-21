import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {handlePersonalRepositoryHttp} from '../../../lib/personal-repository-http';
export const dynamic='force-dynamic';
async function handle(request:Request){const user=await getChatGPTUser();return handlePersonalRepositoryHttp(request,'owner',{db:env.DB??null,configuration:env.CONTROL_ROOM_PERSONAL_CONNECTOR,ownerId:user?.userId??null});}
export const GET=handle;
export const POST=handle;
