import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {DEVICE_LIMITS} from '../devices/contracts.ts';
import {deviceIdSchema,deviceDisplaySchema} from '../devices/validation.ts';
import {readCurrent,type SqlDatabase,type SqlStatement} from '../workspace-store.ts';
import type {MutationPlan} from '../workspace-transaction.ts';
import {RUNTIME_LIMITS} from './contracts.ts';
import {enrollmentMaterialSchema} from './commands.ts';
import {runtimeAdapterConfigurationSchema,runtimeObservationSchema,selectedRuntimeEvidenceSchema,heartbeatReceiptSchema} from './validation.ts';
const controlsSchema=z.object({enrollment:enrollmentMaterialSchema.optional(),revokeIds:z.array(deviceIdSchema).max(1).optional(),evidenceProofs:z.array(z.unknown()).max(1).optional()}).strict();
const kinds=new Set(['devices.enrollment.create','devices.revoke','runtime.adapter.configure','runtime.evidence.select']);
/** Closed statements run only under the shared compiler's transient claim, after
 * portable row writes. They never publish credentials or rewrite planning.
 */
export async function deviceControlStatements(db:SqlDatabase,userId:string,plan:MutationPlan,commandType:string,claim:string,guard:(string|number|null)[],now:string):Promise<SqlStatement[]>{
 if(!userId)throw new Error('An authenticated owner is required.');evidenceDateSchema.parse(now);
 if(!kinds.has(commandType)){if(plan.deviceControls)throw new Error('Device authority requires its explicit owner command.');return [];}
 if(plan.restoreEpoch||plan.jobs.length||plan.replacements?.length||plan.integrationJobs?.length||plan.reviewJobs?.length)throw new Error('Device commands cannot restore or schedule work.');
 if(canonical((await readCurrent(db,userId,now)).workspace)!==canonical(plan.planningAfter))throw new Error('Device commands cannot alter planning.');
 const controls=controlsSchema.parse(plan.deviceControls??{}),statements:SqlStatement[]=[];
 const assertion=(label:string,condition:string,bindings:(string|number|null)[])=>{
  statements.push(db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+condition+' THEN 1 ELSE 0 END WHERE '+claim).bind(userId,label,...bindings,...guard));
  statements.push(db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=? AND '+claim).bind(userId,label,...guard));
 };
 const epoch='COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)';
 const invalidate=(id:string,reenroll:boolean)=>{
  for(const table of ['device_credentials','device_enrollments'])statements.push(db.prepare('UPDATE '+table+' SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND device_id=? AND '+claim).bind(now,userId,id,...guard));
  statements.push(db.prepare('UPDATE device_sessions SET retired_at=? WHERE user_id=? AND device_id=? AND retired_at IS NULL AND '+claim).bind(now,userId,id,...guard));
  statements.push(db.prepare('UPDATE device_live_windows SET consumed_at=?,expires_at=MIN(expires_at,?) WHERE user_id=? AND device_id=? AND consumed_at IS NULL AND julianday(expires_at)>julianday(?) AND '+claim).bind(now,now,userId,id,now,...guard));
  assertion('device-generation-'+id,'NOT EXISTS(SELECT 1 FROM device_runtime WHERE user_id=? AND device_id=? AND (current_generation>=9007199254740991 OR operational_revision>=9007199254740991))',[userId,id]);
  statements.push(db.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation,current_boot_id,last_live_received_at,revoked_at,last_request_at) SELECT ?,?,1,'+epoch+',1,NULL,NULL,?,NULL WHERE '+claim+' ON CONFLICT(user_id,device_id) DO UPDATE SET operational_revision=device_runtime.operational_revision+1,execution_epoch=excluded.execution_epoch,current_generation=device_runtime.current_generation+1,current_boot_id=NULL,last_live_received_at=NULL,revoked_at=excluded.revoked_at,last_request_at=NULL').bind(userId,id,userId,reenroll?null:now,...guard));
 };
 const devicePresent=(id:string)=>assertion('device-present-'+id,'EXISTS(SELECT 1 FROM devices WHERE user_id=? AND id=? AND archived_at IS NULL)',[userId,id]);
 if(commandType==='devices.enrollment.create'){
  if(!controls.enrollment||controls.revokeIds||controls.evidenceProofs)throw new Error('Enrollment requires exact server material only.');
  const material=controls.enrollment;if(Date.parse(material.expiresAt)<=Date.parse(now)||Date.parse(material.expiresAt)-Date.parse(now)>DEVICE_LIMITS.enrollmentMs)throw new Error('Enrollment expired.');
  if(plan.writes.length>1)throw new Error('Enrollment cannot modify unrelated records.');
  if(plan.writes.length){const write=plan.writes[0];if(write.table!=='devices'||write.id!==material.deviceId||write.operation!=='insert'||write.expectedRowRevision!==null)throw new Error('Enrollment requires a new exact display identity.');const display=deviceDisplaySchema.parse(write.value);if(display.id!==material.deviceId||display.createdAt!==now||display.archivedAt!==null)throw new Error('Device display identity differs.');}
  else if(!plan.preconditions?.some(row=>row.table==='devices'&&row.id===material.deviceId&&row.expectedHash))throw new Error('Re-enrollment requires the existing exact owner display.');
  // Secret material is private compiler input, never an immutable portable event.
  if(plan.events.some(event=>canonical(event).includes(material.secretHash)))throw new Error('Enrollment material cannot enter audit history.');
  devicePresent(material.deviceId);assertion('device-capacity-'+material.deviceId,'(SELECT COUNT(*) FROM devices WHERE user_id=?)<=?',[userId,DEVICE_LIMITS.devices]);
  invalidate(material.deviceId,true);
  assertion('device-enrollment-capacity-'+material.id,'(SELECT COUNT(*) FROM device_enrollments WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND julianday(expires_at)>julianday(?))<?',[userId,now,DEVICE_LIMITS.enrollments]);
  statements.push(db.prepare('INSERT INTO device_enrollments(user_id,id,device_id,secret_hash,scopes_json,execution_epoch,created_at,expires_at,consumed_at,revoked_at) SELECT ?,?,?,?,?,'+epoch+',?,?,NULL,NULL WHERE '+claim).bind(userId,material.id,material.deviceId,material.secretHash,canonical(material.scopes),userId,now,material.expiresAt,...guard));
 }else if(commandType==='devices.revoke'){
  if(controls.enrollment||controls.evidenceProofs||controls.revokeIds?.length!==1||plan.writes.length)throw new Error('Revocation cannot modify unrelated records.');
  const id=controls.revokeIds[0];if(!plan.preconditions?.some(row=>row.table==='devices'&&row.id===id&&row.expectedHash))throw new Error('Revocation requires the exact owner display.');devicePresent(id);invalidate(id,false);
 }else if(commandType==='runtime.adapter.configure'){
  if(controls.enrollment||controls.revokeIds||controls.evidenceProofs||plan.writes.length!==1)throw new Error('Configuration cannot grant device authority.');
  const write=plan.writes[0];if(write.table!=='runtime_adapter_configurations'||!['insert','update'].includes(write.operation))throw new Error('An exact adapter write is required.');
  const value=runtimeAdapterConfigurationSchema.parse(write.value);if(value.id!==write.id||value.manifest.endpointAlias!==value.manifest.id)throw new Error('The fixed adapter identity differs.');
  if(value.manifest.enabled&&canonical([...value.manifest.capabilities].sort())!==canonical(['read.health','read.summary']))throw new Error('Enabled telemetry must remain read-only.');
  devicePresent(value.deviceId);assertion('runtime-adapter-capacity-'+write.id,'(SELECT COUNT(*) FROM runtime_adapter_configurations WHERE user_id=?)<=?',[userId,RUNTIME_LIMITS.adapterConfigurations]);
 }else{
  if(controls.enrollment||controls.revokeIds||controls.evidenceProofs?.length!==1||plan.writes.length!==1)throw new Error('Evidence requires one exact frozen observation.');
  const write=plan.writes[0];if(write.table!=='runtime_evidence'||write.operation!=='insert'||write.expectedRowRevision!==null)throw new Error('Evidence must append one immutable frozen record.');
  const value=selectedRuntimeEvidenceSchema.parse(write.value),{id:ignoredId,origin:ignoredOrigin,...proof}=value;void ignoredId;void ignoredOrigin;
  if(value.id!==write.id||value.origin!=='native-device'||value.source!=='pc-command-center'||canonical(proof)!==canonical(controls.evidenceProofs[0])||await contentHash(canonical(runtimeObservationSchema.parse(value.observation)))!==value.payloadHash)throw new Error('Frozen evidence proof differs.');
  const latest=await db.prepare('SELECT payload_json,payload_hash,receipt_json,boot_id,generation,sequence FROM runtime_latest WHERE user_id=? AND device_id=? AND source=? AND instance_id=?').bind(userId,value.deviceId,value.source,value.instanceId).first<{payload_json:string;payload_hash:string;receipt_json:string;boot_id:string;generation:number;sequence:number}>();
  if(!latest)throw new Error('The selected runtime observation is unavailable.');
  const receipt=heartbeatReceiptSchema.parse(JSON.parse(latest.receipt_json));
  if(latest.payload_hash!==value.payloadHash||canonical(JSON.parse(latest.payload_json))!==canonical(value.observation)||receipt.heartbeatHash!==value.heartbeatRef.hash||receipt.bootId!==value.heartbeatRef.bootId||receipt.generation!==value.heartbeatRef.generation||receipt.sequence!==value.heartbeatRef.sequence||receipt.receivedAt!==value.receivedAt||latest.boot_id!==receipt.bootId||latest.generation!==receipt.generation||latest.sequence!==receipt.sequence)throw new Error('The reviewed runtime receipt changed.');
  devicePresent(value.deviceId);
  assertion('runtime-evidence-proof-'+write.id,'EXISTS(SELECT 1 FROM runtime_latest WHERE user_id=? AND device_id=? AND source=? AND instance_id=? AND payload_hash=? AND payload_json=? AND receipt_json=? AND boot_id=? AND generation=? AND sequence=?)',[userId,value.deviceId,value.source,value.instanceId,latest.payload_hash,latest.payload_json,latest.receipt_json,latest.boot_id,latest.generation,latest.sequence]);
  assertion('runtime-evidence-capacity-'+write.id,'(SELECT COUNT(*) FROM runtime_evidence WHERE user_id=?)<=?',[userId,RUNTIME_LIMITS.selectedEvidence]);
 }
 return statements;
}
