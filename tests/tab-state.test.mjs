import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignAnchorTab,
  pruneTabState,
  releaseAnchors,
  removeTab,
  replaceTab,
  touchTab
} from '../tab-state.js';

test('single-tab mode reuses one window slot and releases the old owner', () => {
  const result = assignAnchorTab({
    bindings: { a: 10 },
    lastActive: { a: 100 },
    anchorId: 'b',
    tabId: 10,
    windowTabIds: new Set([10]),
    keepAnchorTabs: false,
    now: 200
  });

  assert.deepEqual(result.bindings, { b: 10 });
  assert.deepEqual(result.lastActive, { b: 200 });
  assert.deepEqual(result.releasedTabIds, []);
});

test('single-tab mode releases extra bindings only in the target window', () => {
  const result = assignAnchorTab({
    bindings: { a: 10, b: 11, c: 20 },
    lastActive: { a: 1, b: 2, c: 3 },
    anchorId: 'b',
    tabId: 11,
    windowTabIds: new Set([10, 11]),
    keepAnchorTabs: false,
    now: 4
  });

  assert.deepEqual(result.bindings, { b: 11, c: 20 });
  assert.deepEqual(result.lastActive, { b: 4, c: 3 });
  assert.deepEqual(result.releasedTabIds, [10]);
});

test('keep-open mode preserves separate anchor tabs', () => {
  const result = assignAnchorTab({
    bindings: { a: 10 },
    lastActive: { a: 1 },
    anchorId: 'b',
    tabId: 11,
    windowTabIds: new Set([10, 11]),
    keepAnchorTabs: true,
    now: 2
  });

  assert.deepEqual(result.bindings, { a: 10, b: 11 });
  assert.deepEqual(result.releasedTabIds, []);
});

test('release removes bindings and activity but leaves tab ids for Today reset', () => {
  const result = releaseAnchors({
    bindings: { a: 10, b: 11 },
    lastActive: { a: 1, b: 2 },
    anchorIds: ['a']
  });

  assert.deepEqual(result.bindings, { b: 11 });
  assert.deepEqual(result.lastActive, { b: 2 });
  assert.deepEqual(result.releasedTabIds, [10]);
});

test('prune removes missing anchors, dead tabs, and orphan activity', () => {
  const result = pruneTabState({
    bindings: { valid: 10, deleted: 11, closed: 12 },
    lastActive: { valid: 1, deleted: 2, closed: 3, orphan: 4 },
    validAnchorIds: new Set(['valid', 'closed']),
    liveTabIds: new Set([10, 11])
  });

  assert.deepEqual(result.bindings, { valid: 10 });
  assert.deepEqual(result.lastActive, { valid: 1 });
  assert.deepEqual(result.releasedTabIds, [11]);
});

test('prune keeps only the newest owner when two anchors share one tab', () => {
  const result = pruneTabState({
    bindings: { older: 10, newer: 10 },
    lastActive: { older: 1, newer: 2 },
    validAnchorIds: new Set(['older', 'newer']),
    liveTabIds: new Set([10])
  });

  assert.deepEqual(result.bindings, { newer: 10 });
  assert.deepEqual(result.lastActive, { newer: 2 });
  assert.deepEqual(result.releasedTabIds, []);
});

test('tab removal, replacement, and activation update both state maps', () => {
  const removed = removeTab({
    bindings: { a: 10, b: 11 },
    lastActive: { a: 1, b: 2 },
    tabId: 10
  });
  assert.deepEqual(removed, { bindings: { b: 11 }, lastActive: { b: 2 } });

  assert.deepEqual(replaceTab({ bindings: { b: 11 }, oldTabId: 11, newTabId: 12 }), { b: 12 });
  assert.deepEqual(touchTab({ bindings: { b: 12 }, lastActive: { b: 2 }, tabId: 12, now: 5 }), { b: 5 });
});
