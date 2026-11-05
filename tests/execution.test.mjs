import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecution} from '../src/execution.js';
import {freshState} from '../src/core.js';

function fakeEl(){
  const el = {
    value: '', textContent: '', hidden: false, disabled: false,
    className: '', title: '', type: '', src: '', alt: '', href: '', download: '',
    style: {}, dataset: {}, children: [], files: [], scrollTop: 0, srcdoc: '',
    options: [],
    add(o){ this.options.push(o); },
    replaceChildren(...c){ this.children = [...c]; },
    append(...c){ this.children.push(...c); },
    addEventListener(){}, remove(){}, click(){}, focus(){},
    setAttribute(){}, getContext(){ return null; },
    querySelector(){ return fakeEl(); },
    querySelectorAll(){ return []; },
    classList: {toggle(){}, add(){}, remove(){}},
  };
  return el;
}
const elements = new Map();
function $(id){ if(!elements.has(id)) elements.set(id, fakeEl()); return elements.get(id); }
globalThis.document = {
  getElementById: (id) => $(id),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
  body: fakeEl(),
};
Object.defineProperty(globalThis, 'navigator', {value: {onLine: true}, configurable: true});

function fakeCtx(){
  const state = freshState();
  const audits = [];
  const toasts = [];
  const ctx = {
    project: () => state.projects.find(p => p.id === state.activeProjectId) || state.projects[0],
    audit: (op, provider, status, usage, meta) => audits.push({op, provider, status, meta}),
    toast: (m) => toasts.push(m),
    metrics: {begin: () => ({}), finish: () => {}, event: () => {}},
  };
  return {ctx, state, audits, toasts};
}
function fakeRun(){
  return {
    calls: [],
    stopped: null,
    run(code, lang, cb){ this.calls.push({code, lang}); cb('done', 'hello output'); },
    stop(msg){ this.stopped = msg ?? 'stopped'; },
    onStop: null,
  };
}
function setupDom(){
  $('runtime-choice').value = 'auto';
  $('code-time-limit').value = '6000';
  $('console-output').textContent = '';
}

test('execution: runCode runs JS, audits started + success, prints output', () => {
  const {ctx, audits, toasts} = fakeCtx();
  const exec = createExecution(ctx);
  const run = fakeRun();
  exec.attachRunner(run);
  setupDom();
  exec.runCode();
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].lang, 'javascript');
  assert.deepEqual(audits.map(a => a.status), ['started', 'success']);
  assert.match($('console-output').textContent, /hello output/);
  assert.equal(toasts.length, 0);
});

test('execution: runCode refuses a non-code file in auto mode', () => {
  const {ctx, toasts} = fakeCtx();
  const exec = createExecution(ctx);
  const run = fakeRun();
  exec.attachRunner(run);
  setupDom();
  ctx.project().active = 'style.css';
  exec.runCode();
  assert.equal(run.calls.length, 0);
  assert.match(toasts.at(-1), /Choose a \.js or \.py file/);
});

test('execution: stopCode stops the runner', () => {
  const {ctx} = fakeCtx();
  const exec = createExecution(ctx);
  const run = fakeRun();
  exec.attachRunner(run);
  exec.stopCode();
  assert.equal(run.stopped, 'Execution stopped by user.');
});

test('execution: printConsole flood stops the runner at 181 lines', () => {
  const {ctx} = fakeCtx();
  const exec = createExecution(ctx);
  const run = fakeRun();
  exec.attachRunner(run);
  setupDom();
  for (let i = 0; i < 182; i++) exec.printConsole('line ' + i);
  assert.ok(run.stopped !== null, 'runner was stopped by the flood guard');
  assert.match($('console-output').textContent, /Output flood limit reached/);
});

test('execution: previewPage renders the project HTML into the preview host', () => {
  const {ctx} = fakeCtx();
  const exec = createExecution(ctx);
  exec.attachRunner(fakeRun());
  setupDom();
  exec.previewPage();
  const host = $('preview-host');
  assert.equal(host.children.length, 1);
  assert.match(host.children[0].srcdoc, /Hello from the browser workbench/);
  assert.equal($('preview-pane').hidden, false);
  assert.equal($('console-pane').hidden, true);
});

test('execution: runner onStop marks a timed-out Python run', () => {
  const {ctx, audits} = fakeCtx();
  const exec = createExecution(ctx);
  const run = fakeRun();
  exec.attachRunner(run);
  setupDom();
  ctx.project().active = 'hello.py';
  run.run = () => { /* never calls back: the run is still going */ };
  exec.runCode();
  assert.equal(exec.getPythonStatus(), 'RUNNING — REQUIRES CDN');
  run.onStop('Execution timed out.');
  assert.equal(exec.getPythonStatus(), 'TIMED OUT THIS SESSION');
  assert.ok(audits.some(a => a.status === 'stopped'));
});
