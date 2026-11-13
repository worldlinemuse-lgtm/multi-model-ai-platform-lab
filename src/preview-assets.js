/* Browser-local preview asset resolution. This is not a bundler or network loader.
 * Only referenced virtual project CSS and classic JS are inlined, in page order.
 * Module scripts are linked to blob URLs at runtime inside the preview
 * (same validated graph + linker as the module runner), never network-loaded.
 * The caller must place the result in an opaque-origin sandbox with allow-scripts only.
 */
import {compileModuleGraph} from './module-graph.js';
import {linkerWorkerSource} from './module-linker.js';
const owns=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const safeTagText=(input,closing)=>String(input).replace(new RegExp('</'+closing,'gi'),'<\\/'+closing);
const htmlAttr=(value)=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
function attribute(attributes,key){
 const expression=new RegExp('(?:^|\\s)'+key+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i');
 const result=attributes.match(expression);
 return result?result[1]??result[2]??result[3]??'':null;
}
function setAttribute(attributes,key,value){
 const expression=new RegExp('((?:^|\\s)'+key+'\\s*=\\s*)(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)','i');
 if(expression.test(attributes))return attributes.replace(expression,'$1"'+htmlAttr(value)+'"');
 return attributes+(attributes.endsWith(' ')||!attributes?'':' ')+key+'="'+htmlAttr(value)+'"';
}
function removeAttribute(attributes,key){
 return attributes.replace(new RegExp('(?:^|\\s)'+key+'\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)','i'),'').replace(/\s+/g,' ').trim();
}
// Resolve a local reference to a path inside the project, without requiring
// the file to exist — media may live in binaryAssets rather than files.
function resolveLocalPath(page,ref){
 if(typeof ref!=='string'||!ref.trim())return {error:'empty local reference'};
 const trimmed=ref.trim();
 if(/^[a-z][a-z0-9+.-]*:/i.test(trimmed)||trimmed.startsWith('//'))return {error:'external reference blocked'};
 if(trimmed.startsWith('#')||trimmed.startsWith('?'))return {error:'reference without a local path'};
 let value;
 try{value=decodeURIComponent(trimmed.split(/[?#]/,1)[0]);}catch{return {error:'invalid URL encoding'};}
 if(/[\x00-\x1f\\]/.test(value)||value.startsWith('//'))return {error:'unsafe path'};
 const parts=value.startsWith('/')?[]:page.split('/').slice(0,-1);
 for(const part of value.split('/')){
  if(!part||part==='.')continue;
  if(part==='..'){if(!parts.length)return {error:'reference outside project root'};parts.pop();continue;}
  parts.push(part);
 }
 const path=parts.join('/');
 if(!path)return {error:'empty local reference'};
 return {path};
}
function textToBase64(text){
 const bytes=new TextEncoder().encode(String(text));
 let parts=[];
 for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
 return btoa(parts.join(''));
}
const TEXT_MEDIA_MIME={svg:'image/svg+xml'};
// A media reference resolves to a data URI: binary assets first (base64 +
// MIME already validated at import), then a text file that is itself media
// (inline SVG). Anything else warns by name and is never fetched.
function resolveMediaRef(files,page,ref,binaryAssets){
 const resolved=resolveLocalPath(page,ref);
 if(resolved.error)return resolved;
 const path=resolved.path;
 const record=binaryAssets&&owns(binaryAssets,path)?binaryAssets[path]:null;
 if(record){
  if(!record||typeof record!=='object'||typeof record.base64!=='string'||typeof record.mime!=='string')
   return {error:'invalid stored media record: '+path};
  return {path,dataUri:'data:'+record.mime+';base64,'+record.base64};
 }
 if(owns(files,path)){
  if(typeof files[path]!=='string')return {error:'non-text virtual asset unsupported: '+path};
  const ext=path.split('.').at(-1)?.toLowerCase()||'';
  const mime=TEXT_MEDIA_MIME[ext];
  if(!mime)return {error:'not a picture, sound or video file: '+path};
  return {path,dataUri:'data:'+mime+';base64,'+textToBase64(files[path])};
 }
 return {error:'local asset not found: '+path};
}
function rewriteCssUrls(css,page,files,binaryAssets,report){
 return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,(whole,q1,q2,unquoted)=>{
  const ref=(q1??q2??unquoted??'').trim();
  if(!ref||ref.startsWith('data:')||ref.startsWith('#'))return whole;
  const resolved=resolveMediaRef(files,page,ref,binaryAssets);
  if(resolved.error)return report('CSS',ref,resolved.error),'none';
  return 'url("'+resolved.dataUri+'")';
 });
}
// Only text .js/.mjs files can take part in a module graph; HTML, CSS and
// binary assets are not modules and must not trip the graph's file limits.
function jsModuleFiles(files){
 const out={};
 for(const [name,content] of Object.entries(files)){
  if(typeof content==='string'&&/\.(?:js|mjs)$/.test(name))out[name]=content;
 }
 return out;
}
// A module entry becomes a small inline bootstrap: it carries the validated
// graph and the tested linker, creates blob URLs for the linked modules
// inside the preview iframe, and dynamically imports the entry. Blob URLs
// are revoked once the entry has loaded; the module code stays in memory.
// The graph JSON is <>&-escaped so module source can never close the tag.
function moduleBootstrap(graph){
 const graphJson=JSON.stringify(graph).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
 const code='(()=>{'+linkerWorkerSource()+'const graph='+graphJson+';let linked;try{linked=linkModuleGraph(graph,function(source){return URL.createObjectURL(new Blob([source],{type:"text/javascript"}));});import(linked.entryUrl).then(function(){linked.revoke();},function(error){console.error(error);linked.revoke();});}catch(error){console.error(error);}})();';
 return '<script data-local-module="'+htmlAttr(graph.entry)+'">'+safeTagText(code,'script')+'</script>';
}
function assetPath(files,page,ref){
 const resolved=resolveLocalPath(page,ref);
 if(resolved.error)return resolved;
 const path=resolved.path;
 if(!owns(files,path))return {error:'local asset not found: '+path};
 if(typeof files[path]!=='string')return {error:'non-text virtual asset unsupported'};
 return {path,content:files[path]};
}
// Find the '<' of the </script> closing an inline module, skipping the
// sequence inside JS strings, template literals and comments. A raw
// </script> can never sit inside a regex literal (its / would end it),
// so code mode only needs quotes, backticks and comments; ${} nesting is
// tracked so a string inside a template expression cannot end the tag.
function findInlineScriptClose(html,start){
 const stack=[];
 let i=start;
 while(i<html.length){
  const frame=stack.length?stack[stack.length-1]:null;
  const ch=html[i],next=html[i+1];
  if(frame&&(frame.t==='sq'||frame.t==='dq')){
   if(ch==='\\'){i+=2;continue;}
   if(ch===frame.q)stack.pop();
   i++;continue;
  }
  if(frame&&frame.t==='tpl'){
   if(ch==='\\'){i+=2;continue;}
   if(ch==='`'){stack.pop();i++;continue;}
   if(ch==='$'&&next==='{'){stack.push({t:'expr',depth:1});i+=2;continue;}
   i++;continue;
  }
  if(frame&&frame.t==='line'){
   if(ch==='\n')stack.pop();
   i++;continue;
  }
  if(frame&&frame.t==='block'){
   if(ch==='*'&&next==='/'){stack.pop();i+=2;continue;}
   i++;continue;
  }
  if(ch==='\''){stack.push({t:'sq',q:'\''});i++;continue;}
  if(ch==='"'){stack.push({t:'dq',q:'"'});i++;continue;}
  if(ch==='`'){stack.push({t:'tpl'});i++;continue;}
  if(ch==='/'&&next==='/'){stack.push({t:'line'});i+=2;continue;}
  if(ch==='/'&&next==='*'){stack.push({t:'block'});i+=2;continue;}
  if(frame&&frame.t==='expr'){
   if(ch==='{'){frame.depth++;i++;continue;}
   if(ch==='}'){frame.depth--;if(!frame.depth)stack.pop();i++;continue;}
  }
  if(ch==='<'){
   const rest=html.slice(i+1,i+8).toLowerCase();
   if(rest.startsWith('/script')){
    const after=html[i+8];
    if(after===undefined||/[\s/>]/.test(after))return i;
   }
  }
  i++;
 }
 return -1;
}
// An inline module compiles as a synthetic entry in the page's own
// directory, so its relative imports resolve exactly as they would from
// the page itself. The synthetic name never leaks into warnings: graph
// errors name the page file (e.g. "index.html inline module").
function inlineModuleGraph(files,htmlName,body,index,used){
 const modules=jsModuleFiles(files);
 const dir=htmlName.split('/').slice(0,-1);
 let name,n=index;
 do{name=[...dir,'__inline-module-'+(n++)+'.js'].join('/');}while(owns(modules,name)||used.has(name));
 used.add(name);
 try{return compileModuleGraph({...modules,[name]:body},name);}
 catch(error){
  const display=htmlName+' inline module';
  throw Error(String(error?.message||error).split(name).join(display));
 }
}
// Inline <script type="module"> (no src) compiles through the same
// validated graph as src modules and links to the same blob bootstrap.
// The body is found with the JS-aware scan above, so a </script> inside
// a string or comment cannot end the tag early and leak source as markup.
// Graph failures warn by name and drop the tag — never network-loaded.
function replaceInlineModules(html,files,htmlName,report){
 let out='',cursor=0,index=0;
 const used=new Set();
 const open=/<script\b([^>]*)>/gi;
 let match;
 while((match=open.exec(html))!==null){
  const attrs=match[1],type=attribute(attrs,'type');
  if(!type||type.toLowerCase().trim()!=='module')continue;
  if(attribute(attrs,'src')!==null)continue;
  const bodyStart=match.index+match[0].length;
  const close=findInlineScriptClose(html,bodyStart);
  if(close<0)continue;
  const closeEnd=html.indexOf('>',close);
  if(closeEnd<0)continue;
  const body=html.slice(bodyStart,close);
  let replacement;
  try{replacement=moduleBootstrap(inlineModuleGraph(files,htmlName,body,index,used));}
  catch(error){replacement=report('JS',htmlName+' inline module',error?.message||String(error));}
  out+=html.slice(cursor,match.index)+replacement;
  cursor=closeEnd+1;
  index++;
  open.lastIndex=cursor;
 }
 return out+html.slice(cursor);
}
export function previewReport(files,htmlName,binaryAssets={}){
 if(!files||!owns(files,htmlName)||typeof files[htmlName]!=='string')throw Error('Select an existing HTML file to preview.');
 const warnings=[];
 const report=(type,ref,reason)=>{warnings.push(type+' '+String(ref??'')+': '+reason);return '';};
 let html=files[htmlName];
 // Only <link rel="stylesheet" href="local.css"> is resolved. Other links are left to CSP.
 html=html.replace(/<link\b([^>]*?)\/?>/gi,(whole,attrs)=>{
  const rel=attribute(attrs,'rel')||'';
  if(!rel.split(/\s+/).some(x=>x.toLowerCase()==='stylesheet'))return whole;
  const ref=attribute(attrs,'href'),asset=assetPath(files,htmlName,ref);
  if(asset.error)return report('CSS',ref,asset.error);
  if(!asset.path.toLowerCase().endsWith('.css'))return report('CSS',ref,'expected a .css project file');
  const css=rewriteCssUrls(asset.content,htmlName,files,binaryAssets,report);
  return '<style data-local-href="'+htmlAttr(asset.path)+'">'+safeTagText(css,'style')+'</style>';
 });
 // Inline modules compile first, with a JS-aware scan for their closing
 // tag; the general pass below then handles src scripts and classic
 // inline scripts exactly as before.
 html=replaceInlineModules(html,files,htmlName,report);
 // Inserting at each original script location preserves ordering with inline scripts.
 // Module entries are linked to blob URLs and run; anything the graph
 // rejects (missing dep, dynamic import, traversal, external) is warned
 // by name and the tag is dropped — never network-loaded.
 html=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,(whole,attrs,body)=>{
  const ref=attribute(attrs,'src');
  if(ref===null)return whole;
  const type=attribute(attrs,'type');
  if(type&&type.toLowerCase().trim()==='module'){
   const asset=assetPath(files,htmlName,ref);
   if(asset.error)return report('JS',ref,asset.error);
   let graph;
   try{graph=compileModuleGraph(jsModuleFiles(files),asset.path);}
   catch(error){return report('JS',ref,error?.message||String(error));}
   return moduleBootstrap(graph);
  }
  if(type&&!['text/javascript','application/javascript'].includes(type.toLowerCase().trim()))return report('JS',ref,'script type not supported');
  const asset=assetPath(files,htmlName,ref);
  if(asset.error)return report('JS',ref,asset.error);
  if(!/\.(js|mjs|cjs)$/i.test(asset.path))return report('JS',ref,'expected a JavaScript project file');
  return '<script data-local-src="'+htmlAttr(asset.path)+'">'+safeTagText(asset.content,'script')+'</script>';
 });
 // Local media becomes data URIs, so pictures, sounds and video actually
 // show and play inside the srcdoc preview. A ref that cannot resolve is
 // warned by name and stripped — no broken image, no network attempt.
 html=html.replace(/<(img|audio|video|source)\b([^>]*?)>/gi,(whole,tag,attrs)=>{
  let next=attrs;
  const src=attribute(attrs,'src');
  if(src!==null&&!src.startsWith('data:')){
   const resolved=resolveMediaRef(files,htmlName,src,binaryAssets);
   if(resolved.error){report('Media',src,resolved.error);next=removeAttribute(next,'src');}
   else next=setAttribute(next,'src',resolved.dataUri);
  }
  if(tag.toLowerCase()==='video'){
   const poster=attribute(next,'poster');
   if(poster!==null&&!poster.startsWith('data:')){
    const resolved=resolveMediaRef(files,htmlName,poster,binaryAssets);
    if(resolved.error){report('Media',poster,resolved.error);next=removeAttribute(next,'poster');}
    else next=setAttribute(next,'poster',resolved.dataUri);
   }
  }
  // Rebuild the tag with a separating space: removeAttribute trims the
  // attribute string, so concatenating it bare fuses the tag name with
  // the next attribute (<imgalt="gone">) and the element never attaches.
  return '<'+tag+(next?' '+next:'')+'>';
 });
 const csp='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; media-src data: blob:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\' blob:; connect-src \'none\'; form-action \'none\'; base-uri \'none\';">';
 const document='<!doctype html><html><head><meta charset="utf-8">'+csp+'</head><body>'+html+'</body></html>';
 return {document,warnings};
}
export function previewDocument(files,htmlName,binaryAssets={}){return previewReport(files,htmlName,binaryAssets).document;}
