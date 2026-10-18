import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
async function loadLeaf(){
 const {build}=await import('esbuild'),{mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{createRequire}=await import('node:module');
 const directory=await mkdtemp(join(process.cwd(),'.backup-reauthorization-'));
 try{const file=join(directory,'leaf.cjs');await build({entryPoints:['components/backup-history.tsx'],outfile:file,bundle:true,platform:'node',format:'cjs',packages:'external',jsx:'automatic',logLevel:'silent'});return createRequire(import.meta.url)(file) as typeof import('../components/backup-history');}finally{await rm(directory,{recursive:true,force:true});}
}
const leaf=loadLeaf();
const old={id:'retired-synthetic',indexHash:'a'.repeat(64),cleanupAuthorized:false,chargedParts:1,pendingUploadCount:0};
const newer={id:'newer-synthetic',sha256:'b'.repeat(64),status:'ready' as const,fileArchive:{status:'ready' as const,bytes:1234,files:0,sha256:'c'.repeat(64)}};
test('owner renewal request binds exact retired index and newer metadata digest only after separate consent',async()=>{
 const {retiredArchiveAuthorizationRequest}=await leaf;
 assert.throws(()=>retiredArchiveAuthorizationRequest(old,newer,false));
 assert.deepEqual(retiredArchiveAuthorizationRequest(old,newer,true),{action:'reauthorize',id:old.id,indexHash:old.indexHash,newerId:newer.id,newerSha256:newer.sha256,confirmed:true});
 for(const candidate of [undefined,{...newer,id:old.id},{...newer,fileArchive:undefined},{...newer,fileArchive:{...newer.fileArchive,status:'failed' as const}},{...newer,sha256:'forged'}])assert.throws(()=>retiredArchiveAuthorizationRequest(old,candidate,true));
 for(const row of [{...old,cleanupAuthorized:true},{...old,chargedParts:0},{...old,pendingUploadCount:1}])assert.throws(()=>retiredArchiveAuthorizationRequest(row,newer,true));
});
test('actual consent rendering starts unchecked and distinguishes authorization from physical deletion',async()=>{
 const {RetiredAuthorizationConsent}=await leaf;
 const html=renderToStaticMarkup(React.createElement(RetiredAuthorizationConsent,{confirmed:false,disabled:false,onChange:()=>{}}));
 assert.match(html,/type="checkbox"/);assert.doesNotMatch(html,/checked=/);assert.match(html,/Renew cleanup authorization only; do not delete files/);
 const checked=renderToStaticMarkup(React.createElement(RetiredAuthorizationConsent,{confirmed:true,disabled:true,onChange:()=>{}}));assert.match(checked,/checked=/);assert.match(checked,/disabled=/);
});
