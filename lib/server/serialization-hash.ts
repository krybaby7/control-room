import {createHash} from 'node:crypto';
import {createSerializationHashContext,type SerializationHashContext} from '../serialization-hash.ts';
import {bindServerSerializationDigest} from '../internal/serialization-hash-state.ts';
export const SERVER_SERIALIZATION_SHA_BYTES=65536;
/** Fixed genuine SHA-256 implementation, available only to trusted server code.
 * No caller callback, algorithm, module path or serialized backend is accepted. */
function nativeSmallStringSHA(utf8:Uint8Array):string{
 if(!(utf8 instanceof Uint8Array)||utf8.byteLength>SERVER_SERIALIZATION_SHA_BYTES)throw new Error('Server serialization UTF8 bound exceeded.');
 return createHash('sha256').update(utf8).digest('hex');
}
export function createServerSerializationHashContext():SerializationHashContext{
 if(arguments.length)throw new Error('Server serialization context accepts no options.');
 const context=createSerializationHashContext();bindServerSerializationDigest(context,nativeSmallStringSHA);return context;
}
