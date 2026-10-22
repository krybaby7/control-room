import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryMatchesScope } from '../lib/history/source-scope.ts';
test('scope revision and epoch invalidate old inventory, archive remains membership', () => {
    const scope = { sourceId: 's', epoch: 'e', scopeRevision: 2 };
    assert.equal(inventoryMatchesScope({ ...scope, generation: 'g' }, scope, 'g'), true);
    assert.equal(inventoryMatchesScope({ ...scope, scopeRevision: 1, generation: 'g' }, scope, 'g'), false);
    assert.equal(inventoryMatchesScope({ ...scope, epoch: 'old', generation: 'g' }, scope, 'g'), false);
});
import {changeSourceScope, SourceConfigurationSchema} from '../lib/history/source-scope.ts';
test('scope edits force fresh epoch and invalidate cursor completeness',()=>{
 const config={codecVersion:1 as const,sourceId:'s',kind:'codex_local' as const,epoch:'old',scopeRevision:1,roots:['synthetic-root'],accountId:null,deviceId:'synthetic-device',includeArchived:true,exclusions:[],parserVersion:'1',normalizationVersion:'1'};
 assert.equal(SourceConfigurationSchema.safeParse({...config,codecVersion:2}).success,false);
 assert.throws(()=>changeSourceScope(config,{...config,scopeRevision:2}));
 assert.deepEqual(changeSourceScope(config,{...config,epoch:'new',scopeRevision:2}),{configuration:{...config,epoch:'new',scopeRevision:2},cursor:null,inventoryComplete:false});
});
