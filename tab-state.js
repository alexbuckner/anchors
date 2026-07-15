// Pure helpers for the runtime anchor-to-tab state. The background service
// worker is the only writer; keeping the transformations here makes the
// lifecycle deterministic and testable without a browser.

function cloneMap(value) {
  return Object.assign({}, value || {});
}

export function assignAnchorTab({
  bindings,
  lastActive,
  anchorId,
  tabId,
  windowTabIds = new Set(),
  keepAnchorTabs = true,
  now = Date.now()
}) {
  const nextBindings = cloneMap(bindings);
  const nextLastActive = cloneMap(lastActive);
  const releasedTabIds = new Set();

  for (const [boundAnchorId, boundTabId] of Object.entries(nextBindings)) {
    const replacesAnchor = boundAnchorId === anchorId;
    const reusesTab = boundTabId === tabId;
    const extraInWindow = !keepAnchorTabs && windowTabIds.has(boundTabId) && boundTabId !== tabId;
    if (!replacesAnchor && !reusesTab && !extraInWindow) continue;

    delete nextBindings[boundAnchorId];
    delete nextLastActive[boundAnchorId];
    if (boundTabId !== tabId) releasedTabIds.add(boundTabId);
  }

  nextBindings[anchorId] = tabId;
  nextLastActive[anchorId] = now;
  return {
    bindings: nextBindings,
    lastActive: nextLastActive,
    releasedTabIds: [...releasedTabIds]
  };
}

export function releaseAnchors({ bindings, lastActive, anchorIds }) {
  const nextBindings = cloneMap(bindings);
  const nextLastActive = cloneMap(lastActive);
  const releasedTabIds = new Set();

  for (const anchorId of new Set(anchorIds || [])) {
    if (anchorId in nextBindings) releasedTabIds.add(nextBindings[anchorId]);
    delete nextBindings[anchorId];
    delete nextLastActive[anchorId];
  }

  return {
    bindings: nextBindings,
    lastActive: nextLastActive,
    releasedTabIds: [...releasedTabIds]
  };
}

export function removeTab({ bindings, lastActive, tabId }) {
  const nextBindings = cloneMap(bindings);
  const nextLastActive = cloneMap(lastActive);

  for (const [anchorId, boundTabId] of Object.entries(nextBindings)) {
    if (boundTabId !== tabId) continue;
    delete nextBindings[anchorId];
    delete nextLastActive[anchorId];
  }

  return { bindings: nextBindings, lastActive: nextLastActive };
}

export function replaceTab({ bindings, oldTabId, newTabId }) {
  const nextBindings = cloneMap(bindings);
  for (const [anchorId, boundTabId] of Object.entries(nextBindings)) {
    if (boundTabId === oldTabId) nextBindings[anchorId] = newTabId;
  }
  return nextBindings;
}

export function touchTab({ bindings, lastActive, tabId, now = Date.now() }) {
  const nextLastActive = cloneMap(lastActive);
  for (const [anchorId, boundTabId] of Object.entries(bindings || {})) {
    if (boundTabId === tabId) nextLastActive[anchorId] = now;
  }
  return nextLastActive;
}

export function pruneTabState({ bindings, lastActive, validAnchorIds, liveTabIds }) {
  const nextBindings = cloneMap(bindings);
  const nextLastActive = cloneMap(lastActive);
  const releasedTabIds = new Set();

  for (const [anchorId, tabId] of Object.entries(nextBindings)) {
    const validAnchor = validAnchorIds.has(anchorId);
    const liveTab = liveTabIds.has(tabId);
    if (validAnchor && liveTab) continue;

    delete nextBindings[anchorId];
    delete nextLastActive[anchorId];
    if (!validAnchor && liveTab) releasedTabIds.add(tabId);
  }

  // A tab can have only one anchor owner. Earlier releases could create a
  // duplicate owner during concurrent pin/rebind operations; keep the most
  // recently active owner and remove the rest in every mode.
  const ownerByTab = new Map();
  for (const [anchorId, tabId] of Object.entries(nextBindings)) {
    const existing = ownerByTab.get(tabId);
    if (!existing) {
      ownerByTab.set(tabId, anchorId);
      continue;
    }
    const existingTime = nextLastActive[existing] || 0;
    const candidateTime = nextLastActive[anchorId] || 0;
    const candidateWins = candidateTime > existingTime ||
      (candidateTime === existingTime && anchorId.localeCompare(existing) < 0);
    const loser = candidateWins ? existing : anchorId;
    delete nextBindings[loser];
    delete nextLastActive[loser];
    if (candidateWins) ownerByTab.set(tabId, anchorId);
  }

  for (const anchorId of Object.keys(nextLastActive)) {
    if (!(anchorId in nextBindings)) delete nextLastActive[anchorId];
  }

  return {
    bindings: nextBindings,
    lastActive: nextLastActive,
    releasedTabIds: [...releasedTabIds]
  };
}
