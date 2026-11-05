import test from 'node:test';
import assert from 'node:assert/strict';
import {compileWorkflowPlan} from '../src/workflow-plan.js';
import {executeSavedPlan} from '../src/workflow-supervisor.js';
const mk = plan => ({goal: 'Explain tests', status: 'running', steps: [], plan, inFlightStage: null});
const plan = s => compileWorkflowPlan(s, 'groq', ['groq', 'gemini']);

test('workflow retry: a failed run retries only the failed stage and records the attempt', async () => {
  const w = mk(plan('First\nSecond'));
  w.status = 'failed';
  w.steps = [
    {stage: 'First', provider: 'groq', status: 'complete', content: 'already computed', savedAs: 'stage1'},
    {stage: 'Second', provider: 'groq', status: 'failed', content: 'synthetic offline failure'},
  ];
  const calls = [];
  await executeSavedPlan(w, {persist: async () => {}, callStage: async (stage) => { calls.push(stage.label); return {text: 'retried'}; }});
  assert.deepEqual(calls, ['Second']);
  assert.equal(w.status, 'complete');
  assert.equal(w.steps.length, 2);
  assert.equal(w.steps[0].content, 'already computed');
  assert.equal(w.steps[1].content, 'retried');
  assert.equal(w.attempts.length, 1);
  assert.equal(w.attempts[0].stage, 'Second');
  assert.equal(w.attempts[0].status, 'failed');
});

test('workflow persist failure: a step whose persist fails is rolled back so durable state matches memory', async () => {
  const w = mk(plan('First\nSecond'));
  const snapshots = [];
  let persistCalls = 0;
  const persist = async (r) => {
    persistCalls++;
    if (persistCalls === 3) throw Error('storage unavailable');
    snapshots.push(JSON.parse(JSON.stringify(r)));
  };
  await assert.rejects(executeSavedPlan(w, {persist, callStage: async () => ({text: 'done'})}), /storage unavailable/);
  assert.equal(w.status, 'stopped');
  assert.equal(w.steps.length, 0);
  assert.deepEqual(snapshots.at(-1).steps, []);
  assert.equal(snapshots.at(-1).status, 'stopped');
});
