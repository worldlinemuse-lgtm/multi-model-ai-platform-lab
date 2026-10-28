/* OpenTelemetry workshop bridge.
 *
 * Wires the real OTel SDK pilot bundles (observability/dist/) into the
 * workshop's existing metrics surface without changing any call site.
 * main.js wraps its workshopMetrics object with attachOtel(); every
 * begin/finish/record then mirrors to the real SDK automatically.
 *
 * Safety properties (all load-bearing):
 * - Asynchronous init with timeout: initOtelBridge() never blocks app boot
 *   and never throws. A missing bundle yields state 'unavailable'; a broken
 *   bundle yields 'failed'. Either way the workshop runs exactly as before.
 * - Fixed dictionaries only: only pre-approved operation/outcome/reason
 *   labels ever reach the SDK. Never user content, filenames, or errors.
 * - Local-only: the pilot uses memory exporters. No network, no global
 *   tracer provider, no auto-instrumentation.
 * - OTel failures never propagate: every mirror call is guarded so a
 *   telemetry fault cannot break workshop behavior.
 * - Lifecycle: setEnabled gates the OTel mirror; reset() finishes active
 *   OTel spans and clears both SDKs; partial init shuts down the pilot
 *   so no handle leaks.
 */

// App operation -> OTel operation. Unmapped ops (e.g. ui-error) are not mirrored.
const OTEL_OPS = Object.freeze({
  'boot': 'workshop.boot',
  'code-run': 'workshop.code_run',
  'save': 'workshop.project_save',
  'preview': 'workshop.preview',
  'snapshot': 'workshop.snapshot',
  'project-import': 'workshop.project_import',
  'project-export': 'workshop.project_export',
  'data-analyze': 'workshop.data_analyze',
  'offline-refresh': 'workshop.offline_refresh',
  'storage-check': 'workshop.storage_check',
  'inference': 'workshop.inference',
});
// App reason -> OTel reason (pilot REASONS dictionary). Unknown -> 'unobserved'.
const OTEL_REASONS = Object.freeze({
  'none': 'none',
  'runtime-error': 'runtime-failed',
  'uncaught-error': 'runtime-failed',
  'unhandled-rejection': 'runtime-failed',
  'user-stop': 'user-stop',
  'superseded': 'superseded',
  'time-limit': 'time-limit',
  'output-limit': 'resource-limit',
  'storage-error': 'storage-failed',
  'invalid-input': 'invalid-input',
  'unsupported-asset': 'unsupported',
  'worker-error': 'worker-failed',
  'offline-unavailable': 'offline-unavailable',
  'resource-limit': 'resource-limit',
  'clone-failed': 'clone-failed',
  'restore-failed': 'restore-failed',
  'unknown': 'unobserved',
});
const OTEL_OUTCOMES = new Set(['ok', 'error', 'timeout', 'cancelled', 'warning', 'unknown']);
const INIT_TIMEOUT_MS = 5000;
// Mirror of the pilot's resource bounds, surfaced in diagnostics.
const OTEL_LIMITS = Object.freeze({maxActiveSpans: 20, maxRetainedEvents: 160, maxDurationMs: 600000});

async function defaultLoad() {
  return Promise.all([
    import('../observability/dist/otel-local-pilot.js'),
    import('../observability/dist/otel-local-metrics.js'),
  ]);
}

/** Initialize the OTel SDK without blocking the caller and without throwing.
 *  Resolves {state:'ready', bridge:{pilot, metrics}} on success, or
 *  {state:'unavailable'|'failed', bridge:null}. A half-created pilot is shut
 *  down so no trace handle leaks. `load` is injectable for tests. */
export async function initOtelBridge({load = defaultLoad, timeoutMs = INIT_TIMEOUT_MS} = {}) {
  let pilot = null;
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('otel-init-timeout'), {code: 'OTEL_TIMEOUT'})), timeoutMs));
    const [traceMod, metricsMod] = await Promise.race([load(), timeout]);
    pilot = traceMod.createLocalOtelPilot();
    try {
      const metrics = metricsMod.createLocalOtelMetrics();
      return {state: 'ready', bridge: {pilot, metrics}};
    } catch (e) {
      try { await pilot.shutdown(); } catch { /* best effort */ }
      pilot = null;
      throw e;
    }
  } catch (e) {
    if (pilot) { try { await pilot.shutdown(); } catch { /* best effort */ } }
    const msg = String((e && e.message) || '');
    const state = (e && e.code === 'OTEL_TIMEOUT') || /failed to fetch|not found|404/i.test(msg)
      ? 'unavailable'
      : 'failed';
    return {state, bridge: null};
  }
}

/** Wrap a workshopMetrics-compatible object so begin/finish/record also
 *  mirror to the real OTel SDK. All other methods delegate unchanged.
 *  The wrapper is always returned (never the base), so setBridge() and
 *  otelStatus() exist even before the SDK loads. Pass null as the initial
 *  result while loading; call setBridge() when initOtelBridge() resolves. */
export function attachOtel(base, initialResult = null) {
  let state = initialResult ? initialResult.state : 'loading';
  let bridge = initialResult && initialResult.bridge ? initialResult.bridge : null;
  let otelEnabled = true;
  const active = new Map(); // base token -> {traceToken, metricsToken}
  const mapOutcome = outcome => (OTEL_OUTCOMES.has(outcome) ? outcome : 'unknown');
  const mapReason = reason => OTEL_REASONS[reason] || 'unobserved';
  // Mirror target: only when the SDK is ready AND collection is enabled.
  const parts = () => (state === 'ready' && bridge && bridge.pilot && bridge.metrics && otelEnabled ? bridge : null);

  function begin(op) {
    const token = base.begin(op); // throws on invalid op, exactly as before
    const p = parts();
    const otelOp = OTEL_OPS[op];
    if (token && p && otelOp) {
      try {
        active.set(token, {
          traceToken: p.pilot.start(otelOp), // may be null under backpressure
          metricsToken: p.metrics.begin(otelOp),
        });
      } catch {
        active.delete(token);
      }
    }
    return token;
  }
  function finish(token, outcome = 'ok', reason = 'none') {
    const mirror = token ? active.get(token) : undefined;
    if (mirror) {
      active.delete(token);
      const p = parts();
      const o = mapOutcome(outcome), r = mapReason(reason);
      // Finish against the bridge even if disabled mid-span: the span was
      // started, so it must be closed to avoid leaking gauges.
      const b = p || (state === 'ready' ? bridge : null);
      if (b) {
        try { if (mirror.traceToken) b.pilot.finish(mirror.traceToken, o, r); } catch { /* never break the app */ }
        try { if (mirror.metricsToken) b.metrics.finish(mirror.metricsToken, o); } catch { /* never break the app */ }
      }
    }
    return base.finish(token, outcome, reason);
  }
  function record(op, outcome = 'warning', reason = 'unknown') {
    const p = parts();
    const otelOp = OTEL_OPS[op];
    if (p && otelOp) {
      try { p.metrics.record(otelOp, mapOutcome(outcome)); } catch { /* never break the app */ }
    }
    return base.record(op, outcome, reason);
  }
  function event(token, name) {
    if (!token || typeof name !== 'string') return false;
    const mirror = active.get(token);
    const p = parts();
    if (mirror && mirror.traceToken && p) {
      try { return p.pilot.event(mirror.traceToken, name); } catch { /* never break the app */ }
    }
    return false;
  }
  function setEnabled(value) {
    otelEnabled = Boolean(value);
    return base.setEnabled(value);
  }
  function reset(...args) {
    // Close any OTel-side active spans first so gauges return to zero,
    // then clear both SDKs' retained state.
    if (bridge) {
      for (const mirror of active.values()) {
        try { if (mirror.traceToken) bridge.pilot.finish(mirror.traceToken, 'unknown', 'parent-closed'); } catch { /* never break the app */ }
        try { if (mirror.metricsToken) bridge.metrics.finish(mirror.metricsToken, 'unknown'); } catch { /* never break the app */ }
      }
      active.clear();
      try { bridge.pilot.clear(); } catch { /* never break the app */ }
      try { if (typeof bridge.metrics.clear === 'function') bridge.metrics.clear(); } catch { /* never break the app */ }
    } else {
      active.clear();
    }
    return base.reset(...args);
  }
  function setBridge(result) {
    if (result && result.state === 'ready' && result.bridge && result.bridge.pilot && result.bridge.metrics) {
      bridge = result.bridge;
      state = 'ready';
    } else {
      bridge = null;
      state = (result && result.state) || 'unavailable';
    }
  }
  /** loading | ready | disabled | unavailable | failed */
  function otelStatus() {
    if (state !== 'ready') return state;
    if (!bridge) return 'unavailable';
    return otelEnabled ? 'ready' : 'disabled';
  }
  return Object.freeze({
    begin,
    finish,
    record,
    event,
    setEnabled,
    reset,
    setBridge,
    otelStatus,
    otelBridge: () => bridge,
    summary: (...args) => base.summary(...args),
    exportReport: (...args) => base.exportReport(...args),
    otelSnapshot() {
      try { return bridge ? bridge.pilot.snapshot() : null; } catch { return null; }
    },
    async otelCollect() {
      try { return bridge ? await bridge.metrics.collect() : null; } catch { return null; }
    },
  });
}

/** Render OTel state as plain text for the diagnostics panel. Never throws. */
export async function otelDiagnosticsText(decorated) {
  const status = (decorated && typeof decorated.otelStatus === 'function') ? decorated.otelStatus() : 'unavailable';
  const lines = [`OpenTelemetry SDK state: ${String(status).toUpperCase()}`];
  if (status !== 'ready') {
    lines.push(
      status === 'loading' ? 'SDK bundles are still loading; workshop counters above are unaffected.' :
      status === 'disabled' ? 'Collection disabled by the workshop toggle; no spans or metrics are recorded.' :
      status === 'unavailable' ? 'SDK bundles not present (not built or not deployed). Workshop counters above are unaffected.' :
      'SDK initialization failed. Workshop counters above are unaffected; no telemetry is recorded.'
    );
    return lines.join('\n');
  }
  const bridge = decorated.otelBridge();
  lines.push(
    `Local-only, in-memory. Limits: ${OTEL_LIMITS.maxActiveSpans} active spans, ` +
    `${OTEL_LIMITS.maxRetainedEvents} retained events, durations clipped at ${OTEL_LIMITS.maxDurationMs}ms. ` +
    `Outcome labels: OK=confirmed success, FAILED=error/timeout, UNKNOWN=finished without a terminal state, ` +
    `NOT OBSERVED=no reason recorded.`
  );
  lines.push(
    `Note: the SDK initializes asynchronously without blocking boot. Operations that start before ` +
    `the SDK reaches READY (including the earliest boot interval) are recorded in workshop counters ` +
    `but not as OTel spans.`
  );
  let events = [];
  try {
    const snap = bridge.pilot.snapshot();
    events = snap.events;
    lines.push(
      `Traces: ${snap.recorded} recorded, ${snap.discarded} discarded (overflow), ` +
      `${snap.discardedStarts} rejected starts (backpressure), ${snap.active} active`
    );
    // Duration distribution per operation from real span data.
    const byOp = new Map();
    for (const e of events) {
      if (e.durationMs === null) continue;
      if (!byOp.has(e.op)) byOp.set(e.op, []);
      byOp.get(e.op).push(e.durationMs);
    }
    for (const [op, ds] of [...byOp.entries()].sort()) {
      ds.sort((a, b) => a - b);
      const q = p => ds[Math.min(ds.length - 1, Math.ceil(ds.length * p) - 1)];
      lines.push(`  ${op}: n=${ds.length} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${ds[ds.length - 1]}ms`);
    }
    for (const e of events.slice(-8).reverse()) {
      lines.push(
        `  ${e.op} · ${e.outcome} · ${e.reason} · ` +
        `${e.durationMs === null ? 'duration n/a' : e.durationMs + 'ms'}` +
        `${e.traceId ? ' · trace ' + e.traceId : ''}` +
        `${e.spanId ? ' · span ' + e.spanId : ''}` +
        `${e.parentSpanId ? ' · parent ' + e.parentSpanId : ''}`
      );
    }
    if (!events.length) lines.push('  no spans recorded yet');
  } catch {
    lines.push('Trace snapshot unavailable.');
  }
  try {
    const report = await bridge.metrics.collect();
    const rows = (report.byOperation || []).filter(o => o.total > 0);
    lines.push(
      `Metrics: collection ${report.collectionStatus || 'unknown'}` +
      `${report.rejectedStarts ? `, ${report.rejectedStarts} rejected starts (backpressure)` : ''}` +
      `${report.sdkErrorCount ? `, ${report.sdkErrorCount} SDK errors` : ''}`
    );
    for (const o of rows) {
      const bad = o.errors + o.timeouts;
      const rate = o.total ? (100 * bad / o.total).toFixed(1) : '0.0';
      lines.push(
        `  ${o.operation}: ${o.total} total / ${o.ok} ok / ${o.errors} error / ` +
        `${o.timeouts} timeout / ${o.cancelled} cancelled / failure rate ${rate}%`
      );
    }
    if (!rows.length) lines.push('  no operations recorded yet');
  } catch {
    lines.push('Metrics collection unavailable.');
  }
  return lines.join('\n');
}
