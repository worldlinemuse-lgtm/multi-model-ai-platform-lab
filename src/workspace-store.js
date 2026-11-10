// Workspace persistence, extracted from main.js (Stage 4b group 2).
// Wired into main.js and shipped in the lab (commit 84b2d2c); main.js
// keeps one-line shims (saveSoon/saveNow/audit/replaceWorkspace) and
// the store owns all persistence bookkeeping. Verified by
// tests/workspace-store.test.mjs against fake storage.
//
// The store owns all persistence bookkeeping in closure (revisions,
// cross-tab flags, save timer, recovery state) and takes everything else
// through one explicit context object, so no module reaches back into
// main.js globals. Function bodies are copied verbatim from main.js with
// global references replaced by closure/ctx references only.
import {MANIFEST_KEY,ENTITY_KEYS,entityKey,splitState,migrateToEntities,loadEntityState} from './entity-store.js';
import {CROSS_TAB_CHANNEL,revisionOf,isCrossTabConflict,nextRevision,crossTabConflictMessage} from './cross-tab.js';
import {MAX_AUDIT,uid,now,validateState} from './core.js';
import {auditTraceFields} from './request-trace.js';
import {el} from './dom-helpers.js';

export function createWorkspaceStore(ctx){
 let lastSeenRevision=null,lastSeenEntityRevision=null,lastEntityJson={};
 let crossTabStale=false,crossTabBackupDone=false,storageFailed=false;
 let saveTimer=null,recoveryRaw=null,recoveryKind=null;
 let saveChain=Promise.resolve();
 const {read,write}=ctx;
 function setSaveIndicator(text){const ind=el('save-indicator');if(ind)ind.textContent=text;}
 function snapshotEntityJson(next){const out={};for(const name of ENTITY_KEYS)out[name]=JSON.stringify(next[name]);return out;}
 async function writeEntityRecords(next){const split=splitState(next);for(const name of ENTITY_KEYS){const json=JSON.stringify(split.records[name].value);if(lastEntityJson[name]!==json){await write(entityKey(name),split.records[name]);lastEntityJson[name]=json;}}await write(MANIFEST_KEY,split.manifest);lastSeenEntityRevision=split.manifest.revision;}
 async function adoptStoredWorkspace(stored){
  let entityLoaded=null,entityManifest=null,entityError=null;
  try{const loaded=await loadEntityState(read);if(loaded){entityLoaded=loaded.state;entityManifest=loaded.manifest;}}catch(e){entityError=e;}
  if(validateState(stored)){
   // Stored states that predate saved datasets carry no datasets list.
   // validateState allows the missing list, but splitState cannot save
   // it — every later save failed with "not serializable: datasets"
   // (2026-11-08). Fill it here, before the state goes live, so the
   // first save after load succeeds and the migration can run.
   if(stored.datasets===undefined)stored.datasets=[];
   if(entityLoaded&&entityLoaded.revision>revisionOf(stored)){ctx.setState(entityLoaded);lastSeenRevision=entityLoaded.revision;lastSeenEntityRevision=entityManifest.revision;lastEntityJson=snapshotEntityJson(ctx.getState());return true;}
   ctx.setState(stored);lastSeenRevision=revisionOf(stored);ctx.getState().revision=lastSeenRevision;lastEntityJson=snapshotEntityJson(ctx.getState());
   try{await migrateToEntities(read,write,ctx.getState());lastSeenEntityRevision=ctx.getState().revision;}catch{}
   if(entityError)ctx.toast('Entity storage could not be loaded ('+ctx.errorText(entityError)+'); restored from whole-workspace backup.',true);
   return true;
  }
  if(entityLoaded){ctx.setState(entityLoaded);lastSeenRevision=entityLoaded.revision;lastSeenEntityRevision=entityManifest.revision;lastEntityJson=snapshotEntityJson(ctx.getState());ctx.toast('Whole-workspace record unreadable; workspace restored from entity records.',true);return true;}
  return false;
 }
 async function writeStateCheckedInner(){if(crossTabStale){const err=Error('Cross-tab conflict: this tab is stale; another tab saved a newer workspace.');err.crossTab=true;throw err;}const stored=await read('state.v1');const manifest=await read(MANIFEST_KEY).catch(()=>null);const entityConflict=manifest!==null&&(lastSeenEntityRevision===null||manifest.revision!==lastSeenEntityRevision);if(isCrossTabConflict(stored,lastSeenRevision)||entityConflict){crossTabStale=true;if(!crossTabBackupDone){crossTabBackupDone=true;try{ctx.exportAll();}catch{}}const ind=el('save-indicator');if(ind)ind.textContent='Not saved — another tab saved a newer workspace';ctx.toast('Another tab saved a newer workspace. This tab did not overwrite it; a backup of this tab was exported. Reload to load the newer workspace.',true);const err=Error(entityConflict&&!isCrossTabConflict(stored,lastSeenRevision)?`Cross-tab conflict: stored entity manifest revision ${manifest.revision} differs from this tab's last seen entity revision ${lastSeenEntityRevision}.`:crossTabConflictMessage(stored,lastSeenRevision));err.crossTab=true;throw err;}const state=ctx.getState();state.revision=Math.max(nextRevision(lastSeenRevision,stored),(manifest?.revision??0)+1);await writeEntityRecords(state);await write('state.v1',state);lastSeenRevision=state.revision;ctx.broadcast();}
 // Checked writes run one at a time, in call order. A debounced saveSoon
 // that fires while a provider call is still in flight used to overlap
 // the final saveNow: the overlap corrupted the revision bookkeeping
 // (spurious cross-tab throw on the same tab) or let the earlier
 // pre-response snapshot commit last, losing the response from storage
 // (2026-11-06, CI run 42215709359). Serializing keeps the later
 // invocation's stored-state read and write strictly after the earlier
 // one completes, so same-tab saves can no longer trip the guard or
 // clobber each other; genuine other-tab conflicts still trip it.
 function writeStateChecked(){const run=saveChain.then(writeStateCheckedInner);saveChain=run.catch(()=>{});return run;}
 function saveSoon(){if(storageFailed||crossTabStale)return;clearTimeout(saveTimer);const status=el('save-indicator');if(status)status.textContent='Saving…';saveTimer=setTimeout(async()=>{const span=ctx.metrics.begin('save');try{await writeStateChecked();ctx.metrics.finish(span,'ok');if(status)status.textContent=ctx.savedStatus();}catch(e){ctx.metrics.finish(span,'error','storage-error');if(e.crossTab){if(status)status.textContent='Not saved — another tab saved a newer workspace';return;}storageFailed=true;if(status)status.textContent='Save failed — export a backup';ctx.toast('Local storage failed: '+ctx.errorText(e),true);}},300);}
 async function saveNow(){if(recoveryKind==='state'&&recoveryRaw!==null)throw Error('Stored workspace requires recovery; original data will not be overwritten.');if(crossTabStale){const err=Error('Cross-tab conflict: this tab is stale; another tab saved a newer workspace.');err.crossTab=true;throw err;}clearTimeout(saveTimer);const span=ctx.metrics.begin('save');try{await writeStateChecked();ctx.metrics.finish(span,'ok');storageFailed=false;setSaveIndicator(ctx.savedStatus());}catch(e){ctx.metrics.finish(span,'error','storage-error');if(e.crossTab){setSaveIndicator('Not saved — another tab saved a newer workspace');throw e;}storageFailed=true;setSaveIndicator('Save failed — export a backup');ctx.toast('Save failed: '+ctx.errorText(e),true);throw e;}}
 async function replaceWorkspace(next){if(!validateState(next))throw Error('Invalid workspace replacement');clearTimeout(saveTimer);const stored=await read('state.v1').catch(()=>null);const manifest=await read(MANIFEST_KEY).catch(()=>null);next.revision=Math.max(nextRevision(lastSeenRevision,stored),(manifest?.revision??0)+1);await writeEntityRecords(next);await write('state.v1',next);ctx.setState(next);lastSeenRevision=next.revision;crossTabStale=false;crossTabBackupDone=false;ctx.broadcast();ctx.clearActiveNote();storageFailed=false;recoveryRaw=null;recoveryKind=null;setSaveIndicator(ctx.savedStatus());ctx.renderAll();}
 function audit(op,provider,status,usage,metadata={}){const state=ctx.getState();state.audit.unshift({id:uid('event'),at:now(),op,provider,status,usage:usage?{prompt_tokens:usage.prompt_tokens??null,completion_tokens:usage.completion_tokens??null,total_tokens:usage.total_tokens??null,source:usage.source||'unknown'}:null,...auditTraceFields(metadata)});state.audit=state.audit.slice(0,MAX_AUDIT);saveSoon();ctx.renderAudit();ctx.renderStats();}
 return {
  snapshotEntityJson,writeEntityRecords,adoptStoredWorkspace,writeStateChecked,
  saveSoon,saveNow,replaceWorkspace,audit,
  get lastSeenRevision(){return lastSeenRevision;},
  get lastSeenEntityRevision(){return lastSeenEntityRevision;},
  get isCrossTabStale(){return crossTabStale;},
  get isStorageFailed(){return storageFailed;},
  get recoveryRaw(){return recoveryRaw;},
  get recoveryKind(){return recoveryKind;},
  setRecovery(raw,kind){recoveryRaw=raw;recoveryKind=kind;},
  setStorageFailed(v){storageFailed=!!v;},
  setRevisionBookkeeping(patch){
   if('lastSeenRevision' in patch)lastSeenRevision=patch.lastSeenRevision;
   if('lastSeenEntityRevision' in patch)lastSeenEntityRevision=patch.lastSeenEntityRevision;
   if('lastEntityJson' in patch)lastEntityJson=patch.lastEntityJson;
  }
 };
}
export {CROSS_TAB_CHANNEL};
