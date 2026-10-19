import test from 'node:test';
import assert from 'node:assert/strict';
import {createInstalledSubscriptionRuntime} from '../executor/runtime.mjs';
import {fixture} from './fixtures/executor.mjs';

test('production composition refuses fabricated native owners before loading code',async()=>{const f=fixture();await assert.rejects(createInstalledSubscriptionRuntime({installation:{status:'installed'},owner:{run(){}},policy:f.policy,providerConfiguration:{provider:'codex',executable:'/synthetic/provider',subscriptionOnly:true,extraUsageOffAttested:true},executableEvidence:{sha256:'a'.repeat(64),version:'fixture-cli'},now:()=>new Date().toISOString()}),/native_owned_supervisor_required/);});

