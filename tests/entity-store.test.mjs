import test from 'node:test';
import assert from 'node:assert/strict';
import {freshState} from '../src/core.js';
import {MANIFEST_KEY, ENTITY_KEYS, entityKey, splitState, assembleState, migrateToEntities, loadEntityState} from '../src/entity-store.js';

test('entity store: split and assemble round-trip a workspace', () => {
  const state = freshState();
  state.notes = [{id: 'note-1', title: 'QA note', content: 'hello', created: '2026-11-04T00:00:00Z'}];
  state.revision = 3;
  const {manifest, records} = splitState(state);
  assert.equal(manifest.revision, 3);
  assert.deepEqual(manifest.entities, ENTITY_KEYS);
  assert.equal(records.notes.revision, 3);
  const back = assembleState(manifest, records);
  assert.deepEqual(back.notes, state.notes);
  assert.equal(back.revision, 3);
  assert.equal(back.activeProjectId, state.activeProjectId);
});

test('entity store: a missing entity record is named, and an invalid notes record is named', () => {
  const {manifest, records} = splitState(freshState());
  const missing = {...records};
  delete missing.notes;
  assert.throws(() => assembleState(manifest, missing), /Entity record missing: notes/);
  const corrupt = {...records, notes: {revision: 0, value: 'corrupt'}};
  assert.throws(() => assembleState(manifest, corrupt), /Entity record invalid: notes/);
});

test('entity store: an older entity revision is accepted (dirty entities are not rewritten every save)', () => {
  const state = freshState();
  state.revision = 3;
  const {manifest, records} = splitState(state);
  const older = {...records, notes: {revision: 1, value: []}};
  const back = assembleState(manifest, older);
  assert.equal(back.revision, 3);
  assert.deepEqual(back.notes, []);
});

test('entity store: an out-of-sync entity record is refused', () => {
  const {manifest, records} = splitState(freshState());
  const stale = {...records, audit: {revision: 99, value: []}};
  assert.throws(() => assembleState(manifest, stale), /Entity record out of sync: audit/);
});

test('entity store: migration is copy-only and never overwrites an existing manifest', async () => {
  const store = new Map();
  const read = async k => store.get(k) ?? null;
  const write = async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); };
  const state = freshState();
  assert.equal(await migrateToEntities(read, write, state), true);
  assert.equal(store.get('state.v1'), undefined);
  assert.equal(store.get(MANIFEST_KEY).revision, 0);
  assert.equal(store.get(entityKey('notes')).value.length, 0);
  const loaded = await loadEntityState(read);
  assert.deepEqual(loaded.state.projects[0].files, state.projects[0].files);
  assert.equal(await migrateToEntities(read, write, state), false);
});

test('entity store: a missing datasets list is named with its cause, and a BigInt inside datasets is named', () => {
  // 2026-11-08: Robbie's lab hit "Entity record not serializable:
  // datasets" on every save. The stored state predated saved datasets,
  // so datasets was undefined — valid per validateState, fatal per
  // splitState — and the message said nothing about why.
  const older = freshState();
  delete older.datasets;
  assert.throws(() => splitState(older), /Entity record not serializable: datasets \(value is undefined\)/);
  const big = freshState();
  big.datasets = [{id: 'd1', title: 't', content: 'x', created: 'now', junk: 10n}];
  assert.throws(() => splitState(big), /Entity record not serializable: datasets \(Do not know how to serialize a BigInt\)/);
});
