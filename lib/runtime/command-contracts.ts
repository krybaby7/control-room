import type {RuntimeSource,SelectedRuntimeEvidence} from './contracts.ts';
export interface DeviceEnrollmentMaterial {id:string;deviceId:string;secretHash:string;expiresAt:string;scopes:readonly ['telemetry:write']}
export interface DeviceRuntimeContext {enrollment?:DeviceEnrollmentMaterial;latest:(input:{deviceId:string;source:RuntimeSource;instanceId:string})=>Promise<Omit<SelectedRuntimeEvidence,'id'|'origin'>|null>}
export interface DeviceRuntimeControls {enrollment?:DeviceEnrollmentMaterial;revokeIds?:string[];evidenceProofs?:Array<Omit<SelectedRuntimeEvidence,'id'|'origin'>>}
