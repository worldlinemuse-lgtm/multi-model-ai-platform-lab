import test from 'node:test';
import assert from 'node:assert/strict';
import {CROSS_TAB_CHANNEL,revisionOf,isCrossTabConflict,nextRevision,crossTabConflictMessage} from '../src/cross-tab.js';
import {freshState,validateState} from '../src/core.js';

test('cross-tab: legacy states without a revision read as 0, never as a conflict on first save',()=>{
  assert.equal(revisionOf({}),0);
  assert.equal(revisionOf(null),0);
  assert.equal(revisionOf({revision:-1}),0);
  assert.equal(revisionOf({revision:1.5}),0);
  assert.equal(revisionOf({revision:7}),7);
  assert.equal(nextRevision(0,null),1);
  assert.equal(nextRevision(null,{revision:7}),8);
});

test('cross-tab: a stored revision different from the last seen revision is a conflict',()=>{
  assert.equal(isCrossTabConflict({revision:1},0),true);
  assert.equal(isCrossTabConflict({revision:2},2),false);
  assert.equal(isCrossTabConflict(null,0),false);
  assert.equal(isCrossTabConflict({revision:1},null),false);
  assert.match(crossTabConflictMessage({revision:3},1),/revision 3/);
  assert.equal(CROSS_TAB_CHANNEL,'mm-studio-cross-tab');
});

test('cross-tab: fresh states carry revision 0 and validateState accepts or rejects revisions',()=>{
  const state=freshState();
  assert.equal(state.revision,0);
  assert.equal(validateState(state),true);
  assert.equal(validateState({...state,revision:12}),true);
  assert.equal(validateState({...state,revision:-1}),false);
  assert.equal(validateState({...state,revision:1.5}),false);
  assert.equal(validateState({...state,revision:'3'}),false);
});
