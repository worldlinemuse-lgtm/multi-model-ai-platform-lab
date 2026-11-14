import {VERSION,PROVIDERS,VIEWS,FLOW_TEMPLATES,now,providerById,freshState,migrateLegacy,routeDescription} from './core.js';
import {read,write,remove,isDurableStorage} from './storage.js';
import {CROSS_TAB_CHANNEL} from './cross-tab.js';
import {migrateToEntities} from './entity-store.js';
import {createWorkspaceStore} from './workspace-store.js';
import {createProjects} from './projects.js';
import {KeyVault} from './vault.js';
import {callProvider} from './provider-api.js';
import {createWorkshopMetrics} from './request-trace.js';
import {renderTelemetry,wireHud,hudUpdate,hudHide} from './telemetry-view.js';
import {initOtelBridge,attachOtel} from './otel-workshop.js';
import {RuntimeRunner} from './sandbox.js';
import {createExecution} from './execution.js';
import {createProviders} from './providers.js';
import {createChat} from './chat.js';
import {createWorkbench} from './workbench.js';
import {setupLabs} from './labs.js';
import {setupWasmImport} from './wasm-ui.js';
import {setupExpressionRepl} from './expression-repl-ui.js';
import {el,qs,qsa,$,make,clearNode,formatTime,errorText} from './dom-helpers.js';
const vault=new KeyVault(()=>{try{crossTabChannel?.postMessage({type:'vault-saved'});}catch{}});
// Real OpenTelemetry SDK (local-only). initOtelBridge() never blocks boot and
// never throws: the bridge attaches asynchronously when the bundles load.
// Until then (and if they are missing or broken) the workshop runs exactly
// as before; otelStatus() reports loading|ready|disabled|unavailable|failed.
const workshopMetrics=attachOtel(createWorkshopMetrics(),null);
initOtelBridge().then(result=>workshopMetrics.setBridge(result));
const bootTrace=workshopMetrics.begin('boot');
let state,run,labs,activeView='overview',toastTimer=null,crossTabChannel=null;
const bootMissingControls=new Set();
function optionalControl(id){const node=$(id);if(!node)bootMissingControls.add(id);return node;}
document.documentElement.dataset.mmBoot='starting';
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
 clearActiveNote(){workbench.clearActiveNote();}
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
 renderStats,
 // After any import lands, open the workspace, show the stage and play it.
 onImported(){selectView('workspace');exec.previewPage();},
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
 download,callProvider,isDurableStorage,
 renderFiles:()=>renderFiles()
});
// Read-only debug hook for local automation (Simone bridge): agent trace has code/results, never keys.
window.__mmAgent=Object.freeze({trace:()=>chat.agentTrace()});
// Stage 4b group 7: the remaining views live in workbench.js. wire() and
// boot() stay here — they are the app entry and assembly.
const workbench=createWorkbench({
 getState:()=>state,
 saveSoon,saveNow,replaceWorkspace,
 toast,audit,
 metrics:workshopMetrics,
 vault,callProvider,selectView,
 renderFiles,renderStats,download,tracedExport,optionalControl,
 routeChoices:()=>providers.routeChoices(),
 renderProviders:()=>providers.renderProviders(),
 renderVault:()=>providers.renderVault(),
 renderChat,
 store,
 getLabs:()=>labs,
 getActiveView:()=>activeView,
 runCode:()=>exec.runCode(),
 runStop:()=>exec.stopCode(),
 newThread, newFile, createProject,
 savedStatus
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

function renderAudit(){workbench.renderAudit();}
function renderFlowGraph(states,givenPlan){return workbench.renderFlowGraph(states,givenPlan);}
function renderWorkflows(){workbench.renderWorkflows();}
async function executeWorkflow(event){return workbench.executeWorkflow(event);}
async function resumeWorkflow(){return workbench.resumeWorkflow();}

function previewLocalEvidence(){workbench.previewLocalEvidence();}
function insertLocalEvidence(){workbench.insertLocalEvidence();}
function renderKnowledge(){workbench.renderKnowledge();}
function cancelNoteEdit(){workbench.cancelNoteEdit();}
function beginNoteEdit(){workbench.beginNoteEdit();}
function showDuplicateNotes(){workbench.showDuplicateNotes();}
function submitKnowledge(e){return workbench.submitKnowledge(e);}
async function importKnowledge(input){return workbench.importKnowledge(input);}
async function refreshLocalCapabilities(){return workbench.refreshLocalCapabilities();}
async function runOndeviceReadiness(){return workbench.runOndeviceReadiness();}
async function renderWorkshopMetrics(){return workbench.renderWorkshopMetrics();}
function renderCapabilities(){workbench.renderCapabilities();}
function renderSettings(){workbench.renderSettings();}
function exportAll(){workbench.exportAll();}
async function importAll(file){return workbench.importAll(file);}
function renderAll(){workbench.renderAll();}
function buildActivityBar(){workbench.buildActivityBar();}
function syncActivityBar(){workbench.syncActivityBar();}
function commandDialog(){workbench.commandDialog();}
async function refreshOfflineCache(){return workbench.refreshOfflineCache();}
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
$('project-select').addEventListener('change',e=>{state.activeProjectId=e.target.value;exec.finishCodeMetric('cancelled','superseded');run.stop();renderFiles();saveSoon()});$('new-project').addEventListener('click',createProject);$('rename-project').addEventListener('click',renameProject);$('delete-project').addEventListener('click',deleteProject);$('snapshot-project').addEventListener('click',snapshot);$('snapshot-select').addEventListener('change',renderSnapshotActions);$('snapshot-action-run').addEventListener('click',manageSnapshot);$('restore-snapshot').addEventListener('click',restoreSnapshot);$('add-file').addEventListener('click',newFile);$('rename-file').addEventListener('click',renameFile);$('move-folder').addEventListener('click',moveFolder);$('copy-folder').addEventListener('click',copyFolder);$('delete-file').addEventListener('click',deleteFile);$('add-local-files').addEventListener('change',e=>importTextFiles(e.target));$('binary-asset-import').addEventListener('change',e=>importBinaryAssets(e.target));$('binary-asset-delete').addEventListener('click',removeBinaryAsset);$('code-editor').addEventListener('input',editFile);$('code-editor').addEventListener('scroll',e=>{$('line-gutter').scrollTop=e.target.scrollTop});$('code-editor').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const t=e.target,start=t.selectionStart,end=t.selectionEnd;t.setRangeText('  ',start,end,'end');editFile();}});$('run-code').addEventListener('click',()=>exec.runCode());$('stop-code').addEventListener('click',()=>exec.stopCode());$('preview-page').addEventListener('click',()=>exec.previewPage());$('clear-console').addEventListener('click',()=>exec.clearConsole());$('show-console').addEventListener('click',()=>exec.showExecTab('console'));$('show-preview').addEventListener('click',()=>exec.showExecTab('preview'));$('export-json').addEventListener('click',()=>tracedExport(()=>download(project().name.replace(/\W+/g,'_')+'.json',projectJSON())));$('export-zip').addEventListener('click',()=>tracedExport(()=>download(project().name.replace(/\W+/g,'_')+'.zip',projectZip(),'application/zip')));$('import-project').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';importProject(file)});$('github-repo-import').addEventListener('click',()=>{const url=$('github-repo-url').value;projects.importGitHubRepo(url)});
$('provider-search').addEventListener('input',e=>providers.renderProviders(e.target.value));$('provider-check-local').addEventListener('click',()=>providers.q22InspectRoutes());$('provider-check-groq').addEventListener('click',()=>providers.inspectGroqLiveMetadata());$('provider-preset-import').addEventListener('change',e=>providers.importProviderPresets(e));$('provider-preset-export').addEventListener('click',()=>providers.exportLocalPresets());$('provider-preset-select').addEventListener('change',()=>providers.renderProviderPresets());$('provider-preset-apply').addEventListener('click',()=>providers.applyProviderPreset());$('vault-form').addEventListener('submit',e=>providers.submitVault(e));$('vault-export-encrypted').addEventListener('click',()=>providers.exportEncryptedVaultUI());$('vault-import-encrypted').addEventListener('change',e=>providers.importEncryptedVaultUI(e));$('vault-rotate-form').addEventListener('submit',e=>providers.rotateVaultUI(e));$('vault-lock').addEventListener('click',()=>{vault.lock();renderAll();toast('Key vault locked.');});$('vault-wipe').addEventListener('click',async()=>{if(!confirm('Permanently erase ALL encrypted API keys from this device?'))return;if(!confirm('Confirm permanent vault deletion. This cannot be undone.'))return;try{await vault.erase();renderAll();toast('Encrypted vault erased.');}catch(e){toast(errorText(e),true);}});$('key-provider').addEventListener('change',e=>{$('key-model').value=vault.get(e.target.value)?.model||providerById(e.target.value)?.model||'';$('key-account').value=vault.get(e.target.value)?.account||'';});$('save-key').addEventListener('click',()=>{if(!vault.isUnlocked){toast('First create or unlock your vault with a passphrase. Your provider fields will remain filled.',true);$('vault-password').focus();$('vault-password').scrollIntoView({behavior:'smooth',block:'center'});}});$('key-form').addEventListener('submit',e=>providers.submitKey(e));
$('chat-route').addEventListener('change',()=>providers.renderCompareRoute());$('compare-mode').addEventListener('change',()=>providers.renderCompareRoute());$('chat-output-tokens').addEventListener('change',e=>{state.preferences.maxOutputTokens=Number(e.target.value);saveSoon();toast('Request output cap saved locally. Provider eligibility and free balance remain unverified.');});$('chat-form').addEventListener('submit',sendMessage);const chatHost=$('chat-messages'),toTop=$('chat-to-top');const syncToTop=()=>{if(toTop)toTop.hidden=chatHost.scrollTop<300;};chatHost.addEventListener('scroll',syncToTop,{passive:true});if(toTop)toTop.addEventListener('click',()=>chatHost.scrollTo({top:0,behavior:'smooth'}));$('chat-retry-draft').addEventListener('click',q22DraftManualRetry);$('chat-input').addEventListener('input',e=>$('chat-counter').textContent=e.target.value.length+' / 10,000');$('stop-chat').addEventListener('click',stopChat);$('send-selected-code').addEventListener('click',addCodeToChat);$('new-chat').addEventListener('click',newThread);$('clear-chat').addEventListener('click',clearThread);$('thread-search').addEventListener('input',renderThreadList);$('export-chat-thread').addEventListener('click',exportThread);$('delete-chat-thread').addEventListener('click',deleteThread);$('export-audit').addEventListener('click',()=>download('mm-audit.json',JSON.stringify(state.audit,null,2)));$('clear-audit').addEventListener('click',()=>{if(!confirm('Clear local audit log?'))return;state.audit=[];saveSoon();renderAudit();});
$('workflow-template').addEventListener('change',()=>{$('workflow-stages').value=FLOW_TEMPLATES[$('workflow-template').value].join('\n');renderFlowGraph();});$('workflow-stages').addEventListener('input',()=>renderFlowGraph());$('workflow-form').addEventListener('submit',executeWorkflow);$('workflow-resume').addEventListener('click',resumeWorkflow);$('workflow-stop').addEventListener('click',()=>workbench.stopWorkflow());$('capability-refresh').addEventListener('click',refreshLocalCapabilities);$('ondevice-probe').addEventListener('click',runOndeviceReadiness);$('knowledge-form').addEventListener('submit',submitKnowledge);$('knowledge-edit').addEventListener('click',beginNoteEdit);$('knowledge-cancel-edit').addEventListener('click',()=>{cancelNoteEdit();toast('Note edit cancelled without changes.');});$('knowledge-find-duplicates').addEventListener('click',showDuplicateNotes);$('knowledge-search').addEventListener('input',()=>workbench.resetKnowledgeSearch());$('knowledge-page-prev').addEventListener('click',()=>workbench.changeKnowledgePage(-1));$('knowledge-page-next').addEventListener('click',()=>workbench.changeKnowledgePage(1));$('knowledge-import').addEventListener('change',e=>importKnowledge(e.target));$('knowledge-evidence').addEventListener('click',previewLocalEvidence);$('knowledge-insert-evidence').addEventListener('click',insertLocalEvidence);$('knowledge-export').addEventListener('click',()=>workbench.exportKnowledge());$('knowledge-delete').addEventListener('click',()=>workbench.deleteActiveNote());$('knowledge-to-chat').addEventListener('click',()=>workbench.sendActiveNoteToChat());
$('accent-select').addEventListener('change',e=>{state.preferences.accent=e.target.value;document.body.dataset.accent=e.target.value;saveSoon()});$('compact-toggle').addEventListener('change',e=>{state.preferences.compact=e.target.checked;document.body.classList.toggle('compact',e.target.checked);saveSoon()});$('backup-all').addEventListener('click',exportAll);$('restore-all').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';importAll(file)});$('reset-all').addEventListener('click',async()=>{if(!confirm('Reset projects, notes, chat and audit? API keys remain encrypted in the separate vault.'))return;if(!confirm('This removes the saved workspace from this browser. Confirm?'))return;try{await replaceWorkspace(freshState());toast('Application data reset and saved.');}catch(e){toast('Reset was not applied: '+errorText(e),true);}});$('recovery-backup').addEventListener('click',()=>{if(store.recoveryRaw!==null)download('mm-unreadable-'+(store.recoveryKind||'state')+'-backup.txt',store.recoveryRaw,'text/plain');});$('recovery-reset').addEventListener('click',async()=>{if(store.recoveryRaw===null)return;if(!confirm('Reset this unreadable saved record? Download its raw backup first.'))return;try{await replaceWorkspace(freshState());if(store.recoveryKind==='legacy')localStorage.removeItem('mm-platform-browser-b01');store.setRecovery(null,null);renderSettings();toast('Unreadable saved data replaced and saved; new workspace initialized.');}catch(e){toast('Reset failed: '+errorText(e),true);}});$('cache-refresh').addEventListener('click',refreshOfflineCache);}
async function boot(){try{const storageSpan=workshopMetrics.begin('storage-check');let stored;try{stored=await read('state.v1');workshopMetrics.finish(storageSpan,'ok');}catch(e){workshopMetrics.finish(storageSpan,'error','storage-error');throw e;}if(stored!==null){if(!(await store.adoptStoredWorkspace(stored))){store.setRecovery(JSON.stringify(stored),'state');store.setStorageFailed(true);state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:null,lastSeenEntityRevision:null});toast('Unreadable B0.3 state detected. Original data preserved; use Settings → Recovery before saving.',true);}}else{let legacy=null;let raw=null;try{raw=localStorage.getItem('mm-platform-browser-b01');if(raw)legacy=JSON.parse(raw);}catch{store.setRecovery(raw,'legacy');}if(legacy){try{state=migrateLegacy(legacy);}catch{store.setRecovery(raw,'legacy');}}if(!state)state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:0,lastEntityJson:store.snapshotEntityJson(state)});await write('state.v1',state);try{await migrateToEntities(read,write,state);store.setRevisionBookkeeping({lastSeenEntityRevision:state.revision});}catch{}if(store.recoveryRaw)toast('Legacy project unreadable: raw bytes preserved. Open Settings → Recovery.',true);}openCrossTabChannel();}catch(e){state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:null,lastSeenEntityRevision:null,lastEntityJson:{}});store.setStorageFailed(true);toast('Browser storage unavailable. Export your work frequently: '+errorText(e),true);}
$('key-provider').replaceChildren(...PROVIDERS.map(p=>new Option(p.name,p.id)));$('key-model').value=PROVIDERS[0].model;
run=new RuntimeRunner(document.body,(active,lang)=>{$('stop-code').disabled=!active;$('runner-status').textContent=active?'Running '+lang:'Idle';});exec.attachRunner(run);
$('workflow-stages').value=FLOW_TEMPLATES.research.join('\n');wire();setupWasmImport({el,toast});setupExpressionRepl({el,toast});labs=setupLabs({el,toast,download,metrics:workshopMetrics,getDatasets:()=>state.datasets||[],commitDatasets:async(next)=>{if(store.isStorageFailed)throw Error('Local storage is in recovery mode; export a backup first.');const previous=state.datasets;state.datasets=next;try{await saveNow();}catch(e){state.datasets=previous;throw e;}}});document.body.dataset.accent=state.preferences?.accent||'cyan';document.body.classList.toggle('compact',!!state.preferences?.compact);const relBuild=optionalControl('release-build');if(relBuild)relBuild.textContent=VERSION;renderAll();$('save-indicator').textContent=store.isStorageFailed?'Save failed — export a backup':savedStatus();const initial=location.hash.slice(1);selectView(VIEWS[initial]?initial:'overview');if('serviceWorker' in navigator && location.protocol!=='file:'){void Promise.resolve().then(()=>navigator.serviceWorker.register('./sw.js',{scope:'./'})).catch(e=>console.warn('Offline shell unavailable:',e?.message||'registration failed'));}if(bootMissingControls.size){document.documentElement.dataset.mmBoot='degraded';toast('Interface files may be out of sync. Missing controls: '+[...bootMissingControls].join(', ')+'. Reload after refreshing the offline cache.',true);}else document.documentElement.dataset.mmBoot='ready';workshopMetrics.finish(bootTrace,bootMissingControls.size?'warning':'ok',bootMissingControls.size?'invalid-input':'none');}
boot().catch(e=>{workshopMetrics.finish(bootTrace,'error','uncaught-error');document.documentElement.dataset.mmBoot='failed';console.error('Initialization error',e);toast('Initialization error: '+errorText(e),true)});
