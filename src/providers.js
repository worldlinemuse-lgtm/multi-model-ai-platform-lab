// Providers and key-vault UI, extracted from main.js (Stage 4b group 5).
// Wired into main.js 2026-11-05: main.js constructs the module after the
// execution module and calls providers.* directly from selectView,
// renderAll, renderChat, renderWorkflows and the wire() handlers; no shims
// were needed. Function bodies were copied verbatim from main.js with
// global references replaced by closure/ctx references only. The vault
// instance itself stays owned by main.js and arrives via ctx.vault, so the
// Stage 2b fingerprint guard and cross-tab wiring are untouched by this
// move.
import {PROVIDERS,providerById} from './core.js';
import {validateModel} from './provider-api.js';
import {parseProviderPresets,exportProviderPresets,resolvePresetRoute} from './provider-presets.js';
import {inspectProviderConfiguration} from './connection-diagnostics.js';
import {probeGroqModels,recommendGroqModel} from './provider-connection-probe.js';
import {$,make,clearNode,formatTime,errorText} from './dom-helpers.js';

export function createProviders(ctx){
 const guideById=new Map(((typeof window!=='undefined'&&window.MM_PROVIDER_GUIDES)||[]).map(g=>[g.id,g]));
 const state=()=>ctx.getState();
 const vault=()=>ctx.vault;
 function q22InspectRoutes(){
  const routes=PROVIDERS.map(p=>inspectProviderConfiguration(p.id,vault().get(p.id)));
  const text=routes.map(x=>x.provider+': '+x.state+(x.endpointHost?' @ '+x.endpointHost:'')+'\n'+x.issues.join('; ')).join('\n\n');
  $('provider-diagnostics').textContent=text;
  ctx.toast('Local-only configuration inspection complete. No HTTP request was sent.');
 }
 async function inspectGroqLiveMetadata(){
  const button=$('provider-check-groq'),output=$('provider-groq-diagnostics');
  if(button.disabled)return;
  const credential=vault().get('groq');
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
 function renderProviderPresets(){
  const list=state().preferences?.providerPresets||[],select=$('provider-preset-select'),prior=select.value;
  select.replaceChildren(new Option('Choose a saved model preset…',''));
  list.forEach((p,i)=>select.add(new Option(p.label+' · '+p.provider+' · '+p.model,String(i))));
  if([...select.options].some(x=>x.value===prior))select.value=prior;
  $('provider-preset-count').textContent=list.length+' saved local model preset(s). No keys or endpoints stored.';
  $('provider-preset-apply').disabled=!select.value;
 }
 async function importProviderPresets(event){
  const input=event.target,file=input.files?.[0];input.value='';
  if(!file)return;
  if(file.size>15000)return ctx.toast('Preset manifest exceeds 15 KB.',true);
  try{
   const parsed=parseProviderPresets(await file.text());
   if(!confirm('Replace current local model presets with '+parsed.length+' new data-only entries? No keys or API requests involved.'))return;
   const previous=state().preferences.providerPresets;
   state().preferences.providerPresets=parsed;
   try{await ctx.saveNow();}catch(error){state().preferences.providerPresets=previous;throw error;}
   renderProviderPresets();ctx.toast('Validated local model presets imported. Free account/model eligibility remains unverified.');
  }catch(error){ctx.toast('Preset import rejected: '+errorText(error),true);}
 }
 function exportLocalPresets(){
  try{ctx.download('mm-provider-presets.json',exportProviderPresets(state().preferences.providerPresets||[]));}
  catch(error){ctx.toast('Preset export failed: '+errorText(error),true);}
 }
 function applyProviderPreset(){
  const index=Number($('provider-preset-select').value);
  try{
   if($('provider-preset-select').value==='')throw Error('Select a saved preset first.');
   const candidate=resolvePresetRoute(state().preferences.providerPresets||[],index);
   $('key-provider').value=candidate.provider;$('key-model').value=candidate.model;
   $('key-account').value=vault().get(candidate.provider)?.account||'';
   ctx.selectView('vault');
   ctx.toast('Unverified provider/model preset copied to vault form. Provide your eligible free-plan key and explicitly save.');
  }catch(error){ctx.toast('Preset selection rejected: '+errorText(error),true);}
 }
 function renderProviders(query=$('provider-search').value||''){renderProviderPresets();const host=clearNode($('provider-list'));let count=0;for(const p of PROVIDERS){const g=guideById.get(p.id);if(!(p.name+p.window+(g?.scope||'')+(g?.reset||'')).toLowerCase().includes(query.toLowerCase()))continue;count++;const card=make('article','provider-card');const top=make('div','provider-top');top.append(make('h2','',p.name),make('span','tag '+(vault().get(p.id)?'good':'muted'),vault().get(p.id)?'KEY SAVED':'NOT CONNECTED'));card.append(top,make('p','',g?.note||'Eligible recurring-free source.'));const tags=make('div','provider-meta');tags.append(make('span','tag',p.window),make('span','tag','REMAINING: UNKNOWN'));card.append(tags);if(g){const d=make('details');d.append(make('summary','','Setup instructions + quota scope'));d.append(make('p','','Quota scope: '+g.scope));d.append(make('p','','Published reset: '+g.reset));const ol=make('ol');for(const step of g.steps)ol.append(make('li','',step));d.append(ol);card.append(d);const links=make('div','provider-links');for(const [label,url] of [['Create account ↗',g.signup_url],['Get key ↗',g.key_url],['Docs ↗',g.docs_url],['Limits ↗',g.limits_url]]){if(!url)continue;const a=make('a','',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}card.append(links);}const button=make('button','button secondary small',vault().get(p.id)?'Manage saved key →':'Connect a key →');button.type='button';button.addEventListener('click',()=>{$('key-provider').value=p.id;$('key-model').value=vault().get(p.id)?.model||p.model;$('key-account').value=vault().get(p.id)?.account||'';ctx.selectView('vault');});card.append(button);host.append(card);}if(!count)host.append(make('p','','No providers match this search.'));}
 async function exportEncryptedVaultUI(){
  try{
   const backup=await vault().exportEncrypted();
   ctx.download('mm-encrypted-key-vault.json',backup,'application/json');
   ctx.toast('Encrypted-only vault backup exported. Keep the original passphrase; it is never stored in this file.');
  }catch(e){ctx.toast('Encrypted backup failed: '+errorText(e),true);}
 }
 async function importEncryptedVaultUI(event){
  const input=event.target,file=input.files?.[0];input.value='';
  const passwordBox=$('vault-import-passphrase'),passphrase=passwordBox.value;passwordBox.value='';
  if(!file)return;
  if(!passphrase||passphrase.length<10)return ctx.toast('Enter the ORIGINAL encrypted backup passphrase before selecting the file.',true);
  if(file.size>1000000)return ctx.toast('Encrypted vault backup exceeds 1 MB.',true);
  const exists=await vault().exists();
  if(exists&&!confirm('Replace the EXISTING encrypted key vault on this device? Export its encrypted backup first. Importing a different vault will require that backup’s original passphrase and cannot be undone here.'))return;
  try{
   await vault().importEncrypted(await file.text(),{replaceExisting:exists,passphrase});
   $('vault-password').value='';ctx.renderAll();
   ctx.toast('Encrypted vault imported and locked. Unlock it with its original passphrase.');
  }catch(e){ctx.toast('Vault import rejected: '+errorText(e),true);}
 }
 async function rotateVaultUI(event){
  event.preventDefault();
  const current=$('vault-rotation-old').value,newPass=$('vault-rotation-new').value;
  if(!vault().isUnlocked)return ctx.toast('Unlock vault before changing its passphrase.',true);
  if(!confirm('Rotate this device’s vault encryption passphrase? Previously exported encrypted backups will still require their OLD passphrase.'))return;
  try{
   await vault().rotatePassphrase(current,newPass);
   ctx.renderAll();ctx.toast('Vault re-encrypted with a new random salt and IV. Export a new encrypted backup.');
  }catch(e){ctx.toast('Passphrase rotation rejected: '+errorText(e),true);}
  finally{$('vault-rotation-old').value='';$('vault-rotation-new').value='';}
 }
 async function renderVault(){const exists=await vault().exists();$('vault-status').textContent=vault().isUnlocked?'UNLOCKED':exists?'LOCKED':'NOT CREATED';$('vault-status').className='tag '+(vault().isUnlocked?'good':'muted');$('vault-action-title').textContent=exists?'Unlock your encrypted vault':'Create your encrypted vault';$('vault-submit').textContent=exists?'Unlock vault':'Create vault';$('vault-entry-hint').textContent=vault().isUnlocked?'Vault unlocked. Enter your provider information and save it encrypted.':'You can enter provider information now. To save it securely, first create or unlock your vault using the passphrase field on this page.';$('vault-lock').disabled=!vault().isUnlocked;$('vault-export-encrypted').disabled=!exists;$('vault-rotate-submit').disabled=!vault().isUnlocked;const host=clearNode($('vault-items'));if(!vault().isUnlocked){host.append(make('p','hint-line',exists?'Vault is locked. Enter your passphrase to access saved key slots.':'No vault created yet. Choose a passphrase to begin.'));}else{for(const entry of vault().list()){const div=make('div','vault-item'),description=make('div');description.append(make('b','',providerById(entry.id)?.name||entry.id),make('small','',`${entry.model} · saved ${formatTime(entry.updated)}`));const removeButton=make('button','text-button danger-text','Remove');removeButton.addEventListener('click',async()=>{if(!confirm(`Remove ${entry.id} credentials?`))return;try{await vault().drop(entry.id);ctx.renderAll();ctx.toast('Key slot removed.');}catch(e){ctx.toast(errorText(e),true);}});div.append(description,removeButton);host.append(div);}if(!vault().count)host.append(make('p','hint-line','No keys stored yet. Add your first eligible route.'));}ctx.renderStats();}
 async function submitVault(event){event.preventDefault();const pass=$('vault-password').value;try{if(await vault().exists())await vault().unlock(pass);else await vault().create(pass);$('vault-password').value='';ctx.toast('Vault unlocked on this device.');ctx.renderAll();}catch(e){ctx.toast(errorText(e),true);}}
 async function submitKey(event){event.preventDefault();if(!vault().isUnlocked){ctx.toast('Your details are ready. Create or unlock your vault with a passphrase first; the fields will stay filled.',true);$('vault-password').focus();$('vault-password').scrollIntoView({behavior:'smooth',block:'center'});return;}const id=$('key-provider').value,model=$('key-model').value.trim(),key=$('key-value').value.trim(),account=$('key-account').value.trim();try{validateModel(id,model);if(id==='cloudflare'&&!/^[a-f0-9]{32}$/i.test(account))throw Error('Cloudflare requires a 32-character account ID');await vault().put(id,{key,model,account,attested:$('key-attest').checked});$('key-value').value='';$('key-attest').checked=false;ctx.renderAll();ctx.toast(`Encrypted key slot saved for ${providerById(id).name}. Provider connection is not verified until a request succeeds.`);}catch(e){ctx.toast(errorText(e),true);}}
 function routeChoices(){const list=vault().list();for(const select of [$('chat-route'),$('workflow-route')]){const prior=select.value;select.replaceChildren();if(!list.length){select.add(new Option('Unlock + save a key first',''));continue;}for(const entry of list){select.add(new Option(`${providerById(entry.id)?.name||entry.id} · ${entry.model}`,entry.id));}if(list.some(e=>e.id===prior))select.value=prior;}const ready=list.length;$('chat-connection-label').textContent=ready?`${ready} saved key slot(s) · not verified`:'Unlock vault + connect an eligible free key';renderCompareRoute();}
 function renderCompareRoute(){const select=$('compare-route'),previous=select.value,primary=$('chat-route').value;select.replaceChildren(new Option('Choose another route…',''));for(const entry of vault().list().filter(e=>e.id!==primary))select.add(new Option(`${providerById(entry.id)?.name||entry.id} · ${entry.model}`,entry.id));if([...select.options].some(o=>o.value===previous))select.value=previous;else select.value='';const compareWrap=ctx.optionalControl('compare-route-wrap');if(compareWrap)compareWrap.hidden=!$('compare-mode').checked;}
 return {q22InspectRoutes,inspectGroqLiveMetadata,renderProviderPresets,importProviderPresets,exportLocalPresets,applyProviderPreset,renderProviders,exportEncryptedVaultUI,importEncryptedVaultUI,rotateVaultUI,renderVault,submitVault,submitKey,routeChoices,renderCompareRoute};
}
