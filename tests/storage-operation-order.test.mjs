import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window={};
import {read,write,remove} from '../src/storage.js';
test('write and remove preserve call ordering',async()=>{await Promise.all([write('ordering-check',{v:1}),remove('ordering-check')]);assert.equal(await read('ordering-check'),null);});
test('remove and write preserve call ordering',async()=>{await Promise.all([remove('ordering-check'),write('ordering-check',{v:2})]);assert.deepEqual(await read('ordering-check'),{v:2});await remove('ordering-check');});
