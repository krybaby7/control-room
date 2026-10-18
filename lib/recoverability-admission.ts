import type {SqlDatabase,SqlStatement} from './workspace-store.ts';
import {canonical} from './canonical-json.ts';
import {reviewBoundary} from './reviews/boundary.ts';
import type {ProspectiveRecoverabilityResult} from './recoverability-snapshot.ts';
export class RecoverabilityCapacityError extends Error {readonly code='recovery_capacity';readonly paused:boolean;constructor(paused=false){super('This change would exceed the verified recovery capacity. Existing records are retained. Export your workspace and configure compatible recovery storage before adding more data.');this.paused=paused;}}
/** Reuse only inside a writer's already-authorized atomic batch. No independent effects. */
export function recoverabilityAssertions(db:SqlDatabase,owner:string,mutationId:string,quote:ProspectiveRecoverabilityResult,gate:string,binds:(string|number|null)[]):SqlStatement[]{
 if(!quote.measurement.allowed)throw new RecoverabilityCapacityError();const boundary=reviewBoundary(owner,quote.boundaryRevision,quote.boundaryWatermarks),conditions=[boundary,...quote.boundaryRows.map(({table,rows})=>({sql:`(SELECT COUNT(*) FROM ${table} WHERE user_id=?)=? AND NOT EXISTS(SELECT id,row_revision,content_hash FROM ${table} WHERE user_id=? EXCEPT SELECT json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.content_hash') FROM json_each(?))`,bindings:[owner,rows.length,owner,canonical(rows)] as (string|number|null)[]}))];
 return conditions.map(condition=>db.prepare(`INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${condition.sql} THEN 1 ELSE 0 END WHERE ${gate}`).bind(owner,mutationId,...condition.bindings,...binds));
}
