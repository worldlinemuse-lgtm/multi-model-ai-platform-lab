// Remaining views: usage audit, workflows, knowledge, capabilities,
// settings, backup/restore, command palette and activity bar — extracted
// from main.js (Stage 4b group 7). Wired into main.js 2026-11-05: main.js
// keeps one-line shims for renderAll, exportAll and renderAudit (the
// store and providers contexts captured them before this module exists);
// the wire() handlers call workbench.* directly. Function bodies are
// copied verbatim from main.js with global references replaced by
// closure/ctx references only. wire() and boot() stay in main.js: they
// are the app entry and assembly (they construct the runner, labs,
// wasm/repl and the module instances themselves), not extractable view
// logic.
import {VERSION,MAX_NOTES,MAX_AUDIT,FLOW_TEMPLATES,VIEWS,CAPABILITIES,uid,now,csvSummary,validateState} from './core.js';
import {storageMode} from './storage.js';
import {compileWorkflowPlan,validateSavedWorkflowPlan} from './workflow-plan.js';
import {executeSavedPlan} from './workflow-supervisor.js';
import {parseNoteArchive,exportNoteArchive} from './knowledge.js';
import {knowledgePage} from './knowledge-pages.js';
import {retrieveLocalEvidence,formatLocalEvidence} from './local-evidence.js';
import {readKnowledgeDocument} from './knowledge-documents.js';
import {readBrowserCapabilities} from './capability-probes.js';
import {probeWebGPUReadiness} from './ondevice-readiness.js';
import {renderTelemetry} from './telemetry-view.js';
import {otelDiagnosticsText} from './otel-workshop.js';
import {editLocalNote,findExactNoteDuplicates} from './note-tools.js';
import {$,make,clearNode,formatTime,errorText} from './dom-helpers.js';

export function createWorkbench(ctx){
 let workflowController=null,activeNote=null,editingNoteId=null,currentKnowledgePage=0;
 let localEvidenceDraft='',capabilityProbeEpoch=0,q27ProbeActive=false;
 const state=()=>ctx.getState();
 function renderAudit(){const events=state().audit;const reqs=events.filter(x=>x.op==='inference'&&x.status!=='requested');$('usage-total').textContent=reqs.length;$('usage-success').textContent=reqs.filter(x=>x.status==='success').length;const observed=reqs.filter(x=>Number.isSafeInteger(x.usage?.total_tokens));const unreported=reqs.length-observed.length;$('usage-tokens').textContent=`${observed.reduce((s,x)=>s+x.usage.total_tokens,0)} tokens`;const tokensNote=$('usage-tokens-note');if(tokensNote)tokensNote.textContent=`across ${observed.length} calls with reported usage; ${unreported} calls reported no usage`;const shown=events.slice(0,100);const windowEl=$('audit-window');if(windowEl)windowEl.textContent=`Showing latest ${shown.length} of ${events.length} recorded events (audit log capped at ${MAX_AUDIT}).`;const body=clearNode($('audit-rows'));for(const a of shown){const tr=make('tr');for(const value of [formatTime(a.at),`${a.provider||'local'} / ${a.op}`,a.status,a.requestId?.slice(0,8)||'—',a.model||'—',a.latencyMs==null?'unknown':a.latencyMs+' ms',a.usage?`${a.usage.total_tokens===null?'unknown':a.usage.total_tokens} tokens · ${a.usage.source}`:'unknown'])tr.append(make('td',value==='failed'?'bad':'',value));body.append(tr);}if(!events.length){const tr=make('tr'),td=make('td','','No activity recorded.');td.colSpan=7;tr.append(td);body.append(tr);}}
 function flowStages(){const entered=$('workflow-stages').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);return entered.length?entered:FLOW_TEMPLATES[$('workflow-template').value]||FLOW_TEMPLATES.research;}
 function renderFlowGraph(states=[],givenPlan=null){
  const stages=givenPlan||flowStages(),host=clearNode($('workflow-graph'));
  if(stages.length>6){host.textContent=stages.length+' stages entered. Maximum is 6; remove extras before starting.';return;}
  stages.forEach((stage,i)=>{
   const caption=typeof stage==='string'?stage:stage.label+' ['+stage.route+']';
   const tile=make('div','flow-step '+(states[i]||'pending'),(i+1)+'. '+caption);
   tile.append(make('span','',({pending:'Waiting',running:'Running',done:'Complete',skipped:'Skipped',error:'Failed'})[states[i]]||''));
   host.append(tile);if(i!==stages.length-1)host.append(make('span','flow-arrow','→'));
  });
  if(!givenPlan){
   try{
    const plan=compileWorkflowPlan($('workflow-stages').value||FLOW_TEMPLATES[$('workflow-template').value].join('\n'),$('workflow-route').value,ctx.vault.list().map(x=>x.id));
    $('workflow-estimate').textContent='Validated '+plan.length+' stages, at most '+plan.length+' authorized model calls: '+plan.map(x=>x.route).join(' → ')+'. Conditions may skip a call.';
   }catch(e){$('workflow-estimate').textContent='Plan check: '+errorText(e);}
  }
 }
 function workflowText(w){return w.steps.map(s=>s.stage+(s.model?' ('+s.model+')':'')+(s.provider?' ['+s.provider+']':'')+'\n'+s.content).join('\n\n---\n\n');}
 function renderWorkflows(){
  ctx.routeChoices();renderFlowGraph();
  const host=clearNode($('workflow-history'));
  for(const w of state().workflows.slice(0,30)){
   const b=make('button','history-entry');b.type='button';
   b.append(make('strong','',w.template+' · '+w.status),make('small','',formatTime(w.at)+' · '+w.goal.slice(0,65)));
   b.addEventListener('click',()=>{$('workflow-results').textContent=workflowText(w)||'No finished stage output yet.';});host.append(b);
  }
  if(!state().workflows.length)host.textContent='No runs recorded.';
  $('workflow-resume').disabled=!!workflowController||!state().workflows.some(workflowResumable);
 }
 function workflowResumable(w){if(!Array.isArray(w.plan))return false;if(['running','stopped'].includes(w.status))return w.steps.length<w.plan.length;if(w.status==='failed')return w.steps.at(-1)?.status==='failed';return false;}
 async function runWorkflowCheckpoint(result){
  if(workflowController)return ctx.toast('Stop the active workflow first.',true);
  if(!validateSavedWorkflowPlan(result.plan))return ctx.toast('Stored plan validation failed.',true);
  const controller=new AbortController();workflowController=controller;
  $('workflow-start').disabled=true;$('workflow-stop').disabled=false;$('workflow-resume').disabled=true;
  const progress=()=>result.plan.map((_,i)=>result.steps[i]?(result.steps[i].status==='skipped'?'skipped':result.steps[i].status==='failed'?'error':'done'):'pending');
  try{
   await executeSavedPlan(result,{
    signal:controller.signal,
    persist:async()=>await ctx.saveNow(),
    onStage:(run,i,status)=>{
     const states=progress();states[i]=status;renderFlowGraph(states,run.plan);
     $('workflow-results').textContent=workflowText(run)||'Running authorized stages…';
    },
    callStage:async(stage,prompt,signal)=>{
     const cred=ctx.vault.get(stage.route);
     if(!cred)throw Error('Route '+stage.route+' requires an unlocked key.');
     ctx.audit('inference',stage.route,'requested');
     try{
      const answer=await ctx.callProvider(stage.route,cred,[{role:'user',content:prompt}],{signal,maxOutputTokens:state().preferences.maxOutputTokens??512});
      ctx.audit('inference',stage.route,'success',answer.usage);return answer;
     }catch(e){ctx.audit('inference',stage.route,signal.aborted?'stopped':'failed');throw e;}
    }
   });
  }catch(error){result.status='stopped';ctx.toast('Workflow paused safely: '+errorText(error),true);}
  finally{
   workflowController=null;$('workflow-start').disabled=false;$('workflow-stop').disabled=true;
   $('workflow-results').textContent=workflowText(result)||'Workflow '+result.status+'.';renderWorkflows();
  }
 }
 async function executeWorkflow(event){
  event.preventDefault();
  if(workflowController)return ctx.toast('Stop the current workflow first.',true);
  if(!$('workflow-confirm').checked)return ctx.toast('Confirm explicit model requests first.',true);
  const goal=$('workflow-goal').value.trim(),template=$('workflow-template').value,provider=$('workflow-route').value;
  if(!goal)return ctx.toast('Enter a task goal.',true);
  let plan;
  try{plan=compileWorkflowPlan($('workflow-stages').value||FLOW_TEMPLATES[template].join('\n'),provider,ctx.vault.list().map(x=>x.id));}
  catch(e){return ctx.toast(errorText(e),true);}
  const result={id:uid('workflow'),at:now(),provider,template,goal,status:'running',steps:[],plan,inFlightStage:null};
  state().workflows.unshift(result);state().workflows=state().workflows.slice(0,40);
  try{await ctx.saveNow();}catch(e){state().workflows=state().workflows.filter(x=>x!==result);return ctx.toast('No request sent: '+errorText(e),true);}
  await runWorkflowCheckpoint(result);
 }
 async function resumeWorkflow(){
  if(workflowController)return;
  const result=state().workflows.find(workflowResumable);
  if(!result)return ctx.toast('No paused workflow to resume.',true);
  if(!validateSavedWorkflowPlan(result.plan))return ctx.toast('Saved plan integrity check failed.',true);
  const retryIndex=(result.status==='failed'&&result.steps.at(-1)?.status==='failed')?result.steps.length-1:result.steps.length;
  if(result.plan.slice(retryIndex).some(s=>!ctx.vault.get(s.route)))return ctx.toast('Unlock the required saved model routes before resuming.',true);
  if(!confirm('Resume '+(result.plan.length-retryIndex)+' remaining stage(s)? An interrupted request may already have consumed quota and may be reissued. Resume is manual only; no paid fallback.'))return;
  await runWorkflowCheckpoint(result);
 }
 function knowledgeItems(query){const results=[];for(const note of state().notes){if((note.title+' '+note.content).toLowerCase().includes(query)){results.push({type:'note',id:note.id,title:note.title,content:note.content});}}for(const p of state().projects){for(const [name,source]of Object.entries(p.files)){if((p.name+' '+name+' '+source).toLowerCase().includes(query))results.push({type:'file',id:name,projectId:p.id,title:p.name+' / '+name,content:source});}}return results;}
 function resolveActiveKnowledge(){
  if(!activeNote)return null;
  if(activeNote.type==='note'){const note=state().notes.find(n=>n.id===activeNote.id);return note?{type:'note',id:note.id,title:note.title,content:note.content}:null;}
  if(activeNote.type==='file'){const p=state().projects.find(item=>item.id===activeNote.projectId);if(!p||!Object.hasOwn(p.files,activeNote.id))return null;return {type:'file',id:activeNote.id,projectId:p.id,title:p.name+' / '+activeNote.id,content:p.files[activeNote.id]};}
  return null;
 }
 function previewLocalEvidence(){
  const query=$('knowledge-search').value.trim();
  if(!query){$('knowledge-evidence-output').textContent='Enter a phrase in Search local knowledge first.';return;}
  const docs=[
   ...state().notes.map(n=>({kind:'note',id:n.id,title:n.title,content:n.content})),
   ...state().projects.flatMap(p=>Object.entries(p.files).map(([name,content])=>({kind:'file',id:p.id+'/'+name,title:p.name+' / '+name,content})))
  ];
  try{
   const matches=retrieveLocalEvidence(docs,query);
   localEvidenceDraft=matches.length?formatLocalEvidence(matches):'';
   $('knowledge-evidence-output').textContent=matches.length?localEvidenceDraft:'No matching source passage. No local citations generated.';
   $('knowledge-insert-evidence').disabled=!matches.length;
  }catch(e){localEvidenceDraft='';$('knowledge-insert-evidence').disabled=true;$('knowledge-evidence-output').textContent='Local retrieval rejected: '+errorText(e);}
 }
 function insertLocalEvidence(){
  if(!localEvidenceDraft)return ctx.toast('Preview local excerpts first.',true);
  const prior=$('chat-input').value.trim();
  const combined=(prior?prior+'\n\n':'')+localEvidenceDraft;
  if(combined.length>10000)return ctx.toast('Local excerpt exceeds available chat input; shorten the question or existing message.',true);
  $('chat-input').value=combined;$('chat-counter').textContent=combined.length+' / 10,000';
  ctx.selectView('chat');ctx.toast('Local sources inserted as editable text. No provider request was made.');
 }
 function renderKnowledge(){localEvidenceDraft='';$('knowledge-evidence-output').textContent='Enter a search phrase and click Find local passages.';$('knowledge-insert-evidence').disabled=true;const live=resolveActiveKnowledge();$('knowledge-edit').disabled=!live||live.type!=='note';if(activeNote){activeNote=live;$('knowledge-preview').textContent=live?live.content.slice(0,15000):'Choose a search result.';}const query=$('knowledge-search').value.trim().toLowerCase(),matches=knowledgeItems(query),paged=knowledgePage(matches,currentKnowledgePage);currentKnowledgePage=paged.page;$('knowledge-page-info').textContent='Page '+(paged.page+1)+' of '+paged.pages+' · '+paged.from+'–'+paged.to+' of '+paged.total+' local matches';$('knowledge-page-prev').disabled=paged.page===0;$('knowledge-page-next').disabled=paged.page>=paged.pages-1;$('note-count').textContent=state().notes.length+' notes';const host=clearNode($('knowledge-results'));paged.items.forEach(result=>{const button=make('button','knowledge-result'+(activeNote?.id===result.id&&activeNote?.type===result.type?' active':''));button.append(make('b','',result.title),make('small','',result.content.slice(0,180)));button.addEventListener('click',()=>{activeNote=result;$('knowledge-preview').textContent=result.content.slice(0,15000);renderKnowledge();});host.append(button)});if(!matches.length)host.append(make('p','hint-line','No local matches.'));const dupReport=ctx.optionalControl('knowledge-duplicate-report');if(dupReport&&!dupReport.hidden)showDuplicateNotes();}
 function cancelNoteEdit(){editingNoteId=null;$('knowledge-title').value='';$('knowledge-content').value='';$('knowledge-submit').textContent='Save locally';$('knowledge-cancel-edit').hidden=true;}
 function beginNoteEdit(){const live=resolveActiveKnowledge();if(!live||live.type!=='note')return ctx.toast('Select a saved note to edit; project files are edited in Code Studio.',true);if(editingNoteId&&editingNoteId!==live.id&&!confirm('Discard unsaved note edits and switch to the selected note?'))return;editingNoteId=live.id;$('knowledge-title').value=live.title;$('knowledge-content').value=live.content;$('knowledge-submit').textContent='Save changes';$('knowledge-cancel-edit').hidden=false;$('knowledge-title').focus();}
 function showDuplicateNotes(){const groups=findExactNoteDuplicates(state().notes);const box=$('knowledge-duplicate-report');box.hidden=false;box.textContent=groups.length?'Exact-content duplicate groups (nothing deleted):\n'+groups.map((g,i)=>(i+1)+'. '+g.count+' notes: '+g.notes.map(n=>n.title+' ['+n.id.slice(-8)+']').join(' | ')).join('\n'):'No exact-content duplicates found. Nothing was deleted.';}
 function submitKnowledge(e){e.preventDefault();const title=$('knowledge-title').value.trim(),content=$('knowledge-content').value;if(!title||!content.trim())return ctx.toast('Both title and note content are required.',true);if(editingNoteId){const existing=state().notes.find(n=>n.id===editingNoteId);if(!existing){cancelNoteEdit();return ctx.toast('The edited note no longer exists.',true);}if(existing.title===title&&existing.content===content)return ctx.toast('No note changes to save.');if(!confirm('Replace the saved content of note "'+existing.title+'"? This changes the local record. Export a backup first if necessary.'))return;try{state().notes=editLocalNote(state().notes,editingNoteId,title,content,now());activeNote={type:'note',id:editingNoteId,title,content};cancelNoteEdit();renderKnowledge();ctx.saveSoon();ctx.toast('Note changes saved locally.');}catch(error){ctx.toast('Note edit rejected: '+error.message,true);}return;}if(state().notes.length>=MAX_NOTES)return ctx.toast('Note limit reached; export notes first.',true);state().notes.unshift({id:uid('note'),title,content,created:now()});cancelNoteEdit();renderKnowledge();ctx.saveSoon();ctx.toast('Knowledge note saved.');}
 async function importKnowledge(input){
  const files=Array.from(input.files||[]);input.value='';
  if(files.length>15)return ctx.toast('Import at most 15 documents per batch.',true);
  const pending=[];
  try{
   for(const file of files){
    const name=file.name.toLowerCase();
    if(name.endsWith('.pdf'))throw Error(file.name+': PDF extraction is not supported. No notes were imported.');
    if(name.endsWith('.docx')){
     const extracted=await readKnowledgeDocument(file);
     pending.push({id:uid('note'),title:extracted.title,content:extracted.text,created:now()});
     continue;
    }
    if(!/\.(txt|md|csv|json)$/.test(name))throw Error(file.name+': unsupported document type');
    if(name.endsWith('.json')&&file.size>30_000_000)throw Error(file.name+': JSON archive exceeds 30 MB');
    if(!name.endsWith('.json')&&file.size>100000)throw Error(file.name+': text document exceeds 100 KB');
    const content=await file.text();
    if(name.endsWith('.json')){
     const archived=parseNoteArchive(content);
     if(archived!==null){for(const note of archived)pending.push({...note,id:uid('note')});continue;}
     if(file.size>100000)throw Error(file.name+': text document exceeds 100 KB');
    }
    const prefix=name.endsWith('.csv')?csvSummary(content)+'\n\n':'';
    pending.push({id:uid('note'),title:file.name.slice(0,100),content:(prefix+content).slice(0,100000),created:now()});
   }
   if(state().notes.length+pending.length>MAX_NOTES)throw Error('Note capacity exceeded (maximum '+MAX_NOTES+')');
   if(!pending.length)return ctx.toast('No documents selected.',true);
   state().notes.push(...pending);ctx.saveSoon();renderKnowledge();ctx.toast(pending.length+' note(s) imported.');
  }catch(e){ctx.toast('Import failed: '+errorText(e),true);}
 }
 async function refreshLocalCapabilities(){const epoch=++capabilityProbeEpoch,host=$('capability-live-list'),button=$('capability-refresh');button.disabled=true;host.textContent='Checking local browser capability signals…';try{const readings=await readBrowserCapabilities(window);if(epoch!==capabilityProbeEpoch)return;host.replaceChildren();for(const reading of readings){const row=make('article','capability-row'),description=make('div');description.append(make('b','',reading.label),make('small','',reading.detail));row.append(description,make('span','tag muted',reading.status));host.append(row);} }catch(error){if(epoch===capabilityProbeEpoch)host.textContent='Browser capability diagnostics could not complete: '+errorText(error);}finally{if(epoch===capabilityProbeEpoch)button.disabled=false;}}
 async function runOndeviceReadiness(){
  if(q27ProbeActive)return;
  q27ProbeActive=true;const button=$('ondevice-probe');button.disabled=true;
  $('ondevice-probe-result').textContent='Checking only for a local WebGPU adapter. No device or model is running.';
  try{
   const result=await probeWebGPUReadiness();
   $('ondevice-probe-result').textContent=result.state.toUpperCase()+': '+result.summary+' No model was downloaded, loaded, or executed.';
  }catch{
   $('ondevice-probe-result').textContent='WebGPU readiness could not be checked. No model inference was attempted.';
  }finally{q27ProbeActive=false;button.disabled=false;}
 }
 async function renderWorkshopMetrics(){const snap=ctx.metrics.summary(),host=$('workshop-metrics-summary'),recent=$('workshop-metrics-events');$('workshop-metrics-enabled').checked=snap.enabled;const rows=snap.byOperation.filter(item=>item.total);host.textContent=rows.length?rows.map(item=>item.op+': '+item.total+' observed / '+item.errors+' error / '+item.timeouts+' timeout / '+item.cancelled+' stopped · p95 '+(item.p95Ms===null?'n/a':item.p95Ms+' ms')).join('\n'):'No workshop operations observed in this browser session.';recent.textContent=snap.recent.map(item=>item.op+' · '+item.outcome+' · '+item.reason+' · '+(item.durationMs===null?'n/a':item.durationMs+'ms')).join('\n')||'No events recorded.';const otelHost=$('otel-diagnostics');if(otelHost)otelHost.textContent=await otelDiagnosticsText(ctx.metrics);}
 function renderCapabilities(){const host=clearNode($('capability-list'));for(const [code,title,status,description]of CAPABILITIES){const row=make('article','capability-row');row.append(make('span','',status==='local'?'✓':status==='conditional'?'◇':'○'));const details=make('div');details.append(make('b','',`${code} · ${title}`),make('small','',description));row.append(details,make('span','tag '+(status==='local'?'good':status==='conditional'?'pending':'muted'),({local:'LOCAL',conditional:'EXTERNAL',partial:'PARTIAL',planned:'PLANNED'})[status]));host.append(row);}refreshLocalCapabilities();renderWorkshopMetrics();}
 function renderSettings(){const recovery=ctx.optionalControl('recovery-tools');if(recovery)recovery.hidden=ctx.store.recoveryRaw===null;if(ctx.store.recoveryRaw!==null)$('recovery-description').textContent='Unparseable '+(ctx.store.recoveryKind==='legacy'?'legacy B0.1/B0.2 project':'B0.3 browser state')+' detected. Original data has not been overwritten. Download a raw backup before resetting.';$('accent-select').value=state().preferences.accent;$('compact-toggle').checked=!!state().preferences.compact;$('platform-details').replaceChildren();for(const [k,v]of [['Build',VERSION],['Storage',storageMode()],['Security','Encrypted secrets; no keys in backups'],['Network','Provider requests only on explicit actions'],['GitHub','Public static source'],['Python','Optional Pyodide CDN runtime']]){const row=make('div');row.append(make('span','',k),make('strong','',v));$('platform-details').append(row);}}
 function exportAll(){ctx.tracedExport(()=>ctx.download('multimodel-studio-backup.json',JSON.stringify(state(),null,2)));}
 async function importAll(file){if(!file||file.size>12_000_000)return ctx.toast('Backup file exceeds limit.',true);const span=ctx.metrics.begin('project-import');try{const value=JSON.parse(await file.text());if(!validateState(value))throw Error('Invalid or unsupported backup');if(!confirm('Replace ALL local projects, chat, notes, and audit with this backup? Encrypted key vault remains untouched.')){ctx.metrics.finish(span,'cancelled','user-stop');return;}await ctx.replaceWorkspace(value);ctx.metrics.finish(span,'ok');ctx.toast('Workspace restored and saved.');}catch(e){ctx.metrics.finish(span,'error','invalid-input');ctx.toast('Restore failed: '+errorText(e),true);}}
 function renderAll(){ctx.getLabs()?.refreshSavedDatasets();ctx.renderFiles();ctx.routeChoices();ctx.renderProviders();ctx.renderVault();ctx.renderChat();renderAudit();renderWorkflows();renderKnowledge();ctx.renderStats();renderSettings();renderCapabilities();}
 const ACTIVITY_GROUPS=[['overview','workspace','chat','workflows','knowledge','datalab','media'],['providers','vault','usage','telemetry','capabilities','settings']];
 function buildActivityBar(){const bar=$('activity-bar');if(!bar||bar.dataset.built)return;bar.dataset.built='1';
 ACTIVITY_GROUPS.forEach((group,gi)=>{if(gi>0){const sep=document.createElement('div');sep.className='activity-sep';bar.append(sep);}
 for(const id of group){const navBtn=document.querySelector('.nav-item[data-view="'+id+'"]');const icon=navBtn?.querySelector('.nav-icon')?.textContent||'◈';const label=VIEWS[id]||id;
 const b=document.createElement('button');b.type='button';b.className='activity-btn';b.dataset.view=id;b.title=label;b.setAttribute('aria-label',label);b.textContent=icon;
 b.addEventListener('click',()=>ctx.selectView(id));bar.append(b);}});
 syncActivityBar();}
 function syncActivityBar(){for(const b of document.querySelectorAll('.activity-btn'))b.classList.toggle('selected',b.dataset.view===ctx.getActiveView());}
 function commandDialog(){const dialog=$('command-dialog'),input=$('command-search');input.value='';
 const actions=[
  ['Go to: Code studio',()=>ctx.selectView('workspace')],
  ['Go to: Model chat',()=>ctx.selectView('chat')],
  ['Go to: Key vault',()=>ctx.selectView('vault')],
  ['Go to: Telemetry',()=>ctx.selectView('telemetry')],
  ['Go to: Settings',()=>ctx.selectView('settings')],
  ['Run code (Code studio)',()=>{ctx.selectView('workspace');ctx.runCode();}],
  ['Stop running code',()=>{try{ctx.runStop();}catch{}}],
  ['New chat',()=>{ctx.selectView('chat');ctx.newThread();}],
  ['New code file',()=>{ctx.selectView('workspace');ctx.newFile();}],
  ['New project',()=>ctx.createProject()],
  ['Save now',()=>ctx.saveNow().then(()=>ctx.toast(ctx.savedStatus())).catch(()=>{})],
  ['Export workspace backup',()=>exportAll()],
  ['Toggle performance HUD',()=>{const t=$('hud-toggle');if(t){t.checked=!t.checked;t.dispatchEvent(new Event('change'));}else{ctx.selectView('telemetry');}}],
  ['Refresh telemetry',()=>renderTelemetry(state().audit,ctx.metrics)],
  ['Lock key vault',()=>{ctx.vault.lock();renderAll();ctx.toast('Key vault locked.');}],
 ];
 const render=()=>{const host=clearNode($('command-results'));const q=input.value.toLowerCase();
 for(const [id,label]of Object.entries(VIEWS)){if(!label.toLowerCase().includes(q))continue;const b=make('button','','Go to: '+label);b.addEventListener('click',()=>{dialog.close();ctx.selectView(id);});host.append(b);}
 for(const [label,fn]of actions){if(!label.toLowerCase().includes(q))continue;const b=make('button','',label);b.addEventListener('click',()=>{dialog.close();try{fn()}catch(e){ctx.toast(errorText(e),true)}});host.append(b);}};
 render();dialog.showModal();input.focus();input.oninput=render;}
 async function refreshOfflineCache(){
  const span=ctx.metrics.begin('offline-refresh');
  const controller=navigator.serviceWorker?.controller;
  if(!controller){ctx.metrics.finish(span,'cancelled','offline-unavailable');return ctx.toast('Open the site over HTTPS and reload to initialize service worker.',true);}
  const button=$('cache-refresh');button.disabled=true;button.textContent='Refreshing…';
  try{
   if(typeof MessageChannel!=='function')throw Error('MessageChannel unavailable in this browser');
   await new Promise((resolve,reject)=>{
    const channel=new MessageChannel();
    const timer=setTimeout(()=>{channel.port1.close();reject(Error('No service worker confirmation within 20 seconds'));},20000);
    channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();if(event.data?.ok)resolve();else reject(Error(event.data?.error||'Offline refresh failed'));};
    try{controller.postMessage({type:'REFRESH'},[channel.port2]);}catch(error){clearTimeout(timer);channel.port1.close();reject(error);}
   });
   ctx.metrics.finish(span,'ok');
   ctx.toast('Offline application cache refreshed successfully.');
  }catch(error){ctx.metrics.finish(span,'error','offline-unavailable');ctx.toast('Offline cache refresh failed: '+errorText(error),true);}
  finally{button.disabled=false;button.textContent='Refresh offline cache';}
 }
 // Wire-handler helpers added at wiring time (2026-11-05): these bodies
 // lived inline in main.js wire() and touch module closure state
 // (workflowController, activeNote, editingNoteId, currentKnowledgePage),
 // so they moved here verbatim rather than staying split across files.
 function clearActiveNote(){activeNote=null;}
 function stopWorkflow(){workflowController?.abort();ctx.toast('Workflow cancellation requested.');}
 function resetKnowledgeSearch(){currentKnowledgePage=0;renderKnowledge();}
 function changeKnowledgePage(delta){currentKnowledgePage=Math.max(0,currentKnowledgePage+delta);renderKnowledge();}
 function deleteActiveNote(){
  if(!activeNote||activeNote.type!=='note')return ctx.toast('Select a saved note to delete.',true);
  if(!confirm(`Delete note ${activeNote.title}?`))return;
  state().notes=state().notes.filter(n=>n.id!==activeNote.id);
  if(editingNoteId===activeNote.id)cancelNoteEdit();
  activeNote=null;$('knowledge-preview').textContent='Choose a search result.';
  renderKnowledge();ctx.saveSoon();
 }
 function sendActiveNoteToChat(){
  activeNote=resolveActiveKnowledge();
  if(!activeNote)return ctx.toast('Select a current note or project file first.',true);
  $('chat-input').value=`Use the following local reference (${activeNote.title}):\n${activeNote.content.slice(0,9000)}`;
  $('chat-counter').textContent=$('chat-input').value.length+' / 10,000';
  ctx.selectView('chat');
 }
 function exportKnowledge(){ctx.download('mm-knowledge.json',exportNoteArchive(state().notes));}
 return {renderAudit,flowStages,renderFlowGraph,workflowText,renderWorkflows,workflowResumable,runWorkflowCheckpoint,executeWorkflow,resumeWorkflow,knowledgeItems,resolveActiveKnowledge,previewLocalEvidence,insertLocalEvidence,renderKnowledge,cancelNoteEdit,beginNoteEdit,showDuplicateNotes,submitKnowledge,importKnowledge,refreshLocalCapabilities,runOndeviceReadiness,renderWorkshopMetrics,renderCapabilities,renderSettings,exportAll,importAll,renderAll,buildActivityBar,syncActivityBar,commandDialog,refreshOfflineCache,stopWorkflow,resetKnowledgeSearch,changeKnowledgePage,deleteActiveNote,sendActiveNoteToChat,exportKnowledge,clearActiveNote};
}
