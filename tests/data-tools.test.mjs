import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDataset} from '../src/data-parse.js';
import {freshState,clone,validateState} from '../src/core.js';
import {DATA_TRANSFORMS,transformDataset,serializeDataset,validateSavedDatasets,MAX_SAVED_DATASET_CHARS} from '../src/data-tools.js';

const sample=()=>parseDataset('name,score,group\nAlpha,10,green\nBeta,,blue\nGamma,20,green\nAlpha,10,green');
test('P19: local filters preserve missing numeric semantics',()=>{
 const d=sample();
 assert.deepEqual(transformDataset(d,{operation:'filter-gt',column:'score',value:'10'}).records.map(x=>x.name),['Gamma']);
 assert.deepEqual(transformDataset(d,{operation:'filter-lt',column:'score',value:'11'}).records.map(x=>x.name),['Alpha','Alpha']);
 assert.deepEqual(transformDataset(d,{operation:'filter-contains',column:'group',value:'GRE'}).records.map(x=>x.name),['Alpha','Gamma','Alpha']);
 assert.deepEqual(transformDataset(d,{operation:'filter-equals',column:'name',value:'Alpha'}).records.map(x=>x.score),['10','10']);
 assert.throws(()=>transformDataset(d,{operation:'filter-gt',column:'score',value:'bad'}),/finite number/);
});
test('P19: numeric sorting and deduplication are stable',()=>{
 const d=sample();
 assert.deepEqual(transformDataset(d,{operation:'sort-asc',column:'score'}).records.map(x=>x.name),['Alpha','Alpha','Gamma','Beta']);
 assert.deepEqual(transformDataset(d,{operation:'sort-desc',column:'score'}).records.slice(0,1).map(x=>x.name),['Beta']); // Missing values sorted first descending by design
 assert.equal(transformDataset(d,{operation:'dedupe'}).records.length,3);
 assert.equal(transformDataset(d,{operation:'dedupe',column:'group'}).records.length,2);
 assert.throws(()=>transformDataset(d,{operation:'sort-asc',column:'bad'}),/Choose a column/);
 assert.deepEqual(DATA_TRANSFORMS.length,7);
});
test('P19: transformed records serialize and roundtrip as local JSON',()=>{
 const d=transformDataset(sample(),{operation:'filter-contains',column:'name',value:'alpha'});
 const json=serializeDataset(d);
 assert.deepEqual(parseDataset(json).records,d.records);
 assert.deepEqual(JSON.parse(serializeDataset({columns:['x'],records:[]})),[]);
});
test('P18: bounded saved dataset metadata roundtrips full backups',()=>{
 const s=freshState();
 s.datasets=[{id:'dataset-1',title:'QA sample',content:'name,value\nA,1\nB,2',created:'2026-10-12T20:00:00Z'}];
 assert.equal(validateState(s),true);
 assert.equal(validateState(JSON.parse(JSON.stringify(s))),true);
 const legacy=clone(s);delete legacy.datasets;
 assert.equal(validateState(legacy),true,'old backups with no datasets remain supported');
 const bad=clone(s);bad.datasets[0].content='x'.repeat(MAX_SAVED_DATASET_CHARS+1);
 assert.equal(validateState(bad),false);
 const duplicates=clone(s);duplicates.datasets.push({...duplicates.datasets[0]});
 assert.equal(validateSavedDatasets(duplicates.datasets),false);
 const full=clone(s);full.datasets=Array.from({length:8},(_,i)=>({id:'dataset-'+i,title:'Dataset '+i,content:'x'.repeat(400000),created:'now'}));
 assert.equal(validateState(full),false,'enforce total workspace dataset cap');
});
