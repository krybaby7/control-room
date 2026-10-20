import type {EvidenceSnapshot} from './evidence-store.ts';
import type {EvidenceVersion,DecisionVersion,VersionedRecordHead} from './evidence-contract.ts';
import type {HistoryEntry} from './history.ts';

/** A citation names data only. Parsing never asserts that the current owner can read it. */
export type ReviewTarget={kind:'evidence'|'decision';id:string;version:number}|{kind:'history';id:string};
export type ParsedReviewLink={status:'valid';target:ReviewTarget}|{status:'unavailable'};
const unavailable={status:'unavailable'} as const;
const malformedUnicode=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function validId(id:unknown):id is string{return typeof id==='string'&&id.length>0&&id.length<=128&&id.trim().length>0&&!/[\u0000-\u001f\u007f]/u.test(id)&&!malformedUnicode.test(id);}
function validVersion(version:unknown):version is number{return typeof version==='number'&&Number.isSafeInteger(version)&&version>0;}
function validTarget(target:unknown):target is ReviewTarget{
 if(!target||typeof target!=='object'||Array.isArray(target))return false;const value=target as Record<string,unknown>,history=value.kind==='history';
 if(!['evidence','decision','history'].includes(String(value.kind))||!validId(value.id))return false;
 const keys=history?['kind','id']:['kind','id','version'];return Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key))&&(history||validVersion(value.version));
}
/** Always an application-local root URL; logical IDs are encoded without truncating or rewriting them. */
export function reviewHref(target:ReviewTarget):string{
 if(!validTarget(target))throw new Error('Invalid review citation target.');const params=new URLSearchParams({view:target.kind==='history'?'history':'evidence',review:target.kind,id:target.id});if(target.kind!=='history')params.set('version',String(target.version));return `/?${params}`;
}
/** Absolute copied links require the caller's trusted application origin. No redirect URL is returned. */
export function parseReviewLink(input:string|URLSearchParams,options:{origin?:string}={}):ParsedReviewLink{
 try{
  let params:URLSearchParams;
  if(input instanceof URLSearchParams){if(input.toString().length>2048)return unavailable;params=new URLSearchParams(input);}
  else {
   if(typeof input!=='string'||input.length>4096||input!==input.trim()||/[\u0000-\u001f\u007f]/u.test(input)||malformedUnicode.test(input)||input.includes('#')||/%(?![a-f0-9]{2})/i.test(input))return unavailable;
   decodeURIComponent(input); // Reject invalid UTF-8 encodings before URLSearchParams can replace them.
   let origin='https://review.invalid';if(options.origin){const trusted=new URL(options.origin);if(!['http:','https:'].includes(trusted.protocol)||trusted.username||trusted.password||trusted.pathname!=='/'||trusted.search||trusted.hash)return unavailable;origin=trusted.origin;}
   const relative=input.startsWith('?')||input.startsWith('/?');if(!relative&&!options.origin)return unavailable;if(input.startsWith('//'))return unavailable;
   const url=new URL(input,origin);if(url.origin!==origin||url.pathname!=='/'||url.username||url.password||url.hash)return unavailable;params=url.searchParams;
  }
  const kind=params.get('review');if(kind!=='evidence'&&kind!=='decision'&&kind!=='history')return unavailable;const keys=kind==='history'?['view','review','id']:['view','review','id','version'];if([...params.keys()].some(key=>!keys.includes(key))||keys.some(key=>params.getAll(key).length!==1))return unavailable;
  if(params.get('view')!==(kind==='history'?'history':'evidence'))return unavailable;const id=params.get('id');if(!validId(id))return unavailable;if(kind==='history')return {status:'valid',target:{kind,id}};
  const raw=params.get('version')!;if(!/^[1-9][0-9]{0,15}$/.test(raw))return unavailable;const version=Number(raw);if(!validVersion(version))return unavailable;return {status:'valid',target:{kind,id,version}};
 }catch{return unavailable;}
}
export type ReviewSnapshot=Pick<EvidenceSnapshot,'evidenceHeads'|'evidenceVersions'|'decisionHeads'|'decisionVersions'>;
export type ResolvedReviewTarget=
 |{status:'available';target:Extract<ReviewTarget,{kind:'evidence'|'decision'}>;record:EvidenceVersion|DecisionVersion;head:VersionedRecordHead;historical:boolean;archived:boolean}
 |{status:'available';target:Extract<ReviewTarget,{kind:'history'}>;record:HistoryEntry}
 |{status:'unavailable'};
/** Supply only snapshots/entries obtained through an authenticated owner-scoped read.
 * Missing, foreign, ambiguous and unavailable exact versions share one neutral result.
 * A missing event in a supplied history page may simply require an exact owner-scoped server lookup.
 */
export function resolveReviewTarget(target:ReviewTarget,snapshot:ReviewSnapshot|null,history:readonly HistoryEntry[]=[]):ResolvedReviewTarget{
 if(!validTarget(target))return unavailable;
 if(target.kind==='history'){const matches=history.filter(row=>row.id===target.id);return matches.length===1?{status:'available',target,record:matches[0]}:unavailable;}
 if(!snapshot)return unavailable;const heads=(target.kind==='evidence'?snapshot.evidenceHeads:snapshot.decisionHeads).filter(row=>row.id===target.id),versions=(target.kind==='evidence'?snapshot.evidenceVersions:snapshot.decisionVersions).filter(row=>row.id===target.id&&row.version===target.version);
 if(heads.length!==1||versions.length!==1||!validVersion(heads[0].currentVersion)||heads[0].currentVersion<target.version)return unavailable;return {status:'available',target,record:versions[0],head:heads[0],historical:target.version!==heads[0].currentVersion,archived:heads[0].archivedAt!==null};
}
