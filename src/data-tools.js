// Pure, bounded Data Lab operations. All work stays on the user's device.
export const MAX_SAVED_DATASETS=8;
export const MAX_SAVED_DATASET_CHARS=500000;
export const MAX_SAVED_DATASET_TOTAL_CHARS=2000000;

export function validateSavedDatasets(items){
 if(items===undefined)return true; // Older backups predate saved datasets.
 if(!Array.isArray(items)||items.length>MAX_SAVED_DATASETS)return false;
 const ids=new Set();
 let total=0;
 for(const item of items){
  if(!item||typeof item!=='object'||Array.isArray(item)||
     typeof item.id!=='string'||!item.id||item.id.length>140||
     typeof item.title!=='string'||!item.title.trim()||item.title.length>90||
     typeof item.created!=='string'||item.created.length>80||
     typeof item.content!=='string'||item.content.length>MAX_SAVED_DATASET_CHARS||
     ids.has(item.id))return false;
  ids.add(item.id);
  total+=item.content.length;
  if(total>MAX_SAVED_DATASET_TOTAL_CHARS)return false;
 }
 return true;
}
function numerical(value){
 if(value===null||value===undefined||typeof value==='boolean'||typeof value==='object')return null;
 if(typeof value==='string'&&value.trim()==='')return null;
 const number=Number(value);
 return Number.isFinite(number)?number:null;
}
function cell(row,column){return Object.hasOwn(row,column)?row[column]:null;}
function asText(value){if(value===null||value===undefined)return '';if(typeof value==='object')return JSON.stringify(value);return String(value);}
function compareCells(a,b){
 const na=numerical(a),nb=numerical(b);
 if(na===null&&asText(a).trim()==='')return nb===null&&asText(b).trim()===''?0:1;
 if(nb===null&&asText(b).trim()==='')return -1;
 if(na!==null&&nb!==null)return na-nb;
 return asText(a).localeCompare(asText(b),undefined,{numeric:true,sensitivity:'base'});
}
export const DATA_TRANSFORMS=Object.freeze(['filter-contains','filter-equals','filter-gt','filter-lt','sort-asc','sort-desc','dedupe']);
export function transformDataset(parsed,{operation,column='',value=''}={}){
 if(!parsed||!Array.isArray(parsed.columns)||!Array.isArray(parsed.records))throw Error('Analyze a dataset first.');
 if(!DATA_TRANSFORMS.includes(operation))throw Error('Choose an available transformation.');
 if(column&&!parsed.columns.includes(column))throw Error('Choose a column in this dataset.');
 if(operation!=='dedupe'&&!column)throw Error('Choose a column first.');
 const rows=parsed.records.slice(),input=String(value);
 let result;
 if(operation==='filter-contains'){
  result=rows.filter(row=>asText(cell(row,column)).toLocaleLowerCase().includes(input.toLocaleLowerCase()));
 }else if(operation==='filter-equals'){
  result=rows.filter(row=>asText(cell(row,column))===input);
 }else if(operation==='filter-gt'||operation==='filter-lt'){
  const threshold=numerical(input);
  if(threshold===null)throw Error('Numeric filters require a finite number.');
  result=rows.filter(row=>{const number=numerical(cell(row,column));return number!==null&&(operation==='filter-gt'?number>threshold:number<threshold);});
 }else if(operation==='sort-asc'||operation==='sort-desc'){
  result=rows.sort((a,b)=>{const cmp=compareCells(cell(a,column),cell(b,column));return operation==='sort-desc'?-cmp:cmp;});
 }else {
  const seen=new Set();
  result=rows.filter(row=>{const key=column?JSON.stringify(cell(row,column)):JSON.stringify(parsed.columns.map(name=>cell(row,name)));
   if(seen.has(key))return false;seen.add(key);return true;});
 }
 return {columns:parsed.columns.slice(),records:result};
}
export function serializeDataset(parsed){
 if(!parsed||!Array.isArray(parsed.records))throw Error('No dataset to export.');
 // JSON retains numeric and quoted-string distinctions (CSV rewriting would not).
 return JSON.stringify(parsed.records,null,2);
}

/* Bounded browser-local grouped numeric statistics. No remote APIs. */
export function groupNumericStats(parsed,{groupColumn,valueColumn,missingPolicy='skip'}={}){
 if(!parsed||!Array.isArray(parsed.columns)||!Array.isArray(parsed.records)||parsed.records.length>3000)throw Error('Analyze a bounded dataset first.');
 if(!parsed.columns.includes(groupColumn)||!parsed.columns.includes(valueColumn)||groupColumn===valueColumn)throw Error('Choose distinct group and numeric columns.');
 if(!['skip','zero'].includes(missingPolicy))throw Error('Invalid missing-value policy.');
 const map=new Map();
 for(const row of parsed.records){
  const rawKey=row?.[groupColumn];
  if(rawKey!==null&&rawKey!==undefined&&typeof rawKey==='object')throw Error('Complex grouping keys are not supported.');
  const key=rawKey===null||rawKey===undefined||String(rawKey).trim()===''?'(missing)':String(rawKey);
  if(key.length>500)throw Error('Group key exceeds 500 characters.');
  if(!map.has(key)){
   if(map.size>=50)throw Error('Maximum 50 distinct groups.');
   map.set(key,{label:key,count:0,observed:0,imputed:0,sum:0,min:null,max:null});
  }
  const item=map.get(key);item.count++;
  const raw=row?.[valueColumn];
  const numeric=raw===null||raw===undefined||typeof raw==='boolean'||typeof raw==='object'||String(raw).trim()===''?null:Number(raw);
  let amount=Number.isFinite(numeric)?numeric:null;
  if(amount===null){
   // Unusable value: missing (absent/blank) or invalid (non-numeric).
   // The selected policy decides explicitly, and the two cases are never
   // conflated in the counts: skip excludes the row; zero imputes 0 and
   // counts it as imputed, never as observed. A real numeric in the
   // source, including an actual 0, always counts as observed.
   if(missingPolicy==='zero'){amount=0;item.imputed++;}
   else continue;
  }else item.observed++;
  item.sum+=amount;
  if(!Number.isFinite(item.sum))throw Error('Grouped sum exceeds numeric range.');
  item.min=item.min===null?amount:Math.min(item.min,amount);
  item.max=item.max===null?amount:Math.max(item.max,amount);
 }
 return [...map.values()].map(({label,count,observed,imputed,sum,min,max})=>{const included=observed+imputed;return {label,count,observed,imputed,included,missing:count-included,total:sum,mean:included?sum/included:null,min,max};});
}
