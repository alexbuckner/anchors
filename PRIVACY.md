# Anchors privacy

Anchors has no first-party server, analytics, advertising, or content scripts.
It does not read the contents of open web pages. The extension works with tab
metadata required to manage anchors: URLs, titles, favicons, and tab IDs.

## Local storage

Anchors uses three Chrome Storage areas:

- `chrome.storage.local` stores Favorites, spaces, anchors, folders, settings,
  notes, the archive, and GitHub Gist configuration, including the token and sync
  encryption key.
- `chrome.storage.sync` stores no active Anchors data. Releases before encrypted
  Gist sync used this area. During upgrade, Anchors first copies a newer legacy
  snapshot to local storage and then removes its plaintext browser-sync keys.
- `chrome.storage.session` stores per-window active Spaces, temporary
  anchor-to-tab bindings, Today-to-Space assignments, activity times, and tab
  age. This state is removed when the browser session ends.
- Chromium's `sessions` API stores only a Space ID on an open Today tab so its
  local assignment can be recovered after session restore. It is not sent to
  Gist or another device.

If another device running an older release writes legacy Anchors keys back to
browser sync, the current release removes those keys without treating them as a
new synchronization source. GitHub Gist is the only supported cross-device
channel.

## GitHub Gist

Gist sync is off by default and requires both a GitHub token and a sync
encryption key. Before leaving the device, Favorites, spaces, anchor URLs and
titles, folders, notes, settings, and update metadata are serialized and encrypted with
AES-256-GCM. GitHub stores only the ciphertext envelope in a secret Gist named
`anchors-sync.enc.json`.

Anchors generates a fresh random 96-bit AES-GCM nonce for every write. The
envelope also contains the format version, algorithm name, and a short key
identifier. These fields do not contain sidebar data. Authenticated decryption
must succeed before remote data is applied or replaced.

The GitHub token:

- is stored as `syncConfig.token` only in `chrome.storage.local`;
- is never written to `chrome.storage.sync`;
- is never included in the Gist or an Anchors export;
- is not encrypted by Anchors.

The sync encryption key:

- is generated from 256 bits of cryptographically secure randomness or entered
  by the user on an additional device;
- is stored as `syncConfig.encryptionKey` only in `chrome.storage.local`;
- is never sent to GitHub or written to `chrome.storage.sync`;
- is never included in a Gist or Anchors export;
- is not additionally encrypted by Anchors on the local device.

Anyone who gains access to the local browser profile while the extension is
configured may be able to obtain the token and encryption key. Store a backup
of the key in a password manager. Anchors and GitHub cannot recover encrypted
sync data without it.

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
- `⚙` → **Disable sync and forget the token** removes the local token. The local
  encryption key remains so sync can be reconnected later, and the Gist remains
  in GitHub until it is deleted there.
- Uninstalling the extension removes its local browser data. The encrypted Gist
  remains in GitHub until it is deleted there.

## Manifest V3 permissions

| Permission | Use |
| --- | --- |
| `tabs` | Display and manage tabs and bind them to anchors. |
| `storage` | Store synchronized, local, and session state. |
| `sessions` | Restore the local Space assignment of an open Today tab. |
| `alarms` | Run periodic tab maintenance and Gist sync. |
| `favicon` | Load favicons through Chromium. |
| `sidePanel` | Display the side-panel interface. |
| `browsingData`, `cookies`, `<all_urls>` | Clear data for a selected site after an explicit user action. |

Privacy questions can be submitted through the repository's Issues page.
