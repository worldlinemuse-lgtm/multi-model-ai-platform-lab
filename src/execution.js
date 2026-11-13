// Code execution (run/stop/preview/console), extracted from main.js
// (Stage 4b group 4). Wired into main.js 2026-11-05: the RuntimeRunner is
// constructed in boot() and attached via attachRunner, so its onStop
// callback uses the module-internal finishCodeMetric/printConsole.
// Function bodies were copied verbatim from main.js with global references
// replaced by closure/ctx references only.
import {traceDuration} from './request-trace.js';
import {previewReport} from './sandbox.js';
import {$,make,errorText} from './dom-helpers.js';

const consoleLimit=50000;

export function createExecution(ctx){
 let codeRunTrace=null,codeRunRequestId=null,codeRunStartedAt=0,codeRunLang='javascript';
 let lastRunLang=null,pythonRuntimeStatus='UNTESTED',terminalLines=0,run=null;
 function finishCodeMetric(outcome,reason='none'){if(!codeRunTrace)return;const trace=codeRunTrace,requestId=codeRunRequestId,startedAt=codeRunStartedAt,lang=codeRunLang;ctx.metrics.finish(trace,outcome,reason);codeRunTrace=null;codeRunRequestId=null;const status=outcome==='ok'?'success':outcome==='error'?'failed':'stopped';ctx.audit('run',lang,status,null,{requestId,latencyMs:traceDuration(startedAt,performance.now())});}
 function printConsole(text){const area=$('console-output');if(++terminalLines>180){if(terminalLines===181){run.stop();area.textContent=(area.textContent+'\n[Output flood limit reached; worker terminated.]').slice(0,consoleLimit);}return;}let next=area.textContent+(area.textContent?'\n':'')+String(text);if(next.length>consoleLimit)next=next.slice(0,consoleLimit)+'\n[Output truncated]';area.textContent=next;area.scrollTop=area.scrollHeight;}
 function showExecTab(tab){$('console-pane').hidden=tab!=='console';$('preview-pane').hidden=tab!=='preview';$('show-console').classList.toggle('active',tab==='console');$('show-preview').classList.toggle('active',tab==='preview');}
 function runCode(){const p=ctx.project(),filename=p.active;const setting=$('runtime-choice').value;const lang=setting==='auto'?(filename.endsWith('.py')?'python':'javascript'):setting;if(setting==='auto'&&!/\.(py|js|mjs|cjs)$/.test(filename))return ctx.toast('Choose a .js or .py file, or set the runtime manually.',true);if(lang==='python'&&navigator.onLine===false){ctx.toast('You appear to be offline. Python needs to download its runtime once before it can run.',true);return;}finishCodeMetric('cancelled','superseded');showExecTab('console');terminalLines=0;$('console-output').textContent=`Running ${filename} in isolated ${lang==='python'?'Python/WebAssembly':'JavaScript'} worker…`;codeRunTrace=ctx.metrics.begin('code-run');if(codeRunTrace){codeRunRequestId=crypto.randomUUID();codeRunStartedAt=performance.now();codeRunLang=lang;ctx.audit('run',lang,'started',null,{requestId:codeRunRequestId});}try{lastRunLang=lang;if(lang==='python')pythonRuntimeStatus='RUNNING — REQUIRES CDN';run.run(p.files[filename],lang,(type,msg)=>{if(type==='done')finishCodeMetric('ok');else if(type==='error')finishCodeMetric('error','runtime-error');if(lang==='python'){if(type==='done'&&msg.includes('Python execution complete.'))pythonRuntimeStatus='EXECUTED THIS SESSION';else if(type==='error')pythonRuntimeStatus='FAILED THIS SESSION';}if(type==='error')printConsole('ERROR: '+msg);else printConsole(msg);},lang==='python'?120000:Number($('code-time-limit').value),lang==='javascript'?{files:p.files,entry:filename}:null,phase=>{try{ctx.metrics.event(codeRunTrace,phase)}catch{}});}catch(e){finishCodeMetric('error','worker-error');ctx.toast(errorText(e),true);}}
 function stopCode(){run.stop('Execution stopped by user.');}
 function previewPage(){finishCodeMetric('cancelled','superseded');run.stop();const span=ctx.metrics.begin('preview');const p=ctx.project();const html=p.active.endsWith('.html')?p.active:Object.keys(p.files).find(f=>f.endsWith('.html'));if(!html){ctx.metrics.finish(span,'cancelled','invalid-input');return ctx.toast('Create or select an HTML file to preview.',true);}try{const result=previewReport(p.files,html,p.binaryAssets||{});const frame=make('iframe');frame.title='Opaque-origin local project preview';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.srcdoc=result.document;$('preview-host').replaceChildren(frame);showExecTab('preview');const note=$('preview-warnings-note'),list=$('preview-warnings');if(note&&list){list.replaceChildren(...result.warnings.map(w=>make('li','',w)));note.hidden=result.warnings.length===0;list.hidden=result.warnings.length===0;}ctx.metrics.finish(span,result.warnings.length?'warning':'ok',result.warnings.length?'unsupported-asset':'none');ctx.toast(result.warnings.length?`Playing ${html} — ${result.warnings.length} file(s) could not be shown, listed below the stage. First: ${result.warnings[0]}`:`Playing ${html} in the stage — pictures, sounds and files included.`,result.warnings.length>0);}catch(error){ctx.metrics.finish(span,'error','invalid-input');ctx.toast('Preview could not be built: '+errorText(error),true);}}
 function attachRunner(next){
  run=next;
  run.onStop=msg=>{if(lastRunLang==='python'&&pythonRuntimeStatus.startsWith('RUNNING'))pythonRuntimeStatus=msg.includes('timed out')?'TIMED OUT THIS SESSION':'STOPPED THIS SESSION';finishCodeMetric(msg.includes('timed out')?'timeout':msg.includes('Output flood')?'error':'cancelled',msg.includes('timed out')?'time-limit':msg.includes('Output flood')?'output-limit':'user-stop');printConsole(msg);};
 }
 function clearConsole(){terminalLines=0;$('console-output').textContent='';}
 return {finishCodeMetric,printConsole,showExecTab,runCode,stopCode,previewPage,attachRunner,clearConsole,
  getPythonStatus(){return pythonRuntimeStatus;},
  getTerminalLines(){return terminalLines;}};
}
