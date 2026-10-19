export const WORKSPACE_STREAM_LIMITS=Object.freeze({connectionMs:20000,pollMs:2000,eventBytes:8192,connectionBytes:65536,cursorBytes:256});
export interface WorkspaceStreamNotice {workspaceRevision:number;operationalWatermarksHash:string}
function shape(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
export function parseWorkspaceStreamNotice(value:unknown):WorkspaceStreamNotice{
 if(!shape(value,['workspaceRevision','operationalWatermarksHash'])||typeof value.workspaceRevision!=='number'||!Number.isSafeInteger(value.workspaceRevision)||value.workspaceRevision<1||typeof value.operationalWatermarksHash!=='string'||!/^[a-f0-9]{64}$/u.test(value.operationalWatermarksHash))throw new Error('Invalid workspace stream notice.');
 return {workspaceRevision:value.workspaceRevision,operationalWatermarksHash:value.operationalWatermarksHash};
}
/** Opaque change cursor only; it is never an owner identity, grant or history offset. */
export function workspaceStreamCursor(value:WorkspaceStreamNotice):string{const notice=parseWorkspaceStreamNotice(value);return 'w1.'+notice.workspaceRevision+'.'+notice.operationalWatermarksHash;}
export function parseWorkspaceStreamCursor(value:unknown):WorkspaceStreamNotice{
 if(typeof value!=='string'||value.length>WORKSPACE_STREAM_LIMITS.cursorBytes)throw new Error('Invalid workspace stream cursor.');
 const match=/^w1\.([1-9][0-9]{0,15})\.([a-f0-9]{64})$/u.exec(value);if(!match)throw new Error('Invalid workspace stream cursor.');
 return parseWorkspaceStreamNotice({workspaceRevision:Number(match[1]),operationalWatermarksHash:match[2]});
}
