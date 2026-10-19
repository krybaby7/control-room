/** INTERNAL trusted-code seam. Not a public configuration API or request input.
 * Context provenance stays in this WeakMap; a JSON object cannot select a hasher.
 * Only the server factory binds its fixed implementation, before any use. */
export type SerializationState={closed:boolean;used:boolean;bytes:number;entries:Map<string,{promise:Promise<string>;bytes:number}>;serverDigest?:((utf8:Uint8Array)=>string)};
const states=new WeakMap<object,SerializationState>();
export function initializeSerializationState(context:object):void{if(states.has(context))throw new Error('Serialization context already exists.');states.set(context,{closed:false,used:false,bytes:0,entries:new Map()});}
export function serializationState(context:object):SerializationState|undefined{return states.get(context);}
export function bindServerSerializationDigest(context:object,digest:(utf8:Uint8Array)=>string):void{
 const state=states.get(context);if(!state||state.closed||state.used||state.serverDigest||typeof digest!=='function')throw new Error('Invalid server serialization capability.');
 state.serverDigest=digest;
}
