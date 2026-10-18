import {createHash} from 'node:crypto';
import {validateRelativePath} from '../src/execution-policy.mjs';
import {shape,integer,digest,fail,canonical} from './codec.mjs';
export function validateInspectionReport(raw,workspace,outputBytesLimit){
 shape(raw,['summary','findings','limitations']);const text=value=>{if(typeof value!=='string'||value.length>8192||value.includes('\0'))fail('invalid_report_text');return value;};text(raw.summary);if(!raw.summary.trim())fail('empty_report');
 if(!Array.isArray(raw.findings)||raw.findings.length>100||!Array.isArray(raw.limitations)||raw.limitations.length>100)fail('report_bound');raw.limitations.forEach(text);
 for(const item of raw.findings){shape(item,['path','line','claim','evidenceSha256']);validateRelativePath(item.path);integer(item.line,1,1000000);text(item.claim);digest(item.evidenceSha256);const file=workspace.files.find(file=>file.path===item.path);if(!file||file.sha256!==item.evidenceSha256||item.line>file.lineCount)fail('report_source_differs');}
 const data=Buffer.from(canonical(raw));if(data.length>outputBytesLimit)fail('output_limit');return {filename:'inspection.json',contentType:'application/json',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),data};
}
/** Narrow textual unified-diff format only. Git apply --check --cached remains required.
 * No modes, renames, binary patches, quoted paths, attributes, or command text accepted. */
export function parsePatchPaths(bytes,repository,outputBytesLimit){
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>outputBytesLimit)fail('patch_bound');const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0')||!text.endsWith('\n'))fail('invalid_patch');
 const lines=text.split('\n'),paths=new Set();let sections=0;
 for(const line of lines){if(line.startsWith('diff --git ')){const match=/^diff --git a\/([^\t\r]+) b\/([^\t\r]+)$/u.exec(line);if(!match||match[1]!==match[2])fail('unsupported_patch_header');const path=validateRelativePath(match[1]);if(/[ "]/u.test(path)||path.split('/').some(part=>['.gitattributes','.gitmodules'].includes(part.toLowerCase())))fail('unsafe_patch_path');const normalized=value=>process.platform==='win32'?value.toLowerCase():value,p=normalized(path),inside=base=>p===normalized(base)||p.startsWith(normalized(base)+'/');if(!repository.allowedPaths.some(inside)||repository.protectedPaths.some(inside))fail('patch_path_outside_scope');paths.add(path);sections++;}else if(/^(?:old mode|new mode|deleted file mode|new file mode|similarity index|rename |copy |GIT binary patch|Binary files)/u.test(line))fail('unsupported_patch_effect');}
 if(!sections||paths.size!==sections)fail('invalid_patch_sections');return [...paths];
}
