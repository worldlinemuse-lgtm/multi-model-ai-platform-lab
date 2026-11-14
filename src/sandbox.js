/* Every submitted code program runs in a disposable worker created by an opaque-origin sandboxed iframe.
   Parent documents and encrypted key material are unavailable to the sandbox. */
import {moduleRunnerDocument,shouldRunAsModule} from './module-runtime.js';
import {workerPrelude,frameSubtleRelay} from './sandbox-prelude.js';
const escapeScript=s=>JSON.stringify(String(s)).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
const JAVASCRIPT_WORKER=workerPrelude()+String.raw`
self.onmessage=async({data})=>{if(data&&data.subtleReply){__mmSubtleReply(data.subtleReply);return;}try{const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;await new AsyncFunction('console','print','"use strict";\n'+data.code)(logs,...[logs.log]);if(await __mmDrain())send('done','Execution complete.')}catch(e){__mmFail('',e)}};
`;
const PYTHON_WORKER=String.raw`
const CD='https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
const send=(type,message)=>self.postMessage({type,message:String(message).slice(0,10000)});
self.onmessage=async({data})=>{try{send('log','Downloading Python WebAssembly runtime on first use…');importScripts(CD+'pyodide.js');const py=await loadPyodide({indexURL:CD});py.setStdout({batched:s=>send('log',s)});py.setStderr({batched:s=>send('log','STDERR: '+s)});send('log','Pyodide ready. Running Python…');let result=await py.runPythonAsync(data.code);if(result!==undefined&&result!==null)send('log',String(result));send('done','Python execution complete.');}catch(e){send('error',e?.stack||String(e))}};
`;
export function runnerDocument(code,lang,nonce){const js=lang==='python'?PYTHON_WORKER:JAVASCRIPT_WORKER;
 const csp=lang==='python'?"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: https://cdn.jsdelivr.net; worker-src blob:; connect-src https://cdn.jsdelivr.net; form-action 'none'; base-uri 'none'":"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>
(()=>{${frameSubtleRelay()}const nonce=${escapeScript(nonce)};const code=${escapeScript(code)};const source=${escapeScript(js)};const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));let worker;
const send=(type,message)=>parent.postMessage({channel:'mm-sandbox-b03',nonce,type,message:String(message)},'*');
try{worker=new Worker(url);URL.revokeObjectURL(url);worker.onmessage=e=>{if(__mmRelay(worker,e.data))return;send(e.data.type,e.data.message)};worker.onerror=e=>send('error',e.message||'Worker error');worker.postMessage({code});}catch(e){send('error','Unable to start isolated Worker: '+String(e))}
window.addEventListener('message',e=>{if(e.source===parent&&e.data?.channel==='mm-stop-b03'&&e.data.nonce===nonce){worker?.terminate();send('stopped','Execution stopped.')}});
})();
<\/script></body></html>`;}
export class RuntimeRunner{
 constructor(host,onState){this.host=host;this.onState=onState;this.frame=null;this.listener=null;this.timer=null;this.pending=null;}
 run(code,lang,onEvent,limitMs=lang==='python'?60000:6000,project=null,onPhase=null){this.stop();const phase=n=>{try{if(typeof onPhase==='function')onPhase(n)}catch{}};const nonce=crypto.randomUUID();phase('sandbox-preparing');const html=lang==='javascript'&&project&&shouldRunAsModule(code,project.entry)?moduleRunnerDocument(project.files,project.entry,nonce):runnerDocument(code,lang,nonce);const frame=document.createElement('iframe');frame.hidden=true;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.title='Isolated code execution';const listener=event=>{if(event.source!==frame.contentWindow)return;const data=event.data;if(!data||data.channel!=='mm-sandbox-b03'||data.nonce!==nonce)return;if(!['log','error','done','stopped'].includes(data.type))return;this.pending.count++;if(this.pending.count>180){this.stop('Output flood limit reached.');return;}if(this.pending.count===1)phase('first-output');onEvent(data.type,String(data.message).slice(0,10000));if(['done','error'].includes(data.type))this.stop();};this.listener=listener;this.frame=frame;this.pending={nonce,count:0};window.addEventListener('message',listener);frame.srcdoc=html;this.host.appendChild(frame);phase('sandbox-attached');this.timer=setTimeout(()=>this.stop('Execution timed out.'),limitMs);this.onState(true,lang);}
 stop(reason){if(this.frame&&this.pending){try{this.frame.contentWindow.postMessage({channel:'mm-stop-b03',nonce:this.pending.nonce},'*')}catch{}}if(this.listener)window.removeEventListener('message',this.listener);if(this.timer!==null)clearTimeout(this.timer);this.timer=null;this.frame?.remove();this.frame=null;this.listener=null;this.pending=null;this.onState(false);if(reason)this.onStop?.(reason);}
}
export {previewDocument,previewReport} from './preview-assets.js';
