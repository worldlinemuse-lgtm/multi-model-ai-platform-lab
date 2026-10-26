/* Telemetry tab: provider burn-down, device resources, operation traces, OTel diagnostics.
   HUD: draggable 5-metric overlay toggled from the telemetry view.
   All data is local-only; no network export. */
import {otelDiagnosticsText} from './otel-workshop.js';

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- device resources (browser-exposed only) ---------- */
let longTaskCount=0,longTaskTotalMs=0;
try{
  if('PerformanceObserver' in window){
    const po=new PerformanceObserver(list=>{
      for(const e of list.getEntries()){longTaskCount++;longTaskTotalMs+=e.duration;}
    });
    po.observe({entryTypes:['longtask']});
  }
}catch{/* longtask unsupported — counts stay zero */}

export function deviceSnapshot(){
  const mem=(performance&&performance.memory)||null;
  return {
    heapUsedMB:mem?+(mem.usedJSHeapSize/1048576).toFixed(1):null,
    heapTotalMB:mem?+(mem.totalJSHeapSize/1048576).toFixed(1):null,
    heapLimitMB:mem?+(mem.jsHeapSizeLimit/1048576).toFixed(1):null,
    cores:navigator.hardwareConcurrency||null,
    deviceRamGB:navigator.deviceMemory||null,
    longTasks:{count:longTaskCount,totalMs:Math.round(longTaskTotalMs)},
    heapAvailable:!!mem,
  };
}

/* ---------- provider burn-down from the audit log ---------- */
export function providerBurndown(auditEvents){
  const by={};
  for(const e of auditEvents||[]){
    if(e.op!=='inference'||e.status==='requested')continue; // one logical request counts once: 'requested' is the open its terminal event closes
    const p=e.provider||'unknown';
    by[p]=by[p]||{provider:p,calls:0,ok:0,failed:0,stopped:0,tokens:0,latSum:0,latN:0,models:new Set()};
    const r=by[p];r.calls++;
    if(e.status==='success')r.ok++;else if(e.status==='failed')r.failed++;else if(e.status==='stopped')r.stopped++;
    if(Number.isSafeInteger(e.usage?.total_tokens))r.tokens+=e.usage.total_tokens;
    if(Number.isFinite(e.latencyMs)){r.latSum+=e.latencyMs;r.latN++;}
    if(e.model)r.models.add(e.model);
  }
  return Object.values(by).map(r=>({...r,models:[...r.models],p50LatMs:r.latN?Math.round(r.latSum/r.latN):null}));
}

/* ---------- headline stats ---------- */
export function headlineStats(auditEvents,otelSnap){
  const inf=(auditEvents||[]).filter(e=>e.op==='inference'&&e.status!=='requested');
  const runs=(auditEvents||[]).filter(e=>e.op==='run');
  const dev=deviceSnapshot();
  return [
    {label:'PROVIDER CALLS',value:String(inf.length),sub:`${inf.filter(e=>e.status==='success').length} succeeded`},
    {label:'OBSERVED TOKENS',value:inf.reduce((s,e)=>s+(Number.isSafeInteger(e.usage?.total_tokens)?e.usage.total_tokens:0),0).toLocaleString(),sub:'provider-reported only'},
    {label:'CODE RUNS',value:String(runs.length),sub:`${runs.filter(e=>e.status==='failed').length} failed`},
    {label:'JS HEAP',value:dev.heapUsedMB==null?'n/a':dev.heapUsedMB+' MB',sub:dev.heapTotalMB==null?'browser not reporting':`of ${dev.heapTotalMB} MB allocated`},
    {label:'LONG TASKS',value:String(dev.longTasks.count),sub:`${dev.longTasks.totalMs} ms main-thread blocks`},
    {label:'OTEL SPANS',value:String(otelSnap?.recorded??0),sub:`state: ${esc(otelSnap?.state??'unknown')}`},
  ];
}

/* ---------- renderers ---------- */
export function renderTelemetryHeadline(auditEvents,workshopMetrics){
  const host=$('telemetry-headline');if(!host)return;
  let snap=null;try{snap=workshopMetrics.otelSnapshot?.()||null;}catch{}
  let state='unknown';try{state=workshopMetrics.otelStatus?.()||'unknown';}catch{}
  const stats=headlineStats(auditEvents,{recorded:snap?.recorded??0,state});
  host.innerHTML=stats.map(s=>`<article class="stat"><span>${esc(s.label)}</span><strong>${esc(s.value)}</strong><small>${esc(s.sub)}</small></article>`).join('');
}

export function renderTelemetryProviders(auditEvents){
  const host=$('telemetry-providers');if(!host)return;
  const rows=providerBurndown(auditEvents);
  if(!rows.length){host.innerHTML='<p class="hint-line">No provider calls yet. Chat with a connected provider to see burn-down here.</p>';return;}
  host.innerHTML=`<table><thead><tr><th>Provider</th><th>Calls</th><th>OK</th><th>Failed</th><th>Tokens</th><th>Avg latency</th><th>Models</th></tr></thead><tbody>${
    rows.map(r=>`<tr><td>${esc(r.provider)}</td><td>${r.calls}</td><td>${r.ok}</td><td class="${r.failed?'bad':''}">${r.failed}</td><td>${r.tokens.toLocaleString()}</td><td>${r.p50LatMs==null?'—':r.p50LatMs+' ms'}</td><td>${esc(r.models.join(', ')||'—')}</td></tr>`).join('')
  }</tbody></table>`;
}

export function renderTelemetryDevice(){
  const host=$('telemetry-device');if(!host)return;
  const d=deviceSnapshot();
  const row=(k,v)=>`<div class="settings-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`;
  host.innerHTML=
    row('JS heap used',d.heapUsedMB==null?'Not reported by this browser':d.heapUsedMB+' MB')+
    row('JS heap allocated',d.heapTotalMB==null?'Not reported by this browser':d.heapTotalMB+' MB')+
    row('JS heap limit',d.heapLimitMB==null?'Not reported by this browser':d.heapLimitMB+' MB')+
    row('CPU cores (logical)',d.cores==null?'Unknown':String(d.cores))+
    row('Device RAM (bucket)',d.deviceRamGB==null?'Unknown':`~${d.deviceRamGB} GB`)+
    row('Long tasks this session',`${d.longTasks.count} (${d.longTasks.totalMs} ms total)`);
}

export function renderTelemetryTraces(workshopMetrics){
  const host=$('telemetry-traces');if(!host)return;
  let snap=null;try{snap=workshopMetrics.otelSnapshot?.();}catch{}
  const events=(snap?.events||[]).slice(-12).reverse();
  if(!events.length){host.textContent='No spans recorded yet. Run code or chat with a provider.';return;}
  host.textContent=events.map(e=>{
    const phases=(e.phases||[]).map(p=>p.name).join(' → ');
    return `${e.op} · ${e.outcome}${e.reason!=='none'?' ('+e.reason+')':''} · ${e.durationMs??'?'} ms${phases?'\n  phases: '+phases:''}`;
  }).join('\n\n');
}

export async function renderTelemetryOtel(workshopMetrics){
  const host=$('telemetry-otel');if(!host)return;
  try{host.textContent=await otelDiagnosticsText(workshopMetrics);}
  catch(e){host.textContent='Diagnostics unavailable: '+(e?.message||String(e));}
}

export function renderTelemetry(auditEvents,workshopMetrics){
  renderTelemetryHeadline(auditEvents,workshopMetrics);
  renderTelemetryProviders(auditEvents);
  renderTelemetryDevice();
  renderTelemetryTraces(workshopMetrics);
  renderTelemetryOtel(workshopMetrics);
}

/* ---------- HUD ---------- */
let hudTimer=null,hudDrag=null;

const HUD_METRICS=[
  {label:'Heap',get:d=>d.heapUsedMB==null?'n/a':d.heapUsedMB+' MB',warn:d=>d.heapUsedMB!=null&&d.heapLimitMB!=null&&d.heapUsedMB/d.heapLimitMB>0.8},
  {label:'Long tasks',get:d=>String(d.longTasks.count),warn:d=>d.longTasks.count>10},
  {label:'Spans',get:(d,s)=>String(s?.recorded??0),warn:()=>false},
  {label:'Provider calls',get:(d,s,a)=>String((a||[]).filter(e=>e.op==='inference'&&e.status!=='requested').length),warn:()=>false},
  {label:'Code runs',get:(d,s,a)=>String((a||[]).filter(e=>e.op==='run').length),warn:()=>false},
];

export function hudUpdate(getState){
  const hud=$('perf-hud');if(!hud||hud.hidden)return;
  const box=$('perf-hud-metrics');if(!box)return;
  const {auditEvents,workshopMetrics}=getState();
  const d=deviceSnapshot();
  let snap=null;try{snap=workshopMetrics.otelSnapshot?.();}catch{}
  box.innerHTML=HUD_METRICS.map(m=>{
    const v=m.get(d,snap,auditEvents);
    const cls=m.warn(d,snap,auditEvents)?'warn':'';
    return `<div class="hud-row"><span class="hud-label">${esc(m.label)}</span><span class="hud-value ${cls}">${esc(v)}</span></div>`;
  }).join('');
}

export function hudShow(getState){
  const hud=$('perf-hud');if(!hud)return;
  hud.hidden=false;
  hudUpdate(getState);
  if(hudTimer)clearInterval(hudTimer);
  hudTimer=setInterval(()=>hudUpdate(getState),2000);
  const toggle=$('hud-toggle');if(toggle)toggle.checked=true;
}

export function hudHide(){
  const hud=$('perf-hud');if(!hud)return;
  hud.hidden=true;
  if(hudTimer){clearInterval(hudTimer);hudTimer=null;}
  const toggle=$('hud-toggle');if(toggle)toggle.checked=false;
}

export function hudToggle(getState){
  const hud=$('perf-hud');
  if(hud&&!hud.hidden)hudHide();else hudShow(getState);
}

export function wireHud(getState){
  const hud=$('perf-hud');if(!hud)return;
  const header=$('perf-hud-header');
  const close=$('perf-hud-close');
  if(close)close.addEventListener('click',hudHide);
  if(header)header.addEventListener('pointerdown',e=>{
    if(e.target===close)return;
    hudDrag={x:e.clientX-hud.offsetLeft,y:e.clientY-hud.offsetTop};
    header.setPointerCapture?.(e.pointerId);
    const move=ev=>{
      if(!hudDrag)return;
      hud.style.left=Math.max(0,Math.min(window.innerWidth-240,ev.clientX-hudDrag.x))+'px';
      hud.style.top=Math.max(0,Math.min(window.innerHeight-60,ev.clientY-hudDrag.y))+'px';
      hud.style.right='auto';
    };
    const up=()=>{hudDrag=null;header.removeEventListener('pointermove',move);header.removeEventListener('pointerup',up);};
    header.addEventListener('pointermove',move);
    header.addEventListener('pointerup',up);
  });
  const toggle=$('hud-toggle');
  if(toggle)toggle.addEventListener('change',()=>hudToggle(getState));
}
