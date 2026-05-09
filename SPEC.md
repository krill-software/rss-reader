# RSS Reader — Spec (v1)

A minimal RSS / Atom reader for Linux. Open an `.opml` file, see your feeds and the items in them, read articles. Three columns, no accounts, no cloud, no daemon. Beautiful and quiet.

## Goals

- One `.opml` file = one window. Open / Save / Save As act on the OPML — same file model as the markdown editor uses for `.md`.
- Three columns, **always visible**: feed list, item list, item body. No tab navigation, no master-detail back buttons.
- Fetch on launch and on demand. No background daemon, no auto-poll on a timer.
- Read-state lives in a sidecar JSON in `$XDG_STATE_HOME/krill-rss-reader/`, keyed by feed-URL hash. The OPML stays standard and tiny — interoperable with NetNewsWire, miniflux, Feedly.

## Non-goals (v1)

- No accounts, no cloud sync, no Fever / Greader / Inoreader bridges.
- No background fetching while the window is closed. The app is not a daemon.
- No podcasts (audio/video enclosure playback). Treat enclosures as plain links.
- No filtering rules, smart folders, "read later" integrations.
- No JS execution in article bodies — articles render as sanitized HTML.
- No image proxying or tracker-stripping (privacy work deferred to v2; v1 just renders what the feed sent).
- No nested OPML folders. v1 flattens the subscription tree to a single list. Folders are v2.
- No multi-window. One OPML per window.

## Stack additions

Base stack lives in [STYLE.md](https://github.com/krill-software/.github/blob/main/STYLE.md); chrome + palette come from [`@krill-software/desktop-ui`](https://github.com/krill-software/desktop-ui) via `mountChrome()`. RSS-specific Rust crates:

- [`feed-rs`](https://crates.io/crates/feed-rs) — RSS 2.0 + Atom + JSON Feed parsing under one API.
- [`reqwest`](https://crates.io/crates/reqwest) — HTTP client (rustls).
- [`ammonia`](https://crates.io/crates/ammonia) — HTML sanitization for article bodies.
- [`opml`](https://crates.io/crates/opml) — OPML 2.0 round-tripping.

All network calls happen in Rust. The webview only renders.

## The model

### Subscription document — `.opml`

Standard OPML 2.0. v1 reads & writes the flat-list subset:

```xml
<opml version="2.0">
  <head><title>untitled</title></head>
  <body>
    <outline type="rss" text="Title" xmlUrl="https://example.com/feed.xml" htmlUrl="https://example.com/" />
    ...
  </body>
</opml>
```

Folders / nested outlines on input: items are recursively flattened in v1; folder names are dropped on save. (We document this so users with folder-organized OPML aren't surprised.)

### Item identity

For read-state keying, an item's stable identity is, in order:

1. `<guid>` if present and `isPermaLink="false"`, or any unique `<id>` for Atom.
2. Otherwise `<link>`.
3. Otherwise SHA-256 of `<title> + <published>`.

### Read-state sidecar — `$XDG_STATE_HOME/krill-rss-reader/state.json`

```json
{
  "version": 1,
  "feeds": {
    "<feedUrlSha256>": {
      "url": "https://example.com/feed.xml",
      "lastFetched": "2026-04-26T10:00:00Z",
      "etag": "\"abc123\"",
      "lastModified": "Wed, 25 Apr 2026 11:00:00 GMT",
      "items": {
        "<itemId>": { "read": true, "starred": false, "firstSeen": "2026-04-25T08:30:00Z" }
      }
    }
  },
  "window": { "width": 1280, "height": 800, "x": 0, "y": 0 }
}
```

- Never grows unboundedly: items missing from the latest fetch are GC'd after 30 days.
- ETag + `Last-Modified` headers stored per feed → fetches send `If-None-Match` / `If-Modified-Since` and skip parsing on `304`.

## Layout

```
+-------------------------------------------------------------+
| [titlebar: menu  drag region  min max close]                |
+-------------+-----------------------+-----------------------+
| Feeds       | Items                 | Article               |
|             |                       |                       |
| ⟳ All       | ●  How to write …     | <h1>How to write …</h1>
|             |    Apr 24 · daringfir |                       |
| ⟳ Daring..  | ○  ELIZA, redux       | <p>The article body…  |
| ⟳ Hacker..  |    Apr 23 · daringfir |                       |
| ⟳ ...       | ●  Friday notes       |                       |
| + Add feed  |    Apr 22 · daringfir |                       |
|             |                       |                       |
+-------------+-----------------------+-----------------------+
| status: subscriptions.opml · dirty • · last refresh 12:04   |
+-------------------------------------------------------------+
```

- **Feeds column** (~200 px): one row per feed. Top "All" pseudo-feed shows the merged item stream. Each feed shows title + unread count. A small refresh icon per row triggers per-feed refresh.
- **Items column** (~340 px): newest first. Read items are dimmed; unread items show the accent dot. Each row: title (one line, ellipsis), 2nd line "{date} · {feed name}".
- **Body column** (rest): article title (serif), byline + date + "open original" link, then the sanitized HTML body. Links open in the default system browser.
- Column dividers are draggable; widths persist in the sidecar window state.

## Discoverability

This is a **manipulation-style app** per [STYLE.md](https://github.com/krill-software/.github/blob/main/STYLE.md). Controls are visible:

- "Add feed" button at the bottom of the feeds column.
- Per-feed refresh icon visible on hover/focus.
- "Mark all read" button at the top of the items column when a feed is selected.
- Every action also has a menu entry; keyboard shortcuts are listed there.

## Fetching

- **On launch:** parallel fetch of every feed in the OPML (with concurrency cap, e.g. 8 at a time).
- **Manual:** `Ctrl+R` refreshes everything; per-feed refresh icon refreshes one.
- HTTP timeout 15 s per feed. Failed feeds show a small "!" indicator next to the title; clicking shows the error.
- User-agent: `krill-rss-reader/<version> (+https://github.com/krill-software/rss-reader)`.
- HTTPS only by default; HTTP allowed if the URL specifies it. No redirect-loop following beyond 5.

## Article rendering

- The webview renders the sanitized HTML body — no JS, no `<iframe>`, no `<script>`, no inline `on*` handlers.
- `ammonia` whitelist: `p, h1-h6, a, img, blockquote, code, pre, ul, ol, li, em, strong, br, hr, figure, figcaption, table, thead, tbody, tr, td, th, picture, source`.
- Links: `target="_blank" rel="noopener"`, intercepted in JS to call `tauri://opener`.
- Images load directly from the feed's URLs. **No tracker stripping in v1** — feature, not bug, for v1 simplicity.

## File handling

- **Open** (`Ctrl+O`): pick an `.opml` file. Replaces the current window's subscriptions.
- **Save** (`Ctrl+S`): writes current OPML back. Dirty marker clears.
- **Save As** (`Ctrl+Shift+S`): same with a path prompt.
- **New** (`Ctrl+N`): empty OPML window.
- **Add feed:** prompt for URL → fetch once to discover title → append outline. Title is editable inline before commit.
- **Remove feed:** select in the feeds column, `Delete` key or context menu. Confirms.
- Drag-drop an `.opml` opens it.
- Untitled subscriptions list is allowed; first save prompts for path.

## Keybindings (v1)

| Action                                 | Key            |
|----------------------------------------|----------------|
| New                                    | `Ctrl+N`       |
| Open                                   | `Ctrl+O`       |
| Save / Save As                         | `Ctrl+S` / `Ctrl+Shift+S` |
| Add feed                               | `Ctrl+L`       |
| Refresh all                            | `Ctrl+R`       |
| Refresh selected feed                  | `Ctrl+Shift+R` |
| Next / previous item                   | `J` / `K`      |
| Next / previous unread                 | `N` / `P`      |
| Toggle read                            | `M`            |
| Toggle starred                         | `S`            |
| Open original article in browser       | `O`            |
| Mark all read in selected feed         | `Shift+M`      |
| Quit                                   | `Ctrl+Q`       |

`J/K/N/P/M/S/O` only fire when focus is in the items list — never when typing in inputs.

## Naming (this app)

| Where         | Value                       |
|---------------|-----------------------------|
| Slug          | `rss`                       |
| Binary        | `krill-rss-reader`                |
| productName   | `RSS Reader`                |
| Identifier    | `software.krill.rss-reader`            |
| Directory     | `krill-software/rss-reader/`    |
| Repo          | `krill-software/rss-reader`         |

## File associations

- Extension: `.opml`
- MIME: `text/x-opml`

(General shipping rules — AppImage / .deb, license, distribution — live in [STYLE.md](https://github.com/krill-software/.github/blob/main/STYLE.md).)

## Out of scope / open questions

- **Atom-1.0 vs RSS-2.0 vs JSON Feed** — `feed-rs` handles all three transparently; nothing to decide.
- **Image rendering security.** A feed could embed tracking pixels. v1 renders them. v2 should add a "no remote content" toggle.
- **Read-state GC threshold.** 30 days of unseen items before purge — confirm.
- **Feed-discovery UX.** Pasted URLs that are HTML pages should auto-discover their `<link rel="alternate">` feed. Probably yes for v1; cheap to add.

## Milestones

1. **M1 — Read-only viewer:** Open OPML, fetch all feeds in parallel, parse, render flat feeds list, items list, sanitized article body. No persistence yet.
2. **M2 — Persistence + write paths:** read-state sidecar, mark read on click + via keyboard, refresh on launch + manual, add/remove feeds, save OPML, dirty tracking.
3. **M3 — Polish + packaging:** keyboard nav (J/K/N/P), starred items, error indicator on failing feeds, AppImage + .deb release flow, GitHub Pages landing.
