# Changelog

All notable changes to Anchors will be documented in this file.

## [0.8.0] — 2026-07-19

### Changed

- End-to-end encrypted GitHub Gist snapshots with AES-256-GCM and a local
  recovery key that can be copied to another device.
- Added explicit, fail-closed migration from legacy plaintext Gists: Anchors
  creates and activates an encrypted replacement before deleting the old Gist.
- Refused to overwrite invalid, unsupported, or differently encrypted remote
  data.
- Moved spaces, anchors, settings, and notes from `chrome.storage.sync` to
  `chrome.storage.local`, making the encrypted Gist the only cross-device
  channel.
- Added a local-first upgrade migration that preserves the newer snapshot and
  removes legacy plaintext browser-sync keys after the local copy is safe.

## [0.7.1] — 2026-07-15

### Changed

- Reuse one live anchor tab per browser window by default, preventing the
  native tab strip from growing with every opened anchor.
- Added **Keep anchor tabs open** for users who prefer a separate tab and
  preserved browsing state for every anchor.
- Unified the extension icon and in-product branding with the anchor glyph
  used by **Pin current tab**.
- Serialized runtime tab operations in the background service worker so rapid
  anchor switches cannot race with tab events or scheduled maintenance.

### Fixed

- Cleared runtime bindings and activity when an anchor is unpinned, its space
  is deleted, or its browser tab is closed.
- Repaired stale bindings left by earlier releases and returned their live tabs
  to Today with a fresh auto-archive timer.
- Kept side-panel actions attached to the browser window that owns the panel.
- Kept the background worker available in Vivaldi when it exposes only a
  partial `sidePanel` API.

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
