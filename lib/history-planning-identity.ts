import {canonical} from './canonical-json.ts';
import type {AuditEventDraft} from './workspace-protocol.ts';
const collections={project:'projects',milestone:'milestones',task:'tasks',capture:'captures'} as const;
export function planningCreationCollection(entityType:string):string|null{return Object.hasOwn(collections,entityType)?collections[entityType as keyof typeof collections]:null;}
/** Exact contextual identity from a unique typed insertion; never rewrites history. */
export function createdPlanningEntityId(kind:string,entityType:string,changes:AuditEventDraft['changes']):string|null{
 const collection=planningCreationCollection(entityType);if(!collection||kind!==entityType+'.create'||changes.length>2000)return null;
 const inserted=changes.filter(change=>change.path[0]===collection&&!change.before.exists&&change.after.exists);
 if(inserted.length!==1)return null;
 const change=inserted[0],value=change.after.value,identity=change.path[1];
 if(change.path.length!==2||typeof identity!=='string'||identity.length<1||identity.length>128||identity.trim()!==identity||/[\u0000-\u001f\u007f]/u.test(identity)||change.before.value!==null||!value||typeof value!=='object'||Array.isArray(value)||value.id!==identity)return null;
 return identity;
}

const scopedKinds:Record<string,readonly string[]>={project:['create','edit','update','archive','restore'],milestone:['create','update','archive','restore','reorder'],task:['create','update','restore','move','bulk'],capture:['create','update','convert','bulk','bulkConvert']};
export function knownPlanningHistoryKind(entityType:string,kind:string):boolean{return Object.hasOwn(scopedKinds,entityType)&&scopedKinds[entityType].some(action=>kind===entityType+'.'+action);}
/** Bulk actions may match several subjects; a given subject must have one exact
 * full-row change. Duplicate paths, field-only/unknown shapes are not inferred. */
export function changedPlanningEntityId(kind:string,entityType:string,changes:AuditEventDraft['changes'],targetId:string):string|null{
 const collection=planningCreationCollection(entityType);if(!collection||!knownPlanningHistoryKind(entityType,kind)||changes.length>2000)return null;
 const matches=changes.filter(change=>change.path[0]===collection&&change.path[1]===targetId);
 if(matches.length!==1)return null;
 const change=matches[0];if(canonical(change.before)===canonical(change.after))return null;if(change.path.length!==2||targetId.length<1||targetId.length>128||targetId.trim()!==targetId||/[\u0000-\u001f\u007f]/u.test(targetId)||!change.before.exists&&!change.after.exists)return null;
 for(const side of [change.before,change.after])if(side.exists?(!side.value||typeof side.value!=='object'||Array.isArray(side.value)||side.value.id!==targetId):side.value!==null)return null;
 return targetId;
}

export function planningHistoryKinds(entityType:string):string[]{return Object.hasOwn(scopedKinds,entityType)?scopedKinds[entityType].map(action=>entityType+'.'+action):[];}
