import {z} from 'zod';
/** Lifecycle only. Database authority, approval and journal verification belong to the caller. */
export type JobStatus='awaiting_approval'|'queued'|'leased'|'running'|'cancelling'|'succeeded'|'failed'|'cancelled'|'blocked'|'reconcile_required'|'rejected';
const statuses=['awaiting_approval','queued','leased','running','cancelling','succeeded','failed','cancelled','blocked','reconcile_required','rejected']as const;
export const jobStatusSchema=z.enum(statuses);
const sequence=z.number().int().positive().safe(),identity=z.string().min(1).max(128).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/u.test(v)),epoch=z.number().int().positive().safe(),model=z.string().min(1).max(200).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f]/u.test(v));
const terminalSchema=z.object({
 kind:z.enum(['terminal','reconciled-terminal']),attemptId:identity,epoch,
 leaseState:z.enum(['current','expired','unknown']),disposition:z.enum(['succeeded','failed','cancelled','blocked']),
 contiguousThrough:sequence,terminalSequence:sequence,
 processExit:z.object({attemptId:identity,epoch,sequence,owned:z.boolean(),confirmed:z.boolean(),exitCode:z.number().int().safe().nullable()}).strict(),
 cancellationAcknowledgedSequence:sequence.nullable(),terminalProtocolSequence:sequence.nullable(),
 terminalProtocolObserved:z.boolean(),terminationUnconfirmed:z.boolean(),adapterChecksPassed:z.boolean(),
 model:z.object({requested:model,observed:model.nullable(),verified:z.boolean(),allowUnverifiedIdentity:z.boolean()}).strict()
}).strict();
export const jobTransitionEvidenceSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('approved')}).strict(),z.object({kind:z.literal('rejected')}).strict(),
 z.object({kind:z.literal('leased'),attemptId:identity,epoch}).strict(),
 z.object({kind:z.literal('started'),attemptId:identity,epoch,leaseState:z.literal('current'),sequence,contiguousThrough:sequence,processOwned:z.literal(true)}).strict(),
 z.object({kind:z.literal('cancel-requested')}).strict(),
 z.object({kind:z.literal('execution-unknown'),reason:z.enum(['lease-expired','missing-heartbeat','termination-unconfirmed','journal-uncertain']),slotRetained:z.literal(true)}).strict(),
 z.object({kind:z.literal('prelaunch-terminal'),proof:z.enum(['no-attempt','journal-no-launch']),leaseState:z.enum(['none','current'])}).strict(),
 z.object({kind:z.literal('reconciled-not-launched'),journalConfirmed:z.literal(true)}).strict(),
 terminalSchema
]);
export type JobTransitionEvidence=z.infer<typeof jobTransitionEvidenceSchema>;
export interface JobTransitionInput {from:JobStatus;to:JobStatus;evidence:JobTransitionEvidence}
const inputSchema=z.object({from:jobStatusSchema,to:jobStatusSchema,evidence:jobTransitionEvidenceSchema}).strict();
const edges:Readonly<Record<JobStatus,readonly JobStatus[]>>={
 awaiting_approval:['queued','rejected','cancelled'],queued:['leased','blocked','cancelled'],
 leased:['running','cancelling','reconcile_required','blocked'],running:['succeeded','failed','blocked','cancelling','reconcile_required'],
 cancelling:['cancelled','succeeded','failed','blocked','reconcile_required'],reconcile_required:['succeeded','failed','cancelled','blocked'],
 succeeded:[],failed:[],cancelled:[],blocked:[],rejected:[]
};
export class JobTransitionError extends Error {readonly status=409;constructor(message:string){super(message);this.name='JobTransitionError';}}
function requireProof(value:unknown,message:string):asserts value{if(!value)throw new JobTransitionError(message);}
/** Accept only a trusted server projection of contiguous, same-attempt evidence.
 * Passing these pure checks grants no lease, process, model, or planning authority.
 * Duplicate receipts are handled before this function; terminal records have no outgoing edges.
 */
export function assertJobTransition(raw:JobTransitionInput):void{
 const parsed=inputSchema.safeParse(raw);requireProof(parsed.success,'Invalid job transition evidence.');const {from,to,evidence:e}=parsed.data;
 requireProof(edges[from].includes(to),'Job transition is not permitted; retries require a new explicitly approved job.');
 if(to==='queued'){requireProof(e.kind==='approved','Queueing requires explicit approval evidence.');return;}
 if(to==='rejected'){requireProof(e.kind==='rejected','Rejection requires an explicit owner decision.');return;}
 if(to==='leased'){requireProof(e.kind==='leased','Leasing requires one admitted attempt.');return;}
 if(to==='running'){requireProof(e.kind==='started'&&e.sequence<=e.contiguousThrough,'Running requires contiguous owned-process start evidence and a current lease.');return;}
 if(to==='cancelling'){requireProof(e.kind==='cancel-requested','Cancelling records an explicit cancellation request, not a stopped process.');return;}
 if(to==='reconcile_required'){requireProof(e.kind==='execution-unknown','Uncertain execution requires reconciliation and retention of its device slot.');return;}
 if(e.kind==='prelaunch-terminal'){
  requireProof((from==='awaiting_approval'||from==='queued')?e.proof==='no-attempt'&&e.leaseState==='none':from==='leased'&&to==='blocked'&&e.proof==='journal-no-launch'&&e.leaseState==='current','Prelaunch termination requires exact proof that no process launched.');return;
 }
 if(e.kind==='reconciled-not-launched'){requireProof(from==='reconcile_required'&&to!=='succeeded','Only explicit journal reconciliation can prove an uncertain attempt never launched.');return;}
 requireProof(e.kind==='terminal'||e.kind==='reconciled-terminal','Terminal status requires ordered process exit evidence.');
 requireProof(e.disposition===to,'Terminal disposition differs from requested status.');
 requireProof(from==='reconcile_required'?e.kind==='reconciled-terminal':e.kind==='terminal'&&e.leaseState==='current','Expired or unknown leases cannot publish terminal status before explicit reconciliation.');
 requireProof(e.processExit.owned&&e.processExit.confirmed&&!e.terminationUnconfirmed,'Only confirmed owned-process exit can release an attempted execution.');
 requireProof(e.processExit.attemptId===e.attemptId&&e.processExit.epoch===e.epoch,'Exit evidence belongs to another attempt or epoch.');
 const ordered=[e.processExit.sequence,...(e.cancellationAcknowledgedSequence===null?[]:[e.cancellationAcknowledgedSequence]),...(e.terminalProtocolSequence===null?[]:[e.terminalProtocolSequence])];
 requireProof(new Set(ordered).size===ordered.length&&ordered.every(s=>s<e.terminalSequence)&&e.terminalSequence<=e.contiguousThrough,'Required evidence must be distinct, contiguous, and precede the terminal event.');
 requireProof(e.terminalProtocolObserved===(e.terminalProtocolSequence!==null),'Terminal protocol evidence and its event sequence disagree.');
 if(e.model.observed!==null&&e.model.observed!==e.model.requested)requireProof(to==='blocked','An emitted different model identity blocks the run; it cannot be accepted or silently substituted.');
 if(to==='cancelled')requireProof(e.cancellationAcknowledgedSequence!==null,'Cancellation requires acknowledgement as well as confirmed exit.');
 if(to==='succeeded'){
  requireProof(e.terminalProtocolObserved&&e.adapterChecksPassed&&e.processExit.exitCode===0,'Success requires terminal protocol, declared adapter checks, and successful confirmed exit.');
  if(e.model.observed===null)requireProof(!e.model.verified&&e.model.allowUnverifiedIdentity,'Missing model identity requires an explicit policy allowing disclosed unverified identity.');
  else requireProof(e.model.observed===e.model.requested&&e.model.verified,'An emitted different or unverified model identity cannot succeed.');
  if(from==='cancelling'||e.cancellationAcknowledgedSequence!==null)requireProof(e.cancellationAcknowledgedSequence!==null&&e.processExit.sequence<e.cancellationAcknowledgedSequence&&e.terminalProtocolSequence!<e.cancellationAcknowledgedSequence,'Cancellation race success requires completion and exit strictly before acknowledgement.');
 }
}
