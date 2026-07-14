import {
  PALETTE, normalizeUrl,
  loadMeta, saveMeta, loadAnchors, saveAnchors, deleteAnchors, cleanupOrphans,
  loadNote, saveNote,
  getBindings, setBindings, getLastActive, setLastActive
} from './shared.js';
import { syncNow, getSyncConfig, setSyncConfig } from './sync.js';

let meta = null;
let anchors = [];   // Items are anchors {id,url,title} or folders {id,type:'folder',name,collapsed,children:[]}.
let currentWindowId = null;
let renderTimer = null;
let dragId = null;
let noteOpen = false;
let archiveOpen = false;
let noteTimer = null;
let importing = false; // Ignore storage.onChanged while an import is writing multiple related keys.

const $ = (sel) => document.querySelector(sel);

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function applyI18n() {
  document.documentElement.lang = chrome.i18n.getMessage('@@ui_locale') || 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

const isFolder = (item) => item && item.type === 'folder';

// Browser-internal pages (vivaldi://, chrome://, the panel itself, and so on)
// cannot be used as anchors or appear in Today.
function isWebUrl(u) {
  return typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'));
}

function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '16');
  return u.toString();
}

function fallbackFavicon(pageUrl) {
  try {
    return 'https://icons.duckduckgo.com/ip3/' + new URL(pageUrl).hostname + '.ico';
  } catch (e) {
    return '';
  }
}

async function currentWindow() {
  if (currentWindowId !== null) {
    const w = await chrome.windows.get(currentWindowId).catch(() => null);
    if (w) return currentWindowId;
  }
  const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  currentWindowId = w.id;
  return currentWindowId;
}

function activeSpace() {
  return meta.spaces.find(s => s.id === meta.activeSpaceId) || meta.spaces[0];
}

// Locate an item by id at the top level or inside a folder.
function findLoc(id) {
  for (let i = 0; i < anchors.length; i++) {
    const it = anchors[i];
    if (it.id === id) return { arr: anchors, index: i, item: it };
    if (isFolder(it)) {
      const j = (it.children || []).findIndex(c => c.id === id);
      if (j >= 0) return { arr: it.children, index: j, item: it.children[j] };
    }
  }
  return null;
}

async function persist() {
  try {
    await saveAnchors(activeSpace().id, anchors);
  } catch (e) {
    toast(t('saveError', e.message));
  }
}

// ---------- toasts and dialogs (prompt/confirm do not work in a Vivaldi Web Panel) ----------

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

const SPACE_EMOJIS = ['🏠', '💼', '🎮', '📚', '🎬', '🛒', '✈️', '💰', '🧪', '🎧', '🌐', '❤️'];

function showDialog({ title, withInput = false, initial = '', inputType = 'text', withColors = false, color = PALETTE[0], withIcon = false, icon = '', okText = t('okButton'), onOk }) {
  const overlay = $('#dialog-overlay');
  $('#dialog-title').textContent = title;
  const input = $('#dialog-input');
  input.style.display = withInput ? '' : 'none';
  input.type = inputType;
  input.value = initial;

  let chosenColor = color;

  const iconRow = $('#dialog-icon-row');
  iconRow.style.display = withIcon ? '' : 'none';
  const iconInput = $('#dialog-icon');
  iconInput.value = icon;

  // Use the space color behind each emoji, matching the final space button.
  const paintIcons = () => {
    if (!withIcon) return;
    document.querySelectorAll('#dialog-icons .icon-pick').forEach(d => {
      d.style.backgroundColor = chosenColor;
    });
    iconInput.style.backgroundColor = chosenColor;
  };

  if (withIcon) {
    const icons = $('#dialog-icons');
    icons.innerHTML = '';
    for (const em of SPACE_EMOJIS) {
      const d = document.createElement('div');
      d.className = 'icon-pick';
      d.textContent = em;
      d.onclick = () => { iconInput.value = em; };
      icons.appendChild(d);
    }
  }

  const colorsEl = $('#dialog-colors');
  colorsEl.style.display = withColors ? '' : 'none';
  if (withColors) {
    colorsEl.innerHTML = '';
    for (const c of PALETTE) {
      const dot = document.createElement('div');
      dot.className = 'color-dot' + (c === chosenColor ? ' chosen' : '');
      dot.style.backgroundColor = c;
      dot.onclick = () => {
        chosenColor = c;
        colorsEl.querySelectorAll('.color-dot').forEach(d => d.classList.remove('chosen'));
        dot.classList.add('chosen');
        paintIcons();
      };
      colorsEl.appendChild(dot);
    }
  }
  paintIcons();

  const close = () => { overlay.style.display = 'none'; };
  $('#dialog-ok').textContent = okText;
  $('#dialog-ok').onclick = () => {
    if (withInput && !input.value.trim()) return;
    close();
    onOk(input.value.trim(), chosenColor, iconInput.value.trim());
  };
  $('#dialog-cancel').onclick = close;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') $('#dialog-ok').click();
    if (e.key === 'Escape') close();
  };
  overlay.style.display = 'flex';
  if (withInput) { input.focus(); input.select(); }
}

// ---------- context menu ----------

function closeMenu() {
  $('#menu')?.remove();
}

function showMenu(anchorEl, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.id = 'menu';
  for (const it of items) {
    const btn = document.createElement('button');
    btn.textContent = it.label;
    if (it.disabled) btn.disabled = true;
    btn.onclick = () => { closeMenu(); it.action(); };
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const mh = menu.offsetHeight;
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + 'px';
  menu.style.top = (r.bottom + mh > window.innerHeight ? r.top - mh : r.bottom) + 'px';
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}

// ---------- drag and drop ----------

function makeDraggable(li, item) {
  li.draggable = true;
  li.dataset.id = item.id;
  li.ondragstart = (e) => { dragId = item.id; li.classList.add('dragging'); e.stopPropagation(); };
  li.ondragend = () => { dragId = null; li.classList.remove('dragging'); };
  li.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); };
  li.ondrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragId || dragId === item.id) return;
    const src = findLoc(dragId);
    if (!src) return;
    const [moved] = src.arr.splice(src.index, 1);
    const dst = findLoc(item.id);
    if (!dst) { src.arr.splice(src.index, 0, moved); return; }
    if (isFolder(dst.item) && !isFolder(moved)) {
      // Dropping an anchor on a folder moves it into that folder.
      dst.item.children = dst.item.children || [];
      dst.item.children.push(moved);
      dst.item.collapsed = false;
    } else {
      // Otherwise insert before the target on its level; folders cannot be nested.
      dst.arr.splice(dst.index, 0, moved);
    }
    await persist();
    render();
  };
}

// ---------- rendering ----------

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
}

function anchorRow(a, tabs, bindings, depth) {
  const li = document.createElement('li');
  if (depth > 0) li.classList.add('depth1');

  const boundTab = bindings[a.id] ? tabs.find(t => t.id === bindings[a.id]) : null;
  const isAway = boundTab && normalizeUrl(boundTab.url) !== normalizeUrl(a.url);
  if (boundTab && boundTab.active) li.classList.add('active');
  if (isAway) li.classList.add('away');
  if (boundTab && boundTab.discarded) li.classList.add('asleep');

  const img = document.createElement('img');
  img.className = 'favicon';
  img.src = faviconUrl(a.url);
  img.onerror = () => { img.onerror = null; img.src = fallbackFavicon(a.url); };

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = a.title || a.url;
  title.title = a.url;

  const homeBtn = document.createElement('button');
  homeBtn.className = 'btn';
  homeBtn.textContent = '⌂';
  homeBtn.title = t('returnHomeTitle');
  homeBtn.onclick = (e) => { e.stopPropagation(); goHome(a); };

  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = t('actionsTitle');
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    showMenu(li, [
      { label: t('goHomeAction'), action: () => goHome(a) },
      { label: t('popOutAction'), action: () => popOut(a) },
      {
        label: t('makeCurrentHomeAction'),
        disabled: !isAway,
        action: async () => {
          a.url = boundTab.url;
          await persist();
          toast(t('homeUpdatedToast'));
          render();
        }
      },
      { label: t('clearSiteDataAction'), action: () => clearSiteData(a) },
      {
        label: t('renameAction'),
        action: () => showDialog({
          title: t('anchorNameDialog'), withInput: true, initial: a.title || '',
          onOk: async (name) => {
            a.title = name;
            await persist();
            render();
          }
        })
      },
      {
        label: t('unpinAction'),
        action: async () => {
          const loc = findLoc(a.id);
          if (loc) loc.arr.splice(loc.index, 1);
          await persist();
          render();
        }
      }
    ]);
  };

  li.append(img, title, homeBtn, menuBtn);
  li.onclick = () => openAnchor(a);
  makeDraggable(li, a);
  return li;
}

function folderRow(f) {
  const li = document.createElement('li');
  li.classList.add('folder');

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = f.collapsed ? '▸' : '▾';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = f.name;

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = (f.children || []).length || '';

  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = t('actionsTitle');
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    showMenu(li, [
      {
        label: t('pinCurrentHereAction'),
        action: () => addCurrentTab(f)
      },
      {
        label: t('renameAction'),
        action: () => showDialog({
          title: t('folderNameDialog'), withInput: true, initial: f.name,
          onOk: async (name) => {
            f.name = name;
            await persist();
            render();
          }
        })
      },
      {
        label: t('deleteFolderAction'),
        action: async () => {
          const loc = findLoc(f.id);
          if (!loc) return;
          loc.arr.splice(loc.index, 1, ...(f.children || []));
          await persist();
          render();
        }
      }
    ]);
  };

  li.append(twisty, title, count, menuBtn);
  li.onclick = async () => {
    f.collapsed = !f.collapsed;
    await persist();
    render();
  };
  makeDraggable(li, f);
  return li;
}

async function renderArchive() {
  const { archive } = await chrome.storage.local.get('archive');
  const arch = archive || [];
  $('#archive-count').textContent = arch.length ? `(${arch.length})` : '';
  $('#archive-twisty').textContent = archiveOpen ? '▾' : '▸';
  $('#archive-search').style.display = archiveOpen && arch.length ? '' : 'none';
  $('#archive-clear').style.display = archiveOpen && arch.length ? '' : 'none';

  const list = $('#archive');
  list.innerHTML = '';
  if (!archiveOpen) return;

  const q = $('#archive-search').value.trim().toLowerCase();
  const filtered = q
    ? arch.filter(e => (e.title || '').toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q))
    : arch;

  for (const entry of filtered.slice(0, 100)) {
    const li = document.createElement('li');

    const img = document.createElement('img');
    img.className = 'favicon';
    img.src = faviconUrl(entry.url);
    img.onerror = () => { img.onerror = null; img.src = fallbackFavicon(entry.url); };

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.title || entry.url;
    title.title = entry.url;

    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.textContent = '✕';
    delBtn.title = t('removeFromArchiveTitle');
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const { archive: cur } = await chrome.storage.local.get('archive');
      await chrome.storage.local.set({ archive: (cur || []).filter(x => x !== null && !(x.url === entry.url && x.at === entry.at)) });
      renderArchive();
    };

    li.append(img, title, delBtn);
    li.onclick = async (e) => {
      const winId = await currentWindow();
      await chrome.tabs.create({ url: entry.url, windowId: winId });
      const { archive: cur } = await chrome.storage.local.get('archive');
      await chrome.storage.local.set({ archive: (cur || []).filter(x => x !== null && !(x.url === entry.url && x.at === entry.at)) });
      renderArchive();
    };
    list.appendChild(li);
  }
}

async function render() {
  const space = activeSpace();
  const winId = await currentWindow();
  const bindings = await getBindings();
  const tabs = await chrome.tabs.query({ windowId: winId });
  const boundTabIds = new Set(Object.values(bindings));

  // Spaces.
  const spacesEl = $('#spaces');
  spacesEl.innerHTML = '';
  for (const s of meta.spaces) {
    const dot = document.createElement('div');
    dot.className = 'space-dot' + (s.id === space.id ? ' active' : '');
    dot.style.backgroundColor = s.color;
    dot.style.color = s.color;
    dot.textContent = s.icon || s.name[0]?.toUpperCase() || '?';
    if (s.icon) dot.classList.add('has-icon');
    dot.title = s.name;
    dot.onclick = async () => {
      meta.activeSpaceId = s.id;
      await saveMeta(meta);
      anchors = await loadAnchors(s.id);
      await loadNoteUI();
      render();
    };
    dot.ondblclick = () => editSpace(s);
    dot.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(dot, [
        { label: t('editSpaceAction'), action: () => editSpace(s) },
        { label: t('deleteSpaceAction'), disabled: meta.spaces.length <= 1, action: () => removeSpace(s) }
      ]);
    };
    spacesEl.appendChild(dot);
  }
  const sn = $('#space-name');
  sn.textContent = (space.icon ? space.icon + ' ' : '') + space.name;
  sn.style.color = space.color;

  // Anchors and folders.
  const list = $('#anchors');
  list.innerHTML = '';
  for (const item of anchors) {
    if (isFolder(item)) {
      list.appendChild(folderRow(item));
      if (!item.collapsed) {
        for (const child of (item.children || [])) {
          list.appendChild(anchorRow(child, tabs, bindings, 1));
        }
      }
    } else {
      list.appendChild(anchorRow(item, tabs, bindings, 0));
    }
  }

  // Space note.
  $('#note-twisty').textContent = noteOpen ? '▾' : '▸';
  $('#note').style.display = noteOpen ? '' : 'none';

  // Today contains regular web tabs that are not bound to anchors.
  const today = $('#today');
  today.innerHTML = '';
  for (const tab of tabs) {
    if (tab.pinned || boundTabIds.has(tab.id) || !isWebUrl(tab.url)) continue;
    const li = document.createElement('li');
    if (tab.active) li.classList.add('active');

    const img = document.createElement('img');
    img.className = 'favicon';
    img.src = tab.favIconUrl || faviconUrl(tab.url);
    img.onerror = () => { img.onerror = null; img.src = fallbackFavicon(tab.url); };

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || tab.url;

    const pinBtn = document.createElement('button');
    pinBtn.className = 'btn';
    pinBtn.textContent = '⚓';
    pinBtn.title = t('pinAsAnchorTitle');
    pinBtn.onclick = (e) => { e.stopPropagation(); pinTab(tab); };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = '✕';
    closeBtn.title = t('closeTitle');
    closeBtn.onclick = (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id); };

    li.append(img, title, pinBtn, closeBtn);
    li.onclick = () => chrome.tabs.update(tab.id, { active: true });
    today.appendChild(li);
  }

  await renderArchive();

  $('#autoreset').value = String(meta.settings.autoResetHours);
  $('#suspend').value = String(meta.settings.suspendMinutes);
  $('#archive-hours').value = String(meta.settings.archiveHours);
  $('#delete-space').style.display = meta.spaces.length <= 1 ? 'none' : '';
}

// ---------- actions ----------

async function openAnchor(a) {
  const bindings = await getBindings();
  const winId = await currentWindow();
  let tab = bindings[a.id] ? await chrome.tabs.get(bindings[a.id]).catch(() => null) : null;

  if (tab) {
    if (tab.active && tab.windowId === winId) {
      await goHome(a, tab);
    } else {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } else {
    tab = await chrome.tabs.create({ url: a.url, windowId: winId });
    await bindTab(a, tab);
  }
  scheduleRender();
}

async function bindTab(a, tab) {
  const bindings = await getBindings();
  bindings[a.id] = tab.id;
  await setBindings(bindings);
  const la = await getLastActive();
  la[a.id] = Date.now();
  await setLastActive(la);
}

async function goHome(a, tab = null) {
  const bindings = await getBindings();
  if (!tab && bindings[a.id]) tab = await chrome.tabs.get(bindings[a.id]).catch(() => null);
  if (!tab) return openAnchor(a);
  if (normalizeUrl(tab.url) !== normalizeUrl(a.url)) {
    await chrome.tabs.update(tab.id, { url: a.url });
  }
  scheduleRender();
}

// Move an existing anchor tab to a separate window, or create a new window for it.
async function popOut(a) {
  const bindings = await getBindings();
  const tab = bindings[a.id] ? await chrome.tabs.get(bindings[a.id]).catch(() => null) : null;
  if (tab) {
    await chrome.windows.create({ tabId: tab.id, focused: true });
  } else {
    const win = await chrome.windows.create({ url: a.url, focused: true });
    if (win.tabs && win.tabs[0]) await bindTab(a, win.tabs[0]);
  }
  scheduleRender();
}

async function pinTab(tab, folder = null) {
  if (!isWebUrl(tab.url)) { toast(t('invalidPageToast')); return; }
  const anchor = { id: crypto.randomUUID(), url: tab.url, title: tab.title || tab.url };
  if (folder) {
    folder.children = folder.children || [];
    folder.children.push(anchor);
    folder.collapsed = false;
  } else {
    anchors.push(anchor);
  }
  await persist();
  await bindTab(anchor, tab);
  render();
}

async function addCurrentTab(folder = null) {
  const winId = await currentWindow();
  const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
  if (!tab || !isWebUrl(tab.url)) {
    toast(t('addCurrentTabToast'));
    return;
  }
  await pinTab(tab, folder);
}

function addFolder() {
  showDialog({
    title: t('newFolderDialog'), withInput: true, okText: t('createButton'),
    onOk: async (name) => {
      anchors.push({ id: crypto.randomUUID(), type: 'folder', name, collapsed: false, children: [] });
      await persist();
      render();
    }
  });
}

async function clearSiteData(a) {
  let origin, hostname;
  try {
    const u = new URL(a.url);
    origin = u.origin;
    hostname = u.hostname;
  } catch (e) { return; }

  // Clear cookies, site storage, and service workers for this exact origin.
  await chrome.browsingData.remove({ origins: [origin] }, {
    cookies: true,
    localStorage: true,
    indexedDB: true,
    serviceWorkers: true,
    cacheStorage: true,
    fileSystems: true,
    webSQL: true
  }).catch(() => {});

  // browsingData does not cover every parent-domain cookie, so remove those explicitly.
  const bare = hostname.replace(/^www\./, '');
  const cookies = await chrome.cookies.getAll({ domain: bare }).catch(() => []);
  await Promise.all(cookies.map(c => {
    const host = c.domain.replace(/^\./, '');
    return chrome.cookies.remove({
      url: (c.secure ? 'https://' : 'http://') + host + c.path,
      name: c.name,
      storeId: c.storeId
    }).catch(() => {});
  }));

  // Reload the bound tab without HTTP cache; Chromium cannot clear that cache per origin.
  const bindings = await getBindings();
  if (bindings[a.id]) {
    const tab = await chrome.tabs.get(bindings[a.id]).catch(() => null);
    if (tab) await chrome.tabs.reload(tab.id, { bypassCache: true }).catch(() => {});
  }
  toast(t('siteDataClearedToast', [hostname, String(cookies.length)]));
}

function addSpace() {
  showDialog({
    title: t('newSpaceDialog'), withInput: true, withColors: true, withIcon: true,
    color: PALETTE[meta.spaces.length % PALETTE.length], okText: t('createButton'),
    onOk: async (name, color, icon) => {
      const space = { id: crypto.randomUUID(), name, color, icon: icon || '' };
      meta.spaces.push(space);
      meta.activeSpaceId = space.id;
      await saveMeta(meta);
      anchors = [];
      await loadNoteUI();
      render();
    }
  });
}

function editSpace(space) {
  showDialog({
    title: t('spaceDialogTitle', space.name), withInput: true, initial: space.name,
    withColors: true, color: space.color,
    withIcon: true, icon: space.icon || '',
    onOk: async (name, color, icon) => {
      space.name = name;
      space.color = color;
      space.icon = icon || '';
      await saveMeta(meta);
      render();
    }
  });
}

function removeSpace(space) {
  if (meta.spaces.length <= 1) return;
  showDialog({
    title: t('deleteSpaceDialog', space.name), okText: t('deleteButton'),
    onOk: async () => {
      await deleteAnchors(space.id);
      await saveNote(space.id, '');
      meta.spaces = meta.spaces.filter(s => s.id !== space.id);
      if (!meta.spaces.find(s => s.id === meta.activeSpaceId)) {
        meta.activeSpaceId = meta.spaces[0].id;
      }
      await saveMeta(meta);
      anchors = await loadAnchors(meta.activeSpaceId);
      await loadNoteUI();
      render();
    }
  });
}

// ---------- space note ----------

async function loadNoteUI() {
  const text = await loadNote(activeSpace().id);
  $('#note').value = text;
  noteOpen = !!text;
}

function onNoteInput() {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    await saveNote(activeSpace().id, $('#note').value);
  }, 800);
}

// ---------- import and export ----------

function countAnchors(items) {
  let n = 0;
  for (const it of items) n += isFolder(it) ? (it.children || []).length : 1;
  return n;
}

// Parse Arc StorableSidebar.json; the format is the same on Windows and macOS.
function parseArcSidebar(obj) {
  const container = (obj.sidebar?.containers || []).find(c => c && c.spaces && c.items);
  if (!container) throw new Error(t('arcInvalidFileError'));

  const itemById = {};
  for (const it of container.items) {
    if (it && typeof it === 'object' && it.id) itemById[it.id] = it;
  }

  const walk = (childIds, into, allowFolders) => {
    for (const cid of (childIds || [])) {
      const it = itemById[cid];
      if (!it) continue;
      const data = it.data || {};
      if (data.tab && data.tab.savedURL) {
        into.push({
          id: crypto.randomUUID(),
          url: data.tab.savedURL,
          title: it.title || data.tab.savedTitle || data.tab.savedURL
        });
      } else if (data.list !== undefined) {
        if (allowFolders) {
          const folder = { id: crypto.randomUUID(), type: 'folder', name: it.title || t('defaultFolderName'), collapsed: true, children: [] };
          walk(it.childrenIds, folder.children, false); // Flatten nested folders.
          if (folder.children.length) into.push(folder);
        } else {
          walk(it.childrenIds, into, false);
        }
      } else if (data.splitView !== undefined || data.itemContainer !== undefined) {
        walk(it.childrenIds, into, allowFolders);
      }
    }
  };

  const out = [];
  for (const s of container.spaces) {
    if (!s || typeof s !== 'object') continue;
    const ids = s.containerIDs || [];
    const pinnedIdx = ids.indexOf('pinned');
    const pinnedId = pinnedIdx >= 0 ? ids[pinnedIdx + 1] : null;
    const root = pinnedId ? itemById[pinnedId] : null;
    if (!root) continue;
    const items = [];
    walk(root.childrenIds, items, true);
    if (items.length) out.push({ name: s.title || t('defaultImportedSpaceName'), items });
  }
  return out;
}

async function importSpaces(spacesIn, sourceLabel) {
  importing = true;
  try {
    let spaceCount = 0, anchorCount = 0;
    for (const sp of spacesIn) {
      const space = {
        id: crypto.randomUUID(),
        name: sp.name,
        color: sp.color || PALETTE[meta.spaces.length % PALETTE.length],
        icon: sp.icon || ''
      };
      meta.spaces.push(space);
      await saveAnchors(space.id, sp.items);
      if (sp.note) await saveNote(space.id, sp.note);
      spaceCount++;
      anchorCount += countAnchors(sp.items);
    }
    await saveMeta(meta);
    anchors = await loadAnchors(activeSpace().id);
    toast(t('importSummaryToast', [sourceLabel, String(spaceCount), String(anchorCount)]));
    render();
  } finally {
    importing = false;
  }
}

async function handleImportFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    if (obj.format === 'anchors-export') {
      await importSpaces(obj.spaces || [], t('anchorsFileSource'));
    } else if (obj.sidebar) {
      await importSpaces(parseArcSidebar(obj), t('arcSource'));
    } else {
      toast(t('unknownImportFormatToast'));
    }
  } catch (e) {
    toast(t('importErrorToast', e.message));
  }
}

async function exportToFile() {
  const payload = { format: 'anchors-export', version: 1, exportedAt: new Date().toISOString(), spaces: [] };
  for (const s of meta.spaces) {
    payload.spaces.push({
      name: s.name,
      color: s.color,
      icon: s.icon || '',
      items: await loadAnchors(s.id),
      note: await loadNote(s.id)
    });
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const aEl = document.createElement('a');
  aEl.href = url;
  aEl.download = 'anchors-export-' + new Date().toISOString().slice(0, 10) + '.json';
  aEl.click();
  URL.revokeObjectURL(url);
}

// ---------- GitHub Gist sync ----------

const SYNC_STATUS_TEXT = {
  off: t('syncStatusOff'),
  created: t('syncStatusCreated'),
  linked: t('syncStatusLinked'),
  pulled: t('syncStatusPulled'),
  pushed: t('syncStatusPushed'),
  uptodate: t('syncStatusUptodate')
};

async function runSync() {
  try {
    const r = await syncNow();
    toast(SYNC_STATUS_TEXT[r.status] || r.status);
    if (r.status === 'pulled' || r.status === 'linked') {
      meta = await loadMeta();
      anchors = await loadAnchors(activeSpace().id);
      await loadNoteUI();
      render();
    }
  } catch (e) {
    toast(t('syncErrorToast', e.message));
  }
}

async function showSyncMenu(el) {
  const cfg = await getSyncConfig();
  const status = cfg.token
    ? (cfg.lastSyncAt
      ? t('syncEnabledLastStatus', new Date(cfg.lastSyncAt).toLocaleTimeString())
      : t('syncEnabledStatus'))
    : t('syncDisabledStatus');
  showMenu(el, [
    { label: 'ℹ ' + status, disabled: true, action: () => {} },
    {
      label: '🔑 ' + (cfg.token ? t('replaceGitHubTokenAction') : t('connectGitHubAction')),
      action: () => showDialog({
        title: t('githubTokenDialog'), withInput: true, inputType: 'password', okText: t('saveButton'),
        onOk: async (token) => {
          await setSyncConfig({ ...cfg, token });
          runSync();
        }
      })
    },
    { label: t('syncNowAction'), disabled: !cfg.token, action: runSync },
    {
      label: (meta.settings.dedup ? '☑ ' : '☐ ') + t('dedupAction'),
      action: async () => {
        meta.settings.dedup = !meta.settings.dedup;
        await saveMeta(meta);
        toast(t(meta.settings.dedup ? 'dedupEnabledToast' : 'dedupDisabledToast'));
      }
    },
    { label: t('importAction'), action: () => $('#import-file').click() },
    { label: t('exportAction'), action: exportToFile },
    {
      label: t('disableSyncAction'),
      disabled: !cfg.token,
      action: async () => {
        await setSyncConfig({ token: '', gistId: cfg.gistId, lastSyncAt: 0 });
        toast(t('syncDisabledToast'));
      }
    }
  ]);
}

// ---------- initialization ----------

async function init() {
  applyI18n();
  meta = await loadMeta();
  await cleanupOrphans(meta).catch(() => {});
  anchors = await loadAnchors(activeSpace().id);
  await loadNoteUI();

  $('#add-anchor').onclick = () => addCurrentTab();
  $('#add-folder').onclick = addFolder;
  $('#add-space').onclick = addSpace;
  $('#rename-space').onclick = (e) => { e.preventDefault(); editSpace(activeSpace()); };
  $('#delete-space').onclick = (e) => { e.preventDefault(); removeSpace(activeSpace()); };
  $('#sync-menu').onclick = (e) => { e.preventDefault(); e.stopPropagation(); showSyncMenu(e.target); };
  $('#autoreset').onchange = async (e) => {
    meta.settings.autoResetHours = Number(e.target.value);
    await saveMeta(meta);
  };
  $('#suspend').onchange = async (e) => {
    meta.settings.suspendMinutes = Number(e.target.value);
    await saveMeta(meta);
  };
  $('#archive-hours').onchange = async (e) => {
    meta.settings.archiveHours = Number(e.target.value);
    await saveMeta(meta);
  };

  $('#note-head').onclick = () => { noteOpen = !noteOpen; render(); };
  $('#note').oninput = onNoteInput;
  $('#archive-head').onclick = (e) => {
    if (e.target.id === 'archive-clear') return;
    archiveOpen = !archiveOpen;
    renderArchive();
  };
  $('#archive-search').oninput = () => renderArchive();
  $('#archive-search').onclick = (e) => e.stopPropagation();
  $('#archive-clear').onclick = (e) => {
    e.stopPropagation();
    showDialog({
      title: t('clearArchiveDialog'), okText: t('clearButton'),
      onOk: async () => {
        await chrome.storage.local.set({ archive: [] });
        renderArchive();
      }
    });
  };
  $('#import-file').onchange = (e) => {
    if (e.target.files && e.target.files[0]) handleImportFile(e.target.files[0]);
    e.target.value = '';
  };

  chrome.tabs.onActivated.addListener(scheduleRender);
  chrome.tabs.onRemoved.addListener(scheduleRender);
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (info.status === 'complete' || info.title || info.favIconUrl || info.discarded !== undefined) scheduleRender();
  });
  chrome.windows.onFocusChanged.addListener((id) => {
    if (id !== chrome.windows.WINDOW_ID_NONE) { currentWindowId = null; scheduleRender(); }
  });
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.archive) { renderArchive(); return; }
    if (area !== 'sync' || importing) return;
    meta = await loadMeta();
    anchors = await loadAnchors(activeSpace().id);
    scheduleRender();
  });

  render();

  // Pull any changes made on another device when the panel opens.
  const cfg = await getSyncConfig();
  if (cfg.token) {
    syncNow().then(r => {
      if (r.status === 'pulled' || r.status === 'linked') {
        toast(SYNC_STATUS_TEXT[r.status]);
      }
    }).catch(() => {});
  }
}

init();
