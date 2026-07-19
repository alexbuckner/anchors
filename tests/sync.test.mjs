import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const clone = value => value === undefined ? undefined : structuredClone(value);

function storageArea(state) {
  return {
    async get(query) {
      if (query === null || query === undefined) return clone(state);
      if (typeof query === 'string') return { [query]: clone(state[query]) };
      if (Array.isArray(query)) return Object.fromEntries(query.map(key => [key, clone(state[key])]));
      return Object.fromEntries(Object.entries(query).map(([key, fallback]) => [
        key, key in state ? clone(state[key]) : fallback
      ]));
    },
    async set(values) { Object.assign(state, clone(values)); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }
  };
}

const localState = {};
const syncState = {};
globalThis.chrome = {
  storage: {
    local: storageArea(localState),
    sync: storageArea(syncState)
  }
};

const {
  generateSyncKey,
  encryptSyncState,
  decryptSyncState,
  setSyncConfig,
  syncNow,
  migratePlaintextGist
} = await import('../sync.js');

const encryptedFile = 'anchors-sync.enc.json';
const legacyFile = 'anchors-sync.json';
const gists = new Map();
const requests = [];
let nextGistId = 1;

function response(status, data = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    async json() { return clone(data); }
  };
}

globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = options.method || 'GET';
  const path = parsed.pathname;
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ method, path, body });

  if (method === 'GET' && path === '/gists') {
    return response(200, [...gists.values()].map(gist => clone(gist)));
  }
  if (method === 'POST' && path === '/gists') {
    const id = String(nextGistId++);
    const gist = { id, files: clone(body.files), description: body.description, public: body.public };
    gists.set(id, gist);
    return response(201, gist);
  }

  const id = path.match(/^\/gists\/([^/]+)$/)?.[1];
  if (!id || !gists.has(id)) return response(404);
  if (method === 'GET') return response(200, gists.get(id));
  if (method === 'PATCH') {
    const gist = gists.get(id);
    Object.assign(gist.files, clone(body.files));
    return response(200, gist);
  }
  if (method === 'DELETE') {
    gists.delete(id);
    return response(204);
  }
  return response(405);
};

function state(updatedAt, url = 'https://example.test/') {
  return {
    updatedAt,
    meta: { spaces: [{ id: 'space', name: 'Work' }], activeSpaceId: 'space' },
    data: { anchors_space__0: [{ id: 'anchor', url, title: 'Private title' }] }
  };
}

function setLocal(value) {
  localState.updatedAt = value.updatedAt;
  localState.meta = clone(value.meta);
  for (const key of Object.keys(localState)) {
    if (key.startsWith('anchors_') || key.startsWith('note_')) delete localState[key];
  }
  Object.assign(localState, clone(value.data));
}

beforeEach(() => {
  for (const store of [localState, syncState]) {
    for (const key of Object.keys(store)) delete store[key];
  }
  gists.clear();
  requests.length = 0;
  nextGistId = 1;
});

test('AES-GCM envelope round-trips without exposing sync contents', async () => {
  const key = generateSyncKey();
  const plaintext = state(10, 'https://internal.example.test/customer/42');
  const envelope = await encryptSyncState(plaintext, key);

  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.equal(envelope.version, 2);
  assert.doesNotMatch(JSON.stringify(envelope), /internal|customer|Private title/);
  assert.deepEqual(await decryptSyncState(envelope, key), plaintext);

  await assert.rejects(
    decryptSyncState(envelope, generateSyncKey()),
    error => error.code === 'KEY_MISMATCH'
  );
});

test('first sync creates an encrypted Gist', async () => {
  const key = generateSyncKey();
  const local = state(20, 'https://work.example.test/secret');
  setLocal(local);
  await setSyncConfig({ token: 'token', gistId: '', lastSyncAt: 0, encryptionKey: key });

  assert.deepEqual(await syncNow(), { status: 'created' });
  const gist = [...gists.values()][0];
  assert.ok(gist.files[encryptedFile]);
  assert.equal(gist.files[legacyFile], undefined);
  assert.doesNotMatch(gist.files[encryptedFile].content, /work\.example|secret/);
  assert.deepEqual(await decryptSyncState(JSON.parse(gist.files[encryptedFile].content), key), local);
});

test('a newer encrypted snapshot is pulled and applied', async () => {
  const key = generateSyncKey();
  setLocal(state(10, 'https://old.test/'));
  const remote = state(30, 'https://new.test/');
  const envelope = await encryptSyncState(remote, key);
  gists.set('remote', { id: 'remote', files: { [encryptedFile]: { content: JSON.stringify(envelope) } } });
  await setSyncConfig({ token: 'token', gistId: 'remote', lastSyncAt: 0, encryptionKey: key });

  assert.deepEqual(await syncNow(), { status: 'pulled' });
  assert.equal(localState.updatedAt, 30);
  assert.equal(localState.anchors_space__0[0].url, 'https://new.test/');
});

test('a wrong key never overwrites the remote Gist', async () => {
  const remoteKey = generateSyncKey();
  const localKey = generateSyncKey();
  setLocal(state(50, 'https://local.test/'));
  const envelope = await encryptSyncState(state(10, 'https://remote.test/'), remoteKey);
  gists.set('remote', { id: 'remote', files: { [encryptedFile]: { content: JSON.stringify(envelope) } } });
  await setSyncConfig({ token: 'token', gistId: 'remote', lastSyncAt: 0, encryptionKey: localKey });

  await assert.rejects(syncNow(), error => error.code === 'KEY_MISMATCH');
  assert.equal(requests.filter(request => request.method === 'PATCH').length, 0);
  assert.match(gists.get('remote').files[encryptedFile].content, new RegExp(envelope.ciphertext.slice(0, 16)));
});

test('plaintext migration is explicit and replaces the legacy Gist safely', async () => {
  const key = generateSyncKey();
  setLocal(state(10, 'https://local.test/'));
  const remote = state(30, 'https://remote.test/private');
  gists.set('legacy', {
    id: 'legacy',
    files: { [legacyFile]: { content: JSON.stringify(remote) } }
  });
  await setSyncConfig({ token: 'token', gistId: 'legacy', lastSyncAt: 0, encryptionKey: key });

  await assert.rejects(syncNow(), error => error.code === 'PLAINTEXT_GIST');
  assert.ok(gists.has('legacy'));
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);

  const result = await migratePlaintextGist();
  assert.deepEqual(result, { status: 'migrated', pulled: true, legacyDeleted: true });
  assert.equal(gists.has('legacy'), false);
  const replacement = [...gists.values()][0];
  const decrypted = await decryptSyncState(JSON.parse(replacement.files[encryptedFile].content), key);
  assert.equal(decrypted.data.anchors_space__0[0].url, 'https://remote.test/private');
  assert.equal(localState.anchors_space__0[0].url, 'https://remote.test/private');
  assert.equal(localState.syncConfig.gistId, replacement.id);
});
