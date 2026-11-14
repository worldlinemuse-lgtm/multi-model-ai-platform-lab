/* Browser executors for the agent tools (local Simone bridge, 2026-11-13).
 * Every action goes through an existing lab boundary: RuntimeRunner (opaque-origin sandbox frame +
 * Worker, run time limit) for code, and the Q04 prepareTextEdit/applyTextEdit review path for edits.
 * Nothing here touches the vault, the network or GitHub. */
import {RuntimeRunner} from './sandbox.js';
import {safeName,safeFiles,now} from './core.js';
import {prepareTextEdit,applyTextEdit} from './review-edits.js';
import {lineDiff} from './snapshot-diff.js';
import {MAX_TOOL_RESULT_CHARS} from './agent-tools.js';

export const AGENT_RUN_LIMITS=Object.freeze({javascript:10000,python:120000});
const MAX_READ_CHARS=MAX_TOOL_RESULT_CHARS-400;

export function runInSandbox(code,lang,{host=document.body,limitMs=AGENT_RUN_LIMITS[lang],signal}={}){
 return new Promise(resolve=>{
  const lines=[],started=performance.now();let settled=false,errorText='';
  const runner=new RuntimeRunner(host,()=>{});
  const done=(status,extra={})=>{if(settled)return;settled=true;signal?.removeEventListener('abort',onAbort);
   let output=lines.join('\n');if(output.length>MAX_READ_CHARS)output=output.slice(0,MAX_READ_CHARS)+`\n…[output truncated, ${output.length} characters total]`;
   resolve({status,language:lang,output,...(errorText?{error:errorText.slice(0,2000)}:{}),durationMs:Math.round(performance.now()-started),...extra});};
  const onAbort=()=>runner.stop('Execution stopped by user.');
  runner.onStop=reason=>done(/timed out/i.test(reason)?'timeout':/flood/i.test(reason)?'output_limit':'stopped',{detail:reason});
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)return done('stopped',{detail:'Execution stopped by user.'});
  runner.run(code,lang,(type,message)=>{
   if(type==='log')lines.push(message);
   else if(type==='error'){errorText=message;done('error');}
   else if(type==='done')done('ok');
  },limitMs,null);
 });
}

export function createAgentExecutor(ctx){
 const proposals=new Map();
 function previewEdit(callId,{name,content}){
  const p=ctx.project();
  if(!safeName(name))throw Error('Unsafe project path.');
  if(Object.hasOwn(p.files,name)){
   const proposal=prepareTextEdit(p.files,name,content);
   proposals.set(callId,{kind:'edit',proposal,projectId:p.id});
   return {name,created:false,preview:proposal.preview,added:proposal.added,removed:proposal.removed};
  }
  const after={...p.files,[name]:content};
  if(!safeFiles(after))throw Error('New file would exceed project limits.');
  const diff=lineDiff('',content);
  if(diff.status!=='ok')throw Error('New file preview cannot be shown within safe bounds: '+diff.text);
  proposals.set(callId,{kind:'create',name,content,before:JSON.stringify(p.files),projectId:p.id});
  return {name,created:true,preview:diff.text,added:diff.added,removed:0};
 }
 async function execute({call,tool,args,signal}){
  const p=ctx.project();
  switch(tool.name){
   case 'list_files':return {project:p.name,entry:p.entry||p.active,files:Object.keys(p.files).sort().map(name=>({name,chars:p.files[name].length}))};
   case 'read_file':{
    if(!Object.hasOwn(p.files,args.name))throw Error(`No file named ${args.name}. Use list_files.`);
    const text=p.files[args.name];
    return {name:args.name,chars:text.length,truncated:text.length>MAX_READ_CHARS,content:text.slice(0,MAX_READ_CHARS)};
   }
   case 'run_javascript':return runInSandbox(args.code,'javascript',{host:ctx.sandboxHost?.()||document.body,signal});
   case 'run_python':return runInSandbox(args.code,'python',{host:ctx.sandboxHost?.()||document.body,signal});
   case 'propose_edit':{
    const pending=proposals.get(call.id);proposals.delete(call.id);
    if(!pending)throw Error('Edit was not reviewed; nothing applied.');
    if(pending.projectId!==p.id)throw Error('Active project changed since review; nothing applied.');
    if(pending.kind==='edit'){
     const {files}=applyTextEdit(p.files,pending.proposal,{confirmed:true});
     p.files=files;
    }else{
     if(JSON.stringify(p.files)!==pending.before)throw Error('Project changed since review; nothing applied.');
     const after={...p.files,[pending.name]:pending.content};
     if(!safeFiles(after))throw Error('New file would exceed project limits.');
     p.files=after;
    }
    p.updated=now();
    ctx.renderFiles?.();
    await ctx.saveNow();
    ctx.audit('agent-edit',ctx.route?.()||'agent','applied',null);
    return {applied:true,name:args.name,created:pending.kind==='create',chars:args.content.length};
   }
   default:throw Error('No executor for '+tool.name);
  }
 }
 return {execute,previewEdit,discard:id=>proposals.delete(id)};
}
