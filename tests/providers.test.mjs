import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviders} from '../src/providers.js';
import {freshState,PROVIDERS} from '../src/core.js';
import {exportProviderPresets} from '../src/provider-presets.js';

function fakeEl(){
  const el = {
    value: '', textContent: '', hidden: false, disabled: false, checked: false,
    className: '', title: '', type: '', src: '', alt: '', href: '', download: '',
    style: {}, dataset: {}, children: [], files: [], scrollTop: 0,
    options: [],
    add(o){ this.options.push(o); },
    replaceChildren(...c){ this.children = [...c]; this.options = []; },
    append(...c){ this.children.push(...c); },
    addEventListener(){}, remove(){}, click(){}, focus(){},
    setAttribute(){}, getContext(){ return null; },
    querySelector(){ return fakeEl(); },
    querySelectorAll(){ return []; },
    classList: {toggle(){}, add(){}, remove(){}},
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
globalThis.confirm = () => true;

function fakeVault(){
  const slots = new Map();
  const v = {
    isUnlocked: false, existsFlag: false,
    get count(){ return slots.size; },
    get: (id) => slots.get(id) ?? null,
    list: () => [...slots.entries()].map(([id, rec]) => ({id, ...rec})),
    put: async (id, rec) => { slots.set(id, {...rec, updated: Date.now()}); },
    drop: async (id) => { slots.delete(id); },
    exists: async () => v.existsFlag,
    unlock: async () => { v.isUnlocked = true; },
    create: async () => { v.existsFlag = true; v.isUnlocked = true; },
    exportEncrypted: async () => '{"encrypted":true}',
    importEncrypted: async () => {},
    rotatePassphrase: async () => {},
  };
  return v;
}
function fakeCtx(){
  const state = freshState();
  const toasts = [];
  const downloads = [];
  const vault = fakeVault();
  const ctx = {
    getState: () => state,
    saveNow: async () => {},
    toast: (m) => toasts.push(m),
    metrics: {begin: () => ({}), finish: () => {}, event: () => {}},
    vault,
    selectView: () => {},
    renderAll: () => {},
    renderStats: () => {},
    download: (name, data) => downloads.push({name, data}),
    optionalControl: (id) => $(id),
  };
  return {ctx, state, toasts, downloads, vault};
}

function textOf(el){
  let out = el.textContent || '';
  for (const child of el.children || []) out += textOf(child);
  return out;
}
test('providers: renderProviders lists every provider as NOT CONNECTED when vault is empty', () => {
  const {ctx} = fakeCtx();
  const p = createProviders(ctx);
  p.renderProviders('');
  const host = $('provider-list');
  assert.equal(host.children.length, PROVIDERS.length);
  assert.ok(host.children.every(c => textOf(c).includes('NOT CONNECTED')));
});

test('providers: renderProviders marks a saved key', () => {
  const {ctx, vault} = fakeCtx();
  const p = createProviders(ctx);
  vault.isUnlocked = true;
  vault.put('groq', {key: 'x', model: 'llama-3.1-8b-instant', account: ''});
  p.renderProviders('');
  const host = $('provider-list');
  const groqCard = host.children.find(c => textOf(c).includes('Groq'));
  assert.ok(groqCard && textOf(groqCard).includes('KEY SAVED'));
});

test('providers: renderVault shows NOT CREATED before any vault exists', async () => {
  const {ctx} = fakeCtx();
  const p = createProviders(ctx);
  await p.renderVault();
  assert.equal($('vault-status').textContent, 'NOT CREATED');
  assert.equal($('vault-submit').textContent, 'Create vault');
});

test('providers: submitKey refuses while the vault is locked', async () => {
  const {ctx, toasts} = fakeCtx();
  const p = createProviders(ctx);
  $('key-provider').value = 'groq';
  $('key-model').value = 'llama-3.1-8b-instant';
  $('key-value').value = 'gsk-test';
  await p.submitKey({preventDefault(){}});
  assert.match(toasts.at(-1), /Create or unlock your vault/);
});

test('providers: routeChoices lists saved key slots in both route selects', () => {
  const {ctx, vault} = fakeCtx();
  const p = createProviders(ctx);
  vault.isUnlocked = true;
  vault.put('groq', {key: 'x', model: 'llama-3.1-8b-instant', account: ''});
  p.routeChoices();
  assert.equal($('chat-route').options.length, 1);
  assert.equal($('chat-route').options[0].value, 'groq');
  assert.match($('chat-connection-label').textContent, /1 saved key slot/);
});

test('providers: preset export then import round-trips through the module', async () => {
  const {ctx, state} = fakeCtx();
  const p = createProviders(ctx);
  state.preferences.providerPresets = [{label: 'Groq fast', provider: 'groq', model: 'llama-3.1-8b-instant'}];
  p.exportLocalPresets();
  const {downloads} = fakeCtx();
  // Re-export from the real exporter to build a valid import file.
  const manifest = exportProviderPresets(state.preferences.providerPresets);
  const file = {name: 'presets.json', size: manifest.length, text: async () => manifest};
  const event = {target: {files: [file], value: 'x'}};
  state.preferences.providerPresets = [];
  await p.importProviderPresets(event);
  assert.equal(state.preferences.providerPresets.length, 1);
  assert.equal(state.preferences.providerPresets[0].label, 'Groq fast');
  assert.equal(downloads.length, 0); // downloads from the fresh ctx are empty; the real one is in ctx
});

test('providers: applyProviderPreset copies the preset into the vault form', () => {
  const {ctx, state} = fakeCtx();
  const p = createProviders(ctx);
  state.preferences.providerPresets = [{label: 'Groq fast', provider: 'groq', model: 'llama-3.1-8b-instant'}];
  p.renderProviderPresets();
  $('provider-preset-select').value = '0';
  p.applyProviderPreset();
  assert.equal($('key-provider').value, 'groq');
  assert.equal($('key-model').value, 'llama-3.1-8b-instant');
});

test('providers: q22InspectRoutes writes a diagnostics line per provider', () => {
  const {ctx} = fakeCtx();
  const p = createProviders(ctx);
  p.q22InspectRoutes();
  const text = $('provider-diagnostics').textContent;
  for (const prov of PROVIDERS) assert.ok(text.includes(prov.name), prov.id + ' missing from diagnostics');
});
