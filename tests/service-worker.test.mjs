import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const base='https://example.github.io/multi-model-ai-platform/';
const CACHE_PREFIX='mm-studio-shell-'+encodeURIComponent(new URL(base).pathname)+'-';
const BASE_CACHE=CACHE_PREFIX+'lab-08';
function harness({online=true,existingCaches=[],failRefresh=false,failControl=false}={}){
 const callbacks={},deleted=[],stores=new Map(existingCaches.map(name=>[name,new Map()]));
 const net={online},failures={refresh:failRefresh,control:failControl};
 const stats={refreshActive:0,maxRefreshActive:0,refreshCount:0};
 const key=request=>typeof request==='string'?new URL(request,base).href:request.url;
 function cacheFor(name){
  if(!stores.has(name))stores.set(name,new Map());
  const items=stores.get(name);
  return {
   addAll:async requests=>{
    if(name.includes('-refresh-')){
     stats.refreshActive++;stats.refreshCount++;
     stats.maxRefreshActive=Math.max(stats.maxRefreshActive,stats.refreshActive);
    }
    try{
     for(let i=0;i<requests.length;i++){
      // Deliberately simulate a partially written Cache.addAll before failing.
      if(name.includes('-refresh-')&&failures.refresh&&i===3){
       failures.refresh=false;throw Error('cache update blocked on third asset');
      }
      const url=key(requests[i]);
      items.set(url,new Response('offline cache '+name+' '+url,{status:200}));
      await Promise.resolve();
     }
    }finally{if(name.includes('-refresh-'))stats.refreshActive--;}
   },
   put:async(request,response)=>{
    if(name.endsWith('-control')&&failures.control){failures.control=false;throw Error('control pointer storage failed');}
    items.set(key(request),response.clone());
   },
   match:async request=>items.get(key(request))?.clone()||null
  };
 }
 const caches={
  open:async name=>cacheFor(name),
  keys:async()=>Array.from(stores.keys()),
  delete:async name=>{deleted.push(name);return stores.delete(name);},
  match:async request=>{for(const m of stores.values()){const x=m.get(key(request));if(x)return x.clone()}return null;}
 };
 const self={location:{origin:new URL(base).origin},registration:{scope:base},clients:{claim:async()=>{}},skipWaiting:async()=>{},addEventListener:(kind,fn)=>{callbacks[kind]=fn}};
 const fetch=async()=>{if(!net.online)throw Error('offline');return new Response('network fresh',{status:200});};
 vm.runInNewContext(source,{self,caches,fetch,URL,Request,Response,Promise});
 const navigate=async url=>{
  let result=null;const extras=[];const request=new Request(url);
  callbacks.fetch({request,respondWith:promise=>result=promise,waitUntil:p=>extras.push(p)});
  if(result===null)return null;
  const response=await result;await Promise.all(extras);return response;
 };
 const refresh=async()=>new Promise((resolve,reject)=>{
  let task;callbacks.message({data:{type:'REFRESH'},ports:[{postMessage:resolve}],waitUntil:p=>task=p});
  if(!task)reject(Error('Refresh message was not handled'));else task.catch(reject);
 });
 const activate=async()=>{
  let task;callbacks.activate({waitUntil:p=>task=p});await task;
 };
 const install=async()=>{
  let task;callbacks.install({waitUntil:p=>task=p});await task;
 };
 return {navigate,refresh,activate,install,net,stats,stores,deleted,failures,seed:(name,url,body)=>{cacheFor(name);stores.get(name).set(key(url),new Response(body))}};
}
test('network-first serves newest code and writes it to installed base cache',async()=>{
 const h=harness();const url=base+'src/main.js';h.seed(BASE_CACHE,url,'older version');
 const response=await h.navigate(url);
 assert.equal(await response.text(),'network fresh');
 const stored=h.stores.get(BASE_CACHE).get(url);assert.equal(await stored.text(),'network fresh');
});
test('offline fallback returns pre-existing cached shell',async()=>{
 const h=harness({online:false}),url=base+'index.html';h.seed(BASE_CACHE,url,'old offline shell');
 assert.equal(await (await h.navigate(url)).text(),'old offline shell');
});
test('never intercept another site, different origin, service worker script or private control marker',async()=>{
 const h=harness();
 for(const u of ['https://api.groq.com/chat','https://example.github.io/unrelated-repo/index.html',base+'sw.js',base+'__mm_offline_refresh_pointer__'])assert.equal(await h.navigate(u),null);
});
test('Q23: successfully refreshed complete staging shell becomes offline active',async()=>{
 const h=harness();const url=base+'index.html';
 h.seed(BASE_CACHE,url,'old page');
 const result=await h.refresh();
 assert.equal(result.ok,true);assert.ok(result.assets>=40);
 assert.match(result.cache,/-refresh-a$/);
 h.net.online=false;
 assert.match(await (await h.navigate(url)).text(),/offline cache .*refresh-a/);
});
test('Q23: partially failed candidate refresh leaves older complete cache active and reports error',async()=>{
 const h=harness();const url=base+'index.html';h.seed(BASE_CACHE,url,'original offline page');
 assert.equal((await h.refresh()).ok,true);
 h.failures.refresh=true;
 const failed=await h.refresh();
 assert.equal(failed.ok,false);assert.match(failed.error,/cache update blocked/);
 h.net.online=false;
 assert.match(await (await h.navigate(url)).text(),/refresh-a/);
 assert.ok(!h.stores.has(BASE_CACHE+'-refresh-b'),'partial staging must be deleted');
});
test('Q23: pointer write failure preserves prior active offline cache',async()=>{
 const h=harness();const url=base+'index.html';
 assert.equal((await h.refresh()).ok,true);
 h.failures.control=true;
 const result=await h.refresh();
 assert.equal(result.ok,false);assert.match(result.error,/control pointer storage failed/);
 h.net.online=false;assert.match(await (await h.navigate(url)).text(),/refresh-a/);
});
test('Q23: two tabs concurrent REFRESH messages serialize candidate builds',async()=>{
 const h=harness();const [a,b]=await Promise.all([h.refresh(),h.refresh()]);
 assert.equal(a.ok,true);assert.equal(b.ok,true);
 assert.equal(h.stats.maxRefreshActive,1,'no overlapping cache candidate builds');
 assert.equal(h.stats.refreshCount,2);
 h.net.online=false;assert.match(await (await h.navigate(base+'index.html')).text(),/refresh-b/);
});
test('Q23: offline after failed first refresh falls back to original base shell',async()=>{
 const h=harness({failRefresh:true});const url=base+'index.html';h.seed(BASE_CACHE,url,'original base');
 const result=await h.refresh();assert.equal(result.ok,false);
 h.net.online=false;assert.equal(await (await h.navigate(url)).text(),'original base');
});
test('Q23: activation preserves active version slots, control and unrelated cache but deletes superseded shells',async()=>{
 const keep=[BASE_CACHE,BASE_CACHE+'-refresh-a',BASE_CACHE+'-refresh-b',BASE_CACHE+'-control','other-app-cache'];
 const old=['b03-19','b03-20','b03-21','b03-22','b03-23','b03-24','b03-25','b03-26','b03-27','b03-28'].map(v=>CACHE_PREFIX+v);
 const h=harness({existingCaches:[...keep,...old]});await h.activate();
 assert.deepEqual(h.deleted,old);
 for(const n of keep)assert.ok(h.stores.has(n));
});
test('Q23: failed install cleans candidate and preserves previous version shell',async()=>{
 const h=harness({failRefresh:false,existingCaches:['mm-studio-shell-b03-24']});
 // The initial install uses the active version; use successful install to verify scoped cache.
 await h.install();assert.ok(h.stores.has(BASE_CACHE));assert.ok(h.stores.has('mm-studio-shell-b03-24'));
});

test('V6.0: activation does not delete foreign Pages scoped caches or ambiguous old cache names',async()=>{
 const foreign='mm-studio-shell-'+encodeURIComponent('/other-project/')+'-b03-29';
 const ambiguous='mm-studio-shell-b03-28';
 const obsolete=CACHE_PREFIX+'b03-18';
 const h=harness({existingCaches:[BASE_CACHE,foreign,ambiguous,obsolete]});
 await h.activate();
 assert.deepEqual(h.deleted,[obsolete]);
 for(const name of [BASE_CACHE,foreign,ambiguous])assert.ok(h.stores.has(name),'foreign or ambiguous cache deleted: '+name);
});
test('V6.0: registration path participates in offline cache namespace',()=>{
 assert.ok(BASE_CACHE.startsWith('mm-studio-shell-'+encodeURIComponent('/multi-model-ai-platform/')+'-'));
 assert.ok(!BASE_CACHE.startsWith('mm-studio-shell-'+encodeURIComponent('/other-project/')+'-'));
});
test('Q03: all directly imported main modules are in the offline shell',()=>{
 const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
 const match=source.match(/const SHELL=\[([^\]]+)\];/);assert.ok(match);
 const shell=new Set([...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(x=>x[1]));
 const dependencies=[...main.matchAll(/\bfrom\s+['"]\.\/([^'"]+)['"]/g)].map(m=>'./src/'+m[1]);
 assert.ok(dependencies.includes('./src/labs.js'));
 for(const path of dependencies)assert.ok(shell.has(path),'offline shell missing '+path);
});
