// Validation boundary for imported and synchronized persistent data. Browser
// tab metadata is trusted only long enough to create the same small records.

export const DATA_LIMITS = Object.freeze({
  importBytes: 5 * 1024 * 1024,
  spaces: 100,
  favorites: 12,
  anchorsPerSpace: 5000,
  anchorsTotal: 10000,
  name: 160,
  title: 500,
  url: 8192,
  note: 7000,
  icon: 32,
  id: 128,
  lineage: 24
});

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SPACE_ICON_TOKENS = new Set([
  'icon:home', 'icon:work', 'icon:code', 'icon:study', 'icon:travel',
  'icon:finance', 'icon:shopping', 'icon:media', 'icon:music',
  'icon:gaming', 'icon:ideas', 'icon:projects', 'icon:heart', 'icon:lab'
]);

export class DataValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataValidationError';
    this.code = 'INVALID_DATA';
  }
}

function fail(message) {
  throw new DataValidationError(message);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

export function boundedText(value, label, max, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return '';
    fail(`${label} is required`);
  }
  if (typeof value !== 'string') fail(`${label} must be text`);
  const text = value.trim();
  if (!text && !optional) fail(`${label} cannot be empty`);
  if (text.length > max) fail(`${label} is too long`);
  if (text.includes('\0')) fail(`${label} contains an invalid character`);
  return text;
}

export function normalizeId(value, label = 'ID') {
  const id = boundedText(value, label, DATA_LIMITS.id);
  if (!ID_RE.test(id) || id.includes('__')) fail(`${label} is invalid`);
  return id;
}

export function normalizeHttpUrl(value, label = 'URL') {
  const raw = boundedText(value, label, DATA_LIMITS.url);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label} is invalid`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`${label} must use HTTP or HTTPS`);
  if (!url.hostname) fail(`${label} must include a hostname`);
  return url.toString();
}

export function normalizeColor(value, fallback = null, label = 'Space color') {
  if ((value === undefined || value === null || value === '') && fallback) return fallback;
  if (typeof value !== 'string' || !COLOR_RE.test(value)) fail(`${label} is invalid`);
  return value.toLowerCase();
}

export function normalizeIcon(value, label = 'Space icon') {
  if (value === undefined || value === null || value === '') return '';
  const icon = boundedText(value, label, DATA_LIMITS.icon, { optional: true });
  if (icon.startsWith('icon:') && !SPACE_ICON_TOKENS.has(icon)) fail(`${label} is invalid`);
  return icon;
}

export function normalizeNote(value, label = 'Space note') {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(`${label} must be text`);
  if (value.length > DATA_LIMITS.note) fail(`${label} is too long`);
  if (value.includes('\0')) fail(`${label} contains an invalid character`);
  return value;
}

function nextId(rawId, freshIds, label) {
  return freshIds ? crypto.randomUUID() : normalizeId(rawId, label);
}

function normalizeAnchor(raw, { freshIds, label, seenIds }) {
  const value = record(raw, label);
  const id = nextId(value.id, freshIds, `${label} ID`);
  if (seenIds.has(id)) fail(`${label} has a duplicate ID`);
  seenIds.add(id);
  const url = normalizeHttpUrl(value.url, `${label} URL`);
  const title = boundedText(value.title ?? url, `${label} title`, DATA_LIMITS.title, { optional: true }) || url;
  return { id, url, title };
}

export function normalizeAnchorItems(value, {
  freshIds = false,
  label = 'Anchors',
  maxAnchors = DATA_LIMITS.anchorsPerSpace,
  seenIds = new Set()
} = {}) {
  if (!Array.isArray(value)) fail(`${label} must be a list`);
  const items = [];
  let anchorCount = 0;
  for (let index = 0; index < value.length; index++) {
    const raw = record(value[index], `${label} item ${index + 1}`);
    if (raw.type === 'folder') {
      const id = nextId(raw.id, freshIds, `${label} folder ID`);
      if (seenIds.has(id)) fail(`${label} has a duplicate ID`);
      seenIds.add(id);
      if (!Array.isArray(raw.children)) fail(`${label} folder children must be a list`);
      const children = [];
      for (let childIndex = 0; childIndex < raw.children.length; childIndex++) {
        const child = raw.children[childIndex];
        if (child?.type === 'folder') fail(`${label} cannot contain nested folders`);
        children.push(normalizeAnchor(child, {
          freshIds,
          label: `${label} folder anchor ${childIndex + 1}`,
          seenIds
        }));
        anchorCount++;
        if (anchorCount > maxAnchors) fail(`${label} contains too many anchors`);
      }
      items.push({
        id,
        type: 'folder',
        name: boundedText(raw.name, `${label} folder name`, DATA_LIMITS.name),
        collapsed: raw.collapsed === undefined
          ? true
          : (typeof raw.collapsed === 'boolean' ? raw.collapsed : fail(`${label} folder state is invalid`)),
        children
      });
    } else {
      items.push(normalizeAnchor(raw, { freshIds, label: `${label} item ${index + 1}`, seenIds }));
      anchorCount++;
      if (anchorCount > maxAnchors) fail(`${label} contains too many anchors`);
    }
  }
  return { items, anchorCount, seenIds };
}

export function normalizeFavorites(value, { freshIds = false, seenIds = new Set() } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('Favorites must be a list');
  if (value.length > DATA_LIMITS.favorites) fail('Favorites contains too many entries');
  return value.map((favorite, index) => normalizeAnchor(favorite, {
    freshIds,
    label: `Favorite ${index + 1}`,
    seenIds
  }));
}

function normalizeSettings(value) {
  if (value === undefined || value === null) return {};
  const settings = record(value, 'Settings');
  const out = {};
  const numeric = {
    autoResetHours: [0, 24 * 30],
    suspendMinutes: [0, 60 * 24 * 30],
    archiveHours: [0, 24 * 365]
  };
  for (const [key, [min, max]] of Object.entries(numeric)) {
    if (settings[key] === undefined) continue;
    if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max) {
      fail(`Setting ${key} is invalid`);
    }
    out[key] = settings[key];
  }
  for (const key of ['keepAnchorTabs', 'dedup']) {
    if (settings[key] === undefined) continue;
    if (typeof settings[key] !== 'boolean') fail(`Setting ${key} is invalid`);
    out[key] = settings[key];
  }
  return out;
}

function normalizeSyncMeta(value, validSpaceIds, seenIds) {
  const meta = record(value, 'Metadata');
  if (!Array.isArray(meta.spaces) || !meta.spaces.length) fail('Metadata must contain at least one Space');
  if (meta.spaces.length > DATA_LIMITS.spaces) fail('Metadata contains too many Spaces');
  const spaces = [];
  for (let index = 0; index < meta.spaces.length; index++) {
    const space = record(meta.spaces[index], `Space ${index + 1}`);
    const id = normalizeId(space.id, `Space ${index + 1} ID`);
    if (validSpaceIds.has(id)) fail('Metadata contains duplicate Space IDs');
    validSpaceIds.add(id);
    spaces.push({
      id,
      name: boundedText(space.name, `Space ${index + 1} name`, DATA_LIMITS.name),
      color: normalizeColor(space.color, '#7c9cff', `Space ${index + 1} color`),
      icon: normalizeIcon(space.icon, `Space ${index + 1} icon`)
    });
  }
  const activeSpaceId = validSpaceIds.has(meta.activeSpaceId) ? meta.activeSpaceId : spaces[0].id;
  return {
    version: Number.isInteger(meta.version) && meta.version > 0 ? meta.version : 1,
    spaces,
    favorites: normalizeFavorites(meta.favorites, { seenIds }),
    activeSpaceId,
    settings: normalizeSettings(meta.settings)
  };
}

function normalizeLineage(value) {
  if (value === undefined || value === null) return undefined;
  const sync = record(value, 'Sync metadata');
  const revision = normalizeId(sync.revision, 'Sync revision');
  if (!Array.isArray(sync.lineage) || sync.lineage.length > DATA_LIMITS.lineage) {
    fail('Sync lineage is invalid');
  }
  const lineage = sync.lineage.map((entry, index) => normalizeId(entry, `Sync lineage entry ${index + 1}`));
  if (new Set(lineage).size !== lineage.length || lineage.includes(revision)) fail('Sync lineage is invalid');
  return { revision, lineage };
}

export function validateSyncState(value) {
  const state = record(value, 'Sync state');
  if (!Number.isFinite(state.updatedAt) || state.updatedAt < 0) fail('Sync timestamp is invalid');
  const validSpaceIds = new Set();
  const seenIds = new Set();
  const meta = normalizeSyncMeta(state.meta, validSpaceIds, seenIds);
  const sourceData = record(state.data, 'Sync data');
  const data = {};
  let totalAnchors = meta.favorites.length;
  const spaceAnchorCounts = new Map();

  for (const [key, raw] of Object.entries(sourceData)) {
    let match = key.match(/^anchors_(.+?)(?:__(\d+))?$/);
    if (match) {
      const spaceId = normalizeId(match[1], 'Anchor storage Space ID');
      if (!validSpaceIds.has(spaceId)) fail('Sync data contains anchors for an unknown Space');
      const currentSpaceCount = spaceAnchorCounts.get(spaceId) || 0;
      const normalized = normalizeAnchorItems(raw, {
        label: `Anchors for ${spaceId}`,
        seenIds,
        maxAnchors: DATA_LIMITS.anchorsPerSpace - currentSpaceCount
      });
      spaceAnchorCounts.set(spaceId, currentSpaceCount + normalized.anchorCount);
      totalAnchors += normalized.anchorCount;
      if (totalAnchors > DATA_LIMITS.anchorsTotal) fail('Sync data contains too many anchors');
      data[key] = normalized.items;
      continue;
    }
    match = key.match(/^note_(.+)$/);
    if (match) {
      const spaceId = normalizeId(match[1], 'Note storage Space ID');
      if (!validSpaceIds.has(spaceId)) fail('Sync data contains a note for an unknown Space');
      data[key] = normalizeNote(raw, `Note for ${spaceId}`);
      continue;
    }
    fail(`Sync data contains an unsupported key: ${key}`);
  }

  const normalized = { updatedAt: state.updatedAt, meta, data };
  const syncMeta = normalizeLineage(state.syncMeta);
  if (syncMeta) normalized.syncMeta = syncMeta;
  return normalized;
}

export function assertImportFileSize(file) {
  if (Number.isFinite(file?.size) && file.size > DATA_LIMITS.importBytes) {
    fail('Import file is too large');
  }
}
