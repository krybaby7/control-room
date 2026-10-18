import {contentHash} from './canonical-json.ts';
/** The logical ID remains inside the version; bounded storage keys never truncate it. */
export async function versionRowId(id:string,version:number):Promise<string>{
 if(!id||id.length>128||id.trim()!==id||!Number.isSafeInteger(version)||version<1)throw new Error('A valid record and version are required.');
 return `v:${await contentHash(id)}:${version}`;
}
export async function portableHeadId(id:string):Promise<string>{
 if(!id||id.length>128||id.trim()!==id)throw new Error('A valid record is required.');
 return `h:${await contentHash(id)}`;
}
