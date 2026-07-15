# Changelog

All notable changes to Anchors will be documented in this file.

## [0.7.0] — 2026-07-15

### Changed

- Redesigned the side panel with a compact Windows-native visual system,
  unified SVG controls, clearer anchor states, and responsive layouts down to
  280 pixels.
- Added 14 custom space icons while preserving existing emoji icons.
- Moved tab, sync, and data controls into an accessible Settings sheet.
- Added Anchors extension icons at 16, 32, 48, and 128 pixels.
- Improved keyboard navigation, focus handling, contrast, reduced-motion
  behavior, archive search, empty states, and sync-status feedback.
- Replaced the remote favicon fallback with a locally generated monogram.

### Fixed

- Prevented drag and drop from creating unsupported nested folders.
- Preserved keyboard focus after switching spaces.
- Prevented duplicate Settings overlays during rapid activation.

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
