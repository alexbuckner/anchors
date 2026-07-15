(() => {
  const messages = window.__ANCHORS_MESSAGES__ || {};
  const event = () => ({ addListener() {} });
  const clone = value => value === undefined ? undefined : structuredClone(value);

  const meta = {
    version: 1,
    spaces: [
      { id: 'personal', name: 'Personal', color: '#7c9cff', icon: 'icon:home' },
      { id: 'work', name: 'Work', color: '#ff8a7c', icon: 'icon:work' },
      { id: 'travel', name: 'Travel', color: '#7cd992', icon: 'icon:travel' }
    ],
    activeSpaceId: 'work',
    settings: {
      autoResetHours: 6,
      suspendMinutes: 30,
      archiveHours: 24,
      keepAnchorTabs: false,
      dedup: true
    }
  };
  const workAnchors = [
    {
      id: 'product', type: 'folder', name: 'Product', collapsed: false,
      children: [
        { id: 'github', url: 'https://github.com/openai', title: 'GitHub' },
        { id: 'linear', url: 'https://linear.app', title: 'Linear' }
      ]
    },
    { id: 'chatgpt', url: 'https://chatgpt.com', title: 'ChatGPT' }
  ];
  const tabs = [
    { id: 1, windowId: 1, index: 0, url: 'https://github.com/openai/codex', title: 'openai/codex', active: true, pinned: false, audible: false, discarded: false },
    { id: 2, windowId: 1, index: 1, url: 'https://chatgpt.com', title: 'ChatGPT', active: false, pinned: false, audible: false, discarded: true },
    { id: 3, windowId: 1, index: 2, url: 'https://developer.chrome.com/docs/extensions/', title: 'Chrome Extensions', active: false, pinned: false, audible: false, discarded: false }
  ];

  const stores = {
    sync: {
      meta,
      updatedAt: Date.now(),
      'anchors_work__0': workAnchors,
      'anchors_personal__0': [],
      'anchors_travel__0': [],
      note_work: 'Ship the next focused release.'
    },
    local: { archive: [], syncConfig: { token: '', gistId: '', lastSyncAt: 0 } },
    session: { bindings: { github: 1, chatgpt: 2 }, lastActive: { github: Date.now(), chatgpt: Date.now() } }
  };

  function area(store) {
    return {
      async get(query) {
        if (query === null || query === undefined) return clone(store);
        if (typeof query === 'string') return { [query]: clone(store[query]) };
        if (Array.isArray(query)) return Object.fromEntries(query.map(key => [key, clone(store[key])]));
        const result = {};
        for (const [key, fallback] of Object.entries(query)) result[key] = key in store ? clone(store[key]) : fallback;
        return result;
      },
      async set(values) { Object.assign(store, clone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }
    };
  }

  function translate(key, substitutions) {
    if (key === '@@ui_locale') return 'en';
    const entry = messages[key];
    if (!entry) return '';
    let text = entry.message;
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    for (const [name, placeholder] of Object.entries(entry.placeholders || {})) {
      const index = Number(placeholder.content.replace('$', '')) - 1;
      text = text.replaceAll(`$${name.toUpperCase()}$`, values[index] ?? '');
    }
    return text;
  }

  window.chrome = {
    i18n: { getMessage: translate },
    runtime: {
      getManifest: () => ({ version: '0.7.1' }),
      getURL: path => new URL(path.replace(/^\//, ''), window.parent.location.origin + '/').href,
      sendMessage: async () => ({ ok: true, bindingCount: 2 })
    },
    storage: {
      sync: area(stores.sync),
      local: area(stores.local),
      session: area(stores.session),
      onChanged: event()
    },
    tabs: {
      query: async query => clone(tabs.filter(tab => query?.windowId === undefined || tab.windowId === query.windowId)),
      get: async id => clone(tabs.find(tab => tab.id === id)),
      update: async () => {},
      create: async () => {},
      remove: async () => {},
      reload: async () => {},
      onCreated: event(),
      onActivated: event(),
      onRemoved: event(),
      onAttached: event(),
      onDetached: event(),
      onUpdated: event()
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: event(),
      getCurrent: async () => ({ id: 1, type: 'normal' }),
      getLastFocused: async () => ({ id: 1, type: 'normal' }),
      update: async () => {},
      create: async () => {},
      remove: async () => {}
    },
    browsingData: { remove: async () => {} },
    cookies: { getAll: async () => [], remove: async () => {} }
  };
})();
