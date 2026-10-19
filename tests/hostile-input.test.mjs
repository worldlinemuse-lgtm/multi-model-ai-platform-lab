import {test} from 'node:test';
import assert from 'node:assert/strict';

// Hostile-input fuzz: every parser must reject, never crash/hang.
// Industrial bar: malformed input -> clean Error, not an exception leak,
// not a hang, not a corrupt state.

// We import the pure functions directly. DOM-dependent modules are not loaded.
import {parseDataset} from '../src/labs.js';

const HOSTILE = [
  '',                          // empty
  '   ',                       // whitespace
  '\x00\x01\x02',              // binary garbage
  '{"a":',                     // truncated JSON
  '[1,2,',                     // truncated array
  '{"a":'.repeat(10000),       // deep nesting attempt
  '['.repeat(50000)+']'.repeat(50000), // deep brackets
  'a,b\n'.repeat(100000),      // many CSV rows
  'x'.repeat(3_000_000),       // over 2MB
  '{"__proto__":{"polluted":1}}', // prototype pollution
  'constructor',               //
  'a,b\r\n1,2\r\n3',           // ragged CSV
  '"unclosed quote,a\n1,2',    // broken quoting
  '1e9999999,2\n3,4',          // extreme numbers
  '\uFEFFa,b\n1,2',            // BOM
  'a\0b,c\n1,2',               // null bytes in CSV
  JSON.stringify({data: Array(5000).fill({x:1})}), // over row limit
  JSON.stringify(Object.fromEntries(Array(100).fill(0).map((_,i)=>['k'+i,'v']))), // wide object
];

test('parseDataset never crashes on hostile input',()=>{
  for(const input of HOSTILE){
    let threw=false, result=null;
    try{ result=parseDataset(input); }
    catch(e){ threw=true; assert.ok(e instanceof Error, 'throws Error, not raw value'); }
    // Either clean throw or valid result — never a hang (test would timeout), never undefined crash.
    if(!threw){
      assert.ok(result && Array.isArray(result.columns) && Array.isArray(result.records),
        'non-throw returns well-formed result');
    }
  }
});

test('parseDataset rejects over-limit fast (no hang)',{timeout:5000},()=>{
  const big='x'.repeat(2_000_001);
  assert.throws(()=>parseDataset(big), /under 2 MB/);
  const manyRows=JSON.stringify(Array(4000).fill({a:1}));
  assert.throws(()=>parseDataset(manyRows), /3,000/);
});

test('parseDataset rejects excessive nesting depth',{timeout:5000},()=>{
  const deep='['.repeat(20000)+'1'+']'.repeat(20000);
  assert.throws(()=>parseDataset(deep),/nesting exceeds/);
  // 99 levels is fine.
  const ok='['.repeat(99)+'1'+']'.repeat(99);
  const r=parseDataset(ok);
  assert.ok(r.records.length===1);
});
