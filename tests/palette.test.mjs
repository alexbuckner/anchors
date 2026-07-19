import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPalette } from '../palette.js';

const items = [
  { id: 'sync', label: 'Sync now', detail: 'Action', priority: 100 },
  { id: 'github', label: 'GitHub', detail: 'Work — Anchor', priority: 60 },
  { id: 'home', label: 'Home', detail: 'Space', priority: 40 },
  { id: 'docs', label: 'Chrome Extensions', detail: 'Work — Today', priority: 50, keywords: 'developer docs' }
];

test('palette search matches labels, details, and keywords', () => {
  assert.deepEqual(filterPalette(items, 'git').map(item => item.id), ['github']);
  assert.deepEqual(filterPalette(items, 'work today').map(item => item.id), ['docs']);
  assert.deepEqual(filterPalette(items, 'developer').map(item => item.id), ['docs']);
});

test('palette search keeps high-priority actions first for an empty query', () => {
  assert.deepEqual(filterPalette(items, '').map(item => item.id), ['sync', 'github', 'docs', 'home']);
});
