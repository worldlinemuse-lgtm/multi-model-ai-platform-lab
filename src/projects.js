// Projects, files, snapshots and workspace import/export, extracted from
// main.js (Stage 4b group 3). Wired into main.js 2026-11-05: main.js keeps
// one-line shims for project()/renderFiles() and the widely-called helpers;
// the wire() handlers call the module directly. Function bodies were copied
// verbatim from main.js with global references replaced by closure/ctx
// references only.
import {MAX_FILES,MAX_PROJECT_BYTES,clone,uid,now,safeName,safeFiles,starterProject} from './core.js';
import {projectFolders,projectTreeEntries,moveProjectFolder,copyProjectFolder} from './project-files.js';
import {zipFiles,unzipFiles} from './zip.js';
import {binaryRecord,decodeBinaryRecord,validateBinaryAssets,exportBinaryBytes,BINARY_TYPES,MAX_BINARY_FILE_BYTES} from './binary-assets.js';
import {stripTopLevelFolder,pickEntryFile,fetchGitHubRepo} from './github-import.js';
import {prepareTextEdit,applyTextEdit,rollbackTextEdit} from './review-edits.js';
import {compareProjectFiles} from './snapshot-diff.js';
import {$,make,clearNode,formatTime,errorText} from './dom-helpers.js';

export function createProjects(ctx){
 let selectedBinaryName=null,selectedBinaryProjectId=null,binaryPreviewURL=null;
 let q04Pending=null,q04PendingProjectId=null,q04PendingPath=null,q04Rollback=null,q04RollbackProjectId=null;
 const state=()=>ctx.getState();
 function project(){return state().projects.find(p=>p.id===state().activeProjectId)||state().projects[0];}
 function renderProjectSelector(){const select=$('project-select'),old=select.value;select.replaceChildren();for(const p of state().projects){const option=new Option(p.name,p.id);select.add(option);}select.value=state().activeProjectId;const snaps=$('snapshot-select'),prior=snaps.value;snaps.replaceChildren(new Option('Choose snapshot…',''));state().snapshots.filter(s=>s.project.id===state().activeProjectId).slice().reverse().forEach(s=>snaps.add(new Option(`${s.pinned?'📌 ':''}${s.label} · ${formatTime(s.at)}`,s.id)));if([...snaps.options].some(o=>o.value===prior))snaps.value=prior;renderSnapshotActions();}
 function revokeBinaryAssetURL(){
  if(binaryPreviewURL){URL.revokeObjectURL(binaryPreviewURL);binaryPreviewURL=null;}
 }
 function renderBinaryAssets(){
  const p=project(),assets=p.binaryAssets||{},host=clearNode($('binary-assets-list')),preview=$('binary-asset-preview');
  if(selectedBinaryProjectId!==p.id||!Object.hasOwn(assets,selectedBinaryName||'')){
   selectedBinaryName=null;selectedBinaryProjectId=p.id;revokeBinaryAssetURL();
  }
  const names=Object.keys(assets).sort((a,b)=>a.localeCompare(b));
  for(const name of names){
   const rec=assets[name],button=make('button','history-entry'+(name===selectedBinaryName?' active':''),name+' · '+rec.bytes+' B · '+rec.mime);
   button.type='button';button.addEventListener('click',()=>{selectedBinaryName=name;selectedBinaryProjectId=p.id;renderBinaryAssets();});
   host.append(button);
  }
  if(!names.length)host.append(make('p','hint-line','No binary assets stored in this project.'));
  $('binary-asset-delete').disabled=!selectedBinaryName;
  if(!selectedBinaryName){preview.textContent='Choose a local image/audio file to preview.';return;}
  try{
   const rec=assets[selectedBinaryName],raw=decodeBinaryRecord(selectedBinaryName,rec);
   revokeBinaryAssetURL();
   binaryPreviewURL=URL.createObjectURL(new Blob([raw],{type:rec.mime}));
   const media=make(rec.mime.startsWith('image/')?'img':'audio');
   media.src=binaryPreviewURL;
   media.setAttribute('aria-label','Local media preview: '+selectedBinaryName);
   if(rec.mime.startsWith('image/')){media.alt=selectedBinaryName;media.style.maxWidth='100%';media.style.maxHeight='260px';}
   else media.controls=true;
   preview.replaceChildren(make('p','',selectedBinaryName+' · '+rec.mime),media);
  }catch(error){revokeBinaryAssetURL();preview.textContent='Preview rejected: '+errorText(error);}
 }
 async function importBinaryAssets(input){
  const chosen=Array.from(input.files||[]);input.value='';
  if(!chosen.length)return;
  const span=ctx.metrics.begin('project-import');
  const p=project(),previous=p.binaryAssets||{},next={...previous};
  try{
   if(chosen.length>8)throw Error('Select at most eight media files at once.');
   for(const file of chosen){
    if(file.size>MAX_BINARY_FILE_BYTES||file.size<4)throw Error(file.name+': 400 KB limit or empty file.');
    if(!safeName(file.name)||Object.hasOwn(p.files,file.name)||Object.hasOwn(next,file.name))throw Error(file.name+': invalid name or collision.');
    next[file.name]=binaryRecord(file.name,await file.arrayBuffer());
   }
   if(!validateBinaryAssets(next,p.files))throw Error('Project media total exceeds 1.25 MB or eight assets.');
   p.binaryAssets=next;p.updated=now();
   try{await ctx.saveNow();}catch(error){p.binaryAssets=previous;throw error;}
   selectedBinaryName=chosen.at(-1).name;selectedBinaryProjectId=p.id;renderBinaryAssets();
   ctx.metrics.finish(span,'ok');
   ctx.toast(chosen.length+' local media asset(s) saved. No files uploaded.');
  }catch(error){ctx.metrics.finish(span,'error','invalid-input');ctx.toast('Binary import rejected: '+errorText(error),true);}
 }
 async function removeBinaryAsset(){
  const p=project(),name=selectedBinaryName;if(!name||!Object.hasOwn(p.binaryAssets||{},name))return;
  if(!confirm('Remove the locally saved asset '+name+' from this project? Export a project backup first if necessary.'))return;
  const previous=p.binaryAssets,updated={...previous};delete updated[name];
  p.binaryAssets=updated;p.updated=now();
  try{await ctx.saveNow();selectedBinaryName=null;revokeBinaryAssetURL();renderBinaryAssets();ctx.toast('Local media asset removed.');}
  catch(error){p.binaryAssets=previous;ctx.toast('Media removal not saved: '+errorText(error),true);}
 }
 function projectZip(){const p=project();return zipFiles({...p.files,...exportBinaryBytes(p.binaryAssets||{})});}
 function renderFiles(){renderProjectSelector();const p=project();const tree=clearNode($('file-tree'));for(const entry of projectTreeEntries(p.files)){if(entry.type==='folder'){const heading=make('div','folder-entry','📁 '+entry.path.split('/').at(-1));heading.title=entry.path;heading.style.paddingLeft=Math.min(11+entry.depth*14,60)+'px';tree.append(heading);continue;}const name=entry.path;const button=make('button','file-entry'+(name===p.active?' active':''),`${name.toLowerCase().endsWith('.py')?'🐍':name.toLowerCase().endsWith('.html')?'◇':name.toLowerCase().endsWith('.css')?'▥':'▤'} ${name.split('/').at(-1)}`);button.type='button';button.title=name;button.style.paddingLeft=Math.min(11+entry.depth*14,60)+'px';button.addEventListener('click',()=>{p.active=name;renderFiles();ctx.saveSoon()});tree.append(button);}const editor=$('code-editor');if(editor.value!==p.files[p.active])editor.value=p.files[p.active]||'';$('active-file').textContent=p.active;renderGutter();ctx.renderStats();q04SyncButtons();renderBinaryAssets();}
 function renderGutter(){const editor=$('code-editor');const lines=Math.min(2500,editor.value.split('\n').length);$('line-gutter').textContent=Array.from({length:lines},(_,i)=>i+1).join('\n');}
 function editFile(){const p=project(),prior=p.files[p.active];p.files[p.active]=$('code-editor').value;if(!safeFiles(p.files)){p.files[p.active]=prior;$('code-editor').value=prior;ctx.toast(`Project limit: ${MAX_FILES} files and ${MAX_PROJECT_BYTES} total characters.`,true);return;}p.updated=now();renderGutter();ctx.saveSoon();ctx.renderStats();}
 function q04SyncButtons(){
  const p=project();
  $('q04-accept').disabled=!q04Pending||q04PendingProjectId!==p.id||q04PendingPath!==p.active;
  $('q04-rollback').disabled=!q04Rollback||q04RollbackProjectId!==p.id;
 }
 function q04PreviewEdit(){
  const p=project();
  try{
   q04Pending=prepareTextEdit(p.files,p.active,$('q04-proposal').value);
   q04PendingProjectId=p.id;q04PendingPath=p.active;
   $('q04-diff').textContent=q04Pending.preview;
   $('q04-diff').hidden=false;
   q04SyncButtons();ctx.toast('Review the exact line diff before accepting. No file has changed.');
  }catch(error){q04Pending=null;$('q04-diff').textContent='Preview unavailable: '+errorText(error);$('q04-diff').hidden=false;q04SyncButtons();ctx.toast('Edit preview rejected: '+errorText(error),true);}
 }
 function q04AcceptEdit(){
  const p=project();
  if(!q04Pending||q04PendingProjectId!==p.id||q04PendingPath!==p.active)return ctx.toast('Prepare a new edit preview for this file.',true);
  if(!confirm('Apply the reviewed replacement to '+p.active+'? The current project will be changed and saved locally.'))return;
  try{
   const result=applyTextEdit(p.files,q04Pending,{confirmed:true});
   p.files=result.files;p.updated=now();q04Rollback=result.rollback;q04RollbackProjectId=p.id;
   q04Pending=null;q04PendingProjectId=null;q04PendingPath=null;
   renderFiles();ctx.saveSoon();ctx.toast('Reviewed edit applied locally. Rollback remains available until the project changes.');
  }catch(error){q04Pending=null;q04SyncButtons();ctx.toast('Edit not applied: '+errorText(error),true);}
 }
 function q04RollbackEdit(){
  const p=project();
  if(!q04Rollback||q04RollbackProjectId!==p.id)return ctx.toast('No applicable rollback token for this project.',true);
  if(!confirm('Rollback the last accepted reviewed edit? This will replace the current project files only if no intervening edits occurred.'))return;
  try{
   const result=rollbackTextEdit(p.files,q04Rollback,{confirmed:true});
   p.files=result.files;p.updated=now();q04Rollback=null;q04RollbackProjectId=null;
   renderFiles();ctx.saveSoon();ctx.toast('Reviewed edit rolled back locally.');
  }catch(error){q04Rollback=null;q04RollbackProjectId=null;q04SyncButtons();ctx.toast('Rollback rejected: '+errorText(error),true);}
 }
 function createProject(){if(state().projects.length>=30)return ctx.toast('Maximum 30 projects.',true);const name=prompt('Project name:','Untitled project');if(!name)return;const p=starterProject(name.slice(0,90));state().projects.push(p);state().activeProjectId=p.id;renderFiles();ctx.saveSoon();ctx.toast('Project created.');}
 function renameProject(){const p=project();const name=prompt('Rename project:',p.name);if(!name)return;p.name=name.slice(0,90);renderProjectSelector();ctx.renderStats();ctx.saveSoon();}
 function deleteProject(){if(state().projects.length<=1)return ctx.toast('Keep at least one project.',true);const p=project();if(!confirm(`Delete project "${p.name}" from this browser? Export a backup first if needed.`))return;state().projects=state().projects.filter(x=>x.id!==p.id);state().activeProjectId=state().projects[0].id;renderFiles();ctx.saveSoon();}
 function newFile(){const p=project();const name=prompt('New file name (folders can be included, e.g. src/utils.js):');if(name===null)return;if(!safeName(name)||Object.hasOwn(p.files,name)||Object.hasOwn(p.binaryAssets||{},name)||Object.keys(p.files).length>=MAX_FILES)return ctx.toast('Invalid, duplicate, or excessive filename.',true);p.files[name]='';p.active=name;renderFiles();ctx.saveSoon();$('code-editor').focus();}
 function renameFile(){const p=project();const name=prompt('Rename file:',p.active);if(!name||name===p.active)return;if(!safeName(name)||Object.hasOwn(p.files,name)||Object.hasOwn(p.binaryAssets||{},name))return ctx.toast('Invalid or duplicate filename.',true);const result={};for(const [file,text] of Object.entries(p.files))result[file===p.active?name:file]=text;p.files=result;p.active=name;renderFiles();ctx.saveSoon();}
 function copyFolder(){
  const p=project(),folders=projectFolders(p.files);
  if(!folders.length)return ctx.toast('This project has no nested folders yet.',true);
  const from=prompt('Folder to copy (available: '+folders.join(', ')+'):',p.active.includes('/')?p.active.slice(0,p.active.lastIndexOf('/')):folders[0]);
  if(from===null)return;
  const to=prompt('Copy all files under "'+from+'" to which NEW relative folder path?');
  if(to===null)return;
  try{
   const result=copyProjectFolder(p.files,p.active,from.trim(),to.trim());
   if(!validateBinaryAssets(p.binaryAssets||{},result.files))throw Error('Folder copy destination collides with saved media asset.');
   if(!confirm('Copy '+result.copied.length+' file(s) into "'+to.trim()+'"? Existing files will remain and will never be overwritten.'))return;
   p.files=result.files;p.updated=now();renderFiles();ctx.saveSoon();
   ctx.toast('Copied '+result.copied.length+' virtual project files.');
  }catch(error){ctx.toast('Folder copy rejected: '+error.message,true);}
 }
 function moveFolder(){
  const p=project(),folders=projectFolders(p.files);if(!folders.length)return ctx.toast('This project has no nested folders yet.',true);
  const suggested=p.active.includes('/')?p.active.slice(0,p.active.lastIndexOf('/')):folders[0];
  const from=prompt('Folder to move (available: '+folders.join(', ')+'):',suggested);if(from===null)return;
  const to=prompt('Move all files in "'+from+'" to which relative folder path? (e.g. src/lib):');if(to===null)return;
  try{const result=moveProjectFolder(p.files,p.active,from.trim(),to.trim());
  if(!validateBinaryAssets(p.binaryAssets||{},result.files))throw Error('Folder move destination collides with saved media asset.');
  if(!confirm('Move '+result.moved.length+' file(s) from "'+from.trim()+'" into "'+to.trim()+'"? Existing files will not be overwritten.'))return;
  p.files=result.files;p.active=result.active;p.updated=now();renderFiles();ctx.saveSoon();ctx.toast('Moved '+result.moved.length+' project file(s).');
  }catch(error){ctx.toast('Folder move rejected: '+error.message,true);}
 }
 function deleteFile(){const p=project();if(Object.keys(p.files).length===1)return ctx.toast('A project needs at least one file.',true);if(!confirm(`Delete ${p.active}?`))return;delete p.files[p.active];p.active=Object.keys(p.files)[0];renderFiles();ctx.saveSoon();}
 function snapshot(){const span=ctx.metrics.begin('snapshot');const p=project();const input=prompt('Snapshot label:','Checkpoint');if(input===null){ctx.metrics.finish(span,'cancelled','user-stop');return;}const label=input.trim().slice(0,60);if(!label){ctx.metrics.finish(span,'cancelled','invalid-input');return ctx.toast('Snapshot needs a label.',true);}
  if(state().snapshots.length>=100){const oldest=state().snapshots.findIndex(s=>!s.pinned);if(oldest<0){ctx.metrics.finish(span,'cancelled','resource-limit');return ctx.toast('All 100 snapshots are pinned. Unpin or delete one first.',true);}if(!confirm('Snapshot storage is full. Replace the oldest unpinned snapshot "'+state().snapshots[oldest].label+'"? Export it first if needed.')){ctx.metrics.finish(span,'cancelled','user-stop');return;}state().snapshots.splice(oldest,1);}
  const cloned=clone(p);if(!cloned){ctx.metrics.finish(span,'error','clone-failed');return ctx.toast('Snapshot failed: project data could not be copied.',true);}
  const record={id:uid('snapshot'),at:now(),label,project:cloned,pinned:false};
  state().snapshots.push(record);renderProjectSelector();$('snapshot-select').value=record.id;renderSnapshotActions();ctx.saveSoon();ctx.metrics.finish(span,'ok');ctx.toast('Snapshot saved locally.');
 }
 function selectedSnapshot(){return state().snapshots.find(s=>s.id===$('snapshot-select').value&&s.project.id===state().activeProjectId)||null;}
 function renderSnapshotActions(){const selected=selectedSnapshot();$('restore-snapshot').disabled=!selected;$('snapshot-action-run').disabled=!selected;const pin=$('snapshot-action').querySelector('option[value="pin"]');if(pin)pin.textContent=selected?.pinned?'Unpin snapshot':'Pin snapshot';}
 function manageSnapshot(){
  const snap=selectedSnapshot();if(!snap)return ctx.toast('Select a saved snapshot first.',true);
  const action=$('snapshot-action').value;
  if(action==='rename'){const entered=prompt('Rename selected snapshot:',snap.label);if(entered===null)return;const name=entered.trim().slice(0,60);if(!name)return ctx.toast('Snapshot label cannot be blank.',true);snap.label=name;renderProjectSelector();ctx.saveSoon();ctx.toast('Snapshot renamed.');return;}
  if(action==='export'){tracedExport(()=>{const payload={format:'mm-platform-snapshot-v1',name:snap.project.name,active:snap.project.active,files:snap.project.files,snapshot:{label:snap.label,at:snap.at},...(snap.project.binaryAssets?{binaryAssets:snap.project.binaryAssets}:{})};download('snapshot-'+snap.label.replace(/[^a-z0-9_-]/gi,'_')+'.json',JSON.stringify(payload,null,2),'application/json');});ctx.toast('Snapshot exported as an importable project.');return;}
  if(action==='pin'){snap.pinned=!snap.pinned;renderProjectSelector();ctx.saveSoon();ctx.toast(snap.pinned?'Snapshot protected from automatic eviction.':'Snapshot unpinned.');return;}
  if(action==='delete'){if(!confirm('Permanently delete snapshot "'+snap.label+'"? This does not delete your current project.'))return;state().snapshots=state().snapshots.filter(s=>s.id!==snap.id);$('snapshot-select').value='';renderProjectSelector();$('snapshot-comparison').hidden=true;ctx.saveSoon();ctx.toast('Snapshot deleted.');return;}
  if(action==='compare'){
  const report=compareProjectFiles(snap.project.files,project().files);
  $('snapshot-comparison').textContent='Comparison with snapshot: '+snap.label+'\n\n'+report.summary+'\n\n'+report.details;
  $('snapshot-comparison').hidden=false;ctx.toast('Snapshot comparison ready (read-only).');}
 }
 function restoreSnapshot(){const span=ctx.metrics.begin('snapshot');const s=state().snapshots.find(x=>x.id===$('snapshot-select').value);if(!s){ctx.metrics.finish(span,'cancelled','invalid-input');return ctx.toast('Select a snapshot first.',true);}if(!confirm('Replace your current project files with this snapshot?')){ctx.metrics.finish(span,'cancelled','user-stop');return;}const idx=state().projects.findIndex(p=>p.id===state().activeProjectId);const restored=clone(s.project);if(!restored||idx<0){ctx.metrics.finish(span,'error','restore-failed');return ctx.toast('Restore failed: snapshot data is damaged.',true);}state().projects[idx]=restored;renderFiles();ctx.saveSoon();ctx.metrics.finish(span,'ok');ctx.toast('Snapshot restored.');}
 function download(name,data,type='application/json'){const blob=data instanceof Blob?data:new Blob([data],{type});const url=URL.createObjectURL(blob);const a=make('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
 function tracedExport(fn){const span=ctx.metrics.begin('project-export');try{fn();ctx.metrics.finish(span,'ok');}catch(e){ctx.metrics.finish(span,'error','invalid-input');throw e;}}
 function projectJSON(){const p=project();return JSON.stringify({format:p.binaryAssets&&Object.keys(p.binaryAssets).length?'mm-platform-binary-v1':'mm-platform-b01',active:p.active,files:p.files,...(p.binaryAssets?{binaryAssets:p.binaryAssets}:{})},null,2);}
 async function importProject(file){
  if(!file||file.size>10_000_000)return ctx.toast('Import file must be under 10 MB.',true);
  const span=ctx.metrics.begin('project-import');
  try{
   let files,active,binaryAssets={},name=file.name.replace(/\.(zip|json)$/i,'');
   if(file.name.toLowerCase().endsWith('.zip')){
    const unpacked=await unzipFiles(await file.arrayBuffer(),{maxEntries:128,maxBytes:2_500_000,binaryExtensions:Object.keys(BINARY_TYPES)});
    files={};
    for(const [filename,value]of Object.entries(unpacked)){
     if(value instanceof Uint8Array)binaryAssets[filename]=binaryRecord(filename,value);
     else files[filename]=value;
    }
    // GitHub ZIPs wrap everything in one repo-branch/ folder; strip it so
    // index.html lands at the root. Other layouts pass through unchanged.
    const strippedFiles=stripTopLevelFolder(files),strippedBinary=stripTopLevelFolder(binaryAssets);
    files=strippedFiles;binaryAssets=strippedBinary;
    active=pickEntryFile(files);
   }else{
    const payload=JSON.parse(await file.text());
    if(!payload||!['mm-platform-b01','mm-platform-binary-v1'].includes(payload.format)||!payload.files||!payload.active)throw Error('Not a supported project JSON format');
    files=payload.files;active=payload.active;binaryAssets=payload.binaryAssets||{};
   }
   if(!safeFiles(files)||!Object.hasOwn(files,active)||!validateBinaryAssets(binaryAssets,files))throw Error('Project contains unsafe text or binary files, names or sizes.');
   if(state().projects.length>=30)throw Error('Project limit reached');
   if(!confirm('Import '+Object.keys(files).length+' text and '+Object.keys(binaryAssets).length+' bounded media files as a new project?'))return;
   const p={id:uid('project'),name:name.slice(0,90),active,files,binaryAssets,updated:now()};
   state().projects.push(p);state().activeProjectId=p.id;
   try{await ctx.saveNow();}catch(error){state().projects.pop();state().activeProjectId=state().projects[0].id;throw error;}
   selectedBinaryName=null;renderFiles();ctx.metrics.finish(span,'ok');ctx.toast('Imported local project with validated media.');
   ctx.onImported?.();
  }catch(error){ctx.metrics.finish(span,'error','invalid-input');ctx.toast('Import rejected: '+errorText(error),true);}
 }
 async function importGitHubRepo(rawUrl){
  const url=String(rawUrl||'').trim();
  if(!url)return ctx.toast('Paste a GitHub repo link first, like https://github.com/owner/repo.',true);
  const span=ctx.metrics.begin('project-import');
  try{
   const fetched=await fetchGitHubRepo(url,{fetchImpl:fetch});
   if(state().projects.length>=30)throw Error('Project limit reached');
   const skippedNote=fetched.skipped.length?` ${fetched.skipped.length} file(s) left out: `+fetched.skipped.map(s=>s.path+' ('+s.reason+')').join('; '):'';
   if(!confirm('Open "'+fetched.name+'" from GitHub as a new project — '+Object.keys(fetched.files).length+' text and '+Object.keys(fetched.binaryAssets).length+' media files?'+skippedNote))return;
   const p={id:uid('project'),name:fetched.name.slice(0,90),active:fetched.active,files:fetched.files,binaryAssets:fetched.binaryAssets,updated:now()};
   state().projects.push(p);state().activeProjectId=p.id;
   try{await ctx.saveNow();}catch(error){state().projects.pop();state().activeProjectId=state().projects[0].id;throw error;}
   selectedBinaryName=null;renderFiles();ctx.metrics.finish(span,'ok');
   ctx.toast('Opened "'+fetched.name+'" from GitHub.'+(fetched.skipped.length?' '+fetched.skipped.length+' file(s) were left out — see the stage warnings after it plays.':''));
   ctx.onImported?.();
  }catch(error){ctx.metrics.finish(span,'error','invalid-input');ctx.toast('GitHub import failed: '+errorText(error),true);}
 }
 async function importTextFiles(input){const files=Array.from(input.files||[]);input.value='';if(!files.length)return;const span=ctx.metrics.begin('project-import');try{const p=project();let accepted=0;for(const file of files.slice(0,20)){const name=file.name;if(!safeName(name)||file.size>500000||Object.hasOwn(p.files,name)||Object.hasOwn(p.binaryAssets||{},name))continue;const text=await file.text();if(Object.keys(p.files).length>=MAX_FILES)break;p.files[name]=text;if(!safeFiles(p.files)){delete p.files[name];break;}p.active=name;accepted++;}renderFiles();ctx.saveSoon();ctx.metrics.finish(span,'ok');ctx.toast(`${accepted} text file(s) imported into current project.`);}catch(error){ctx.metrics.finish(span,'error','invalid-input');ctx.toast('Text import failed: '+errorText(error),true);}}
 return {project,renderProjectSelector,revokeBinaryAssetURL,renderBinaryAssets,importBinaryAssets,removeBinaryAsset,projectZip,renderFiles,renderGutter,editFile,q04SyncButtons,q04PreviewEdit,q04AcceptEdit,q04RollbackEdit,createProject,renameProject,deleteProject,newFile,renameFile,copyFolder,moveFolder,deleteFile,snapshot,selectedSnapshot,renderSnapshotActions,manageSnapshot,restoreSnapshot,download,tracedExport,projectJSON,importProject,importGitHubRepo,importTextFiles};
}
