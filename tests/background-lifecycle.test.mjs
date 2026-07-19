import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeEvent {
  constructor() { this.listeners = []; }
  addListener(listener) { this.listeners.push(listener); }
  emit(...args) {
    for (const listener of this.listeners) listener(...args);
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function storageArea(state, changedEvent, areaName) {
  return {
    async get(query) {
      if (query === null || query === undefined) return clone(state);
      if (typeof query === 'string') return { [query]: clone(state[query]) };
      if (Array.isArray(query)) {
        return Object.fromEntries(query.map(key => [key, clone(state[key])]));
      }
      const result = {};
      for (const [key, fallback] of Object.entries(query)) {
        result[key] = key in state ? clone(state[key]) : fallback;
      }
      return result;
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: clone(state[key]), newValue: clone(value) };
        state[key] = clone(value);
      }
      changedEvent.emit(changes, areaName);
    },
    async remove(keys) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!(key in state)) continue;
        changes[key] = { oldValue: clone(state[key]) };
        delete state[key];
      }
      if (Object.keys(changes).length) changedEvent.emit(changes, areaName);
    }
  };
}

const events = {
  storageChanged: new FakeEvent(),
  onCreated: new FakeEvent(),
  onRemoved: new FakeEvent(),
  onReplaced: new FakeEvent(),
  onActivated: new FakeEvent(),
  onAttached: new FakeEvent(),
  onUpdated: new FakeEvent(),
  onInstalled: new FakeEvent(),
  onStartup: new FakeEvent(),
  onMessage: new FakeEvent(),
  onAlarm: new FakeEvent(),
  onCommand: new FakeEvent()
};

const syncState = {};
const sessionState = {};
const localState = {};
const tabs = new Map();
const tabValues = new Map();
const windows = new Map();
let nextTabId = 100;
let nextWindowId = 10;
let createCount = 0;
let focusedWindowId = 1;

function tabCopy(tab) { return tab ? clone(tab) : null; }
function windowTabs(windowId) {
  return [...tabs.values()].filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);
}
function activate(tab) {
  for (const other of windowTabs(tab.windowId)) other.active = other.id === tab.id;
  focusedWindowId = tab.windowId;
}

globalThis.chrome = {
  i18n: { getMessage: () => 'Personal' },
  // Vivaldi can expose the sidePanel namespace without Chrome's behavior API.
  sidePanel: {},
  runtime: {
    onInstalled: events.onInstalled,
    onStartup: events.onStartup,
    onMessage: events.onMessage
  },
  storage: {
    sync: storageArea(syncState, events.storageChanged, 'sync'),
    session: storageArea(sessionState, events.storageChanged, 'session'),
    local: storageArea(localState, events.storageChanged, 'local'),
    onChanged: events.storageChanged
  },
  sessions: {
    async getTabValue(tabId, key) { return clone(tabValues.get(tabId)?.[key]); },
    async setTabValue(tabId, key, value) {
      const values = tabValues.get(tabId) || {};
      values[key] = clone(value);
      tabValues.set(tabId, values);
    },
    async removeTabValue(tabId, key) {
      const values = tabValues.get(tabId);
      if (!values) return;
      delete values[key];
      if (!Object.keys(values).length) tabValues.delete(tabId);
    }
  },
  tabs: {
    onCreated: events.onCreated,
    onRemoved: events.onRemoved,
    onReplaced: events.onReplaced,
    onActivated: events.onActivated,
    onAttached: events.onAttached,
    onUpdated: events.onUpdated,
    async query(query = {}) {
      let result = [...tabs.values()];
      if (query.windowId !== undefined) result = result.filter(tab => tab.windowId === query.windowId);
      if (query.lastFocusedWindow) result = result.filter(tab => tab.windowId === focusedWindowId);
      if (query.active !== undefined) result = result.filter(tab => tab.active === query.active);
      return result.map(tabCopy);
    },
    async get(tabId) {
      if (!tabs.has(tabId)) throw new Error('No tab');
      return tabCopy(tabs.get(tabId));
    },
    async create({ url = 'about:blank', windowId = focusedWindowId, active = true }) {
      createCount++;
      const tab = {
        id: nextTabId++, windowId, index: windowTabs(windowId).length,
        url, title: url, active, pinned: false, audible: false, discarded: false
      };
      tabs.set(tab.id, tab);
      if (active) activate(tab);
      events.onCreated.emit(tabCopy(tab));
      return tabCopy(tab);
    },
    async update(tabId, changes) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('No tab');
      const wasActive = tab.active;
      const changeInfo = {};
      if (changes.url !== undefined) {
        tab.url = changes.url;
        tab.title = changes.url;
        changeInfo.url = changes.url;
      }
      if (changes.active) activate(tab);
      if (changes.active && !wasActive) events.onActivated.emit({ tabId, windowId: tab.windowId });
      if (changeInfo.url) events.onUpdated.emit(tabId, changeInfo, tabCopy(tab));
      return tabCopy(tab);
    },
    async remove(tabIds) {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        const tab = tabs.get(tabId);
        if (!tab) continue;
        tabs.delete(tabId);
        events.onRemoved.emit(tabId, { windowId: tab.windowId, isWindowClosing: false });
      }
    },
    async reload() {},
    async discard(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('No tab');
      tab.discarded = true;
      return tabCopy(tab);
    }
  },
  windows: {
    WINDOW_ID_NONE: -1,
    async update(windowId, changes) {
      if (!windows.has(windowId)) throw new Error('No window');
      if (changes.focused) focusedWindowId = windowId;
      return clone(windows.get(windowId));
    },
    async create({ tabId, url = 'about:blank', focused = true } = {}) {
      const id = nextWindowId++;
      windows.set(id, { id, type: 'normal', focused });
      if (focused) focusedWindowId = id;
      let moved;
      if (tabId !== undefined) {
        moved = tabs.get(tabId);
        if (!moved) throw new Error('No tab');
        moved.windowId = id;
        moved.index = 0;
        activate(moved);
        events.onAttached.emit(tabId, { newWindowId: id, newPosition: 0 });
      } else {
        moved = await chrome.tabs.create({ url, windowId: id, active: true });
      }
      return { id, type: 'normal', focused, tabs: [tabCopy(tabs.get(moved.id))] };
    },
    async remove(windowId) {
      for (const tab of windowTabs(windowId)) await chrome.tabs.remove(tab.id);
      windows.delete(windowId);
    }
  },
  alarms: { create: () => {}, onAlarm: events.onAlarm },
  commands: { onCommand: events.onCommand }
};

await import('../background.js');

function setFixture({ keepAnchorTabs = false, restored = [] } = {}) {
  for (const state of [syncState, sessionState, localState]) {
    for (const key of Object.keys(state)) delete state[key];
  }
  tabs.clear();
  tabValues.clear();
  windows.clear();
  nextTabId = 100;
  nextWindowId = 10;
  createCount = 0;
  focusedWindowId = 1;
  windows.set(1, { id: 1, type: 'normal', focused: true });
  localState.meta = {
    version: 1,
    spaces: [{ id: 'space', name: 'Work', color: '#7c9cff' }],
    activeSpaceId: 'space',
    settings: { autoResetHours: 6, suspendMinutes: 0, archiveHours: 0, keepAnchorTabs, dedup: true }
  };
  localState['anchors_space__0'] = [
    { id: 'a', url: 'https://a.test/', title: 'A' },
    { id: 'b', url: 'https://b.test/', title: 'B' },
    { id: 'c', url: 'https://c.test/', title: 'C' }
  ];
  for (const item of restored) {
    const tab = {
      id: item.id, windowId: item.windowId || 1, index: windowTabs(item.windowId || 1).length,
      url: item.url, title: item.url, active: !!item.active,
      pinned: false, audible: false, discarded: false
    };
    tabs.set(tab.id, tab);
    if (item.spaceId) tabValues.set(tab.id, { anchorsSpaceId: item.spaceId });
    if (tab.active) activate(tab);
    nextTabId = Math.max(nextTabId, tab.id + 1);
  }
}

function send(action, payload = {}) {
  const listener = events.onMessage.listeners[0];
  return new Promise((resolve, reject) => {
    const returned = listener({ scope: 'anchors-tab-state', action, ...payload }, {}, response => {
      if (response?.ok) resolve(response);
      else reject(new Error(response?.error || 'Message failed'));
    });
    if (returned !== true) reject(new Error('Listener did not keep the response channel open'));
  });
}

async function drain() {
  await send('repair');
}

beforeEach(async () => {
  await drain().catch(() => {});
  setFixture();
  await drain();
});

test('Vivaldi-like partial sidePanel API still registers and answers tab messages', async () => {
  assert.equal(events.onMessage.listeners.length, 1);

  const handshake = await send('handshake');
  assert.equal(handshake.ok, true);
  assert.equal(handshake.protocolVersion, 3);

  const repaired = await send('repair');
  assert.equal(repaired.ok, true);
  assert.equal(repaired.protocolVersion, 3);

  const opened = await send('open', { anchorId: 'a', windowId: 1 });
  assert.equal(typeof opened.tabId, 'number');
  assert.deepEqual(sessionState.bindings, { a: opened.tabId });
});

test('A to B to A reuses one tab and keeps URL and binding aligned', async () => {
  const first = await send('open', { anchorId: 'a', windowId: 1 });
  const second = await send('open', { anchorId: 'b', windowId: 1 });
  const third = await send('open', { anchorId: 'a', windowId: 1 });
  await drain();

  assert.equal(first.tabId, second.tabId);
  assert.equal(second.tabId, third.tabId);
  assert.equal(createCount, 1);
  assert.deepEqual(sessionState.bindings, { a: first.tabId });
  assert.equal(tabs.get(first.tabId).url, 'https://a.test/');
});

test('rapid A B C commands are serialized and the last click wins', async () => {
  const results = await Promise.all([
    send('open', { anchorId: 'a', windowId: 1 }),
    send('open', { anchorId: 'b', windowId: 1 }),
    send('open', { anchorId: 'c', windowId: 1 })
  ]);
  await drain();

  assert.equal(new Set(results.map(result => result.tabId)).size, 1);
  assert.equal(createCount, 1);
  assert.deepEqual(sessionState.bindings, { c: results[2].tabId });
  assert.equal(tabs.get(results[2].tabId).url, 'https://c.test/');
});

test('keep-open mode preserves a separate tab for each anchor', async () => {
  localState.meta.settings.keepAnchorTabs = true;
  const first = await send('open', { anchorId: 'a', windowId: 1 });
  const second = await send('open', { anchorId: 'b', windowId: 1 });
  await drain();

  assert.notEqual(first.tabId, second.tabId);
  assert.equal(createCount, 2);
  assert.deepEqual(sessionState.bindings, { a: first.tabId, b: second.tabId });
});

test('a restored home tab is adopted after session state is cleared', async () => {
  setFixture({ restored: [{ id: 7, url: 'https://a.test/', active: true }] });
  const opened = await send('open', { anchorId: 'a', windowId: 1 });
  await drain();

  assert.equal(opened.tabId, 7);
  assert.equal(createCount, 0);
  assert.deepEqual(sessionState.bindings, { a: 7 });
});

test('release keeps the live page open and resets it as an unbound tab', async () => {
  const opened = await send('open', { anchorId: 'a', windowId: 1 });
  await send('release', { anchorIds: ['a'] });
  await drain();

  assert.ok(tabs.has(opened.tabId));
  assert.deepEqual(sessionState.bindings, {});
  assert.equal(typeof sessionState.tabSeen[opened.tabId], 'number');
  assert.equal(sessionState.tabSpaces[opened.tabId], 'space');
});

test('Today tabs belong to a per-window Space and switching restores the last tab', async () => {
  localState.meta.spaces.push({ id: 'home', name: 'Home', color: '#63d489' });
  const workTab = await chrome.tabs.create({ url: 'https://work.test/', windowId: 1, active: true });
  await drain();
  assert.equal(sessionState.tabSpaces[workTab.id], 'space');

  const switched = await send('activateSpace', { spaceId: 'home', windowId: 1 });
  assert.equal(switched.activeSpaceId, 'home');
  assert.equal(sessionState.activeSpaces[1], 'home');

  const homeTab = await chrome.tabs.create({ url: 'https://home.test/', windowId: 1, active: true });
  await drain();
  assert.equal(sessionState.tabSpaces[homeTab.id], 'home');

  const restored = await send('activateSpace', { spaceId: 'space', windowId: 1 });
  assert.equal(restored.tabId, workTab.id);
  assert.equal(tabs.get(workTab.id).active, true);
});

test('restored tabs recover their Space from Chromium session metadata', async () => {
  setFixture({ restored: [{ id: 7, url: 'https://home.test/', active: true, spaceId: 'home' }] });
  localState.meta.spaces.push({ id: 'home', name: 'Home', color: '#63d489' });
  await drain();
  assert.equal(sessionState.tabSpaces[7], 'home');
  assert.equal(sessionState.activeSpaces[1], 'home');
});

test('moving an active Today tab updates its Space and restart metadata', async () => {
  localState.meta.spaces.push({ id: 'home', name: 'Home', color: '#63d489' });
  const tab = await chrome.tabs.create({ url: 'https://move.test/', windowId: 1, active: true });
  await drain();
  await send('moveToday', { tabId: tab.id, spaceId: 'home' });
  assert.equal(sessionState.tabSpaces[tab.id], 'home');
  assert.equal(sessionState.activeSpaces[1], 'home');
  assert.equal(tabValues.get(tab.id).anchorsSpaceId, 'home');
});

test('Favorites are global anchors and do not change the active Space', async () => {
  localState.meta.favorites = [{ id: 'fav', url: 'https://favorite.test/', title: 'Favorite' }];
  const opened = await send('open', { anchorId: 'fav', windowId: 1 });
  await drain();
  assert.equal(tabs.get(opened.tabId).url, 'https://favorite.test/');
  assert.equal(sessionState.activeSpaces[1], 'space');
  assert.equal(sessionState.tabSpaces[opened.tabId], undefined);
});

test('queued Go Home and Open actions cannot split URL from its binding', async () => {
  const opened = await send('open', { anchorId: 'a', windowId: 1 });
  await Promise.all([
    send('open', { anchorId: 'b', windowId: 1 }),
    send('goHome', { anchorId: 'a', windowId: 1 })
  ]);
  await drain();

  assert.deepEqual(sessionState.bindings, { a: opened.tabId });
  assert.equal(tabs.get(opened.tabId).url, 'https://a.test/');
});
