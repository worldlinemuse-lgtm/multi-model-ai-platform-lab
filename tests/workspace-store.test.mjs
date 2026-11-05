import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceStore} from '../src/workspace-store.js';
import {freshState} from '../src/core.js';
import {MANIFEST_KEY,ENTITY_KEYS,entityKey} from '../src/entity-store.js';

// The store touches the DOM only through el('save-indicator'); stub the
// document so node can exercise the persistence paths.
globalThis.document = {getElementById: () => null, querySelector: () => null, querySelectorAll: () => []};

function fakeCtx(){
  const store = new Map();
  const writes = [];
  const calls = {toast: [], broadcast: 0, renderAll: 0, renderAudit: 0, renderStats: 0, exportAll: 0, clearActiveNote: 0};
  let state = freshState();
  const ctx = {
    read: async (k) => store.get(k),
    write: async (k, v) => { writes.push(k); store.set(k, v); },
    getState: () => state,
    setState: (s) => { state = s; },
    toast: (m) => calls.toast.push(m),
    exportAll: () => { calls.exportAll++; },
    renderAll: () => { calls.renderAll++; },
    renderAudit: () => { calls.renderAudit++; },
    renderStats: () => { calls.renderStats++; },
    savedStatus: () => 'Saved',
    metrics: {begin: () => ({}), finish: () => {}},
    broadcast: () => { calls.broadcast++; },
    errorText: (e) => (typeof e === 'string' ? e : e?.message || String(e)),
    clearActiveNote: () => { calls.clearActiveNote++; },
  };
  return {ctx, store, calls, writes, getState: () => state};
}

test('workspace store: snapshotEntityJson mirrors each entity as JSON', () => {
  const {ctx} = fakeCtx();
  const s = createWorkspaceStore(ctx);
  const snap = s.snapshotEntityJson(ctx.getState());
  assert.deepEqual(Object.keys(snap).sort(), [...ENTITY_KEYS].sort());
  assert.equal(snap.notes, JSON.stringify(ctx.getState().notes));
});

test('workspace store: writeEntityRecords writes only changed entities, manifest every time', async () => {
  const {ctx, store, writes} = fakeCtx();
  const s = createWorkspaceStore(ctx);
  await s.writeEntityRecords(ctx.getState());
  assert.equal(writes.length, ENTITY_KEYS.length + 1);
  assert.ok(writes.includes(MANIFEST_KEY));
  writes.length = 0;
  await s.writeEntityRecords(ctx.getState());
  assert.deepEqual(writes, [MANIFEST_KEY]);
  assert.ok(store.get(MANIFEST_KEY));
});

test('workspace store: adoptStoredWorkspace accepts a valid state and migrates entities', async () => {
  const {ctx, store} = fakeCtx();
  const s = createWorkspaceStore(ctx);
  assert.equal(await s.adoptStoredWorkspace(ctx.getState()), true);
  assert.equal(s.lastSeenRevision, 0);
  assert.ok(store.get(MANIFEST_KEY), 'migration wrote a manifest');
  assert.ok(store.get(entityKey('notes')), 'migration wrote the notes entity');
});

test('workspace store: writeStateChecked refuses when another tab moved the manifest', async () => {
  const {ctx, store} = fakeCtx();
  const s = createWorkspaceStore(ctx);
  await s.adoptStoredWorkspace(ctx.getState());
  await s.saveNow();
  assert.equal(s.isCrossTabStale, false);
  const manifest = store.get(MANIFEST_KEY);
  store.set(MANIFEST_KEY, {...manifest, revision: manifest.revision + 5});
  await assert.rejects(() => s.writeStateChecked(), (e) => e.crossTab === true);
  assert.equal(s.isCrossTabStale, true);
});

test('workspace store: audit records the event, caps at 500, renders, and saves', async () => {
  const {ctx, store, calls} = fakeCtx();
  const s = createWorkspaceStore(ctx);
  await s.adoptStoredWorkspace(ctx.getState());
  const state = ctx.getState();
  for (let i = 0; i < 500; i++) state.audit.push({id: `e${i}`, at: '2026-11-05T00:00:00.000Z', op: 'inference', provider: 'groq', status: 'success', usage: null});
  s.audit('inference', 'groq', 'success', {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, source: 'provider'});
  assert.equal(state.audit.length, 500);
  assert.equal(state.audit[0].usage.total_tokens, 3);
  assert.equal(calls.renderAudit, 1);
  assert.equal(calls.renderStats, 1);
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(store.get('state.v1'), 'debounced save wrote state.v1');
  assert.equal(store.get('state.v1').audit[0].usage.total_tokens, 3);
});
