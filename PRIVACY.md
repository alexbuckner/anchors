# Anchors privacy

Anchors has no first-party server, analytics, advertising, or content scripts.
It does not read the contents of open web pages. The extension works with tab
metadata required to manage anchors: URLs, titles, favicons, and tab IDs.

## Local storage

Anchors uses three Chrome Storage areas:

- `chrome.storage.sync` stores spaces, anchors, folders, settings, and notes.
  The browser may synchronize this data when the user enables browser sync.
- `chrome.storage.local` stores the local archive and GitHub Gist configuration,
  including the token.
- `chrome.storage.session` stores temporary anchor-to-tab bindings, activity
  times, and tab age. This state is removed when the browser session ends.

## GitHub Gist

Gist sync is off by default and starts only after the user enters a token. When
enabled, Anchors sends spaces, anchor URLs and titles, folders, notes, and
settings to `api.github.com`. GitHub stores this data in a secret Gist named
`anchors-sync.json`. The data is not end-to-end encrypted.

The GitHub token:

- is stored as `syncConfig.token` only in `chrome.storage.local`;
- is never written to `chrome.storage.sync`;
- is never included in the Gist or an Anchors export;
- is not encrypted by Anchors.

Use a dedicated token with the minimum **Gists: Read and write** permission.
Revoke it in GitHub after disabling sync if it is no longer needed.

## External requests

- When Gist sync is enabled, Anchors connects to `api.github.com`.
- Favicons are loaded through Chromium's internal API. If no icon is available,
  Anchors generates a local monogram without sending the website hostname to a
  third-party favicon service.

The extension code uses no other external services.

## Clearing site data

The **Clear cookies and site data** command runs only after an explicit action
in an anchor menu. It removes cookies and storage for the selected origin,
including Local Storage, IndexedDB, Cache Storage, and Service Workers. It does
not remove browsing history, bookmarks, downloads, or saved passwords.

The `browsingData`, `cookies`, and `<all_urls>` permissions are required because
an anchor may point to a website on any domain. Anchors never clears site data
automatically.

## Deleting data

- Spaces and notes can be deleted from the extension UI.
- Unpinning an anchor or deleting its space removes the saved anchor data but
  leaves any open page as a regular Today tab; Anchors does not silently close
  a potentially important page.
- The entire local archive can be cleared from the Archive section.
- `⚙` → **Disable sync and forget the token** removes the local token. The Gist
  remains in the GitHub account until it is deleted through GitHub.
- Uninstalling the extension removes its local browser data. Copies already
  stored by browser sync or GitHub are managed through those services.

## Manifest V3 permissions

| Permission | Use |
| --- | --- |
| `tabs` | Display and manage tabs and bind them to anchors. |
| `storage` | Store synchronized, local, and session state. |
| `alarms` | Run periodic tab maintenance and Gist sync. |
| `favicon` | Load favicons through Chromium. |
| `sidePanel` | Display the side-panel interface. |
| `browsingData`, `cookies`, `<all_urls>` | Clear data for a selected site after an explicit user action. |

Privacy questions can be submitted through the repository's Issues page.
