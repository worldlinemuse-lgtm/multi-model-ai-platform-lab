import {validateBinaryAssets} from './binary-assets.js';
import {validateProviderPresets} from './provider-presets.js';
export const VERSION = 'B0.4.0';
export const APP_KEY = 'mm-studio-v03';
export const MAX_FILES = 120;
export const MAX_FILE_LENGTH = 500000;
export const MAX_PROJECT_BYTES = 1250000;
export const MAX_NOTES = 250;
export const MAX_AUDIT = 500;
export const PROVIDERS = Object.freeze([
  {id:'groq', name:'GroqCloud',model:'openai/gpt-oss-20b',window:'Minute / day',transport:'OpenAI-compatible',kind:'key'},
  {id:'openrouter',name:'OpenRouter Free',model:'openrouter/free',window:'Minute / day',transport:'OpenAI-compatible',kind:'key'},
  {id:'gemini',name:'Google Gemini API',model:'gemini-2.5-flash-lite',window:'Minute / day',transport:'Gemini REST',kind:'key'},
  {id:'cloudflare',name:'Cloudflare Workers AI',model:'@cf/meta/llama-3.1-8b-instruct-fp8',window:'Daily',transport:'Workers AI REST',kind:'key+account'},
  {id:'mistral',name:'Mistral Studio Free',model:'mistral-small-latest',window:'Recurring rate windows',transport:'OpenAI-compatible',kind:'key'},
  {id:'ollama',name:'Ollama Cloud Free',model:'',window:'Monthly',transport:'OpenAI-compatible',kind:'key'},
  {id:'huggingface',name:'Hugging Face Inference Providers',model:'',window:'Monthly',transport:'OpenAI-compatible',kind:'key'},
  {id:'aion',name:'Aion Labs Free',model:'aion-labs/aion-3.5',window:'Minute / day',transport:'OpenAI-compatible',kind:'key'}
]);
export const VIEWS = Object.freeze({overview:'Overview',workspace:'Code studio',chat:'Model chat',workflows:'Workflows',knowledge:'Knowledge',datalab:'Data lab',media:'Media tools',providers:'Free providers',vault:'Key vault',usage:'Usage & audit',telemetry:'Telemetry',capabilities:'Capabilities',settings:'Settings'});
export const CAPABILITIES = [
['B01','Conversation threads','local','Saved conversation threads with search, user-message editing and export; model replies require an authorized provider route'],
['B02','Multi-file IDE','local','Editable source, file explorer, project selection, line numbers and snapshots'],
['B03','JavaScript execution','local','Terminating Web Worker inside opaque-origin sandbox'],
['B04','Python WebAssembly','conditional','Pyodide loads on demand over CDN and executes inside isolated worker'],
['B05','Other language runtimes','partial','WebAssembly execution capability test; additional interpreters not integrated'],
['B06','Virtual filesystem and ZIP','local','IndexedDB projects, file import, ZIP/JSON export and archive import'],
['B07','Isolated HTML preview','local','HTML/CSS/JS from project source with restrictive CSP'],
['B08','Execution console','local','Captured logs, errors, Stop/timeout, output caps'],
['B09','Project checkpoints','local','Multiple projects, snapshots, export and restore'],
['B10','Workflow diagram','local','Visible three-stage task graph'],
['B11','Supervised orchestration','conditional','Sequential, stoppable multi-step calls with explicit consent and audit'],
['B12','Operator controls','local','Model route settings, stop buttons, audit and capability views'],
['B13','IndexedDB persistence','local','Browser-origin project, chat, notes, audit and encrypted vault storage'],
['B14','Data encryption','local','PBKDF2 + AES-GCM for credential vault, unlock required each session'],
['B15','Document import','partial','Local text, Markdown, JSON, CSV and bounded DOCX extraction; PDF text extraction not implemented'],
['B16','Local data analysis','local','CSV/JSON analysis, browser charts and JavaScript/Python calculations'],
['B17','On-device AI inference','planned','No local model weights or WebGPU inference have been bundled'],
['B18','Knowledge retrieval','local','Simple local keyword search through notes and project files'],
['B19','Multimedia','local','Canvas image adjustment, browser text-to-speech and optional dictation'],
['B20','Extensible provider adapters','partial','Eight fixed provider transport profiles; third-party plugin API planned'],
['B21','Offline application shell','local','Service-worker cache after HTTP(S) visit; provider API and Python runtime need network'],
['E01','Provider onboarding','local','Eight verified dated catalog entries with official signup and key links'],
['E02','Credential handling','local','Encrypted local API keys with user-attested free plan'],
['E03','Live model inference','conditional','Direct browser fetch with provider key + CORS + eligible model/account'],
['E04','Model comparison','conditional','Explicit two-route comparison with separate provider histories, conditional on valid keys and network'],
['E05','Model routing','partial','Explicit route selection; quota-aware auto-routing not implemented'],
['E06','Allowance accounting','partial','Logs provider-reported tokens and local attempts; remaining quota unknown'],
['E07','Fallback routing','planned','No automatic billed or paid fallback'],
['E08','Model collaboration','conditional','Sequential three-stage review workflows'],
['E09','Parallel inference','conditional','Two-route chat comparison'],
['E10','AI-assisted code','conditional','Attach selected editor source to a model; never auto-execute output'],
['E11','Agent workflows','partial','Human-confirmed fixed workflows; no autonomous external tool use'],
['E12','External research','planned','No independent search API connection'],
['E13','GitHub repository sync','planned','Source is hosted on GitHub; user repo editing requires separately authorized GitHub credentials'],
['E14','Other media inference','planned','Remote image/speech/embedding adapters are not implemented']
];
export const FLOW_TEMPLATES = Object.freeze({
 research:['Collect evidence','Draft an answer','Critically review'],
 code:['Plan implementation','Propose source code','Find defects'],
 explain:['Explain concept','Challenge assumptions','Refine explanation']
});
export function uid(prefix='id'){return `${prefix}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;}
export const clone = value => { try{ return JSON.parse(JSON.stringify(value)); }catch{ return null; } };
export const now = () => new Date().toISOString();
export const providerById = id => PROVIDERS.find(p=>p.id===id);
export function safeName(name){return typeof name==='string' && name.length<=100 && /^[\p{L}\p{N}_-][\p{L}\p{N}_.+@ /-]*$/u.test(name) && !name.endsWith('/') && name.split('/').every(part=>part.length>0&&part!=='.'&&part!=='..'&&!part.startsWith('.'));}
export function safeFiles(files){return !!files && typeof files==='object'&&!Array.isArray(files) && Object.keys(files).length>0&&Object.keys(files).length<=MAX_FILES&&Object.entries(files).every(([n,v])=>safeName(n)&&typeof v==='string'&&v.length<=MAX_FILE_LENGTH) && Object.values(files).reduce((s,v)=>s+v.length,0)<=MAX_PROJECT_BYTES;}
export function starterProject(name='First project'){return {id:uid('project'),name,active:'main.js',updated:now(),files:{'main.js':'// Run with ▶ Run code. This runs in an isolated Web Worker.\nconst message = "Hello from Multi-Model Studio!";\nconsole.log(message);\nconsole.log("2 + 2 =", 2 + 2);','index.html':'<!doctype html>\n<html><head><title>My first preview</title></head><body>\n<h1>Hello from the browser workbench!</h1>\n<p>Edit this file and press Preview HTML.</p>\n<button onclick="document.getElementById(\'result\').textContent = \'It works!\'">Test interaction</button>\n<p id="result"></p>\n</body></html>','style.css':'body { font: 16px system-ui; padding: 28px; color: #1d2b43; }\nh1 { color: #4162c6; }\nbutton { background: #4162c6; color: white; border: 0; padding: 10px; border-radius: 8px; }','hello.py':'print("Python is running inside WebAssembly!")\nprint("2 + 2 =", 2 + 2)'}};}
import {validateSavedDatasets} from './data-tools.js';
import {validateSavedWorkflowPlan} from './workflow-plan.js';
export function freshState(){const p=starterProject();const thread={id:uid('thread'),title:'New conversation',created:now(),messages:[]};return {format:APP_KEY,projects:[p],activeProjectId:p.id,snapshots:[],threads:[thread],activeThreadId:thread.id,notes:[],audit:[],workflows:[],datasets:[],preferences:{accent:'cyan',compact:false,maxOutputTokens:512,providerPresets:[]},created:now()};}
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const textField = (v,max=100000) => typeof v === 'string' && v.length <= max;
const idField = v => textField(v,140) && v.length > 0;
const uniqueIds = items => new Set(items.map(x=>x.id)).size === items.length;
function validProject(p){return record(p) && idField(p.id) && textField(p.name,100) && idField(p.active) && safeFiles(p.files) && Object.hasOwn(p.files,p.active) && textField(p.updated,80) && (p.binaryAssets===undefined||validateBinaryAssets(p.binaryAssets,p.files));}
function validSnapshot(s){return record(s) && idField(s.id) && textField(s.at,80) && textField(s.label,60) && (s.pinned===undefined||typeof s.pinned==='boolean') && validProject(s.project);}
function validMessage(m){return record(m) && ['user','assistant','system'].includes(m.role) && textField(m.content,60000) && (m.provider===undefined||textField(m.provider,140)) && (m.model===undefined||textField(m.model,140)) && (m.error===undefined||typeof m.error==='boolean') && (m.at===undefined||textField(m.at,80));}
function validThread(t){return record(t) && idField(t.id) && textField(t.title,300) && textField(t.created,80) && Array.isArray(t.messages) && t.messages.length<=150 && t.messages.every(validMessage);}
function validNote(n){return record(n) && idField(n.id) && textField(n.title,150) && textField(n.content,100000) && textField(n.created,80) && (n.updated===undefined||textField(n.updated,80));}
const validTokens = v => v===null || (Number.isSafeInteger(v) && v>=0);
function validUsage(u){return u===null || (record(u) && validTokens(u.prompt_tokens) && validTokens(u.completion_tokens) && validTokens(u.total_tokens) && textField(u.source,100));}
function validAudit(a){return record(a) && idField(a.id) && textField(a.at,80) && textField(a.op,100) && textField(a.provider,140) && textField(a.status,100) && (a.usage===undefined || validUsage(a.usage)) && (a.requestId===undefined||textField(a.requestId,36)) && (a.model===undefined||textField(a.model,130)) && (a.latencyMs===undefined||a.latencyMs===null||(Number.isSafeInteger(a.latencyMs)&&a.latencyMs>=0&&a.latencyMs<=120000)) && (a.httpStatus===undefined||a.httpStatus===null||(Number.isSafeInteger(a.httpStatus)&&a.httpStatus>=100&&a.httpStatus<=599)) && (a.observation===undefined||a.observation==='local-browser');}
function validWorkflow(w){return record(w) && idField(w.id) && textField(w.at,80) && textField(w.provider,140) && textField(w.template,100) && textField(w.goal,10000) && ['running','stopped','failed','complete'].includes(w.status) && Array.isArray(w.steps) && w.steps.length<=6 && w.steps.every(x=>record(x)&&textField(x.stage,200)&&textField(x.content,60000)&&(x.model===undefined||textField(x.model,140))&&(x.provider===undefined||textField(x.provider,140))&&(x.status===undefined||['complete','skipped','failed'].includes(x.status))&&(x.savedAs===undefined||(typeof x.savedAs==='string'&&/^[a-z][a-z0-9_]{0,23}$/i.test(x.savedAs))))&&(w.plan===undefined||(validateSavedWorkflowPlan(w.plan)&&w.steps.length<=w.plan.length))&&(w.inFlightStage===undefined||w.inFlightStage===null||(Number.isSafeInteger(w.inFlightStage)&&w.inFlightStage>=0&&w.inFlightStage<6));}
export function validateState(s){
 if(!record(s)||s.format!==APP_KEY||!textField(s.created,80))return false;
 if(!Array.isArray(s.projects)||!s.projects.length||s.projects.length>30||!s.projects.every(validProject)||!uniqueIds(s.projects)||!s.projects.some(p=>p.id===s.activeProjectId))return false;
 if(!Array.isArray(s.snapshots)||s.snapshots.length>100||!s.snapshots.every(validSnapshot)||!uniqueIds(s.snapshots))return false;
 if(!Array.isArray(s.threads)||!s.threads.length||s.threads.length>120||!s.threads.every(validThread)||!uniqueIds(s.threads)||!s.threads.some(t=>t.id===s.activeThreadId))return false;
 if(!Array.isArray(s.notes)||s.notes.length>MAX_NOTES||!s.notes.every(validNote)||!uniqueIds(s.notes))return false;
 if(!Array.isArray(s.audit)||s.audit.length>MAX_AUDIT||!s.audit.every(validAudit))return false;
 if(!Array.isArray(s.workflows)||s.workflows.length>40||!s.workflows.every(validWorkflow))return false;
  if(!validateSavedDatasets(s.datasets))return false;
 return record(s.preferences) && ['cyan','violet','amber'].includes(s.preferences.accent) && typeof s.preferences.compact==='boolean' && (s.preferences.maxOutputTokens===undefined||[128,256,512,1024].includes(s.preferences.maxOutputTokens)) && (s.preferences.providerPresets===undefined||validateProviderPresets(s.preferences.providerPresets));
}
export function historyForRoute(messages,route){
 return messages.filter(m=>m && (m.role==='user'||(m.role==='assistant'&&m.provider===route&&!m.error)))
  .slice(-10).map(m=>({role:m.role,content:m.content}));
}
export function migrateLegacy(source){if(!source||!safeFiles(source.files)||!Object.hasOwn(source.files,source.active))throw Error('Cannot migrate invalid legacy project');const state=freshState();const migratedFiles=clone(source.files);if(!migratedFiles)throw Error('Cannot migrate: legacy file data is not serializable');state.projects[0].files=migratedFiles;state.projects[0].active=source.active;state.projects[0].name='Recovered B0.2 project';return state;}
export function csvSummary(text){const rows=text.trim().split(/\r?\n/).filter(Boolean);if(!rows.length)return 'Empty CSV';return `${rows.length} rows · ${rows[0].split(',').length} columns\nHeaders: ${rows[0].slice(0,400)}`;}
export function routeDescription(connected){return `${connected} / ${PROVIDERS.length}`;}
