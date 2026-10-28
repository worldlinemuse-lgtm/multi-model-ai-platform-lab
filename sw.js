// Network-first for live source changes; cached application shell supports offline use.
// The cache is scoped to this project site, not other sites on the same github.io origin.
const CACHE_PREFIX='mm-studio-shell-'+encodeURIComponent(new URL(self.registration.scope).pathname)+'-';
const CACHE=CACHE_PREFIX+'lab-11';
const SHELL=['./','./index.html','./styles.css','./favicon.svg','./provider-guides.js','./src/main.js','./src/core.js','./src/storage.js','./src/vault.js','./src/provider-api.js','./src/request-trace.js','./src/otel-workshop.js','./src/sandbox.js','./src/zip.js','./src/bounded-deflate.js','./src/labs.js','./src/speech-settings.js','./src/image-transform.js','./src/data-tools.js','./src/project-files.js','./src/preview-assets.js','./src/module-graph.js','./src/module-linker.js','./src/module-runtime.js','./src/note-tools.js','./src/snapshot-diff.js','./src/capability-probes.js','./src/knowledge.js','./src/wasm-policy.js','./src/wasm-runner.js','./src/wasm-worker.js','./src/wasm-ui.js','./src/expression-repl.js','./src/expression-repl-worker.js','./src/expression-repl-ui.js','./src/workflow-plan.js','./src/workflow-supervisor.js','./src/local-evidence.js','./src/knowledge-pages.js','./src/binary-assets.js','./src/provider-presets.js','./src/ondevice-readiness.js','./src/model-request-settings.js','./src/connection-diagnostics.js','./src/provider-connection-probe.js','./src/review-edits.js','./src/docx-text.js','./src/knowledge-documents.js','./src/telemetry-view.js','./src/draw.js'];
const REFRESH_SLOTS=Object.freeze([CACHE+'-refresh-a',CACHE+'-refresh-b']);
// OTel SDK bundles: built in CI and restored before deploy. Cached best-effort:
// a missing bundle must never fail service-worker install or break startup
// (the app dynamic-imports them with a timeout fallback).
const OTEL_BUNDLES=['./observability/dist/otel-local-pilot.js','./observability/dist/otel-local-metrics.js'];
async function cacheOtelBundles(cache){
 for(const path of OTEL_BUNDLES){
  try{
   const res=await fetch(scopeAsset(path));
   if(res&&res.ok)await cache.put(scopeAsset(path),res);
  }catch{/* optional bundle: skip silently */}
 }
}
const CONTROL_CACHE=CACHE+'-control';
const POINTER=new URL('./__mm_offline_refresh_pointer__',self.registration.scope);
let refreshQueue=Promise.resolve();
const scopeAsset=path=>new Request(new URL(path,self.registration.scope),{cache:'reload'});
const inScope=request=>{
 const u=new URL(request.url);
 return request.method==='GET' && u.origin===self.location.origin
 && u.pathname.startsWith(new URL(self.registration.scope).pathname)
 && !u.pathname.endsWith('/sw.js') && u.href!==POINTER.href;
};
async function activeOfflineCache(){
 const control=await caches.open(CONTROL_CACHE),pointer=await control.match(POINTER);
 const name=pointer?await pointer.text():'';
 return REFRESH_SLOTS.includes(name)?name:CACHE;
}
async function refreshShell(){
 const active=await activeOfflineCache();
 const next=active===REFRESH_SLOTS[0]?REFRESH_SLOTS[1]:REFRESH_SLOTS[0];
 try{
  await caches.delete(next); // never remove the active complete shell
  const target=await caches.open(next);
  await target.addAll(SHELL.map(scopeAsset)); // stage entire candidate without changing the pointer
  await cacheOtelBundles(target); // best-effort: never fail the refresh
  for(const path of SHELL){
   const match=await target.match(scopeAsset(path));
   if(!match||!match.ok)throw Error('Offline shell staging missing '+path);
  }
  const control=await caches.open(CONTROL_CACHE);
  await control.put(POINTER,new Response(next,{headers:{'Content-Type':'text/plain'}}));
  return {ok:true,assets:SHELL.length,cache:next};
 }catch(error){
  try{await caches.delete(next);}catch{}
  throw error;
 }
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
 try{
  const cache=await caches.open(CACHE);
  await cache.addAll(SHELL);
  await cacheOtelBundles(cache);
  await self.skipWaiting();
 }catch(error){
  try{await caches.delete(CACHE);}catch{}
  throw error;
 }
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 const keep=new Set([CACHE,CONTROL_CACHE,...REFRESH_SLOTS]);
 const keys=await caches.keys();
 await Promise.all(keys.filter(k=>k.startsWith(CACHE_PREFIX)&&!keep.has(k)).map(k=>caches.delete(k)));
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 if(!inScope(event.request))return;
 event.respondWith((async()=>{
  try{
   const response=await fetch(event.request);
   if(response.ok){
    const copy=response.clone();
    const update=caches.open(CACHE).then(c=>c.put(event.request,copy)).catch(()=>{});
    event.waitUntil?.(update);
   }
   return response;
  }catch(error){
   const name=await activeOfflineCache();
   const cached=await (await caches.open(name)).match(event.request);
   if(cached)return cached;
   const fallback=await (await caches.open(CACHE)).match(event.request);
   if(fallback)return fallback;
   throw error;
  }
 })());
});
self.addEventListener('message',event=>{
 if(event.data?.type!=='REFRESH')return;
 const port=event.ports?.[0];
 const attempt=refreshQueue.catch(()=>{}).then(async()=>{
  try{port?.postMessage(await refreshShell());}
  catch(error){port?.postMessage({ok:false,error:String(error?.message||error).slice(0,260)});}
 });
 refreshQueue=attempt;
 event.waitUntil(attempt);
});
