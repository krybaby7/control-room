import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpool } from '../src/spool.mjs';
const draft = () => ({
    protocolVersion: 1, epoch: 'e', scopeRevision: 1, page: {
        codecVersion: 1, sourceId: 's', runId: 'r', pageId: 'p', previousCursor: null, nextCursor: 'next', inventoryExhausted: false, conversations: [], messages: [], segments: [], attachments: [], gaps: [], objectManifest: []
    }
});
test('durable acquisition survives restart; changed page identity cannot replace queued bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-spool-'));
    try {
        const spool = await openSpool(dir);
        const entry = await spool.acquire(draft(), []);
        assert.equal((await (await openSpool(dir)).list()).length, 1);
        await assert.rejects(spool.acquire({ ...draft(), page: { ...draft().page, nextCursor: 'changed' } }, []), /identity/i);
        assert.equal(entry.envelope.page.nextCursor, 'next');
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
import { writeFile } from 'node:fs/promises';
import { acquireSingleInstance } from '../src/spool.mjs';
test('crash before atomic acquisition rename leaves no accepted entry and recovers safely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-crash-'));
    try {
        const broken = await openSpool(dir, { failpoint: async () => {
                throw Error('crash');
            } });
        await assert.rejects(broken.acquire(draft(), []), /crash/);
        const spool = await openSpool(dir);
        assert.deepEqual(await spool.list(), []);
        const release = await acquireSingleInstance(dir);
        try {
            await spool.recoverInterrupted();
        }
        finally {
            await release();
        }
        assert.ok(await spool.acquire(draft(), []));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('full spool never evicts pending data; corrupt state fails closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-bound-'));
    try {
        const spool = await openSpool(dir, { maxEntries: 1 }), entry = await spool.acquire(draft(), []);
        await assert.rejects(spool.acquire({ ...draft(), page: { ...draft().page, pageId: 'other' } }, []), /full/);
        assert.equal((await spool.list()).length, 1);
        await writeFile(join(entry.path, 'draft.json'), '{}', { mode: 0o600 });
        await assert.rejects(spool.list());
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('locked delivery is immutable and concurrent collector instance is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-lock-'));
    const release = await acquireSingleInstance(dir);
    try {
        await assert.rejects(acquireSingleInstance(dir), /already running/);
        const spool = await openSpool(dir), entry = await spool.acquire(draft(), []);
        await spool.lockDelivery(entry.id, entry.envelope);
        await assert.rejects(spool.lockDelivery(entry.id, { ...entry.envelope, page: { ...entry.envelope.page, nextCursor: 'other' } }), /cannot change/);
    }
    finally {
        await release();
        await rm(dir, { recursive: true, force: true });
    }
});
test('first observedAt, sequence and gap observation survive reordered scans; changed core requires provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-observed-'));
    try {
        const spool = await openSpool(dir), message = {
            id: 'm', conversationId: 'c', nativeMessageId: 'native', parentNativeMessageId: null, role: 'assistant', sequence: 7, revisionDigest: 'a'.repeat(64), observedAt: '2026-10-22T00:00:00.000Z'
        }, gap = {
            id: 'g', sourceId: 's', conversationId: 'c', kind: 'missing_segment', explanation: 'Not retained', detectedAt: '2026-10-22T00:00:00.000Z', resolvedAt: null
        }, first = { ...draft(), page: {
                ...draft().page, messages: [message], gaps: [gap]
            } };
        await spool.acquire(first, []);
        const later = { ...first, page: {
                ...first.page, pageId: 'p2', messages: [{
                        ...message, sequence: 99, observedAt: '2026-10-22T01:00:00.000Z'
                    }], gaps: [{ ...gap, detectedAt: '2026-10-22T01:00:00.000Z' }]
            } };
        const replay = await (await openSpool(dir)).acquire(later, []);
        assert.equal(replay.envelope.page.messages[0].sequence, 7);
        assert.equal(replay.envelope.page.messages[0].observedAt, message.observedAt);
        assert.equal(replay.envelope.page.gaps[0].detectedAt, gap.detectedAt);
        await assert.rejects(spool.acquire({ ...later, page: {
                ...later.page, pageId: 'p3', messages: [{ ...message, role: 'user' }]
            } }, []), /core changed/);
        await assert.rejects(spool.acquire({ ...later, page: {
                ...later.page, pageId: 'p4', gaps: [{ ...gap, explanation: 'Different loss' }]
            } }, []), /provenance identity/);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
import {symlink,truncate} from 'node:fs/promises';
test('asset symlinks and oversized declared files are rejected before buffering or accepting a draft',async()=>{const dir=await mkdtemp(join(tmpdir(),'history-asset-safety-')),outside=await mkdtemp(join(tmpdir(),'history-outside-'));try{const spool=await openSpool(dir),content=Buffer.from('matching private bytes'),asset={key:'local:asset',content,sha256:(await import('../src/spool.mjs')).digest(content),bytes:content.length},envelope={...draft(),page:{...draft().page,objectManifest:[{key:asset.key,sha256:asset.sha256,bytes:asset.bytes}]}},entry=await spool.acquire(envelope,[asset]),assetPath=join(entry.path,entry.assets[0].file),target=join(outside,'other-private-file');await writeFile(target,content,{mode:0o600});await rm(assetPath);await symlink(target,assetPath);await assert.rejects(spool.load(entry.id),/private|link|asset|file/i);await rm(assetPath);await writeFile(assetPath,content,{mode:0o600});await truncate(assetPath,16*1024*1024+1);await assert.rejects(spool.load(entry.id),/size|oversized|bound/i);}finally{await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}});

import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {digest} from '../src/spool.mjs';
import {resolve} from 'node:path';
test('kernel instance identity does not collide with unrelated occupied TCP ports and releases on process death', {skip:!['linux','win32'].includes(process.platform),timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-kernel-lock-')),other=await mkdtemp(join(tmpdir(),'history-kernel-other-'));
 const legacyPort=40000+parseInt(digest(resolve(dir)).slice(0,8),16)%20000,unrelated=createServer(socket=>socket.destroy());let child,release;
 try{
  await new Promise((ok,no)=>{unrelated.once('error',no);unrelated.listen({host:'127.0.0.1',port:legacyPort},ok);});
  // The former lock is deterministically blocked by an unrelated listener.
  const oldProbe=createServer();const oldError=await new Promise(ok=>{oldProbe.once('error',ok);oldProbe.listen({host:'127.0.0.1',port:legacyPort});});assert.equal(oldError.code,'EADDRINUSE');
  const moduleUrl=new URL('../src/spool.mjs',import.meta.url).href;
  child=spawn(process.execPath,['--input-type=module','-e',`import {acquireSingleInstance} from ${JSON.stringify(moduleUrl)};await acquireSingleInstance(process.argv[1]);process.stdout.write('locked\\n');`,dir],{stdio:['ignore','pipe','pipe']});
  const [output]=await once(child.stdout,'data');assert.equal(output.toString(),'locked\n');
  await assert.rejects(acquireSingleInstance(dir),error=>{assert.equal(error.code,'EADDRINUSE');assert.equal(error.cause.code,'EADDRINUSE');assert.ok(!error.message.includes(dir));assert.ok(!error.cause.message.includes(dir));return true;});
  const distinctRelease=await acquireSingleInstance(other);await distinctRelease();
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=null;
  release=await acquireSingleInstance(dir);await release();release=null;
  release=await acquireSingleInstance(dir);
 }finally{if(child){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await release?.();await new Promise(ok=>unrelated.close(ok));await rm(dir,{recursive:true,force:true});await rm(other,{recursive:true,force:true});}
});
