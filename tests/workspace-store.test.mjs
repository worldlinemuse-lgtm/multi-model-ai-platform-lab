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

test('workspace store: a stored state predating datasets loads with an empty list and saves again', async () => {
  // 2026-11-08: Robbie's lab refused every save with "Entity record not
  // serializable: datasets" because his stored state predated saved
  // datasets. validateState allows a missing list, so adopt must fill
  // it before the state goes live, or nothing new ever saves.
  const {ctx, store} = fakeCtx();
  const older = ctx.getState();
  delete older.datasets;
  const s = createWorkspaceStore(ctx);
  assert.equal(await s.adoptStoredWorkspace(older), true);
  assert.deepEqual(ctx.getState().datasets, []);
  assert.ok(store.get(entityKey('datasets')), 'migration wrote the datasets entity');
  await s.saveNow();
  assert.deepEqual(store.get('state.v1').datasets, []);
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

test('workspace store: overlapping checked writes cannot commit a stale snapshot last', async () => {
  // 2026-11-06: a debounced saveSoon (fired while a provider call was
  // still in flight) and the final saveNow ran writeStateChecked
  // concurrently; the overlap corrupts the revision bookkeeping either
  // way — the later invocation can trip a spurious cross-tab conflict
  // (same tab, not another tab) or the earlier invocation's pre-response
  // snapshot can commit after the final save, so stored state loses the
  // response (CI run 42215709359: the 3b case's settle-wait saw the
  // message, the immediate re-read found none). Checked writes are
  // serialized, so the later invocation re-reads stored state and
  // writes last.
  const {ctx, store} = fakeCtx();
  let releaseGate;
  const gated = new Promise((r) => { releaseGate = r; });
  let armGate = false;
  let gateTaken = false;
  ctx.write = async (k, v) => {
    const snapshot = structuredClone(v);
    if (k === 'state.v1' && armGate) { armGate = false; gateTaken = true; await gated; }
    store.set(k, snapshot);
  };
  const s = createWorkspaceStore(ctx);
  await s.adoptStoredWorkspace(ctx.getState());
  await s.saveNow();
  armGate = true;
  const first = s.writeStateChecked();
  for (let i = 0; i < 100 && !gateTaken; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(gateTaken, true, 'first invocation never reached its state.v1 write');
  ctx.getState().threads[0].messages.push({role: 'assistant', content: 'late response'});
  const second = s.writeStateChecked();
  releaseGate();
  await Promise.all([first, second]);
  const stored = store.get('state.v1');
  assert.equal(stored.threads[0].messages.filter((m) => m.role === 'assistant').length, 1, 'stored state lost the late response to a stale overlapping save');
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
