/* Browser-local preview asset resolution. This is not a bundler or network loader.
 * Only referenced virtual project CSS and classic JS are inlined, in page order.
 * The caller must place the result in an opaque-origin sandbox with allow-scripts only.
 */
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
function assetPath(files,page,ref){
 const resolved=resolveLocalPath(page,ref);
 if(resolved.error)return resolved;
 const path=resolved.path;
 if(!owns(files,path))return {error:'local asset not found: '+path};
 if(typeof files[path]!=='string')return {error:'non-text virtual asset unsupported'};
 return {path,content:files[path]};
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
 // Inserting at each original script location preserves ordering with inline scripts.
 // Explicitly skip external, missing and module scripts; never network-load them.
 html=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,(whole,attrs,body)=>{
  const ref=attribute(attrs,'src');
  if(ref===null)return whole;
  const type=attribute(attrs,'type');
  if(type&&type.toLowerCase().trim()==='module')return report('JS',ref,'module imports are not supported by this preview');
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
  return '<'+tag+next+'>';
 });
 const csp='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; media-src data: blob:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\';">';
 const document='<!doctype html><html><head><meta charset="utf-8">'+csp+'</head><body>'+html+'</body></html>';
 return {document,warnings};
}
export function previewDocument(files,htmlName,binaryAssets={}){return previewReport(files,htmlName,binaryAssets).document;}
