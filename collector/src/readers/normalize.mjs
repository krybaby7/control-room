import {createHash} from 'node:crypto';
/** Preserve whitespace and code-point citation positions; normalize only Unicode and line endings. */
export function normalizeText(input){if(typeof input!=='string')throw new TypeError('Expected text.');return input.replace(/\r\n?/gu,'\n').normalize('NFC');}
export function sha256(input){return createHash('sha256').update(input).digest('hex');}
export function stableId(sourceId,...parts){if(typeof sourceId!=='string'||!sourceId||parts.some(value=>typeof value!=='string'||!value))throw new TypeError('Stable history identity requires source and native identity.');return sha256(JSON.stringify([sourceId,...parts]));}
export function codePointLength(text){return Array.from(text).length;}
