const MAX_BYTES=10*1024*1024;
const rules=[
 {code:'private_key',expression:/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/gu},
 {code:'bearer_credential',expression:/\bBearer[ \t]+[A-Za-z0-9._~+\/-]{16,}={0,2}/giu},
 {code:'provider_credential',expression:/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gu},
 {code:'credential_assignment',expression:/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|lease[_-]?token|device[_-]?(?:secret|credential))\b["']?[ \t]*[:=][ \t]*["']?[A-Za-z0-9._~+\/=-]{16,}/giu},
];

export type ArtifactSensitiveCode='private_key'|'bearer_credential'|'provider_credential'|'credential_assignment';
/** Bounded heuristic only. Absence of a match is not proof of secret-free content. */
export function inspectAgentArtifactContent(bytes:Uint8Array):{allowed:boolean;codes:ArtifactSensitiveCode[]}{
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_BYTES)throw new Error('Artifact content is outside the supported bound.');
 const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes),codes:ArtifactSensitiveCode[]=[];
 for(const rule of rules){rule.expression.lastIndex=0;if(rule.expression.test(value))codes.push(rule.code as ArtifactSensitiveCode);rule.expression.lastIndex=0;}
 return {allowed:codes.length===0,codes};
}
