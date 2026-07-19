import {
  loadMeta, loadAllAnchors, normalizeUrl,
  getBindings, setBindings, getLastActive, setLastActive,
  ensureLocalStorage, isPersistentKey, purgeLegacyBrowserSync
} from './shared.js';
import {
  assignAnchorTab, pruneTabState, releaseAnchors,
  removeTab, replaceTab, touchTab
} from './tab-state.js';
import { syncNow } from './sync.js';

// Clicking the extension action opens the side panel in Chrome, Edge, and Brave.
// Vivaldi uses panel.html as a manually configured Web Panel; see README.
try {
  const setupSidePanel = chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  setupSidePanel?.catch?.(() => {});
} catch {
  // Some Chromium variants expose only a partial sidePanel namespace.
}

const TAB_MESSAGE_SCOPE = 'anchors-tab-state';
const isWebUrl = (u) => typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'));

// The service worker is the sole writer of runtime tab state. Serializing every
// mutation prevents rapid panel clicks, tab events, and maintenance from
// overwriting one another with stale read-modify-write snapshots.
let tabStateQueue = Promise.resolve();
function enqueueTabState(task) {
  const run = tabStateQueue.then(task, task);
  tabStateQueue = run.catch(() => {});
  return run;
}

function ensureAlarms() {
  chrome.alarms.create('maintenance', { periodInMinutes: 10 });
  chrome.alarms.create('gistSync', { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  enqueueTabState(() => prepareRuntime({ reconcileSingle: true })).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  enqueueTabState(() => prepareRuntime({ reconcileSingle: true })).catch(() => {});
});

// Debounce Gist pushes so a burst of local edits produces one remote update.
// Anchor or settings changes also trigger a defensive runtime-state repair.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    purgeLegacyBrowserSync().catch(() => {});
    return;
  }
  if (area !== 'local' || !Object.keys(changes).some(isPersistentKey)) return;
  chrome.alarms.create('gistPush', { delayInMinutes: 0.5 });
  // Persistent writes can touch metadata, chunks, and the commit marker in
  // separate operations. Recreate the one-shot alarm until the batch is quiet.
  if (changes.meta || changes.updatedAt || Object.keys(changes).some(key => key.startsWith('anchors_'))) {
    chrome.alarms.create('stateRepair', { delayInMinutes: 0.1 });
  }
});

// Upgrade legacy plaintext browser-sync data as soon as the worker wakes, even
// if the side panel has not been opened yet.
ensureLocalStorage().catch(() => {});

// ---------- runtime tab state ----------

async function getTabSeen() {
  const { tabSeen } = await chrome.storage.session.get('tabSeen');
  return tabSeen || {};
}

async function setTabSeen(tabSeen) {
  await chrome.storage.session.set({ tabSeen });
}

async function persistRuntime(ctx) {
  await Promise.all([
    setBindings(ctx.bindings),
    setLastActive(ctx.lastActive),
    setTabSeen(ctx.seen)
  ]);
}

function applyStatePlan(ctx, plan, now = Date.now()) {
  ctx.bindings = plan.bindings;
  ctx.lastActive = plan.lastActive;
  for (const tabId of plan.releasedTabIds || []) {
    ctx.seen[tabId] = now;
  }
}

function pickWindowSlot(ctx, windowTabs) {
  const ownerByTab = new Map(Object.entries(ctx.bindings).map(([anchorId, tabId]) => [tabId, anchorId]));
  const candidates = windowTabs.filter(tab => ownerByTab.has(tab.id));
  if (!candidates.length) return null;
  return candidates.find(tab => tab.active) || candidates.sort((a, b) => {
    const aOwner = ownerByTab.get(a.id);
    const bOwner = ownerByTab.get(b.id);
    return (ctx.lastActive[bOwner] || 0) - (ctx.lastActive[aOwner] || 0) || a.index - b.index;
  })[0];
}

async function reconcileSingleWindows(ctx) {
  if (ctx.meta.settings.keepAnchorTabs) return;

  const tabsById = new Map(ctx.allTabs.map(tab => [tab.id, tab]));
  const recordsByWindow = new Map();
  for (const [anchorId, tabId] of Object.entries(ctx.bindings)) {
    const tab = tabsById.get(tabId);
    if (!tab) continue;
    if (!recordsByWindow.has(tab.windowId)) recordsByWindow.set(tab.windowId, []);
    recordsByWindow.get(tab.windowId).push({ anchorId, tab });
  }

  for (const [windowId, records] of recordsByWindow) {
    if (records.length <= 1) continue;
    const winner = records.find(record => record.tab.active) || records.sort((a, b) => {
      return (ctx.lastActive[b.anchorId] || 0) - (ctx.lastActive[a.anchorId] || 0) ||
        a.tab.index - b.tab.index;
    })[0];
    const windowTabIds = new Set(ctx.allTabs.filter(tab => tab.windowId === windowId).map(tab => tab.id));
    applyStatePlan(ctx, assignAnchorTab({
      bindings: ctx.bindings,
      lastActive: ctx.lastActive,
      anchorId: winner.anchorId,
      tabId: winner.tab.id,
      windowTabIds,
      keepAnchorTabs: false
    }));
  }
}

async function prepareRuntime({ reconcileSingle = false } = {}) {
  const meta = await loadMeta();
  const [anchors, allTabs, bindings, lastActive, seen] = await Promise.all([
    loadAllAnchors(meta),
    chrome.tabs.query({}),
    getBindings(),
    getLastActive(),
    getTabSeen()
  ]);
  const now = Date.now();
  const liveTabIds = new Set(allTabs.map(tab => tab.id));
  const plan = pruneTabState({
    bindings,
    lastActive,
    validAnchorIds: new Set(anchors.map(anchor => anchor.id)),
    liveTabIds
  });
  const ctx = {
    meta,
    anchors,
    allTabs,
    bindings: plan.bindings,
    lastActive: plan.lastActive,
    seen: Object.assign({}, seen)
  };

  for (const tabId of plan.releasedTabIds) ctx.seen[tabId] = now;
  for (const tab of allTabs) {
    if (!(tab.id in ctx.seen)) ctx.seen[tab.id] = now;
  }
  for (const tabId of Object.keys(ctx.seen)) {
    if (!liveTabIds.has(Number(tabId))) delete ctx.seen[tabId];
  }

  if (reconcileSingle) await reconcileSingleWindows(ctx);
  await persistRuntime(ctx);
  return ctx;
}

async function assignInContext(ctx, anchorId, tab) {
  const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
  const plan = assignAnchorTab({
    bindings: ctx.bindings,
    lastActive: ctx.lastActive,
    anchorId,
    tabId: tab.id,
    windowTabIds: new Set(windowTabs.map(item => item.id)),
    keepAnchorTabs: !!ctx.meta.settings.keepAnchorTabs
  });
  applyStatePlan(ctx, plan);
  if (!(tab.id in ctx.seen)) ctx.seen[tab.id] = Date.now();
  await persistRuntime(ctx);
}

async function releaseInContext(ctx, anchorIds) {
  applyStatePlan(ctx, releaseAnchors({
    bindings: ctx.bindings,
    lastActive: ctx.lastActive,
    anchorIds
  }));
  await persistRuntime(ctx);
}

async function createBoundTab(ctx, anchor, windowId) {
  const previous = {
    bindings: Object.assign({}, ctx.bindings),
    lastActive: Object.assign({}, ctx.lastActive),
    seen: Object.assign({}, ctx.seen)
  };
  const blank = await chrome.tabs.create({ url: 'about:blank', windowId, active: true });
  try {
    await assignInContext(ctx, anchor.id, blank);
    const tab = await chrome.tabs.update(blank.id, { url: anchor.url, active: true });
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    return tab;
  } catch (error) {
    ctx.bindings = previous.bindings;
    ctx.lastActive = previous.lastActive;
    ctx.seen = previous.seen;
    await persistRuntime(ctx).catch(() => {});
    await chrome.tabs.remove(blank.id).catch(() => {});
    throw error;
  }
}

async function openAnchor(anchorId, windowId) {
  const ctx = await prepareRuntime();
  const anchor = ctx.anchors.find(item => item.id === anchorId);
  if (!anchor) throw new Error('Anchor not found');

  let tab = ctx.bindings[anchor.id]
    ? await chrome.tabs.get(ctx.bindings[anchor.id]).catch(() => null)
    : null;

  if (tab) {
    await assignInContext(ctx, anchor.id, tab);
    if (tab.active && tab.windowId === windowId) {
      if (normalizeUrl(tab.url) !== normalizeUrl(anchor.url)) {
        tab = await chrome.tabs.update(tab.id, { url: anchor.url });
      }
    } else {
      tab = await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return { tabId: tab.id, windowId: tab.windowId };
  }

  const windowTabs = await chrome.tabs.query({ windowId });
  const boundTabIds = new Set(Object.values(ctx.bindings));
  const restored = windowTabs.find(item => {
    return !boundTabIds.has(item.id) && normalizeUrl(item.url) === normalizeUrl(anchor.url);
  });
  if (restored) {
    await assignInContext(ctx, anchor.id, restored);
    tab = await chrome.tabs.update(restored.id, { active: true });
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    return { tabId: tab.id, windowId: tab.windowId };
  }

  if (!ctx.meta.settings.keepAnchorTabs) {
    const slot = pickWindowSlot(ctx, windowTabs);
    if (slot) {
      const previous = {
        bindings: Object.assign({}, ctx.bindings),
        lastActive: Object.assign({}, ctx.lastActive),
        seen: Object.assign({}, ctx.seen)
      };
      await assignInContext(ctx, anchor.id, slot);
      tab = await chrome.tabs.update(slot.id, { url: anchor.url, active: true }).catch(() => null);
      if (tab) {
        await chrome.windows.update(windowId, { focused: true }).catch(() => {});
        return { tabId: tab.id, windowId: tab.windowId };
      }
      ctx.bindings = previous.bindings;
      ctx.lastActive = previous.lastActive;
      ctx.seen = previous.seen;
      await persistRuntime(ctx);
      return createBoundTab(await prepareRuntime(), anchor, windowId).then(created => ({
        tabId: created.id,
        windowId: created.windowId
      }));
    }
  }

  tab = await createBoundTab(ctx, anchor, windowId);
  return { tabId: tab.id, windowId: tab.windowId };
}

async function bindAnchor(anchorId, tabId) {
  const ctx = await prepareRuntime();
  if (!ctx.anchors.some(anchor => anchor.id === anchorId)) throw new Error('Anchor not found');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('Tab not found');
  await assignInContext(ctx, anchorId, tab);
  return { tabId: tab.id, windowId: tab.windowId };
}

async function goHome(anchorId, windowId) {
  const ctx = await prepareRuntime();
  const anchor = ctx.anchors.find(item => item.id === anchorId);
  if (!anchor) throw new Error('Anchor not found');
  const tab = ctx.bindings[anchor.id]
    ? await chrome.tabs.get(ctx.bindings[anchor.id]).catch(() => null)
    : null;
  if (!tab) return openAnchor(anchorId, windowId);
  if (normalizeUrl(tab.url) !== normalizeUrl(anchor.url)) {
    await chrome.tabs.update(tab.id, { url: anchor.url });
  }
  return { tabId: tab.id, windowId: tab.windowId };
}

async function popOutAnchor(anchorId) {
  const ctx = await prepareRuntime();
  const anchor = ctx.anchors.find(item => item.id === anchorId);
  if (!anchor) throw new Error('Anchor not found');
  const tab = ctx.bindings[anchor.id]
    ? await chrome.tabs.get(ctx.bindings[anchor.id]).catch(() => null)
    : null;
  if (tab) {
    const win = await chrome.windows.create({ tabId: tab.id, focused: true });
    return { tabId: tab.id, windowId: win.id };
  }

  const win = await chrome.windows.create({ url: 'about:blank', focused: true });
  const blank = win.tabs?.[0];
  if (!blank) throw new Error('Could not create a window');
  try {
    await assignInContext(ctx, anchor.id, blank);
    const opened = await chrome.tabs.update(blank.id, { url: anchor.url });
    return { tabId: opened.id, windowId: win.id };
  } catch (error) {
    await releaseInContext(ctx, [anchor.id]).catch(() => {});
    await chrome.windows.remove(win.id).catch(() => {});
    throw error;
  }
}

async function reloadAnchor(anchorId) {
  const ctx = await prepareRuntime();
  const tabId = ctx.bindings[anchorId];
  if (tabId) await chrome.tabs.reload(tabId, { bypassCache: true }).catch(() => {});
  return {};
}

async function handleDuplicateNavigation(tabId, changeInfo) {
  if (!changeInfo.url || !isWebUrl(changeInfo.url)) return;
  const [meta, bindings] = await Promise.all([loadMeta(), getBindings()]);
  if (!meta.settings.dedup || Object.values(bindings).includes(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (normalizeUrl(tab.url) !== normalizeUrl(changeInfo.url)) return;
  const preliminaryAnchors = await loadAllAnchors(meta);
  if (!preliminaryAnchors.some(item => normalizeUrl(item.url) === normalizeUrl(tab.url))) return;
  const ctx = await prepareRuntime();
  if (!ctx.meta.settings.dedup || Object.values(ctx.bindings).includes(tabId)) return;

  const normalized = normalizeUrl(changeInfo.url);
  const anchor = ctx.anchors.find(item => normalizeUrl(item.url) === normalized);
  if (!anchor) return;

  const boundTabId = ctx.bindings[anchor.id];
  if (boundTabId) {
    const bound = await chrome.tabs.get(boundTabId).catch(() => null);
    if (bound && tab.active) {
      await assignInContext(ctx, anchor.id, bound);
      const activated = await chrome.tabs.update(bound.id, { active: true }).catch(() => null);
      if (activated) {
        await chrome.windows.update(bound.windowId, { focused: true }).catch(() => {});
        await chrome.tabs.remove(tabId).catch(() => {});
      } else {
        await releaseInContext(ctx, [anchor.id]);
        const current = await chrome.tabs.get(tabId).catch(() => null);
        if (current) await assignInContext(ctx, anchor.id, current);
      }
    }
    return;
  }

  // In single-tab mode, do not let a background navigation steal a window
  // that already has an anchor slot. An active navigation becomes the slot.
  if (!ctx.meta.settings.keepAnchorTabs && !tab.active) {
    const windowTabs = await chrome.tabs.query({ windowId: tab.windowId });
    if (pickWindowSlot(ctx, windowTabs)) return;
  }
  await assignInContext(ctx, anchor.id, tab);
}

// ---------- browser tab events ----------

chrome.tabs.onCreated.addListener((tab) => {
  enqueueTabState(async () => {
    const seen = await getTabSeen();
    seen[tab.id] = Date.now();
    await setTabSeen(seen);
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueTabState(async () => {
    const [bindings, lastActive, seen] = await Promise.all([getBindings(), getLastActive(), getTabSeen()]);
    const next = removeTab({ bindings, lastActive, tabId });
    delete seen[tabId];
    await Promise.all([setBindings(next.bindings), setLastActive(next.lastActive), setTabSeen(seen)]);
  }).catch(() => {});
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueueTabState(async () => {
    const [bindings, seen] = await Promise.all([getBindings(), getTabSeen()]);
    const nextBindings = replaceTab({ bindings, oldTabId: removedTabId, newTabId: addedTabId });
    seen[addedTabId] = seen[addedTabId] || seen[removedTabId] || Date.now();
    delete seen[removedTabId];
    await Promise.all([setBindings(nextBindings), setTabSeen(seen)]);
  }).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  enqueueTabState(async () => {
    const [bindings, lastActive] = await Promise.all([getBindings(), getLastActive()]);
    await setLastActive(touchTab({ bindings, lastActive, tabId }));
  }).catch(() => {});
});

chrome.tabs.onAttached.addListener((tabId) => {
  enqueueTabState(async () => {
    const ctx = await prepareRuntime();
    if (ctx.meta.settings.keepAnchorTabs) return;
    const owner = Object.entries(ctx.bindings).find(([, boundTabId]) => boundTabId === tabId)?.[0];
    if (!owner) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await assignInContext(ctx, owner, tab);
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !isWebUrl(changeInfo.url)) return;
  enqueueTabState(() => handleDuplicateNavigation(tabId, changeInfo)).catch(() => {});
});

// ---------- panel commands ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.scope !== TAB_MESSAGE_SCOPE) return undefined;

  const handlers = {
    open: () => openAnchor(message.anchorId, message.windowId),
    bind: () => bindAnchor(message.anchorId, message.tabId),
    goHome: () => goHome(message.anchorId, message.windowId),
    popOut: () => popOutAnchor(message.anchorId),
    reload: () => reloadAnchor(message.anchorId),
    release: async () => {
      const ctx = await prepareRuntime();
      await releaseInContext(ctx, message.anchorIds || []);
      return {};
    },
    repair: async () => {
      const ctx = await prepareRuntime({ reconcileSingle: true });
      return { bindingCount: Object.keys(ctx.bindings).length };
    }
  };
  const handler = handlers[message.action];
  if (!handler) {
    sendResponse({ ok: false, error: 'Unknown tab action' });
    return undefined;
  }

  enqueueTabState(handler).then(
    result => sendResponse(Object.assign({ ok: true }, result || {})),
    error => sendResponse({ ok: false, error: error?.message || String(error) })
  );
  return true;
});

// ---------- periodic maintenance ----------

async function runMaintenance() {
  const ctx = await prepareRuntime({ reconcileSingle: true });
  const byId = Object.fromEntries(ctx.anchors.map(anchor => [anchor.id, anchor]));
  const now = Date.now();
  const resetHours = ctx.meta.settings.autoResetHours;
  const suspendMin = ctx.meta.settings.suspendMinutes;

  // 1) Return idle anchors home. 2) Suspend idle anchors.
  for (const [anchorId, tabId] of Object.entries(ctx.bindings)) {
    const anchor = byId[anchorId];
    if (!anchor) continue;
    let tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      const next = removeTab({ bindings: ctx.bindings, lastActive: ctx.lastActive, tabId });
      ctx.bindings = next.bindings;
      ctx.lastActive = next.lastActive;
      continue;
    }
    if (tab.active) {
      ctx.lastActive[anchorId] = now;
      continue;
    }

    const idleMs = now - (ctx.lastActive[anchorId] || 0);
    if (resetHours && normalizeUrl(tab.url) !== normalizeUrl(anchor.url) &&
        idleMs >= resetHours * 3600 * 1000) {
      tab = await chrome.tabs.update(tabId, { url: anchor.url }).catch(() => null);
      ctx.lastActive[anchorId] = now;
      continue; // Let the home page load before considering suspension.
    }

    if (suspendMin && tab && !tab.discarded && !tab.audible &&
        idleMs >= suspendMin * 60 * 1000) {
      const replacement = await chrome.tabs.discard(tabId).catch(() => null);
      if (replacement && replacement.id !== tabId) {
        ctx.bindings = replaceTab({ bindings: ctx.bindings, oldTabId: tabId, newTabId: replacement.id });
        ctx.seen[replacement.id] = ctx.seen[tabId] || now;
        delete ctx.seen[tabId];
      }
    }
  }

  // 3) Archive old unbound tabs. Released anchors start a fresh age counter.
  const archiveHours = ctx.meta.settings.archiveHours;
  if (archiveHours) {
    const { archive } = await chrome.storage.local.get('archive');
    const arch = archive || [];
    const boundIds = new Set(Object.values(ctx.bindings));
    let archived = 0;
    for (const tab of ctx.allTabs) {
      if (tab.pinned || tab.active || tab.audible || boundIds.has(tab.id) || !isWebUrl(tab.url)) continue;
      const age = now - (ctx.seen[tab.id] || now);
      if (age >= archiveHours * 3600 * 1000) {
        arch.unshift({ url: tab.url, title: tab.title || tab.url, at: now });
        await chrome.tabs.remove(tab.id).catch(() => {});
        delete ctx.seen[tab.id];
        archived++;
      }
    }
    if (archived) await chrome.storage.local.set({ archive: arch.slice(0, 500) });
  }

  await persistRuntime(ctx);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'gistSync' || alarm.name === 'gistPush') {
    await syncNow().catch(() => {});
    return;
  }
  if (alarm.name === 'maintenance' || alarm.name === 'autoReset') {
    await enqueueTabState(runMaintenance).catch(() => {});
    return;
  }
  if (alarm.name === 'stateRepair') {
    await enqueueTabState(() => prepareRuntime({ reconcileSingle: true })).catch(() => {});
  }
});

// Keyboard shortcut: return the current anchor tab to its saved home URL.
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'go-home') return;
  enqueueTabState(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    const ctx = await prepareRuntime();
    const anchorId = Object.entries(ctx.bindings).find(([, tabId]) => tabId === tab.id)?.[0];
    const anchor = ctx.anchors.find(item => item.id === anchorId);
    if (anchor) await chrome.tabs.update(tab.id, { url: anchor.url });
  }).catch(() => {});
});
