// Pure dataset parsing and analysis, moved verbatim from labs.js (Stage 4a).
// No DOM, no state, no side effects — these functions are the testable core
// of the Data Lab; the UI in labs.js imports and re-exports them.
export function parseCSV(text){const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=false;else value+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(value);value='';}else if(c==='\n'){row.push(value.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);row=[];value='';}else value+=c;}if(quoted)throw Error('Unclosed quoted CSV field');row.push(value.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);if(!rows.length)throw Error('Empty dataset');const rawColumns=rows.shift().map((x,i)=>x||`Column ${i+1}`);const headerNotes=[];const columns=[];const used=new Set();const unique=(base)=>{let name=base,n=2;while(used.has(name))name=`${base} (${n++})`;used.add(name);return name;};
 for(const col of rawColumns){const name=unique(col);if(name!==col)headerNotes.push(`Duplicate header "${col}" renamed to "${name}".`);columns.push(name);}
 const width=Math.max(columns.length,...rows.map(r=>r.length));
 if(width>columns.length){const added=width-columns.length;for(let i=columns.length;i<width;i++)columns.push(unique(`Column ${i+1}`));headerNotes.push(`Added ${added} column(s) for fields beyond the header row.`);}
 if(columns.length>50||rows.length>3000)throw Error('Limit: 50 columns, 3,000 rows');return {columns,records:rows.map(r=>Object.fromEntries(columns.map((col,i)=>[col,r[i]??'']))),headerNotes};}
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
export function parseDataset(text){if(!text||text.length>2_000_000)throw Error('Dataset must be under 2 MB');const t=text.trim();if(t.startsWith('[')||t.startsWith('{')){const v=JSON.parse(t);if(maxDepth(v)>100)throw Error('JSON nesting exceeds 100 levels');const arr=Array.isArray(v)?v:Array.isArray(v.data)?v.data:[v];if(arr.length>3000)throw Error('Maximum 3,000 JSON rows');const records=arr.map(x=>typeof x==='object'&&x!==null&&!Array.isArray(x)?x:{value:x});const allColumns=Array.from(new Set(records.flatMap(x=>Object.keys(x))));const columns=allColumns.slice(0,50);return {columns,records,hiddenColumns:Math.max(0,allColumns.length-50),allColumns};}return parseCSV(t);}
export function numericValue(value){
 if(value===null||value===undefined||typeof value==='boolean')return null;
 if(typeof value==='string'&&value.trim()==='')return null;
 if(typeof value!=='number'&&typeof value!=='string')return null;
 const converted=Number(value);
 return Number.isFinite(converted)?converted:null;
}
export function analyzeDataset(parsed){const columns=parsed.allColumns||parsed.columns,records=parsed.records;const numeric=columns.filter(col=>records.some(row=>numericValue(row[col])!==null));const stats={};for(const col of numeric){const arr=records.map(row=>numericValue(row[col])).filter(n=>n!==null);if(arr.length)stats[col]={count:arr.length,min:Math.min(...arr),max:Math.max(...arr),mean:arr.reduce((a,b)=>a+b,0)/arr.length};}return {rows:records.length,columns:columns.length,numeric,stats};}
