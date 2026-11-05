import {VERSION,MAX_NOTES,MAX_AUDIT,PROVIDERS,VIEWS,CAPABILITIES,FLOW_TEMPLATES,uid,now,providerById,freshState,validateState,migrateLegacy,csvSummary,routeDescription,historyForRoute,capMessageContent} from './core.js';
import {read,write,remove,storageMode,isDurableStorage} from './storage.js';
import {CROSS_TAB_CHANNEL} from './cross-tab.js';
import {migrateToEntities} from './entity-store.js';
import {createWorkspaceStore} from './workspace-store.js';
import {createProjects} from './projects.js';
import {KeyVault} from './vault.js';
import {callProvider,validateModel} from './provider-api.js';
import {parseProviderPresets,exportProviderPresets,resolvePresetRoute} from './provider-presets.js';
import {inspectProviderConfiguration,findManualRetryDraft} from './connection-diagnostics.js';
import {probeGroqModels,recommendGroqModel} from './provider-connection-probe.js';
import {traceDuration,createWorkshopMetrics} from './request-trace.js';
import {renderTelemetry,wireHud,hudUpdate,hudHide} from './telemetry-view.js';
import {initOtelBridge,attachOtel,otelDiagnosticsText} from './otel-workshop.js';
import {RuntimeRunner,previewReport} from './sandbox.js';
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
const guideById=new Map((window.MM_PROVIDER_GUIDES||[]).map(g=>[g.id,g]));
const vault=new KeyVault(()=>{try{crossTabChannel?.postMessage({type:'vault-saved'});}catch{}});
// Real OpenTelemetry SDK (local-only). initOtelBridge() never blocks boot and
// never throws: the bridge attaches asynchronously when the bundles load.
// Until then (and if they are missing or broken) the workshop runs exactly
// as before; otelStatus() reports loading|ready|disabled|unavailable|failed.
const workshopMetrics=attachOtel(createWorkshopMetrics(),null);
initOtelBridge().then(result=>workshopMetrics.setBridge(result));
const bootTrace=workshopMetrics.begin('boot');
let codeRunTrace=null,codeRunRequestId=null,codeRunStartedAt=0,codeRunLang='javascript';
function finishCodeMetric(outcome,reason='none'){if(!codeRunTrace)return;const trace=codeRunTrace,requestId=codeRunRequestId,startedAt=codeRunStartedAt,lang=codeRunLang;workshopMetrics.finish(trace,outcome,reason);codeRunTrace=null;codeRunRequestId=null;const status=outcome==='ok'?'success':outcome==='error'?'failed':'stopped';audit('run',lang,status,null,{requestId,latencyMs:traceDuration(startedAt,performance.now())});}
let state,run,labs,capabilityProbeEpoch=0,pythonRuntimeStatus='UNTESTED',lastRunLang=null,activeView='overview',activeNote=null,editingNoteId=null,toastTimer=null,activeChatControllers=[],chatSendPending=false,workflowController=null,crossTabChannel=null;
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
function thread(){return state.threads.find(t=>t.id===state.activeThreadId)||state.threads[0];}
function setDrawer(open){$('sidebar').classList.toggle('open',open);$('nav-backdrop').hidden=!open;$('mobile-menu').setAttribute('aria-expanded',String(open));document.body.style.overflow=open?'hidden':'';}
function selectView(view){if(!VIEWS[view])return;if(view==='chat'&&window.setChatDocked)window.setChatDocked(false);activeView=view;for(const node of qsa('.screen'))node.hidden=node.dataset.screen!==view;for(const b of qsa('[data-view]')){const current=b.dataset.view===view;b.classList.toggle('selected',current);b.setAttribute('aria-current',current?'page':'false')}const label=$('current-view-label');label.textContent=VIEWS[view];
const navBtn=document.querySelector('.nav-item[data-view="'+view+'"]');
const navEl=navBtn?navBtn.closest('nav'):null;
let grp='WORKSPACE';
if(navEl){let sib=navEl.previousElementSibling;while(sib){if(sib.classList&&sib.classList.contains('side-group-label')){grp=sib.textContent.trim();break;}sib=sib.previousElementSibling;}}
const grpEl=$('current-group-label');if(grpEl)grpEl.textContent=grp;syncActivityBar();setDrawer(false);if(view==='overview')renderStats();if(view==='providers')renderProviders();if(view==='vault')renderVault();if(view==='chat')renderChat();if(view==='usage')renderAudit();if(view==='workflows')renderWorkflows();if(view==='knowledge')renderKnowledge();if(view==='settings')renderSettings();if(view==='capabilities')renderCapabilities();if(view==='telemetry')renderTelemetry(state.audit,workshopMetrics);history.replaceState(null,'',`#${view}`);}
function renderHealth(){const checks=[['Browser storage',!store.isStorageFailed&&isDurableStorage()?'PERSISTENT':'TEMPORARY'],['JavaScript Workers',typeof Worker==='function'?'AVAILABLE':'UNAVAILABLE'],['Key vault',vault.isUnlocked?'UNLOCKED':'LOCKED'],['Provider calls','UNVERIFIED'],['Python execution',pythonRuntimeStatus],['Offline shell',navigator.serviceWorker?.controller?'CONTROLLING':'INACTIVE']];const host=clearNode($('health-list'));for(const [name,status] of checks){const row=make('div','health-line');row.append(make('span','health-icon pending','○'),make('span','',name),make('strong','',status));host.append(row);}}
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
const consoleLimit=50000;let terminalLines=0;
function printConsole(text){const area=$('console-output');if(++terminalLines>180){if(terminalLines===181){run.stop();area.textContent=(area.textContent+'\n[Output flood limit reached; worker terminated.]').slice(0,consoleLimit);}return;}let next=area.textContent+(area.textContent?'\n':'')+String(text);if(next.length>consoleLimit)next=next.slice(0,consoleLimit)+'\n[Output truncated]';area.textContent=next;area.scrollTop=area.scrollHeight;}
function showExecTab(tab){$('console-pane').hidden=tab!=='console';$('preview-pane').hidden=tab!=='preview';$('show-console').classList.toggle('active',tab==='console');$('show-preview').classList.toggle('active',tab==='preview');}
function runCode(){const p=project(),filename=p.active;const setting=$('runtime-choice').value;const lang=setting==='auto'?(filename.endsWith('.py')?'python':'javascript'):setting;if(setting==='auto'&&!/\.(py|js|mjs|cjs)$/.test(filename))return toast('Choose a .js or .py file, or set the runtime manually.',true);if(lang==='python'&&navigator.onLine===false){toast('You appear to be offline. Python needs to download its runtime once before it can run.',true);return;}finishCodeMetric('cancelled','superseded');showExecTab('console');terminalLines=0;$('console-output').textContent=`Running ${filename} in isolated ${lang==='python'?'Python/WebAssembly':'JavaScript'} worker…`;codeRunTrace=workshopMetrics.begin('code-run');if(codeRunTrace){codeRunRequestId=crypto.randomUUID();codeRunStartedAt=performance.now();codeRunLang=lang;audit('run',lang,'started',null,{requestId:codeRunRequestId});}try{lastRunLang=lang;if(lang==='python')pythonRuntimeStatus='RUNNING — REQUIRES CDN';run.run(p.files[filename],lang,(type,msg)=>{if(type==='done')finishCodeMetric('ok');else if(type==='error')finishCodeMetric('error','runtime-error');if(lang==='python'){if(type==='done'&&msg.includes('Python execution complete.'))pythonRuntimeStatus='EXECUTED THIS SESSION';else if(type==='error')pythonRuntimeStatus='FAILED THIS SESSION';}if(type==='error')printConsole('ERROR: '+msg);else printConsole(msg);},lang==='python'?120000:Number($('code-time-limit').value),lang==='javascript'?{files:p.files,entry:filename}:null,phase=>{try{workshopMetrics.event(codeRunTrace,phase)}catch{}});}catch(e){finishCodeMetric('error','worker-error');toast(errorText(e),true);}}
function stopCode(){run.stop('Execution stopped by user.');}
function previewPage(){finishCodeMetric('cancelled','superseded');run.stop();const span=workshopMetrics.begin('preview');const p=project();const html=p.active.endsWith('.html')?p.active:Object.keys(p.files).find(f=>f.endsWith('.html'));if(!html){workshopMetrics.finish(span,'cancelled','invalid-input');return toast('Create or select an HTML file to preview.',true);}try{const result=previewReport(p.files,html);const frame=make('iframe');frame.title='Opaque-origin local project preview';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.srcdoc=result.document;$('preview-host').replaceChildren(frame);showExecTab('preview');workshopMetrics.finish(span,result.warnings.length?'warning':'ok',result.warnings.length?'unsupported-asset':'none');toast(result.warnings.length?`Preview ${html}: ${result.warnings.length} unresolvable or unsupported reference(s), for example ${result.warnings[0]}`:`Previewing ${html}; only its referenced local CSS/classic JS are included.`,result.warnings.length>0);}catch(error){workshopMetrics.finish(span,'error','invalid-input');toast('Preview could not be built: '+errorText(error),true);}}

function q22InspectRoutes(){
 const routes=PROVIDERS.map(p=>inspectProviderConfiguration(p.id,vault.get(p.id)));
 const text=routes.map(x=>x.provider+': '+x.state+(x.endpointHost?' @ '+x.endpointHost:'')+'\n'+x.issues.join('; ')).join('\n\n');
 $('provider-diagnostics').textContent=text;
 toast('Local-only configuration inspection complete. No HTTP request was sent.');
}
async function inspectGroqLiveMetadata(){
 const button=$('provider-check-groq'),output=$('provider-groq-diagnostics');
 if(button.disabled)return;
 const credential=vault.get('groq');
 if(!credential?.key||credential.attested!==true){
  output.textContent='No unlocked Groq credential. Save your Groq key in Key vault and return here.';
  return;
 }
 if(!confirm('Send one read-only Groq models-list request using your locally saved key? This contacts Groq, consumes no inference tokens, and does not automatically retry.'))return;
 button.disabled=true;output.textContent='Contacting Groq models endpoint once (metadata only)…';
 try{
  const result=await probeGroqModels({credential});
  const lines=['Groq metadata: '+result.state,result.message];
  if(result.httpStatus)lines.push('HTTP '+result.httpStatus);
  if(result.state==='models-received'){
   const selected=credential.model||'';
   const suggestion=recommendGroqModel(result.models,selected);
   lines.push('Active model IDs observed: '+result.totalActiveModels);
   lines.push('Current saved model: '+(selected||'(none)'));
   lines.push('Current model in active list: '+(result.models.includes(selected)?'yes':'no'));
   lines.push('Candidate model: '+(suggestion.model||'manual review needed'));
   lines.push(suggestion.reason);
   lines.push('First 12 active IDs: '+result.models.slice(0,12).join(', '));
   lines.push('No model was changed or queried for inference.');
  }
  output.textContent=lines.join('\n');
 }catch{
  output.textContent='Groq metadata diagnostic could not complete. The key was not recorded in this result.';
 }finally{button.disabled=false;}
}
function q22DraftManualRetry(){
 if(chatBusy())return toast('Stop running requests before preparing a retry.',true);
 const route=$('chat-route').value,draft=findManualRetryDraft(thread().messages,route);
 if(!draft)return toast('No saved failed response for this selected route has a matching user message.',true);
 if(!confirm('Prepare the last failed prompt for '+route+'? A new send may spend quota even if the original request completed remotely. Preparing does not send anything.'))return;
 $('chat-input').value=draft.prompt;
 $('chat-counter').textContent=draft.prompt.length+' / 10,000';
 toast('Retry draft prepared only. Review it and press Send yourself to make a new request.');
 $('chat-input').focus();
}
function renderProviderPresets(){
 const list=state.preferences?.providerPresets||[],select=$('provider-preset-select'),prior=select.value;
 select.replaceChildren(new Option('Choose a saved model preset…',''));
 list.forEach((p,i)=>select.add(new Option(p.label+' · '+p.provider+' · '+p.model,String(i))));
 if([...select.options].some(x=>x.value===prior))select.value=prior;
 $('provider-preset-count').textContent=list.length+' saved local model preset(s). No keys or endpoints stored.';
 $('provider-preset-apply').disabled=!select.value;
}
async function importProviderPresets(event){
 const input=event.target,file=input.files?.[0];input.value='';
 if(!file)return;
 if(file.size>15000)return toast('Preset manifest exceeds 15 KB.',true);
 try{
  const parsed=parseProviderPresets(await file.text());
  if(!confirm('Replace current local model presets with '+parsed.length+' new data-only entries? No keys or API requests involved.'))return;
  const previous=state.preferences.providerPresets;
  state.preferences.providerPresets=parsed;
  try{await saveNow();}catch(error){state.preferences.providerPresets=previous;throw error;}
  renderProviderPresets();toast('Validated local model presets imported. Free account/model eligibility remains unverified.');
 }catch(error){toast('Preset import rejected: '+errorText(error),true);}
}
function exportLocalPresets(){
 try{download('mm-provider-presets.json',exportProviderPresets(state.preferences.providerPresets||[]));}
 catch(error){toast('Preset export failed: '+errorText(error),true);}
}
function applyProviderPreset(){
 const index=Number($('provider-preset-select').value);
 try{
  if($('provider-preset-select').value==='')throw Error('Select a saved preset first.');
  const candidate=resolvePresetRoute(state.preferences.providerPresets||[],index);
  $('key-provider').value=candidate.provider;$('key-model').value=candidate.model;
  $('key-account').value=vault.get(candidate.provider)?.account||'';
  selectView('vault');
  toast('Unverified provider/model preset copied to vault form. Provide your eligible free-plan key and explicitly save.');
 }catch(error){toast('Preset selection rejected: '+errorText(error),true);}
}
function renderProviders(query=$('provider-search').value||''){renderProviderPresets();const host=clearNode($('provider-list'));let count=0;for(const p of PROVIDERS){const g=guideById.get(p.id);if(!(p.name+p.window+(g?.scope||'')+(g?.reset||'')).toLowerCase().includes(query.toLowerCase()))continue;count++;const card=make('article','provider-card');const top=make('div','provider-top');top.append(make('h2','',p.name),make('span','tag '+(vault.get(p.id)?'good':'muted'),vault.get(p.id)?'KEY SAVED':'NOT CONNECTED'));card.append(top,make('p','',g?.note||'Eligible recurring-free source.'));const tags=make('div','provider-meta');tags.append(make('span','tag',p.window),make('span','tag','REMAINING: UNKNOWN'));card.append(tags);if(g){const d=make('details');d.append(make('summary','','Setup instructions + quota scope'));d.append(make('p','','Quota scope: '+g.scope));d.append(make('p','','Published reset: '+g.reset));const ol=make('ol');for(const step of g.steps)ol.append(make('li','',step));d.append(ol);card.append(d);const links=make('div','provider-links');for(const [label,url] of [['Create account ↗',g.signup_url],['Get key ↗',g.key_url],['Docs ↗',g.docs_url],['Limits ↗',g.limits_url]]){if(!url)continue;const a=make('a','',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}card.append(links);}const button=make('button','button secondary small',vault.get(p.id)?'Manage saved key →':'Connect a key →');button.type='button';button.addEventListener('click',()=>{$('key-provider').value=p.id;$('key-model').value=vault.get(p.id)?.model||p.model;$('key-account').value=vault.get(p.id)?.account||'';selectView('vault');});card.append(button);host.append(card);}if(!count)host.append(make('p','','No providers match this search.'));}
async function exportEncryptedVaultUI(){
 try{
  const backup=await vault.exportEncrypted();
  download('mm-encrypted-key-vault.json',backup,'application/json');
  toast('Encrypted-only vault backup exported. Keep the original passphrase; it is never stored in this file.');
 }catch(e){toast('Encrypted backup failed: '+errorText(e),true);}
}
async function importEncryptedVaultUI(event){
 const input=event.target,file=input.files?.[0];input.value='';
 const passwordBox=$('vault-import-passphrase'),passphrase=passwordBox.value;passwordBox.value='';
 if(!file)return;
 if(!passphrase||passphrase.length<10)return toast('Enter the ORIGINAL encrypted backup passphrase before selecting the file.',true);
 if(file.size>1000000)return toast('Encrypted vault backup exceeds 1 MB.',true);
 const exists=await vault.exists();
 if(exists&&!confirm('Replace the EXISTING encrypted key vault on this device? Export its encrypted backup first. Importing a different vault will require that backup’s original passphrase and cannot be undone here.'))return;
 try{
  await vault.importEncrypted(await file.text(),{replaceExisting:exists,passphrase});
  $('vault-password').value='';renderAll();
  toast('Encrypted vault imported and locked. Unlock it with its original passphrase.');
 }catch(e){toast('Vault import rejected: '+errorText(e),true);}
}
async function rotateVaultUI(event){
 event.preventDefault();
 const current=$('vault-rotation-old').value,newPass=$('vault-rotation-new').value;
 if(!vault.isUnlocked)return toast('Unlock vault before changing its passphrase.',true);
 if(!confirm('Rotate this device’s vault encryption passphrase? Previously exported encrypted backups will still require their OLD passphrase.'))return;
 try{
  await vault.rotatePassphrase(current,newPass);
  renderAll();toast('Vault re-encrypted with a new random salt and IV. Export a new encrypted backup.');
 }catch(e){toast('Passphrase rotation rejected: '+errorText(e),true);}
 finally{$('vault-rotation-old').value='';$('vault-rotation-new').value='';}
}
async function renderVault(){const exists=await vault.exists();$('vault-status').textContent=vault.isUnlocked?'UNLOCKED':exists?'LOCKED':'NOT CREATED';$('vault-status').className='tag '+(vault.isUnlocked?'good':'muted');$('vault-action-title').textContent=exists?'Unlock your encrypted vault':'Create your encrypted vault';$('vault-submit').textContent=exists?'Unlock vault':'Create vault';$('vault-entry-hint').textContent=vault.isUnlocked?'Vault unlocked. Enter your provider information and save it encrypted.':'You can enter provider information now. To save it securely, first create or unlock your vault using the passphrase field on this page.';$('vault-lock').disabled=!vault.isUnlocked;$('vault-export-encrypted').disabled=!exists;$('vault-rotate-submit').disabled=!vault.isUnlocked;const host=clearNode($('vault-items'));if(!vault.isUnlocked){host.append(make('p','hint-line',exists?'Vault is locked. Enter your passphrase to access saved key slots.':'No vault created yet. Choose a passphrase to begin.'));}else{for(const entry of vault.list()){const div=make('div','vault-item'),description=make('div');description.append(make('b','',providerById(entry.id)?.name||entry.id),make('small','',`${entry.model} · saved ${formatTime(entry.updated)}`));const removeButton=make('button','text-button danger-text','Remove');removeButton.addEventListener('click',async()=>{if(!confirm(`Remove ${entry.id} credentials?`))return;try{await vault.drop(entry.id);renderAll();toast('Key slot removed.');}catch(e){toast(errorText(e),true);}});div.append(description,removeButton);host.append(div);}if(!vault.count)host.append(make('p','hint-line','No keys stored yet. Add your first eligible route.'));}renderStats();}
async function submitVault(event){event.preventDefault();const pass=$('vault-password').value;try{if(await vault.exists())await vault.unlock(pass);else await vault.create(pass);$('vault-password').value='';toast('Vault unlocked on this device.');renderAll();}catch(e){toast(errorText(e),true);}}
async function submitKey(event){event.preventDefault();if(!vault.isUnlocked){toast('Your details are ready. Create or unlock your vault with a passphrase first; the fields will stay filled.',true);$('vault-password').focus();$('vault-password').scrollIntoView({behavior:'smooth',block:'center'});return;}const id=$('key-provider').value,model=$('key-model').value.trim(),key=$('key-value').value.trim(),account=$('key-account').value.trim();try{validateModel(id,model);if(id==='cloudflare'&&!/^[a-f0-9]{32}$/i.test(account))throw Error('Cloudflare requires a 32-character account ID');await vault.put(id,{key,model,account,attested:$('key-attest').checked});$('key-value').value='';$('key-attest').checked=false;renderAll();toast(`Encrypted key slot saved for ${providerById(id).name}. Provider connection is not verified until a request succeeds.`);}catch(e){toast(errorText(e),true);}}
function routeChoices(){const list=vault.list();for(const select of [$('chat-route'),$('workflow-route')]){const prior=select.value;select.replaceChildren();if(!list.length){select.add(new Option('Unlock + save a key first',''));continue;}for(const entry of list){select.add(new Option(`${providerById(entry.id)?.name||entry.id} · ${entry.model}`,entry.id));}if(list.some(e=>e.id===prior))select.value=prior;}const ready=list.length;$('chat-connection-label').textContent=ready?`${ready} saved key slot(s) · not verified`:'Unlock vault + connect an eligible free key';renderCompareRoute();}
function renderCompareRoute(){const select=$('compare-route'),previous=select.value,primary=$('chat-route').value;select.replaceChildren(new Option('Choose another route…',''));for(const entry of vault.list().filter(e=>e.id!==primary))select.add(new Option(`${providerById(entry.id)?.name||entry.id} · ${entry.model}`,entry.id));if([...select.options].some(o=>o.value===previous))select.value=previous;else select.value='';const compareWrap=optionalControl('compare-route-wrap');if(compareWrap)compareWrap.hidden=!$('compare-mode').checked;}
function chatDateGroup(ts){const d=new Date(ts),now=new Date();const startOfDay=x=>{const c=new Date(x);c.setHours(0,0,0,0);return c;};const days=Math.floor((startOfDay(now)-startOfDay(d))/86400000);if(days<=0)return 'Today';if(days===1)return 'Yesterday';if(days<7)return 'Previous 7 days';if(days<30)return 'Previous 30 days';return 'Older';}
function renderThreadList(){const host=clearNode($('thread-list')),query=$('thread-search').value.trim().toLowerCase();let count=0;let lastGroup=null;for(const t of state.threads.slice().reverse()){if(query&&!t.title.toLowerCase().includes(query)&&!t.messages.some(m=>m.content.toLowerCase().includes(query)))continue;count++;if(!query){const g=chatDateGroup(t.created||Date.now());if(g!==lastGroup){host.append(make('div','chat-date-group',g));lastGroup=g;}}const b=make('button','thread-entry'+(t.id===state.activeThreadId?' active':''),t.title||'Conversation');b.type='button';b.addEventListener('click',()=>{if(chatBusy())return toast('Finish the pending message save or model request before switching chats.',true);state.activeThreadId=t.id;renderChat();saveSoon()});host.append(b);}if(!count)host.append(make('p','hint-line','No matching conversations.'));}
function renderChat(){$('chat-output-tokens').value=String(state.preferences.maxOutputTokens??512);routeChoices();renderThreadList();const host=clearNode($('chat-messages'));const t=thread();if(!t.messages.length){const empty=make('div','chat-empty');empty.append(make('span','','✳'),make('h3','','Your next idea starts here.'),make('p','','Unlock a provider key, choose its model, then send a message. You can also compare two connected routes.'));const chips=make('div','prompt-chips');for(const prompt of ['Brainstorm product names','Explain a tricky concept','Review my code','Draft a professional email']){const c=make('button','prompt-chip',prompt);c.type='button';c.addEventListener('click',()=>{const inp=$('chat-input');inp.value=prompt;inp.focus();$('chat-counter').textContent=prompt.length+' / 10,000';});chips.append(c);}empty.append(chips);host.append(empty);}else for(const msg of t.messages){const bubble=make('div','bubble '+(msg.role==='user'?'user':'assistant')+(msg.error?' error':''));bubble.append(make('div','bubble-meta',msg.role==='user'?'YOU':`${msg.provider||'MODEL'} · ${msg.model||'unverified'}`),make('div','bubble-text',msg.content));if(msg.role==='user'){const edit=make('button','text-button','Edit message');edit.type='button';edit.setAttribute('aria-label','Edit saved user message');edit.addEventListener('click',()=>{if(chatBusy())return toast('Finish the pending message save or model request before editing chat history.',true);const updated=prompt('Edit this locally saved user message (not resent to providers):',msg.content);if(updated===null)return;if(!updated.trim()||updated.length>10000)return toast('Message must contain 1–10,000 characters.',true);msg.content=updated;renderChat();saveSoon();toast('Saved user message edited locally; no request was sent.');});bubble.append(edit);}host.append(bubble);}host.scrollTop=host.scrollHeight;}
function chatBusy(){return chatSendPending||activeChatControllers.length>0;}
function newThread(){if(chatBusy())return toast('Stop the active model request before starting a new chat.',true);if(state.threads.length>=120){if(!confirm('The 120-chat limit is reached. Creating another thread will delete the oldest one. Export your history first. Continue?'))return;state.threads.shift();}const t={id:uid('thread'),title:'New conversation',created:now(),messages:[]};state.threads.push(t);state.activeThreadId=t.id;renderChat();saveSoon();}
function clearThread(){if(chatBusy())return toast('Stop the active model request before clearing chat.',true);if(!confirm('Clear the currently selected conversation?'))return;thread().messages=[];thread().title='New conversation';renderChat();saveSoon();}
function exportThread(){const t=thread();download('mm-chat-'+t.id.replace(/[^a-z0-9_-]/gi,'')+'.json',JSON.stringify({format:'mm-studio-thread-v1',thread:t},null,2));}
function deleteThread(){if(chatBusy())return toast('Stop the active model request before deleting chat.',true);const current=thread();if(!confirm('Delete this conversation and all its locally saved messages? This cannot be undone. Export it first if needed.'))return;state.threads=state.threads.filter(t=>t.id!==current.id);if(!state.threads.length)state.threads=[{id:uid('thread'),title:'New conversation',created:now(),messages:[]}];state.activeThreadId=state.threads[state.threads.length-1].id;renderChat();saveSoon();toast('Conversation deleted locally.');}
function recordMessage(t,msg){const stored={...msg,at:now(),content:capMessageContent(msg.content)};t.messages.push(stored);t.messages=t.messages.slice(-150);renderChat();saveSoon();return stored;}
async function sendMessage(event){event?.preventDefault();const input=$('chat-input');const promptText=input.value.trim();if(!promptText)return;if(!isDurableStorage())return toast('Persistent browser storage is required before sending a model request. Export your work and enable IndexedDB.',true);if(navigator.onLine===false)return toast('You appear to be offline. Reconnect to send AI requests.',true);const id=$('chat-route').value;if(!id||!vault.get(id)){toast('Unlock your vault and select a connected key first. Taking you to the Key vault…',true);setTimeout(()=>selectView('vault'),900);return;}if(activeChatControllers.length)return toast('A model request is already running.',true);if(chatSendPending)return toast('A message send is already in progress.',true);const targets=[id];if($('compare-mode').checked){const second=$('compare-route').value;if(!second||second===id||!vault.get(second))return toast('Select a different, connected second route to compare.',true);targets.push(second);}const t=thread();if(t.messages.length>=147&&!confirm('This chat is near its 150-message limit. Older messages may be removed. Export this chat before continuing. Send anyway?'))return;const priorTitle=t.title,priorMessages=t.messages.slice();if(!t.messages.length)t.title=promptText.slice(0,45);chatSendPending=true;$('send-chat').disabled=true;recordMessage(t,{role:'user',content:promptText});
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
try{await saveNow();}catch(e){t.messages=priorMessages;t.title=priorTitle;renderChat();input.value=promptText;$('chat-counter').textContent=promptText.length+' / 10,000';chatSendPending=false;$('send-chat').disabled=false;toast('Request not sent: the prompt could not be saved locally. It is back in the input — send again once storage recovers, or export a backup first.',true);return;}
input.value='';$('chat-counter').textContent='0 / 10,000';$('send-chat').disabled=true;$('stop-chat').disabled=false;
const pending=targets.map(route=>{const controller=new AbortController();activeChatControllers.push(controller);const traceId=crypto.randomUUID(),startedAt=performance.now(),cred=vault.get(route);audit('inference',route,'requested',null,{requestId:traceId,model:cred?.model});const inferSpan=workshopMetrics.begin('inference');workshopMetrics.event(inferSpan,'request-sent');return (async()=>{try{const result=await callProvider(route,cred,[{role:'system',content:'Be helpful, accurate, and identify uncertainties.'},...historyForRoute(t.messages.slice(0,-1),route),{role:'user',content:promptText}],{signal:controller.signal,maxOutputTokens:state.preferences.maxOutputTokens??512});workshopMetrics.event(inferSpan,'response-received');workshopMetrics.finish(inferSpan,'ok');recordMessage(t,{role:'assistant',provider:route,model:result.model,content:result.text});audit('inference',route,'success',result.usage,{requestId:traceId,model:result.model,latencyMs:traceDuration(startedAt,performance.now()),httpStatus:result.httpStatus});return result;}catch(e){const cancelled=e.name==='AbortError';workshopMetrics.finish(inferSpan,cancelled?'cancelled':'error',cancelled?'user-stop':'runtime-error');recordMessage(t,{role:'assistant',provider:route,model:vault.get(route)?.model,error:true,content:cancelled?'Request stopped.':errorText(e)});audit('inference',route,cancelled?'stopped':'failed',null,{requestId:traceId,model:cred?.model,latencyMs:traceDuration(startedAt,performance.now())});return null;}})()});let results;try{results=await Promise.all(pending);await saveNow();}catch(e){toast('The model response could not be saved. Export a workspace backup before closing this tab: '+errorText(e),true);}finally{activeChatControllers=[];chatSendPending=false;$('send-chat').disabled=false;$('stop-chat').disabled=true;}if(results?.every(r=>r===null)){toast('All model requests failed. Use Retry draft to prepare the prompt again.',true);}renderChat();}
function stopChat(){activeChatControllers.forEach(c=>c.abort());toast('Stop requested for all in-flight model requests.');}
function addCodeToChat(){const p=project();const content=p.files[p.active];$('chat-input').value=($('chat-input').value+'\n\nPlease review the following file '+p.active+':\n```\n'+content.slice(0,8000)+'\n```').trim().slice(0,10000);$('chat-counter').textContent=$('chat-input').value.length+' / 10,000';selectView('chat');$('chat-input').focus();}

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
 routeChoices();renderFlowGraph();
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
function renderAll(){labs?.refreshSavedDatasets();renderFiles();routeChoices();renderProviders();renderVault();renderChat();renderAudit();renderWorkflows();renderKnowledge();renderStats();renderSettings();renderCapabilities();}
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
 ['Run code (Code studio)',()=>{selectView('workspace');runCode();}],
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
try{if(localStorage.getItem('mm-chat-docked')==='1')window.setChatDocked(true);}catch{}$('command-close').addEventListener('click',()=>$('command-dialog').close());document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();commandDialog()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveNow().then(()=>toast(savedStatus())).catch(()=>{}) }if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&activeView==='workspace'){e.preventDefault();runCode()}});
$('project-select').addEventListener('change',e=>{state.activeProjectId=e.target.value;finishCodeMetric('cancelled','superseded');run.stop();renderFiles();saveSoon()});$('new-project').addEventListener('click',createProject);$('rename-project').addEventListener('click',renameProject);$('delete-project').addEventListener('click',deleteProject);$('snapshot-project').addEventListener('click',snapshot);$('snapshot-select').addEventListener('change',renderSnapshotActions);$('snapshot-action-run').addEventListener('click',manageSnapshot);$('restore-snapshot').addEventListener('click',restoreSnapshot);$('add-file').addEventListener('click',newFile);$('rename-file').addEventListener('click',renameFile);$('move-folder').addEventListener('click',moveFolder);$('copy-folder').addEventListener('click',copyFolder);$('delete-file').addEventListener('click',deleteFile);$('add-local-files').addEventListener('change',e=>importTextFiles(e.target));$('binary-asset-import').addEventListener('change',e=>importBinaryAssets(e.target));$('binary-asset-delete').addEventListener('click',removeBinaryAsset);$('code-editor').addEventListener('input',editFile);$('code-editor').addEventListener('scroll',e=>{$('line-gutter').scrollTop=e.target.scrollTop});$('code-editor').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const t=e.target,start=t.selectionStart,end=t.selectionEnd;t.setRangeText('  ',start,end,'end');editFile();}});$('run-code').addEventListener('click',runCode);$('stop-code').addEventListener('click',stopCode);$('preview-page').addEventListener('click',previewPage);$('clear-console').addEventListener('click',()=>{terminalLines=0;$('console-output').textContent='';});$('show-console').addEventListener('click',()=>showExecTab('console'));$('show-preview').addEventListener('click',()=>showExecTab('preview'));$('export-json').addEventListener('click',()=>tracedExport(()=>download(project().name.replace(/\W+/g,'_')+'.json',projectJSON())));$('export-zip').addEventListener('click',()=>tracedExport(()=>download(project().name.replace(/\W+/g,'_')+'.zip',projectZip(),'application/zip')));$('import-project').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';importProject(file)});
$('provider-search').addEventListener('input',e=>renderProviders(e.target.value));$('provider-check-local').addEventListener('click',q22InspectRoutes);$('provider-check-groq').addEventListener('click',inspectGroqLiveMetadata);$('provider-preset-import').addEventListener('change',importProviderPresets);$('provider-preset-export').addEventListener('click',exportLocalPresets);$('provider-preset-select').addEventListener('change',renderProviderPresets);$('provider-preset-apply').addEventListener('click',applyProviderPreset);$('vault-form').addEventListener('submit',submitVault);$('vault-export-encrypted').addEventListener('click',exportEncryptedVaultUI);$('vault-import-encrypted').addEventListener('change',importEncryptedVaultUI);$('vault-rotate-form').addEventListener('submit',rotateVaultUI);$('vault-lock').addEventListener('click',()=>{vault.lock();renderAll();toast('Key vault locked.');});$('vault-wipe').addEventListener('click',async()=>{if(!confirm('Permanently erase ALL encrypted API keys from this device?'))return;if(!confirm('Confirm permanent vault deletion. This cannot be undone.'))return;try{await vault.erase();renderAll();toast('Encrypted vault erased.');}catch(e){toast(errorText(e),true);}});$('key-provider').addEventListener('change',e=>{$('key-model').value=vault.get(e.target.value)?.model||providerById(e.target.value)?.model||'';$('key-account').value=vault.get(e.target.value)?.account||'';});$('save-key').addEventListener('click',()=>{if(!vault.isUnlocked){toast('First create or unlock your vault with a passphrase. Your provider fields will remain filled.',true);$('vault-password').focus();$('vault-password').scrollIntoView({behavior:'smooth',block:'center'});}});$('key-form').addEventListener('submit',submitKey);
$('chat-route').addEventListener('change',renderCompareRoute);$('compare-mode').addEventListener('change',renderCompareRoute);$('chat-output-tokens').addEventListener('change',e=>{state.preferences.maxOutputTokens=Number(e.target.value);saveSoon();toast('Request output cap saved locally. Provider eligibility and free balance remain unverified.');});$('chat-form').addEventListener('submit',sendMessage);$('chat-retry-draft').addEventListener('click',q22DraftManualRetry);$('chat-input').addEventListener('input',e=>$('chat-counter').textContent=e.target.value.length+' / 10,000');$('stop-chat').addEventListener('click',stopChat);$('send-selected-code').addEventListener('click',addCodeToChat);$('new-chat').addEventListener('click',newThread);$('clear-chat').addEventListener('click',clearThread);$('thread-search').addEventListener('input',renderThreadList);$('export-chat-thread').addEventListener('click',exportThread);$('delete-chat-thread').addEventListener('click',deleteThread);$('export-audit').addEventListener('click',()=>download('mm-audit.json',JSON.stringify(state.audit,null,2)));$('clear-audit').addEventListener('click',()=>{if(!confirm('Clear local audit log?'))return;state.audit=[];saveSoon();renderAudit();});
$('workflow-template').addEventListener('change',()=>{$('workflow-stages').value=FLOW_TEMPLATES[$('workflow-template').value].join('\n');renderFlowGraph();});$('workflow-stages').addEventListener('input',()=>renderFlowGraph());$('workflow-form').addEventListener('submit',executeWorkflow);$('workflow-resume').addEventListener('click',resumeWorkflow);$('workflow-stop').addEventListener('click',()=>{workflowController?.abort();toast('Workflow cancellation requested.');});$('capability-refresh').addEventListener('click',refreshLocalCapabilities);$('ondevice-probe').addEventListener('click',runOndeviceReadiness);$('knowledge-form').addEventListener('submit',submitKnowledge);$('knowledge-edit').addEventListener('click',beginNoteEdit);$('knowledge-cancel-edit').addEventListener('click',()=>{cancelNoteEdit();toast('Note edit cancelled without changes.');});$('knowledge-find-duplicates').addEventListener('click',showDuplicateNotes);$('knowledge-search').addEventListener('input',()=>{currentKnowledgePage=0;renderKnowledge();});$('knowledge-page-prev').addEventListener('click',()=>{currentKnowledgePage=Math.max(0,currentKnowledgePage-1);renderKnowledge();});$('knowledge-page-next').addEventListener('click',()=>{currentKnowledgePage++;renderKnowledge();});$('knowledge-import').addEventListener('change',e=>importKnowledge(e.target));$('knowledge-evidence').addEventListener('click',previewLocalEvidence);$('knowledge-insert-evidence').addEventListener('click',insertLocalEvidence);$('knowledge-export').addEventListener('click',()=>download('mm-knowledge.json',exportNoteArchive(state.notes)));$('knowledge-delete').addEventListener('click',()=>{if(!activeNote||activeNote.type!=='note')return toast('Select a saved note to delete.',true);if(!confirm(`Delete note ${activeNote.title}?`))return;state.notes=state.notes.filter(n=>n.id!==activeNote.id);if(editingNoteId===activeNote.id)cancelNoteEdit();activeNote=null;$('knowledge-preview').textContent='Choose a search result.';renderKnowledge();saveSoon();});$('knowledge-to-chat').addEventListener('click',()=>{activeNote=resolveActiveKnowledge();if(!activeNote)return toast('Select a current note or project file first.',true);$('chat-input').value=`Use the following local reference (${activeNote.title}):\n${activeNote.content.slice(0,9000)}`;$('chat-counter').textContent=$('chat-input').value.length+' / 10,000';selectView('chat');});
$('accent-select').addEventListener('change',e=>{state.preferences.accent=e.target.value;document.body.dataset.accent=e.target.value;saveSoon()});$('compact-toggle').addEventListener('change',e=>{state.preferences.compact=e.target.checked;document.body.classList.toggle('compact',e.target.checked);saveSoon()});$('backup-all').addEventListener('click',exportAll);$('restore-all').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';importAll(file)});$('reset-all').addEventListener('click',async()=>{if(!confirm('Reset projects, notes, chat and audit? API keys remain encrypted in the separate vault.'))return;if(!confirm('This removes the saved workspace from this browser. Confirm?'))return;try{await replaceWorkspace(freshState());toast('Application data reset and saved.');}catch(e){toast('Reset was not applied: '+errorText(e),true);}});$('recovery-backup').addEventListener('click',()=>{if(store.recoveryRaw!==null)download('mm-unreadable-'+(store.recoveryKind||'state')+'-backup.txt',store.recoveryRaw,'text/plain');});$('recovery-reset').addEventListener('click',async()=>{if(store.recoveryRaw===null)return;if(!confirm('Reset this unreadable saved record? Download its raw backup first.'))return;try{await replaceWorkspace(freshState());if(store.recoveryKind==='legacy')localStorage.removeItem('mm-platform-browser-b01');store.setRecovery(null,null);renderSettings();toast('Unreadable saved data replaced and saved; new workspace initialized.');}catch(e){toast('Reset failed: '+errorText(e),true);}});$('cache-refresh').addEventListener('click',refreshOfflineCache);}
async function boot(){try{const storageSpan=workshopMetrics.begin('storage-check');let stored;try{stored=await read('state.v1');workshopMetrics.finish(storageSpan,'ok');}catch(e){workshopMetrics.finish(storageSpan,'error','storage-error');throw e;}if(stored!==null){if(!(await store.adoptStoredWorkspace(stored))){store.setRecovery(JSON.stringify(stored),'state');store.setStorageFailed(true);state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:null,lastSeenEntityRevision:null});toast('Unreadable B0.3 state detected. Original data preserved; use Settings → Recovery before saving.',true);}}else{let legacy=null;let raw=null;try{raw=localStorage.getItem('mm-platform-browser-b01');if(raw)legacy=JSON.parse(raw);}catch{store.setRecovery(raw,'legacy');}if(legacy){try{state=migrateLegacy(legacy);}catch{store.setRecovery(raw,'legacy');}}if(!state)state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:0,lastEntityJson:store.snapshotEntityJson(state)});await write('state.v1',state);try{await migrateToEntities(read,write,state);store.setRevisionBookkeeping({lastSeenEntityRevision:state.revision});}catch{}if(store.recoveryRaw)toast('Legacy project unreadable: raw bytes preserved. Open Settings → Recovery.',true);}openCrossTabChannel();}catch(e){state=freshState();state.revision=0;store.setRevisionBookkeeping({lastSeenRevision:null,lastSeenEntityRevision:null,lastEntityJson:{}});store.setStorageFailed(true);toast('Browser storage unavailable. Export your work frequently: '+errorText(e),true);}
$('key-provider').replaceChildren(...PROVIDERS.map(p=>new Option(p.name,p.id)));$('key-model').value=PROVIDERS[0].model;
run=new RuntimeRunner(document.body,(active,lang)=>{$('stop-code').disabled=!active;$('runner-status').textContent=active?'Running '+lang:'Idle';});run.onStop=msg=>{if(lastRunLang==='python'&&pythonRuntimeStatus.startsWith('RUNNING'))pythonRuntimeStatus=msg.includes('timed out')?'TIMED OUT THIS SESSION':'STOPPED THIS SESSION';finishCodeMetric(msg.includes('timed out')?'timeout':msg.includes('Output flood')?'error':'cancelled',msg.includes('timed out')?'time-limit':msg.includes('Output flood')?'output-limit':'user-stop');printConsole(msg);};
$('workflow-stages').value=FLOW_TEMPLATES.research.join('\n');wire();setupWasmImport({el,toast});setupExpressionRepl({el,toast});labs=setupLabs({el,toast,download,metrics:workshopMetrics,getDatasets:()=>state.datasets||[],commitDatasets:async(next)=>{if(store.isStorageFailed)throw Error('Local storage is in recovery mode; export a backup first.');const previous=state.datasets;state.datasets=next;try{await saveNow();}catch(e){state.datasets=previous;throw e;}}});document.body.dataset.accent=state.preferences?.accent||'cyan';document.body.classList.toggle('compact',!!state.preferences?.compact);const relBuild=optionalControl('release-build');if(relBuild)relBuild.textContent=VERSION;renderAll();$('save-indicator').textContent=store.isStorageFailed?'Save failed — export a backup':savedStatus();const initial=location.hash.slice(1);selectView(VIEWS[initial]?initial:'overview');if('serviceWorker' in navigator && location.protocol!=='file:'){void Promise.resolve().then(()=>navigator.serviceWorker.register('./sw.js',{scope:'./'})).catch(e=>console.warn('Offline shell unavailable:',e?.message||'registration failed'));}if(bootMissingControls.size){document.documentElement.dataset.mmBoot='degraded';toast('Interface files may be out of sync. Missing controls: '+[...bootMissingControls].join(', ')+'. Reload after refreshing the offline cache.',true);}else document.documentElement.dataset.mmBoot='ready';workshopMetrics.finish(bootTrace,bootMissingControls.size?'warning':'ok',bootMissingControls.size?'invalid-input':'none');}
boot().catch(e=>{workshopMetrics.finish(bootTrace,'error','uncaught-error');document.documentElement.dataset.mmBoot='failed';console.error('Initialization error',e);toast('Initialization error: '+errorText(e),true)});
