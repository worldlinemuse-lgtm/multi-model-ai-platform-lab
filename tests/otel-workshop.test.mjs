import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkshopMetrics} from '../src/request-trace.js';
import {attachOtel, initOtelBridge, otelDiagnosticsText} from '../src/otel-workshop.js';
import {createLocalOtelPilot,WhitelistMemoryExporter} from '../observability/otel-local-pilot.mjs';
import {createLocalOtelMetrics} from '../observability/otel-local-metrics.mjs';

const fakeBridge = () => ({pilot: createLocalOtelPilot(), metrics: createLocalOtelMetrics()});
const readyResult = () => ({state: 'ready', bridge: fakeBridge()});

test('null initial result yields a loading wrapper, not the base object', () => {
  const base = createWorkshopMetrics({clock: () => 0});
  const m = attachOtel(base, null);
  assert.notEqual(m, base);
  assert.equal(m.otelStatus(), 'loading');
  // operations still work while loading
  const t = m.begin('save');
  assert.equal(m.finish(t, 'ok'), true);
});

test('setBridge attaches the SDK and flips status to ready', async () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), null);
  m.setBridge(readyResult());
  assert.equal(m.otelStatus(), 'ready');
  const t = m.begin('save');
  m.finish(t, 'ok');
  assert.equal(m.otelSnapshot().recorded, 1);
});

test('setBridge with unavailable result reports unavailable', () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), null);
  m.setBridge({state: 'unavailable', bridge: null});
  assert.equal(m.otelStatus(), 'unavailable');
  const t = m.begin('save');
  m.finish(t, 'ok'); // no crash, base still records
  assert.equal(m.summary().byOperation.find(o => o.op === 'save').total, 1);
});

test('initOtelBridge resolves ready with the real bundles', async () => {
  const result = await initOtelBridge();
  assert.equal(result.state, 'ready');
  assert.ok(result.bridge.pilot && result.bridge.metrics);
  await result.bridge.pilot.shutdown();
  await result.bridge.metrics.shutdown();
});

test('initOtelBridge reports unavailable when bundles are missing', async () => {
  const result = await initOtelBridge({load: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))});
  assert.equal(result.state, 'unavailable');
  assert.equal(result.bridge, null);
});

test('initOtelBridge reports failed when the SDK factory throws', async () => {
  const result = await initOtelBridge({load: async () => ({createLocalOtelPilot: () => { throw Error('broken'); }, createLocalOtelMetrics: () => { throw Error('broken'); }})});
  assert.equal(result.state, 'failed');
  assert.equal(result.bridge, null);
});

test('initOtelBridge reports unavailable on timeout', async () => {
  const result = await initOtelBridge({load: () => new Promise(() => {}), timeoutMs: 20});
  assert.equal(result.state, 'unavailable');
});

test('initOtelBridge shuts down a half-created pilot (no leak)', async () => {
  let shutdownCalled = false;
  const result = await initOtelBridge({load: async () => ([
    {createLocalOtelPilot: () => ({shutdown: async () => { shutdownCalled = true; }})},
    {createLocalOtelMetrics: () => { throw Error('metrics broken'); }},
  ])});
  assert.equal(result.state, 'failed');
  assert.equal(shutdownCalled, true);
});

test('begin/finish mirror to real OTel spans and metrics', () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  const t = m.begin('save');
  assert.ok(t);
  assert.equal(m.finish(t, 'ok', 'none'), true);
  const snap = m.otelSnapshot();
  assert.equal(snap.recorded, 1);
  assert.equal(snap.events[0].op, 'workshop.project_save');
  assert.equal(snap.events[0].outcome, 'ok');
  assert.equal(snap.events[0].reason, 'none');
});

test('app reasons map to the OTel reason dictionary, including superseded', () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  const t = m.begin('code-run');
  m.finish(t, 'cancelled', 'superseded');
  const snap = m.otelSnapshot();
  assert.equal(snap.events[0].outcome, 'cancelled');
  assert.equal(snap.events[0].reason, 'superseded');
});

test('setEnabled(false) gates the OTel mirror; re-enable resumes', () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  m.setEnabled(false);
  assert.equal(m.otelStatus(), 'disabled');
  const t = m.begin('save');
  m.finish(t, 'ok');
  assert.equal(m.otelSnapshot().recorded, 0);
  m.setEnabled(true);
  assert.equal(m.otelStatus(), 'ready');
  const t2 = m.begin('save');
  m.finish(t2, 'ok');
  assert.equal(m.otelSnapshot().recorded, 1);
});

test('reset finishes active OTel spans and clears both SDKs', async () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  const t1 = m.begin('save');
  const t2 = m.begin('code-run');
  m.finish(t1, 'ok');
  // t2 left active; reset must close it and clear everything
  m.reset();
  const snap = m.otelSnapshot();
  assert.equal(snap.active, 0);
  assert.equal(snap.recorded, 0);
  const report = await m.otelCollect();
  assert.ok(report.byOperation.every(o => o.total === 0));
  assert.equal(report.active, 0);
  assert.equal(m.summary().recorded, 0);
});

test('unmapped operations are not mirrored but still recorded locally', () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  const t = m.begin('ui-error');
  m.record('ui-error', 'error', 'uncaught-error');
  m.finish(t, 'error', 'uncaught-error');
  assert.equal(m.otelSnapshot().recorded, 0);
  assert.ok(m.summary().recorded >= 2);
});

test('invalid operations still throw exactly as before', () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  assert.throws(() => m.begin('https://example.com/?key=SECRET'), TypeError);
  assert.throws(() => m.begin('my private filename'), TypeError);
  // invalid codes never reach OTel: no spans recorded
  assert.equal(m.otelSnapshot().recorded, 0);
});

test('OTel mirror faults never break workshop behavior', () => {
  const badBridge = {
    pilot: {start() { throw Error('boom'); }, finish() { throw Error('boom'); }, snapshot() { throw Error('boom'); }, clear() { throw Error('boom'); }},
    metrics: {begin() { throw Error('boom'); }, finish() { throw Error('boom'); }, record() { throw Error('boom'); }, clear() { throw Error('boom'); }},
  };
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), {state: 'ready', bridge: badBridge});
  const t = m.begin('save');
  assert.equal(m.finish(t, 'ok'), true);
  assert.equal(m.summary().byOperation.find(o => o.op === 'save').total, 1);
  m.reset(); // must not throw even when the SDKs are broken
  assert.equal(m.summary().recorded, 0);
});

test('otelDiagnosticsText reports real SDK state with trace ids', async () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  const t = m.begin('boot');
  m.finish(t, 'ok');
  const t2 = m.begin('boot');
  m.finish(t2, 'error', 'runtime-error');
  const text = await otelDiagnosticsText(m);
  assert.match(text, /READY/);
  assert.match(text, /workshop\.boot/);
  assert.match(text, /trace [0-9a-f]{32}/);
  assert.match(text, /span [0-9a-f]{16}/);
  assert.match(text, /p50=\d+ms p95=\d+ms/);
  assert.match(text, /failure rate 50\.0%/);
  assert.match(text, /Limits:/);
});

test('otelDiagnosticsText distinguishes all non-ready states', async () => {
  const loading = attachOtel(createWorkshopMetrics({clock: () => 0}), null);
  assert.match(await otelDiagnosticsText(loading), /LOADING/);
  const unavailable = attachOtel(createWorkshopMetrics({clock: () => 0}), null);
  unavailable.setBridge({state: 'unavailable', bridge: null});
  assert.match(await otelDiagnosticsText(unavailable), /UNAVAILABLE/);
  const failed = attachOtel(createWorkshopMetrics({clock: () => 0}), null);
  failed.setBridge({state: 'failed', bridge: null});
  assert.match(await otelDiagnosticsText(failed), /FAILED/);
  const disabled = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  disabled.setEnabled(false);
  assert.match(await otelDiagnosticsText(disabled), /DISABLED/);
});

test('new snapshot and data-analyze operations are accepted', () => {
  const m = attachOtel(createWorkshopMetrics({clock: () => 0}), readyResult());
  const s = m.begin('snapshot');
  m.finish(s, 'ok');
  const d = m.begin('data-analyze');
  m.finish(d, 'ok');
  const snap = m.otelSnapshot();
  assert.deepEqual(snap.events.map(e => e.op), ['workshop.snapshot', 'workshop.data_analyze']);
});

test('phase atMs is the event offset from span start, not a duration',()=>{
  const exporter=new WhitelistMemoryExporter();
  const span={
    instrumentationScope:{name:'mm.workshop.local-pilot'},
    name:'workshop.boot',
    attributes:{'mm.outcome':'ok','mm.reason':'none'},
    spanContext:()=>({traceId:'a'.repeat(32),spanId:'b'.repeat(16)}),
    parentSpanContext:null,
    duration:[1,500000000],
    startTime:[100,0],
    events:[{name:'first',time:[100,250000000]},{name:'second',time:[101,0]}],
  };
  exporter.export([span],()=>{});
  const phases=exporter.snapshot().events[0].phases;
  assert.equal(phases[0].atMs,250);
  assert.equal(phases[1].atMs,1000);
});
