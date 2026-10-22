import {z} from 'zod';
/** Read-only owner projection of the personal PC connector (`GET /api/personal-repositories`).
 * The dashboard only displays this state; it never enqueues or claims work from here. Extra
 * fields are tolerated so the companion feature can evolve without breaking the overview. */
const stamp=z.string().min(1).max(64).refine(value=>Number.isFinite(Date.parse(value)),'Invalid timestamp.');
const providerStateSchema=z.object({ready:z.boolean(),detail:z.enum(['ready','not_installed','auth_required','unavailable'])}).passthrough();
export const personalConnectorJobSchema=z.object({
 id:z.string().min(1).max(64),kind:z.enum(['browse','analyze','cancel','ack']).or(z.string().min(1).max(32)),status:z.enum(['queued','claimed','completed','failed','cancelled']),
 createdAt:stamp,claimedAt:stamp.nullable().optional(),completedAt:stamp.nullable().optional(),expiresAt:stamp.optional(),
 projectId:z.string().min(1).max(128).optional(),repositoryKey:z.string().min(1).max(128).optional(),provider:z.enum(['codex','claude']).optional(),requestedModel:z.string().max(128).optional(),
}).passthrough();
export const personalConnectorViewSchema=z.object({
 configured:z.literal(true),deviceId:z.string().min(1).max(128),connected:z.boolean(),online:z.boolean(),lastSeenAt:stamp.nullable(),
 providers:z.object({codex:providerStateSchema,claude:providerStateSchema}).passthrough(),
 repositories:z.array(z.object({key:z.string().min(1).max(128),name:z.string().min(1).max(100),head:z.string().min(1).max(64),dirty:z.boolean(),hasPreviousAnalysis:z.boolean()}).passthrough()).max(16),
 jobs:z.array(personalConnectorJobSchema).max(20),
}).passthrough();
export type PersonalConnectorView=z.infer<typeof personalConnectorViewSchema>;
export type PersonalConnectorJob=z.infer<typeof personalConnectorJobSchema>;
export const unconfiguredConnectorSchema=z.object({configured:z.literal(false)}).passthrough();
