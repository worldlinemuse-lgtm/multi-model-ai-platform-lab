/* Q10 private request timing and correlation. NEVER store prompts, headers, keys or response bodies. */
export function traceDuration(start,end){
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return null;
 return Math.min(120000,Math.round(end-start));
}
export function auditTraceFields(metadata={}){
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))return {};
 const clean={};
 if(typeof metadata.requestId==='string'&&/^[a-f0-9-]{36}$/i.test(metadata.requestId))clean.requestId=metadata.requestId;
 if(typeof metadata.model==='string'&&/^[\w@/:.+-]{1,130}$/.test(metadata.model))clean.model=metadata.model;
 if(metadata.latencyMs===null||(Number.isSafeInteger(metadata.latencyMs)&&metadata.latencyMs>=0&&metadata.latencyMs<=120000))clean.latencyMs=metadata.latencyMs;
 if(metadata.httpStatus===null||(Number.isSafeInteger(metadata.httpStatus)&&metadata.httpStatus>=100&&metadata.httpStatus<=599))clean.httpStatus=metadata.httpStatus;
 if(Object.keys(clean).length)clean.observation='local-browser';
 return clean;
}

/* Browser-local workshop operations: bounded, content-free metrics.
 * Never inspect user code, prompts, keys, URLs, filenames or error strings.
 * Never transmit or persist events: export requires an explicit UI action.
 */
export const WORKSHOP_OPERATIONS = Object.freeze([
  'boot','code-run','save','preview','project-import','project-export',
  'storage-check','offline-refresh','ui-error','snapshot','data-analyze','inference'
]);
export const WORKSHOP_OUTCOMES = Object.freeze(['ok','error','timeout','cancelled','warning']);
export const WORKSHOP_REASONS = Object.freeze([
  'none','runtime-error','uncaught-error','unhandled-rejection','user-stop',
  'superseded','time-limit','output-limit','storage-error','invalid-input',
  'unsupported-asset','worker-error','offline-unavailable','unknown',
  // Snapshot failure reasons (2026-10-27 re-audit): snapshot() and
  // restoreSnapshot() already finished spans with these, but the set
  // rejected them, so reporting the failure threw instead.
  'resource-limit','clone-failed','restore-failed'
]);
const OPS = new Set(WORKSHOP_OPERATIONS), OUTCOMES = new Set(WORKSHOP_OUTCOMES), REASONS = new Set(WORKSHOP_REASONS);
const MAX_EVENTS=160, MAX_ACTIVE=20, MAX_DURATION_MS=600000;
const allowed=(value,set,label)=>{if(typeof value!=='string'||!set.has(value))throw new TypeError('Invalid workshop '+label);return value;};
const quantile=(values,p)=>values.length?values[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
export function createWorkshopMetrics({clock=()=>performance.now(),enabled=true,limit=MAX_EVENTS}={}){
  if(typeof clock!=='function'||!Number.isSafeInteger(limit)||limit<1||limit>MAX_EVENTS)throw TypeError('Invalid workshop metrics configuration');
  let active = new Map(), events=[], nextId=0, discarded=0, isEnabled=Boolean(enabled);
  const now=()=>{const v=clock();return Number.isFinite(v)&&v>=0?v:0;};
  function retain(event){events.push(Object.freeze(event));if(events.length>limit){events.shift();discarded++;}}
  function begin(op){
    allowed(op,OPS,'operation');
    if(!isEnabled)return null;
    if(active.size>=MAX_ACTIVE){discarded++;return null;}
    const token=Object.freeze({id:++nextId});
    active.set(token,Object.freeze({op,start:now()}));
    return token;
  }
  function finish(token,outcome='ok',reason='none'){
    allowed(outcome,OUTCOMES,'outcome');allowed(reason,REASONS,'reason');
    if(!token||!active.has(token))return false;
    const item=active.get(token);active.delete(token);
    if(!isEnabled)return false;
    const elapsed=now()-item.start;
    retain({op:item.op,outcome,reason,durationMs:Math.min(MAX_DURATION_MS,Math.max(0,Math.round(elapsed)))});
    return true;
  }
  function record(op,outcome='warning',reason='unknown'){
    allowed(op,OPS,'operation');allowed(outcome,OUTCOMES,'outcome');allowed(reason,REASONS,'reason');
    if(!isEnabled)return false;
    retain({op,outcome,reason,durationMs:null});return true;
  }
  function setEnabled(value){isEnabled=Boolean(value);if(!isEnabled)active.clear();return isEnabled;}
  function reset(){active.clear();events=[];discarded=0;nextId=0;}
  function summary(){
    const data=WORKSHOP_OPERATIONS.map(op=>{
      const list=events.filter(e=>e.op===op),timings=list.map(e=>e.durationMs).filter(n=>n!==null).sort((a,b)=>a-b);
      return {op,total:list.length,ok:list.filter(e=>e.outcome==='ok').length,errors:list.filter(e=>e.outcome==='error').length,timeouts:list.filter(e=>e.outcome==='timeout').length,cancelled:list.filter(e=>e.outcome==='cancelled').length,warnings:list.filter(e=>e.outcome==='warning').length,p50Ms:quantile(timings,0.5),p95Ms:quantile(timings,0.95)};
    });
    return {schema:'mm-workshop-metrics-v1',scope:'in-memory-only',enabled:isEnabled,recorded:events.length,discarded,active:active.size,byOperation:data,recent:events.slice(-20).reverse().map(e=>({...e}))};
  }
  function exportReport(){return JSON.stringify(summary(),null,2);}
  return Object.freeze({begin,finish,record,setEnabled,reset,summary,exportReport});
}
