/* Q03 staged integration: browser-local ES modules in a disposable opaque-origin iframe/Worker.
 * Parent validates a bounded virtual graph but never executes submitted project code.
 */
import {compileModuleGraph} from './module-graph.js';
import {linkerWorkerSource} from './module-linker.js';
import {workerPrelude,frameSubtleRelay} from './sandbox-prelude.js';

const escapedJSON=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');

export function moduleRunnerDocument(files,entry,nonce){
 const graph=compileModuleGraph(files,entry);
 // The tested linker functions are copied into the Worker source; no application-origin
 // script or credential is made available to untrusted code inside the Worker.
 const workerSource=String.raw`
${workerPrelude()}
self.console=logs;
self.print=logs.log;
self.Worker=undefined;
self.SharedWorker=undefined;
${linkerWorkerSource()}
self.onmessage=async({data})=>{
 if(data&&data.subtleReply){__mmSubtleReply(data.subtleReply);return;}
 let linked;
 try{
  linked=linkModuleGraph(data.graph,source=>URL.createObjectURL(new Blob([source],{type:'text/javascript'})),URL.revokeObjectURL);
  await import(linked.entryUrl);
  if(await __mmDrain())send('done','Module execution complete.');
 }catch(e){__mmFail('',e)}
 finally{linked?.revoke()}
};
`;
 const csp="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>
(()=>{${frameSubtleRelay()}const nonce=${escapedJSON(nonce)};const graph=${escapedJSON(graph)};const source=${escapedJSON(workerSource)};
const send=(type,message)=>parent.postMessage({channel:'mm-sandbox-b03',nonce,type,message:String(message)},'*');
const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));let worker;
try{worker=new Worker(url);URL.revokeObjectURL(url);worker.onmessage=e=>{if(__mmRelay(worker,e.data))return;send(e.data.type,e.data.message);if(e.data.type==='done'||e.data.type==='error')worker.terminate()};worker.onerror=e=>{send('error',e.message||'Worker error');worker.terminate()};worker.postMessage({graph});}catch(e){URL.revokeObjectURL(url);send('error','Unable to start isolated module Worker: '+String(e))}
window.addEventListener('message',e=>{if(e.source===parent&&e.data?.channel==='mm-stop-b03'&&e.data.nonce===nonce){worker?.terminate();send('stopped','Execution stopped.')}});
})();
<\/script></body></html>`;
}

export function shouldRunAsModule(code,filename){
 return /\.mjs$/i.test(filename)||/(?:^|\n)\s*(?:import\s|export\s)/.test(String(code));
}