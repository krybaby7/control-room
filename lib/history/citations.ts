import type {Citation,MessageRevision} from './contracts.ts';
import {CitationSchema,MessageRevisionSchema} from './validation.ts';
import {contentHash} from '../canonical-json.ts';
export interface ImmutableMessageBody{ownerId:string;sourceId:string;message:MessageRevision;text:string;requiredContentAvailable:boolean}
export interface VerifiedCitation{citation:Citation;text:string;role:MessageRevision['role'];sourceId:string;conversationId:string}
export async function resolveCitation(ownerId:string,citation:Citation,body:ImmutableMessageBody):Promise<VerifiedCitation>{
 CitationSchema.parse(citation);const message=MessageRevisionSchema.parse(body.message);
 if(!ownerId||body.ownerId!==ownerId||!body.requiredContentAvailable||message.availability!=='complete'||message.id!==citation.messageRevisionId||message.revisionDigest!==citation.revisionDigest)throw Error('Citation source is foreign or unavailable.');
 const bytes=new TextEncoder().encode(body.text);
 if(bytes.length!==message.contentBytes||await contentHash(bytes)!==message.revisionDigest)throw Error('Immutable citation body digest or length differs.');
 const points=Array.from(body.text);if(citation.end>points.length)throw Error('Citation exceeds immutable Unicode text.');
 return {citation:{...citation},text:points.slice(citation.start,citation.end).join(''),role:message.role,sourceId:body.sourceId,conversationId:message.conversationId};
}
