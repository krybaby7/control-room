import {serializationHash,type SerializationHashContext} from './serialization-hash.ts';
/** The logical ID remains inside the version; bounded storage keys never truncate it. */
export async function versionRowId(id:string,version:number,serializationHashContext?:SerializationHashContext):Promise<string>{
 if(!id||id.length>128||id.trim()!==id||!Number.isSafeInteger(version)||version<1)throw new Error('A valid record and version are required.');
 return `v:${await serializationHash(id,serializationHashContext)}:${version}`;
}
export async function portableHeadId(id:string,serializationHashContext?:SerializationHashContext):Promise<string>{
 if(!id||id.length>128||id.trim()!==id)throw new Error('A valid record is required.');
 return `h:${await serializationHash(id,serializationHashContext)}`;
}
