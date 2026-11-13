import test from 'node:test';import assert from 'node:assert/strict';
import {parseGitHubRepoUrl,stripTopLevelFolder,pickEntryFile,filterGitHubTreeEntries,fetchGitHubRepo} from '../src/github-import.js';

// --- URL parsing ---
test('GitHub URL: plain repo link parses to owner/repo, no branch',()=>{
 assert.deepEqual(parseGitHubRepoUrl('https://github.com/acme/widgets'),{owner:'acme',repo:'widgets',branch:null,subpath:''});
});
test('GitHub URL: tree link parses branch and subpath',()=>{
 assert.deepEqual(parseGitHubRepoUrl('https://github.com/acme/widgets/tree/main/examples/sim'),{owner:'acme',repo:'widgets',branch:'main',subpath:'examples/sim'});
});
test('GitHub URL: .git suffix and trailing slash are tolerated',()=>{
 assert.deepEqual(parseGitHubRepoUrl('https://github.com/acme/widgets.git/'),{owner:'acme',repo:'widgets',branch:null,subpath:''});
});
test('GitHub URL: non-GitHub hosts, missing parts and junk are refused in plain language',()=>{
 for(const bad of ['https://gitlab.com/acme/widgets','https://github.com/acme','https://github.com/','not a url','','https://github.com/acme/widgets/issues/3']){
  assert.throws(()=>parseGitHubRepoUrl(bad),/GitHub repo link/);
 }
});

// --- ZIP top-level folder + entry picking (pure, shared by ZIP and GitHub import) ---
test('stripTopLevelFolder: GitHub ZIP prefix is removed, other layouts untouched',()=>{
 const zipped={'widgets-main/index.html':'<h1>x</h1>','widgets-main/app.js':'1'};
 assert.deepEqual(stripTopLevelFolder(zipped),{'index.html':'<h1>x</h1>','app.js':'1'});
 assert.deepEqual(stripTopLevelFolder({'index.html':'a','app.js':'b'}),{'index.html':'a','app.js':'b'});
 assert.deepEqual(stripTopLevelFolder({'only.html':'a'}),{'only.html':'a'});
 assert.deepEqual(stripTopLevelFolder({'a/x.js':'1','b/y.js':'2'}),{'a/x.js':'1','b/y.js':'2'});
});
test('pickEntryFile: index.html at the root wins, then main.js, then the first file',()=>{
 assert.equal(pickEntryFile({'main.js':'1','index.html':'2'}),'index.html');
 assert.equal(pickEntryFile({'main.js':'1','app.js':'2'}),'main.js');
 assert.equal(pickEntryFile({'app.js':'2','lib.js':'3'}),'app.js');
 assert.equal(pickEntryFile({'web/index.html':'2','main.js':'1'}),'main.js','nested index.html is not the root entry');
});

// --- tree filtering ---
const tree=(entries)=>entries.map(([path,size,type='blob'])=>({path,size,type}));
test('filterGitHubTreeEntries: hidden paths and submodules are skipped, sizes and counts enforced',()=>{
 const {kept,skipped}=filterGitHubTreeEntries(tree([
  ['index.html',100],['app.js',200],['.github/workflows/test.yml',50],['.hidden',10],
  ['docs/.keep',5],['sub/inner.js',50],['vendor/lib',1,'commit']]),'');
 assert.deepEqual(kept.map(e=>e.path),['index.html','app.js','sub/inner.js']);
 assert.ok(skipped.some(s=>s.path==='.github/workflows/test.yml'));
 assert.ok(skipped.some(s=>s.path==='vendor/lib'));
 const {skipped:over}=filterGitHubTreeEntries(tree([['big.bin',500001]]),'');
 assert.ok(over.some(s=>s.path==='big.bin'&&/500 KB/.test(s.reason)),'one oversized file is refused with a reason, not a failed import');
 assert.throws(()=>filterGitHubTreeEntries(tree(Array.from({length:129},(_,i)=>['f'+i+'.js',10])),''),/too many|128/);
 const big=tree(Array.from({length:6},(_,i)=>['f'+i+'.js',500000]));
 assert.throws(()=>filterGitHubTreeEntries(big,''),/too much|2.5 MB/);
});
test('filterGitHubTreeEntries: subpath restricts and strips the prefix',()=>{
 const {kept}=filterGitHubTreeEntries(tree([['examples/sim/index.html',10],['examples/sim/app.js',10],['other.js',10]]),'examples/sim');
 assert.deepEqual(kept.map(e=>e.path),['index.html','app.js']);
});

// --- stub fetch for the network half ---
const PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
const PNG_BYTES=Buffer.from(PNG_B64,'base64');
function stubFetch(routes){
 return async(url)=>{
  const hit=routes[String(url)];
  if(hit instanceof Error)throw hit;
  if(!hit)return {ok:false,status:404,headers:{get:()=>null},json:async()=>({message:'Not Found'}),text:async()=>('Not Found'),arrayBuffer:async()=>new ArrayBuffer(0)};
  return {ok:hit.status<400,status:hit.status,headers:{get:(n)=>hit.headers?.[n.toLowerCase()]??null},
   json:async()=>hit.json,text:async()=>hit.text??'',arrayBuffer:async()=>hit.bytes?hit.bytes.buffer.slice(hit.bytes.byteOffset,hit.bytes.byteOffset+hit.bytes.byteLength):new ArrayBuffer(0)};
 };
}
const treeBody=(entries)=>({tree:entries.map(([path,size])=>({path,size,type:'blob',sha:'x'}))});
test('fetchGitHubRepo: pulls a public repo straight from GitHub — tree plus raw files, code and images together',async()=>{
 const fetchImpl=stubFetch({
  'https://api.github.com/repos/acme/widgets':{status:200,json:{default_branch:'main'}},
  'https://api.github.com/repos/acme/widgets/git/trees/main?recursive=1':{status:200,json:treeBody([['index.html',40],['app.js',30],['icon.png',PNG_BYTES.length],['.github/workflows/test.yml',10]])},
  'https://raw.githubusercontent.com/acme/widgets/main/index.html':{status:200,text:'<img src="icon.png">'},
  'https://raw.githubusercontent.com/acme/widgets/main/app.js':{status:200,text:'console.log(1)'},
  'https://raw.githubusercontent.com/acme/widgets/main/icon.png':{status:200,bytes:PNG_BYTES},
 });
 const out=await fetchGitHubRepo('https://github.com/acme/widgets',{fetchImpl});
 assert.equal(out.name,'widgets');
 assert.equal(out.files['index.html'],'<img src="icon.png">');
 assert.equal(out.files['app.js'],'console.log(1)');
 assert.equal(out.binaryAssets['icon.png'].mime,'image/png');
 assert.equal(out.active,'index.html');
 assert.ok(out.skipped.some(s=>s.path==='.github/workflows/test.yml'),'hidden file should be listed as skipped, not silently dropped');
});
test('fetchGitHubRepo: tree link uses its branch; slash branches resolve by retrying longer prefixes',async()=>{
 const fetchImpl=stubFetch({
  'https://api.github.com/repos/acme/widgets/git/trees/feature?recursive=1':{status:404,json:{message:'Not Found'}},
  'https://api.github.com/repos/acme/widgets/git/trees/feature/x?recursive=1':{status:200,json:treeBody([['sim/index.html',10]])},
  'https://raw.githubusercontent.com/acme/widgets/feature/x/sim/index.html':{status:200,text:'<h1>sim</h1>'},
 });
 const out=await fetchGitHubRepo('https://github.com/acme/widgets/tree/feature/x/sim',{fetchImpl});
 assert.equal(out.files['index.html'],'<h1>sim</h1>');
 assert.equal(out.active,'index.html');
});
test('fetchGitHubRepo: missing or private repo says so plainly and points at the ZIP fallback',async()=>{
 const fetchImpl=stubFetch({'https://api.github.com/repos/acme/nope':{status:404,json:{message:'Not Found'}}});
 await assert.rejects(()=>fetchGitHubRepo('https://github.com/acme/nope',{fetchImpl}),/doesn't exist or isn't public|download the ZIP/);
});
test('fetchGitHubRepo: GitHub rate limit names the limit and the ZIP fallback',async()=>{
 const fetchImpl=stubFetch({'https://api.github.com/repos/acme/widgets':{status:403,headers:{'x-ratelimit-remaining':'0'},json:{message:'API rate limit exceeded'}}});
 await assert.rejects(()=>fetchGitHubRepo('https://github.com/acme/widgets',{fetchImpl}),/hourly limit|download the ZIP/);
});
test('fetchGitHubRepo: blocked or failed network says plainly that GitHub could not be reached, with the ZIP fallback',async()=>{
 const fetchImpl=stubFetch({'https://api.github.com/repos/acme/widgets':new TypeError('Failed to fetch')});
 await assert.rejects(()=>fetchGitHubRepo('https://github.com/acme/widgets',{fetchImpl}),/couldn't reach GitHub|download the ZIP/);
});
test('fetchGitHubRepo: over-cap and bad-signature media are refused at import with a reason, and the rest still imports',async()=>{
 const bigPng=new Uint8Array(450000);bigPng.set([137,80,78,71,13,10,26,10]);
 const fakePng=new Uint8Array([1,2,3,4,5,6,7,8]);
 const fetchImpl=stubFetch({
  'https://api.github.com/repos/acme/widgets':{status:200,json:{default_branch:'main'}},
  'https://api.github.com/repos/acme/widgets/git/trees/main?recursive=1':{status:200,json:treeBody([['index.html',10],['big.png',450000],['fake.png',8]])},
  'https://raw.githubusercontent.com/acme/widgets/main/index.html':{status:200,text:'<h1>ok</h1>'},
  'https://raw.githubusercontent.com/acme/widgets/main/big.png':{status:200,bytes:bigPng},
  'https://raw.githubusercontent.com/acme/widgets/main/fake.png':{status:200,bytes:fakePng},
 });
 const out=await fetchGitHubRepo('https://github.com/acme/widgets',{fetchImpl});
 assert.equal(out.files['index.html'],'<h1>ok</h1>');
 assert.deepEqual(Object.keys(out.binaryAssets),[]);
 assert.ok(out.skipped.some(s=>s.path==='big.png'&&/400 KB/.test(s.reason)),'over-cap image must be refused with a reason');
 assert.ok(out.skipped.some(s=>s.path==='fake.png'&&/signature/.test(s.reason)),'bad-signature image must be refused with a reason');
});
