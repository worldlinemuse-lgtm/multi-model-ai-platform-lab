import {providerById} from './core.js';
import {validateOutputCap} from './model-request-settings.js';
import {readBoundedResponseText,ResponseTooLargeError} from './bounded-response.js';
const ENDPOINTS=Object.freeze({groq:'https://api.groq.com/openai/v1/chat/completions',openrouter:'https://openrouter.ai/api/v1/chat/completions',mistral:'https://api.mistral.ai/v1/chat/completions',ollama:'https://ollama.com/v1/chat/completions',huggingface:'https://router.huggingface.co/v1/chat/completions',aion:'https://api.aionlabs.ai/v1/chat/completions'});
export function validateModel(id,model){if(!providerById(id))throw Error('Unknown provider');if(typeof model!=='string'||!model.trim()||model.length>130)throw Error('Choose an eligible model ID in the vault first.');if(id==='openrouter'&&model!=='openrouter/free'&&!model.endsWith(':free'))throw Error('OpenRouter must use openrouter/free or a model ending in :free. Paid routes are disabled.');if(id==='cloudflare'&&!/^@cf\/[A-Za-z0-9._/-]+$/.test(model))throw Error('Cloudflare model must be an @cf/ route.');if(id==='gemini'&&!/^gemini-[\w.-]+$/.test(model))throw Error('Gemini model ID must begin with gemini-.');if(!/^[\w@/:.+-]+$/.test(model))throw Error('Model ID contains unsupported characters.');}
export function buildRequest(provider,credential,messages,{maxOutputTokens=512}={}){validateOutputCap(maxOutputTokens);const id=provider,model=credential.model;validateModel(id,model);if(!credential.attested)throw Error('Account free-plan attestation missing.');if(!credential.key)throw Error('Missing key.');const simplified=messages.filter(m=>['user','assistant','system'].includes(m.role)&&typeof m.content==='string').slice(-12).map(m=>({role:m.role,content:m.content.slice(0,12000)}));if(!simplified.length)throw Error('No prompt supplied');let url,headers={'Content-Type':'application/json'},body;
if(id==='gemini'){url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;headers['x-goog-api-key']=credential.key;const system=simplified.filter(m=>m.role==='system').map(m=>m.content).join('\n');body={contents:simplified.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens}};if(system)body.systemInstruction={parts:[{text:system}]};}
else if(id==='cloudflare'){if(!/^[a-f0-9]{32}$/i.test(credential.account||''))throw Error('Cloudflare requires a 32-character account ID.');url=`https://api.cloudflare.com/client/v4/accounts/${credential.account}/ai/run/${model}`;headers.Authorization=`Bearer ${credential.key}`;body={messages:simplified.map(m=>({role:m.role,content:m.content})),max_tokens:maxOutputTokens};}
else{url=ENDPOINTS[id];if(!url)throw Error('This provider does not have a configured transport');headers.Authorization=`Bearer ${credential.key}`;body={model,messages:simplified,stream:false,max_tokens:maxOutputTokens};if(id==='openrouter'){headers['X-Title']='Multi-Model Studio';}}
return {url,headers,body};}
export function parseReportedUsage(usage){
 if(!usage||typeof usage!=='object'||Array.isArray(usage))return null;
 const token = value => value===undefined||value===null||value===''?null:(Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null);
 return {prompt_tokens:token(usage.prompt_tokens),completion_tokens:token(usage.completion_tokens),total_tokens:token(usage.total_tokens),source:'provider_reported'};
}
export async function callProvider(id,credential,messages,{signal,timeoutMs=45000,maxOutputTokens=512}={}){
 const request=buildRequest(id,credential,messages,{maxOutputTokens});
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
let payload;try{payload=JSON.parse(responseText);}catch{throw Error(`${id}: response was not JSON (HTTP ${response.status}).`);}if(!response.ok||payload?.success===false){const msg=payload?.error?.message||payload?.error||payload?.message||payload?.errors?.[0]?.message||JSON.stringify(payload).slice(0,260);throw Error(`${id}: HTTP ${response.status} — ${String(msg).slice(0,300)}`);}
let text='',usage=payload.usage||payload.result?.usage||null;
if(id==='gemini'){text=(payload.candidates||[]).flatMap(c=>(c.content?.parts||[]).map(p=>p.text||'')).join('\n');usage=payload.usageMetadata?{prompt_tokens:payload.usageMetadata.promptTokenCount,completion_tokens:payload.usageMetadata.candidatesTokenCount,total_tokens:payload.usageMetadata.totalTokenCount}:null;}
else if(id==='cloudflare'){const output=payload.result?.response||payload.result?.output||payload.result;text=typeof output==='string'?output:Array.isArray(output)?output.map(x=>x.text||x.content||'').join('\n'):JSON.stringify(output??'');}
else text=payload.choices?.[0]?.message?.content||payload.output_text||'';
if(Array.isArray(text))text=text.map(p=>p.text||'').join('\n');if(!text)throw Error(`${id}: API returned no text; check model compatibility and response format.`);
return {text:String(text).slice(0,60000),usage:parseReportedUsage(usage),model:payload.model||credential.model,id,httpStatus:response.status};}
