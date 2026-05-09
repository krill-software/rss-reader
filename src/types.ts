// Wire types — must match Rust serializations in src-tauri/src/lib.rs.

export interface OpmlFeed {
  title: string;
  url: string;
  htmlUrl?: string;
}

export interface OpmlDoc {
  path: string;
  name: string;
  feeds: OpmlFeed[];
}

export interface FeedItem {
  id: string;
  title: string;
  link?: string;
  published?: string;   // ISO 8601
  summary?: string;     // sanitized HTML
  content?: string;     // sanitized HTML
  author?: string;
  /** Image URLs harvested from RSS Media (media:content / media:thumbnail). */
  images?: string[];
}

export interface FetchedFeed {
  url: string;
  urlHash: string;
  title: string;
  items: FeedItem[];
  etag?: string;
  lastModified?: string;
}

export type FeedResult =
  | ({ kind: "ok" } & FetchedFeed)
  | { kind: "notmodified"; url: string; etag?: string; lastModified?: string }
  | { kind: "err"; url: string; error: string };

// In-memory app state.
export interface AppState {
  opml: OpmlDoc | null;
  /** url → fetched feed (keyed by feed URL, not hash, for ergonomics). */
  feeds: Map<string, FetchedFeed>;
  /** url → error message, if the latest fetch failed. */
  errors: Map<string, string>;
  /** Currently-selected feed url, or "all", or null. */
  selectedFeed: string | "all" | null;
  /** Currently-selected item id (per current feed). */
  selectedItem: string | null;
  lastRefresh: Date | null;
  refreshing: boolean;
  /** True when in-memory OPML has unsaved edits. */
  dirty: boolean;
  /** `${feedUrl}|${itemId}` set of items the user has read. Mirrors sidecar. */
  readKeys: Set<string>;
}
