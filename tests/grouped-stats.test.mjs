import test from 'node:test';
import assert from 'node:assert/strict';
import {groupNumericStats} from '../src/data-tools.js';
const parsed={columns:['team','points'],records:[{team:'A',points:'10'},{team:'A',points:''},{team:'B',points:'5'},{team:'B',points:'-2'}]};
test('Q15 skip-missing grouping calculates counts and mean',()=>assert.deepEqual(groupNumericStats(parsed,{groupColumn:'team',valueColumn:'points'}),[
 {label:'A',count:2,observed:1,imputed:0,included:1,missing:1,total:10,mean:10,min:10,max:10},
 {label:'B',count:2,observed:2,imputed:0,included:2,missing:0,total:3,mean:1.5,min:-2,max:5}]));
test('Q15 zero missing policy: imputed rows are counted, never observed',()=>assert.deepEqual(groupNumericStats(parsed,{groupColumn:'team',valueColumn:'points',missingPolicy:'zero'}),[
 {label:'A',count:2,observed:1,imputed:1,included:2,missing:0,total:10,mean:5,min:0,max:10},
 {label:'B',count:2,observed:2,imputed:0,included:2,missing:0,total:3,mean:1.5,min:-2,max:5}]));
test('observed vs imputed: an actual zero in the source is observed',()=>{
 const p={columns:['g','v'],records:[{g:'A',v:0},{g:'A',v:10}]};
 for(const policy of ['skip','zero']){const x=groupNumericStats(p,{groupColumn:'g',valueColumn:'v',missingPolicy:policy})[0];assert.equal(x.observed,2);assert.equal(x.imputed,0);assert.equal(x.included,2);assert.equal(x.mean,5);}
 const q={columns:['g','v'],records:[{g:'A',v:0},{g:'A',v:''}]};
 const y=groupNumericStats(q,{groupColumn:'g',valueColumn:'v'})[0];
 assert.equal(y.observed,1);assert.equal(y.included,1);assert.equal(y.missing,1);assert.equal(y.mean,0);});
test('observed vs imputed: invalid non-numeric input follows the policy',()=>{
 const p={columns:['g','v'],records:[{g:'A',v:'abc'},{g:'A',v:'10'}]};
 const z=groupNumericStats(p,{groupColumn:'g',valueColumn:'v',missingPolicy:'zero'})[0];
 assert.equal(z.observed,1);assert.equal(z.imputed,1);assert.equal(z.included,2);assert.equal(z.mean,5);
 const s=groupNumericStats(p,{groupColumn:'g',valueColumn:'v'})[0];
 assert.equal(s.observed,1);assert.equal(s.imputed,0);assert.equal(s.missing,1);assert.equal(s.mean,10);});
test('observed vs imputed: entirely missing groups',()=>{
 const p={columns:['g','v'],records:[{g:'A',v:''},{g:'A',v:''}]};
 const z=groupNumericStats(p,{groupColumn:'g',valueColumn:'v',missingPolicy:'zero'})[0];
 assert.deepEqual([z.count,z.observed,z.imputed,z.included,z.missing,z.mean,z.min,z.max],[2,0,2,2,0,0,0,0]);
 const s=groupNumericStats(p,{groupColumn:'g',valueColumn:'v'})[0];
 assert.deepEqual([s.count,s.observed,s.imputed,s.included,s.missing,s.mean,s.min,s.max],[2,0,0,0,2,null,null,null]);});
test('Q15 bad columns and policy fail',()=>{assert.throws(()=>groupNumericStats(parsed,{groupColumn:'missing',valueColumn:'points'}),/distinct/);assert.throws(()=>groupNumericStats(parsed,{groupColumn:'team',valueColumn:'points',missingPolicy:'bogus'}),/policy/)});
test('Q15 distinct key cap enforced',()=>{const p={columns:['group','value'],records:Array.from({length:51},(_,i)=>({group:'k'+i,value:i}))};assert.throws(()=>groupNumericStats(p,{groupColumn:'group',valueColumn:'value'}),/50/)});
test('Q15 detects numeric overflow',()=>{const p={columns:['g','v'],records:[{g:'A',v:1e308},{g:'A',v:1e308}]};assert.throws(()=>groupNumericStats(p,{groupColumn:'g',valueColumn:'v'}),/numeric range/)});
