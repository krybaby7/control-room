import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {captureRecoveryPrivateContinuity,validateRecoveryPrivateContinuity} from '../lib/recovery-private-continuity.ts';
const NOW='2026-10-18T12:00:00.000Z',OWNER='synthetic-private-epoch-owner',SHA='a'.repeat(64);
test('recomputed private JSON cannot supply a future cleanup epoch',async()=>{
 const f=database();try{
 await loadWorkspace(f.db,OWNER,()=>createSeedWorkspace(NOW),NOW);
 const input={manifestSha256:SHA,ownerContextHash:await contentHash(OWNER),sourceContext:{workspaceRevision:1,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(f.db,OWNER)}};
 const value=await captureRecoveryPrivateContinuity(f.db,OWNER,input,NOW);
 const edited=structuredClone(value);
 edited.tables.backup_archives.push({id:crypto.randomUUID(),namespace:crypto.randomUUID(),intent_id:crypto.randomUUID(),source_revision:1,source_sha256:SHA,metadata_content:null,metadata_bytes:0,execution_epoch:1,status:'failed',created_at:NOW,updated_at:NOW,zip_bytes:0,files:0,file_bytes:0,chunk_count:0,index_json:null,index_sha256:null});
 const {sha256,...body}=edited;void sha256;edited.sha256=await contentHash(canonical(body));
 await assert.rejects(validateRecoveryPrivateContinuity(edited,{...input,sha256:edited.sha256,ownerId:OWNER}),/epoch is ahead/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM backup_archives').get()!.count,0);
 // Even privileged source rows with an impossible future epoch fail capture;
 // an offline installer cannot reinterpret that corruption as current consent.
 const row=edited.tables.backup_archives[0],columns=Object.keys(row);
 f.sqlite.prepare('INSERT INTO backup_archives(user_id,'+columns.join(',')+') VALUES('+['user_id',...columns].map(()=>'?').join(',')+')').run(OWNER,...columns.map(column=>row[column as keyof typeof row]));
 await assert.rejects(captureRecoveryPrivateContinuity(f.db,OWNER,input,NOW),/epoch is ahead/);
 }finally{f.sqlite.close();}
});
