// Shared storage layer for the panel and service worker.
// Persistent sidebar data lives in chrome.storage.local. GitHub Gist is the only
// cross-device channel; chrome.storage.sync is used only as a one-time migration
// source for releases that stored plaintext there. Runtime anchor-to-tab
// bindings live in chrome.storage.session because tab ids do not survive a
// browser restart.

const STORAGE_VERSION = 2;
const STORAGE_VERSION_KEY = 'anchorsStorageVersion';
const SYNCED_PREFIXES = ['anchors_', 'note_'];

export async function restrictStorageAccess() {
  const trustedOnly = { accessLevel: 'TRUSTED_CONTEXTS' };
  await Promise.all([
    chrome.storage.local.setAccessLevel?.(trustedOnly),
    chrome.storage.sync.setAccessLevel?.(trustedOnly),
    chrome.storage.session.setAccessLevel?.(trustedOnly)
  ].filter(Boolean));
}

export function isPersistentKey(key) {
  return key === 'meta' || key === 'updatedAt' || SYNCED_PREFIXES.some(prefix => key.startsWith(prefix));
}

function persistentSnapshot(all) {
  return Object.fromEntries(Object.entries(all).filter(([key]) => isPersistentKey(key)));
}

// Copy the newest legacy browser-sync snapshot locally before removing its
// plaintext cloud copy. Writes are ordered so a crash can leave a duplicate but
// cannot leave Anchors without either the local or legacy snapshot.
export async function migratePersistentStorage() {
  const [local, legacy] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.storage.sync.get(null)
  ]);
  const legacyKeys = Object.keys(legacy).filter(isPersistentKey);
  let migrated = false;

  if ((local[STORAGE_VERSION_KEY] || 0) < STORAGE_VERSION) {
    const localState = persistentSnapshot(local);
    const legacyState = persistentSnapshot(legacy);
    const hasLocal = !!localState.meta;
    const hasLegacy = !!legacyState.meta;
    // Equality also selects legacy while the version marker is absent. That
    // makes a retry finish stale-key cleanup after a crash that occurred just
    // after copying the legacy snapshot locally.
    const legacyIsAtLeastAsNew = (legacyState.updatedAt || 0) >= (localState.updatedAt || 0);

    if (hasLegacy && (!hasLocal || legacyIsAtLeastAsNew)) {
      const staleLocal = Object.keys(localState).filter(key => !(key in legacyState));
      await chrome.storage.local.set(legacyState);
      if (staleLocal.length) await chrome.storage.local.remove(staleLocal);
      migrated = true;
    }
    await chrome.storage.local.set({ [STORAGE_VERSION_KEY]: STORAGE_VERSION });
  }

  // Also purge keys after an already-completed migration. This removes any
  // plaintext state reintroduced by a device still running an older release.
  if (legacyKeys.length) await chrome.storage.sync.remove(legacyKeys);
  return { migrated, removedLegacyKeys: legacyKeys.length };
}

let storageMigration = null;
export function ensureLocalStorage() {
  if (!storageMigration) storageMigration = migratePersistentStorage();
  return storageMigration;
}

export async function purgeLegacyBrowserSync() {
  const legacy = await chrome.storage.sync.get(null);
  const keys = Object.keys(legacy).filter(isPersistentKey);
  if (keys.length) await chrome.storage.sync.remove(keys);
  return keys.length;
}

export const PALETTE = ['#7c9cff', '#ff8a7c', '#7cd992', '#e8c46b', '#c78af0', '#6bd0e8', '#f08ab8'];

export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch (e) {
    return u;
  }
}

const SETTINGS_DEFAULTS = {
  autoResetHours: 6,
  suspendMinutes: 0,
  archiveHours: 0,
  keepAnchorTabs: false,
  dedup: true
};
const FAVORITES_LIMIT = 12;

export async function loadMeta() {
  await ensureLocalStorage();
  const { meta } = await chrome.storage.local.get('meta');
  if (meta) {
    meta.settings = Object.assign({}, SETTINGS_DEFAULTS, meta.settings || {});
    meta.favorites = Array.isArray(meta.favorites) ? meta.favorites.slice(0, FAVORITES_LIMIT) : [];
    if (!meta.spaces.some(space => space.id === meta.activeSpaceId)) {
      meta.activeSpaceId = meta.spaces[0]?.id || null;
    }
    return meta;
  }
  const fresh = {
    version: 1,
    spaces: [{ id: crypto.randomUUID(), name: chrome.i18n.getMessage('defaultSpaceName') || 'Personal', color: PALETTE[0] }],
    favorites: [],
    activeSpaceId: null,
    settings: Object.assign({}, SETTINGS_DEFAULTS)
  };
  fresh.activeSpaceId = fresh.spaces[0].id;
  await chrome.storage.local.set({ meta: fresh });
  return fresh;
}

// updatedAt records the latest local edit and remains a legacy-sync fallback.
async function touch() {
  await chrome.storage.local.set({ updatedAt: Date.now() });
}

export async function saveMeta(meta) {
  await ensureLocalStorage();
  await chrome.storage.local.set({ meta });
  await touch();
}

// Space anchors remain chunked as anchors_<id>__0, __1, ... for compatibility
// with existing data and to keep individual writes small.
const CHUNK_LIMIT = 6500;

export async function loadAnchors(spaceId) {
  await ensureLocalStorage();
  const all = await chrome.storage.local.get(null);
  const prefix = 'anchors_' + spaceId;
  if (Array.isArray(all[prefix])) return all[prefix]; // Legacy unchunked format.
  const chunkKeys = Object.keys(all)
    .filter(k => k.startsWith(prefix + '__'))
    .sort((a, b) => Number(a.split('__')[1]) - Number(b.split('__')[1]));
  const out = [];
  for (const k of chunkKeys) out.push(...all[k]);
  return out;
}

export async function saveAnchors(spaceId, anchors) {
  await ensureLocalStorage();
  const prefix = 'anchors_' + spaceId;
  const chunks = [];
  let cur = [];
  for (const item of anchors) {
    if (cur.length && JSON.stringify(cur.concat([item])).length > CHUNK_LIMIT) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(item);
  }
  chunks.push(cur);

  const payload = {};
  chunks.forEach((c, i) => { payload[prefix + '__' + i] = c; });

  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all)
    .filter(k => (k === prefix || k.startsWith(prefix + '__')) && !(k in payload));
  await chrome.storage.local.set(payload);
  if (stale.length) await chrome.storage.local.remove(stale);
  await touch();
}

export async function deleteAnchors(spaceId) {
  await ensureLocalStorage();
  const all = await chrome.storage.local.get(null);
  const prefix = 'anchors_' + spaceId;
  const keys = Object.keys(all).filter(k => k === prefix || k.startsWith(prefix + '__'));
  if (keys.length) await chrome.storage.local.remove(keys);
  await touch();
}

// A list item is either an anchor or a folder {type:'folder', children:[anchors]}.
// Return a flat list of every anchor for maintenance, shortcuts, and deduplication.
export async function loadAllAnchors() {
  await ensureLocalStorage();
  const all = await chrome.storage.local.get(null);
  const out = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('anchors_') || !Array.isArray(v)) continue;
    const spaceId = k.slice('anchors_'.length).split('__')[0];
    for (const item of v) {
      if (item && item.type === 'folder') {
        for (const c of (item.children || [])) out.push({ ...c, spaceId });
      } else if (item) {
        out.push({ ...item, spaceId });
      }
    }
  }
  for (const favorite of (all.meta?.favorites || []).slice(0, FAVORITES_LIMIT)) {
    if (favorite) out.push({ ...favorite, spaceId: null, favorite: true });
  }
  return out;
}

// Space notes keep the previous length limit for predictable snapshot sizes.
export async function loadNote(spaceId) {
  await ensureLocalStorage();
  const k = 'note_' + spaceId;
  const d = await chrome.storage.local.get(k);
  return d[k] || '';
}

export async function saveNote(spaceId, text) {
  await ensureLocalStorage();
  const k = 'note_' + spaceId;
  if (text && text.trim()) {
    await chrome.storage.local.set({ [k]: text.slice(0, 7000) });
  } else {
    await chrome.storage.local.remove(k);
  }
  await touch();
}

// Delete anchor and note keys for spaces no longer present in meta, such as
// orphans left by an interrupted import. Returns the number of removed keys.
export async function cleanupOrphans(meta) {
  await ensureLocalStorage();
  const valid = new Set(meta.spaces.map(s => s.id));
  const all = await chrome.storage.local.get(null);
  const stale = [];
  for (const k of Object.keys(all)) {
    let id = null;
    if (k.startsWith('anchors_')) id = k.slice('anchors_'.length).split('__')[0];
    else if (k.startsWith('note_')) id = k.slice('note_'.length);
    else continue;
    if (!valid.has(id)) stale.push(k);
  }
  if (stale.length) {
    await chrome.storage.local.remove(stale);
    await touch();
  }
  return stale.length;
}

export async function getBindings() {
  const { bindings } = await chrome.storage.session.get('bindings');
  return bindings || {};
}

export async function setBindings(b) {
  await chrome.storage.session.set({ bindings: b });
}

export async function getLastActive() {
  const { lastActive } = await chrome.storage.session.get('lastActive');
  return lastActive || {};
}

export async function setLastActive(la) {
  await chrome.storage.session.set({ lastActive: la });
}

export async function getWorkspaceState() {
  const { tabSpaces, activeSpaces, spaceLastTabs } = await chrome.storage.session.get([
    'tabSpaces', 'activeSpaces', 'spaceLastTabs'
  ]);
  return {
    tabSpaces: tabSpaces || {},
    activeSpaces: activeSpaces || {},
    lastTabs: spaceLastTabs || {}
  };
}

export async function setWorkspaceState(state) {
  await chrome.storage.session.set({
    tabSpaces: state.tabSpaces || {},
    activeSpaces: state.activeSpaces || {},
    spaceLastTabs: state.lastTabs || {}
  });
}
