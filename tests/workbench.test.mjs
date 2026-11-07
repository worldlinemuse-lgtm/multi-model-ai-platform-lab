import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkbench} from '../src/workbench.js';
import {freshState,FLOW_TEMPLATES} from '../src/core.js';

function fakeEl(){
  const el = {
    value: '', textContent: '', hidden: false, disabled: false, checked: false,
    className: '', title: '', type: '', src: '', alt: '', href: '', download: '',
    style: {}, dataset: {}, children: [], files: [], scrollTop: 0, colSpan: 0,
    options: [],
    add(o){ this.options.push(o); },
    replaceChildren(...c){ this.children = [...c]; this.options = []; },
    append(...c){ this.children.push(...c); },
    addEventListener(){}, remove(){}, click(){}, focus(){}, close(){}, showModal(){},
    setAttribute(){}, getContext(){ return null; },
    querySelector(){ return fakeEl(); },
    querySelectorAll(){ return []; },
    classList: {toggle(){}, add(){}, remove(){}, contains(){ return false; }},
    scrollIntoView(){},
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
globalThis.Option = class { constructor(text, value){ this.text = text; this.value = value; } };
globalThis.prompt = () => null;
globalThis.confirm = () => true;
Object.defineProperty(globalThis, 'navigator', {value: {onLine: true}, configurable: true});

function fakeCtx(){
  const state = freshState();
  const toasts = [];
  const downloads = [];
  const audits = [];
  const ctx = {
    getState: () => state,
    saveSoon: () => {},
    saveNow: async () => {},
    replaceWorkspace: async (next) => { Object.assign(state, next); },
    toast: (m) => toasts.push(m),
    metrics: {begin: () => ({}), finish: () => {}, event: () => {}, summary: () => ({enabled: true, byOperation: [], recent: []}), exportReport: () => ({}), setEnabled: () => {}, reset: () => {}, record: () => {}},
    audit: (op, provider, status, usage) => audits.push({op, provider, status, usage}),
    vault: {get: () => null, list: () => [], lock: () => {}},
    callProvider: async () => ({text: 'stage done', model: 'm', usage: {total_tokens: 1}, httpStatus: 200}),
    selectView: () => {},
    renderFiles: () => {},
    routeChoices: () => {},
    renderProviders: () => {},
    renderVault: async () => {},
    renderChat: () => {},
    renderStats: () => {},
    download: (name, data) => downloads.push({name, data}),
    tracedExport: (fn) => fn(),
    optionalControl: (id) => $(id),
    store: {recoveryRaw: null, recoveryKind: null},
    getLabs: () => null,
    getActiveView: () => 'overview',
    runCode: () => {},
    runStop: () => {},
    newThread: () => {},
    newFile: () => {},
    createProject: () => {},
    savedStatus: () => 'Saved',
  };
  return {ctx, state, toasts, downloads, audits};
}
function textOf(el){
  let out = el.textContent || '';
  for (const child of el.children || []) out += textOf(child);
  return out;
}

test('workbench: renderAudit totals tokens and splits reported/unreported', () => {
  const {ctx, state} = fakeCtx();
  const w = createWorkbench(ctx);
  state.audit = [
    {id: 'a1', at: Date.now(), op: 'inference', provider: 'groq', status: 'success', usage: {total_tokens: 30, source: 'provider'}},
    {id: 'a2', at: Date.now(), op: 'inference', provider: 'groq', status: 'failed', usage: null},
    {id: 'a3', at: Date.now(), op: 'inference', provider: 'groq', status: 'requested', usage: null},
  ];
  w.renderAudit();
  assert.equal($('usage-total').textContent, 2);
  assert.equal($('usage-success').textContent, 1);
  assert.equal($('usage-tokens').textContent, '30 tokens');
  assert.match($('usage-tokens-note').textContent, /across 1 calls with reported usage; 1 calls reported no usage/);
});

test('workbench: workflowResumable covers running, failed and finished runs', () => {
  const {ctx} = fakeCtx();
  const w = createWorkbench(ctx);
  const plan = [{route: 'groq', label: 'one'}, {route: 'groq', label: 'two'}];
  assert.equal(w.workflowResumable({status: 'running', plan, steps: []}), true);
  assert.equal(w.workflowResumable({status: 'running', plan, steps: [{}, {}]}), false);
  assert.equal(w.workflowResumable({status: 'failed', plan, steps: [{status: 'done'}, {status: 'failed'}]}), true);
  assert.equal(w.workflowResumable({status: 'failed', plan, steps: [{status: 'failed'}, {status: 'done'}]}), false);
  assert.equal(w.workflowResumable({status: 'done', plan, steps: [{}, {}]}), false);
  assert.equal(w.workflowResumable({status: 'running', plan: null, steps: []}), false);
});

test('workbench: renderFlowGraph caps at 6 stages', () => {
  const {ctx} = fakeCtx();
  const w = createWorkbench(ctx);
  $('workflow-stages').value = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
  $('workflow-template').value = 'research';
  w.renderFlowGraph();
  assert.match($('workflow-graph').textContent, /Maximum is 6/);
});

test('workbench: flowStages falls back to the template when empty', () => {
  const {ctx} = fakeCtx();
  const w = createWorkbench(ctx);
  $('workflow-stages').value = '';
  $('workflow-template').value = 'research';
  assert.deepEqual(w.flowStages(), FLOW_TEMPLATES.research);
});

test('workbench: submitKnowledge creates a note, edit flow updates it', () => {
  const {ctx, state} = fakeCtx();
  const w = createWorkbench(ctx);
  $('knowledge-title').value = 'Test note';
  $('knowledge-content').value = 'Some content here';
  w.submitKnowledge({preventDefault(){}});
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].title, 'Test note');
  w.renderKnowledge();
  assert.match($('note-count').textContent, /1 notes/);
});

test('workbench: importKnowledge accepts a text file', async () => {
  const {ctx, state} = fakeCtx();
  const w = createWorkbench(ctx);
  const file = {name: 'memo.txt', size: 11, text: async () => 'hello world'};
  await w.importKnowledge({files: [file], value: ''});
  assert.equal(state.notes.length, 1);
  assert.equal(state.notes[0].title, 'memo.txt');
});

test('workbench: exportAll downloads a full workspace backup', () => {
  const {ctx, downloads} = fakeCtx();
  const w = createWorkbench(ctx);
  w.exportAll();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, 'multimodel-studio-backup.json');
  assert.ok(downloads[0].data.includes('"format": "mm-studio-v03"'));
});

test('workbench: executeWorkflow refuses without confirmation', async () => {
  const {ctx, state, toasts} = fakeCtx();
  const w = createWorkbench(ctx);
  $('workflow-confirm').checked = false;
  $('workflow-goal').value = 'Do a thing';
  $('workflow-template').value = 'research';
  $('workflow-route').value = 'groq';
  $('workflow-stages').value = 'Research the topic';
  await w.executeWorkflow({preventDefault(){}});
  assert.equal(state.workflows.length, 0);
  assert.match(toasts.at(-1), /Confirm explicit model requests/);
});

test('workbench: resumeWorkflow reports when nothing is resumable', async () => {
  const {ctx, toasts} = fakeCtx();
  const w = createWorkbench(ctx);
  await w.resumeWorkflow();
  assert.match(toasts.at(-1), /No paused workflow/);
});
