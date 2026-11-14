import {providerById} from './core.js';
import {validateOutputCap} from './model-request-settings.js';
import {readBoundedResponseText,ResponseTooLargeError} from './bounded-response.js';
const ENDPOINTS=Object.freeze({groq:'https://api.groq.com/openai/v1/chat/completions',openrouter:'https://openrouter.ai/api/v1/chat/completions',mistral:'https://api.mistral.ai/v1/chat/completions',ollama:'https://ollama.com/v1/chat/completions',huggingface:'https://router.huggingface.co/v1/chat/completions',aion:'https://api.aionlabs.ai/v1/chat/completions'});
export function validateModel(id,model){if(!providerById(id))throw Error('Unknown provider');if(typeof model!=='string'||!model.trim()||model.length>130)throw Error('Choose an eligible model ID in the vault first.');if(id==='openrouter'&&model!=='openrouter/free'&&!model.endsWith(':free'))throw Error('OpenRouter must use openrouter/free or a model ending in :free. Paid routes are disabled.');if(id==='cloudflare'&&!/^@cf\/[A-Za-z0-9._/-]+$/.test(model))throw Error('Cloudflare model must be an @cf/ route.');if(id==='gemini'&&!/^gemini-[\w.-]+$/.test(model))throw Error('Gemini model ID must begin with gemini-.');if(!/^[\w@/:.+-]+$/.test(model))throw Error('Model ID contains unsupported characters.');}
/* Tool calling (local Simone bridge, 2026-11-13). Opt-in per request: only when `tools` is passed.
 * Without `tools`, buildRequest/callProvider behave exactly as before (same keys, same 12-message window). */
export const TOOL_CAPABLE_PROVIDERS=Object.freeze(Object.keys(ENDPOINTS));
export const TOOL_HISTORY_LIMIT=32;
const TOOL_NAME=/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export function validateToolDefinitions(tools){
 if(!Array.isArray(tools)||!tools.length||tools.length>16)throw Error('Tool list must contain 1 to 16 tools.');
 for(const t of tools){if(t?.type!=='function'||!TOOL_NAME.test(t.function?.name||'')||typeof t.function?.description!=='string'||!t.function.parameters||typeof t.function.parameters!=='object')throw Error('Invalid tool definition: '+String(t?.function?.name||'?').slice(0,64));}
 if(JSON.stringify(tools).length>24000)throw Error('Tool definitions are too large.');
 return tools;
}
function toolMessage(m){
 if(!m||typeof m!=='object')return null;
 if(['user','system'].includes(m.role))return typeof m.content==='string'?{role:m.role,content:m.content.slice(0,12000)}:null;
 if(m.role==='assistant'){
  const calls=Array.isArray(m.tool_calls)?m.tool_calls.filter(c=>c&&typeof c.id==='string'&&TOOL_NAME.test(c.function?.name||'')).slice(0,16).map(c=>({id:c.id.slice(0,120),type:'function',function:{name:c.function.name,arguments:typeof c.function.arguments==='string'?c.function.arguments.slice(0,60000):JSON.stringify(c.function.arguments??{})}})):[];
  const content=typeof m.content==='string'?m.content.slice(0,12000):'';
  if(calls.length)return content?{role:'assistant',content,tool_calls:calls}:{role:'assistant',tool_calls:calls};
  return content?{role:'assistant',content}:null;
 }
 if(m.role==='tool'&&typeof m.tool_call_id==='string'&&typeof m.content==='string')return {role:'tool',tool_call_id:m.tool_call_id.slice(0,120),content:m.content.slice(0,12000)};
 return null;
}
/* Keeps every system message, then the newest non-system messages, and never starts the window on an
 * orphaned tool result (a tool message whose assistant tool_calls turn was cut off is a provider error). */
export function toolConversationWindow(messages,limit=TOOL_HISTORY_LIMIT){
 const all=messages.map(toolMessage).filter(Boolean);
 const system=all.filter(m=>m.role==='system'),rest=all.filter(m=>m.role!=='system');
 let tail=rest.slice(-Math.max(1,limit-system.length));
 while(tail.length&&tail[0].role==='tool')tail=tail.slice(1);
 const known=new Set();for(const m of tail){if(m.tool_calls)for(const c of m.tool_calls)known.add(c.id);}
 tail=tail.filter(m=>m.role!=='tool'||known.has(m.tool_call_id));
 return [...system,...tail];
}
export function buildRequest(provider,credential,messages,{maxOutputTokens=512,tools=null,toolChoice='auto'}={}){validateOutputCap(maxOutputTokens);const id=provider,model=credential.model;validateModel(id,model);if(!credential.attested)throw Error('Account free-plan attestation missing.');if(!credential.key)throw Error('Missing key.');if(tools){if(!TOOL_CAPABLE_PROVIDERS.includes(id))throw Error('Tool calling is wired only for OpenAI-compatible routes ('+TOOL_CAPABLE_PROVIDERS.join(', ')+').');validateToolDefinitions(tools);if(!['auto','none','required'].includes(toolChoice))throw Error('Unsupported tool_choice.');}const simplified=tools?toolConversationWindow(messages):messages.filter(m=>['user','assistant','system'].includes(m.role)&&typeof m.content==='string').slice(-12).map(m=>({role:m.role,content:m.content.slice(0,12000)}));if(!simplified.length)throw Error('No prompt supplied');let url,headers={'Content-Type':'application/json'},body;
if(id==='gemini'){url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;headers['x-goog-api-key']=credential.key;const system=simplified.filter(m=>m.role==='system').map(m=>m.content).join('\n');body={contents:simplified.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens}};if(system)body.systemInstruction={parts:[{text:system}]};}
else if(id==='cloudflare'){if(!/^[a-f0-9]{32}$/i.test(credential.account||''))throw Error('Cloudflare requires a 32-character account ID.');url=`https://api.cloudflare.com/client/v4/accounts/${credential.account}/ai/run/${model}`;headers.Authorization=`Bearer ${credential.key}`;body={messages:simplified.map(m=>({role:m.role,content:m.content})),max_tokens:maxOutputTokens};}
else{url=ENDPOINTS[id];if(!url)throw Error('This provider does not have a configured transport');headers.Authorization=`Bearer ${credential.key}`;body={model,messages:simplified,stream:false,max_tokens:maxOutputTokens};if(tools&&toolChoice!=='none'){body.tools=tools;body.tool_choice=toolChoice;}/* 'none': keep the tool-aware history but offer no tools (Groq's gpt-oss can ignore tool_choice:none and 400). */if(id==='openrouter'){headers['X-Title']='Multi-Model Studio';}}
return {url,headers,body};}
export function parseReportedUsage(usage){
 if(!usage||typeof usage!=='object'||Array.isArray(usage))return null;
 const token = value => value===undefined||value===null||value===''?null:(Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null);
 return {prompt_tokens:token(usage.prompt_tokens),completion_tokens:token(usage.completion_tokens),total_tokens:token(usage.total_tokens),source:'provider_reported'};
}
export async function callProvider(id,credential,messages,{signal,timeoutMs=45000,maxOutputTokens=512,tools=null,toolChoice='auto'}={}){
 const request=buildRequest(id,credential,messages,{maxOutputTokens,tools,toolChoice});
 const ms=Number.isFinite(timeoutMs)&&timeoutMs>=1&&timeoutMs<=120000?timeoutMs:45000;
 const combined=new AbortController(), deadline=new AbortController();
 const forward=()=>combined.abort(signal?.reason||new DOMException('Stopped by user','AbortError'));
 if(signal?.aborted)forward();else signal?.addEventListener('abort',forward,{once:true});
 deadline.signal.addEventListener('abort',()=>{if(!combined.signal.aborted)combined.abort(deadline.signal.reason);},{once:true});
 const timer=setTimeout(()=>deadline.abort(new DOMException('Request deadline exceeded','TimeoutError')),ms);
 let response,responseText;
 try{
  response=await fetch(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(request.body),signal:combined.signal,mode:'cors',credentials:'omit',cache:'no-store',redirect:'error'});
  responseText=await readBoundedResponseText(response,{signal:combined.signal});
 }catch(e){
  if(deadline.signal.aborted&&!signal?.aborted)throw Error(`Request to ${providerById(id)?.name||id} timed out after ${Math.ceil(ms/1000)} seconds. Check provider availability or network; no automatic retry was sent.`);
  if(e instanceof ResponseTooLargeError)throw e;
  if(e.name==='AbortError')throw e;
  throw Error(`Browser request failed for ${providerById(id)?.name}. The provider may block cross-origin requests (CORS), or the network may be unavailable. ${e.message}`);
 }finally{
  clearTimeout(timer);
  signal?.removeEventListener('abort',forward);
 }
let payload;try{payload=JSON.parse(responseText);}catch{throw Error(`${id}: response was not JSON (HTTP ${response.status}).`);}if(!response.ok||payload?.success===false){const msg=payload?.error?.message||payload?.error||payload?.message||payload?.errors?.[0]?.message||JSON.stringify(payload).slice(0,260);const err=Error(`${id}: HTTP ${response.status} — ${String(msg).slice(0,300)}`);err.httpStatus=response.status;if(response.status===429){const ra=Number(response.headers?.get?.('retry-after'));const m=/try again in ([0-9.]+)\s*(ms|s)\b/i.exec(String(msg));const ms=m?Number(m[1])*(m[2].toLowerCase()==='ms'?1:1000):Number.isFinite(ra)&&ra>=0?ra*1000:NaN;if(Number.isFinite(ms))err.retryAfterMs=Math.min(600000,Math.ceil(ms));}if(typeof payload?.error?.code==='string')err.code=payload.error.code.slice(0,60);if(tools&&typeof payload?.error?.failed_generation==='string')err.failedGeneration=payload.error.failed_generation.slice(0,2000);throw err;}
let text='',usage=payload.usage||payload.result?.usage||null;
if(id==='gemini'){text=(payload.candidates||[]).flatMap(c=>(c.content?.parts||[]).map(p=>p.text||'')).join('\n');usage=payload.usageMetadata?{prompt_tokens:payload.usageMetadata.promptTokenCount,completion_tokens:payload.usageMetadata.candidatesTokenCount,total_tokens:payload.usageMetadata.totalTokenCount}:null;}
else if(id==='cloudflare'){const output=payload.result?.response||payload.result?.output||payload.result;text=typeof output==='string'?output:Array.isArray(output)?output.map(x=>x.text||x.content||'').join('\n'):JSON.stringify(output??'');}
else text=payload.choices?.[0]?.message?.content||payload.output_text||'';
if(Array.isArray(text))text=text.map(p=>p.text||'').join('\n');
if(tools){
 const message=payload.choices?.[0]?.message||{};
 const toolCalls=parseToolCalls(message.tool_calls);
 if(!text&&!toolCalls.length)throw Error(`${id}: API returned neither text nor a tool call; check model compatibility and response format.`);
 return {text:String(text||'').slice(0,60000),toolCalls,finishReason:String(payload.choices?.[0]?.finish_reason||'').slice(0,40),reasoning:typeof message.reasoning==='string'?message.reasoning.slice(0,8000):'',usage:parseReportedUsage(usage),model:payload.model||credential.model,id,httpStatus:response.status};
}
if(!text)throw Error(`${id}: API returned no text; check model compatibility and response format.`);
return {text:String(text).slice(0,60000),usage:parseReportedUsage(usage),model:payload.model||credential.model,id,httpStatus:response.status};}
/* Normalizes OpenAI-compatible tool_calls. Arguments stay a raw string: validation happens in the agent layer. */
export function parseToolCalls(raw){
 if(!Array.isArray(raw))return [];
 return raw.slice(0,16).filter(c=>c&&typeof c==='object'&&c.function&&typeof c.function.name==='string').map((c,i)=>({id:typeof c.id==='string'&&c.id?c.id.slice(0,120):`call_${i}`,name:c.function.name.slice(0,64),arguments:typeof c.function.arguments==='string'?c.function.arguments.slice(0,250000):JSON.stringify(c.function.arguments??{})}));
}
