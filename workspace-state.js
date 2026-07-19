// Pure helpers for local, per-window Space state. Persistent Space definitions
// sync through the encrypted Gist; live tab ids never leave storage.session.

const cloneMap = value => Object.assign({}, value || {});
const cloneNestedMap = value => Object.fromEntries(
  Object.entries(value || {}).map(([key, nested]) => [key, cloneMap(nested)])
);

function validSpace(validSpaceIds, candidate, fallbackSpaceId) {
  return validSpaceIds.has(candidate) ? candidate : fallbackSpaceId;
}

function ownerByTab(bindings) {
  return new Map(Object.entries(bindings || {}).map(([anchorId, tabId]) => [tabId, anchorId]));
}

export function tabSpaceId({ tabId, bindings, anchorSpaces, tabSpaces, owners = null }) {
  const owner = (owners || ownerByTab(bindings)).get(tabId);
  if (owner) return anchorSpaces?.[owner] || null; // Favorites are global.
  return tabSpaces?.[tabId] || null;
}

export function repairWorkspaceState({
  tabs,
  bindings,
  anchorSpaces,
  tabSpaces,
  activeSpaces,
  lastTabs,
  validSpaceIds,
  fallbackSpaceId
}) {
  const valid = validSpaceIds instanceof Set ? validSpaceIds : new Set(validSpaceIds || []);
  const liveTabs = new Map((tabs || []).map(tab => [tab.id, tab]));
  const boundTabs = new Set(Object.values(bindings || {}));
  const owners = ownerByTab(bindings);
  const nextTabSpaces = cloneMap(tabSpaces);
  const nextActiveSpaces = cloneMap(activeSpaces);
  const nextLastTabs = cloneNestedMap(lastTabs);
  const windowIds = new Set((tabs || []).map(tab => tab.windowId));
  const explicitActiveWindows = new Set(
    Object.entries(activeSpaces || {})
      .filter(([, spaceId]) => valid.has(spaceId))
      .map(([windowId]) => Number(windowId))
  );

  for (const windowId of windowIds) {
    nextActiveSpaces[windowId] = validSpace(valid, nextActiveSpaces[windowId], fallbackSpaceId);
  }
  for (const windowId of Object.keys(nextActiveSpaces)) {
    if (!windowIds.has(Number(windowId)) || !valid.has(nextActiveSpaces[windowId])) delete nextActiveSpaces[windowId];
  }

  for (const tab of tabs || []) {
    if (tab.pinned || boundTabs.has(tab.id)) {
      delete nextTabSpaces[tab.id];
      continue;
    }
    nextTabSpaces[tab.id] = validSpace(
      valid,
      nextTabSpaces[tab.id],
      nextActiveSpaces[tab.windowId] || fallbackSpaceId
    );
  }
  for (const tabId of Object.keys(nextTabSpaces)) {
    if (!liveTabs.has(Number(tabId)) || !valid.has(nextTabSpaces[tabId])) delete nextTabSpaces[tabId];
  }

  for (const [windowId, bySpace] of Object.entries(nextLastTabs)) {
    if (!windowIds.has(Number(windowId))) {
      delete nextLastTabs[windowId];
      continue;
    }
    for (const [spaceId, tabId] of Object.entries(bySpace)) {
      const tab = liveTabs.get(tabId);
      const belongs = tab && tab.windowId === Number(windowId) &&
        tabSpaceId({ tabId, bindings, anchorSpaces, tabSpaces: nextTabSpaces, owners }) === spaceId;
      if (!valid.has(spaceId) || !belongs) delete bySpace[spaceId];
    }
    if (!Object.keys(bySpace).length) delete nextLastTabs[windowId];
  }

  for (const tab of tabs || []) {
    if (!tab.active) continue;
    const spaceId = tabSpaceId({ tabId: tab.id, bindings, anchorSpaces, tabSpaces: nextTabSpaces, owners });
    if (!valid.has(spaceId) ||
        (explicitActiveWindows.has(tab.windowId) && nextActiveSpaces[tab.windowId] !== spaceId)) continue;
    nextActiveSpaces[tab.windowId] = spaceId;
    nextLastTabs[tab.windowId] ||= {};
    nextLastTabs[tab.windowId][spaceId] = tab.id;
  }

  return { tabSpaces: nextTabSpaces, activeSpaces: nextActiveSpaces, lastTabs: nextLastTabs };
}

export function activateWorkspace({ state, windowId, spaceId, tabs, bindings, anchorSpaces }) {
  const next = {
    tabSpaces: cloneMap(state.tabSpaces),
    activeSpaces: cloneMap(state.activeSpaces),
    lastTabs: cloneNestedMap(state.lastTabs)
  };
  next.activeSpaces[windowId] = spaceId;

  const inWindow = (tabs || []).filter(tab => tab.windowId === windowId);
  const owners = ownerByTab(bindings);
  const remembered = next.lastTabs[windowId]?.[spaceId];
  const candidate = inWindow.find(tab => tab.id === remembered &&
    tabSpaceId({ tabId: tab.id, bindings, anchorSpaces, tabSpaces: next.tabSpaces, owners }) === spaceId) ||
    inWindow.find(tab => tabSpaceId({ tabId: tab.id, bindings, anchorSpaces, tabSpaces: next.tabSpaces, owners }) === spaceId) ||
    null;

  if (candidate) {
    next.lastTabs[windowId] ||= {};
    next.lastTabs[windowId][spaceId] = candidate.id;
  }
  return { ...next, tabId: candidate?.id || null };
}

export function touchWorkspaceTab({ state, tab, bindings, anchorSpaces, fallbackSpaceId }) {
  const next = {
    tabSpaces: cloneMap(state.tabSpaces),
    activeSpaces: cloneMap(state.activeSpaces),
    lastTabs: cloneNestedMap(state.lastTabs)
  };
  if (!tab || tab.pinned) return next;

  const bound = Object.values(bindings || {}).includes(tab.id);
  if (!bound && !next.tabSpaces[tab.id]) {
    next.tabSpaces[tab.id] = next.activeSpaces[tab.windowId] || fallbackSpaceId;
  }
  const spaceId = tabSpaceId({ tabId: tab.id, bindings, anchorSpaces, tabSpaces: next.tabSpaces });
  if (!spaceId) return next; // A global Favorite does not switch Spaces.

  next.activeSpaces[tab.windowId] = spaceId;
  next.lastTabs[tab.windowId] ||= {};
  next.lastTabs[tab.windowId][spaceId] = tab.id;
  return next;
}

export function removeWorkspaceTab(state, tabId) {
  const next = {
    tabSpaces: cloneMap(state.tabSpaces),
    activeSpaces: cloneMap(state.activeSpaces),
    lastTabs: cloneNestedMap(state.lastTabs)
  };
  delete next.tabSpaces[tabId];
  for (const bySpace of Object.values(next.lastTabs)) {
    for (const [spaceId, rememberedTabId] of Object.entries(bySpace)) {
      if (rememberedTabId === tabId) delete bySpace[spaceId];
    }
  }
  return next;
}

export function replaceWorkspaceTab(state, oldTabId, newTabId) {
  const next = {
    tabSpaces: cloneMap(state.tabSpaces),
    activeSpaces: cloneMap(state.activeSpaces),
    lastTabs: cloneNestedMap(state.lastTabs)
  };
  if (next.tabSpaces[oldTabId]) next.tabSpaces[newTabId] = next.tabSpaces[oldTabId];
  delete next.tabSpaces[oldTabId];
  for (const bySpace of Object.values(next.lastTabs)) {
    for (const [spaceId, rememberedTabId] of Object.entries(bySpace)) {
      if (rememberedTabId === oldTabId) bySpace[spaceId] = newTabId;
    }
  }
  return next;
}
