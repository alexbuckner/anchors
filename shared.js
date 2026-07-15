// Shared storage layer for the panel and service worker.
// Persistent data lives in chrome.storage.sync. Anchor lists are chunked because
// sync storage has a per-key quota. Runtime anchor-to-tab bindings live in
// chrome.storage.session because tab ids do not survive a browser restart.

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

export async function loadMeta() {
  const { meta } = await chrome.storage.sync.get('meta');
  if (meta) {
    meta.settings = Object.assign({}, SETTINGS_DEFAULTS, meta.settings || {});
    return meta;
  }
  const fresh = {
    version: 1,
    spaces: [{ id: crypto.randomUUID(), name: chrome.i18n.getMessage('defaultSpaceName') || 'Personal', color: PALETTE[0] }],
    activeSpaceId: null,
    settings: Object.assign({}, SETTINGS_DEFAULTS)
  };
  fresh.activeSpaceId = fresh.spaces[0].id;
  await chrome.storage.sync.set({ meta: fresh });
  return fresh;
}

// updatedAt is the last-write-wins marker used by Gist sync.
async function touch() {
  await chrome.storage.sync.set({ updatedAt: Date.now() });
}

export async function saveMeta(meta) {
  await chrome.storage.sync.set({ meta });
  await touch();
}

// Space anchors are stored as anchors_<id>__0, __1, ... chunks to stay below the
// sync storage per-key quota.
const CHUNK_LIMIT = 6500;

export async function loadAnchors(spaceId) {
  const all = await chrome.storage.sync.get(null);
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

  const all = await chrome.storage.sync.get(null);
  const stale = Object.keys(all)
    .filter(k => (k === prefix || k.startsWith(prefix + '__')) && !(k in payload));
  await chrome.storage.sync.set(payload);
  if (stale.length) await chrome.storage.sync.remove(stale);
  await touch();
}

export async function deleteAnchors(spaceId) {
  const all = await chrome.storage.sync.get(null);
  const prefix = 'anchors_' + spaceId;
  const keys = Object.keys(all).filter(k => k === prefix || k.startsWith(prefix + '__'));
  if (keys.length) await chrome.storage.sync.remove(keys);
  await touch();
}

// A list item is either an anchor or a folder {type:'folder', children:[anchors]}.
// Return a flat list of every anchor for maintenance, shortcuts, and deduplication.
export async function loadAllAnchors() {
  const all = await chrome.storage.sync.get(null);
  const out = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('anchors_') || !Array.isArray(v)) continue;
    for (const item of v) {
      if (item && item.type === 'folder') {
        for (const c of (item.children || [])) out.push(c);
      } else if (item) {
        out.push(item);
      }
    }
  }
  return out;
}

// Space notes use one sync key and are truncated with headroom below the quota.
export async function loadNote(spaceId) {
  const k = 'note_' + spaceId;
  const d = await chrome.storage.sync.get(k);
  return d[k] || '';
}

export async function saveNote(spaceId, text) {
  const k = 'note_' + spaceId;
  if (text && text.trim()) {
    await chrome.storage.sync.set({ [k]: text.slice(0, 7000) });
  } else {
    await chrome.storage.sync.remove(k);
  }
  await touch();
}

// Delete anchor and note keys for spaces no longer present in meta, such as
// orphans left by an interrupted import. Returns the number of removed keys.
export async function cleanupOrphans(meta) {
  const valid = new Set(meta.spaces.map(s => s.id));
  const all = await chrome.storage.sync.get(null);
  const stale = [];
  for (const k of Object.keys(all)) {
    let id = null;
    if (k.startsWith('anchors_')) id = k.slice('anchors_'.length).split('__')[0];
    else if (k.startsWith('note_')) id = k.slice('note_'.length);
    else continue;
    if (!valid.has(id)) stale.push(k);
  }
  if (stale.length) {
    await chrome.storage.sync.remove(stale);
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
