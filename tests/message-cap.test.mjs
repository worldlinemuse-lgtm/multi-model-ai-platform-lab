import test from 'node:test';
import assert from 'node:assert/strict';
import {capMessageContent, MAX_STORED_MESSAGE_CHARS} from '../src/core.js';

test('message cap: short content is stored unchanged', () => {
  assert.equal(capMessageContent('hello'), 'hello');
  assert.equal(capMessageContent('x'.repeat(MAX_STORED_MESSAGE_CHARS)), 'x'.repeat(MAX_STORED_MESSAGE_CHARS));
  assert.equal(capMessageContent(undefined), undefined);
});

test('message cap: oversized content is truncated with a marker naming the original length', () => {
  const long = 'A'.repeat(35000);
  const capped = capMessageContent(long);
  assert.ok(capped.length < long.length);
  assert.ok(capped.startsWith('A'.repeat(MAX_STORED_MESSAGE_CHARS)));
  assert.match(capped, /\[truncated/);
  assert.match(capped, /35000 characters/);
  assert.match(capped, /usage counts are from the provider/);
});
