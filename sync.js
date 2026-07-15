// Synchronize through a secret GitHub Gist using last-write-wins by updatedAt.
// Concurrent edits are not merged; the newer complete snapshot wins. The token
// stays in storage.local and is never sent through browser sync.
//
// On a new device, entering the same token lets syncNow discover the existing
// Gist by filename and pull its data.

const FILE = 'anchors-sync.json';
const API = 'https://api.github.com';

const SYNCED_PREFIXES = ['anchors_', 'note_'];
const isSyncedKey = (k) => SYNCED_PREFIXES.some(p => k.startsWith(p));

export async function getSyncConfig() {
  const { syncConfig } = await chrome.storage.local.get('syncConfig');
  return syncConfig || { token: '', gistId: '', lastSyncAt: 0 };
}

export async function setSyncConfig(cfg) {
  await chrome.storage.local.set({ syncConfig: cfg });
}

async function gh(token, path, method = 'GET', body = null) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) throw new Error('GitHub API: ' + res.status + ' ' + res.statusText);
  return res.json();
}

async function discoverGist(token) {
  for (let page = 1; page <= 3; page++) {
    const gists = await gh(token, `/gists?per_page=100&page=${page}`);
    if (!Array.isArray(gists) || gists.length === 0) break;
    const hit = gists.find(g => g.files && g.files[FILE]);
    if (hit) return hit.id;
    if (gists.length < 100) break;
  }
  return null;
}

async function collectState() {
  const all = await chrome.storage.sync.get(null);
  const state = { updatedAt: all.updatedAt || 0, meta: all.meta || null, data: {} };
  for (const [k, v] of Object.entries(all)) {
    if (isSyncedKey(k)) state.data[k] = v;
  }
  return state;
}

async function applyState(state) {
  const data = state.data || state.anchors || {}; // .anchors is the legacy format.
  const all = await chrome.storage.sync.get(null);
  const stale = Object.keys(all).filter(k => isSyncedKey(k) && !(k in data));
  await chrome.storage.sync.set({ meta: state.meta, ...data });
  if (stale.length) await chrome.storage.sync.remove(stale);
  // updatedAt is the commit marker consumed by runtime binding repair.
  await chrome.storage.sync.set({ updatedAt: state.updatedAt });
}

// Returns {status}: off | created | linked | pulled | pushed | uptodate.
export async function syncNow() {
  const cfg = await getSyncConfig();
  if (!cfg.token) return { status: 'off' };

  const local = await collectState();
  let justLinked = false;

  if (!cfg.gistId) {
    const found = await discoverGist(cfg.token);
    if (found) {
      cfg.gistId = found;
      justLinked = true;
      await setSyncConfig(cfg);
    } else {
      const gist = await gh(cfg.token, '/gists', 'POST', {
        description: 'Anchors extension sync',
        public: false,
        files: { [FILE]: { content: JSON.stringify(local) } }
      });
      cfg.gistId = gist.id;
      cfg.lastSyncAt = Date.now();
      await setSyncConfig(cfg);
      return { status: 'created' };
    }
  }

  const gist = await gh(cfg.token, '/gists/' + cfg.gistId);
  let remote = null;
  try { remote = JSON.parse(gist.files[FILE].content); } catch (e) { /* Replace an empty or invalid Gist. */ }

  if (remote && remote.updatedAt > local.updatedAt) {
    await applyState(remote);
    cfg.lastSyncAt = Date.now();
    await setSyncConfig(cfg);
    return { status: justLinked ? 'linked' : 'pulled' };
  }

  if (!remote || local.updatedAt > remote.updatedAt) {
    await gh(cfg.token, '/gists/' + cfg.gistId, 'PATCH', {
      files: { [FILE]: { content: JSON.stringify(local) } }
    });
    cfg.lastSyncAt = Date.now();
    await setSyncConfig(cfg);
    return { status: 'pushed' };
  }

  cfg.lastSyncAt = Date.now();
  await setSyncConfig(cfg);
  return { status: 'uptodate' };
}
