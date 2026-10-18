'use client';
import {z} from 'zod';
import {DEVICE_LIMITS} from '@/lib/devices/contracts';
import {RUNTIME_LIMITS} from '@/lib/runtime/contracts';
import {deviceDisplaySchema} from '@/lib/devices/validation';
import {runtimeAdapterConfigurationSchema,runtimeObservationSchema,heartbeatReceiptSchema,runtimeSourceSchema} from '@/lib/runtime/validation';
import {evidenceDateSchema,evidenceIdSchema} from '@/lib/evidence-validation';
const revision=z.number().int().positive().safe(),age=z.number().finite().nonnegative().nullable();
const connectivity=z.enum(['online','stale','offline','never-seen','revoked']);
export const runtimeSourceDisplaySchema=z.object({
 configurationId:evidenceIdSchema,source:runtimeSourceSchema,instanceId:z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
 observedAt:evidenceDateSchema.nullable(),receivedAt:evidenceDateSchema.nullable(),lastSuccessfulSampleAt:evidenceDateSchema.nullable(),
 payloadHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),observation:runtimeObservationSchema.nullable(),receipt:heartbeatReceiptSchema.nullable(),
 freshness:z.object({connectivity,source:z.enum(['fresh','stale','unknown','clock-skew','unavailable','disabled']),heartbeatAgeSeconds:age,serverAgeSeconds:age,reportedAgeSeconds:age,effectiveSampleAgeUpperBoundSeconds:age}).strict()
}).strict().superRefine((row,ctx)=>{
 if(row.observation&&(row.observation.source!==row.source||row.observation.instanceId!==row.instanceId||row.observation.observedAt!==row.observedAt))ctx.addIssue({code:'custom',message:'Runtime observation identity differs.'});
 if(row.receipt&&row.receipt.receivedAt!==row.receivedAt)ctx.addIssue({code:'custom',message:'Runtime receipt clock differs.'});
 if((row.observation===null)!==(row.payloadHash===null))ctx.addIssue({code:'custom',message:'Runtime payload identity is unavailable.'});
});
export const runtimeDeviceSchema=z.object({device:deviceDisplaySchema,rowRevision:revision,enrolled:z.boolean(),revoked:z.boolean(),lastLiveReceivedAt:evidenceDateSchema.nullable(),connectivity,sources:z.array(runtimeSourceDisplaySchema).max(RUNTIME_LIMITS.adapterConfigurations)}).strict();
export const runtimeReadSchema=z.object({revision,ingress:z.literal('unverified'),generatedAt:evidenceDateSchema,configurations:z.array(z.object({value:runtimeAdapterConfigurationSchema,rowRevision:revision}).strict()).max(RUNTIME_LIMITS.adapterConfigurations),devices:z.array(runtimeDeviceSchema).max(DEVICE_LIMITS.devices)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.devices.map(row=>row.device.id)).size!==value.devices.length||new Set(value.configurations.map(row=>row.value.id)).size!==value.configurations.length)ctx.addIssue({code:'custom',message:'Duplicate runtime identity.'});
 for(const device of value.devices){if(new Set(device.sources.map(row=>row.source+':'+row.instanceId)).size!==device.sources.length)ctx.addIssue({code:'custom',message:'Duplicate runtime source.'});for(const source of device.sources){if(!value.configurations.some(row=>row.value.id===source.configurationId&&row.value.deviceId===device.device.id&&row.value.manifest.id===source.source))ctx.addIssue({code:'custom',message:'Runtime source configuration differs.'});}}
});
export type RuntimeRead=z.infer<typeof runtimeReadSchema>;
export type RuntimeDevice=z.infer<typeof runtimeDeviceSchema>;
export type RuntimeSourceDisplay=z.infer<typeof runtimeSourceDisplaySchema>;
const metricLabels:Record<string,string>={cpuPercent:'CPU %',memoryPercent:'Memory %',gpuUtilizationPercent:'GPU utilization %',gpuMemoryUsedBytes:'GPU memory used bytes',gpuMemoryTotalBytes:'GPU memory total bytes',gpuTemperatureC:'GPU temperature °C',diskReadBytesPerSec:'Disk read bytes/s',diskWriteBytesPerSec:'Disk write bytes/s',networkSentBytesPerSec:'Network sent bytes/s',networkReceivedBytesPerSec:'Network received bytes/s'};
export function runtimeDeviceLabel(row:RuntimeDevice){return row.revoked?'Revoked':!row.enrolled?'Never enrolled':row.connectivity==='never-seen'?'No live heartbeat received':row.connectivity;}
export function RuntimeCard({row,busy,onConfigure,onRevoke,onReplaceEnrollment,onSelectEvidence}:{row:RuntimeDevice;busy:boolean;onConfigure:()=>void;onRevoke:()=>void;onReplaceEnrollment?:()=>void;onSelectEvidence:(source:RuntimeSourceDisplay)=>void}){
 return <article className="capture-preview" aria-label={'Runtime device '+row.device.label}>
  <h3>{row.device.label}</h3><p>Device state: {runtimeDeviceLabel(row)}</p><p className="field-hint">Device ID {row.device.id} · Device recorded {row.device.createdAt} · Last live heartbeat received: {row.lastLiveReceivedAt??'None recorded'}</p>
  <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy||row.revoked||!!row.device.archivedAt} onClick={onConfigure}>Configure PC adapter</button><button type="button" className="button secondary" disabled={busy||row.revoked||!row.enrolled} onClick={onRevoke}>Revoke device</button>{onReplaceEnrollment&&<button type="button" className="button secondary" disabled={busy||!!row.device.archivedAt} onClick={onReplaceEnrollment}>Replace enrollment</button>}</div>
  {!row.sources.length&&<p>No configured runtime samples. No source availability has been established.</p>}
  {row.sources.map(source=><section key={source.source+':'+source.instanceId} aria-label={source.source+' '+source.instanceId}>
   <h4>{source.source} · {source.instanceId}</h4><p>Source state: {source.freshness.source}{source.observation?' · '+source.observation.state+' · '+source.observation.diagnostic:''}</p>
   <p>Observed: {source.observedAt??'Unknown'} · Received: {source.receivedAt??'None recorded'} · Last successful sample: {source.lastSuccessfulSampleAt??'None recorded'}</p>
   <p className="field-hint">Heartbeat age seconds: {source.freshness.heartbeatAgeSeconds??'Unknown'} · Server sample age seconds: {source.freshness.serverAgeSeconds??'Unknown'} · Reported sample age seconds: {source.freshness.reportedAgeSeconds??'Unknown'} · Sample age upper bound seconds: {source.freshness.effectiveSampleAgeUpperBoundSeconds??'Unknown'}</p>
   {source.receipt&&<p className="field-hint">Original delivery: {source.receipt.classification} · {source.receipt.reason}. A replayed historical sample is not a new live heartbeat.</p>}
   {source.observation?.metrics?<dl>{Object.entries(source.observation.metrics).map(([key,value])=><div key={key}><dt>{metricLabels[key]??key}</dt><dd>{value===null?'Unavailable':value}</dd></div>)}</dl>:<p>Metrics unavailable. Missing values are not zero.</p>}
   <button type="button" className="text-button" disabled={busy||!source.observation||!source.receipt||!source.payloadHash} onClick={()=>onSelectEvidence(source)}>Select exact runtime sample as evidence</button>
   <p className="field-hint">Selecting a sample records contextual evidence only. It does not accept work, run a job, change task status or pin weekly commitments.</p>
  </section>)}
 </article>;
}
