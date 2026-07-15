# Anchors — visual specification (v0.7.0)

This document is the source of truth for the implemented panel design. The
v0.7.0 source and bundled assets follow these tokens, component rules, states,
and responsive constraints.

## 1. Design tokens

Surfaces (neutral, warm-free):

| Token | Value | Use |
|---|---|---|
| `--bg0` | `#17181b` | panel base |
| `--bg1` | `#1d1e22` | inset surfaces: note, inputs |
| `--bg2` | `#24262b` | hover fill |
| `--bg3` | `#2c2e34` | pressed fill, controls (selects, buttons) |
| `--surface` | `#232428` | floating: menus, settings group cards |
| sheet base | `#1f2024` | settings sheet |
| dialog base | `#212226` | centered dialogs |
| `--line` | `rgba(255,255,255,.07)` | hairline separators |
| `--line2` | `rgba(255,255,255,.12)` | toast border |
| group border | `rgba(255,255,255,.06)` | settings cards |

Text (AA on every surface they appear on):

| Token | Value | Contrast on bg0 | Use |
|---|---|---|---|
| `--text` | `#e9eaec` | ≈13.9:1 | primary |
| `--text2` | `#b0b2b9` | ≈7.5:1 | secondary: Today/archive titles, icons |
| `--text3` | `#8e919a` | ≈4.7:1 | section labels, timestamps, hints |
| `--text-disabled` | `#686b73` | — | disabled controls only (sub-AA by intent) |

Accent and status:

- `--sp` = active space color, set from JS; drives: active pill, away dot,
  selection tints (`color-mix` 10% / 15%), focus rings
  (`color-mix(var(--sp) 75%, #fff)`), switch-on fill, dialog OK button.
- Space palette (PALETTE in shared.js, unchanged): `#7c9cff` blue ·
  `#ff8a7c` coral · `#7cd992` green · `#e8c46b` yellow · `#c78af0` purple ·
  `#6bd0e8` cyan · `#f08ab8` pink.
- `--ok #63d489` (sync-on dot) · `--danger #f09891` (destructive text) ·
  `--danger-strong #e5675e` (destructive fills) · danger tint
  `rgba(229,103,94,.12)`.

## 2. Typography

Stack: `"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system,
sans-serif`. No remote fonts. The note textarea uses the same stack (not
monospace).

| Style | Size/weight | Use |
|---|---|---|
| Row title | 13 px / 400 | anchors, Today, archive, buttons |
| Space name / sheet & dialog titles | 13 px / 600 | headers |
| Folder title | 12.5 px / 600 | folder rows |
| Settings labels, menu items | 12.5 px / 400 | |
| Note text, search, toasts, empty hints | 12 px / 400 | |
| Footer chip | 11 px / 400 | sync status |
| Hints under labels | 11 px / 400, `--text3` | Data rows |
| Section/group labels | 10.5 px / 600, uppercase, +0.7 px tracking | NOTE, TODAY, ARCHIVE, TABS… |
| Counts, ages | 10.5 px / 400, tabular-nums | |

## 3. Geometry

- Radii: 6 px (rows, small controls) · 8 px (tiles, note, inputs, toast) ·
  10 px (menus, group cards) · 12 px (dialog) · 14 px top corners (sheet).
- Row height 32 px; row gap 1 px; favicon 16 px, radius 4 px.
- Space tile 26 px, radius 8; icon buttons 26 px (footer gear 28 px);
  row hover buttons 24 px.
- Header: 10 px padding, 6 px gap between rail and title row.
- Main padding 8 px; sections separated by 14 px.
- Folder children: 15 px left margin + 1 px guide line + 14 px padding.
- Active pill 3×14 px, radius 2, at row left edge.
- Footer 38 px tall, hairline top border.
- Focus ring: 2 px, inset (offset −2), color `color-mix(--sp 75%, #fff)`.
- Motion: 120 ms (hover/press) · 160 ms (switch, borders) · 140–180 ms
  (menu/sheet enter). All disabled under `prefers-reduced-motion`.

## 4. Icon system

Grid and strokes: 16 px viewBox, ~13.6 px live area, `stroke: currentColor`,
width 1.5 (1.6 for plus/chevron/close), round caps and joins, `fill="none"`
except deliberate solid dots/bars ≤ 2 px. Optical sizes in UI: 15 px (header,
settings rows), 14 px (menus, row buttons), 13 px (search, small buttons),
12 px (twisty, sleep crescent), 10 px (section twisty).

Semantic mapping (interface `i-*`):

| Icon | Action / meaning |
|---|---|
| `i-plus` | new space |
| `i-chev` | expand/collapse (rotates 0→90°), select caret (rotated) |
| `i-dots` | actions menu (rows, space options) |
| `i-home` | go to home page; Auto-reset setting |
| `i-anchor` | pin tab (header/Today/menus) |
| `i-x` | close tab, unpin, remove, close sheet, disable sync |
| `i-search` | archive search; empty Today/no-matches hint |
| `i-trash` | clear archive, delete space |
| `i-moon` | sleeping state; Sleep setting |
| `i-pop` | move to separate window; restore from archive |
| `i-cookie` | clear cookies and site data |
| `i-pencil` | rename / edit space |
| `i-folder` | new folder |
| **`i-gear`** | Settings — **adjustment sliders** (3 rails y = 3.6/8/12.4, knobs r 1.7 at x = 10.2/5.8/9, gap 1.7 around knobs). Replaces the sun-like cog. See `icons/settings.svg`. |
| `i-sync` | sync now |
| `i-down` / `i-up` | import / export |
| `i-key` | GitHub token |
| `i-check` | confirmation, duplicate protection, selected color |
| `i-box` | auto-archive |
| `i-slash` | "no icon" choice in the space editor |

Space icons (`s-*`, tokens `icon:<name>`): home, work, code, study, travel,
finance, shopping, media, music, gaming, ideas, projects, heart, lab — sheet
in `icons/space-icons.svg`. Rendered at 14 px in tiles/picker, 15 px in the
space header. Storage: `space.icon` = `icon:*` token | legacy emoji | `''`
(falls back to the space's first letter). Legacy emoji keep rendering but are
not shown in marketing screenshots.

## 5. Brand mark

Concept: a browser tab moored to a cradle (tab card + stem + open arc).

- `icons/anchors.svg` — master, 128 grid: badge `#17181b` r 28 with 2 px
  `rgba(255,255,255,.09)` ring; glyph `#7c9cff`, stroke 10, round: tab
  36,24 56×40 r 11 · stem 64,64→102 · arc c(64,82) r 26.
- `icons/anchors-16.svg` — 16 px optical size: badge-free,
  stroke 2, tab 2.8,1.8 10.4×5.6 r 2 + arc c(8,10.2) r 5 — the stem drops
  out at this size so the mark keeps internal air and cannot read as a
  microphone/USB plug.
- `icons/anchors-mono.svg` — currentColor variant.
- PNG set: icon16 (optical geometry) · icon32/48/128 (master geometry) —
  registered in the manifest (`icons`, `action.default_icon`).
- In-product use: the sheet's brand/version footer row (15 px, `--text3`).

## 6. Component anatomy

**Space rail tile**: 26 px; resting = 15% tint of space color, glyph in space
color; hover 30% tint; active = solid space color, glyph `#15161a`, 1 px
`rgba(255,255,255,.16)` ring (no glow); press scale .94. Add-space: 1 px
dashed `rgba(255,255,255,.24)` box, `--text3` → hover `--text`/`.4`.

**Anchor row**: [pill 3×14 when active] favicon 16 · title (ellipsis) ·
away dot 6 px `--sp` · sleep crescent 12 px `--text3` · hover buttons
(home, dots). Active row = 10% `--sp` tint (15% on hover). Sleeping: favicon
45% opacity, title `--text3`. Away/sleeping are appended to the accessible
name. Folder row: chevron 12 · 12.5/600 title · tabular count.

**Note**: `--bg1` inset card, 1 px `--line`, r 8, padding 8×10, min-height
76 px, focus border `--sp`. Collapsible via NOTE header.

**Footer**: sync chip (6 px dot: `#55585f` off / `--ok` on + 11 px label,
truncates) ··· sliders icon button 28 px. Both open Settings.

**Settings sheet**: bottom sheet, `#1f2024`, top radius 14, max-height
`min(84%, 560px)`, backdrop `rgba(0,0,0,.44)`; enter 180 ms rise. Head:
13/600 title + close. Body scrolls vertically only (8 px thumb, inset).
Groups: `--surface` cards, r 10, rows ≥ 40 px, hairline row separators.
Rows: icon 15 (`--text2`) · label 12.5 (flex, truncates) · control
(`flex:none`). Selects: `--bg3`, r 6, 4/9 px padding + caret. Switch:
36×20, knob 16, on = `--sp`. Data rows: hint sits under the
label in a column, both truncate independently. Sheet ends with the
brand/version row.

**Space editor dialog**: width `min(280px, 100% − 32px)`,
r 12, padding 14, 12 px vertical rhythm: title 13/600 → name input (32 px,
`--bg0`, r 8, focus `--sp`) → **ICON group label** (10.5/600 uppercase
`--text3`, 6 px gap to grid) → icon grid (26 px cells, gap 6; `i-slash` =
none; selected = space-color fill, glyph `#15161a`, 1.5 px white ring;
`aria-pressed`) → **COLOR group label** → color dots (20 px, 55% resting
opacity; selected = full + 2 px dark gap ring + check) → Cancel / OK
(OK = `--sp` fill, dark text; danger = `--danger-strong`, white text).

**Context menu**: `--surface`, r 10, 4 px padding, min-width 200, max-width
`calc(100vw − 16px)`, shadow `0 12px 32px rgba(0,0,0,.55)`; items 12.5 px
with 14 px icon at 80% opacity; danger red + red tint hover; disabled
`--text-disabled`. Clamps to viewport (8 px margins), flips up when needed.

**Toast**: fixed, centered, bottom 50 px, `--bg3` + `--line2`, r 8, 12 px.

## 7. States

| State | Treatment |
|---|---|
| hover | fill `--bg2` (rows/buttons) or +15% tile tint |
| pressed | fill `--bg3`; tiles scale .94 |
| focus | 2 px inset ring, space color ⊕ 75% white |
| active anchor | 10% `--sp` tint + 3×14 pill |
| away | 6 px `--sp` dot after title (never hover-only) |
| sleeping | crescent + 45% favicon + `--text3` title |
| drag source | 35% opacity |
| drop reorder | inset 2 px top line `--sp` |
| drop into folder | 15% tint + 1 px `--sp` inset outline |
| disabled | `--text-disabled`, no hover fill |
| destructive | `--danger` text; hover `rgba(229,103,94,.12)` |

## 8. Responsive: 280 vs 360 px (heights ≥ 480 px)

Identical structure at both widths — nothing hides, moves, or collapses;
only text truncation absorbs the difference (panel-narrow.png vs
panel-overview.png):

- every flex row sets `min-width: 0` and ellipsizes its label;
- `html, body { overflow: hidden }` + `main { overflow-x: hidden }` — a
  horizontal scrollbar is structurally impossible;
- vertical scrollbar: 8 px, transparent track, inset thumb — does not
  dominate at 280;
- header: rail scrolls horizontally under a hidden scrollbar; the three
  header actions are fixed-size and never wrap;
- settings selects/switch never shrink (`flex:none`); labels truncate; Data
  hints truncate under their labels;
- menus ≤ `100vw − 16px`; dialogs ≤ `100% − 32px`; sheet unchanged;
- footer chip truncates ("Synced · 09:41" → "Sync…") before controls touch.

## 9. Screenshot inventory (this folder)

All from the same demo dataset (Work space, coral `#ff8a7c` accent, GitHub
active + away, ChatGPT sleeping, 4-entry archive):

- `panel-overview.png` 360×900 — spaces, folder, states, note, Today
- `panel-archive.png` 360×900 — archive open: search, ages, count
- `panel-settings.png` 360×720 — full sheet: Tabs / Sync / Data + brand row
- `panel-narrow.png` 280×720 — same overview at minimum width
- `panel-space-editor.png` 360×720 — editor with Icon/Color labels

Implemented in v0.7.0:
1. `#i-gear` uses the sliders geometry from `icons/settings.svg`;
2. the space editor exposes visible ICON and COLOR group labels;
3. `icons/icon16.png` uses the optical geometry from `icons/anchors-16.svg`,
   while 32/48/128 use the master geometry;
4. demo and marketing data use `icon:*` tokens rather than emoji.
