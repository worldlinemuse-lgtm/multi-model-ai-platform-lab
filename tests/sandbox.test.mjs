import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {runnerDocument,previewDocument,previewReport} from '../src/sandbox.js';
import {binaryRecord} from '../src/binary-assets.js';
const PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
const pngRecord=()=>binaryRecord('icon.png',Buffer.from(PNG_B64,'base64'));
const wavBytes=()=>{const b=new Uint8Array(16);b.set([82,73,70,70,0,0,0,0,87,65,86,69,0,0,0,0]);return b;};
const mp3Bytes=()=>new Uint8Array([0x49,0x44,0x33,0,0,0,0,0]);
test('JS document never grants same-origin, CSP blocks network',()=>{const src=runnerDocument('console.log("ok")','javascript','random-nonce');assert.match(src,/worker-src blob:/);assert.match(src,/connect-src 'none'/);assert.match(src,/mm-sandbox-b03/);assert.ok(!src.includes('allow-same-origin'));const script=src.match(/<script>([\s\S]+?)<\/script>/)?.[1];assert.ok(script);assert.doesNotThrow(()=>new vm.Script(script));});
test('JS runner serializes markup-breaking code safely',()=>{const src=runnerDocument('console.log("</script><script>bad</script>")','javascript','nonce');assert.equal((src.match(/<script>/g)||[]).length,1);assert.equal((src.match(/<\/script>/g)||[]).length,1);});
test('Python loads an isolated CDN WASM runtime on demand',()=>{const src=runnerDocument('print(42)','python','nonce');assert.match(src,/cdn.jsdelivr.net/);assert.match(src,/worker-src blob:/);assert.match(src,/Pyodide/);});
test('preview CSP blocks connect and no same origin',()=>{const html=previewDocument({'index.html':'<link rel="stylesheet" href="site.css"><h1>hi</h1><script src="main.js"></script>','site.css':'body{color:red}','main.js':'console.log("x")'},'index.html');assert.match(html,/connect-src 'none'/);assert.match(html,/<h1>hi<\/h1>/);assert.match(html,/body\{color:red\}/);assert.match(html,/console.log\("x"\)/);});

test('P04: linked virtual assets resolve relative to selected nested HTML; unused files are not injected',()=>{
 const files={
  'web/index.html':'<link href="./css/site.css?version=1" rel="stylesheet"><div id="result"></div><script src="./js/helper.js"></script><script src="../app.js"></script>',
  'web/css/site.css':'#result { color: red; }',
  'web/js/helper.js':'window.VERSION="FIRST";',
  'app.js':'document.querySelector("#result").textContent=window.VERSION;',
  'unused.css':'.wrong { color: orange }',
  'unused.js':'throw Error("unrelated JS must never run")'
 };
 const rendered=previewReport(files,'web/index.html');
 assert.deepEqual(rendered.warnings,[]);
 assert.ok(rendered.document.indexOf('window.VERSION=')<rendered.document.indexOf('document.querySelector'));
 assert.match(rendered.document,/data-local-href="web\/css\/site.css"/);
 assert.match(rendered.document,/data-local-src="app.js"/);
 assert.ok(!rendered.document.includes('unrelated JS must never run'));
 assert.ok(!rendered.document.includes('color: orange'));
});
test('P04: block external URLs, traversal and missing assets; module scripts now link instead of being skipped',()=>{
 const files={'web/index.html':'<script src="https://example.org/attack.js"></script><script src="../../escape.js"></script><link rel="stylesheet" href="missing.css"><script type="module" src="./mod.js"></script><script src="./good.js"></script>',
  'web/good.js':'console.log("GOOD")','web/mod.js':'export const n=42;',
  'escape.js':'console.log("ESCAPED")'};
 const out=previewReport(files,'web/index.html');
 assert.equal(out.warnings.length,3);
 assert.match(out.document,/GOOD/);
 assert.ok(!out.document.includes('ESCAPED'));
 assert.ok(!out.document.includes('attack.js"'));
 assert.match(out.document,/data-local-module="web\/mod.js"/,'module entry must link to a blob bootstrap, not be skipped');
 assert.match(out.document,/export const n/,'module source rides in the linked graph');
 assert.match(out.warnings.join(' | '),/external reference blocked/);
 assert.match(out.warnings.join(' | '),/outside project root/);
 assert.match(out.warnings.join(' | '),/local asset not found/);
 assert.ok(!out.warnings.join(' | ').includes('module imports are not supported'),'Stage B: modules are supported now');
});
test('P04: escape closing tags inside local scripts and CSS',()=>{
 const files={
  'index.html':'<link rel="stylesheet" href="style.css"><script src="app.js"></script>',
  'style.css':'/* </style> */ body{color:red}',
  'app.js':'console.log("</script><script>BAD</script>")'
 };
 const html=previewDocument(files,'index.html');
 assert.equal((html.match(/<\/script>/g)||[]).length,1,'script injection must not close the inline script');
 assert.equal((html.match(/<\/style>/g)||[]).length,1,'style injection must not close the inline style');
 assert.match(html,/script-src 'unsafe-inline'/);
 assert.match(html,/connect-src 'none'/);
});

// Stage A: full-asset preview — local media refs become data URIs, never network loads.
test('Stage A: img src rewrites to a data URI with the right MIME from binary assets',()=>{
 const files={'index.html':'<img src="icon.png" alt="icon">'};
 const out=previewReport(files,'index.html',{'icon.png':pngRecord()});
 assert.deepEqual(out.warnings,[]);
 assert.match(out.document,/src="data:image\/png;base64,iVBORw0KGgo/);
 assert.ok(!out.document.includes('src="icon.png"'));
});
test('Stage A: missing image warns by name and leaves no broken reference',()=>{
 const files={'index.html':'<img src="gone.png" alt="gone"><p>after</p>'};
 const out=previewReport(files,'index.html',{});
 assert.equal(out.warnings.length,1);
 assert.match(out.warnings[0],/gone\.png/);
 assert.ok(!out.document.includes('gone.png'),'missing ref must not survive in the document');
 // Exact tag match, space included: the old loose /<img[^>]*alt=.../ also
 // matched the fused <imgalt="gone"> a stripped src used to emit, so
 // this case stayed green while the stage had no img element at all.
 assert.match(out.document,/<img alt="gone">/);
 assert.ok(!out.document.includes('src='),'stripped img must carry no src at all');
 assert.ok(!out.document.includes('imgalt'),'stripped tag must not fuse with its attributes');
});
test('Stage A: missing video poster is stripped and the video tag stays intact',()=>{
 const files={'index.html':'<video poster="gone.png" controls></video><img src="gone.png">'};
 const out=previewReport(files,'index.html',{});
 assert.equal(out.warnings.length,2);
 assert.match(out.document,/<video controls><\/video>/);
 assert.match(out.document,/<img>/);
 assert.ok(!out.document.includes('gone.png'));
 assert.ok(!out.document.includes('videocontrols'),'stripped tag must not fuse with its attributes');
});
test('Stage A: audio, video poster and source elements rewrite from binary assets',()=>{
 const files={'index.html':'<audio src="sfx.wav" controls></audio><video poster="icon.png"><source src="song.mp3"></video>'};
 const assets={'sfx.wav':binaryRecord('sfx.wav',wavBytes()),'song.mp3':binaryRecord('song.mp3',mp3Bytes()),'icon.png':pngRecord()};
 const out=previewReport(files,'index.html',assets);
 assert.deepEqual(out.warnings,[]);
 assert.match(out.document,/audio[^>]*src="data:audio\/wav;base64,/);
 assert.match(out.document,/video[^>]*poster="data:image\/png;base64,/);
 assert.match(out.document,/source[^>]*src="data:audio\/mpeg;base64,/);
});
test('Stage A: CSS url() rewrites to data URIs; a missing CSS image warns by name and becomes none',()=>{
 const files={'index.html':'<link rel="stylesheet" href="style.css">','style.css':'.a{background-image:url(icon.png)}.b{background-image:url("gone.png")}'};
 const out=previewReport(files,'index.html',{'icon.png':pngRecord()});
 assert.equal(out.warnings.length,1);
 assert.match(out.warnings[0],/gone\.png/);
 assert.match(out.document,/url\("data:image\/png;base64,/);
 assert.match(out.document,/\.b\{background-image:none\}/);
 assert.ok(!out.document.includes('gone.png'));
});
test('Stage A: external and traversal media refs are blocked, warned and stripped',()=>{
 const files={'index.html':'<img src="https://evil.example/x.png"><img src="../escape.png"><img src="data:image/png;base64,AAA">'};
 const out=previewReport(files,'index.html',{'escape.png':pngRecord()});
 assert.equal(out.warnings.length,2);
 assert.match(out.warnings.join(' | '),/external reference blocked/);
 assert.match(out.warnings.join(' | '),/outside project root/);
 assert.ok(!out.document.includes('evil.example'));
 assert.ok(!out.document.includes('escape.png'));
 assert.match(out.document,/src="data:image\/png;base64,AAA"/,'inline data: URIs pass through untouched');
});
test('Stage A: text SVG falls back to a data URI; non-media text files are refused by name',()=>{
 const files={'index.html':'<img src="logo.svg"><img src="notes.txt">','logo.svg':'<svg xmlns="http://www.w3.org/2000/svg"></svg>','notes.txt':'hello'};
 const out=previewReport(files,'index.html',{});
 assert.equal(out.warnings.length,1);
 assert.match(out.warnings[0],/notes\.txt/);
 assert.match(out.document,/src="data:image\/svg\+xml;base64,/);
 assert.ok(!out.document.includes('notes.txt'));
});
test('Stage A: preview CSP allows data: media so rewritten audio/video can actually play',()=>{
 const html=previewDocument({'index.html':'<audio src="s.mp3"></audio>'},'index.html');
 assert.match(html,/media-src data: blob:/);
 assert.match(html,/img-src data: blob:/);
 assert.match(html,/connect-src 'none'/);
});

// Stage B: ES modules in preview — module scripts link to blob URLs and run
// instead of previewing with their code missing.
test('Stage B: module entry with a relative import links to a blob bootstrap, no warning',()=>{
 const files={
  'index.html':'<div id="m">Waiting</div><script type="module" src="app.js"></script>',
  'app.js':"import {msg} from './helper.js';\ndocument.querySelector('#m').textContent=msg;",
  'helper.js':"export const msg='MODULE_OK';"
 };
 const out=previewReport(files,'index.html');
 assert.deepEqual(out.warnings,[]);
 assert.ok(!out.document.includes('module imports are not supported'));
 assert.match(out.document,/script-src 'unsafe-inline' blob:/);
 assert.match(out.document,/data-local-module="app.js"/);
 assert.match(out.document,/createObjectURL/);
 assert.match(out.document,/linkModuleGraph/);
 assert.match(out.document,/MODULE_OK/,'module source rides in the linked graph');
 assert.ok(!out.document.includes('<script type="module"'),'entry tag must be replaced by the bootstrap, not left to 404');
 // Every script block in the emitted document must parse as JavaScript.
 for(const block of out.document.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)){
  assert.doesNotThrow(()=>new vm.Script(block[1]),'bootstrap must be valid JS');
 }
});
test('Stage B: missing module dependency warns by name and strips the module tag',()=>{
 const files={
  'index.html':'<script type="module" src="app.js"></script><div id="m">Waiting</div>',
  'app.js':"import './gone.js';\ndocument.querySelector('#m').textContent='RAN';"
 };
 const out=previewReport(files,'index.html');
 assert.equal(out.warnings.length,1);
 assert.match(out.warnings[0],/gone\.js/);
 assert.ok(!out.document.includes('data-local-module'));
 assert.ok(!out.document.includes('RAN'),'unlinked module source must not survive in the document');
});
test('Stage B: external module src is blocked and warned; dynamic import() is refused with a warning',()=>{
 const files={
  'index.html':'<script type="module" src="https://evil.example/x.js"></script><script type="module" src="dyn.js"></script>',
  'dyn.js':"const m=await import('./helper.js');",
  'helper.js':"export const x=1;"
 };
 const out=previewReport(files,'index.html');
 assert.equal(out.warnings.length,2);
 assert.match(out.warnings.join(' | '),/external reference blocked/);
 assert.match(out.warnings.join(' | '),/Dynamic import\(\) is not supported/);
 assert.ok(!out.document.includes('data-local-module'));
 assert.ok(!out.document.includes('evil.example'));
});
test('Stage B: module source containing a closing script tag cannot break out of the bootstrap',()=>{
 const files={
  'index.html':'<script type="module" src="app.js"></script>',
  'app.js':"export const s='</script><script>alert(1)</script>';"
 };
 const out=previewReport(files,'index.html');
 assert.deepEqual(out.warnings,[]);
 assert.equal((out.document.match(/<\/script>/g)||[]).length,1,'bootstrap must not leak a closing tag');
});
test('Stage B: preview CSP allows blob: module loads and still blocks network',()=>{
 const html=previewDocument({'index.html':'<script type="module" src="app.js"></script>','app.js':"export const x=1;"},'index.html');
 assert.match(html,/script-src 'unsafe-inline' blob:/);
 assert.match(html,/connect-src 'none'/);
 assert.match(html,/data-local-module="app.js"/);
});
