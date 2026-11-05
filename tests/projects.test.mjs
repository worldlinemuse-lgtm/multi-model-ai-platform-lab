import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjects} from '../src/projects.js';
import {freshState} from '../src/core.js';

// Minimal fake DOM: every id returns a persistent fake element.
function fakeEl(){
  const el = {
    value: '', textContent: '', hidden: false, disabled: false,
    className: '', title: '', type: '', src: '', alt: '', href: '', download: '',
    style: {}, dataset: {}, children: [], files: [],
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
  el.options = [];
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
globalThis.URL = {createObjectURL: () => 'blob:fake', revokeObjectURL: () => {}};

let promptQueue = [];
let confirmQueue = [];
globalThis.prompt = () => promptQueue.shift() ?? null;
globalThis.confirm = () => confirmQueue.shift() ?? true;

function fakeCtx(){
  let state = freshState();
  const calls = {toast: [], saves: 0, renderStats: 0};
  const ctx = {
    getState: () => state,
    setState: (s) => { state = s; },
    saveSoon: () => { calls.saves++; },
    saveNow: async () => { calls.saves++; },
    toast: (m) => calls.toast.push(m),
    metrics: {begin: () => ({}), finish: () => {}},
    renderStats: () => { calls.renderStats++; },
  };
  return {ctx, calls, getState: () => state};
}

test('projects: create, rename, delete project', () => {
  const {ctx, getState} = fakeCtx();
  const p = createProjects(ctx);
  promptQueue = ['Second'];
  p.createProject();
  assert.equal(getState().projects.length, 2);
  assert.equal(getState().projects[1].name, 'Second');
  promptQueue = ['Renamed'];
  p.renameProject();
  assert.equal(getState().projects[1].name, 'Renamed');
  confirmQueue = [true];
  p.deleteProject();
  assert.equal(getState().projects.length, 1);
  assert.equal(getState().activeProjectId, getState().projects[0].id);
});

test('projects: create project refuses past 30', () => {
  const {ctx, calls, getState} = fakeCtx();
  const p = createProjects(ctx);
  while (getState().projects.length < 30) getState().projects.push({...getState().projects[0], id: `x${getState().projects.length}`});
  p.createProject();
  assert.equal(getState().projects.length, 30);
  assert.match(calls.toast.at(-1), /Maximum 30 projects/);
});

test('projects: new file, rename file, delete file', () => {
  const {ctx, getState} = fakeCtx();
  const p = createProjects(ctx);
  promptQueue = ['notes.txt'];
  p.newFile();
  assert.ok(Object.hasOwn(getState().projects[0].files, 'notes.txt'));
  assert.equal(getState().projects[0].active, 'notes.txt');
  promptQueue = ['renamed.txt'];
  p.renameFile();
  assert.ok(Object.hasOwn(getState().projects[0].files, 'renamed.txt'));
  assert.ok(!Object.hasOwn(getState().projects[0].files, 'notes.txt'));
  confirmQueue = [true];
  p.deleteFile();
  assert.ok(!Object.hasOwn(getState().projects[0].files, 'renamed.txt'));
});

test('projects: snapshot create, restore, delete', () => {
  const {ctx, getState} = fakeCtx();
  const p = createProjects(ctx);
  promptQueue = ['Checkpoint 1'];
  p.snapshot();
  assert.equal(getState().snapshots.length, 1);
  assert.equal(getState().snapshots[0].label, 'Checkpoint 1');
  getState().projects[0].files['main.js'] = '// changed';
  $('snapshot-select').value = getState().snapshots[0].id;
  confirmQueue = [true];
  p.restoreSnapshot();
  assert.notEqual(getState().projects[0].files['main.js'], '// changed');
  $('snapshot-action').value = 'delete';
  confirmQueue = [true];
  p.manageSnapshot();
  assert.equal(getState().snapshots.length, 0);
});

test('projects: reviewed edit preview, accept, rollback', () => {
  const {ctx, getState} = fakeCtx();
  const p = createProjects(ctx);
  const original = getState().projects[0].files['main.js'];
  $('q04-proposal').value = original.replace('Hello from Multi-Model Studio!', 'Hello, reviewed world!');
  p.q04PreviewEdit();
  p.q04AcceptEdit();
  assert.match(getState().projects[0].files['main.js'], /Hello, reviewed world!/);
  confirmQueue = [true];
  p.q04RollbackEdit();
  assert.equal(getState().projects[0].files['main.js'], original);
});

test('projects: importProject accepts a valid project JSON', async () => {
  const {ctx, getState} = fakeCtx();
  const p = createProjects(ctx);
  const payload = JSON.stringify({format: 'mm-platform-b01', active: 'main.js', files: {'main.js': 'console.log(1);'}});
  const file = {name: 'imported.json', size: payload.length, text: async () => payload};
  confirmQueue = [true];
  await p.importProject(file);
  assert.equal(getState().projects.length, 2);
  assert.equal(getState().projects[1].name, 'imported');
});
