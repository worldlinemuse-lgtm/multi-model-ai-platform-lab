/* OpenTelemetry SDK 2.12.0 isolated local-only pilot.
 * This is NOT a browser auto-instrumentation setup, production app import, OTLP exporter,
 * or remote-telemetry service. All operation names and attributes are fixed enumerations.
 * Deliberately avoids setting a global tracer provider, context manager and propagator:
 * parent spans are propagated through explicit opaque handles, never through network headers.
 */
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { TracerProvider, SimpleSpanProcessor, AlwaysOnSampler } from '@opentelemetry/sdk-trace';

const OPERATIONS = Object.freeze([
  'workshop.boot', 'workshop.code_run', 'workshop.project_save', 'workshop.preview',
  'workshop.snapshot', 'workshop.project_import', 'workshop.project_export',
  'workshop.data_analyze', 'workshop.offline_refresh', 'workshop.storage_check','workshop.inference'
]);
const OUTCOMES = Object.freeze(['ok','error','timeout','cancelled','warning','unknown']);
const REASONS = Object.freeze([
  'none','invalid-input','worker-failed','runtime-failed','time-limit',
  'user-stop','superseded','parent-closed','storage-failed',
  'offline-unavailable','resource-limit','unsupported','unobserved'
]);
const isAllowed=(value,items,name)=>{if(typeof value!=='string'||!items.includes(value))throw TypeError('Invalid '+name);return value;};
const LIMIT=160;
const MAX_ACTIVE=20;
const MAX_MS=600000;
function durationMs(span){
  const pair=span.duration;
  if(!Array.isArray(pair)||pair.length!==2)return null;
  const n=Math.floor(pair[0]*1000+pair[1]/1e6);
  return Number.isFinite(n)?Math.max(0,Math.min(MAX_MS,n)):null;
}
// OTel HrTime is a [seconds, nanoseconds] pair. Phase timing is an event's
// offset from its span's start, not a span duration: the old code fed
// {startTime, endTime} into durationMs, which reads span.duration, so every
// phase atMs came out null. (2026-10-26 audit fix.)
function hrTimeMs(t){
  if(!Array.isArray(t)||t.length!==2)return null;
  const n=Math.floor(t[0]*1000+t[1]/1e6);
  return Number.isFinite(n)?n:null;
}
function phaseAtMs(span,event){
  const start=hrTimeMs(span.startTime),at=hrTimeMs(event.time);
  if(start==null||at==null)return null;
  return Math.max(0,Math.min(MAX_MS,at-start));
}

/** Exporter only retains fixed, content-free projection of our own spans, never ReadableSpan objects. */
export class WhitelistMemoryExporter {
  #events=[];
  #discarded=0;
  #disabled=false;
  export(spans,done){
    if(!this.#disabled){
      for(const span of spans){
        // Reject foreign spans and arbitrary attributes even if another SDK user passed them here.
        if(span.instrumentationScope?.name!=='mm.workshop.local-pilot')continue;
        if(!OPERATIONS.includes(span.name))continue;
        const a=span.attributes||{};
        const outcome=OUTCOMES.includes(a['mm.outcome'])?a['mm.outcome']:'unknown';
        const reason=REASONS.includes(a['mm.reason'])?a['mm.reason']:'unobserved';
        const ctx=span.spanContext();
        const parent=span.parentSpanContext;
        this.#events.push(Object.freeze({
          op:span.name,
          outcome,reason,
          durationMs:durationMs(span),
          traceId:/^[0-9a-f]{32}$/.test(ctx.traceId)?ctx.traceId:null,
          spanId:/^[0-9a-f]{16}$/.test(ctx.spanId)?ctx.spanId:null,
          parentSpanId:parent&&/^[0-9a-f]{16}$/.test(parent.spanId)?parent.spanId:null,
          phases:(span.events||[]).map(e=>({name:String(e.name||'').slice(0,64),atMs:phaseAtMs(span,e)})).slice(0,32)
        }));
        if(this.#events.length>LIMIT){this.#events.shift();this.#discarded++;}
      }
    }
    done({code:0}); // OTel ExportResultCode.SUCCESS, no I/O or network
  }
  shutdown(){this.#disabled=true;return Promise.resolve();}
  forceFlush(){return Promise.resolve();}
  snapshot(){return Object.freeze({schema:'mm-workshop-otel-local-pilot-v1',scope:'memory-only',recorded:this.#events.length,discarded:this.#discarded,events:this.#events.map(x=>({...x}))});}
  clear(){this.#events=[];this.#discarded=0;}
}

export function createLocalOtelPilot(){
  const exporter=new WhitelistMemoryExporter();
  const provider=new TracerProvider({
    resource:resourceFromAttributes({'service.name':'mm-workshop-pilot','service.version':'0.1.0'}),
    sampler:new AlwaysOnSampler(),
    spanProcessors:[new SimpleSpanProcessor({exporter})]
  });
  // No trace.setGlobalTracerProvider(), no browser auto-instrumentation, no OTLP exporter.
  const tracer=provider.getTracer('mm.workshop.local-pilot','0.1.0');
  const active=new Map();
  let closed=false,discardedStarts=0;
  function start(op,parent=null){
    isAllowed(op,OPERATIONS,'operation');
    if(closed)throw Error('Pilot is shut down');
    if(parent!==null&&!active.has(parent))throw TypeError('Unknown active parent');
    if(active.size>=MAX_ACTIVE){discardedStarts++;return null;}
    const parentCtx=parent?trace.setSpan(ROOT_CONTEXT,active.get(parent).span):ROOT_CONTEXT;
    const span=tracer.startSpan(op,{attributes:{'mm.outcome':'unknown','mm.reason':'unobserved'}},parentCtx);
    const token=Object.freeze({});
    active.set(token,{span,parent,children:new Set()});
    if(parent)active.get(parent).children.add(token);
    return token;
  }
  function finish(token,outcome='ok',reason='none'){
    isAllowed(outcome,OUTCOMES,'outcome');isAllowed(reason,REASONS,'reason');
    if(!active.has(token))return false;
    const item=active.get(token);
    for(const child of [...item.children])finish(child,'unknown','parent-closed');
    if(item.parent&&active.has(item.parent))active.get(item.parent).children.delete(token);
    active.delete(token);
    item.span.setAttribute('mm.outcome',outcome);
    item.span.setAttribute('mm.reason',reason);
    item.span.setStatus({code:outcome==='error'||outcome==='timeout'?SpanStatusCode.ERROR:outcome==='ok'?SpanStatusCode.OK:SpanStatusCode.UNSET});
    item.span.end();
    return true;
  }
  function event(token,name){
    if(!active.has(token))return false;
    if(typeof name!=='string'||!name.length||name.length>64)return false;
    try{active.get(token).span.addEvent(name);}catch{return false;}
    return true;
  }
  function snapshot(){return {...exporter.snapshot(),active:active.size,discardedStarts};}
  async function shutdown(){if(closed)return;for(const token of [...active.keys()])finish(token,'unknown','parent-closed');closed=true;await provider.forceFlush();await provider.shutdown();}
  return Object.freeze({start,finish,event,snapshot,shutdown,clear:()=>exporter.clear()});
}
