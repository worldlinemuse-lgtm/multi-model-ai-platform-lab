import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BRUSH_PRESETS,DEFAULT_SMOOTHING,BLEND_MODES} from '../src/draw.js';

test('five brush presets defined as data',()=>{
  const ids=Object.keys(BRUSH_PRESETS);
  assert.deepEqual(ids,['pencil','ink','marker','soft','eraser','smudge']);
  for(const [id,p] of Object.entries(BRUSH_PRESETS)){
    assert.ok(p.name, id+' has name');
    assert.ok(['hard','soft'].includes(p.tip), id+' tip kind');
    assert.ok(typeof p.smoothing==='number' && p.smoothing>=0 && p.smoothing<1, id+' smoothing in range');
    assert.ok(typeof p.eraser==='boolean', id+' eraser flag');
  }
});

test('pencil has no smoothing, ink has pulled-string smoothing',()=>{
  assert.equal(BRUSH_PRESETS.pencil.smoothing, 0);
  assert.ok(BRUSH_PRESETS.ink.smoothing > 0.5, 'ink pulls hard');
});

test('eraser uses destination-out composite',()=>{
  assert.equal(BRUSH_PRESETS.eraser.eraser, true);
  assert.ok(!Object.values(BRUSH_PRESETS).filter(p=>p!==BRUSH_PRESETS.eraser).some(p=>p.eraser));
});

test('default smoothing map covers every preset',()=>{
  for(const p of Object.values(BRUSH_PRESETS)){
    assert.ok(typeof DEFAULT_SMOOTHING[p.name]==='number', p.name);
  }
});

test('marker is wider and more transparent than pencil',()=>{
  assert.ok(BRUSH_PRESETS.marker.sizeMul > BRUSH_PRESETS.pencil.sizeMul);
  assert.ok(BRUSH_PRESETS.marker.opacityMul < BRUSH_PRESETS.pencil.opacityMul);
});

test('16 blend modes including normal',()=>{
  assert.equal(BLEND_MODES[0],'source-over');
  assert.equal(BLEND_MODES.length,16);
  for(const m of ['multiply','screen','overlay','difference','hue','color','luminosity']) assert.ok(BLEND_MODES.includes(m), m);
});

test('smudge preset samples rather than paints fixed color',()=>{
  assert.equal(BRUSH_PRESETS.smudge.smudge, true);
  assert.ok(!Object.values(BRUSH_PRESETS).filter(p=>p!==BRUSH_PRESETS.smudge).some(p=>p.smudge));
});
