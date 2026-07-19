import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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
const browserSyncState = {};
globalThis.chrome = {
  storage: {
    local: storageArea(localState),
    sync: storageArea(browserSyncState)
  }
};

const { migratePersistentStorage } = await import('../shared.js');

beforeEach(() => {
  for (const store of [localState, browserSyncState]) {
    for (const key of Object.keys(store)) delete store[key];
  }
});

test('legacy browser-sync data is copied locally before its plaintext copy is removed', async () => {
  localState.archive = [{ url: 'https://archive.test/' }];
  localState.syncConfig = { token: 'token', encryptionKey: 'key' };
  browserSyncState.meta = { spaces: [{ id: 'work', name: 'Work' }], activeSpaceId: 'work' };
  browserSyncState.updatedAt = 50;
  browserSyncState.anchors_work__0 = [{ id: 'a', url: 'https://internal.test/' }];
  browserSyncState.note_work = 'private note';
  browserSyncState.unrelated = 'preserve';

  assert.deepEqual(await migratePersistentStorage(), { migrated: true, removedLegacyKeys: 4 });
  assert.deepEqual(localState.meta, { spaces: [{ id: 'work', name: 'Work' }], activeSpaceId: 'work' });
  assert.equal(localState.anchors_work__0[0].url, 'https://internal.test/');
  assert.equal(localState.note_work, 'private note');
  assert.deepEqual(localState.archive, [{ url: 'https://archive.test/' }]);
  assert.deepEqual(localState.syncConfig, { token: 'token', encryptionKey: 'key' });
  assert.equal(localState.anchorsStorageVersion, 2);
  assert.deepEqual(browserSyncState, { unrelated: 'preserve' });

  assert.deepEqual(await migratePersistentStorage(), { migrated: false, removedLegacyKeys: 0 });
});

test('newer local data wins while stale browser-sync plaintext is still purged', async () => {
  localState.meta = { spaces: [{ id: 'home', name: 'Home' }], activeSpaceId: 'home' };
  localState.updatedAt = 100;
  localState.anchors_home__0 = [{ id: 'local', url: 'https://local.test/' }];
  browserSyncState.meta = { spaces: [{ id: 'old', name: 'Old' }], activeSpaceId: 'old' };
  browserSyncState.updatedAt = 10;
  browserSyncState.anchors_old__0 = [{ id: 'remote', url: 'https://old.test/' }];

  assert.deepEqual(await migratePersistentStorage(), { migrated: false, removedLegacyKeys: 3 });
  assert.equal(localState.meta.activeSpaceId, 'home');
  assert.equal(localState.anchors_home__0[0].url, 'https://local.test/');
  assert.equal(localState.anchors_old__0, undefined);
  assert.deepEqual(browserSyncState, {});
});

test('an interrupted equal-timestamp migration is safely completed on retry', async () => {
  localState.meta = { spaces: [{ id: 'work', name: 'Work' }], activeSpaceId: 'work' };
  localState.updatedAt = 50;
  localState.anchors_work__0 = [{ id: 'a', url: 'https://internal.test/' }];
  localState.note_stale = 'left by an interrupted copy';
  browserSyncState.meta = clone(localState.meta);
  browserSyncState.updatedAt = 50;
  browserSyncState.anchors_work__0 = clone(localState.anchors_work__0);

  assert.deepEqual(await migratePersistentStorage(), { migrated: true, removedLegacyKeys: 3 });
  assert.equal(localState.note_stale, undefined);
  assert.equal(localState.anchorsStorageVersion, 2);
  assert.deepEqual(browserSyncState, {});
});
