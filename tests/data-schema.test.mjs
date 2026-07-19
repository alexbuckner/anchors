import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertImportFileSize,
  normalizeAnchorItems,
  normalizeFavorites,
  validateSyncState
} from '../data-schema.js';

function validState() {
  return {
    updatedAt: 10,
    meta: {
      version: 1,
      spaces: [{ id: 'space', name: 'Work', color: '#7c9cff', icon: 'icon:work' }],
      favorites: [],
      activeSpaceId: 'space',
      settings: { dedup: true }
    },
    data: {
      anchors_space__0: [{ id: 'anchor', url: 'https://example.test/path', title: 'Example' }],
      note_space: 'Private note'
    }
  };
}

test('import normalization regenerates IDs and strips unsupported fields', () => {
  const source = [{
    id: 'source-folder', type: 'folder', name: 'Folder', collapsed: false, extra: 'drop',
    children: [{ id: 'source-anchor', url: 'https://example.test', title: 'Example', extra: 'drop' }]
  }];
  const normalized = normalizeAnchorItems(source, { freshIds: true });
  assert.equal(normalized.anchorCount, 1);
  assert.notEqual(normalized.items[0].id, 'source-folder');
  assert.notEqual(normalized.items[0].children[0].id, 'source-anchor');
  assert.equal(normalized.items[0].extra, undefined);
  assert.equal(normalized.items[0].children[0].extra, undefined);
  assert.equal(normalized.items[0].children[0].url, 'https://example.test/');
});

test('schema rejects nested folders and oversized favorite lists', () => {
  assert.throws(() => normalizeAnchorItems([{
    id: 'outer', type: 'folder', name: 'Outer', children: [
      { id: 'inner', type: 'folder', name: 'Inner', children: [] }
    ]
  }]), error => error.code === 'INVALID_DATA');

  assert.throws(() => normalizeFavorites(Array.from({ length: 13 }, (_, index) => ({
    id: `favorite-${index}`,
    url: `https://example${index}.test/`,
    title: `Favorite ${index}`
  }))), error => error.code === 'INVALID_DATA');
});

test('sync schema accepts only scoped keys and HTTP URLs', () => {
  const state = validState();
  assert.deepEqual(validateSyncState(state), state);

  const whitespace = validState();
  whitespace.data.note_space = '  indented note\n';
  assert.equal(validateSyncState(whitespace).data.note_space, '  indented note\n');

  const unsupported = validState();
  unsupported.data.archive = [];
  assert.throws(() => validateSyncState(unsupported), error => error.code === 'INVALID_DATA');

  const unsafeUrl = validState();
  unsafeUrl.data.anchors_space__0[0].url = 'data:text/html,hello';
  assert.throws(() => validateSyncState(unsafeUrl), error => error.code === 'INVALID_DATA');
});

test('import files are rejected before reading when they exceed the cap', () => {
  assert.doesNotThrow(() => assertImportFileSize({ size: 1024 }));
  assert.throws(
    () => assertImportFileSize({ size: 6 * 1024 * 1024 }),
    error => error.code === 'INVALID_DATA'
  );
});
