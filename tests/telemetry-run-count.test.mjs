import test from 'node:test';
import assert from 'node:assert/strict';
import {headlineStats} from '../src/telemetry-view.js';

// headlineStats calls deviceSnapshot, which reads navigator in node
// (node 24 ships a read-only navigator global, so redefine it).
Object.defineProperty(globalThis, 'navigator', {value: {hardwareConcurrency: null, deviceMemory: null}, configurable: true});

const codeRuns = events => headlineStats(events, {recorded: 0, state: 'unknown'})
  .find(s => s.label === 'CODE RUNS');
const run = (status, extra = {}) => ({op: 'run', provider: 'javascript', status, ...extra});

test('telemetry: a started run plus its terminal event counts as one code run, not two', () => {
  const stats = codeRuns([run('started'), run('success')]);
  assert.equal(stats.value, '1');
  assert.equal(stats.sub, '0 failed');
});

test('telemetry: a started run plus a failed terminal event counts once, with one failed', () => {
  const stats = codeRuns([run('started'), run('failed')]);
  assert.equal(stats.value, '1');
  assert.equal(stats.sub, '1 failed');
});

test('telemetry: a started run with no terminal event yet counts as zero code runs', () => {
  const stats = codeRuns([run('started')]);
  assert.equal(stats.value, '0');
});

test('telemetry: two runs, one success and one stopped, count as two with no failed', () => {
  const stats = codeRuns([run('started'), run('success'), run('started'), run('stopped')]);
  assert.equal(stats.value, '2');
  assert.equal(stats.sub, '0 failed');
});
