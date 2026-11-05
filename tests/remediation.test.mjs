import test from 'node:test';
import assert from 'node:assert/strict';
import {freshState,validateState,clone,MAX_NOTES} from '../src/core.js';
import {parseDataset,analyzeDataset,numericValue} from '../src/data-parse.js';
import {parseReportedUsage,callProvider} from '../src/provider-api.js';

const valid=()=>freshState();
test('D01 P32: rejected missing or invalid settings and thread references',()=>{
 const s=valid();assert.equal(validateState(s),true);
 for(const alter of [
  x=>delete x.preferences,
  x=>x.threads=[],
  x=>x.activeThreadId='missing',
  x=>x.preferences.compact='yes',
  x=>x.preferences.accent='bad',
  x=>x.projects[0].active='absent.js',
  x=>x.projects[0].id=null,
  x=>x.threads[0].messages=[{role:'assistant',content:null}],
  x=>x.notes=[{title:'no id',content:'x',created:'now'}],
  x=>x.audit=[null],
  x=>x.workflows=[{id:'broken'}],
  x=>x.snapshots=[{id:'snap',at:'now',label:'x',project:{id:'p',name:'x',active:'missing',updated:'now',files:{'a.js':'x'}}}],
 ]){const c=clone(s);alter(c);assert.equal(validateState(c),false,JSON.stringify(c).slice(0,240));}
});
test('D01 P32: valid populated workspace, snapshots, notes, workflows, audit roundtrip',()=>{
 const s=valid(),p=s.projects[0];
 s.snapshots.push({id:'snapshot-1',at:'2026-10-12T01:00:00Z',label:'checkpoint',project:clone(p)});
 s.notes.push({id:'note-1',title:'A',content:'Note',created:'now'});
 s.threads[0].messages.push({role:'user',content:'hi',at:'now'},{role:'assistant',provider:'groq',model:'model',content:'hello',at:'now'});
 s.audit.push({id:'event-1',at:'now',op:'inference',provider:'groq',status:'success',usage:{prompt_tokens:null,completion_tokens:2,total_tokens:null,source:'provider_reported'}});
 s.workflows.push({id:'wf-1',at:'now',provider:'groq',template:'research',goal:'goal',status:'complete',steps:[{stage:'Plan',content:'result',model:'model'}]});
 assert.equal(validateState(s),true);
 assert.equal(validateState(JSON.parse(JSON.stringify(s))),true);
});
test('D03: blank and invalid numeric cells are absent, not zero',()=>{
 for(const value of ['', ' ', '\t', null, undefined, false, true, 'N/A', {}, [], Infinity])assert.equal(numericValue(value),null);
 assert.equal(numericValue('0'),0); assert.equal(numericValue(0),0);assert.equal(numericValue(' -3.25 '),-3.25);
 const d=parseDataset('label,value\nA,10\nB,\nC,20\nD,not available\nE,0');
 const x=analyzeDataset(d).stats.value;assert.deepEqual(x,{count:3,min:0,max:20,mean:10});
 const sample=analyzeDataset(parseDataset('label,value\nA,10\nB,\nC,20')).stats.value;
 assert.deepEqual(sample,{count:2,min:10,max:20,mean:15});
});
test('P07: unreported tokens remain unknown and reported zero stays zero',()=>{
 assert.deepEqual(parseReportedUsage({total_tokens:4}),{prompt_tokens:null,completion_tokens:null,total_tokens:4,source:'provider_reported'});
 assert.deepEqual(parseReportedUsage({prompt_tokens:0}),{prompt_tokens:0,completion_tokens:null,total_tokens:null,source:'provider_reported'});
 assert.equal(parseReportedUsage(null),null);
 assert.equal(parseReportedUsage({total_tokens:'unknown'}).total_tokens,null);
});
test('P07: missing Gemini usage fields remain unknown in actual provider adapter',async()=>{
 const orig=globalThis.fetch;globalThis.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({candidates:[{content:{parts:[{text:'test'}]}}],usageMetadata:{totalTokenCount:8}})});
 try{const r=await callProvider('gemini',{model:'gemini-2.5-flash-lite',key:'fake',attested:true},[{role:'user',content:'go'}]);assert.deepEqual(r.usage,{prompt_tokens:null,completion_tokens:null,total_tokens:8,source:'provider_reported'});}finally{globalThis.fetch=orig;}
});

import {historyForRoute} from '../src/core.js';
import {parseNoteArchive,exportNoteArchive,NOTES_FORMAT} from '../src/knowledge.js';
test('D07: model comparison histories are separated by provider, errors excluded',()=>{
 const messages=[{role:'user',content:'initial'}, {role:'assistant',provider:'groq',content:'Groq answer'}, {role:'assistant',provider:'gemini',content:'Gemini answer'}, {role:'user',content:'followup'}, {role:'assistant',provider:'groq',content:'network error',error:true}];
 assert.deepEqual(historyForRoute(messages,'groq'),[{role:'user',content:'initial'},{role:'assistant',content:'Groq answer'},{role:'user',content:'followup'}]);
 assert.deepEqual(historyForRoute(messages,'gemini'),[{role:'user',content:'initial'},{role:'assistant',content:'Gemini answer'},{role:'user',content:'followup'}]);
});
test('D08: knowledge note export is losslessly re-importable, including prior array format',()=>{
 const notes=[{id:'note-a',title:'Work',content:'Notes line 1\nLine 2',created:'2026-10-11T00:00:00Z'}];
 const serialized=exportNoteArchive(notes);assert.equal(JSON.parse(serialized).format,NOTES_FORMAT);
 assert.deepEqual(parseNoteArchive(serialized),notes.map(({title,content,created})=>({title,content,created})));
 assert.deepEqual(parseNoteArchive(JSON.stringify(notes)),parseNoteArchive(serialized));
 assert.equal(parseNoteArchive('{"arbitrary":"json"}'),null);
 assert.throws(()=>parseNoteArchive(JSON.stringify({format:NOTES_FORMAT,notes:[{title:1,content:'x',id:'id',created:'now'}]})),/invalid record/);
});

test('P23: pinned snapshots survive validated backup roundtrip; nonboolean pin rejected',()=>{
 const data=freshState();
 const snap={id:'snapshot-verified-1',at:'2026-10-12T19:40:00Z',label:'Pinned',project:clone(data.projects[0]),pinned:true};
 data.snapshots=[snap];
 assert.equal(validateState(data),true);
 assert.equal(validateState(JSON.parse(JSON.stringify(data))),true);
 data.snapshots[0].pinned='yes';
 assert.equal(validateState(data),false);
 delete data.snapshots[0].pinned;
 assert.equal(validateState(data),true,'older snapshots lacking pinned field must remain importable');
});
