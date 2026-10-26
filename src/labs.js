import {imageGeometry,paintEditedImage} from './image-transform.js';
import {BrushEngine,DEFAULT_SMOOTHING} from './draw.js';
import {validateSpeechSettings,chooseVoice} from './speech-settings.js';
import {MAX_SAVED_DATASETS,MAX_SAVED_DATASET_CHARS,validateSavedDatasets,transformDataset,serializeDataset,groupNumericStats} from './data-tools.js';
export function parseCSV(text){const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=false;else value+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(value);value='';}else if(c==='\n'){row.push(value.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);row=[];value='';}else value+=c;}if(quoted)throw Error('Unclosed quoted CSV field');row.push(value.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);if(!rows.length)throw Error('Empty dataset');const columns=rows.shift().map((x,i)=>x||`Column ${i+1}`);if(columns.length>50||rows.length>3000)throw Error('Limit: 50 columns, 3,000 rows');return {columns,records:rows.map(r=>Object.fromEntries(columns.map((col,i)=>[col,r[i]??''])))};}
function maxDepth(value,limit=100){
 // Iterative depth check — recursion here would be the vulnerability.
 let max=0;const stack=[[value,1]];
 while(stack.length){
  const [v,d]=stack.pop();
  if(d>limit)return d;
  if(d>max)max=d;
  if(v&&typeof v==='object'){
   if(Array.isArray(v)){for(let i=0;i<v.length;i++)stack.push([v[i],d+1]);}
   else{for(const k of Object.keys(v))stack.push([v[k],d+1]);}
  }
 }
 return max;
}
export function parseDataset(text){if(!text||text.length>2_000_000)throw Error('Dataset must be under 2 MB');const t=text.trim();if(t.startsWith('[')||t.startsWith('{')){const v=JSON.parse(t);if(maxDepth(v)>100)throw Error('JSON nesting exceeds 100 levels');const arr=Array.isArray(v)?v:Array.isArray(v.data)?v.data:[v];if(arr.length>3000)throw Error('Maximum 3,000 JSON rows');const records=arr.map(x=>typeof x==='object'&&x!==null&&!Array.isArray(x)?x:{value:x});const allColumns=Array.from(new Set(records.flatMap(x=>Object.keys(x))));const columns=allColumns.slice(0,50);return {columns,records,hiddenColumns:Math.max(0,allColumns.length-50)};}return parseCSV(t);}
export function numericValue(value){
 if(value===null||value===undefined||typeof value==='boolean')return null;
 if(typeof value==='string'&&value.trim()==='')return null;
 if(typeof value!=='number'&&typeof value!=='string')return null;
 const converted=Number(value);
 return Number.isFinite(converted)?converted:null;
}
export function analyzeDataset(parsed){const {columns,records}=parsed;const numeric=columns.filter(col=>records.some(row=>numericValue(row[col])!==null));const stats={};for(const col of numeric){const arr=records.map(row=>numericValue(row[col])).filter(n=>n!==null);if(arr.length)stats[col]={count:arr.length,min:Math.min(...arr),max:Math.max(...arr),mean:arr.reduce((a,b)=>a+b,0)/arr.length};}return {rows:records.length,columns:columns.length,numeric,stats};}
export function setupLabs({el,toast,download,metrics=null,getDatasets=()=>[],commitDatasets=async()=>{throw Error('Workspace persistence is not configured');}}){
 let parsed=null,selectedImage=null,selectedNote='',activeRecognition=null,tablePage=0,chartPage=0,undoSource=null,rotation=0,cropPercent=0,imageUndo=[];const $=el;
 function refreshSavedDatasets(){
  const selected=$('data-saved').value,items=getDatasets(),control=$('data-saved');
  control.replaceChildren(new Option(items.length?'Choose saved dataset…':'No saved datasets',''));
  for(const item of items)control.add(new Option(item.title,item.id));
  if(items.some(item=>item.id===selected))control.value=selected;
  $('data-load').disabled=!control.value;$('data-delete').disabled=!control.value;
 }
 function renderTransformFields(){
  const select=$('data-transform-field'),prior=select.value;
  select.replaceChildren(new Option('Choose column…',''));
  if(parsed){for(const col of parsed.columns)select.add(new Option(col,col));}
  if(parsed?.columns.includes(prior))select.value=prior;
  else if(parsed?.columns.length)select.value=parsed.columns[0];
  const valid=!!parsed && parsed.columns.length>0;
  $('data-transform-apply').disabled=!valid;
  $('data-transform-undo').disabled=undoSource===null;
 }
 function renderTable(){const host=$('data-table');host.replaceChildren();if(!parsed){$('data-table-status').textContent='No table data';return;}const total=parsed.records.length,pages=Math.max(1,Math.ceil(total/25));tablePage=Math.max(0,Math.min(tablePage,pages-1));$('data-table-status').textContent=`Rows ${total?tablePage*25+1:0}–${Math.min(total,(tablePage+1)*25)} of ${total} · ${parsed.columns.length} columns${parsed.hiddenColumns?` · ${parsed.hiddenColumns} more hidden (first 50 shown)`:''}`;$('data-table-prev').disabled=tablePage===0;$('data-table-next').disabled=tablePage>=pages-1;const table=document.createElement('table'),head=document.createElement('thead'),header=document.createElement('tr');for(const column of parsed.columns){const th=document.createElement('th');th.textContent=column;header.append(th);}head.append(header);table.append(head);const body=document.createElement('tbody');for(const row of parsed.records.slice(tablePage*25,(tablePage+1)*25)){const tr=document.createElement('tr');for(const col of parsed.columns){const td=document.createElement('td');td.textContent=typeof row[col]==='object'?JSON.stringify(row[col]).slice(0,100):String(row[col]??'').slice(0,120);tr.append(td);}body.append(tr);}table.append(body);host.append(table);}
 function drawChart(){const canvas=$('data-chart'),ctx=canvas.getContext('2d');canvas.width=900;canvas.height=470;ctx.fillStyle='#0b1426';ctx.fillRect(0,0,900,470);if(!parsed){$('data-chart-status').textContent='No chart data';return;}const total=parsed.records.length,pages=Math.max(1,Math.ceil(total/15));chartPage=Math.max(0,Math.min(chartPage,pages-1));$('data-chart-status').textContent=`Chart rows ${total?chartPage*15+1:0}–${Math.min(total,(chartPage+1)*15)} of ${total}`;$('data-chart-prev').disabled=chartPage===0;$('data-chart-next').disabled=chartPage>=pages-1;const col=$('data-axis').value;if(!col)return;const labels=parsed.records.slice(chartPage*15,(chartPage+1)*15).map((r,i)=>String(Object.values(r)[0]??`#${i+1}`).slice(0,9)),nums=parsed.records.slice(chartPage*15,(chartPage+1)*15).map(r=>numericValue(r[col]));if(!nums.length)return;const available=nums.filter(v=>v!==null);if(!available.length)return;const lo=Math.min(0,...available),hi=Math.max(0,...available);const range=Math.max(1,hi-lo),top=30,bottom=414,left=55,right=860;ctx.strokeStyle='#64748b';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,top);ctx.lineTo(left,bottom);ctx.lineTo(right,bottom);ctx.stroke();ctx.font='16px ui-monospace, monospace';ctx.fillStyle='#b9cbe3';for(let i=0;i<5;i++){const y=bottom-(i/4)*(bottom-top);const v=lo+(i/4)*range;ctx.fillText(v.toFixed(1),6,y+5);ctx.strokeStyle='#243854';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();}const width=(right-left)/nums.length;nums.forEach((v,i)=>{if(v===null)return;const y0=bottom-(0-lo)/range*(bottom-top),y1=bottom-(v-lo)/range*(bottom-top),barx=left+width*i+Math.min(12,width*.1),barwidth=width-Math.min(20,width*.2);ctx.fillStyle='#76d3ef';ctx.fillRect(barx,Math.min(y0,y1),barwidth,Math.max(2,Math.abs(y0-y1)));ctx.save();ctx.translate(barx+barwidth/2,450);ctx.rotate(-Math.PI/6);ctx.fillStyle='#a9b8d0';ctx.font='12px ui-monospace, monospace';ctx.textAlign='right';ctx.fillText(labels[i],0,0);ctx.restore();});}
 function doAnalyze(){const span=metrics?metrics.begin('data-analyze'):null;let ok=true;try{parsed=parseDataset($('data-input').value);tablePage=0;chartPage=0;const report=analyzeDataset(parsed);
  const groupEl=$('data-group-field'),numericEl=$('data-group-value');
  groupEl.replaceChildren();numericEl.replaceChildren();
  for(const column of parsed.columns)groupEl.add(new Option(column,column));
  for(const column of report.numeric)numericEl.add(new Option(column,column));
  $('data-group-run').disabled=parsed.columns.length<2||!report.numeric.length;
  $('data-group-output').textContent='Choose a group and numeric field, then Analyze groups.';
  $('data-status').textContent=`${report.rows} rows × ${report.columns} columns\nNumeric fields: ${report.numeric.join(', ')||'none'}\n`+Object.entries(report.stats).map(([k,v])=>`${k}: min ${v.min.toFixed(2)}, max ${v.max.toFixed(2)}, mean ${v.mean.toFixed(2)}`).join('\n');const axis=$('data-axis');axis.replaceChildren();for(const col of report.numeric)axis.add(new Option(col,col));if(!report.numeric.length)axis.add(new Option('No numeric fields',''));renderTransformFields();renderTable();drawChart();toast('Local dataset analyzed.');if(span)metrics.finish(span,'ok');}catch(e){parsed=null;tablePage=0;chartPage=0;$('data-status').textContent='Analysis failed: '+e.message;$('data-axis').replaceChildren(new Option('No numeric fields',''));renderTransformFields();renderTable();drawChart();if(span)metrics.finish(span,'error','invalid-input');toast('Analysis failed: '+e.message,true);}}
 $('data-group-run').addEventListener('click',()=>{
  const span=metrics?metrics.begin('data-analyze'):null;
  try{
   if(!parsed)throw Error('Analyze a dataset first.');
   const rows=groupNumericStats(parsed,{groupColumn:$('data-group-field').value,valueColumn:$('data-group-value').value,missingPolicy:$('data-group-missing').value});
   $('data-group-output').textContent=rows.map(item=>
    item.label.slice(0,80)+': '+item.observed+'/'+item.count+' observed, '+item.imputed+' imputed, '+item.included+' included, total '+item.total+
    ', mean '+(item.mean===null?'unknown':item.mean.toFixed(3))+
    ', min '+(item.min??'unknown')+', max '+(item.max??'unknown')
   ).join('\n')||'No groups.';
   if(span)metrics.finish(span,'ok');
   toast('Grouped local analysis ready.');
  }catch(error){if(span)metrics.finish(span,'error','invalid-input');$('data-group-output').textContent='Grouped analysis rejected: '+error.message;toast('Grouped analysis failed.',true);}
 });
 $('data-analyze').addEventListener('click',doAnalyze);$('data-axis').addEventListener('change',()=>{chartPage=0;drawChart();});$('data-table-prev').addEventListener('click',()=>{if(parsed&&tablePage>0){tablePage--;renderTable();}});$('data-table-next').addEventListener('click',()=>{if(parsed&&tablePage+1<Math.ceil(parsed.records.length/25)){tablePage++;renderTable();}});$('data-chart-prev').addEventListener('click',()=>{if(parsed&&chartPage>0){chartPage--;drawChart();}});$('data-chart-next').addEventListener('click',()=>{if(parsed&&chartPage+1<Math.ceil(parsed.records.length/15)){chartPage++;drawChart();}});$('data-import').addEventListener('change',async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;if(f.size>2_000_000)return toast('Dataset too large.',true);$('data-input').value=await f.text();doAnalyze();});$('data-export').addEventListener('click',()=>download('data-export.txt',$('data-input').value,'text/plain'));
 $('data-saved').addEventListener('change',refreshSavedDatasets);
 $('data-save').addEventListener('click',async()=>{
  try{
   parseDataset($('data-input').value);
   const content=$('data-input').value;
   if(content.length>MAX_SAVED_DATASET_CHARS)throw Error('Save limit: 500,000 characters. Export a larger dataset as a file.');
   const title=prompt('Name this local dataset:','Data Lab dataset');
   if(title===null)return;
   const name=title.trim().slice(0,90);
   if(!name)throw Error('Dataset name cannot be empty.');
   const previous=getDatasets(),existing=previous.find(x=>x.title.toLocaleLowerCase()===name.toLocaleLowerCase());
   if(existing&&!confirm('Replace saved dataset "'+existing.title+'"? This cannot be undone.'))return;
   if(!existing&&previous.length>=MAX_SAVED_DATASETS)throw Error('8 saved datasets maximum. Export or delete one before saving another.');
   const entry={id:existing?.id||'dataset-'+crypto.randomUUID(),title:name,content,created:new Date().toISOString()};
   const next=existing?previous.map(item=>item.id===existing.id?entry:item):[...previous,entry];
   if(!validateSavedDatasets(next))throw Error('Workspace dataset storage is full (2 million total characters).');
   await commitDatasets(next);
   refreshSavedDatasets();
   $('data-saved').value=entry.id;refreshSavedDatasets();
   toast('Named dataset saved into the local workspace and full backups.');
  }catch(error){toast('Dataset save failed: '+error.message,true);}
 });
 $('data-load').addEventListener('click',()=>{
  const item=getDatasets().find(x=>x.id===$('data-saved').value);
  if(!item)return toast('Choose a saved dataset.',true);
  if($('data-input').value.trim()&&!confirm('Replace the current working input with "'+item.title+'"? Export or save unsaved edits first.'))return;
  $('data-input').value=item.content;undoSource=null;doAnalyze();toast('Saved dataset loaded locally.');
 });
 $('data-delete').addEventListener('click',async()=>{
  const item=getDatasets().find(x=>x.id===$('data-saved').value);
  if(!item)return toast('Choose a saved dataset.',true);
  if(!confirm('Permanently delete saved dataset "'+item.title+'"? Full backups previously exported are unchanged.'))return;
  try{await commitDatasets(getDatasets().filter(x=>x.id!==item.id));refreshSavedDatasets();toast('Saved dataset deleted.');}
  catch(e){toast('Dataset deletion failed: '+e.message,true);}
 });
 $('data-transform').addEventListener('change',()=>{$('data-transform-value').disabled=['sort-asc','sort-desc','dedupe'].includes($('data-transform').value);});
 $('data-transform-apply').addEventListener('click',()=>{
  const span=metrics?metrics.begin('data-analyze'):null;
  try{
   if(!parsed)throw Error('Analyze data first.');
   const operation=$('data-transform').value,column=$('data-transform-field').value,value=$('data-transform-value').value;
   const result=transformDataset(parsed,{operation,column,value});
   const output=serializeDataset(result);
   if(output.length>2_000_000)throw Error('Transformed dataset exceeds the 2 MB limit.');
   const old=$('data-input').value;
   $('data-input').value=output;undoSource=old;doAnalyze();
   if(span)metrics.finish(span,'ok');
   toast('Local transformation applied ('+result.records.length+' rows). Undo is available.');
  }catch(error){if(span)metrics.finish(span,'error','invalid-input');toast('Transformation failed: '+error.message,true);}
 });
 $('data-transform-undo').addEventListener('click',()=>{
  if(undoSource===null)return;
  const source=undoSource;undoSource=null;
  $('data-input').value=source;doAnalyze();toast('Last transformation undone.');
 });
 $('data-wasm-test').addEventListener('click',async()=>{try{const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);const instance=await WebAssembly.instantiate(bytes);const sum=instance.instance.exports.add(20,22);$('data-status').textContent=`WebAssembly execution: PASS\n20 + 22 = ${sum}\nNative browser WebAssembly runtime is available.`;toast('WebAssembly test passed.');}catch(e){toast('WebAssembly failed: '+e.message,true)}});
 const canvas=$('media-canvas'),ctx=canvas.getContext('2d');
 const drawCanvas=$('media-draw-canvas');
 const brush = drawCanvas ? new BrushEngine(drawCanvas) : null;
 function syncDrawLayer(){
  if(!brush||!canvas.width) return;
  // Match the draw layer to the image canvas pixel size, then position it over the displayed image.
  if(drawCanvas.width!==canvas.width||drawCanvas.height!==canvas.height) brush.resize(canvas.width,canvas.height);
  const r=canvas.getBoundingClientRect();
  drawCanvas.style.width=r.width+'px'; drawCanvas.style.height=r.height+'px';
 }
 let activePreset='';
 // --- Drawing controls ---
 function canvasPoint(e){
  const r=drawCanvas.getBoundingClientRect();
  return { x:(e.clientX-r.left)*(drawCanvas.width/r.width), y:(e.clientY-r.top)*(drawCanvas.height/r.height), p:e.pressure||0.5 };
 }
 if(brush){
  let lastStrokeEnd=null;
  drawCanvas.addEventListener('pointerdown',e=>{
   if(!selectedImage) return toast('Load an image first, then draw.',true);
   const pt=canvasPoint(e);
   // Alt+click: sample color from the photo (eyedropper).
   if(e.altKey){
     try{
       const sx=Math.max(0,Math.min(canvas.width-1,Math.round(pt.x)));
       const sy=Math.max(0,Math.min(canvas.height-1,Math.round(pt.y)));
       const d=ctx.getImageData(sx,sy,1,1).data;
       const hex='#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
       brush.color=hex; const cp=$('draw-color'); if(cp) cp.value=hex;
       toast('Color sampled: '+hex);
     }catch{ toast('Could not sample color.',true); }
     return;
   }
   drawCanvas.setPointerCapture(e.pointerId);
   // Shift+click: straight line from end of last stroke.
   if(e.shiftKey && lastStrokeEnd && !brush.preset.smudge && !brush.preset.blur && !brush.preset.eraser){
     brush.beginStroke(lastStrokeEnd.x,lastStrokeEnd.y,0.5);
     const dx=pt.x-lastStrokeEnd.x, dy=pt.y-lastStrokeEnd.y;
     const dist=Math.hypot(dx,dy), size=brush._size(0.5);
     const step=Math.max(size*brush.preset.spacing,0.75);
     const n=Math.max(1,Math.floor(dist/step));
     for(let i=1;i<=n;i++) brush._dab(lastStrokeEnd.x+dx*(i/n), lastStrokeEnd.y+dy*(i/n), 0.5);
     brush.endStroke();
     lastStrokeEnd={x:pt.x,y:pt.y};
     $('draw-undo-stroke').disabled=false;
     return;
   }
   brush.beginStroke(pt.x,pt.y,pt.p);
   lastStrokeEnd={x:pt.x,y:pt.y};
   e.preventDefault();
  });
  const brushCursor=$('brush-cursor'), brushRing=brushCursor?.querySelector('.brush-ring');
  function updateBrushCursor(clientX,clientY){
   if(!brushCursor||!brushRing||!canvas.width) return;
   const stack=$('media-canvas-stack');
   const sr=stack.getBoundingClientRect(), cr=canvas.getBoundingClientRect();
   const scale=cr.width/canvas.width;
   const d=Math.max(6, brush.cursorSize()*scale);
   brushRing.style.width=d+'px'; brushRing.style.height=d+'px';
   brushRing.classList.toggle('soft', brush.preset.tip==='soft');
   brushCursor.style.display='block';
   brushCursor.style.left=(clientX-sr.left)+'px';
   brushCursor.style.top=(clientY-sr.top)+'px';
  }
  drawCanvas.addEventListener('pointermove',e=>{
   updateBrushCursor(e.clientX,e.clientY);
   if(!brush.drawing) return;
   const pt=canvasPoint(e); brush.moveStroke(pt.x,pt.y,pt.p);
   e.preventDefault();
  });
  drawCanvas.addEventListener('pointerleave',()=>{ if(brushCursor) brushCursor.style.display='none'; });
  for(const ev of ['pointerup','pointercancel']) drawCanvas.addEventListener(ev,e=>{
   if(!brush.drawing) return;
   const pt=canvasPoint(e); lastStrokeEnd={x:pt.x,y:pt.y};
   brush.endStroke(); $('draw-undo-stroke').disabled = brush.strokes.length===0;
  });
  for(const b of document.querySelectorAll('#draw-presets .preset-btn')) b.addEventListener('click',()=>{
   brush.setPreset(b.dataset.brush);
   for(const x of document.querySelectorAll('#draw-presets .preset-btn')) x.classList.toggle('active',x===b);
  });
  $('draw-color')?.addEventListener('input',e=>{ brush.color=e.target.value; });
  $('draw-size')?.addEventListener('input',e=>{ brush.size=Number(e.target.value); $('draw-size-val').textContent=e.target.value; });
  $('draw-opacity')?.addEventListener('input',e=>{ brush.opacity=Number(e.target.value)/100; $('draw-opacity-val').textContent=e.target.value; });
  $('draw-blend')?.addEventListener('change',e=>{ brush.blendMode=e.target.value; });
  // Smudge samples the photo canvas under each dab.
  brush.sampleSource = canvas;
  $('draw-smoothing')?.addEventListener('change',e=>{
   const def = DEFAULT_SMOOTHING[brush.preset.name] ?? 0.3;
   brush.preset = {...brush.preset, smoothing: e.target.checked ? def : 0};
  });
  $('draw-undo-stroke')?.addEventListener('click',()=>{
   if(brush.undo()){ $('draw-undo-stroke').disabled = brush.strokes.length===0; }
  });
  $('draw-clear')?.addEventListener('click',()=>{
   brush.clear(); $('draw-undo-stroke').disabled = brush.strokes.length===0; toast('Drawing cleared.');
  });
  // Photoshop-style shortcuts: [ ] brush size, 1..0 opacity. Active when the media
  // view is shown and focus isn't in a text field.
  document.addEventListener('keydown',e=>{
   if($('view-media')?.hidden) return;
   const t=e.target;
   if(t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable)) return;
   if(e.key==='['||e.key===']'){
     const sz=$('draw-size'); if(!sz) return;
     sz.value=Math.max(1,Math.min(120,Number(sz.value)+(e.key===']'?2:-2)));
     sz.dispatchEvent(new Event('input'));
     e.preventDefault();
   } else if(/^[0-9]$/.test(e.key)){
     const op=$('draw-opacity'); if(!op) return;
     op.value=e.key==='0'?100:Number(e.key)*10;
     op.dispatchEvent(new Event('input'));
     e.preventDefault();
   }
  });
 }
function currentFilter(){const blur=Number($('media-blur')?.value||0);let f=`brightness(${$('media-brightness').value}%) contrast(${$('media-contrast').value}%) saturate(${$('media-saturation').value}%)`;if(blur>0)f+=` blur(${blur}px)`;if(activePreset)f+=` ${activePreset}`;return f;}
 function editOptions(original=false){return {rotation,cropPercent,original};}
 function renderImageTo(outCtx,original=false){return paintEditedImage(outCtx,selectedImage,editOptions(original),currentFilter());}
 function redrawImage(){
  if(!selectedImage)return;
  try{
   const spec=renderImageTo(ctx);
   syncDrawLayer();
   $('media-resolution-status').textContent=`Preview: ${spec.width} × ${spec.height}px · Original: ${selectedImage.naturalWidth} × ${selectedImage.naturalHeight}px · Cropped source: ${spec.sw} × ${spec.sh}px · Export at ${$('media-original-resolution').checked?'original':'preview'} resolution · Rotation: ${rotation}°.`;
   if($('media-vignette')?.checked){const w=canvas.width,h=canvas.height;const g=ctx.createRadialGradient(w/2,h/2,Math.min(w,h)*0.35,w/2,h/2,Math.max(w,h)*0.75);g.addColorStop(0,'rgba(0,0,0,0)');g.addColorStop(1,'rgba(0,0,0,0.55)');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);}
   $('media-undo').disabled=imageUndo.length===0;
  }catch(error){$('media-resolution-status').textContent='Image update failed: '+String(error?.message||error);toast('Image update rejected.',true);}
 }
 function saveImageStep(){if(!selectedImage)return false;imageUndo.push({rotation,cropPercent});if(imageUndo.length>12)imageUndo.shift();return true;}
 $('media-image').addEventListener('change',e=>{
  const f=e.target.files?.[0];e.target.value='';if(!f)return;
  if(f.size>8_000_000||!['image/png','image/jpeg','image/webp'].includes(f.type))return toast('Use PNG, JPEG or WebP (8 MB maximum).',true);
  const url=URL.createObjectURL(f),img=new Image();
  img.onload=()=>{
   URL.revokeObjectURL(url);
   try{imageGeometry(img.naturalWidth,img.naturalHeight,{original:true});}catch(error){return toast('Image rejected: '+String(error?.message||error),true);}
   selectedImage=img;rotation=0;cropPercent=0;imageUndo=[];$('media-crop').value=0;
   if(brush){ brush.ctx.clearRect(0,0,drawCanvas.width,drawCanvas.height); brush.strokes=[]; brush.dabCount=0; const ub=$('draw-undo-stroke'); if(ub) ub.disabled=true; }
   redrawImage();toast('Image loaded locally.');
  };
  img.onerror=()=>{URL.revokeObjectURL(url);toast('Unable to read image.',true)};
  img.src=url;
 });
 for(const id of ['media-brightness','media-contrast','media-saturation','media-blur'])$(id)?.addEventListener('input',redrawImage);
$('media-vignette')?.addEventListener('change',redrawImage);
for(const b of document.querySelectorAll('#media-presets .preset-btn'))b.addEventListener('click',()=>{activePreset=b.dataset.preset;for(const x of document.querySelectorAll('#media-presets .preset-btn'))x.classList.toggle('active',x===b);redrawImage();});
const cmp=$('media-compare');
if(cmp){const showOrig=on=>{if(!selectedImage)return;try{if(on){const keep=ctx.filter;ctx.filter='none';paintEditedImage(ctx,selectedImage,{rotation:0,cropPercent:0,original:false},'brightness(100%) contrast(100%) saturate(100%)');ctx.filter=keep;}else redrawImage();}catch{}};cmp.addEventListener('pointerdown',()=>showOrig(true));for(const ev of ['pointerup','pointerleave','pointercancel'])cmp.addEventListener(ev,()=>showOrig(false));}
 $('media-crop').addEventListener('change',()=>{
  if(!selectedImage)return;
  const desired=Number($('media-crop').value);
  if(desired===cropPercent)return;
  saveImageStep();cropPercent=desired;redrawImage();
 });
 $('media-rotate-left').addEventListener('click',()=>{if(!saveImageStep())return toast('Load an image first.',true);rotation=(rotation+270)%360;redrawImage()});
 $('media-rotate-right').addEventListener('click',()=>{if(!saveImageStep())return toast('Load an image first.',true);rotation=(rotation+90)%360;redrawImage()});
 $('media-undo').addEventListener('click',()=>{
  const prev=imageUndo.pop();if(!prev)return;
  rotation=prev.rotation;cropPercent=prev.cropPercent;$('media-crop').value=cropPercent;redrawImage();
 });
 $('media-reset').addEventListener('click',()=>{
  if(selectedImage)saveImageStep();
  rotation=0;cropPercent=0;$('media-crop').value=0;
  if(brush){ brush.ctx.clearRect(0,0,drawCanvas.width,drawCanvas.height); brush.strokes=[]; brush.dabCount=0; const ub=$('draw-undo-stroke'); if(ub) ub.disabled=true; }
  for(const id of ['media-brightness','media-contrast','media-saturation'])$(id).value=100;
  activePreset='';for(const x of document.querySelectorAll('#media-presets .preset-btn'))x.classList.toggle('active',x.dataset.preset==='');const bl=$('media-blur');if(bl)bl.value=0;const vg=$('media-vignette');if(vg)vg.checked=false;redrawImage();
 });
 $('media-original-resolution').addEventListener('change',redrawImage);
 $('media-download').addEventListener('click',()=>{
  if(!selectedImage)return toast('Load an image first.',true);
  let output=canvas;
  if($('media-original-resolution').checked){
   output=document.createElement('canvas');
   const outCtx=output.getContext('2d');if(!outCtx)return toast('Cannot allocate full-resolution export.',true);
   try{renderImageTo(outCtx,true);}catch(error){return toast('Image export blocked: '+String(error?.message||error),true);}
  }
  // Composite the drawing layer onto the export.
  if(brush && drawCanvas.width>0){
   const hasDrawing = brush.dabCount>0 || brush.strokes.length>0;
   if(hasDrawing){
    if(output===canvas){
     output=document.createElement('canvas');
     output.width=canvas.width; output.height=canvas.height;
     output.getContext('2d').drawImage(canvas,0,0);
    }
    const octx=output.getContext('2d');
    // Scale drawing to output size (matches preview unless original-res export).
    octx.drawImage(drawCanvas,0,0,output.width,output.height);
   }
  }
  output.toBlob(blob=>{if(blob)download('edited-image.png',blob,'image/png');else toast('Image export failed: try preview-size export.',true);},'image/png');
 });
 const voices=$('speech-voice'),rate=$('speech-rate'),pitch=$('speech-pitch');
 function labelSpeech(){$('speech-rate-label').textContent='Speed '+Number(rate.value).toFixed(1)+'×';$('speech-pitch-label').textContent='Pitch '+Number(pitch.value).toFixed(1);}
 function refreshVoices(){
  const keep=voices.value;voices.replaceChildren(new Option('Browser default',''));
  if(!('speechSynthesis' in window)){$('speech-voices-status').textContent='Speech synthesis unavailable.';return;}
  const list=speechSynthesis.getVoices();
  const byLang={};for(const v of list){const l=(v.lang||'unknown').split('-')[0];(byLang[l]=byLang[l]||[]).push(v);}
  for(const l of Object.keys(byLang).sort()){const grp=document.createElement('optgroup');grp.label=l.toUpperCase();for(const v of byLang[l])grp.append(new Option(v.name+(v.localService?' · local':' · network'),v.voiceURI));voices.add(grp);}
  if([...voices.options].some(o=>o.value===keep))voices.value=keep;
  $('speech-voices-status').textContent=list.length+' browser-reported voice(s). Availability and privacy depend on your browser.';
 }
 labelSpeech();refreshVoices();
 if('speechSynthesis' in window)speechSynthesis.addEventListener?.('voiceschanged',refreshVoices);
 rate.addEventListener('input',labelSpeech);pitch.addEventListener('input',labelSpeech);
 $('speech-refresh-voices').addEventListener('click',refreshVoices);
 $('speech-start').addEventListener('click',()=>{
  const text=$('speech-text').value.trim();if(!text)return toast('Enter text to speak.',true);
  if(!('speechSynthesis' in window)||typeof SpeechSynthesisUtterance!=='function')return toast('Speech synthesis unavailable in this browser.',true);
  let options;try{options=validateSpeechSettings({rate:rate.value,pitch:pitch.value,voiceURI:voices.value});}catch(error){return toast(error.message,true);}
  const chosen=options.voiceURI?chooseVoice(speechSynthesis.getVoices(),options.voiceURI):null;
  if(options.voiceURI&&!chosen)return toast('Selected browser voice is no longer available.',true);
  speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(text.slice(0,2000));utterance.rate=options.rate;utterance.pitch=options.pitch;if(chosen)utterance.voice=chosen;
  const ta=$('speech-text');let hl=null;
  utterance.onboundary=e=>{if(e.charIndex==null||!ta)return;try{if(!hl){hl=document.createElement('div');hl.id='speech-highlight';ta.parentNode.insertBefore(hl,ta);hl.style.cssText='position:absolute;inset:0;pointer-events:none;font:inherit;padding:10px 12px;white-space:pre-wrap;word-break:break-word;color:transparent';ta.parentNode.style.position='relative';}const text=ta.value;const before=text.slice(0,e.charIndex);const word=text.slice(e.charIndex,e.charIndex+(e.charLength||1));const after=text.slice(e.charIndex+(e.charLength||1));hl.innerHTML='';hl.append(document.createTextNode(before));const mark=document.createElement('mark');mark.style.background='#75d8f555';mark.textContent=word;hl.append(mark);hl.append(document.createTextNode(after));}catch{}};
  const clearHl=()=>{if(hl){hl.remove();hl=null;}};
  utterance.onend=()=>{clearHl();$('speech-status').textContent='Finished speaking.';};
  utterance.onerror=e=>{clearHl();$('speech-status').textContent='Speech error: '+String(e.error||'unknown');};
  speechSynthesis.speak(utterance);$('speech-status').textContent='Speaking through '+(chosen?.name||'browser default voice')+' — words highlight as spoken.';
 });
 $('speech-stop').addEventListener('click',()=>{
  if('speechSynthesis' in window)speechSynthesis.cancel();
  if(activeRecognition){const instance=activeRecognition;activeRecognition=null;try{instance.stop();}catch(error){console.warn('Unable to stop recognition:',error);}}
  $('speech-status').textContent='Speech and dictation stopped.';
 });
 if(!window.SpeechRecognition&&!window.webkitSpeechRecognition){const db=$('speech-dictate');if(db){db.disabled=true;db.title='Dictation is not supported in this browser. Try Chrome or Edge.';}}
 $('speech-dictate').addEventListener('click',()=>{
 if(activeRecognition)return toast('Dictation is already active; use Stop speech / dictation.',true);
 const SpeechRec=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!SpeechRec)return toast('Dictation not available in this browser.',true);
 const recognition=new SpeechRec();recognition.lang=navigator.language||'en-US';
 recognition.onresult=e=>{if(activeRecognition===recognition)$('speech-text').value+=[...e.results].map(r=>r[0].transcript).join(' ');};
 recognition.onerror=e=>{if(activeRecognition===recognition)$('speech-status').textContent='Dictation error: '+e.error;};
 recognition.onend=()=>{if(activeRecognition===recognition){activeRecognition=null;$('speech-status').textContent='Dictation ended.';}};
 try{activeRecognition=recognition;recognition.start();$('speech-status').textContent='Listening; microphone permission may be requested.';}catch(e){activeRecognition=null;toast('Dictation could not start: '+e.message,true);}
});
 refreshSavedDatasets();renderTransformFields();
 return {refreshSavedDatasets};
}
