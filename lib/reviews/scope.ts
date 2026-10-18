import {canonical,contentHash} from '../canonical-json.ts';
import {reviewScopeSchema} from './validation.ts';
import type {ReviewScope} from './contracts.ts';
/** Shared identity for today's project-only review filter. Stored historical scopes
 * remain immutable; additional filters require a new explicit projection. */
export async function projectReviewScope(projectIds:string[]):Promise<ReviewScope>{const selected=reviewScopeSchema.shape.projectIds.parse(projectIds).toSorted();return {projectIds:selected,filterDigest:await contentHash(canonical(selected))};}
