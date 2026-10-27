import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCSV, parseDataset} from '../src/labs.js';
import {groupNumericStats} from '../src/data-tools.js';

test('duplicate CSV headers are renamed, all values kept', () => {
  const p = parseCSV('name,score,score\nA,10,20\nB,5,7\n');
  assert.deepEqual(p.columns, ['name', 'score', 'score (2)']);
  assert.equal(p.records[0]['score'], '10');
  assert.equal(p.records[0]['score (2)'], '20');
  assert.equal(p.records[1]['score (2)'], '7');
  assert.ok(p.headerNotes.some(n => n.includes('Duplicate header "score"')));
  const g = groupNumericStats(p, {groupColumn: 'name', valueColumn: 'score (2)'});
  assert.equal(g[0].total, 20);
});

test('ragged CSV rows widen the column set instead of dropping fields', () => {
  const p = parseCSV('a,b\n1,2,3\n4,5\n');
  assert.deepEqual(p.columns, ['a', 'b', 'Column 3']);
  assert.equal(p.records[0]['Column 3'], '3');
  assert.equal(p.records[1]['Column 3'], '');
  assert.ok(p.headerNotes.some(n => n.includes('Added 1 column')));
  const g = groupNumericStats(p, {groupColumn: 'a', valueColumn: 'Column 3'});
  assert.equal(g[0].observed, 1);
  assert.equal(g[1].missing, 1);
});

test('CSV column limit still enforced after widening', () => {
  const header = Array.from({length: 51}, (_, i) => 'c' + i).join(',');
  assert.throws(() => parseCSV(header + '\n1\n'), /Limit: 50 columns/);
});

test('JSON over 50 columns exposes every column through allColumns', () => {
  const obj = {};
  for (let i = 0; i < 60; i++) obj['col' + i] = i;
  const p = parseDataset(JSON.stringify([obj, {...obj, col0: 1, col55: 100}]));
  assert.equal(p.columns.length, 50);
  assert.equal(p.allColumns.length, 60);
  assert.equal(p.hiddenColumns, 10);
  const g = groupNumericStats(p, {groupColumn: 'col0', valueColumn: 'col55'});
  assert.equal(g.length, 2);
  assert.equal(g[1].total, 100);
  assert.equal(g[1].observed, 1);
});
