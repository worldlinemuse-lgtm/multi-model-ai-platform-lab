import test from 'node:test';
import assert from 'node:assert/strict';
import {createChat} from '../src/chat.js';
import {freshState} from '../src/core.js';

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
globalThis.prompt = () => null;
globalThis.confirm = () => true;
Object.defineProperty(globalThis, 'navigator', {value: {onLine: true}, configurable: true});

function fakeCtx(callProvider){
  const state = freshState();
  const audits = [];
  const toasts = [];
  const downloads = [];
  const slots = new Map([['groq', {key: 'gsk-test', model: 'llama-3.1-8b-instant', account: ''}]]);
  const ctx = {
    getState: () => state,
    thread: () => state.threads.find(t => t.id === state.activeThreadId) || state.threads[0],
    project: () => state.projects.find(p => p.id === state.activeProjectId) || state.projects[0],
    saveSoon: () => {},
    saveNow: async () => {},
    audit: (op, provider, status, usage, meta) => audits.push({op, provider, status, usage, meta}),
    toast: (m) => toasts.push(m),
    metrics: {begin: () => ({}), finish: () => {}, event: () => {}},
    vault: {get: (id) => slots.get(id) ?? null, list: () => [...slots.keys()].map(id => ({id, ...slots.get(id)}))},
    selectView: () => {},
    routeChoices: () => {},
    download: (name, data) => downloads.push({name, data}),
    callProvider: callProvider || (async () => ({text: 'hello from the model', model: 'llama-3.1-8b-instant', usage: {total_tokens: 5}, httpStatus: 200})),
    isDurableStorage: () => true,
  };
  return {ctx, state, audits, toasts, downloads};
}

test('chat: sendMessage records user + assistant, audits requested and success', async () => {
  const {ctx, state, audits} = fakeCtx();
  const chat = createChat(ctx);
  $('chat-input').value = 'Hello, model';
  $('chat-route').value = 'groq';
  await chat.sendMessage({preventDefault(){}});
  const t = state.threads[0];
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[0].role, 'user');
  assert.equal(t.messages[0].content, 'Hello, model');
  assert.equal(t.messages[1].role, 'assistant');
  assert.equal(t.messages[1].content, 'hello from the model');
  assert.deepEqual(audits.map(a => a.status), ['requested', 'success']);
  assert.equal(audits[1].usage.total_tokens, 5);
  assert.equal($('chat-input').value, '');
  assert.equal(chat.chatBusy(), false);
});

test('chat: sendMessage refuses when no key is saved for the route', async () => {
  const {ctx, state, toasts} = fakeCtx();
  const chat = createChat(ctx);
  $('chat-input').value = 'Hello';
  $('chat-route').value = 'openai';
  await chat.sendMessage({preventDefault(){}});
  assert.equal(state.threads[0].messages.length, 0);
  assert.match(toasts.at(-1), /Unlock your vault/);
});

test('chat: second send while one is in flight is rejected', async () => {
  let resolveCall;
  const pending = new Promise(r => { resolveCall = r; });
  const {ctx, toasts} = fakeCtx(async () => pending);
  const chat = createChat(ctx);
  $('chat-input').value = 'First';
  $('chat-route').value = 'groq';
  const first = chat.sendMessage({preventDefault(){}});
  $('chat-input').value = 'Second';
  await chat.sendMessage({preventDefault(){}});
  assert.match(toasts.at(-1), /already in progress|already running/);
  resolveCall({text: 'done', model: 'llama-3.1-8b-instant', usage: {total_tokens: 1}, httpStatus: 200});
  await first;
});

test('chat: recordMessage truncates an oversized assistant reply', () => {
  const {ctx, state} = fakeCtx();
  const chat = createChat(ctx);
  const stored = chat.recordMessage(state.threads[0], {role: 'assistant', content: 'B'.repeat(35000)});
  assert.ok(stored.content.includes('[truncated'));
  assert.ok(stored.content.includes('35000 characters'));
  assert.ok(stored.content.length < 35000);
});

test('chat: failed save before dispatch restores the prompt and sends nothing', async () => {
  const {ctx, state, toasts} = fakeCtx();
  let calls = 0;
  ctx.callProvider = async () => { calls++; return {text: 'x', model: 'm', usage: {}, httpStatus: 200}; };
  ctx.saveNow = async () => { throw Error('disk full'); };
  const chat = createChat(ctx);
  $('chat-input').value = 'Do not lose me';
  $('chat-route').value = 'groq';
  await chat.sendMessage({preventDefault(){}});
  assert.equal(calls, 0);
  assert.equal(state.threads[0].messages.length, 0);
  assert.equal($('chat-input').value, 'Do not lose me');
  assert.match(toasts.at(-1), /could not be saved locally/);
});

test('chat: new, clear and delete thread', () => {
  const {ctx, state} = fakeCtx();
  const chat = createChat(ctx);
  chat.newThread();
  assert.equal(state.threads.length, 2);
  chat.recordMessage(state.threads[1], {role: 'user', content: 'hi'});
  chat.clearThread();
  assert.equal(state.threads[1].messages.length, 0);
  chat.deleteThread();
  assert.equal(state.threads.length, 1);
});

test('chat: stopChat aborts an in-flight request', async () => {
  const {ctx, state} = fakeCtx(async (route, cred, msgs, {signal}) => {
    await new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), {name: 'AbortError'}))); });
  });
  const chat = createChat(ctx);
  $('chat-input').value = 'Slow one';
  $('chat-route').value = 'groq';
  const sending = chat.sendMessage({preventDefault(){}});
  // Let the send reach dispatch (the controller is registered after the
  // persist-before-dispatch save resolves) before stopping it.
  await new Promise(r => setTimeout(r, 0));
  chat.stopChat();
  await sending;
  const msgs = state.threads[0].messages;
  assert.equal(msgs.at(-1).content, 'Request stopped.');
  assert.equal(msgs.at(-1).error, true);
});
