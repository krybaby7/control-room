/** Portable labels are context, never enrollment or execution authority. */
export interface DeviceDisplay {id:string;label:string;createdAt:string;archivedAt:string|null}
export type DeviceScope='telemetry:write'|'evaluations:write'|'jobs:poll'|'jobs:report';
export interface DevicePrincipal {ownerId:string;deviceId:string;credentialId:string;scopes:readonly DeviceScope[]}
/** Platform-specific verification is separate from application device identity. */
export interface PrivateIngressVerifier {verify(request:Request):Promise<{serviceIdentity:string}|null>}
export const unavailablePrivateIngress:PrivateIngressVerifier={async verify(){return null;}};
export interface DeviceSession {deviceId:string;bootId:string;generation:number;bridgeVersion:string;createdAt:string}
export interface DeviceLiveWindow {windowId:string;bootId:string;generation:number;sequence:number;issuedAt:string;expiresAt:string}
export const DEVICE_LIMITS=Object.freeze({devices:20,enrollments:20,enrollmentMs:600000,credentialMs:30*86400000,rotationOverlapMs:300000,sessions:256,liveWindowMs:30000,requestBytes:65536,requestMs:15000,minHeartbeatMs:10000});
