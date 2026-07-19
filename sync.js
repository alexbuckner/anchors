// End-to-end encrypted synchronization through a secret GitHub Gist.
//
// The GitHub token and AES key stay in storage.local and are never written to
// browser sync, the Gist, or an Anchors export. GitHub only receives an AES-GCM
// envelope. Authenticated revision ancestry and content hashes stop concurrent
// device branches for explicit whole-snapshot resolution.

import { ensureLocalStorage } from './shared.js';
import { DataValidationError, DATA_LIMITS, validateSyncState } from './data-schema.js';

const FILE = 'anchors-sync.enc.json';
const LEGACY_FILE = 'anchors-sync.json';
const API = 'https://api.github.com';
const FORMAT = 'anchors-sync';
const FORMAT_VERSION = 2;
const KEY_PREFIX = 'anchors-key-v1-';
const AAD = new TextEncoder().encode(`${FORMAT}:v${FORMAT_VERSION}`);

const SYNCED_PREFIXES = ['anchors_', 'note_'];
const isSyncedKey = (k) => SYNCED_PREFIXES.some(p => k.startsWith(p));

export class SyncError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SyncError';
    this.code = code;
  }
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SyncError('INVALID_KEY', 'Invalid sync encryption key');
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch (e) {
    throw new SyncError('INVALID_KEY', 'Invalid sync encryption key', e);
  }
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function normalizeSyncKey(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed.startsWith(KEY_PREFIX)) throw new SyncError('INVALID_KEY', 'Invalid sync encryption key');
  const bytes = base64UrlToBytes(trimmed.slice(KEY_PREFIX.length));
  if (bytes.length !== 32) throw new SyncError('INVALID_KEY', 'Invalid sync encryption key');
  return KEY_PREFIX + bytesToBase64Url(bytes);
}

export function generateSyncKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return KEY_PREFIX + bytesToBase64Url(bytes);
}

function keyBytes(value) {
  const normalized = normalizeSyncKey(value);
  return base64UrlToBytes(normalized.slice(KEY_PREFIX.length));
}

async function importAesKey(value) {
  return crypto.subtle.importKey('raw', keyBytes(value), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function keyId(value) {
  const digest = await crypto.subtle.digest('SHA-256', keyBytes(value));
  return bytesToBase64Url(new Uint8Array(digest).slice(0, 9));
}

function validateState(state, code = 'INVALID_REMOTE') {
  try {
    return validateSyncState(state);
  } catch (error) {
    if (error instanceof DataValidationError) {
      throw new SyncError(code, error.message, error);
    }
    throw error;
  }
}

function isEncryptedEnvelope(value) {
  return value && typeof value === 'object' && value.format === FORMAT && value.encrypted === true;
}

export async function encryptSyncState(state, encryptionKey) {
  const validated = validateState(state, 'INVALID_LOCAL');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(validated));
  const key = await importAesKey(encryptionKey);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 },
    key,
    plaintext
  );
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    encrypted: true,
    algorithm: 'AES-256-GCM',
    keyId: await keyId(encryptionKey),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))
  };
}

export async function decryptSyncState(envelope, encryptionKey) {
  if (!isEncryptedEnvelope(envelope) || envelope.version !== FORMAT_VERSION ||
      envelope.algorithm !== 'AES-256-GCM' || typeof envelope.iv !== 'string' ||
      typeof envelope.ciphertext !== 'string') {
    throw new SyncError('UNSUPPORTED_REMOTE', 'The encrypted sync format is not supported');
  }

  let iv, ciphertext;
  try {
    iv = base64UrlToBytes(envelope.iv);
    ciphertext = base64UrlToBytes(envelope.ciphertext);
  } catch (e) {
    throw new SyncError('INVALID_REMOTE', 'The encrypted sync data is invalid', e);
  }
  if (iv.length !== 12 || ciphertext.length < 17) {
    throw new SyncError('INVALID_REMOTE', 'The encrypted sync data is invalid');
  }

  const expectedKeyId = await keyId(encryptionKey);
  if (envelope.keyId && envelope.keyId !== expectedKeyId) {
    throw new SyncError('KEY_MISMATCH', 'This Gist was encrypted with a different sync key');
  }

  try {
    const key = await importAesKey(encryptionKey);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 },
      key,
      ciphertext
    );
    return validateState(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch (e) {
    if (e instanceof SyncError) throw e;
    throw new SyncError('KEY_MISMATCH', 'Could not decrypt the Gist; check the sync key', e);
  }
}

export async function getSyncConfig() {
  const { syncConfig } = await chrome.storage.local.get('syncConfig');
  return {
    token: '', gistId: '', lastSyncAt: 0, encryptionKey: '',
    baseHash: '', baseRevision: '',
    ...(syncConfig || {})
  };
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
  if (!res.ok) throw new SyncError('GITHUB_API', 'GitHub API: ' + res.status + ' ' + res.statusText);
  if (res.status === 204) return null;
  return res.json();
}

async function discoverGist(token) {
  let legacy = null;
  for (let page = 1; page <= 3; page++) {
    const gists = await gh(token, `/gists?per_page=100&page=${page}`);
    if (!Array.isArray(gists) || gists.length === 0) break;
    const encrypted = gists.find(g => g.files && g.files[FILE]);
    if (encrypted) return { id: encrypted.id, legacy: false };
    if (!legacy) {
      const hit = gists.find(g => g.files && g.files[LEGACY_FILE]);
      if (hit) legacy = { id: hit.id, legacy: true };
    }
    if (gists.length < 100) break;
  }
  return legacy;
}

async function collectState() {
  await ensureLocalStorage();
  const all = await chrome.storage.local.get(null);
  const state = { updatedAt: all.updatedAt || 0, meta: all.meta || null, data: {} };
  for (const [k, v] of Object.entries(all)) {
    if (isSyncedKey(k)) state.data[k] = v;
  }
  return validateState(state, 'INVALID_LOCAL');
}

async function applyState(state) {
  state = validateState(state);
  await ensureLocalStorage();
  const data = state.data || state.anchors || {}; // .anchors is the legacy format.
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter(k => isSyncedKey(k) && !(k in data));
  await chrome.storage.local.set({ meta: state.meta, ...data });
  if (stale.length) await chrome.storage.local.remove(stale);
  // updatedAt is the commit marker consumed by runtime binding repair.
  await chrome.storage.local.set({ updatedAt: state.updatedAt });
}

function fileFromGist(gist) {
  if (gist?.files?.[FILE]) return { legacy: false, file: gist.files[FILE] };
  if (gist?.files?.[LEGACY_FILE]) return { legacy: true, file: gist.files[LEGACY_FILE] };
  throw new SyncError('INVALID_REMOTE', 'The Anchors sync file is missing from the Gist');
}

function parseFile(file) {
  if (!file || file.truncated || typeof file.content !== 'string') {
    throw new SyncError('INVALID_REMOTE', 'The Anchors sync file is incomplete');
  }
  try {
    return JSON.parse(file.content);
  } catch (e) {
    throw new SyncError('INVALID_REMOTE', 'The Anchors sync file is not valid JSON', e);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function contentHash(state) {
  const bytes = new TextEncoder().encode(canonicalJson({ meta: state.meta, data: state.data }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToBase64Url(new Uint8Array(digest));
}

function stampState(state, previous = null) {
  const lineage = previous?.revision
    ? [previous.revision, ...(previous.lineage || [])].slice(0, DATA_LIMITS.lineage)
    : [];
  return validateState({
    ...state,
    syncMeta: { revision: crypto.randomUUID(), lineage }
  }, 'INVALID_LOCAL');
}

async function finishSync(cfg, state) {
  cfg.baseHash = await contentHash(state);
  cfg.baseRevision = state.syncMeta?.revision || '';
  cfg.lastSyncAt = Date.now();
  await setSyncConfig(cfg);
}

function revisionOf(state) {
  return state.syncMeta?.revision || '';
}

function descendsFrom(state, revision) {
  if (!revision) return true;
  return revisionOf(state) === revision || (state.syncMeta?.lineage || []).includes(revision);
}

function conflict() {
  throw new SyncError(
    'SYNC_CONFLICT',
    'Both this device and another device changed since the last sync'
  );
}

async function encryptedRemote(cfg) {
  const gist = await gh(cfg.token, '/gists/' + cfg.gistId);
  const remoteFile = fileFromGist(gist);
  const remoteDocument = parseFile(remoteFile.file);
  if (remoteFile.legacy || !isEncryptedEnvelope(remoteDocument)) {
    throw new SyncError(
      'PLAINTEXT_GIST',
      'The existing Gist is not encrypted and requires explicit migration'
    );
  }
  return { gist, state: await decryptSyncState(remoteDocument, cfg.encryptionKey) };
}

async function pushState(cfg, local, expectedRemote) {
  // Re-read immediately before PATCH. GitHub Gists do not expose an atomic
  // compare-and-swap operation, so the encrypted revision lineage also detects
  // a crossing write on the next sync instead of silently accepting it.
  const latest = (await encryptedRemote(cfg)).state;
  const [expectedHash, latestHash] = await Promise.all([
    contentHash(expectedRemote), contentHash(latest)
  ]);
  if (expectedHash !== latestHash || revisionOf(expectedRemote) !== revisionOf(latest)) conflict();

  const outgoing = stampState(local, latest.syncMeta);
  const envelope = await encryptSyncState(outgoing, cfg.encryptionKey);
  await gh(cfg.token, '/gists/' + cfg.gistId, 'PATCH', {
    files: { [FILE]: { content: JSON.stringify(envelope) } }
  });
  return outgoing;
}

async function createEncryptedGist(cfg, state) {
  const outgoing = stampState(state);
  const envelope = await encryptSyncState(outgoing, cfg.encryptionKey);
  const gist = await gh(cfg.token, '/gists', 'POST', {
    description: 'Anchors end-to-end encrypted sync',
    public: false,
    files: { [FILE]: { content: JSON.stringify(envelope) } }
  });
  return { gist, state: outgoing };
}

function requireEncryptionKey(cfg) {
  if (!cfg.encryptionKey) throw new SyncError('MISSING_KEY', 'Add or generate a sync encryption key first');
  return normalizeSyncKey(cfg.encryptionKey);
}

// Returns {status}: off | created | linked | pulled | pushed | uptodate.
export async function syncNow() {
  const cfg = await getSyncConfig();
  if (!cfg.token) return { status: 'off' };
  cfg.encryptionKey = requireEncryptionKey(cfg);

  const local = await collectState();
  let justLinked = false;

  if (!cfg.gistId) {
    const found = await discoverGist(cfg.token);
    if (found) {
      cfg.gistId = found.id;
      justLinked = true;
      await setSyncConfig(cfg);
    } else {
      const created = await createEncryptedGist(cfg, local);
      cfg.gistId = created.gist.id;
      await finishSync(cfg, created.state);
      return { status: 'created' };
    }
  }

  const remote = (await encryptedRemote(cfg)).state;
  const [localHash, remoteHash] = await Promise.all([contentHash(local), contentHash(remote)]);

  if (localHash === remoteHash) {
    await finishSync(cfg, remote);
    return { status: 'uptodate' };
  }

  if (cfg.baseHash) {
    const localChanged = localHash !== cfg.baseHash;
    const remoteChanged = remoteHash !== cfg.baseHash;
    if ((remoteChanged && !descendsFrom(remote, cfg.baseRevision)) ||
        (localChanged && remoteChanged)) {
      conflict();
    }
    if (remoteChanged) {
      await applyState(remote);
      await finishSync(cfg, remote);
      return { status: justLinked ? 'linked' : 'pulled' };
    }
    if (localChanged) {
      const outgoing = await pushState(cfg, local, remote);
      await finishSync(cfg, outgoing);
      return { status: 'pushed' };
    }
    conflict();
  }

  if (remote.updatedAt > local.updatedAt) {
    await applyState(remote);
    await finishSync(cfg, remote);
    return { status: justLinked ? 'linked' : 'pulled' };
  }

  if (local.updatedAt > remote.updatedAt) {
    const outgoing = await pushState(cfg, local, remote);
    await finishSync(cfg, outgoing);
    return { status: 'pushed' };
  }

  // Equal wall-clock timestamps with different authenticated content are not
  // equivalent. Stop instead of choosing an arbitrary winner.
  conflict();
}

export async function resolveSyncConflict(strategy) {
  if (strategy !== 'local' && strategy !== 'remote') {
    throw new SyncError('INVALID_RESOLUTION', 'Unknown sync conflict resolution');
  }
  const cfg = await getSyncConfig();
  if (!cfg.token || !cfg.gistId) throw new SyncError('MISSING_SYNC', 'Sync is not connected');
  cfg.encryptionKey = requireEncryptionKey(cfg);
  const [local, remoteResult] = await Promise.all([collectState(), encryptedRemote(cfg)]);
  const remote = remoteResult.state;

  if (strategy === 'remote') {
    await applyState(remote);
    await finishSync(cfg, remote);
    return { status: 'resolvedRemote' };
  }

  const outgoing = await pushState(cfg, local, remote);
  await finishSync(cfg, outgoing);
  return { status: 'resolvedLocal' };
}

// Explicitly migrates a legacy plaintext Gist. The newer timestamped snapshot
// is first uploaded to a new encrypted Gist. Only after that succeeds
// do we switch configuration and delete the old Gist.
export async function migratePlaintextGist() {
  const cfg = await getSyncConfig();
  if (!cfg.token) throw new SyncError('MISSING_TOKEN', 'Add a GitHub token first');
  cfg.encryptionKey = requireEncryptionKey(cfg);

  let legacyId = cfg.gistId;
  if (!legacyId) {
    const found = await discoverGist(cfg.token);
    if (!found) throw new SyncError('NO_LEGACY_GIST', 'No existing Anchors Gist was found');
    if (!found.legacy) {
      cfg.gistId = found.id;
      await setSyncConfig(cfg);
      return syncNow();
    }
    legacyId = found.id;
  }

  const legacyGist = await gh(cfg.token, '/gists/' + legacyId);
  const remoteFile = fileFromGist(legacyGist);
  if (!remoteFile.legacy) {
    cfg.gistId = legacyId;
    await setSyncConfig(cfg);
    return syncNow();
  }

  const remoteDocument = parseFile(remoteFile.file);
  const remoteData = remoteDocument.data || remoteDocument.anchors;
  const remote = validateState({ ...remoteDocument, data: remoteData || {} });
  const local = await collectState();
  const useRemote = remote.updatedAt > local.updatedAt;
  const selected = useRemote ? remote : local;

  const replacement = await createEncryptedGist(cfg, selected);
  if (useRemote) await applyState(remote);

  cfg.gistId = replacement.gist.id;
  await finishSync(cfg, replacement.state);

  let legacyDeleted = false;
  try {
    await gh(cfg.token, '/gists/' + legacyId, 'DELETE');
    legacyDeleted = true;
  } catch (e) {
    // The encrypted replacement is already active. Report the cleanup failure
    // without rolling back to plaintext storage.
  }

  return { status: 'migrated', pulled: useRemote, legacyDeleted };
}
