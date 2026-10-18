import {createHash} from 'node:crypto';
import {canonicalJson,timestamp} from '../src/config.mjs';
export class ExecutorError extends Error{constructor(code){super(code);this.name='ExecutorError';this.code=code;}}
export const fail=code=>{throw new ExecutorError(code);};
export function shape(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail('invalid_shape');return value;}
export function id(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))fail('invalid_identity');return value;}
export function alias(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value))fail('invalid_alias');return value;}
export function digest(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/u.test(value))fail('invalid_digest');return value;}
export function integer(value,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||value<min||value>max)fail('invalid_bound');return value;}
export function bool(value){if(typeof value!=='boolean')fail('invalid_boolean');return value;}
export function choice(value,values){if(!values.includes(value))fail('invalid_value');return value;}
export function list(value,parse,max=100,min=0){if(!Array.isArray(value)||value.length<min||value.length>max)fail('invalid_list');return value.map(parse);}
export const stamp=value=>timestamp(value);
export const canonical=value=>canonicalJson(value);
export const sha=value=>createHash('sha256').update(canonical(value)).digest('hex');
export const bytes=value=>Buffer.byteLength(canonical(value),'utf8');

export function model(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(value))fail('invalid_model');return value;}
export const DIAGNOSTICS=Object.freeze(['ok','not_installed','capability_stale','policy_blocked','auth_required','quota_exhausted','model_mismatch','timeout','cancel_requested','exit_unconfirmed','artifact_invalid','transport_unavailable','unknown']);

export function fileKey(value){id(value);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)||/[. ]$/u.test(value)||value.includes('..')||/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?$/iu.test(value))fail('unsafe_file_identity');return value;}
