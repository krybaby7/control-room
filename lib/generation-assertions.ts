import type {SqlDatabase,SqlStatement} from './workspace-store.ts';
import type {RecoverabilityCondition} from './recoverability-admission.ts';
type Input={cte:string;cteBindings:(string|number|null)[];owner:string;mutationId:string;claim:string;guard:(string|number|null)[];conditions:RecoverabilityCondition[];stagedNamespace?:RecoverabilityCondition};
/** Only the two adjacent generation proofs and, without intervening backup
 * assertions, the next namespace proof share this post-write claim. Their one
 * MATERIALIZED generation relation retains the original per-predicate meaning.
 * Unsupported framing falls back before preparing SQL, never after DB failure. */
export function compileGenerationAssertions(input:Input):RecoverabilityCondition[]{
 const {cte,cteBindings,owner,mutationId,claim,guard,conditions,stagedNamespace}=input;
 if(conditions.length!==2)throw new Error('Generation proof requires two ordered predicates.');
 const selected=stagedNamespace?[...conditions,stagedNamespace]:conditions;
 const assertion=(condition:string)=>`INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${condition} THEN 1 ELSE 0 END WHERE ${claim}`;
 const combined={sql:`${cte} ${assertion(selected.map(condition=>`(${condition.sql})`).join(' AND '))}`,bindings:[...cteBindings,owner,mutationId,...selected.flatMap(condition=>condition.bindings),...guard]};
 if(combined.bindings.length<=100&&new TextEncoder().encode(combined.sql).length<=100000&&new TextEncoder().encode(JSON.stringify(combined.bindings)).length<=1800000)return [combined];
 return [...conditions.map(condition=>({sql:`${cte} ${assertion(condition.sql)}`,bindings:[...cteBindings,owner,mutationId,...condition.bindings,...guard]})),...(stagedNamespace?[{sql:assertion(stagedNamespace.sql),bindings:[owner,mutationId,...stagedNamespace.bindings,...guard]}]:[])];
}
export function generationAssertionStatements(db:SqlDatabase,input:Input):SqlStatement[]{return compileGenerationAssertions(input).map(condition=>db.prepare(condition.sql).bind(...condition.bindings));}
