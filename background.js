import {
  loadMeta, loadAllAnchors, normalizeUrl,
  getBindings, setBindings, getLastActive, setLastActive
} from './shared.js';
import { syncNow } from './sync.js';

// Clicking the extension action opens the side panel in Chrome, Edge, and Brave.
// Vivaldi uses panel.html as a manually configured Web Panel; see README.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const isWebUrl = (u) => typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'));

function ensureAlarms() {
  chrome.alarms.create('maintenance', { periodInMinutes: 10 });
  chrome.alarms.create('gistSync', { periodInMinutes: 5 });
}
chrome.runtime.onInstalled.addListener(ensureAlarms);
chrome.runtime.onStartup.addListener(ensureAlarms);

// Debounce Gist pushes so a burst of local edits produces one remote update.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  chrome.alarms.create('gistPush', { delayInMinutes: 0.5 });
});

// ---------- tab tracking ----------

async function getTabSeen() {
  const { tabSeen } = await chrome.storage.session.get('tabSeen');
  return tabSeen || {};
}
async function setTabSeen(m) {
  await chrome.storage.session.set({ tabSeen: m });
}

chrome.tabs.onCreated.addListener(async (tab) => {
  const seen = await getTabSeen();
  seen[tab.id] = Date.now();
  await setTabSeen(seen);
});

// Remove bindings and tracking data when a tab is closed.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const b = await getBindings();
  let changed = false;
  for (const [anchorId, tid] of Object.entries(b)) {
    if (tid === tabId) { delete b[anchorId]; changed = true; }
  }
  if (changed) await setBindings(b);
  const seen = await getTabSeen();
  if (tabId in seen) { delete seen[tabId]; await setTabSeen(seen); }
});

// Some Chromium variants replace a discarded tab with a new id; update bindings.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const b = await getBindings();
  let changed = false;
  for (const [anchorId, tid] of Object.entries(b)) {
    if (tid === removedTabId) { b[anchorId] = addedTabId; changed = true; }
  }
  if (changed) await setBindings(b);
});

// Track the last time an anchor tab was active for auto-reset and suspension.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const b = await getBindings();
  for (const [anchorId, tid] of Object.entries(b)) {
    if (tid === tabId) {
      const la = await getLastActive();
      la[anchorId] = Date.now();
      await setLastActive(la);
      break;
    }
  }
});

// ---------- duplicate protection: focus an existing anchor instead of a copy ----------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url || !isWebUrl(changeInfo.url)) return;
  const meta = await loadMeta();
  if (!meta.settings.dedup) return;

  const bindings = await getBindings();
  if (Object.values(bindings).includes(tabId)) return; // Navigation inside an anchor tab.

  const anchors = await loadAllAnchors(meta);
  const nu = normalizeUrl(changeInfo.url);
  const anchor = anchors.find(a => normalizeUrl(a.url) === nu);
  if (!anchor) return;

  const boundTabId = bindings[anchor.id];
  if (boundTabId) {
    const bound = await chrome.tabs.get(boundTabId).catch(() => null);
    if (bound && tab.active) {
      // Focus the existing anchor and close the active duplicate.
      await chrome.tabs.update(bound.id, { active: true }).catch(() => {});
      await chrome.windows.update(bound.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.remove(tabId).catch(() => {});
    } else if (!bound) {
      bindings[anchor.id] = tabId;
      await setBindings(bindings);
    }
  } else {
    // The anchor was closed, so bind this new tab to it.
    bindings[anchor.id] = tabId;
    await setBindings(bindings);
    const la = await getLastActive();
    la[anchor.id] = Date.now();
    await setLastActive(la);
  }
});

// ---------- periodic maintenance: auto-reset, suspension, and archive ----------

async function runMaintenance() {
  const meta = await loadMeta();
  const anchors = await loadAllAnchors(meta);
  const byId = Object.fromEntries(anchors.map(a => [a.id, a]));
  const b = await getBindings();
  const la = await getLastActive();
  const seen = await getTabSeen();
  const now = Date.now();

  const allTabs = await chrome.tabs.query({});
  for (const t of allTabs) {
    if (!(t.id in seen)) seen[t.id] = now;
  }

  const resetHours = meta.settings.autoResetHours;
  const suspendMin = meta.settings.suspendMinutes;
  const boundIds = new Set(Object.values(b));

  // 1) Return idle anchors home. 2) Suspend idle anchors.
  for (const [anchorId, tabId] of Object.entries(b)) {
    const anchor = byId[anchorId];
    if (!anchor) continue;
    let tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) { delete b[anchorId]; continue; }
    if (tab.active) { la[anchorId] = now; continue; }

    const idleMs = now - (la[anchorId] || 0);

    if (resetHours && normalizeUrl(tab.url) !== normalizeUrl(anchor.url) &&
        idleMs >= resetHours * 3600 * 1000) {
      tab = await chrome.tabs.update(tabId, { url: anchor.url }).catch(() => null);
      la[anchorId] = now;
      continue; // Let the home page load before considering suspension.
    }

    if (suspendMin && tab && !tab.discarded && !tab.audible &&
        idleMs >= suspendMin * 60 * 1000) {
      const replacement = await chrome.tabs.discard(tabId).catch(() => null);
      if (replacement && replacement.id !== tabId) {
        b[anchorId] = replacement.id;
      }
    }
  }

  // 3) Archive old unbound tabs.
  const archiveHours = meta.settings.archiveHours;
  if (archiveHours) {
    const { archive } = await chrome.storage.local.get('archive');
    const arch = archive || [];
    let archived = 0;
    for (const t of allTabs) {
      if (t.pinned || t.active || t.audible || boundIds.has(t.id) || !isWebUrl(t.url)) continue;
      const age = now - (seen[t.id] || now);
      if (age >= archiveHours * 3600 * 1000) {
        arch.unshift({ url: t.url, title: t.title || t.url, at: now });
        await chrome.tabs.remove(t.id).catch(() => {});
        delete seen[t.id];
        archived++;
      }
    }
    if (archived) {
      await chrome.storage.local.set({ archive: arch.slice(0, 500) });
    }
  }

  await setBindings(b);
  await setLastActive(la);
  await setTabSeen(seen);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'gistSync' || alarm.name === 'gistPush') {
    await syncNow().catch(() => {});
    return;
  }
  if (alarm.name === 'maintenance' || alarm.name === 'autoReset') {
    await runMaintenance();
  }
});

// Keyboard shortcut: return the current anchor tab to its saved home URL.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'go-home') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const b = await getBindings();
  const meta = await loadMeta();
  const anchors = await loadAllAnchors(meta);
  for (const [anchorId, tabId] of Object.entries(b)) {
    if (tabId === tab.id) {
      const anchor = anchors.find(a => a.id === anchorId);
      if (anchor) await chrome.tabs.update(tab.id, { url: anchor.url });
      return;
    }
  }
});
