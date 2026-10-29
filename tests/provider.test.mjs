import test from 'node:test';import assert from 'node:assert/strict';
import {validateModel,buildRequest,callProvider} from '../src/provider-api.js';
globalThis.location={origin:'https://example.github.io'};
const key={key:'fake-test-key',model:'openrouter/free',attested:true,account:'0'.repeat(32)};
test('paid OpenRouter model blocked and direct endpoints fixed',()=>{assert.throws(()=>validateModel('openrouter','some/paid'));assert.doesNotThrow(()=>validateModel('openrouter','org/model:free'));assert.doesNotThrow(()=>validateModel('openrouter','openrouter/free'));assert.equal(buildRequest('openrouter',key,[{role:'user',content:'hello'}]).url,'https://openrouter.ai/api/v1/chat/completions');assert.throws(()=>buildRequest('cloudflare',{...key,model:'@cf/meta/llama-3.1-8b-instruct',account:'invalid'},[{role:'user',content:'x'}]));});
test('all eight provider routes form authorized HTTPS API payloads',()=>{const routes={groq:'llama-3.3-70b-versatile',openrouter:'openrouter/free',gemini:'gemini-2.5-flash-lite',cloudflare:'@cf/meta/llama-3.1-8b-instruct',mistral:'mistral-small-latest',ollama:'gemma4:31b',huggingface:'openai/gpt-oss-120b:fastest',aion:'aion-labs/aion-3.5'};for(const [id,model] of Object.entries(routes)){const req=buildRequest(id,{...key,model},[{role:'user',content:'Say hello'}]);assert.ok(req.url.startsWith('https://'),id);assert.ok(req.body);assert.ok(req.headers);}});
test('a successful OpenRouter response records model and reported usage',async()=>{const original=globalThis.fetch;globalThis.fetch=async(url,opts)=>({ok:true,status:200,text:async()=>JSON.stringify({model:'openrouter/free',choices:[{message:{content:'hello test'}}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}})});try{const r=await callProvider('openrouter',key,[{role:'user',content:'say hello'}]);assert.equal(r.text,'hello test');assert.equal(r.usage.total_tokens,6);assert.equal(r.usage.source,'provider_reported');}finally{globalThis.fetch=original;}});
test('Gemini direct REST response parser',async()=>{const orig=globalThis.fetch;globalThis.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({candidates:[{content:{parts:[{text:'Gemini response'}]}}],usageMetadata:{totalTokenCount:3}})});try{const r=await callProvider('gemini',{...key,model:'gemini-2.5-flash-lite'},[{role:'user',content:'hi'}]);assert.equal(r.text,'Gemini response');assert.equal(r.usage.total_tokens,3);}finally{globalThis.fetch=orig;}});
test('errors distinguish CORS failures and unauthorized plan',async()=>{const orig=globalThis.fetch;globalThis.fetch=async()=>{throw TypeError('Failed to fetch')};try{await assert.rejects(()=>callProvider('openrouter',key,[{role:'user',content:'x'}]),/CORS/)}finally{globalThis.fetch=orig;}assert.throws(()=>buildRequest('openrouter',{...key,attested:false},[{role:'user',content:'x'}]),/attestation/);});

test('P28 deadline aborts stalled requests once',async()=>{
 const original=globalThis.fetch;let attempts=0;
 globalThis.fetch=(_url,options)=>{attempts++;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));};
 try{
  await assert.rejects(callProvider('openrouter',key,[{role:'user',content:'check'}],{timeoutMs:25}),/timed out/);
  assert.equal(attempts,1);
 }finally{globalThis.fetch=original;}
});

test('P28 respects caller cancellation',async()=>{
 const original=globalThis.fetch,abort=new AbortController();
 globalThis.fetch=(_url,options)=>new Promise((resolve,reject)=>{
  if(options.signal.aborted)return reject(options.signal.reason);
  options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
 });
 try{
  const pending=callProvider('openrouter',key,[{role:'user',content:'cancel'}],{signal:abort.signal,timeoutMs:5000});
  abort.abort();
  await assert.rejects(pending,e=>e.name==='AbortError');
 }finally{globalThis.fetch=original;}
});


test('Cloudflare Workers AI preserves system instructions and message order',()=>{
 const cfg={...key,model:'@cf/meta/llama-3.1-8b-instruct-fp8',account:'0'.repeat(32)};
 const messages=[{role:'system',content:'Mandatory safety and workflow instructions'},{role:'user',content:'First query'},{role:'assistant',content:'Prior answer'},{role:'user',content:'Second query'}];
 const req=buildRequest('cloudflare',cfg,messages,{maxOutputTokens:256});
 assert.deepEqual(req.body.messages,messages);
 assert.equal(req.body.max_tokens,256);
 assert.equal(req.url,'https://api.cloudflare.com/client/v4/accounts/'+cfg.account+'/ai/run/'+cfg.model);
});
test('Cloudflare does not silently strip a system-only request',()=>{
 const req=buildRequest('cloudflare',{...key,model:'@cf/meta/llama-3.1-8b-instruct-fp8'},[{role:'system',content:'System constraints'}]);
 assert.deepEqual(req.body.messages,[{role:'system',content:'System constraints'}]);
});

test('provider adapter rejects excessive chunked response bodies before JSON parsing',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){
  const bytes=new Uint8Array(600_000);
  c.enqueue(bytes);c.enqueue(bytes);c.close();
 }}),{status:200,headers:{'content-type':'application/json'}});
 try{await assert.rejects(callProvider('openrouter',key,[{role:'user',content:'check response limit'}]),/exceeds the 1048576-byte limit/i);}
 finally{globalThis.fetch=original;}
});

test('provider adapter parses a streamed successful response and preserves token usage',async()=>{
 const original=globalThis.fetch;
 const payload=JSON.stringify({model:'openrouter/free',choices:[{message:{content:'streamed JSON body'}}],usage:{prompt_tokens:3,completion_tokens:4,total_tokens:7}});
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){
  const bytes=new TextEncoder().encode(payload);
  c.enqueue(bytes.slice(0,7));c.enqueue(bytes.slice(7));c.close();
 }}),{status:200,headers:{'content-type':'application/json'}});
 try{const result=await callProvider('openrouter',key,[{role:'user',content:'check streamed JSON'}]);assert.equal(result.text,'streamed JSON body');assert.equal(result.usage.total_tokens,7);}
 finally{globalThis.fetch=original;}
});
