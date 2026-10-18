import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {createOwnerEnrollment} from '../lib/devices/enrollment.ts';
import {redeemDeviceEnrollment} from '../lib/devices/store.ts';
import {authenticateDevice} from '../lib/devices/auth.ts';
import {deviceEnrollmentScopesSchema,type DeviceEnrollmentScopes} from '../lib/devices/validation.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
const owner='synthetic-scoped-enrollment-owner',now='2026-10-18T12:00:00.000Z';
const ingress={verify:async()=>({serviceIdentity:'synthetic-private-ingress'})};
async function fixture(){const f=database();await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);return f;}
function command(scopes:DeviceEnrollmentScopes,deviceId?:string){return {type:'devices.enrollment.create' as const,value:{label:'Synthetic scoped device',...(deviceId?{deviceId}:{}),scopes:[...scopes]}};}
for(const scopes of [['telemetry:write'],['jobs:poll','jobs:report'],['evaluations:write']] as const){
 test('public owner enrollment and redemption preserve exact closed scopes '+scopes.join(','),async()=>{
  const f=await fixture();try{
   const before=await readCurrent(f.db,owner,now),mutationId=crypto.randomUUID(),input={revision:before.revision,mutationId,command:command(scopes)};
   const issued=await createOwnerEnrollment(f.db,owner,input,now);assert.equal(issued.status,200);assert.ok('result' in issued.body);if(!('result' in issued.body))throw new Error('Expected first secret');
   const ticket=issued.body.result,privateRow=f.sqlite.prepare('SELECT * FROM device_enrollments WHERE user_id=?').get(owner)!;
   assert.equal(privateRow.secret_hash,await contentHash(ticket.secret));assert.equal(privateRow.scopes_json,canonical(scopes));assert.ok(!canonical(privateRow).includes(ticket.secret));
   const replay=await createOwnerEnrollment(f.db,owner,input,now);assert.equal(replay.status,409);assert.ok('code' in replay.body&&replay.body.code==='enrollment-secret-unavailable');assert.ok(!canonical(replay.body).includes(ticket.secret));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_enrollments').get()!.n,1);
   const credential=await redeemDeviceEnrollment(f.db,{secret:ticket.secret,bridgeVersion:'0.1.0'},{now,verifiedIngress:{serviceIdentity:'synthetic-private-ingress'}});
   const request=()=>new Request('https://synthetic.invalid/api/device',{headers:{'X-Control-Room-Device':credential.deviceCredential}});
   for(const scope of ['telemetry:write','jobs:poll','jobs:report','evaluations:write'] as const){const principal=await authenticateDevice(request(),scope,f.db,ingress,now);assert.equal(principal!==null,(scopes as readonly string[]).includes(scope));if(principal)assert.deepEqual(principal.scopes,[...scopes]);}
   assert.equal(await authenticateDevice(request(),scopes[0],f.db,{verify:async()=>null},now),null);
   await assert.rejects(redeemDeviceEnrollment(f.db,{secret:ticket.secret,bridgeVersion:'0.1.0'},{now,verifiedIngress:{serviceIdentity:'synthetic-private-ingress'}}));
   const after=await readCurrent(f.db,owner,now);assert.deepEqual(after.workspace,before.workspace);
   for(const table of ['agent_jobs','job_approvals','agent_budgets','automation_schedules'])assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get()!.n,0);
  }finally{f.sqlite.close();}
 });
}
test('closed enrollment tuples reject escalation, material forgery and missing server material',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner,now);
  for(const scopes of [[],['jobs:poll'],['jobs:report'],['jobs:report','jobs:poll'],['telemetry:write','evaluations:write'],['jobs:poll','jobs:report','telemetry:write'],['evaluations:write','evaluations:write'],['owner:write']]){
   assert.equal(deviceEnrollmentScopesSchema.safeParse(scopes).success,false);
   await assert.rejects(createOwnerEnrollment(f.db,owner,{revision:before.revision,mutationId:crypto.randomUUID(),command:{type:'devices.enrollment.create',value:{label:'Synthetic scoped device',scopes}}},now));
  }
  const valid=command(['jobs:poll','jobs:report']);
  for(const forged of [{...valid,material:{secretHash:'a'.repeat(64)}},{...valid,value:{...valid.value,secret:'synthetic-forged-secret'}},{...valid,value:{...valid.value,ownerId:owner}}])await assert.rejects(createOwnerEnrollment(f.db,owner,{revision:before.revision,mutationId:crypto.randomUUID(),command:forged},now));
  await assert.rejects(executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:before.revision,mutationId:crypto.randomUUID(),command:valid},{db:f.db,now:()=>now,handlers:workspaceHandlers}));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM device_enrollments').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM devices').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('explicit scope replacement revokes old credentials without combining authority',async()=>{
 const f=await fixture();try{
  const first=await createOwnerEnrollment(f.db,owner,{revision:(await readCurrent(f.db,owner,now)).revision,mutationId:crypto.randomUUID(),command:command(['telemetry:write'])},now);if(!('result' in first.body))throw new Error('Expected enrollment');
  const old=await redeemDeviceEnrollment(f.db,{secret:first.body.result.secret,bridgeVersion:'0.1.0'},{now,verifiedIngress:{serviceIdentity:'synthetic-private-ingress'}});
  const second=await createOwnerEnrollment(f.db,owner,{revision:(await readCurrent(f.db,owner,now)).revision,mutationId:crypto.randomUUID(),command:command(['jobs:poll','jobs:report'],first.body.result.deviceId)},now);if(!('result' in second.body))throw new Error('Expected replacement');
  assert.equal(f.sqlite.prepare('SELECT revoked_at FROM device_credentials WHERE id=?').get(old.credentialId)!.revoked_at,now);
  const fresh=await redeemDeviceEnrollment(f.db,{secret:second.body.result.secret,bridgeVersion:'0.1.0'},{now,verifiedIngress:{serviceIdentity:'synthetic-private-ingress'}});
  const request=(token:string)=>new Request('https://synthetic.invalid/api/device',{headers:{'X-Control-Room-Device':token}});
  assert.equal(await authenticateDevice(request(old.deviceCredential),'telemetry:write',f.db,ingress,now),null);
  assert.equal(await authenticateDevice(request(fresh.deviceCredential),'telemetry:write',f.db,ingress,now),null);
  assert.ok(await authenticateDevice(request(fresh.deviceCredential),'jobs:report',f.db,ingress,now));
  assert.equal(f.sqlite.prepare('SELECT execution_epoch FROM device_runtime').get()!.execution_epoch,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM devices').get()!.n,1);
 }finally{f.sqlite.close();}
});
