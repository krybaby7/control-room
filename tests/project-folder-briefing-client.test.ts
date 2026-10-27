import test from 'node:test';
import assert from 'node:assert/strict';
import {briefingRequest,sendPersonalAction} from '../lib/project-briefing-client.ts';

test('project folder briefing uses the minimal owner request through the existing PC client',async()=>{
 const action=briefingRequest('project','app','claude');
 assert.deepEqual(Object.keys(action).sort(),['action','projectId','provider','repositoryKey','requestId']);
 assert.deepEqual({...action,requestId:'original'},{action:'brief',requestId:'original',projectId:'project',repositoryKey:'app',provider:'claude'});
 assert.match(action.requestId,/^[a-f0-9-]{36}$/);
 let submitted:unknown;
 await sendPersonalAction(action,{fetch:async(url,init)=>{assert.equal(url,'/api/personal-repositories');assert.equal(init?.method,'POST');submitted=JSON.parse(init?.body as string);return new Response('{}',{status:200});}});
 assert.deepEqual(submitted,action);
});
