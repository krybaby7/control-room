import {env} from 'cloudflare:workers';
import {handlePersonalRepositoryHttp} from '../../../../lib/personal-repository-http';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handlePersonalRepositoryHttp(request,'device',{db:env.DB??null,configuration:env.CONTROL_ROOM_PERSONAL_CONNECTOR});}
