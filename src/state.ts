import * as sidecar from "./sidecar";
import type { AppState, FetchedFeed, OpmlDoc, OpmlFeed } from "./types";

export const state: AppState = {
  opml: null,
  feeds: new Map(),
  errors: new Map(),
  selectedFeed: null,
  selectedItem: null,
  lastRefresh: null,
  refreshing: false,
  dirty: false,
  readKeys: new Set(),
};

export function itemKey(feedUrl: string, itemId: string): string {
  return `${feedUrl}|${itemId}`;
}

export function isItemRead(feedUrl: string, itemId: string): boolean {
  return state.readKeys.has(itemKey(feedUrl, itemId));
}

export function hydrateReadFromSidecar() {
  state.readKeys = sidecar.readKeysSnapshot();
  notify();
}

export function markItemRead(feedUrl: string, itemId: string, read = true) {
  const k = itemKey(feedUrl, itemId);
  const was = state.readKeys.has(k);
  if (was === read) return;
  if (read) state.readKeys.add(k);
  else state.readKeys.delete(k);
  void sidecar.markRead(feedUrl, itemId, read);
  notify();
}

const listeners = new Set<() => void>();
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify() {
  for (const fn of listeners) fn();
}

export function setOpml(opml: OpmlDoc | null) {
  state.opml = opml;
  state.feeds = new Map();
  state.errors = new Map();
  state.selectedFeed = opml && opml.feeds.length > 0 ? "all" : null;
  state.selectedItem = null;
  state.dirty = false;
  notify();
}

export function setDirty(dirty: boolean) {
  if (state.dirty === dirty) return;
  state.dirty = dirty;
  notify();
}

export function setOpmlPath(path: string, name?: string) {
  if (!state.opml) return;
  state.opml = { ...state.opml, path, name: name ?? state.opml.name };
  notify();
}

export function ensureUntitledOpml() {
  if (state.opml) return;
  state.opml = { path: "", name: "untitled", feeds: [] };
  state.selectedFeed = null;
  notify();
}

export function addFeedToOpml(feed: OpmlFeed) {
  ensureUntitledOpml();
  if (!state.opml) return;
  if (state.opml.feeds.some((f) => f.url === feed.url)) return;
  state.opml = { ...state.opml, feeds: [...state.opml.feeds, feed] };
  state.dirty = true;
  notify();
}

export function removeFeedFromOpml(url: string) {
  if (!state.opml) return;
  const feeds = state.opml.feeds.filter((f) => f.url !== url);
  if (feeds.length === state.opml.feeds.length) return;
  state.opml = { ...state.opml, feeds };
  state.feeds.delete(url);
  state.errors.delete(url);
  if (state.selectedFeed === url) state.selectedFeed = feeds.length > 0 ? "all" : null;
  state.dirty = true;
  void sidecar.dropFeed(url);
  // Drop any in-memory read keys for this feed too.
  const prefix = `${url}|`;
  for (const k of state.readKeys) if (k.startsWith(prefix)) state.readKeys.delete(k);
  notify();
}

export function setFeed(url: string, feed: FetchedFeed) {
  state.feeds.set(url, feed);
  state.errors.delete(url);
  notify();
}

export function setFeedError(url: string, error: string) {
  state.errors.set(url, error);
  notify();
}

export function selectFeed(urlOrAll: string | "all") {
  state.selectedFeed = urlOrAll;
  state.selectedItem = null;
  notify();
}

export function selectItem(id: string | null) {
  state.selectedItem = id;
  notify();
}

export function setRefreshing(refreshing: boolean) {
  state.refreshing = refreshing;
  if (!refreshing) state.lastRefresh = new Date();
  notify();
}

/** Items visible in the middle column for the currently-selected feed. */
export function visibleItems(): { feedUrl: string; feedTitle: string; item: import("./types").FeedItem }[] {
  if (!state.opml || !state.selectedFeed) return [];
  const collect = (urls: string[]) => urls.flatMap((u) => {
    const f = state.feeds.get(u);
    if (!f) return [];
    return f.items.map((item) => ({ feedUrl: u, feedTitle: f.title, item }));
  });
  const rows = state.selectedFeed === "all"
    ? collect(state.opml.feeds.map((f) => f.url))
    : collect([state.selectedFeed]);
  rows.sort((a, b) => {
    const da = a.item.published ? Date.parse(a.item.published) : 0;
    const db = b.item.published ? Date.parse(b.item.published) : 0;
    return db - da;
  });
  return rows;
}

export function findItem(id: string): { feedUrl: string; item: import("./types").FeedItem } | null {
  for (const [url, feed] of state.feeds) {
    const item = feed.items.find((i) => i.id === id);
    if (item) return { feedUrl: url, item };
  }
  return null;
}
