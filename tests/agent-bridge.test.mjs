// Agent tool bridge (local Simone build, 2026-11-13): registry, validation, provider transport, loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_TOOLS,toolDefinitions,parseToolArguments,validateToolArguments,toolByName,needsApproval,formatToolResult} from '../src/agent-tools.js';
import {runToolLoop} from '../src/agent-loop.js';
import {buildRequest,callProvider,parseToolCalls,toolConversationWindow} from '../src/provider-api.js';
import {workerPrelude,frameSubtleRelay} from '../src/sandbox-prelude.js';

const cred={model:'openai/gpt-oss-20b',key:'gsk_test_not_real',attested:true};
const groqToolReply=(calls,text=null)=>({choices:[{finish_reason:calls?'tool_calls':'stop',message:{role:'assistant',content:text,tool_calls:calls}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15},model:'openai/gpt-oss-20b'});
const fakeFetch=replies=>{const seen=[];const f=async(url,init)=>{seen.push(JSON.parse(init.body));const body=replies.shift();return new Response(JSON.stringify(body.payload??body),{status:body.status??200,headers:{'content-type':'application/json'}});};f.seen=seen;return f;};

test('registry exposes OpenAI-compatible function definitions', ()=>{
 const defs=toolDefinitions();
 assert.equal(defs.length,AGENT_TOOLS.length);
 for(const d of defs){assert.equal(d.type,'function');assert.match(d.function.name,/^[a-z_]+$/);assert.equal(d.function.parameters.type,'object');}
 assert.throws(()=>toolDefinitions(['rm_rf']),/Unknown agent tool/);
});

test('argument parsing and validation reject malformed or unsafe input', ()=>{
 assert.deepEqual(parseToolArguments(''),{});
 assert.throws(()=>parseToolArguments('{bad'),/not valid JSON/);
 assert.throws(()=>parseToolArguments('[1]'),/JSON object/);
 const js=toolByName('run_javascript'),rf=toolByName('read_file'),pe=toolByName('propose_edit');
 assert.deepEqual(validateToolArguments(js,{code:'1+1'}),[]);
 assert.match(validateToolArguments(js,{}).join(),/missing required argument "code"/);
 assert.match(validateToolArguments(js,{code:5}).join(),/must be a string/);
 assert.match(validateToolArguments(js,{code:'x',shell:true}).join(),/unexpected argument "shell"/);
 assert.match(validateToolArguments(js,{code:'   '}).join(),/empty/);
 assert.match(validateToolArguments(rf,{name:'../etc/passwd'}).join(),/not a safe project path/);
 assert.match(validateToolArguments(pe,{name:'a.js'}).join(),/content/);
 assert.match(validateToolArguments(js,{code:'x'.repeat(20001)}).join(),/longer than 20000/);
});

test('approval policy: writes always ask, reads auto by default, runs ask unless auto-approved', ()=>{
 assert.equal(needsApproval(toolByName('propose_edit'),{autoRead:true,autoExecute:true}),true);
 assert.equal(needsApproval(toolByName('read_file')),false);
 assert.equal(needsApproval(toolByName('run_python')),true);
 assert.equal(needsApproval(toolByName('run_python'),{autoRead:true,autoExecute:true}),false);
 assert.match(formatToolResult('x'.repeat(9000)),/truncated/);
});

test('buildRequest without tools is unchanged; with tools it sends tools and tool history', ()=>{
 const plain=buildRequest('groq',cred,[{role:'user',content:'hi'}]);
 const body=plain.body;
 assert.equal(body.tools,undefined);assert.equal(body.tool_choice,undefined);
 const msgs=[{role:'system',content:'s'},{role:'user',content:'u'},{role:'assistant',content:'',tool_calls:[{id:'c1',type:'function',function:{name:'run_javascript',arguments:'{"code":"1"}'}}]},{role:'tool',tool_call_id:'c1',content:'{"output":"1"}'}];
 const withTools=buildRequest('groq',cred,msgs,{tools:toolDefinitions(),toolChoice:'auto'}).body;
 assert.equal(withTools.tools.length,AGENT_TOOLS.length);assert.equal(withTools.tool_choice,'auto');
 assert.deepEqual(withTools.messages.map(m=>m.role),['system','user','assistant','tool']);
 assert.equal(withTools.messages[2].content,undefined,'empty assistant content is omitted when tool_calls exist');
 const none=buildRequest('groq',cred,msgs,{tools:toolDefinitions(),toolChoice:'none'}).body;
 assert.equal(none.tools,undefined);assert.equal(none.tool_choice,undefined);assert.equal(none.messages.at(-1).role,'tool');
 assert.throws(()=>buildRequest('gemini',{...cred,model:'gemini-2.5-flash'},msgs,{tools:toolDefinitions()}),/OpenAI-compatible|Unsupported|model/i);
 assert.throws(()=>buildRequest('groq',cred,msgs,{tools:[{type:'function',function:{name:'bad name',description:'',parameters:{}}}]}),/Invalid tool definition/);
});

test('tool window keeps system, drops orphaned tool results at the cut', ()=>{
 const msgs=[{role:'system',content:'s'}];
 for(let i=0;i<20;i++)msgs.push({role:'assistant',content:'',tool_calls:[{id:'c'+i,type:'function',function:{name:'run_javascript',arguments:'{}'}}]},{role:'tool',tool_call_id:'c'+i,content:'r'});
 const w=toolConversationWindow(msgs,6);
 assert.equal(w[0].role,'system');assert.notEqual(w[1].role,'tool');
 const ids=new Set(w.flatMap(m=>m.tool_calls?.map(c=>c.id)||[]));
 assert.ok(w.filter(m=>m.role==='tool').every(m=>ids.has(m.tool_call_id)));
});

test('callProvider returns tool calls instead of failing with "no text"', async()=>{
 const orig=globalThis.fetch;
 try{
  globalThis.fetch=fakeFetch([groqToolReply([{id:'call_1',type:'function',function:{name:'run_python',arguments:'{"code":"print(2)"}'}}])]);
  const r=await callProvider('groq',cred,[{role:'user',content:'go'}],{tools:toolDefinitions()});
  assert.equal(r.text,'');assert.equal(r.toolCalls.length,1);assert.equal(r.toolCalls[0].name,'run_python');assert.equal(r.finishReason,'tool_calls');
  globalThis.fetch=fakeFetch([groqToolReply(undefined,null)]);
  await assert.rejects(callProvider('groq',cred,[{role:'user',content:'go'}],{tools:toolDefinitions()}),/neither text nor a tool call/);
  globalThis.fetch=fakeFetch([groqToolReply(undefined,null)]);
  await assert.rejects(callProvider('groq',cred,[{role:'user',content:'go'}]),/API returned no text/,'legacy path unchanged');
  globalThis.fetch=fakeFetch([{status:400,payload:{error:{message:'Failed to call a function',code:'tool_use_failed',failed_generation:'<bad>'}}}]);
  await assert.rejects(callProvider('groq',cred,[{role:'user',content:'go'}],{tools:toolDefinitions()}),e=>e.code==='tool_use_failed'&&e.httpStatus===400&&!String(e.message).includes('gsk_'));
 }finally{globalThis.fetch=orig;}
 assert.deepEqual(parseToolCalls([{function:{name:'x',arguments:{a:1}}}]),[{id:'call_0',name:'x',arguments:'{"a":1}'}]);
});

const scripted=steps=>{const calls=[];const call=async(convo,opts)=>{calls.push({convo:structuredClone(convo),opts});const s=steps.shift();if(s instanceof Error)throw s;return s;};call.calls=calls;return call;};
const tc=(id,name,args)=>({id,name,arguments:typeof args==='string'?args:JSON.stringify(args)});

test('loop: tool call -> execute -> result returned -> final text, multi-turn', async()=>{
 const call=scripted([{text:'',toolCalls:[tc('a','run_javascript',{code:'console.log(6*7)'})]},{text:'',toolCalls:[tc('b','list_files',{})]},{text:'The answer is 42.',toolCalls:[]}]);
 const executed=[];
 const r=await runToolLoop({call,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async({tool,args})=>{executed.push(tool.name);return tool.name==='run_javascript'?{status:'ok',output:'42'}:{files:[]};}});
 assert.equal(r.status,'final');assert.equal(r.text,'The answer is 42.');assert.equal(r.rounds,3);assert.equal(r.toolCalls,2);
 assert.deepEqual(executed,['run_javascript','list_files']);
 const last=call.calls[2].convo;
 assert.deepEqual(last.map(m=>m.role),['user','assistant','tool','assistant','tool']);
 assert.equal(last[2].tool_call_id,'a');assert.match(last[2].content,/42/);
 assert.equal(call.calls[0].opts.tools.length,AGENT_TOOLS.length);
});

test('loop: invalid args, unknown tool, denial and executor errors are returned to the model, not executed', async()=>{
 const call=scripted([{text:'',toolCalls:[tc('1','run_javascript','{oops'),tc('2','delete_everything',{}),tc('3','run_python',{code:'print(1)'}),tc('4','run_javascript',{code:'x'}),tc('5','read_file',{name:'../x'})]},{text:'ok',toolCalls:[]}]);
 const executed=[];
 const r=await runToolLoop({call,messages:[{role:'user',content:'q'}],approve:async({tool})=>tool.name!=='run_python',execute:async({tool})=>{executed.push(tool.name);throw Error('boom');}});
 assert.equal(r.status,'final');
 assert.deepEqual(executed,['run_javascript']);
 const results=call.calls[1].convo.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content).error);
 assert.deepEqual(results,['invalid_arguments','unknown_tool','denied','execution_failed','invalid_arguments']);
});

test('loop: approval preview failure is reported as rejected', async()=>{
 const call=scripted([{text:'',toolCalls:[tc('e','propose_edit',{name:'a.js',content:'same'})]},{text:'fine',toolCalls:[]}]);
 const r=await runToolLoop({call,messages:[{role:'user',content:'q'}],approve:async()=>{throw Error('No change to review.');},execute:async()=>assert.fail('must not execute')});
 assert.equal(r.status,'final');
 assert.deepEqual(JSON.parse(call.calls[1].convo.at(-1).content),{error:'rejected',detail:'No change to review.'});
});

test('loop: bounded rounds, final round forces tool_choice none, budget enforced', async()=>{
 const forever=()=>({text:'',toolCalls:[tc('x'+Math.random(),'list_files',{})]});
 const call=scripted(Array.from({length:10},forever));
 const r=await runToolLoop({call,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>({}),limits:{maxRounds:3}});
 assert.equal(r.status,'limit');assert.equal(r.rounds,3);
 assert.deepEqual(call.calls.map(c=>c.opts.toolChoice),['auto','auto','none']);
 assert.match(call.calls[2].convo.at(-1).content,/Tool budget for this request is used up/);
 const failing=scripted([forever(),Object.assign(Error('groq: HTTP 400 \u2014 Tool choice is none, but model called a tool'),{code:'tool_use_failed'})]);
 const rf=await runToolLoop({call:failing,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>({}),limits:{maxRounds:2}});
 assert.equal(rf.status,'limit');assert.match(rf.reason,/wrap-up reply failed/);
 const many=scripted([{text:'',toolCalls:Array.from({length:5},(_,i)=>tc('m'+i,'list_files',{}))},{text:'done',toolCalls:[]}]);
 let n=0;const r2=await runToolLoop({call:many,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>{n++;return {};},limits:{maxToolCalls:2}});
 assert.equal(n,2);assert.equal(r2.toolCalls,2);
 assert.equal(many.calls[1].convo.filter(m=>m.role==='tool'&&/budget/.test(m.content)).length,3);
});

test('loop: abort stops cleanly; provider tool_use_failed retried once; other errors end run', async()=>{
 const ac=new AbortController();
 const call=scripted([{text:'',toolCalls:[tc('s','run_javascript',{code:'1'})]}]);
 const r=await runToolLoop({call,messages:[{role:'user',content:'q'}],signal:ac.signal,approve:async()=>{ac.abort();return false;},execute:async()=>assert.fail()});
 assert.equal(r.status,'stopped');
 const bad=Object.assign(Error('groq: HTTP 400 — Failed to call a function'),{code:'tool_use_failed'});
 const call2=scripted([bad,{text:'recovered',toolCalls:[]}]);
 const r2=await runToolLoop({call:call2,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>({})});
 assert.equal(r2.status,'final');assert.equal(r2.text,'recovered');assert.match(call2.calls[1].convo.at(-1).content,/rejected by the provider/);
 const call3=scripted([bad,bad]);
 const r3=await runToolLoop({call:call3,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>({})});
 assert.equal(r3.status,'error');
 const events=[];const call4=scripted([Error('HTTP 429')]);
 const r4=await runToolLoop({call:call4,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>({}),onEvent:e=>events.push(e.type)});
 assert.equal(r4.status,'error');assert.deepEqual(events,['request','error']);
});

test('sandbox prelude: drains timers, reports unhandled rejections, exposes subtle relay', async()=>{
 const src=workerPrelude();
 assert.match(src,/unhandledrejection/);assert.match(src,/__mmDrain/);assert.match(src,/subtle-call/);
 assert.match(frameSubtleRelay(),/__mmRelay/);
 // Execute the prelude in a fake worker scope to prove timer output after the body returns is kept.
 const saved={setTimeout,clearTimeout,setInterval,clearInterval};
 const posted=[];
 const scope={postMessage:m=>posted.push(m)};
 const fn=new Function('self',src+';return {logs,__mmDrain,__mm};');
 const {logs,__mmDrain}=fn(scope);
 setTimeout(()=>logs.log('late'),20);
 assert.equal(await __mmDrain(),true);
 assert.deepEqual(posted.map(p=>p.message),['late']);
 Object.assign(globalThis,saved);
});

test('loop: 429 with a short provider-named wait is retried in the same round; long waits are not', async()=>{
 const rl=ms=>Object.assign(Error('groq: HTTP 429 — Rate limit reached'),{httpStatus:429,retryAfterMs:ms});
 const waits=[];const wait=async ms=>{waits.push(ms);};
 const call=scripted([rl(1200),{text:'after wait',toolCalls:[]}]);
 const r=await runToolLoop({call,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>({}),wait});
 assert.equal(r.status,'final');assert.equal(r.rounds,1);assert.deepEqual(waits,[1700]);
 const call2=scripted([rl(90000)]);
 const r2=await runToolLoop({call:call2,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>({}),wait});
 assert.equal(r2.status,'error');
 const call3=scripted([rl(10),rl(10),rl(10)]);
 const r3=await runToolLoop({call:call3,messages:[{role:'user',content:'q'}],approve:async()=>true,execute:async()=>({}),wait:async()=>{}});
 assert.equal(r3.status,'error');assert.equal(call3.calls.length,3);
});

test('provider error exposes retryAfterMs parsed from Groq 429 text', async()=>{
 const orig=globalThis.fetch;
 try{
  globalThis.fetch=fakeFetch([{status:429,payload:{error:{message:'Rate limit reached ... Please try again in 11.865s. Need more tokens?',code:'rate_limit_exceeded'}}}]);
  await assert.rejects(callProvider('groq',cred,[{role:'user',content:'go'}],{tools:toolDefinitions()}),e=>e.httpStatus===429&&e.retryAfterMs===11865);
 }finally{globalThis.fetch=orig;}
});
