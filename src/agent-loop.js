/* Bounded tool-calling loop (local Simone bridge, 2026-11-13). Pure: no DOM, no network.
 * call(messages,{tools,signal,toolChoice}) -> {text,toolCalls,usage,model,...} (provider-api callProvider with tools)
 * approve({call,tool,args}) -> Promise<boolean>   (policy + human gate, supplied by the app)
 * execute({call,tool,args,signal}) -> Promise<any> (lab action, supplied by the app)
 * Every request, validation failure, approval decision, result and error is reported via onEvent,
 * and every tool request gets exactly one `tool` reply so the conversation stays well formed. */
import {toolByName,toolDefinitions,parseToolArguments,validateToolArguments,formatToolResult} from './agent-tools.js';

export const LOOP_LIMITS=Object.freeze({maxRounds:6,maxToolCalls:12,deadlineMs:240000});
const WRAP_UP='Tool budget for this request is used up. Do not call tools. Reply now in plain text with what the tool results so far show, and say what is still unfinished.';
export const RATE_LIMIT_RETRY=Object.freeze({maxRetries:2,maxWaitMs:30000});
const sleep=(ms,signal)=>new Promise(resolve=>{const t=setTimeout(done,ms);function done(){clearTimeout(t);signal?.removeEventListener('abort',done);resolve();}signal?.addEventListener('abort',done,{once:true});});

function clampLimits(l={}){
 const n=(v,d,lo,hi)=>Number.isSafeInteger(v)&&v>=lo&&v<=hi?v:d;
 return {maxRounds:n(l.maxRounds,LOOP_LIMITS.maxRounds,1,12),maxToolCalls:n(l.maxToolCalls,LOOP_LIMITS.maxToolCalls,1,40),deadlineMs:n(l.deadlineMs,LOOP_LIMITS.deadlineMs,1000,900000)};
}
const addUsage=(total,u)=>{if(!u)return total;for(const k of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isSafeInteger(u[k]))total[k]=(total[k]||0)+u[k];return total;};

export async function runToolLoop({call,messages,toolNames,approve,execute,limits,signal,onEvent=()=>{},now=()=>Date.now(),wait=sleep}){
 if(typeof call!=='function'||typeof approve!=='function'||typeof execute!=='function')throw TypeError('call, approve and execute are required.');
 const lim=clampLimits(limits),tools=toolDefinitions(toolNames),allowed=new Set(tools.map(t=>t.function.name));
 const convo=messages.slice(),started=now(),usage={};
 let rounds=0,toolCallCount=0,lastText='',providerRetry=false,model=null,rateRetries=0;
 const emit=(type,data)=>{try{onEvent({type,...data});}catch{}};
 const finish=(status,extra={})=>({status,text:lastText,rounds,toolCalls:toolCallCount,usage,model,messages:convo,...extra});
 while(true){
  if(signal?.aborted)return finish('stopped');
  if(rounds>=lim.maxRounds)return finish('limit',{reason:`round limit (${lim.maxRounds}) reached`});
  if(now()-started>lim.deadlineMs)return finish('limit',{reason:`time limit (${Math.round(lim.deadlineMs/1000)} s) reached`});
  rounds++;
  emit('request',{round:rounds});
  let res;
  const lastRound=rounds>=lim.maxRounds;
  if(lastRound&&rounds>1&&convo.at(-1)?.content!==WRAP_UP)convo.push({role:'user',content:WRAP_UP});
  try{res=await call(convo,{tools,signal,toolChoice:lastRound?'none':'auto'});}
  catch(e){
   if(e?.name==='AbortError'||signal?.aborted)return finish('stopped');
   if(e?.httpStatus===429&&Number.isFinite(e.retryAfterMs)&&rateRetries<RATE_LIMIT_RETRY.maxRetries&&e.retryAfterMs<=RATE_LIMIT_RETRY.maxWaitMs&&now()-started+e.retryAfterMs+500<lim.deadlineMs){
    // Free-tier tokens-per-minute limit: wait the time the provider names, then repeat this round.
    rateRetries++;const ms=e.retryAfterMs+500;emit('rate-limit-wait',{round:rounds,waitMs:ms,attempt:rateRetries});
    await wait(ms,signal);rounds--;continue;
   }
   if(lastRound&&rounds>1){emit('error',{round:rounds,error:String(e?.message||e).slice(0,500)});return finish('limit',{reason:`round limit (${lim.maxRounds}) reached and the wrap-up reply failed: ${String(e?.message||e).slice(0,200)}`});}
   if(e?.code==='tool_use_failed'&&!providerRetry){
    // Provider rejected a malformed tool call it generated. Tell the model once and let it try again.
    providerRetry=true;emit('provider-retry',{round:rounds,error:String(e.message).slice(0,300)});
    convo.push({role:'user',content:'Your last tool call was rejected by the provider as malformed ('+String(e.message).slice(0,200)+'). Call one of the listed tools again with a valid JSON object as arguments, or answer in plain text.'});
    continue;
   }
   emit('error',{round:rounds,error:String(e?.message||e).slice(0,500)});
   return finish('error',{error:String(e?.message||e).slice(0,500)});
  }
  addUsage(usage,res.usage);model=res.model||model;lastText=res.text||'';
  const calls=Array.isArray(res.toolCalls)?res.toolCalls:[];
  emit('model',{round:rounds,text:lastText,toolCalls:calls.map(c=>({id:c.id,name:c.name,arguments:String(c.arguments).slice(0,2000)})),finishReason:res.finishReason,model:res.model});
  if(!calls.length)return finish('final');
  if(lastRound)return finish('limit',{reason:`round limit (${lim.maxRounds}) reached; the final round still asked for tools`});
  convo.push({role:'assistant',content:lastText,tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:c.arguments}}))});
  for(const c of calls){
   const reply=content=>convo.push({role:'tool',tool_call_id:c.id,content:formatToolResult(content)});
   if(signal?.aborted){reply({error:'stopped',detail:'The run was stopped before this tool call executed.'});continue;}
   if(toolCallCount>=lim.maxToolCalls){reply({error:'budget',detail:`Tool-call budget (${lim.maxToolCalls}) exhausted for this run. Answer with what you have.`});emit('tool',{id:c.id,name:c.name,status:'budget'});continue;}
   toolCallCount++;
   const tool=allowed.has(c.name)?toolByName(c.name):null;
   if(!tool){reply({error:'unknown_tool',detail:`No tool named "${String(c.name).slice(0,64)}". Available: ${[...allowed].join(', ')}`});emit('tool',{id:c.id,name:c.name,status:'unknown'});continue;}
   let args;
   try{args=parseToolArguments(c.arguments);}catch(e){reply({error:'invalid_arguments',detail:e.message});emit('tool',{id:c.id,name:c.name,status:'invalid',error:e.message});continue;}
   const problems=validateToolArguments(tool,args);
   if(problems.length){reply({error:'invalid_arguments',detail:problems.join('; ')});emit('tool',{id:c.id,name:c.name,status:'invalid',error:problems.join('; ')});continue;}
   let ok=false;
   try{emit('approval-requested',{id:c.id,name:c.name,args});ok=await approve({call:c,tool,args,signal});}
   catch(e){if(signal?.aborted){reply({error:'stopped',detail:'Stopped while waiting for approval.'});continue;}const detail=String(e?.message||e).slice(0,1000);reply({error:'rejected',detail});emit('tool',{id:c.id,name:c.name,status:'rejected',args,error:detail});continue;}
   emit('approval',{id:c.id,name:c.name,approved:!!ok});
   if(!ok){reply({error:'denied',detail:'The user denied this tool call. Do not retry the same call; continue without it or explain what you need.'});emit('tool',{id:c.id,name:c.name,status:'denied'});continue;}
   try{
    const result=await execute({call:c,tool,args,signal});
    reply(result);emit('tool',{id:c.id,name:c.name,status:'ok',args,result});
   }catch(e){
    if(e?.name==='AbortError'||signal?.aborted){reply({error:'stopped',detail:'The run was stopped during this tool call.'});emit('tool',{id:c.id,name:c.name,status:'stopped'});continue;}
    reply({error:'execution_failed',detail:String(e?.message||e).slice(0,1000)});emit('tool',{id:c.id,name:c.name,status:'error',args,error:String(e?.message||e).slice(0,1000)});
   }
  }
  if(signal?.aborted)return finish('stopped');
 }
}
