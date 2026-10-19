import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {cliUnitChildArguments} from './fixtures/cli-unit-child.mjs';
test('isolated CLI child uses a file URL for ESM import and a decoded native test path',()=>{const testUrl=new URL('file:///D:/synthetic%20checkout/bridge/test/cli.test.mjs'),args=cliUnitChildArguments(testUrl.href,'^synthetic case$');assert.equal(args[0],'--import');assert.equal(new URL(args[1]).protocol,'file:');assert.equal(args[1],new URL('./fixtures/cli-windows-state-loader.mjs',import.meta.url).href);assert.deepEqual(args.slice(2,5),['--test','--test-name-pattern','^synthetic case$']);assert.equal(args[5],fileURLToPath(testUrl));assert.ok(args[5].includes('synthetic checkout'));assert.ok(!args[5].includes('%20'));});
