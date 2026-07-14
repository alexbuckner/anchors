# Changelog

All notable changes to Anchors will be documented in this file.

## [0.6.3] — 2026-07-14

Initial public release.

### Features

- Arc-style anchor tabs that return to a saved home URL.
- Spaces with colors, emojis, notes, and one-level folders.
- A Today section for unbound tabs in the current window.
- Automatic reset, tab suspension, and a local automatic archive.
- Duplicate protection, pop-out windows, and per-site data cleanup.
- Import of pinned items from Arc `StorableSidebar.json`.
- Import and export of the Anchors JSON format.
- Browser sync and optional GitHub Gist synchronization.
- Browser Side Panel support and a Vivaldi Web Panel workflow.
- Chrome i18n with English as the default bundled locale.

### Known limitations

- Live `tabId` bindings reset after a browser restart.
- Gist sync uses last-write-wins and does not merge conflicts.
- The automatic archive and GitHub token remain local.
- `Ctrl+Shift+H` may not work in Vivaldi.
