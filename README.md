# Anchors — Arc-style tabs for Chromium

Anchors brings the pinned-tab and space workflow from Arc to Chrome, Edge,
Brave, and Vivaldi. It is a lightweight Manifest V3 extension with a compact
side panel: every anchor tab has a saved home URL, while regular tabs stay in a
separate Today section.

Current version: **0.6.3**.

![Anchors main panel](docs/screenshots/panel-overview.png)

| Tab archive | Settings and sync |
| --- | --- |
| ![Anchors archive](docs/screenshots/panel-archive.png) | ![Anchors settings menu](docs/screenshots/panel-settings.png) |

_The screenshots use fictional demo data._

## Features

- **Anchor tabs.** Click an anchor to open or focus its tab. Click the active
  anchor again to return it to the saved home URL.
- **Spaces.** Every space has a name, color, emoji, anchor collection, and note.
- **Folders and ordering.** Group anchors into one-level folders and reorder
  items with drag and drop.
- **Today.** Open, close, or pin regular web tabs from the current window.
- **Auto-reset.** Return an inactive anchor to its home URL after a configurable
  interval.
- **Sleep.** Discard inactive anchor tabs with Chromium's `tabs.discard` API.
- **Duplicate protection.** Focus an existing anchor instead of keeping a new
  tab that opened the same home URL.
- **Automatic archive.** Close old unbound tabs and keep them in a searchable,
  restorable local archive.
- **Anchor actions.** Rename, move to a separate window, replace the home URL
  with the current page, or clear site data for that origin.
- **Import and export.** Import Arc `StorableSidebar.json` files or Anchors JSON
  exports.
- **Sync.** Sync spaces, anchors, settings, and notes through browser sync and
  an optional GitHub Gist.

## Installation

### Chrome, Edge, and Brave

1. Download the source from GitHub Releases or clone the repository.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode.
4. Select **Load unpacked** and choose the project directory.
5. Click the Anchors toolbar action to open the browser Side Panel.

### Vivaldi

1. Open `vivaldi://extensions`, enable Developer mode, and load the project
   directory as an unpacked extension.
2. Copy the extension ID from its card.
3. Add a Vivaldi Web Panel with this address:

   ```text
   chrome-extension://<ID>/panel.html
   ```

`Ctrl+Shift+H` may not work in Vivaldi because its extension-command support is
limited. The `⌂` button and a second click on the active anchor always provide
the same Go Home action.

## Importing from Arc

1. Locate Arc's `StorableSidebar.json` profile file.
2. In Anchors, select `⚙` → **Import** and choose the file.
3. Imported spaces are appended to the existing Anchors data.

Anchors imports non-empty spaces and their pinned items. Nested folders are
flattened to one level. Arc browsing history and unpinned tabs are not imported.

An Anchors export contains spaces, anchors, folders, and notes. It does not
contain the local archive or GitHub token.

## GitHub Gist sync

Browser sync depends on the sync settings of the browser itself. An additional
Gist channel is useful for Vivaldi or for syncing across different Chromium
browsers:

1. Create a GitHub Personal Access Token with the minimum Gist access: a
   fine-grained token with **Gists: Read and write**, or a classic token with
   only the `gist` scope.
2. Open `⚙` → **Connect GitHub** and enter the token.
3. Anchors creates a secret Gist containing `anchors-sync.json`, or discovers an
   existing Gist with that filename.

Anchors schedules a push about 30 seconds after a local edit and checks for
remote updates about every 5 minutes. Sync uses last-write-wins without merging:
simultaneous edits on two devices can cause the later complete snapshot to
replace the earlier one.

The GitHub token is stored only in `chrome.storage.local`. It is never written
to browser sync, the Gist, or an Anchors export, and it is not encrypted by the
extension. Gist data is not end-to-end encrypted either. Use a minimum-scope
token and revoke it in GitHub when it is no longer needed.

See the [official GitHub Gists API documentation](https://docs.github.com/en/rest/gists/gists).

## Permissions

| Permission | Why Anchors needs it |
| --- | --- |
| `tabs` | Read tab URL, title, and favicon; create, focus, close, and discard tabs. |
| `storage` | Store spaces, anchors, settings, notes, the archive, and runtime bindings. |
| `alarms` | Run auto-reset, suspension, archiving, and background Gist sync. |
| `favicon` | Load site icons through Chromium's internal favicon API. |
| `sidePanel` | Display Anchors in the browser Side Panel. |
| `browsingData` | Clear storage for one selected site after an explicit user action. |
| `cookies` | Find and remove domain cookies for that same explicit action. |
| `<all_urls>` | Work with tabs and cookies on any site the user chooses to save as an anchor. |

Site-data cleanup runs only from the menu of a specific anchor. Anchors does not
delete browsing history or passwords and does not inject content scripts into
web pages. See [PRIVACY.md](PRIVACY.md) and Chromium's documentation for
[`browsingData`](https://developer.chrome.com/docs/extensions/reference/api/browsingData),
[`cookies`](https://developer.chrome.com/docs/extensions/reference/api/cookies),
and [`sidePanel`](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

## Data storage

- `chrome.storage.sync`: space metadata, settings, anchors, folders, notes, and
  the last-update marker. Large anchor lists are split into chunks.
- `chrome.storage.local`: the archive and Gist configuration, including the
  token.
- `chrome.storage.session`: current tab IDs, anchor activity times, and the age
  of regular tabs. This state resets when the browser session ends.

The archive is local, does not sync between devices, and keeps up to 500 items.
Browser sync remains subject to `chrome.storage.sync` quotas.

## Localization

The extension uses Chrome i18n. English is the default and currently bundled
locale. Chromium automatically selects a matching browser locale when a
translation exists under `_locales`, and falls back to English otherwise.

## Project structure

- `panel.html`, `panel.css`, `panel.js` — side-panel UI;
- `background.js` — service worker and tab maintenance;
- `shared.js` — persistence and anchor bindings;
- `sync.js` — GitHub Gist synchronization;
- `_locales/` — Chrome i18n messages;
- `manifest.json` — Manifest V3 configuration.

There is no build step or runtime dependency. After editing the source, reload
the unpacked extension from the browser's extension-management page.

## Known limitations

- Anchors targets Chromium-based browsers.
- Live tab bindings do not survive a browser restart; the next anchor click
  opens a new tab.
- The automatic-archive age counter starts again after a browser restart.
- Gist sync does not merge concurrent changes.
- Folders support one level of nesting.

## License

[MIT](LICENSE)
