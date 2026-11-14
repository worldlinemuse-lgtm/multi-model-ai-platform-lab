// Chat (threads, send, retry draft), extracted from main.js (Stage 4b
// group 6). Wired into main.js 2026-11-05: main.js keeps one-line shims
// for the widely-called helpers so the wire() handlers and
// selectView/renderAll do not churn. The provider call itself arrives via
// ctx.callProvider (main.js passes the real callProvider), so the module
// never touches the network directly and node tests can substitute a fake.
import {uid,now,capMessageContent,historyForRoute} from './core.js';
import {findManualRetryDraft} from './connection-diagnostics.js';
import {traceDuration} from './request-trace.js';
import {$,make,clearNode,errorText} from './dom-helpers.js';
import {runToolLoop} from './agent-loop.js';
import {AGENT_TOOLS,needsApproval} from './agent-tools.js';
import {createAgentExecutor} from './agent-executor.js';

export function createChat(ctx){
 let activeChatControllers=[],chatSendPending=false;
 const state=()=>ctx.getState();
 const thread=()=>ctx.thread();
 function q22DraftManualRetry(){
  if(chatBusy())return ctx.toast('Stop running requests before preparing a retry.',true);
  const route=$('chat-route').value,draft=findManualRetryDraft(thread().messages,route);
  if(!draft)return ctx.toast('No saved failed response for this selected route has a matching user message.',true);
  if(!confirm('Prepare the last failed prompt for '+route+'? A new send may spend quota even if the original request completed remotely. Preparing does not send anything.'))return;
  $('chat-input').value=draft.prompt;
  $('chat-counter').textContent=draft.prompt.length+' / 10,000';
  ctx.toast('Retry draft prepared only. Review it and press Send yourself to make a new request.');
  $('chat-input').focus();
 }
 function chatDateGroup(ts){const d=new Date(ts),now=new Date();const startOfDay=x=>{const c=new Date(x);c.setHours(0,0,0,0);return c;};const days=Math.floor((startOfDay(now)-startOfDay(d))/86400000);if(days<=0)return 'Today';if(days===1)return 'Yesterday';if(days<7)return 'Previous 7 days';if(days<30)return 'Previous 30 days';return 'Older';}
 function renderThreadList(){const host=clearNode($('thread-list')),query=$('thread-search').value.trim().toLowerCase();let count=0;let lastGroup=null;for(const t of state().threads.slice().reverse()){if(query&&!t.title.toLowerCase().includes(query)&&!t.messages.some(m=>m.content.toLowerCase().includes(query)))continue;count++;if(!query){const g=chatDateGroup(t.created||Date.now());if(g!==lastGroup){host.append(make('div','chat-date-group',g));lastGroup=g;}}const b=make('button','thread-entry'+(t.id===state().activeThreadId?' active':''),t.title||'Conversation');b.type='button';b.addEventListener('click',()=>{if(chatBusy())return ctx.toast('Finish the pending message save or model request before switching chats.',true);state().activeThreadId=t.id;renderChat();ctx.saveSoon()});host.append(b);}if(!count)host.append(make('p','hint-line','No matching conversations.'));}
 function renderChat(){$('chat-output-tokens').value=String(state().preferences.maxOutputTokens??512);ctx.routeChoices();renderThreadList();const host=clearNode($('chat-messages'));const t=thread();if(!t.messages.length){const empty=make('div','chat-empty');empty.append(make('span','','✳'),make('h3','','Your next idea starts here.'),make('p','','Unlock a provider key, choose its model, then send a message. You can also compare two connected routes.'));const chips=make('div','prompt-chips');for(const prompt of ['Brainstorm product names','Explain a tricky concept','Review my code','Draft a professional email']){const c=make('button','prompt-chip',prompt);c.type='button';c.addEventListener('click',()=>{const inp=$('chat-input');inp.value=prompt;inp.focus();$('chat-counter').textContent=prompt.length+' / 10,000';});chips.append(c);}empty.append(chips);host.append(empty);}else for(const msg of t.messages){const bubble=make('div','bubble '+(msg.role==='user'?'user':'assistant')+(msg.agentTool?' tool':'')+(msg.error?' error':''));bubble.append(make('div','bubble-meta',msg.role==='user'?'YOU':msg.agentTool?`TOOL · ${msg.provider||'agent'}`:`${msg.provider||'MODEL'} · ${msg.model||'unverified'}`),make('div','bubble-text',msg.content));if(msg.role==='user'){const edit=make('button','text-button','Edit message');edit.type='button';edit.setAttribute('aria-label','Edit saved user message');edit.addEventListener('click',()=>{if(chatBusy())return ctx.toast('Finish the pending message save or model request before editing chat history.',true);const updated=prompt('Edit this locally saved user message (not resent to providers):',msg.content);if(updated===null)return;if(!updated.trim()||updated.length>10000)return ctx.toast('Message must contain 1–10,000 characters.',true);msg.content=updated;renderChat();ctx.saveSoon();ctx.toast('Saved user message edited locally; no request was sent.');});bubble.append(edit);}host.append(bubble);}host.scrollTop=host.scrollHeight;const tt=$('chat-to-top');if(tt)tt.hidden=true;}
 function chatBusy(){return chatSendPending||activeChatControllers.length>0;}
 function newThread(){if(chatBusy())return ctx.toast('Stop the active model request before starting a new chat.',true);if(state().threads.length>=120){if(!confirm('The 120-chat limit is reached. Creating another thread will delete the oldest one. Export your history first. Continue?'))return;state().threads.shift();}const t={id:uid('thread'),title:'New conversation',created:now(),messages:[]};state().threads.push(t);state().activeThreadId=t.id;renderChat();ctx.saveSoon();}
 function clearThread(){if(chatBusy())return ctx.toast('Stop the active model request before clearing chat.',true);if(!confirm('Clear the currently selected conversation?'))return;thread().messages=[];thread().title='New conversation';renderChat();ctx.saveSoon();}
 function exportThread(){const t=thread();ctx.download('mm-chat-'+t.id.replace(/[^a-z0-9_-]/gi,'')+'.json',JSON.stringify({format:'mm-studio-thread-v1',thread:t},null,2));}
 function deleteThread(){if(chatBusy())return ctx.toast('Stop the active model request before deleting chat.',true);const current=thread();if(!confirm('Delete this conversation and all its locally saved messages? This cannot be undone. Export it first if needed.'))return;state().threads=state().threads.filter(t=>t.id!==current.id);if(!state().threads.length)state().threads=[{id:uid('thread'),title:'New conversation',created:now(),messages:[]}];state().activeThreadId=state().threads[state().threads.length-1].id;renderChat();ctx.saveSoon();ctx.toast('Conversation deleted locally.');}
 function recordMessage(t,msg){const stored={...msg,at:now(),content:capMessageContent(msg.content)};t.messages.push(stored);t.messages=t.messages.slice(-150);renderChat();ctx.saveSoon();return stored;}
 async function sendMessage(event){event?.preventDefault();const input=$('chat-input');const promptText=input.value.trim();if(!promptText)return;if(!ctx.isDurableStorage())return ctx.toast('Persistent browser storage is required before sending a model request. Export your work and enable IndexedDB.',true);if(navigator.onLine===false)return ctx.toast('You appear to be offline. Reconnect to send AI requests.',true);const id=$('chat-route').value;if(!id||!ctx.vault.get(id)){ctx.toast('Unlock your vault and select a connected key first. Taking you to the Key vault…',true);setTimeout(()=>ctx.selectView('vault'),900);return;}if(activeChatControllers.length)return ctx.toast('A model request is already running.',true);if(chatSendPending)return ctx.toast('A message send is already in progress.',true);const agentOn=!!$('agent-mode')?.checked;if(agentOn&&$('compare-mode').checked)return ctx.toast('Agent tools run on one route. Turn off Compare to use them.',true);const targets=[id];if($('compare-mode').checked){const second=$('compare-route').value;if(!second||second===id||!ctx.vault.get(second))return ctx.toast('Select a different, connected second route to compare.',true);targets.push(second);}const t=thread();if(t.messages.length>=147&&!confirm('This chat is near its 150-message limit. Older messages may be removed. Export this chat before continuing. Send anyway?'))return;const priorTitle=t.title,priorMessages=t.messages.slice();if(!t.messages.length)t.title=promptText.slice(0,45);chatSendPending=true;$('send-chat').disabled=true;recordMessage(t,{role:'user',content:promptText});
 // Persist-before-dispatch (re-audit item 3): the prompt must reach disk
 // before any provider request starts, so a crash inside the old 300 ms
 // debounce window cannot lose a prompt whose quota was already spent.
 // On failure nothing is dispatched; the exact previous conversation is restored
 // (including messages evicted by the 150-message retention limit) and the prompt is restored to the
 // input, so re-sending records exactly one message. A synchronous
 // chatSendPending guard closes the double-submit window: the controller
 // guard is only populated at dispatch, so without it a second submit
 // during the save would pass the guard and dispatch twice. The failure
 // path removes exactly the recorded message by identity, not pop-last,
 // so it can never delete a different message.
 try{await ctx.saveNow();}catch(e){t.messages=priorMessages;t.title=priorTitle;renderChat();input.value=promptText;$('chat-counter').textContent=promptText.length+' / 10,000';chatSendPending=false;$('send-chat').disabled=false;ctx.toast('Request not sent: the prompt could not be saved locally. It is back in the input — send again once storage recovers, or export a backup first.',true);return;}
 input.value='';$('chat-counter').textContent='0 / 10,000';$('send-chat').disabled=true;$('stop-chat').disabled=false;
 if(agentOn)return runAgent(t,promptText,id);
 const pending=targets.map(route=>{const controller=new AbortController();activeChatControllers.push(controller);const traceId=crypto.randomUUID(),startedAt=performance.now(),cred=ctx.vault.get(route);ctx.audit('inference',route,'requested',null,{requestId:traceId,model:cred?.model});const inferSpan=ctx.metrics.begin('inference');ctx.metrics.event(inferSpan,'request-sent');return (async()=>{try{const result=await ctx.callProvider(route,cred,[{role:'system',content:'Be helpful, accurate, and identify uncertainties.'},...historyForRoute(t.messages.slice(0,-1),route),{role:'user',content:promptText}],{signal:controller.signal,maxOutputTokens:state().preferences.maxOutputTokens??512});ctx.metrics.event(inferSpan,'response-received');ctx.metrics.finish(inferSpan,'ok');recordMessage(t,{role:'assistant',provider:route,model:result.model,content:result.text});ctx.audit('inference',route,'success',result.usage,{requestId:traceId,model:result.model,latencyMs:traceDuration(startedAt,performance.now()),httpStatus:result.httpStatus});return result;}catch(e){const cancelled=e.name==='AbortError';ctx.metrics.finish(inferSpan,cancelled?'cancelled':'error',cancelled?'user-stop':'runtime-error');recordMessage(t,{role:'assistant',provider:route,model:ctx.vault.get(route)?.model,error:true,content:cancelled?'Request stopped.':errorText(e)});ctx.audit('inference',route,cancelled?'stopped':'failed',null,{requestId:traceId,model:cred?.model,latencyMs:traceDuration(startedAt,performance.now())});return null;}})()});let results;try{results=await Promise.all(pending);await ctx.saveNow();}catch(e){ctx.toast('The model response could not be saved. Export a workspace backup before closing this tab: '+errorText(e),true);}finally{activeChatControllers=[];chatSendPending=false;$('send-chat').disabled=false;$('stop-chat').disabled=true;}if(results?.every(r=>r===null)){ctx.toast('All model requests failed. Use Retry draft to prepare the prompt again.',true);}renderChat();}
 // ---- Agent tool bridge (local Simone build, 2026-11-13) ----------------------------------
 // One route, bounded loop (agent-loop.js), allowlisted tools (agent-tools.js), lab executors
 // (agent-executor.js). Reads run without a prompt; sandbox runs ask unless "Auto-approve sandbox
 // runs" is on; file edits ALWAYS show a diff and wait for Approve. Each tool call is shown in the
 // thread, written to the audit log, and kept in a bounded in-memory trace (agentTrace()).
 const executor=createAgentExecutor({project:ctx.project,saveNow:ctx.saveNow,audit:ctx.audit,renderFiles:ctx.renderFiles,route:()=>$('chat-route')?.value});
 const trace=[];let agentState='idle';
 function setAgentStatus(text,stateName){agentState=stateName||agentState;const el=$('agent-status');if(el){el.textContent=text;el.dataset.state=agentState;}}
 function logTrace(entry){trace.push({at:now(),...entry});if(trace.length>200)trace.splice(0,trace.length-200);}
 function agentTrace(){return trace.map(x=>({...x}));}
 const short=(v,n=600)=>{let s;try{s=typeof v==='string'?v:JSON.stringify(v);}catch{s=String(v);}return s.length>n?s.slice(0,n)+'…':s;};
 function agentSystemPrompt(route,cred){return `You are ${cred?.model||'a model'} served through the ${route} route inside Multi-Model Studio, a browser lab. You have tools that act in the lab: ${AGENT_TOOLS.map(x=>x.name).join(', ')}. Use a tool whenever running code or reading project files would make the answer more reliable; never invent results you could compute. Code runs in isolated sandboxes with no network access. Tool results arrive as JSON; if a run fails, read the error, fix the code and try again. The user may deny a tool call; if so, do not repeat it. The lab resends recent turns of this conversation, so you do see prior context. When finished, reply to the user in plain text and base claims about results only on tool output you actually received.`;}
 function askApproval({call,tool,args,signal}){
  const policy={autoRead:true,autoExecute:!!$('agent-auto-run')?.checked};
  if(!needsApproval(tool,policy)){logTrace({kind:'approval-decision',tool:tool.name,id:call.id,decision:'auto'});return Promise.resolve(true);}
  let body;
  try{
   if(tool.name==='propose_edit'){const prev=executor.previewEdit(call.id,args);body=`${prev.created?'Create':'Edit'} ${prev.name} (+${prev.added} / -${prev.removed} lines)\n\n${prev.preview}`;}
   else body=args.code??short(args,4000);
  }catch(e){logTrace({kind:'approval-decision',tool:tool.name,id:call.id,decision:'preview-failed',error:errorText(e)});return Promise.reject(Object.assign(Error('Preview failed: '+errorText(e)),{name:'PreviewError'}));}
  const box=$('agent-approval');
  if(!box)return Promise.resolve(false);
  $('agent-approval-title').textContent=`${tool.name.replace('_',' ')} requested by the model`+(tool.risk==='write'?' — review the diff':'');
  $('agent-approval-body').textContent=body.slice(0,20000);
  box.hidden=false;setAgentStatus('Waiting for your approval: '+tool.name,'approval');
  return new Promise(resolve=>{
   const finish=ok=>{box.hidden=true;$('agent-approve').onclick=null;$('agent-deny').onclick=null;signal?.removeEventListener('abort',onAbort);if(!ok)executor.discard(call.id);logTrace({kind:'approval-decision',tool:tool.name,id:call.id,decision:ok?'approved':'denied'});setAgentStatus(ok?'Running '+tool.name+'…':'Denied '+tool.name,'running');resolve(ok);};
   const onAbort=()=>finish(false);
   signal?.addEventListener('abort',onAbort,{once:true});
   $('agent-approve').onclick=()=>finish(true);
   $('agent-deny').onclick=()=>finish(false);
   $('agent-approve').focus?.();
  });
 }
 // Drops earlier user turns that never got a reply on this route (a failed or stopped run), so the
 // model answers the newest prompt instead of an older dangling one.
 function answeredHistory(list){return list.filter((m,i)=>m.role!=='user'||list[i+1]?.role==='assistant');}
 async function runAgent(t,promptText,route){
  const controller=new AbortController();activeChatControllers.push(controller);
  const cred=ctx.vault.get(route),runId=crypto.randomUUID(),startedAt=performance.now();
  const maxOutputTokens=state().preferences.maxOutputTokens??512;
  logTrace({kind:'run-start',runId,route,model:cred?.model,prompt:short(promptText,300)});
  setAgentStatus('Agent running…','running');
  ctx.audit('agent-run',route,'requested',null,{requestId:runId,model:cred?.model});
  const messages=[{role:'system',content:agentSystemPrompt(route,cred)},...answeredHistory(historyForRoute(t.messages.slice(0,-1),route)),{role:'user',content:promptText}];
  let result=null;
  try{
   result=await runToolLoop({
    messages,signal:controller.signal,
    call:async(convo,{tools,signal,toolChoice})=>{const reqId=crypto.randomUUID(),t0=performance.now();ctx.audit('inference',route,'requested',null,{requestId:reqId,model:cred?.model});try{const r=await ctx.callProvider(route,cred,convo,{signal,tools,toolChoice,maxOutputTokens});ctx.audit('inference',route,'success',r.usage,{requestId:reqId,model:r.model,latencyMs:Math.min(120000,traceDuration(t0,performance.now())),httpStatus:r.httpStatus});return r;}catch(e){ctx.audit('inference',route,e.name==='AbortError'?'stopped':'failed',null,{requestId:reqId,model:cred?.model,latencyMs:Math.min(120000,traceDuration(t0,performance.now()))});throw e;}},
    approve:askApproval,
    execute:a=>executor.execute(a),
    onEvent:ev=>{
     logTrace({kind:ev.type,...ev,runId});
     if(ev.type==='rate-limit-wait')setAgentStatus(`Provider rate limit: waiting ${Math.ceil(ev.waitMs/1000)} s, then retrying (attempt ${ev.attempt})…`,'running');
     if(ev.type==='request')setAgentStatus(`Agent round ${ev.round}: asking the model…`,'running');
     if(ev.type==='provider-retry')recordMessage(t,{role:'assistant',provider:route,model:cred?.model,agentTool:true,content:'Provider rejected a malformed tool call; the model was asked to retry once.\n'+ev.error});
     if(ev.type==='tool'){
      const status=ev.status==='ok'&&ev.result?.status&&ev.result.status!=='ok'?ev.result.status:ev.status;
      ctx.audit('agent-tool',route,(ev.name||'unknown').slice(0,40)+':'+status,null,{requestId:runId});
      const lines=[`${ev.name} — ${status}`];
      if(ev.args?.code)lines.push('code:\n'+short(ev.args.code,1500));else if(ev.args&&Object.keys(ev.args).length)lines.push('args: '+short(ev.name==='propose_edit'?{name:ev.args.name,chars:ev.args.content?.length}:ev.args,300));
      if(ev.result!==undefined)lines.push('result:\n'+(ev.result?.output!==undefined?(ev.result.output||'(no output)')+(ev.result.error?'\nerror: '+ev.result.error:''):short(ev.result,1500)));
      if(ev.error)lines.push('error: '+ev.error);
      recordMessage(t,{role:'assistant',provider:route,model:cred?.model,agentTool:true,error:status!=='ok',content:lines.join('\n')});
     }
    }
   });
   const tail=result.status==='final'?'':result.status==='limit'?`\n\n[Agent stopped: ${result.reason}.]`:result.status==='stopped'?'\n\n[Agent run stopped.]':'';
   const content=(result.text||'')+tail||(result.status==='error'?'Agent error: '+result.error:'(no reply)');
   recordMessage(t,{role:'assistant',provider:route,model:result.model||cred?.model,error:result.status==='error'||(!result.text&&result.status!=='final'),content:content.trim()||'(empty reply)'});
   ctx.audit('agent-run',route,result.status,Object.keys(result.usage).length?result.usage:null,{requestId:runId,model:result.model||cred?.model,latencyMs:Math.min(120000,traceDuration(startedAt,performance.now()))});
   logTrace({kind:'run-end',runId,status:result.status,rounds:result.rounds,toolCalls:result.toolCalls,usage:result.usage});
   setAgentStatus(`Agent ${result.status} · ${result.rounds} round(s) · ${result.toolCalls} tool call(s)`,result.status==='final'?'idle':result.status);
  }catch(e){
   recordMessage(t,{role:'assistant',provider:route,model:cred?.model,error:true,content:'Agent error: '+errorText(e)});
   logTrace({kind:'run-end',runId,status:'exception',error:errorText(e)});
   setAgentStatus('Agent error','error');
  }finally{
   try{await ctx.saveNow();}catch(e){ctx.toast('The agent transcript could not be saved. Export a backup: '+errorText(e),true);}
   activeChatControllers=[];chatSendPending=false;$('send-chat').disabled=false;$('stop-chat').disabled=true;const box=$('agent-approval');if(box)box.hidden=true;
   renderChat();
  }
  return result;
 }
 function stopChat(){activeChatControllers.forEach(c=>c.abort());ctx.toast('Stop requested for all in-flight model requests.');}
 function addCodeToChat(){const p=ctx.project();const content=p.files[p.active];$('chat-input').value=($('chat-input').value+'\n\nPlease review the following file '+p.active+':\n```\n'+content.slice(0,8000)+'\n```').trim().slice(0,10000);$('chat-counter').textContent=$('chat-input').value.length+' / 10,000';ctx.selectView('chat');$('chat-input').focus();}
 return {runAgent,agentTrace,answeredHistory,askApproval,q22DraftManualRetry,chatDateGroup,renderThreadList,renderChat,chatBusy,newThread,clearThread,exportThread,deleteThread,recordMessage,sendMessage,stopChat,addCodeToChat};
}
