import {
  PALETTE, normalizeUrl,
  loadMeta, saveMeta, loadAnchors, saveAnchors, deleteAnchors, cleanupOrphans,
  loadNote, saveNote,
  getBindings, isPersistentKey, purgeLegacyBrowserSync
} from './shared.js';
import {
  syncNow, migratePlaintextGist,
  getSyncConfig, setSyncConfig,
  generateSyncKey, normalizeSyncKey
} from './sync.js';

let meta = null;
let anchors = [];   // Items are anchors {id,url,title} or folders {id,type:'folder',name,collapsed,children:[]}.
let renderTimer = null;
let dragId = null;
let dragIsFolder = false;
let noteOpen = false;
let archiveOpen = false;
let noteTimer = null;
let importing = false; // Ignore storage.onChanged while an import is writing multiple related keys.
let settingsOpening = false;

const $ = (sel) => document.querySelector(sel);
const SVG_NS = 'http://www.w3.org/2000/svg';
const RUNTIME_PROTOCOL_VERSION = 2;

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

async function tabState(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    scope: 'anchors-tab-state',
    action,
    ...payload
  });
  if (!response?.ok) throw new Error(response?.error || 'Unknown tab error');
  return response;
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
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
}

const isFolder = (item) => item && item.type === 'folder';

// Inline SVG icon from the sprite in panel.html.
function icon(name, size = 14) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#' + name);
  svg.appendChild(use);
  return svg;
}

// ---------- space icons ----------
// A space icon is stored as a stable token ('icon:home'), a legacy emoji
// string, or ''. Emoji from existing user data keep rendering as-is.

const SPACE_ICONS = [
  ['icon:home', 's-home', 'iconHome'],
  ['icon:work', 's-work', 'iconWork'],
  ['icon:code', 's-code', 'iconCode'],
  ['icon:study', 's-study', 'iconStudy'],
  ['icon:travel', 's-travel', 'iconTravel'],
  ['icon:finance', 's-finance', 'iconFinance'],
  ['icon:shopping', 's-shopping', 'iconShopping'],
  ['icon:media', 's-media', 'iconMedia'],
  ['icon:music', 's-music', 'iconMusic'],
  ['icon:gaming', 's-gaming', 'iconGaming'],
  ['icon:ideas', 's-ideas', 'iconIdeas'],
  ['icon:projects', 's-projects', 'iconProjects'],
  ['icon:heart', 's-heart', 'iconHeart'],
  ['icon:lab', 's-lab', 'iconLab']
];

const isIconToken = (v) => typeof v === 'string' && v.startsWith('icon:');
const iconSymbol = (token) => {
  const hit = SPACE_ICONS.find(i => i[0] === token);
  return hit ? hit[1] : null;
};

// Element for a space's icon value: SVG for tokens, text for legacy emoji,
// null when the space has no icon.
function spaceGlyphEl(iconVal, size = 14) {
  if (isIconToken(iconVal)) {
    const sym = iconSymbol(iconVal);
    if (sym) return icon(sym, size);
    return null;
  }
  if (iconVal) {
    const s = document.createElement('span');
    s.textContent = iconVal;
    return s;
  }
  return null;
}

// 8-bit alpha tint of a hex color, for space-tinted surfaces.
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Collapsible section headers behave like buttons for keyboard users.
function pressable(el, handler) {
  el.addEventListener('click', handler);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler(e);
    }
  });
}

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

function localFallbackFavicon(pageUrl) {
  let hostname = '';
  try {
    hostname = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch (e) {
    // Keep the fallback generic for malformed or missing URLs.
  }

  const label = (hostname.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  let hash = 0;
  for (const char of hostname) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  const colors = ['#3b6bdc', '#147d75', '#8b5cc7', '#b45f2a', '#a13d64', '#4d6b8a'];
  const background = colors[hash % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${background}"/><text x="8" y="11.5" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="white">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function currentWindow() {
  // In a Chrome side panel, getCurrent() is the window that owns this panel.
  // Fall back for Chromium variants that expose panel.html as a standalone web panel.
  const current = await chrome.windows.getCurrent().catch(() => null);
  if (current?.id !== undefined && current.type === 'normal') return current.id;
  const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  return focused.id;
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

function collectAnchorIds(items) {
  const ids = [];
  for (const item of items || []) {
    if (isFolder(item)) {
      for (const child of item.children || []) ids.push(child.id);
    } else {
      ids.push(item.id);
    }
  }
  return ids;
}

async function persist() {
  try {
    await saveAnchors(activeSpace().id, anchors);
    return true;
  } catch (e) {
    toast(t('saveError', e.message));
    return false;
  }
}

// ---------- overlay stack ----------
// One stack for menus, dialogs, and the settings sheet. Escape closes only the
// topmost overlay; focus returns to the element that opened it; dialogs and
// the sheet trap Tab.

const overlays = [];

function openOverlay(o) {
  o.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlays.push(o);
  return o;
}

function closeOverlay(o, { restoreFocus = true } = {}) {
  const i = overlays.indexOf(o);
  if (i < 0) return;
  overlays.splice(i, 1);
  o.onClose();
  const active = document.activeElement;
  if (restoreFocus && o.opener && o.opener.isConnected && o.opener !== document.body) {
    o.opener.focus();
  } else if (active instanceof HTMLElement && o.el.contains(active)) {
    active.blur(); // Never leave focus on a control inside a hidden overlay.
  }
}

function findOverlay(name) {
  return overlays.find(o => o.name === name) || null;
}

function focusables(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]')]
    .filter(el => !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null);
}

function trapTab(e, root) {
  const f = focusables(root);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  const inside = root.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault();
    first.focus();
  }
}

function menuKeydown(e, ov) {
  const items = [...ov.el.querySelectorAll('button:not(:disabled)')];
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  else if (e.key === 'Tab') { e.preventDefault(); closeOverlay(ov); }
}

document.addEventListener('keydown', (e) => {
  const top = overlays[overlays.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeOverlay(top);
    return;
  }
  if (top.name === 'menu') { menuKeydown(e, top); return; }
  if (e.key === 'Tab' && top.trap) trapTab(e, top.el);
}, true);

// ---------- toasts and dialogs (prompt/confirm do not work in a Vivaldi Web Panel) ----------

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function showDialog({ title, withInput = false, initial = '', inputType = 'text', withColors = false, color = PALETTE[0], withIcon = false, icon: iconValue = '', okText = t('okButton'), danger = false, onOk }) {
  const existing = findOverlay('dialog');
  if (existing) closeOverlay(existing, { restoreFocus: false });

  const overlayEl = $('#dialog-overlay');
  $('#dialog-title').textContent = title;
  const input = $('#dialog-input');
  input.style.display = withInput ? '' : 'none';
  input.type = inputType;
  input.value = initial;
  input.setAttribute('aria-label', title);

  let chosenColor = color;
  let chosenIcon = iconValue;

  const iconsEl = $('#dialog-icons');
  $('#dialog-icon-label').style.display = withIcon ? '' : 'none';
  iconsEl.style.display = withIcon ? '' : 'none';

  const paint = () => {
    if (withIcon) {
      iconsEl.querySelectorAll('.icon-pick').forEach(d => {
        const pressed = d.dataset.value === chosenIcon;
        d.setAttribute('aria-pressed', String(pressed));
        d.style.backgroundColor = pressed ? chosenColor : '';
      });
    }
    if (withColors) {
      $('#dialog-colors').querySelectorAll('.color-dot').forEach(d => {
        d.setAttribute('aria-pressed', String(d.dataset.value === chosenColor));
      });
    }
  };

  if (withIcon) {
    iconsEl.innerHTML = '';
    const addPick = (value, labelText, contentEl) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'icon-pick';
      d.dataset.value = value;
      d.title = labelText;
      d.setAttribute('aria-label', labelText);
      d.setAttribute('aria-pressed', 'false');
      d.appendChild(contentEl);
      d.onclick = () => { chosenIcon = value; paint(); };
      iconsEl.appendChild(d);
    };
    addPick('', t('noIconOption'), icon('i-slash', 14));
    // An existing emoji from older data stays available so editing keeps it.
    if (iconValue && !isIconToken(iconValue)) {
      const em = document.createElement('span');
      em.textContent = iconValue;
      addPick(iconValue, iconValue, em);
    }
    for (const [token, sym, labelKey] of SPACE_ICONS) {
      addPick(token, t(labelKey), icon(sym, 14));
    }
  }

  const colorsEl = $('#dialog-colors');
  $('#dialog-color-label').style.display = withColors ? '' : 'none';
  colorsEl.style.display = withColors ? '' : 'none';
  if (withColors) {
    colorsEl.innerHTML = '';
    const colorNames = ['colorBlue', 'colorCoral', 'colorGreen', 'colorYellow', 'colorPurple', 'colorCyan', 'colorPink'];
    PALETTE.forEach((c, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'color-dot';
      dot.dataset.value = c;
      dot.style.backgroundColor = c;
      dot.style.color = c;
      dot.title = t(colorNames[i] || 'spaceColorGroup');
      dot.setAttribute('aria-label', t(colorNames[i] || 'spaceColorGroup'));
      dot.setAttribute('aria-pressed', 'false');
      dot.appendChild(icon('i-check', 11));
      dot.onclick = () => { chosenColor = c; paint(); };
      colorsEl.appendChild(dot);
    });
  }
  paint();

  const ok = $('#dialog-ok');
  ok.textContent = okText;
  ok.classList.toggle('danger', danger);

  const ov = openOverlay({
    name: 'dialog',
    el: $('#dialog'),
    trap: true,
    onClose: () => { overlayEl.classList.remove('show'); }
  });

  ok.onclick = () => {
    if (withInput && !input.value.trim()) return;
    closeOverlay(ov);
    onOk(input.value.trim(), chosenColor, chosenIcon.trim ? chosenIcon.trim() : chosenIcon);
  };
  $('#dialog-cancel').onclick = () => closeOverlay(ov);
  overlayEl.onclick = (e) => { if (e.target === overlayEl) closeOverlay(ov); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') ok.click();
  };
  overlayEl.classList.add('show');
  if (withInput) { input.focus(); input.select(); }
  else ok.focus();
}

// ---------- context menu ----------

// items: {icon, label, danger, disabled, action} or {sep:true}
function showMenu(anchorEl, items) {
  const existing = findOverlay('menu');
  if (existing) closeOverlay(existing, { restoreFocus: false });

  const menu = document.createElement('div');
  menu.id = 'menu';
  menu.setAttribute('role', 'menu');

  const onDocClick = () => closeOverlay(ov, { restoreFocus: false });
  const ov = openOverlay({
    name: 'menu',
    el: menu,
    trap: false,
    onClose: () => {
      menu.remove();
      document.removeEventListener('click', onDocClick);
    }
  });

  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.setAttribute('role', 'menuitem');
    btn.tabIndex = -1;
    if (it.icon) btn.appendChild(icon(it.icon));
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = it.label;
    btn.appendChild(label);
    if (it.danger) btn.classList.add('danger');
    if (it.disabled) btn.disabled = true;
    btn.onclick = () => { closeOverlay(ov); it.action(); };
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, r.bottom + mh > window.innerHeight - 8 ? r.top - mh : r.bottom) + 'px';
  const first = menu.querySelector('button:not(:disabled)');
  if (first) { first.tabIndex = 0; first.focus(); }
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

// ---------- drag and drop ----------

function clearDropMarks(li) {
  li.classList.remove('drop-before', 'drop-into');
}

function makeDraggable(li, item) {
  li.draggable = true;
  li.dataset.id = item.id;
  li.ondragstart = (e) => {
    dragId = item.id;
    dragIsFolder = isFolder(item);
    li.classList.add('dragging');
    e.stopPropagation();
  };
  li.ondragend = () => {
    dragId = null;
    li.classList.remove('dragging');
    document.querySelectorAll('.drop-before, .drop-into').forEach(clearDropMarks);
  };
  li.ondragover = (e) => {
    e.stopPropagation();
    if (!dragId || dragId === item.id) return;
    const dst = findLoc(item.id);
    if (dragIsFolder && dst && dst.arr !== anchors) {
      clearDropMarks(li);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    li.classList.toggle('drop-into', isFolder(item) && !dragIsFolder);
    li.classList.toggle('drop-before', !(isFolder(item) && !dragIsFolder));
  };
  li.ondragleave = () => clearDropMarks(li);
  li.ondrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearDropMarks(li);
    if (!dragId || dragId === item.id) return;
    const src = findLoc(dragId);
    const target = findLoc(item.id);
    if (!src || !target) return;
    // A folder may only live at the top level. Reject before mutating so an
    // invalid drop leaves the source array and its ordering untouched.
    if (isFolder(src.item) && target.arr !== anchors) return;
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

function rowButton(iconName, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.tabIndex = -1; // Every row action is also in the context menu.
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(icon(iconName));
  btn.onclick = onClick;
  return btn;
}

// li.row = non-interactive shell; button.row-main = the primary action.
function rowShell(mainLabel, onOpen) {
  const li = document.createElement('li');
  li.className = 'row';
  const main = document.createElement('button');
  main.className = 'row-main';
  main.setAttribute('aria-label', mainLabel);
  main.onclick = (e) => { e.stopPropagation(); onOpen(); };
  li.appendChild(main);
  li.onclick = (e) => { if (e.target === li) main.click(); };
  return { li, main };
}

function emptyHint(iconName, text) {
  const li = document.createElement('li');
  li.className = 'empty-hint';
  li.appendChild(icon(iconName));
  li.appendChild(document.createTextNode(text));
  return li;
}

function anchorRow(a, tabs, bindings, depth) {
  const boundTab = bindings[a.id] ? tabs.find(t => t.id === bindings[a.id]) : null;
  const isAway = boundTab && normalizeUrl(boundTab.url) !== normalizeUrl(a.url);
  const isAsleep = boundTab && boundTab.discarded;

  let label = a.title || a.url;
  if (isAway) label += ' — ' + t('awayTitle');
  if (isAsleep) label += ' — ' + t('sleepingTitle');

  const { li, main } = rowShell(label, () => openAnchor(a));
  if (depth > 0) li.classList.add('depth1');
  if (boundTab && boundTab.active) li.classList.add('active');
  if (isAway) li.classList.add('away');
  if (isAsleep) li.classList.add('asleep');

  const img = document.createElement('img');
  img.className = 'favicon';
  img.alt = '';
  img.src = faviconUrl(a.url);
  img.onerror = () => { img.onerror = null; img.src = localFallbackFavicon(a.url); };

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = a.title || a.url;
  main.title = isAway ? a.url + ' — ' + t('awayTitle') : a.url;

  const awayDot = document.createElement('span');
  awayDot.className = 'away-dot';
  awayDot.title = t('awayTitle');

  const sleepIcon = icon('i-moon', 12);
  sleepIcon.classList.add('sleep-icon');

  const menuItems = () => [
    { icon: 'i-home', label: t('goHomeAction'), action: () => goHome(a) },
    { icon: 'i-pop', label: t('popOutAction'), action: () => popOut(a) },
    {
      icon: 'i-anchor',
      label: t('makeCurrentHomeAction'),
      disabled: !isAway,
      action: async () => {
        a.url = boundTab.url;
        await persist();
        toast(t('homeUpdatedToast'));
        render();
      }
    },
    { icon: 'i-cookie', label: t('clearSiteDataAction'), action: () => clearSiteData(a) },
    { sep: true },
    {
      icon: 'i-pencil',
      label: t('renameAction'),
      action: () => showDialog({
        title: t('anchorNameDialog'), withInput: true, initial: a.title || '', okText: t('saveButton'),
        onOk: async (name) => {
          a.title = name;
          await persist();
          render();
        }
      })
    },
    {
      icon: 'i-x',
      label: t('unpinAction'),
      danger: true,
      action: async () => {
        const loc = findLoc(a.id);
        if (!loc) return;
        const [removed] = loc.arr.splice(loc.index, 1);
        if (!await persist()) {
          loc.arr.splice(loc.index, 0, removed);
          render();
          return;
        }
        await tabState('release', { anchorIds: [a.id] }).catch(() => {});
        render();
      }
    }
  ];

  const btns = document.createElement('span');
  btns.className = 'btns';
  btns.appendChild(rowButton('i-home', t('returnHomeTitle'), (e) => { e.stopPropagation(); goHome(a); }));
  btns.appendChild(rowButton('i-dots', t('actionsTitle'), (e) => { e.stopPropagation(); showMenu(li, menuItems()); }));

  main.append(img, title, awayDot, sleepIcon);
  li.appendChild(btns);
  li.oncontextmenu = (e) => { e.preventDefault(); showMenu(li, menuItems()); };
  makeDraggable(li, a);
  return li;
}

function folderRow(f) {
  const { li, main } = rowShell(f.name, async () => {
    f.collapsed = !f.collapsed;
    await persist();
    render();
  });
  li.classList.add('folder');
  main.setAttribute('aria-expanded', String(!f.collapsed));

  const twisty = icon('i-chev', 12);
  twisty.classList.add('twisty');
  if (!f.collapsed) twisty.classList.add('open');

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = f.name;

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = (f.children || []).length || '';

  const menuItems = () => [
    { icon: 'i-anchor', label: t('pinCurrentHereAction'), action: () => addCurrentTab(f) },
    {
      icon: 'i-pencil',
      label: t('renameAction'),
      action: () => showDialog({
        title: t('folderNameDialog'), withInput: true, initial: f.name, okText: t('saveButton'),
        onOk: async (name) => {
          f.name = name;
          await persist();
          render();
        }
      })
    },
    { sep: true },
    {
      icon: 'i-x',
      label: t('deleteFolderAction'),
      danger: true,
      action: async () => {
        const loc = findLoc(f.id);
        if (!loc) return;
        loc.arr.splice(loc.index, 1, ...(f.children || []));
        await persist();
        render();
      }
    }
  ];

  const btns = document.createElement('span');
  btns.className = 'btns';
  btns.appendChild(rowButton('i-dots', t('actionsTitle'), (e) => { e.stopPropagation(); showMenu(li, menuItems()); }));

  main.append(twisty, title, count);
  li.appendChild(btns);
  li.oncontextmenu = (e) => { e.preventDefault(); showMenu(li, menuItems()); };
  makeDraggable(li, f);
  return li;
}

// Short relative age for archive entries ("5h ago", "3d ago").
let rtf = null;
function ageLabel(at) {
  if (!at) return '';
  try {
    if (!rtf) rtf = new Intl.RelativeTimeFormat(chrome.i18n.getMessage('@@ui_locale') || 'en', { style: 'narrow' });
    const hours = Math.round((at - Date.now()) / 36e5);
    if (hours > -1) return '';
    return hours > -24 ? rtf.format(hours, 'hour') : rtf.format(Math.round(hours / 24), 'day');
  } catch (e) {
    return '';
  }
}

async function renderArchive() {
  const { archive } = await chrome.storage.local.get('archive');
  const arch = archive || [];
  $('#archive-count').textContent = arch.length ? String(arch.length) : '';
  $('#archive-twisty').classList.toggle('open', archiveOpen);
  $('#archive-head').setAttribute('aria-expanded', String(archiveOpen));
  $('#archive-search-wrap').style.display = archiveOpen && arch.length ? '' : 'none';
  $('#archive-clear').style.display = archiveOpen && arch.length ? '' : 'none';

  const list = $('#archive');
  list.innerHTML = '';
  if (!archiveOpen) return;

  const q = $('#archive-search').value.trim().toLowerCase();
  const filtered = q
    ? arch.filter(e => (e.title || '').toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q))
    : arch;

  if (!filtered.length && arch.length) {
    list.appendChild(emptyHint('i-search', t('noMatchesHint')));
    return;
  }

  for (const entry of filtered.slice(0, 100)) {
    const removeEntry = async () => {
      const { archive: cur } = await chrome.storage.local.get('archive');
      await chrome.storage.local.set({ archive: (cur || []).filter(x => x !== null && !(x.url === entry.url && x.at === entry.at)) });
      renderArchive();
    };
    const { li, main } = rowShell(entry.title || entry.url, async () => {
      const winId = await currentWindow();
      await chrome.tabs.create({ url: entry.url, windowId: winId });
      await removeEntry();
    });
    main.title = t('restoreFromArchiveTitle');

    const img = document.createElement('img');
    img.className = 'favicon';
    img.alt = '';
    img.src = faviconUrl(entry.url);
    img.onerror = () => { img.onerror = null; img.src = localFallbackFavicon(entry.url); };

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.title || entry.url;

    const age = document.createElement('span');
    age.className = 'age';
    age.textContent = ageLabel(entry.at);

    const btns = document.createElement('span');
    btns.className = 'btns';
    btns.appendChild(rowButton('i-x', t('removeFromArchiveTitle'), (e) => { e.stopPropagation(); removeEntry(); }));

    main.append(img, title, age);
    li.appendChild(btns);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(li, [
        { icon: 'i-pop', label: t('restoreFromArchiveTitle'), action: () => main.click() },
        { icon: 'i-x', label: t('removeFromArchiveTitle'), danger: true, action: removeEntry }
      ]);
    };
    list.appendChild(li);
  }
}

// Footer sync status chip.
async function updateSyncStatus() {
  const cfg = await getSyncConfig();
  const ready = !!cfg.token && !!cfg.encryptionKey;
  const chip = $('#sync-status');
  chip.classList.toggle('on', ready);
  $('#sync-status-label').textContent = ready
    ? (cfg.lastSyncAt
      ? t('syncedShort', new Date(cfg.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      : t('syncEnabledStatus'))
    : t('syncOffShort');
}

async function render(focusSpaceId = null) {
  const focusedTile = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest('#spaces .tile')
    : null;
  const preservedFocusSpaceId = focusSpaceId || focusedTile?.dataset.spaceId || null;
  const space = activeSpace();
  const winId = await currentWindow();
  const bindings = await getBindings();
  const tabs = await chrome.tabs.query({ windowId: winId });
  const boundTabIds = new Set(Object.values(bindings));

  // The active space color drives every accent in the panel.
  document.documentElement.style.setProperty('--sp', space.color);

  // Spaces: a tablist with roving tabindex; arrows move focus, Enter/Space activate.
  const spacesEl = $('#spaces');
  spacesEl.innerHTML = '';
  let replacementFocusTile = null;
  for (const s of meta.spaces) {
    const active = s.id === space.id;
    const tile = document.createElement('button');
    tile.className = 'tile' + (active ? ' on' : '');
    tile.setAttribute('role', 'tab');
    tile.setAttribute('aria-selected', String(active));
    tile.dataset.spaceId = s.id;
    tile.tabIndex = active ? 0 : -1;
    tile.style.setProperty('--tile-color', s.color);
    tile.style.setProperty('--tile-tint', alpha(s.color, 0.15));
    tile.style.setProperty('--tile-tint-hover', alpha(s.color, 0.3));
    const glyph = spaceGlyphEl(s.icon, 14);
    if (glyph) {
      if (glyph.tagName === 'svg') tile.appendChild(glyph);
      else { tile.classList.add('has-icon'); tile.appendChild(glyph); }
    } else {
      tile.textContent = s.name[0]?.toUpperCase() || '?';
    }
    tile.title = s.name;
    tile.setAttribute('aria-label', s.name);
    tile.onclick = async () => {
      const restoreFocus = document.activeElement === tile;
      meta.activeSpaceId = s.id;
      await saveMeta(meta);
      anchors = await loadAnchors(s.id);
      await loadNoteUI();
      await render(restoreFocus ? s.id : null);
    };
    tile.ondblclick = () => editSpace(s);
    tile.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(tile, [
        { icon: 'i-pencil', label: t('editSpaceAction'), action: () => editSpace(s) },
        { icon: 'i-trash', label: t('deleteSpaceAction'), danger: true, disabled: meta.spaces.length <= 1, action: () => removeSpace(s) }
      ]);
    };
    spacesEl.appendChild(tile);
    if (s.id === preservedFocusSpaceId) replacementFocusTile = tile;
  }
  if (replacementFocusTile) replacementFocusTile.focus();

  const glyphHost = $('#space-glyph');
  glyphHost.innerHTML = '';
  const headGlyph = spaceGlyphEl(space.icon, 15);
  if (headGlyph) glyphHost.appendChild(headGlyph);
  else {
    const dot = document.createElement('span');
    dot.className = 'glyph-dot';
    glyphHost.appendChild(dot);
  }
  $('#space-name').textContent = space.name;

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
  if (!anchors.length) list.appendChild(emptyHint('i-anchor', t('emptyAnchorsHint')));

  // Space note.
  $('#note-twisty').classList.toggle('open', noteOpen);
  $('#note-head').setAttribute('aria-expanded', String(noteOpen));
  $('#note').style.display = noteOpen ? '' : 'none';

  // Today contains regular web tabs that are not bound to anchors.
  const today = $('#today');
  today.innerHTML = '';
  let todayCount = 0;
  for (const tab of tabs) {
    if (tab.pinned || boundTabIds.has(tab.id) || !isWebUrl(tab.url)) continue;
    todayCount++;
    const { li, main } = rowShell(tab.title || tab.url, () => chrome.tabs.update(tab.id, { active: true }));
    if (tab.active) li.classList.add('active');
    main.title = tab.url;

    const img = document.createElement('img');
    img.className = 'favicon';
    img.alt = '';
    img.src = tab.favIconUrl || faviconUrl(tab.url);
    img.onerror = () => { img.onerror = null; img.src = localFallbackFavicon(tab.url); };

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || tab.url;

    const btns = document.createElement('span');
    btns.className = 'btns';
    btns.appendChild(rowButton('i-anchor', t('pinAsAnchorTitle'), (e) => { e.stopPropagation(); pinTab(tab); }));
    btns.appendChild(rowButton('i-x', t('closeTitle'), (e) => { e.stopPropagation(); chrome.tabs.remove(tab.id); }));

    main.append(img, title);
    li.appendChild(btns);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(li, [
        { icon: 'i-anchor', label: t('pinAsAnchorTitle'), action: () => pinTab(tab) },
        { icon: 'i-x', label: t('closeTitle'), danger: true, action: () => chrome.tabs.remove(tab.id) }
      ]);
    };
    today.appendChild(li);
  }
  if (!todayCount) today.appendChild(emptyHint('i-search', t('emptyTodayHint')));

  await renderArchive();
  await updateSyncStatus();

  $('#autoreset').value = String(meta.settings.autoResetHours);
  $('#suspend').value = String(meta.settings.suspendMinutes);
  $('#archive-hours').value = String(meta.settings.archiveHours);
  $('#keep-anchor-tabs-toggle').setAttribute('aria-checked', String(!!meta.settings.keepAnchorTabs));
  $('#dedup-toggle').setAttribute('aria-checked', String(!!meta.settings.dedup));
}

// ---------- actions ----------

async function openAnchor(a) {
  try {
    await tabState('open', { anchorId: a.id, windowId: await currentWindow() });
    scheduleRender();
  } catch (error) {
    toast(t('tabActionError', error.message));
  }
}

async function bindTab(a, tab) {
  await tabState('bind', { anchorId: a.id, tabId: tab.id });
}

async function goHome(a) {
  try {
    await tabState('goHome', { anchorId: a.id, windowId: await currentWindow() });
  } catch (error) {
    toast(t('tabActionError', error.message));
  }
  scheduleRender();
}

// Move an existing anchor tab to a separate window, or create a new window for it.
async function popOut(a) {
  try {
    await tabState('popOut', { anchorId: a.id });
  } catch (error) {
    toast(t('tabActionError', error.message));
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
  if (!await persist()) {
    const loc = findLoc(anchor.id);
    if (loc) loc.arr.splice(loc.index, 1);
    render();
    return;
  }
  try {
    await bindTab(anchor, tab);
  } catch (error) {
    const loc = findLoc(anchor.id);
    if (loc) loc.arr.splice(loc.index, 1);
    await persist();
    toast(t('tabActionError', error.message));
    return;
  }
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
  await tabState('reload', { anchorId: a.id }).catch(() => {});
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
    okText: t('saveButton'),
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
    title: t('deleteSpaceDialog', space.name), okText: t('deleteButton'), danger: true,
    onOk: async () => {
      const removedItems = await loadAnchors(space.id);
      const removedAnchorIds = collectAnchorIds(removedItems);
      await deleteAnchors(space.id);
      await saveNote(space.id, '');
      meta.spaces = meta.spaces.filter(s => s.id !== space.id);
      if (!meta.spaces.find(s => s.id === meta.activeSpaceId)) {
        meta.activeSpaceId = meta.spaces[0].id;
      }
      await saveMeta(meta);
      await tabState('release', { anchorIds: removedAnchorIds }).catch(() => {});
      anchors = await loadAnchors(meta.activeSpaceId);
      await loadNoteUI();
      render();
    }
  });
}

function showSpaceMenu(el) {
  const space = activeSpace();
  showMenu(el, [
    { icon: 'i-pencil', label: t('editSpaceAction'), action: () => editSpace(space) },
    { sep: true },
    { icon: 'i-trash', label: t('deleteSpaceAction'), danger: true, disabled: meta.spaces.length <= 1, action: () => removeSpace(space) }
  ]);
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
  uptodate: t('syncStatusUptodate'),
  migrated: t('syncStatusMigrated')
};

async function reloadSyncedState() {
  meta = await loadMeta();
  anchors = await loadAnchors(activeSpace().id);
  await loadNoteUI();
  render();
}

async function runPlaintextMigration() {
  try {
    const r = await migratePlaintextGist();
    if (r.pulled) await reloadSyncedState();
    toast(t(r.legacyDeleted ? 'syncStatusMigrated' : 'syncStatusMigratedLegacyRetained'));
  } catch (e) {
    toast(t('syncErrorToast', e.message));
  }
  await updateSettingsUI();
  await updateSyncStatus();
}

async function runSync() {
  try {
    const r = await syncNow();
    toast(SYNC_STATUS_TEXT[r.status] || r.status);
    if (r.status === 'pulled' || r.status === 'linked') {
      await reloadSyncedState();
    }
  } catch (e) {
    if (e.code === 'PLAINTEXT_GIST') {
      showDialog({
        title: t('migratePlaintextGistDialog'),
        okText: t('migrateButton'),
        danger: true,
        onOk: runPlaintextMigration
      });
    } else {
      toast(t('syncErrorToast', e.message));
    }
  }
  await updateSettingsUI();
  await updateSyncStatus();
}

// ---------- settings sheet ----------

async function updateSettingsUI() {
  const cfg = await getSyncConfig();
  const ready = !!cfg.token && !!cfg.encryptionKey;
  const line = $('#sync-status-line');
  line.classList.toggle('on', ready);
  $('#sync-status-text').textContent = ready
    ? (cfg.lastSyncAt
      ? t('syncEnabledLastStatus', new Date(cfg.lastSyncAt).toLocaleTimeString())
      : t('syncEnabledStatus'))
    : (cfg.token ? t('syncEncryptionKeyRequiredStatus') : t('syncDisabledStatus'));
  $('#sync-token .label').textContent = cfg.token ? t('replaceGitHubTokenAction') : t('connectGitHubAction');
  $('#sync-key .label').textContent = cfg.encryptionKey
    ? t('copyEncryptionKeyAction')
    : t('generateEncryptionKeyAction');
  $('#sync-key-import .label').textContent = t('useExistingEncryptionKeyAction');
  $('#sync-now').disabled = !ready;
  $('#sync-disable').disabled = !cfg.token;
  $('#keep-anchor-tabs-toggle').setAttribute('aria-checked', String(!!meta.settings.keepAnchorTabs));
  $('#dedup-toggle').setAttribute('aria-checked', String(!!meta.settings.dedup));
}

async function openSettings() {
  if (settingsOpening || findOverlay('settings')) return;
  settingsOpening = true;
  try {
    await updateSettingsUI();
    // updateSettingsUI() is asynchronous, so recheck before pushing the
    // descriptor even though the opening guard already serializes callers.
    if (findOverlay('settings')) return;
    const ov = openOverlay({
      name: 'settings',
      el: $('#settings'),
      trap: true,
      onClose: () => { $('#settings-overlay').classList.remove('show'); }
    });
    $('#settings-close').onclick = () => closeOverlay(ov);
    $('#settings-backdrop').onclick = () => closeOverlay(ov);
    $('#settings-overlay').classList.add('show');
    $('#settings-close').focus();
  } finally {
    settingsOpening = false;
  }
}

// ---------- initialization ----------

async function init() {
  applyI18n();
  // An unpacked extension can serve a freshly edited panel while Vivaldi keeps
  // the previously registered service worker alive. Do not migrate storage or
  // accept tab commands across that mixed-version boundary: reload the entire
  // extension first so the panel and worker agree on their storage backend.
  const runtimeState = await chrome.runtime.sendMessage({
    scope: 'anchors-tab-state',
    action: 'handshake',
    protocolVersion: RUNTIME_PROTOCOL_VERSION
  }).catch(() => null);
  if (runtimeState && runtimeState.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    toast(t('extensionReloadingToast'));
    setTimeout(() => chrome.runtime.reload(), 250);
    return;
  }
  meta = await loadMeta();
  await cleanupOrphans(meta).catch(() => {});
  await tabState('repair').catch(() => {});
  anchors = await loadAnchors(activeSpace().id);
  await loadNoteUI();

  if (chrome.runtime.getManifest) {
    $('#about-version').textContent = 'v' + chrome.runtime.getManifest().version;
  }

  $('#add-anchor').onclick = () => addCurrentTab();
  $('#add-folder').onclick = addFolder;
  $('#add-space').onclick = addSpace;
  $('#space-menu').onclick = (e) => { e.stopPropagation(); showSpaceMenu(e.currentTarget); };

  // Roving focus in the space tablist.
  $('#spaces').addEventListener('keydown', (e) => {
    const tiles = [...document.querySelectorAll('#spaces .tile')];
    const idx = tiles.indexOf(document.activeElement);
    if (idx < 0 || !tiles.length) return;
    let to = null;
    if (e.key === 'ArrowRight') to = tiles[(idx + 1) % tiles.length];
    else if (e.key === 'ArrowLeft') to = tiles[(idx - 1 + tiles.length) % tiles.length];
    else if (e.key === 'Home') to = tiles[0];
    else if (e.key === 'End') to = tiles[tiles.length - 1];
    if (to) {
      e.preventDefault();
      tiles.forEach(tl => { tl.tabIndex = -1; });
      to.tabIndex = 0;
      to.focus();
    }
  });

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

  pressable($('#note-head'), () => { noteOpen = !noteOpen; render(); });
  $('#note').oninput = onNoteInput;

  pressable($('#archive-head'), () => {
    archiveOpen = !archiveOpen;
    renderArchive();
  });
  $('#archive-search').oninput = () => renderArchive();
  $('#archive-search').onclick = (e) => e.stopPropagation();
  $('#archive-clear').onclick = (e) => {
    e.stopPropagation();
    showDialog({
      title: t('clearArchiveDialog'), okText: t('clearButton'), danger: true,
      onOk: async () => {
        await chrome.storage.local.set({ archive: [] });
        renderArchive();
      }
    });
  };

  // Settings sheet.
  $('#open-settings').onclick = openSettings;
  $('#sync-status').onclick = openSettings;
  $('#keep-anchor-tabs-toggle').onclick = async () => {
    meta.settings.keepAnchorTabs = !meta.settings.keepAnchorTabs;
    await saveMeta(meta);
    if (!meta.settings.keepAnchorTabs) await tabState('repair').catch(() => {});
    await updateSettingsUI();
    scheduleRender();
    toast(t(meta.settings.keepAnchorTabs ? 'keepAnchorTabsEnabledToast' : 'keepAnchorTabsDisabledToast'));
  };
  $('#dedup-toggle').onclick = async () => {
    meta.settings.dedup = !meta.settings.dedup;
    await saveMeta(meta);
    await updateSettingsUI();
    toast(t(meta.settings.dedup ? 'dedupEnabledToast' : 'dedupDisabledToast'));
  };
  $('#sync-token').onclick = async () => {
    const cfg = await getSyncConfig();
    showDialog({
      title: t('githubTokenDialog'), withInput: true, inputType: 'password', okText: t('saveButton'),
      onOk: async (token) => {
        await setSyncConfig({ ...cfg, token });
        if (cfg.encryptionKey) runSync();
        else {
          toast(t('syncEncryptionKeyRequiredToast'));
          await updateSettingsUI();
          await updateSyncStatus();
        }
      }
    });
  };
  $('#sync-key').onclick = async () => {
    const cfg = await getSyncConfig();
    const encryptionKey = cfg.encryptionKey || generateSyncKey();
    if (!cfg.encryptionKey) await setSyncConfig({ ...cfg, encryptionKey, lastSyncAt: 0 });
    try {
      await navigator.clipboard.writeText(encryptionKey);
      toast(t(cfg.encryptionKey ? 'encryptionKeyCopiedToast' : 'encryptionKeyGeneratedToast'));
    } catch (e) {
      showDialog({
        title: t('copyEncryptionKeyDialog'), withInput: true, initial: encryptionKey,
        okText: t('doneButton'), onOk: () => {}
      });
    }
    await updateSettingsUI();
    await updateSyncStatus();
  };
  $('#sync-key-import').onclick = async () => {
    const cfg = await getSyncConfig();
    showDialog({
      title: t('encryptionKeyDialog'), withInput: true, inputType: 'password', okText: t('saveButton'),
      onOk: async (value) => {
        try {
          const encryptionKey = normalizeSyncKey(value);
          await setSyncConfig({ ...cfg, encryptionKey, lastSyncAt: 0 });
          toast(t('encryptionKeySavedToast'));
          await updateSettingsUI();
          await updateSyncStatus();
        } catch (e) {
          toast(t('syncErrorToast', e.message));
        }
      }
    });
  };
  $('#sync-now').onclick = () => runSync();
  $('#sync-disable').onclick = async () => {
    const cfg = await getSyncConfig();
    await setSyncConfig({ ...cfg, token: '', lastSyncAt: 0 });
    toast(t('syncDisabledToast'));
    await updateSettingsUI();
    await updateSyncStatus();
  };
  $('#import-btn').onclick = () => $('#import-file').click();
  $('#export-btn').onclick = exportToFile;
  $('#import-file').onchange = (e) => {
    if (e.target.files && e.target.files[0]) handleImportFile(e.target.files[0]);
    e.target.value = '';
  };

  chrome.tabs.onCreated.addListener(scheduleRender);
  chrome.tabs.onActivated.addListener(scheduleRender);
  chrome.tabs.onRemoved.addListener(scheduleRender);
  chrome.tabs.onAttached.addListener(scheduleRender);
  chrome.tabs.onDetached.addListener(scheduleRender);
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (info.status === 'complete' || info.title || info.favIconUrl || info.discarded !== undefined) scheduleRender();
  });
  chrome.windows.onFocusChanged.addListener(scheduleRender);
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'session') {
      if (changes.bindings || changes.lastActive) scheduleRender();
      return;
    }
    if (area === 'local') {
      if (changes.archive) renderArchive();
      if (changes.syncConfig) {
        // Background sync updates lastSyncAt; keep the visible status current.
        updateSyncStatus();
        if (findOverlay('settings')) updateSettingsUI();
      }
      if (importing || !Object.keys(changes).some(isPersistentKey)) return;
      meta = await loadMeta();
      anchors = await loadAnchors(activeSpace().id);
      scheduleRender();
      return;
    }
    if (area === 'sync') purgeLegacyBrowserSync().catch(() => {});
  });

  render();

  // Pull any changes made on another device when the panel opens.
  const cfg = await getSyncConfig();
  if (cfg.token && cfg.encryptionKey) {
    syncNow().then(r => {
      if (r.status === 'pulled' || r.status === 'linked') {
        toast(SYNC_STATUS_TEXT[r.status]);
      }
      updateSyncStatus();
    }).catch(() => {});
  }
}

init();
