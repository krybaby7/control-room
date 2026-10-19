import type {SqlDatabase} from './workspace-store.ts';
/** Minimal receipts are never silently removed to make room. Owner exports remain readable. */
export const RECEIPT_CAPACITY=Object.freeze({soft:75_000,hard:100_000});
export class WorkspaceCapacityError extends Error {
 readonly code='receipt_capacity';
 constructor(){super('Receipt capacity is full. Export your workspace and use guarded retired-epoch maintenance or arrange additional storage before making another change. Existing receipts and records are retained.');this.name='WorkspaceCapacityError';}
}
export async function receiptCount(db:SqlDatabase,userId:string):Promise<number>{
 if(!userId)throw new Error('Authenticated owner required.');
 const row=await db.prepare('SELECT COUNT(*) AS count FROM workspace_mutations WHERE user_id=?').bind(userId).first<{count:number}>();
 if(!row||!Number.isSafeInteger(row.count)||row.count<0)throw new Error('Receipt usage is unavailable.');return row.count;
}
