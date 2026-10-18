import {z} from 'zod';
import {evidenceDateSchema as stamp,evidenceIdSchema} from '../evidence-validation.ts';
import {DEVICE_LIMITS} from './contracts.ts';
export const deviceIdSchema=evidenceIdSchema.refine(v=>!/[\u0000-\u001f\u007f]/u.test(v));
export const opaqueRuntimeAliasSchema=z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
export const bridgeVersionSchema=z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u);
export const deviceScopeSchema=z.enum(['telemetry:write','evaluations:write','jobs:poll','jobs:report']);
/** Enrollment grants one closed purpose; broader principals are never inferred. */
export const deviceEnrollmentScopesSchema=z.union([
 z.tuple([z.literal('telemetry:write')]),
 z.tuple([z.literal('jobs:poll'),z.literal('jobs:report')]),
 z.tuple([z.literal('evaluations:write')])
]);
export type DeviceEnrollmentScopes=readonly ['telemetry:write']|readonly ['jobs:poll','jobs:report']|readonly ['evaluations:write'];
export interface GenericDeviceEnrollmentInput {label:string;deviceId?:string;scopes:DeviceEnrollmentScopes}
const generation=z.number().int().positive().safe(),sequence=z.number().int().nonnegative().safe();
export const deviceDisplaySchema=z.object({id:deviceIdSchema,label:z.string().min(1).max(200).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/u.test(v)),createdAt:stamp,archivedAt:stamp.nullable()}).strict();
export const devicePrincipalSchema=z.object({ownerId:z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/u.test(v)),deviceId:deviceIdSchema,credentialId:deviceIdSchema,scopes:z.array(deviceScopeSchema).min(1).max(4).refine(v=>new Set(v).size===v.length)}).strict();
export const enrollmentInputSchema=z.object({label:deviceDisplaySchema.shape.label,scopes:deviceEnrollmentScopesSchema}).strict();
export const deviceSessionInputSchema=z.object({bootId:z.string().uuid(),bridgeVersion:bridgeVersionSchema}).strict();
export const deviceSessionSchema=deviceSessionInputSchema.extend({deviceId:deviceIdSchema,generation,createdAt:stamp}).strict();
export const deviceLiveWindowInputSchema=z.object({bootId:z.string().uuid(),generation,sequence}).strict();
export const deviceLiveWindowSchema=deviceLiveWindowInputSchema.extend({windowId:z.string().uuid(),issuedAt:stamp,expiresAt:stamp}).strict().refine(v=>{const ms=Date.parse(v.expiresAt)-Date.parse(v.issuedAt);return ms>0&&ms<=DEVICE_LIMITS.liveWindowMs;},'Live windows expire within thirty seconds.');
