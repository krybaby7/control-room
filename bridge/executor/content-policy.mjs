const MAX_BYTES=10*1024*1024;
const rules=[
 {code:'private_key',expression:/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/gu},
 {code:'bearer_credential',expression:/\bBearer[ \t]+[A-Za-z0-9._~+\/-]{16,}={0,2}/giu},
 {code:'provider_credential',expression:/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gu},
 {code:'credential_assignment',expression:/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|lease[_-]?token|device[_-]?(?:secret|credential))\b["']?[ \t]*[:=][ \t]*["']?[A-Za-z0-9._~+\/=-]{16,}/giu},
];

function decode(bytes){if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_BYTES)throw new Error('artifact_content_bound');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
/** Explicit preparation of selected content, never implicit transcript upload. */
export function prepareExecutionArtifactContent({logicalType,bytes}){
 if(!['summary','patch','transcript','diagnostic'].includes(logicalType))throw new Error('artifact_type_invalid');
 let value=decode(bytes);const codes=[];
 for(const rule of rules){rule.expression.lastIndex=0;if(rule.expression.test(value))codes.push(rule.code);rule.expression.lastIndex=0;}
 if(logicalType==='patch'&&codes.length)throw new Error('artifact_sensitive_patch_rejected');
 for(const rule of rules){rule.expression.lastIndex=0;value=value.replace(rule.expression,'[redacted:'+rule.code+']');rule.expression.lastIndex=0;}
 const prepared=new TextEncoder().encode(value);if(prepared.byteLength>MAX_BYTES)throw new Error('artifact_content_bound');
 return {bytes:prepared,changed:codes.length>0,codes,limitation:'Heuristic redaction does not prove arbitrary content is free of secrets.'};
}
/** Durable storage refuses unprepared sensitive bytes; it never silently edits a patch. */
export function assertExecutionArtifactContent(bytes){
 const value=decode(bytes);for(const rule of rules){rule.expression.lastIndex=0;const matched=rule.expression.test(value);rule.expression.lastIndex=0;if(matched)throw new Error('artifact_sensitive_content');}
}
