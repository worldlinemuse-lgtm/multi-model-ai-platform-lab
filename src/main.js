import {VERSION,MAX_NOTES,MAX_AUDIT,PROVIDERS,VIEWS,CAPABILITIES,FLOW_TEMPLATES,uid,now,providerById,freshState,validateState,migrateLegacy,csvSummary,routeDescription} from './core.js';
import {read,write,remove,storageMode,isDurableStorage} from './storage.js';
import {CROSS_TAB_CHANNEL} from './cross-tab.js';
import {migrateToEntities} from './entity-store.js';
import {createWorkspaceStore} from './workspace-store.js';
import {createProjects} from './projects.js';
import {KeyVault} from './vault.js';
import {callProvider} from './provider-api.js';
import {createWorkshopMetrics} from './request-trace.js';
import {renderTelemetry,wireHud,hudUpdate,hudHide} from './telemetry-view.js';
import {initOtelBridge,attachOtel,otelDiagnosticsText} from './otel-workshop.js';
import {RuntimeRunner} from './sandbox.js';
import {createExecution} from './execution.js';
import {createProviders} from './providers.js';
import {createChat} from './chat.js';
import {setupLabs} from './labs.js';
import {compileWorkflowPlan,validateSavedWorkflowPlan} from './workflow-plan.js';
import {executeSavedPlan} from './workflow-supervisor.js';
import {setupWasmImport} from './wasm-ui.js';
import {setupExpressionRepl} from './expression-repl-ui.js';
import {parseNoteArchive,exportNoteArchive} from './knowledge.js';
import {knowledgePage} from './knowledge-pages.js';
import {retrieveLocalEvidence,formatLocalEvidence} from './local-evidence.js';
import {readKnowledgeDocument} from './knowledge-documents.js';
import {readBrowserCapabilities} from './capability-probes.js';
import {probeWebGPUReadiness} from './ondevice-readiness.js';
import {editLocalNote,findExactNoteDuplicates} from './note-tools.js';
import {el,qs,qsa,$,make,clearNode,formatTime,errorText} from './dom-helpers.js';
const vault=new KeyVault(()=>{try{crossTabChannel?.postMessage({type:'vault-saved'});}catch{}});
// Real OpenTelemetry SDK (local-only). initOtelBridge() never blocks boot and
// never throws: the bridge attaches asynchronously when the bundles load.
// Until then (and if they are missing or broken) the workshop runs exactly
// as before; otelStatus() reports loading|ready|disabled|unavailable|failed.
const workshopMetrics=attachOtel(createWorkshopMetrics(),null);
initOtelBridge().then(result=>workshopMetrics.setBridge(result));
const bootTrace=workshopMetrics.begin('boot');
let state,run,labs,capabilityProbeEpoch=0,activeView='overview',activeNote=null,editingNoteId=null,toastTimer=null,workflowController=null,crossTabChannel=null;
const bootMissingControls=new Set();
function optionalControl(id){const node=$(id);if(!node)bootMissingControls.add(id);return node;}
document.documentElement.dataset.mmBoot='starting';
let localEvidenceDraft='';let currentKnowledgePage=0;
function toast(message,error=false){const t=$('toast');t.textContent=String(message).slice(0,400);t.classList.toggle('error',error);t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,5200);}
function savedStatus(){return isDurableStorage()?'Saved on this device':'Temporary memory only — export a backup';}
// Stage 4b group 2: persistence lives in workspace-store.js. main.js keeps
// one-line shims so the ~50 call sites below do not churn in this move;
// later groups call store.* directly.
const store=createWorkspaceStore({
 read,write,
 getState:()=>state,setState:(s)=>{state=s;},
 toast,errorText,exportAll,renderAll,renderAudit,renderStats,savedStatus,
 metrics:workshopMetrics,
 broadcast(){try{crossTabChannel?.postMessage({type:'workspace-saved',revision:store.lastSeenRevision});}catch{}},
 clearActiveNote(){activeNote=null;}
});
function saveSoon(){store.saveSoon();}
function saveNow(){return store.saveNow();}
function audit(...args){return store.audit(...args);}
function replaceWorkspace(next){return store.replaceWorkspace(next);}
function openCrossTabChannel(){if(!('BroadcastChannel' in window))return;try{crossTabChannel=new BroadcastChannel(CROSS_TAB_CHANNEL);crossTabChannel.onmessage=(e)=>{const m=e?.data;if(!m)return;if(m.type==='vault-saved'){if(vault.isUnlocked){vault.noteExternalChange();toast('Vault saved in another tab — lock and unlock this tab before changing keys.',true);}return;}if(m.type!=='workspace-saved'||!Number.isSafeInteger(m.revision))return;if(store.lastSeenRevision!==null&&m.revision>store.lastSeenRevision){const ind=$('save-indicator');if(ind)ind.textContent='Another tab saved a newer workspace — reload before editing';toast('Workspace saved in another tab — reload this tab before editing, or your next save will not overwrite it.',true);}};}catch{}}
// Stage 4b group 3: projects/files/snapshots live in projects.js. main.js
// keeps one-line shims for project() and renderFiles() because they are
// called from everywhere; the wire() handlers call projects.* directly.
const projects=createProjects({
 getState:()=>state,setState:(s)=>{state=s;},
 saveSoon,saveNow,toast,
 metrics:workshopMetrics,
 renderStats
});
function project(){return projects.project();}
function renderFiles(){projects.renderFiles();}
function editFile(){projects.editFile();}
async function importBinaryAssets(input){return projects.importBinaryAssets(input);}
async function removeBinaryAsset(){return projects.removeBinaryAsset();}
// Stage 4b group 4: code execution lives in execution.js. The runner is
// constructed in boot() and attached via exec.attachRunner.
const exec=createExecution({
 project,audit,toast,
 metrics:workshopMetrics
});
// Stage 4b group 5: providers/vault UI lives in providers.js. The vault
// instance stays owned by main.js and arrives via ctx.vault, so the Stage
// 2b fingerprint guard and cross-tab wiring are untouched by this move.
const providers=createProviders({
 getState:()=>state,
 saveNow,toast,
 metrics:workshopMetrics,
 vault,selectView,renderAll,renderStats,download,optionalControl
});
// Stage 4b group 6: chat lives in chat.js. The provider call arrives via
// ctx.callProvider (the real one from provider-api.js) so node tests can
// substitute a fake; isDurableStorage also arrives via ctx.
const chat=createChat({
 getState:()=>state,
 thread,project,
 saveSoon,saveNow,audit,toast,
 metrics:workshopMetrics,
 vault,selectView,
 routeChoices:()=>providers.routeChoices(),
 download,callProvider,isDurableStorage
});
function thread(){return state.threads.find(t=>t.id===state.activeThreadId)||state.threads[0];}
function setDrawer(open){$('sidebar').classList.toggle('open',open);$('nav-backdrop').hidden=!open;$('mobile-menu').setAttribute('aria-expanded',String(open));document.body.style.overflow=open?'hidden':'';}
function selectView(view){if(!VIEWS[view])return;if(view==='chat'&&window.setChatDocked)window.setChatDocked(false);activeView=view;for(const node of qsa('.screen'))node.hidden=node.dataset.screen!==view;for(const b of qsa('[data-view]')){const current=b.dataset.view===view;b.classList.toggle('selected',current);b.setAttribute('aria-current',current?'page':'false')}const label=$('current-view-label');label.textContent=VIEWS[view];
const navBtn=document.querySelector('.nav-item[data-view="'+view+'"]');
const navEl=navBtn?navBtn.closest('nav'):null;
let grp='WORKSPACE';
if(navEl){let sib=navEl.previousElementSibling;while(sib){if(sib.classList&&sib.classList.contains('side-group-label')){grp=sib.textContent.trim();break;}sib=sib.previousElementSibling;}}
const grpEl=$('current-group-label');if(grpEl)grpEl.textContent=grp;syncActivityBar();setDrawer(false);if(view==='overview')renderStats();if(view==='providers')providers.renderProviders();if(view==='vault')providers.renderVault();if(view==='chat')renderChat();if(view==='usage')renderAudit();if(view==='workflows')renderWorkflows();if(view==='knowledge')renderKnowledge();if(view==='settings')renderSettings();if(view==='capabilities')renderCapabilities();if(view==='telemetry')renderTelemetry(state.audit,workshopMetrics);history.replaceState(null,'',`#${view}`);}
function renderHealth(){const checks=[['Browser storage',!store.isStorageFailed&&isDurableStorage()?'PERSISTENT':'TEMPORARY'],['JavaScript Workers',typeof Worker==='function'?'AVAILABLE':'UNAVAILABLE'],['Key vault',vault.isUnlocked?'UNLOCKED':'LOCKED'],['Provider calls','UNVERIFIED'],['Python execution',exec.getPythonStatus()],['Offline shell',navigator.serviceWorker?.controller?'CONTROLLING':'INACTIVE']];const host=clearNode($('health-list'));for(const [name,status] of checks){const row=make('div','health-line');row.append(make('span','health-icon pending','○'),make('span','',name),make('strong','',status));host.append(row);}}
function renderStats(){const p=project();$('stat-project').textContent=p?.name||'Workspace';$('stat-files').textContent=Object.keys(p?.files||{}).length;$('stat-routes').textContent=routeDescription(vault.count);$('stat-requests').textContent=String(state.audit.filter(x=>x.op==='inference'&&x.status!=='requested').length);$('sidebar-runtime').textContent=`${state.projects.length} project(s) · ${vault.count} saved key slot(s)`;$('connection-badge').textContent=vault.isUnlocked&&vault.count?'● KEY VAULT UNLOCKED':'● LOCAL MODE';renderHealth();}
function projectZip(){return projects.projectZip();}
function q04PreviewEdit(){projects.q04PreviewEdit();}
function q04AcceptEdit(){projects.q04AcceptEdit();}
function q04RollbackEdit(){projects.q04RollbackEdit();}
function createProject(){projects.createProject();}
function renameProject(){projects.renameProject();}
function deleteProject(){projects.deleteProject();}
function newFile(){projects.newFile();}
function renameFile(){projects.renameFile();}
function copyFolder(){projects.copyFolder();}
function moveFolder(){projects.moveFolder();}
function deleteFile(){projects.deleteFile();}
function snapshot(){projects.snapshot();}
function selectedSnapshot(){return projects.selectedSnapshot();}
function renderSnapshotActions(){projects.renderSnapshotActions();}
function manageSnapshot(){projects.manageSnapshot();}
function restoreSnapshot(){projects.restoreSnapshot();}
function download(name,data,type='application/json'){const blob=data instanceof Blob?data:new Blob([data],{type});const url=URL.createObjectURL(blob);const a=make('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
/* 'ok' means the export payload was generated and handed to the browser
 * download; the browser owns the actual file write from there. */
function tracedExport(fn){const span=workshopMetrics.begin('project-export');try{fn();workshopMetrics.finish(span,'ok');}catch(e){workshopMetrics.finish(span,'error','invalid-input');throw e;}}
function projectJSON(){return projects.projectJSON();}
async function importProject(file){return projects.importProject(file);}
async function importTextFiles(input){return projects.importTextFiles(input);}
function renderChat(){chat.renderChat();}
function newThread(){chat.newThread();}
function clearThread(){chat.clearThread();}
function exportThread(){chat.exportThread();}
function deleteThread(){chat.deleteThread();}
async function sendMessage(event){return chat.sendMessage(event);}
function stopChat(){chat.stopChat();}
function addCodeToChat(){chat.addCodeToChat();}
function q22DraftManualRetry(){chat.q22DraftManualRetry();}
function renderThreadList(){chat.renderThreadList();}

function renderAudit(){const events=state.audit;const reqs=events.filter(x=>x.op==='inference'&&x.status!=='requested');$('usage-total').textContent=reqs.length;$('usage-success').textContent=reqs.filter(x=>x.status==='success').length;const observed=reqs.filter(x=>Number.isSafeInteger(x.usage?.total_tokens));const unreported=reqs.length-observed.length;$('usage-tokens').textContent=`${observed.reduce((s,x)=>s+x.usage.total_tokens,0)} tokens across ${observed.length} calls with reported usage; ${unreported} calls reported no usage`;const shown=events.slice(0,100);const windowEl=$('audit-window');if(windowEl)windowEl.textContent=`Showing latest ${shown.length} of ${events.length} recorded events (audit log capped at ${MAX_AUDIT}).`;const body=clearNode($('audit-rows'));for(const a of shown){const tr=make('tr');for(const value of [formatTime(a.at),`${a.provider||'local'} / ${a.op}`,a.status,a.requestId?.slice(0,8)||'—',a.model||'—',a.latencyMs==null?'unknown':a.latencyMs+' ms',a.usage?`${a.usage.total_tokens===null?'unknown':a.usage.total_tokens} tokens · ${a.usage.source}`:'unknown'])tr.append(make('td',value==='failed'?'bad':'',value));body.append(tr);}if(!events.length){const tr=make('tr'),td=make('td','','No activity recorded.');td.colSpan=7;tr.append(td);body.append(tr);}}
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
   const plan=compileWorkflowPlan($('workflow-stages').value||FLOW_TEMPLATES[$('workflow-template').value].join('\n'),$('workflow-route').value,vault.list().map(x=>x.id));
   $('workflow-estimate').textContent='Validated '+plan.length+' stages, at most '+plan.length+' authorized model calls: '+plan.map(x=>x.route).join(' → ')+'. Conditions may skip a call.';
  }catch(e){$('workflow-estimate').textContent='Plan check: '+errorText(e);}
 }
}
function workflowText(w){return w.steps.map(s=>s.stage+(s.model?' ('+s.model+')':'')+(s.provider?' ['+s.provider+']':'')+'\n'+s.content).join('\n\n---\n\n');}
function renderWorkflows(){
 providers.routeChoices();renderFlowGraph();
 const host=clearNode($('workflow-history'));
 for(const w of state.workflows.slice(0,30)){
  const b=make('button','history-entry');b.type='button';
  b.append(make('strong','',w.template+' · '+w.status),make('small','',formatTime(w.at)+' · '+w.goal.slice(0,65)));
  b.addEventListener('click',()=>{$('workflow-results').textContent=workflowText(w)||'No finished stage output yet.';});host.append(b);
 }
 if(!state.workflows.length)host.textContent='No runs recorded.';
 $('workflow-resume').disabled=!!workflowController||!state.workflows.some(workflowResumable);
}
function workflowResumable(w){if(!Array.isArray(w.plan))return false;if(['running','stopped'].includes(w.status))return w.steps.length<w.plan.length;if(w.status==='failed')return w.steps.at(-1)?.status==='failed';return false;}
async function runWorkflowCheckpoint(result){
 if(workflowController)return toast('Stop the active workflow first.',true);
 if(!validateSavedWorkflowPlan(result.plan))return toast('Stored plan validation failed.',true);
 const controller=new AbortController();workflowController=controller;
 $('workflow-start').disabled=true;$('workflow-stop').disabled=false;$('workflow-resume').disabled=true;
 const progress=()=>result.plan.map((_,i)=>result.steps[i]?(result.steps[i].status==='skipped'?'skipped':result.steps[i].status==='failed'?'error':'done'):'pending');
 try{
  await executeSavedPlan(result,{
   signal:controller.signal,
   persist:async()=>await saveNow(),
   onStage:(run,i,status)=>{
    const states=progress();states[i]=status;renderFlowGraph(states,run.plan);
    $('workflow-results').textContent=workflowText(run)||'Running authorized stages…';
   },
   callStage:async(stage,prompt,signal)=>{
    const cred=vault.get(stage.route);
    if(!cred)throw Error('Route '+stage.route+' requires an unlocked key.');
    audit('inference',stage.route,'requested');
    try{
     const answer=await callProvider(stage.route,cred,[{role:'user',content:prompt}],{signal,maxOutputTokens:state.preferences.maxOutputTokens??512});
     audit('inference',stage.route,'success',answer.usage);return answer;
    }catch(e){audit('inference',stage.route,signal.aborted?'stopped':'failed');throw e;}
   }
  });
 }catch(error){result.status='stopped';toast('Workflow paused safely: '+errorText(error),true);}
 finally{
  workflowController=null;$('workflow-start').disabled=false;$('workflow-stop').disabled=true;
  $('workflow-results').textContent=workflowText(result)||'Workflow '+result.status+'.';renderWorkflows();
 }
}
async function executeWorkflow(event){
 event.preventDefault();
 if(workflowController)return toast('Stop the current workflow first.',true);
 if(!$('workflow-confirm').checked)return toast('Confirm explicit model requests first.',true);
 const goal=$('workflow-goal').value.trim(),template=$('workflow-template').value,provider=$('workflow-route').value;
 if(!goal)return toast('Enter a task goal.',true);
 let plan;
 try{plan=compileWorkflowPlan($('workflow-stages').value||FLOW_TEMPLATES[template].join('\n'),provider,vault.list().map(x=>x.id));}
 catch(e){return toast(errorText(e),true);}
 const result={id:uid('workflow'),at:now(),provider,template,goal,status:'running',steps:[],plan,inFlightStage:null};
 state.workflows.unshift(result);state.workflows=state.workflows.slice(0,40);
 try{await saveNow();}catch(e){state.workflows=state.workflows.filter(x=>x!==result);return toast('No request sent: '+errorText(e),true);}
 await runWorkflowCheckpoint(result);
}
async function resumeWorkflow(){
 if(workflowController)return;
 const result=state.workflows.find(workflowResumable);
 if(!result)return toast('No paused workflow to resume.',true);
 if(!validateSavedWorkflowPlan(result.plan))return toast('Saved plan integrity check failed.',true);
 const retryIndex=(result.status==='failed'&&result.steps.at(-1)?.status==='failed')?result.steps.length-1:result.steps.length;
 if(result.plan.slice(retryIndex).some(s=>!vault.get(s.route)))return toast('Unlock the required saved model routes before resuming.',true);
 if(!confirm('Resume '+(result.plan.length-retryIndex)+' remaining stage(s)? An interrupted request may already have consumed quota and may be reissued. Resume is manual only; no paid fallback.'))return;
 await runWorkflowCheckpoint(result);
}

function knowledgeItems(query){const results=[];for(const note of state.notes){if((note.title+' '+note.content).toLowerCase().includes(query)){results.push({type:'note',id:note.id,title:note.title,content:note.content});}}for(const p of state.projects){for(const [name,source]of Object.entries(p.files)){if((p.name+' '+name+' '+source).toLowerCase().includes(query))results.push({type:'file',id:name,projectId:p.id,title:p.name+' / '+name,content:source});}}return results;}
function resolveActiveKnowledge(){
 if(!activeNote)return null;
 if(activeNote.type==='note'){const note=state.notes.find(n=>n.id===activeNote.id);return note?{type:'note',id:note.id,title:note.title,content:note.content}:null;}
 if(activeNote.type==='file'){const p=state.projects.find(item=>item.id===activeNote.projectId);if(!p||!Object.hasOwn(p.files,activeNote.id))return null;return {type:'file',id:activeNote.id,projectId:p.id,title:p.name+' / '+activeNote.id,content:p.files[activeNote.id]};}
 return null;
}
function previewLocalEvidence(){
 const query=$('knowledge-search').value.trim();
 if(!query){$('knowledge-evidence-output').textContent='Enter a phrase in Search local knowledge first.';return;}
 const docs=[
  ...state.notes.map(n=>({kind:'note',id:n.id,title:n.title,content:n.content})),
  ...state.projects.flatMap(p=>Object.entries(p.files).map(([name,content])=>({kind:'file',id:p.id+'/'+name,title:p.name+' / '+name,content})))
 ];
 try{
  const matches=retrieveLocalEvidence(docs,query);
  localEvidenceDraft=matches.length?formatLocalEvidence(matches):'';
  $('knowledge-evidence-output').textContent=matches.length?localEvidenceDraft:'No matching source passage. No local citations generated.';
  $('knowledge-insert-evidence').disabled=!matches.length;
 }catch(e){localEvidenceDraft='';$('knowledge-insert-evidence').disabled=true;$('knowledge-evidence-output').textContent='Local retrieval rejected: '+errorText(e);}
}
function insertLocalEvidence(){
 if(!localEvidenceDraft)return toast('Preview local excerpts first.',true);
 const prior=$('chat-input').value.trim();
 const combined=(prior?prior+'\n\n':'')+localEvidenceDraft;
 if(combined.length>10000)return toast('Local excerpt exceeds available chat input; shorten the question or existing message.',true);
 $('chat-input').value=combined;$('chat-counter').textContent=combined.length+' / 10,000';
 selectView('chat');toast('Local sources inserted as editable text. No provider request was made.');
}
function renderKnowledge(){localEvidenceDraft='';$('knowledge-evidence-output').textContent='Enter a search phrase and click Find local passages.';$('knowledge-insert-evidence').disabled=true;const live=resolveActiveKnowledge();$('knowledge-edit').disabled=!live||live.type!=='note';if(activeNote){activeNote=live;$('knowledge-preview').textContent=live?live.content.slice(0,15000):'Choose a search result.';}const query=$('knowledge-search').value.trim().toLowerCase(),matches=knowledgeItems(query),paged=knowledgePage(matches,currentKnowledgePage);currentKnowledgePage=paged.page;$('knowledge-page-info').textContent='Page '+(paged.page+1)+' of '+paged.pages+' · '+paged.from+'–'+paged.to+' of '+paged.total+' local matches';$('knowledge-page-prev').disabled=paged.page===0;$('knowledge-page-next').disabled=paged.page>=paged.pages-1;$('note-count').textContent=state.notes.length+' notes';const host=clearNode($('knowledge-results'));paged.items.forEach(result=>{const button=make('button','knowledge-result'+(activeNote?.id===result.id&&activeNote?.type===result.type?' active':''));button.append(make('b','',result.title),make('small','',result.content.slice(0,180)));button.addEventListener('click',()=>{activeNote=result;$('knowledge-preview').textContent=result.content.slice(0,15000);renderKnowledge();});host.append(button)});if(!matches.length)host.append(make('p','hint-line','No local matches.'));const dupReport=optionalControl('knowledge-duplicate-report');if(dupReport&&!dupReport.hidden)showDuplicateNotes();}
function cancelNoteEdit(){editingNoteId=null;$('knowledge-title').value='';$('knowledge-content').value='';$('knowledge-submit').textContent='Save locally';$('knowledge-cancel-edit').hidden=true;}
function beginNoteEdit(){const live=resolveActiveKnowledge();if(!live||live.type!=='note')return toast('Select a saved note to edit; project files are edited in Code Studio.',true);if(editingNoteId&&editingNoteId!==live.id&&!confirm('Discard unsaved note edits and switch to the selected note?'))return;editingNoteId=live.id;$('knowledge-title').value=live.title;$('knowledge-content').value=live.content;$('knowledge-submit').textContent='Save changes';$('knowledge-cancel-edit').hidden=false;$('knowledge-title').focus();}
function showDuplicateNotes(){const groups=findExactNoteDuplicates(state.notes);const box=$('knowledge-duplicate-report');box.hidden=false;box.textContent=groups.length?'Exact-content duplicate groups (nothing deleted):\n'+groups.map((g,i)=>(i+1)+'. '+g.count+' notes: '+g.notes.map(n=>n.title+' ['+n.id.slice(-8)+']').join(' | ')).join('\n'):'No exact-content duplicates found. Nothing was deleted.';}
function submitKnowledge(e){e.preventDefault();const title=$('knowledge-title').value.trim(),content=$('knowledge-content').value;if(!title||!content.trim())return toast('Both title and note content are required.',true);if(editingNoteId){const existing=state.notes.find(n=>n.id===editingNoteId);if(!existing){cancelNoteEdit();return toast('The edited note no longer exists.',true);}if(existing.title===title&&existing.content===content)return toast('No note changes to save.');if(!confirm('Replace the saved content of note "'+existing.title+'"? This changes the local record. Export a backup first if necessary.'))return;try{state.notes=editLocalNote(state.notes,editingNoteId,title,content,now());activeNote={type:'note',id:editingNoteId,title,content};cancelNoteEdit();renderKnowledge();saveSoon();toast('Note changes saved locally.');}catch(error){toast('Note edit rejected: '+error.message,true);}return;}if(state.notes.length>=MAX_NOTES)return toast('Note limit reached; export notes first.',true);state.notes.unshift({id:uid('note'),title,content,created:now()});cancelNoteEdit();renderKnowledge();saveSoon();toast('Knowledge note saved.');}
async function importKnowledge(input){
 const files=Array.from(input.files||[]);input.value='';
 if(files.length>15)return toast('Import at most 15 documents per batch.',true);
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
  if(state.notes.length+pending.length>MAX_NOTES)throw Error('Note capacity exceeded (maximum '+MAX_NOTES+')');
  if(!pending.length)return toast('No documents selected.',true);
  state.notes.push(...pending);saveSoon();renderKnowledge();toast(pending.length+' note(s) imported.');
 }catch(e){toast('Import failed: '+errorText(e),true);}
}
async function refreshLocalCapabilities(){const epoch=++capabilityProbeEpoch,host=$('capability-live-list'),button=$('capability-refresh');button.disabled=true;host.textContent='Checking local browser capability signals…';try{const readings=await readBrowserCapabilities(window);if(epoch!==capabilityProbeEpoch)return;host.replaceChildren();for(const reading of readings){const row=make('article','capability-row'),description=make('div');description.append(make('b','',reading.label),make('small','',reading.detail));row.append(description,make('span','tag muted',reading.status));host.append(row);} }catch(error){if(epoch===capabilityProbeEpoch)host.textContent='Browser capability diagnostics could not complete: '+errorText(error);}finally{if(epoch===capabilityProbeEpoch)button.disabled=false;}}
let q27ProbeActive=false;
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
async function renderWorkshopMetrics(){const snap=workshopMetrics.summary(),host=$('workshop-metrics-summary'),recent=$('workshop-metrics-events');$('workshop-metrics-enabled').checked=snap.enabled;const rows=snap.byOperation.filter(item=>item.total);host.textContent=rows.length?rows.map(item=>item.op+': '+item.total+' observed / '+item.errors+' error / '+item.timeouts+' timeout / '+item.cancelled+' stopped · p95 '+(item.p95Ms===null?'n/a':item.p95Ms+' ms')).join('\n'):'No workshop operations observed in this browser session.';recent.textContent=snap.recent.map(item=>item.op+' · '+item.outcome+' · '+item.reason+' · '+(item.durationMs===null?'n/a':item.durationMs+'ms')).join('\n')||'No events recorded.';const otelHost=$('otel-diagnostics');if(otelHost)otelHost.textContent=await otelDiagnosticsText(workshopMetrics);}
function renderCapabilities(){const host=clearNode($('capability-list'));for(const [code,title,status,description]of CAPABILITIES){const row=make('article','capability-row');row.append(make('span','',status==='local'?'✓':status==='conditional'?'◇':'○'));const details=make('div');details.append(make('b','',`${code} · ${title}`),make('small','',description));row.append(details,make('span','tag '+(status==='local'?'good':status==='conditional'?'pending':'muted'),({local:'LOCAL',conditional:'EXTERNAL',partial:'PARTIAL',planned:'PLANNED'})[status]));host.append(row);}refreshLocalCapabilities();renderWorkshopMetrics();}
function renderSettings(){const recovery=optionalControl('recovery-tools');if(recovery)recovery.hidden=store.recoveryRaw===null;if(store.recoveryRaw!==null)$('recovery-description').textContent='Unparseable '+(store.recoveryKind==='legacy'?'legacy B0.1/B0.2 project':'B0.3 browser state')+' detected. Original data has not been overwritten. Download a raw backup before resetting.';$('accent-select').value=state.preferences.accent;$('compact-toggle').checked=!!state.preferences.compact;$('platform-details').replaceChildren();for(const [k,v]of [['Build',VERSION],['Storage',storageMode()],['Security','Encrypted secrets; no keys in backups'],['Network','Provider requests only on explicit actions'],['GitHub','Public static source'],['Python','Optional Pyodide CDN runtime']]){const row=make('div');row.append(make('span','',k),make('strong','',v));$('platform-details').append(row);}}
function exportAll(){tracedExport(()=>download('multimodel-studio-backup.json',JSON.stringify(state,null,2)));}
async function importAll(file){if(!file||file.size>12_000_000)return toast('Backup file exceeds limit.',true);const span=workshopMetrics.begin('project-import');try{const value=JSON.parse(await file.text());if(!validateState(value))throw Error('Invalid or unsupported backup');if(!confirm('Replace ALL local projects, chat, notes, and audit with this backup? Encrypted key vault remains untouched.')){workshopMetrics.finish(span,'cancelled','user-stop');return;}await replaceWorkspace(value);workshopMetrics.finish(span,'ok');toast('Workspace restored and saved.');}catch(e){workshopMetrics.finish(span,'error','invalid-input');toast('Restore failed: '+errorText(e),true);}}
function renderAll(){labs?.refreshSavedDatasets();renderFiles();providers.routeChoices();providers.renderProviders();providers.renderVault();renderChat();renderAudit();renderWorkflows();renderKnowledge();renderStats();renderSettings();renderCapabilities();}
const ACTIVITY_GROUPS=[['overview','workspace','chat','workflows','knowledge','datalab','media'],['providers','vault','usage','telemetry','capabilities','settings']];
function buildActivityBar(){const bar=$('activity-bar');if(!bar||bar.dataset.built)return;bar.dataset.built='1';
ACTIVITY_GROUPS.forEach((group,gi)=>{if(gi>0){const sep=document.createElement('div');sep.className='activity-sep';bar.append(sep);}
for(const id of group){const navBtn=document.querySelector('.nav-item[data-view="'+id+'"]');const icon=navBtn?.querySelector('.nav-icon')?.textContent||'◈';const label=VIEWS[id]||id;
const b=document.createElement('button');b.type='button';b.className='activity-btn';b.dataset.view=id;b.title=label;b.setAttribute('aria-label',label);b.textContent=icon;
b.addEventListener('click',()=>selectView(id));bar.append(b);}});
syncActivityBar();}
function syncActivityBar(){for(const b of document.querySelectorAll('.activity-btn'))b.classList.toggle('selected',b.dataset.view===activeView);}
function commandDialog(){const dialog=$('command-dialog'),input=$('command-search');input.value='';
const actions=[
 ['Go to: Code studio',()=>selectView('workspace')],
 ['Go to: Model chat',()=>selectView('chat')],
 ['Go to: Key vault',()=>selectView('vault')],
 ['Go to: Telemetry',()=>selectView('telemetry')],
 ['Go to: Settings',()=>selectView('settings')],
 ['Run code (Code studio)',()=>{selectView('workspace');exec.runCode();}],
 ['Stop running code',()=>{try{run.stop('Execution stopped by user.')}catch{};}],
 ['New chat',()=>{selectView('chat');newThread();}],
 ['New code file',()=>{selectView('workspace');newFile();}],
 ['New project',()=>createProject()],
 ['Save now',()=>saveNow().then(()=>toast(savedStatus())).catch(()=>{})],
 ['Export workspace backup',()=>exportAll()],
 ['Toggle performance HUD',()=>{const t=$('hud-toggle');if(t){t.checked=!t.checked;t.dispatchEvent(new Event('change'));}else{selectView('telemetry');}}],
 ['Refresh telemetry',()=>renderTelemetry(state.audit,workshopMetrics)],
 ['Lock key vault',()=>{vault.lock();renderAll();toast('Key vault locked.');}],
];
const render=()=>{const host=clearNode($('command-results'));const q=input.value.toLowerCase();
for(const [id,label]of Object.entries(VIEWS)){if(!label.toLowerCase().includes(q))continue;const b=make('button','','Go to: '+label);b.addEventListener('click',()=>{dialog.close();selectView(id);});host.append(b);}
for(const [label,fn]of actions){if(!label.toLowerCase().includes(q))continue;const b=make('button','',label);b.addEventListener('click',()=>{dialog.close();try{fn()}catch(e){toast(errorText(e),true)}});host.append(b);}};
render();dialog.showModal();input.focus();input.oninput=render;}
async function refreshOfflineCache(){
 const span=workshopMetrics.begin('offline-refresh');
 const controller=navigator.serviceWorker?.controller;
 if(!controller){workshopMetrics.finish(span,'cancelled','offline-unavailable');return toast('Open the site over HTTPS and reload to initialize service worker.',true);}
 const button=$('cache-refresh');button.disabled=true;button.textContent='Refreshing…';
 try{
  if(typeof MessageChannel!=='function')throw Error('MessageChannel unavailable in this browser');
  await new Promise((resolve,reject)=>{
   const channel=new MessageChannel();
   const timer=setTimeout(()=>{channel.port1.close();reject(Error('No service worker confirmation within 20 seconds'));},20000);
   channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();if(event.data?.ok)resolve();else reject(Error(event.data?.error||'Offline refresh failed'));};
   try{controller.postMessage({type:'REFRESH'},[channel.port2]);}catch(error){clearTimeout(timer);channel.port1.close();reject(error);}
  });
  workshopMetrics.finish(span,'ok');
  toast('Offline application cache refreshed successfully.');
 }catch(error){workshopMetrics.finish(span,'error','offline-unavailable');toast('Offline cache refresh failed: '+errorText(error),true);}
 finally{button.disabled=false;button.textContent='Refresh offline cache';}
}
function wire(){$('workshop-metrics-refresh').addEventListener('click',renderWorkshopMetrics);$('workshop-metrics-download').addEventListener('click',()=>download('workshop-metrics.json',workshopMetrics.exportReport()));$('workshop-metrics-clear').addEventListener('click',()=>{workshopMetrics.reset();renderWorkshopMetrics();});$('workshop-metrics-enabled').addEventListener('change',e=>{workshopMetrics.setEnabled(e.target.checked);renderWorkshopMetrics();});wireHud(()=>({auditEvents:state.audit,workshopMetrics}));$('telemetry-refresh').addEventListener('click',()=>renderTelemetry(state.audit,workshopMetrics));$('telemetry-traces-refresh').addEventListener('click',()=>renderTelemetry(state.audit,workshopMetrics));$('telemetry-export').addEventListener('click',()=>download('telemetry.json',JSON.stringify({at:now(),otel:workshopMetrics.exportReport()},null,2)));window.addEventListener('error',()=>workshopMetrics.record('ui-error','error','uncaught-error'));window.addEventListener('unhandledrejection',()=>workshopMetrics.record('ui-error','error','unhandled-rejection'));$('q04-preview-button').addEventListener('click',q04PreviewEdit);$('q04-accept').addEventListener('click',q04AcceptEdit);$('q04-rollback').addEventListener('click',q04RollbackEdit);qsa('[data-view],[data-goto]').forEach(b=>b.addEventListener('click',()=>selectView(b.dataset.view||b.dataset.goto)));$('mobile-menu').addEventListener('click',()=>setDrawer(!$('sidebar').classList.contains('open')));
const syncOnline=()=>{const b=$('connection-badge');const online=navigator.onLine!==false;if(b){b.textContent=!online?'○ OFFLINE':(vault.isUnlocked&&vault.count?'● KEY VAULT UNLOCKED':'● LOCAL MODE');b.classList.toggle('offline',!online);}};
window.addEventListener('online',()=>{syncOnline();toast('Back online.');});
window.addEventListener('offline',()=>{syncOnline();toast('You appear to be offline. Code, notes, and saved work still function; AI requests and Python downloads need a connection.',true);});
syncOnline();for(const b of [$('nav-backdrop'),$('sidebar-close')])b.addEventListener('click',()=>setDrawer(false));document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('sidebar').classList.contains('open'))setDrawer(false);});$('global-command').addEventListener('click',commandDialog);buildActivityBar();
const chatGrid=document.querySelector('#view-chat .chat-grid');
const chatHome=chatGrid?chatGrid.parentNode:null;
const chatPlaceholder=document.createComment('chat-grid home');
if(chatHome)chatHome.insertBefore(chatPlaceholder,chatGrid);
let chatPanelEl=null;
window.setChatDocked=function(docked){
 const btn=$('toggle-chat-panel');
 if(!chatGrid||!chatHome)return;
 if(docked){
  if(!chatPanelEl){
   chatPanelEl=document.createElement('aside');
   chatPanelEl.id='chat-dock-panel';chatPanelEl.className='chat-dock-panel';
   chatPanelEl.setAttribute('aria-label','Docked AI chat');
   const hdr=document.createElement('div');hdr.className='chat-dock-header';
   hdr.append(make('span','','AI CHAT'));
   const close=make('button','small-icon','✕');close.type='button';close.setAttribute('aria-label','Close docked chat');
   close.addEventListener('click',()=>window.setChatDocked(false));
   hdr.append(close);chatPanelEl.append(hdr);
  }
  const grid=document.querySelector('.studio-grid');
  if(grid&&!chatPanelEl.isConnected){grid.append(chatPanelEl);grid.classList.add('with-chat-panel');}
  chatPanelEl.append(chatGrid);
 }else{
  if(chatPanelEl&&chatPanelEl.isConnected){chatPanelEl.remove();document.querySelector('.studio-grid')?.classList.remove('with-chat-panel');}
  if(chatPlaceholder.isConnected)chatPlaceholder.parentNode.insertBefore(chatGrid,chatPlaceholder);
  else chatHome.append(chatGrid);
 }
 if(btn)btn.setAttribute('aria-expanded',String(!!docked));
 try{localStorage.setItem('mm-chat-docked',docked?'1':'0');}catch{}
};
const dockBtn=$('toggle-chat-panel');
if(dockBtn)dockBtn.addEventListener('click',()=>{const isOpen=!!document.getElementById('chat-dock-panel')?.isConnected&&document.querySelector('.studio-grid.with-chat-panel');window.setChatDocked(!isOpen);});
try{if(localStorage.getItem('mm-chat-docked')==='1')window.setChatDocked(true);}catch{}$('command-close').addEventListener('click',()=>$('command-dialog').close());document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();commandDialog()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveNow().then(()=>toast(savedStatus())).catch(()=>{}) }if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&activeView==='workspace'){e.preventDefault();exec.runCode()}});
$('project-select').addEventListener('change',e=>{state.activeProjectId=e.target.value;exec.finishCodeMetric('cancelled','superseded');run.stop();renderFiles();saveSoon()});$('new-project').addEventListener('click',createProject);$('rename-project').addEventListener('click',renameProject);$('delete-project').addEventListener('click',deleteProject);$('snapshot-project').addEventListener('click',snapshot);$('snapshot-select').addEventListener('change',renderSnapshotActions);$('snapshot-action-run').addEventListener('click',manageSnapshot);$('restore-snapshot').addEventListener('click',restoreSnapshot);$('add-file').addEventListener('click',newFile);$('rename-file').addEventListener('click',renameFile);$('move-folder').addEventListener('click',moveFolder);$('copy-folder').addEventListener('click',copyFolder);$('delete-file').addEventListener('click',deleteFile);$('add-local-files').addEventListener('change',e=>importTextFiles(e.target));$('binary-asset-import').addEventListener('change',e=>importBinaryAssets(e.target));$('binary-asset-delete').addEventListener('click',removeBinaryAsset);$('code-editor').addEventListener('input',editFile);$('code-editor').addEventListener('scroll',e=>{$('line-gutter').scrollTop=e.target.scrollTop});$('code-editor').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const t=e.target,start=t.selectionStart,end=t.selectionEnd;t.setRangeText('  ',start,end,'end');editFile();}});$('run-code').addEventListener('click',()=>exec.runCode());$('stop-code').addEventListener('click',()=>exec.stopCode());$('preview-page').addEventListener('click',()=>exec.previewPage());$('clear-console').addEventListener('click',()=>exec.clearConsole());$('show-console').addEventListener('click',()=>exec.showExecTab('console'));$('show-preview').addEventListener('click',()=>exec.showExecTab('preview'));$('export-json').addEventListener('click',()=>tracedExport(()=>download(project().name.replace(/\W+/g,'_')+'.json',projectJSON())));$('export-zip').addEventListener('click',()=>tracedExport(()=>download(project().name.replace(/\W+/g,'_')+'.zip',projectZip(),'application/zip')));$('import-project').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';importProject(file)});
$('provider-search').addEventListener('input',e=>providers.renderProviders(e.target.value));$('provider-check-local').addEventListener('click',()=>providers.q22InspectRoutes());$('provider-check-groq').addEventListener('click',()=>providers.inspectGroqLiveMetadata());$('provider-preset-import').addEventListener('change',e=>providers.importProviderPresets(e));$('provider-preset-export').addEventListener('click',()=>providers.exportLocalPresets());$('provider-preset-select').addEventListener('change',()=>providers.renderProviderPresets());$('provider-preset-apply').addEventListener('click',()=>providers.applyProviderPreset());$('vault-form').addEventListener('submit',e=>providers.submitVault(e));$('vault-export-encrypted').addEventListener('click',()=>providers.exportEncryptedVaultUI());$('vault-import-encrypted').addEventListener('change',e=>providers.importEncryptedVaultUI(e));$('vault-rotate-form').addEventListener('submit',e=>providers.rotateVaultUI(e));$('vault-lock').addEventListener('click',()=>{vault.lock();renderAll();toast('Key vault locked.');});$('vault-wipe').addEventListener('click',async()=>{if(!confirm('Permanently erase ALL encrypted API keys from this device?'))return;if(!confirm('Confirm permanent vault deletion. This cannot be undone.'))return;try{await vault.erase();renderAll();toast('Encrypted vault erased.');}catch(e){toast(errorText(e),true);}});$('key-provider').addEventListener('change',e=>{$('key-model').value=vault.get(e.target.value)?.model||providerById(e.target.value)?.model||'';$('key-account').value=vault.get(e.target.value)?.account||'';});$('save-key').addEventListener('click',()=>{if(!vault.isUnlocked){toast('First create or unlock your vault with a passphrase. Your provider fields will remain filled.',true);$('vault-password').focus();$('vault-password').scrollIntoView({behavior:'smooth',block:'center'});}});$('key-form').addEventListener('submit',e=>providers.submitKey(e));
$('chat-route').addEventListener('change',()=>providers.renderCompareRoute());$('compare-mode').addEventListener('change',()=>providers.renderCompareRoute());$('chat-output-tokens').addEventListener('change',e=>{state.preferences.maxOutputTokens=Number(e.target.value);saveSoon();toast('Request output cap saved locally. Provider eligibility and free balance remain unverified.');});$('chat-form').addEventListener('submit',sendMessage);$('chat-retry-draft').addEventListener('click',q22DraftManualRetry);$('chat-input').addEventListener('input',e=>$('chat-counter').textContent=e.target.value.length+' / 10,000');$('stop-chat').addEventListener('click',stopChat);$('send-selected-code').addEventListener('click',addCodeToChat);$('new-chat').addEventListener('click',newThread);$('clear-chat').addEventListener('click',clearThread);$('thread-search').addEventListener('input',renderThreadList);$('export-chat-thread').addEventListener('click',exportThread);$('delete-chat-thread').addEventListener('click',deleteThread);$('export-audit').addEventListener('click',()=>download('mm-audit.json',JSON.stringify(state.audit,null,2)));$('clear-audit').addEventListener('click',()=>{if(!confirm('Clear local audit log?'))return;state.audit=[];saveSoon();renderAudit();});
$('workflow-template').addEventListener('change',()=>{$('workflow-stages').value=FLOW_TEMPLATES[$('workflow-template').value].join('\n');renderFlowGraph();});$('workflow-stages').addEventListener('input',()=>renderFlowGraph());$('workflow-form').addEventListener('submit',executeWorkflow);$('workflow-resume').addEventListener('click',resumeWorkflow);$('workflow-stop').addEventListener('click',()=>{workflowController?.abort();toast('Workflow cancellation requested.');});$('capability-refresh').addEventListener('click',refreshLocalCapabilities);$('ondevice-probe').addEventListener('click',runOndeviceReadiness);$('knowledge-form').addEventListener('submit',submitKnowledge);$('knowledge-edit').addEventListener('click',beginNoteEdit);$('knowledge-cancel-edit').addEventListener('click',()=>{cancelNoteEdit();toast('Note edit cancelled without changes.');});$('knowledge-find-duplicates').addEventListener('click',showDuplicateNotes);$('knowledge-search').addEventListener('input',()=>{currentKnowledgePage=0;renderKnowledge();});$('knowledge-page-prev').addEventListener('click',()=>{currentKnowledgePage=Math.max(0,currentKnowledgePage-1);renderKnowledge();});$('knowledge-page-next').addEventListener('click',()=>{currentKnowledgePage++;renderKnowledge();});$('knowledge-import').addEventListener('change',e=>importKnowledge(e.target));$('knowledge-evidence').addEventListener('click',previewLocalEvidence);$('knowledge-insert-evidence').addEventListener('click',insertLocalEvidence);$('knowledge-export').addEventListener('click',()=>download('mm-knowledge.json',exportNoteArchive(state.notes)));$('knowledge-delete').addEventListener('click',()=>{if(!activeNote||activeNote.type!=='note')return toast('Select a saved note to delete.',true);if(!confirm(`Delete note ${activeNote.title}?`))return;state.notes=state.notes.filter(n=>n.id!==activeNote.id);if(editingNoteId===activeNote.id)cancelNoteEdit();activeNote=null;$('knowledge-preview').textContent='Choose a search result.';renderKnowledge();saveSoon();});$('knowledge-to-chat').addEventListener('click',()=>{activeNote=resolveActiveKnowledge();if(!activeNote)return toast('Select a current note or project file first.',true);$('chat-input').value=`Use the following local reference (${activeNote.title}):\n${activeNote.content.slice(0,9000)}`;$('chat-counter').textContent=$('chat-input').value.length+' / 10,000';selectView('chat');});
$('accent-select').addEventListener('change',e=>{state.preferences.accent=e.target.value;document.body.dataset.accent=e.target.value;saveSoon()});$('compact-toggle').addEventListener('change',e=>{state.preferences.compact=e.target.checked;document.body.classList.toggle('compact',e.target.checked);saveSoon()});$('backup-all').addEventListener('click',exportAll);$('restore-all').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';importAll(file)});$('reset-all').addEventListener('click',async()=>{if(!confirm('Reset projects, notes, chat and audit? API keys remain encrypted in the separate vault.'))return;if(!confirm('This removes the saved workspace from this browser. Confirm?'))return;try{await replaceWorkspace(freshState());toast('Application data reset and saved.');}catch(e){toast('Reset was not applied: '+errorText(e),true);}});$('recovery-backup').addEventListener('click',()=>{if(store.recoveryRaw!==null)download('mm-unreadable-'+(store.recoveryKind||'state')+'-backup.txt',store.recoveryRaw,'text/plain');});$('recovery-reset').addEventListener('click',async()=>{if(store.recoveryRaw===null)return;if(!confirm('Reset this unreadable saved record? Download its raw backup first.'))return;try{await replaceWorkspace(freshState());if(store.recoveryKind==='legacy')localStorage.removeItem('mm-platform-browser-b01');store.setRecovery(null,null);renderSettings();toast('Unreadable saved data replaced and saved; new workspace initialized.');}catch(e){toast('Reset failed: '+errorText(e),true);}});$('cache-refresh').addEventListener('click',refreshOfflineCache);}
async function boot(){try{const storageSpan=workshopMetrics.begin('storage-check');let stored;try{stored=await read('state.v1');workshopMetrics.finish(storageSpan,'ok');}catch(e){workshopMetrics.finish(storageSpan,'error','storage-error');throw e;}if(stored!==null){if(!(await store.adoptStoredWorkspace(stored))){store.setRecovery(JSON.stringify(stored),'state');store.setStorageFailed(true);state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:null,lastSeenEntityRevision:null});toast('Unreadable B0.3 state detected. Original data preserved; use Settings → Recovery before saving.',true);}}else{let legacy=null;let raw=null;try{raw=localStorage.getItem('mm-platform-browser-b01');if(raw)legacy=JSON.parse(raw);}catch{store.setRecovery(raw,'legacy');}if(legacy){try{state=migrateLegacy(legacy);}catch{store.setRecovery(raw,'legacy');}}if(!state)state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:0,lastEntityJson:store.snapshotEntityJson(state)});await write('state.v1',state);try{await migrateToEntities(read,write,state);store.setRevisionBookkeeping({lastSeenEntityRevision:state.revision});}catch{}if(store.recoveryRaw)toast('Legacy project unreadable: raw bytes preserved. Open Settings → Recovery.',true);}openCrossTabChannel();}catch(e){state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:null,lastSeenEntityRevision:null,lastEntityJson:{}});store.setStorageFailed(true);toast('Browser storage unavailable. Export your work frequently: '+errorText(e),true);}
$('key-provider').replaceChildren(...PROVIDERS.map(p=>new Option(p.name,p.id)));$('key-model').value=PROVIDERS[0].model;
run=new RuntimeRunner(document.body,(active,lang)=>{$('stop-code').disabled=!active;$('runner-status').textContent=active?'Running '+lang:'Idle';});exec.attachRunner(run);
$('workflow-stages').value=FLOW_TEMPLATES.research.join('\n');wire();setupWasmImport({el,toast});setupExpressionRepl({el,toast});labs=setupLabs({el,toast,download,metrics:workshopMetrics,getDatasets:()=>state.datasets||[],commitDatasets:async(next)=>{if(store.isStorageFailed)throw Error('Local storage is in recovery mode; export a backup first.');const previous=state.datasets;state.datasets=next;try{await saveNow();}catch(e){state.datasets=previous;throw e;}}});document.body.dataset.accent=state.preferences?.accent||'cyan';document.body.classList.toggle('compact',!!state.preferences?.compact);const relBuild=optionalControl('release-build');if(relBuild)relBuild.textContent=VERSION;renderAll();$('save-indicator').textContent=store.isStorageFailed?'Save failed — export a backup':savedStatus();const initial=location.hash.slice(1);selectView(VIEWS[initial]?initial:'overview');if('serviceWorker' in navigator && location.protocol!=='file:'){void Promise.resolve().then(()=>navigator.serviceWorker.register('./sw.js',{scope:'./'})).catch(e=>console.warn('Offline shell unavailable:',e?.message||'registration failed'));}if(bootMissingControls.size){document.documentElement.dataset.mmBoot='degraded';toast('Interface files may be out of sync. Missing controls: '+[...bootMissingControls].join(', ')+'. Reload after refreshing the offline cache.',true);}else document.documentElement.dataset.mmBoot='ready';workshopMetrics.finish(bootTrace,bootMissingControls.size?'warning':'ok',bootMissingControls.size?'invalid-input':'none');}
boot().catch(e=>{workshopMetrics.finish(bootTrace,'error','uncaught-error');document.documentElement.dataset.mmBoot='failed';console.error('Initialization error',e);toast('Initialization error: '+errorText(e),true)});
