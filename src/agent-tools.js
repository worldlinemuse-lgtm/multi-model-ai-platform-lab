/* Agent tool registry (local Simone bridge, 2026-11-13).
 * A fixed allowlist of lab actions a model may REQUEST. The model never executes anything itself:
 * the agent loop validates each request against these schemas, asks the policy/human for approval,
 * and only then calls the executor supplied by the app. No vault, network, GitHub or shell actions. */
import {safeName} from './core.js';

export const MAX_TOOL_ARGUMENT_CHARS=250000;
export const MAX_TOOL_RESULT_CHARS=8000;

const file={type:'string',description:'Project-relative file path, for example main.js or src/util.py',maxLength:100};
export const AGENT_TOOLS=Object.freeze([
 {name:'list_files',risk:'read',description:'List the files in the active lab project with their sizes in characters.',parameters:{type:'object',properties:{},additionalProperties:false}},
 {name:'read_file',risk:'read',description:'Read one text file from the active lab project. Long files are truncated.',parameters:{type:'object',properties:{name:file},required:['name'],additionalProperties:false}},
 {name:'run_javascript',risk:'execute',description:'Run JavaScript in an isolated browser Worker with no network, DOM or storage. console.log output is returned. Top-level await works, pending timers are awaited, crypto.subtle is available. Time limit about 10 seconds.',parameters:{type:'object',properties:{code:{type:'string',description:'JavaScript source to run',maxLength:20000}},required:['code'],additionalProperties:false}},
 {name:'run_python',risk:'execute',description:'Run Python 3 (Pyodide/WebAssembly) in an isolated Worker. print() output and the value of the last expression are returned. Standard library only, no network. First use downloads the runtime. Time limit about 120 seconds.',parameters:{type:'object',properties:{code:{type:'string',description:'Python source to run',maxLength:20000}},required:['code'],additionalProperties:false}},
 {name:'propose_edit',risk:'write',description:'Propose replacing (or creating) a project text file with new full content. The user reviews the diff and must approve; it is never applied automatically.',parameters:{type:'object',properties:{name:file,content:{type:'string',description:'Complete new file content',maxLength:200000}},required:['name','content'],additionalProperties:false}}
]);

export function toolByName(name){return AGENT_TOOLS.find(t=>t.name===name)||null;}

export function toolDefinitions(names=AGENT_TOOLS.map(t=>t.name)){
 return names.map(n=>{const t=toolByName(n);if(!t)throw Error('Unknown agent tool: '+n);return {type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}};});
}

/* Throws on malformed JSON or a non-object payload; returns the parsed object. */
export function parseToolArguments(raw){
 if(raw===undefined||raw===null||raw==='')return {};
 if(typeof raw!=='string')throw Error('Tool arguments must be a JSON string.');
 if(raw.length>MAX_TOOL_ARGUMENT_CHARS)throw Error(`Tool arguments exceed ${MAX_TOOL_ARGUMENT_CHARS} characters.`);
 let value;try{value=JSON.parse(raw);}catch(e){throw Error('Tool arguments are not valid JSON: '+String(e.message).slice(0,160));}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Tool arguments must be a JSON object.');
 return value;
}

/* Small JSON-schema subset validator (object, string, required, maxLength, additionalProperties:false)
 * plus lab-specific semantic checks. Returns a list of human-readable errors; empty means valid. */
export function validateToolArguments(tool,args){
 const errors=[],schema=tool.parameters,props=schema.properties||{};
 if(!args||typeof args!=='object'||Array.isArray(args))return ['arguments must be an object'];
 for(const key of schema.required||[])if(!Object.hasOwn(args,key))errors.push(`missing required argument "${key}"`);
 for(const [key,value] of Object.entries(args)){
  const spec=props[key];
  if(!spec){if(schema.additionalProperties===false)errors.push(`unexpected argument "${key}" (allowed: ${Object.keys(props).join(', ')||'none'})`);continue;}
  if(spec.type==='string'){if(typeof value!=='string')errors.push(`"${key}" must be a string`);else if(spec.maxLength&&value.length>spec.maxLength)errors.push(`"${key}" is longer than ${spec.maxLength} characters`);}
 }
 if(!errors.length&&Object.hasOwn(args,'name')&&!safeName(args.name))errors.push(`"name" is not a safe project path: ${JSON.stringify(String(args.name).slice(0,100))}`);
 if(!errors.length&&Object.hasOwn(args,'code')&&!args.code.trim())errors.push('"code" is empty');
 return errors;
}

/* Approval policy. Writes ALWAYS need a person. Reads and sandbox runs can be pre-approved for a session. */
export const DEFAULT_TOOL_POLICY=Object.freeze({autoRead:true,autoExecute:false});
export function needsApproval(tool,policy=DEFAULT_TOOL_POLICY){
 if(tool.risk==='write')return true;
 if(tool.risk==='read')return !policy.autoRead;
 if(tool.risk==='execute')return !policy.autoExecute;
 return true;
}

export function formatToolResult(value,limit=MAX_TOOL_RESULT_CHARS){
 let text;try{text=typeof value==='string'?value:JSON.stringify(value);}catch{text=String(value);}
 if(text.length>limit)text=text.slice(0,limit-60)+`…[truncated ${text.length-limit+60} characters]`;
 return text;
}
