import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = {};
import {KeyVault} from '../src/vault.js';

test('vault cross-tab: a stale tab put is refused and does not erase the other tab key', async () => {
  const a = new KeyVault();
  await a.create('a long passphrase 12345');
  await a.put('groq', {key: 'fake-groq-secret', model: 'llama-3.1-8b-instant', attested: true});
  const b = new KeyVault();
  await b.unlock('a long passphrase 12345');
  await b.put('groq', {key: 'fake-groq-secret-v2', model: 'llama-3.1-8b-instant', attested: true});
  await assert.rejects(() => a.put('groq', {key: 'fake-stale-secret', model: 'llama-3.1-8b-instant', attested: true}), /another tab/);
  const c = new KeyVault();
  await c.unlock('a long passphrase 12345');
  assert.equal(c.get('groq').key, 'fake-groq-secret-v2');
  await b.erase();
  a.lock();
});

test('vault cross-tab: a saved callback fires on a successful put', async () => {
  let calls = 0;
  const v = new KeyVault(() => { calls++; });
  await v.create('a long passphrase 12345');
  calls = 0;
  await v.put('groq', {key: 'fake-groq-secret', model: 'llama-3.1-8b-instant', attested: true});
  assert.equal(calls, 1);
  await v.erase();
});
