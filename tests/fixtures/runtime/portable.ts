import {canonical,contentHash} from '../../../lib/canonical-json.ts';
import type {DeviceDisplay} from '../../../lib/devices/contracts.ts';
import type {RuntimeAdapterConfiguration,SelectedRuntimeEvidence,RuntimeObservationV1} from '../../../lib/runtime/contracts.ts';
import type {ImportContext} from '../../../lib/workspace-export.ts';
import {workspaceFixture} from '../../helpers/workspace.ts';
export const runtimePortableNow='2026-10-18T12:00:00.000Z';
export async function portableRuntimeRow<T extends {id:string}>(value:T){return {id:value.id,rowRevision:1,contentHash:await contentHash(canonical(value)),value};}
/** Synthetic selected evidence; no hardware, service, session or provider queried. */
export async function runtimePortableFixture(){
 const now=runtimePortableNow,device:DeviceDisplay={id:'synthetic-device',label:'Synthetic selected PC',createdAt:now,archivedAt:null};
 const configuration:RuntimeAdapterConfiguration={id:'synthetic-adapter',deviceId:device.id,projectId:'p1',manifest:{id:'pc-command-center',version:1,enabled:true,capabilities:['read.health','read.summary'],endpointAlias:'selected-pc'},selectedGpuAlias:null};
 const observation:RuntimeObservationV1={source:'pc-command-center',instanceId:'selected-pc',observedAt:null,reportedAgeSeconds:null,state:'ready',diagnostic:'ok',metrics:{cpuPercent:0,memoryPercent:32,gpuUtilizationPercent:null,gpuMemoryUsedBytes:null,gpuMemoryTotalBytes:null,gpuTemperatureC:null,diskReadBytesPerSec:0,diskWriteBytesPerSec:null,networkSentBytesPerSec:null,networkReceivedBytesPerSec:null}};
 const evidence:SelectedRuntimeEvidence={id:'synthetic-selected-evidence',deviceId:device.id,source:observation.source,instanceId:observation.instanceId,observedAt:null,reportedAgeSeconds:null,receivedAt:now,payloadHash:await contentHash(canonical(observation)),observation,heartbeatRef:{bootId:'00000000-0000-4000-8000-000000000001',generation:7,sequence:41,hash:'b'.repeat(64)},origin:'native-device'};
 const context:ImportContext={planning:workspaceFixture(),modules:{devices:{schemaVersion:1,records:[await portableRuntimeRow(device)]},runtime_adapter_configurations:{schemaVersion:1,records:[await portableRuntimeRow(configuration)]},runtime_evidence:{schemaVersion:1,records:[await portableRuntimeRow(evidence)]}}};
 return {context,device,configuration,observation,evidence};
}
