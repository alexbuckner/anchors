import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateWorkspace, removeWorkspaceTab, repairWorkspaceState,
  replaceWorkspaceTab, touchWorkspaceTab
} from '../workspace-state.js';

const spaces = new Set(['home', 'work']);

test('existing unbound tabs migrate into the active Space of their window', () => {
  const result = repairWorkspaceState({
    tabs: [
      { id: 1, windowId: 10, active: true, pinned: false },
      { id: 2, windowId: 10, active: false, pinned: false }
    ],
    bindings: {}, anchorSpaces: {}, tabSpaces: {}, activeSpaces: { 10: 'work' }, lastTabs: {},
    validSpaceIds: spaces, fallbackSpaceId: 'home'
  });
  assert.deepEqual(result.tabSpaces, { 1: 'work', 2: 'work' });
  assert.equal(result.activeSpaces[10], 'work');
  assert.equal(result.lastTabs[10].work, 1);
});

test('a restored active tab re-establishes its Space when window state is new', () => {
  const result = repairWorkspaceState({
    tabs: [{ id: 7, windowId: 10, active: true, pinned: false }],
    bindings: {}, anchorSpaces: {}, tabSpaces: { 7: 'work' }, activeSpaces: {}, lastTabs: {},
    validSpaceIds: spaces, fallbackSpaceId: 'home'
  });
  assert.equal(result.activeSpaces[10], 'work');
  assert.equal(result.lastTabs[10].work, 7);
});

test('bound anchors use their Space while global Favorites do not switch Spaces', () => {
  const base = { tabSpaces: {}, activeSpaces: { 10: 'home' }, lastTabs: {} };
  const anchored = touchWorkspaceTab({
    state: base, tab: { id: 1, windowId: 10, pinned: false },
    bindings: { anchor: 1 }, anchorSpaces: { anchor: 'work' }, fallbackSpaceId: 'home'
  });
  assert.equal(anchored.activeSpaces[10], 'work');

  const favorite = touchWorkspaceTab({
    state: anchored, tab: { id: 2, windowId: 10, pinned: false },
    bindings: { favorite: 2 }, anchorSpaces: { favorite: null }, fallbackSpaceId: 'home'
  });
  assert.equal(favorite.activeSpaces[10], 'work');
});

test('switching Spaces restores the last matching live tab', () => {
  const result = activateWorkspace({
    state: {
      tabSpaces: { 1: 'home', 2: 'work' },
      activeSpaces: { 10: 'home' },
      lastTabs: { 10: { work: 2 } }
    },
    windowId: 10, spaceId: 'work',
    tabs: [{ id: 1, windowId: 10 }, { id: 2, windowId: 10 }],
    bindings: {}, anchorSpaces: {}
  });
  assert.equal(result.activeSpaces[10], 'work');
  assert.equal(result.tabId, 2);
});

test('tab removal and replacement keep runtime Space maps consistent', () => {
  const state = {
    tabSpaces: { 1: 'work' },
    activeSpaces: { 10: 'work' },
    lastTabs: { 10: { work: 1 } }
  };
  const replaced = replaceWorkspaceTab(state, 1, 3);
  assert.deepEqual(replaced.tabSpaces, { 3: 'work' });
  assert.equal(replaced.lastTabs[10].work, 3);
  const removed = removeWorkspaceTab(replaced, 3);
  assert.deepEqual(removed.tabSpaces, {});
  assert.deepEqual(removed.lastTabs, { 10: {} });
});
