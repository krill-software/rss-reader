// Read-state sidecar — persists per-feed conditional-fetch headers and
// per-item read/starred flags to $XDG_STATE_HOME/krill-rss-reader/state.json
// via the Rust load_state / save_state commands.

import { invoke } from "@tauri-apps/api/core";

interface ItemState {
  read?: boolean;
  starred?: boolean;
  firstSeen?: string;
}

interface FeedSidecar {
  url: string;
  lastFetched?: string;
  etag?: string;
  lastModified?: string;
  items: Record<string, ItemState>;
}

interface PersistedAppState {
  window?: unknown;
  recent?: string[];
  feeds?: Record<string, FeedSidecar>;
}

/** In-memory copy of the persisted state, hashUrl → FeedSidecar. */
const feeds: Map<string, FeedSidecar> = new Map();
let persistedRest: Omit<PersistedAppState, "feeds"> = {};
let loaded = false;
let saveTimer: number | null = null;

const SAVE_DEBOUNCE_MS = 1000;
const GC_AFTER_MS = 30 * 24 * 3600 * 1000;

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const hashCache = new Map<string, string>();
async function hashUrl(url: string): Promise<string> {
  let h = hashCache.get(url);
  if (!h) {
    h = await sha256Hex(url);
    hashCache.set(url, h);
  }
  return h;
}

export async function loadSidecar(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = (await invoke<PersistedAppState | null>("load_state")) ?? {};
    const { feeds: persistedFeeds, ...rest } = raw;
    persistedRest = rest;
    if (persistedFeeds) {
      for (const [hash, feed] of Object.entries(persistedFeeds)) {
        feeds.set(hash, { ...feed, items: feed.items ?? {} });
      }
    }
  } catch (e) {
    console.warn("loadSidecar failed:", e);
  }
}

function scheduleSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, SAVE_DEBOUNCE_MS) as unknown as number;
}

async function saveNow(): Promise<void> {
  try {
    const feedsObj: Record<string, FeedSidecar> = {};
    for (const [k, v] of feeds) feedsObj[k] = v;
    await invoke("save_state", { state: { ...persistedRest, feeds: feedsObj } });
  } catch (e) {
    console.error("save_state failed:", e);
  }
}

/** Force an immediate flush (e.g. on window-close hooks if we wire them later). */
export async function flushSidecar(): Promise<void> {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveNow();
}

export async function getConditions(feedUrl: string): Promise<{ etag?: string; lastModified?: string }> {
  await loadSidecar();
  const f = feeds.get(await hashUrl(feedUrl));
  return f ? { etag: f.etag, lastModified: f.lastModified } : {};
}

export async function isRead(feedUrl: string, itemId: string): Promise<boolean> {
  await loadSidecar();
  const f = feeds.get(await hashUrl(feedUrl));
  return !!f?.items[itemId]?.read;
}

/** Synchronous variant — only correct after loadSidecar() has resolved. */
export function isReadSync(feedHash: string, itemId: string): boolean {
  return !!feeds.get(feedHash)?.items[itemId]?.read;
}

/** Look up the cached hash for a URL after loadSidecar(); returns null if unseen. */
export function feedHashOrNull(url: string): string | null {
  return hashCache.get(url) ?? null;
}

export async function feedHash(url: string): Promise<string> {
  return hashUrl(url);
}

export async function markRead(feedUrl: string, itemId: string, read = true): Promise<void> {
  await loadSidecar();
  const hash = await hashUrl(feedUrl);
  let f = feeds.get(hash);
  if (!f) {
    f = { url: feedUrl, items: {} };
    feeds.set(hash, f);
  }
  const cur = f.items[itemId] ?? {};
  if (!!cur.read === read) return;
  f.items[itemId] = { ...cur, read };
  scheduleSave();
}

/**
 * Reconcile a freshly-fetched feed:
 *  - Merge the new etag/lastModified/lastFetched.
 *  - Ensure every item has a `firstSeen` timestamp.
 *  - GC items not seen in this fetch whose `firstSeen` is older than 30 days.
 */
export async function reconcileFetched(
  feedUrl: string,
  etag: string | undefined,
  lastModified: string | undefined,
  itemIds: string[],
): Promise<void> {
  await loadSidecar();
  const hash = await hashUrl(feedUrl);
  const now = new Date().toISOString();
  let f = feeds.get(hash);
  if (!f) {
    f = { url: feedUrl, items: {} };
    feeds.set(hash, f);
  }
  f.url = feedUrl;
  f.lastFetched = now;
  if (etag !== undefined) f.etag = etag;
  if (lastModified !== undefined) f.lastModified = lastModified;
  const present = new Set(itemIds);
  for (const id of itemIds) {
    if (!f.items[id]) f.items[id] = { firstSeen: now };
    else if (!f.items[id].firstSeen) f.items[id].firstSeen = now;
  }
  const cutoff = Date.now() - GC_AFTER_MS;
  for (const [id, st] of Object.entries(f.items)) {
    if (present.has(id)) continue;
    const seen = st.firstSeen ? Date.parse(st.firstSeen) : 0;
    if (seen && seen < cutoff) delete f.items[id];
  }
  scheduleSave();
}

/** Called after a 304 — bump lastFetched but keep everything else. */
export async function reconcileNotModified(feedUrl: string): Promise<void> {
  await loadSidecar();
  const hash = await hashUrl(feedUrl);
  const f = feeds.get(hash);
  if (!f) return;
  f.lastFetched = new Date().toISOString();
  scheduleSave();
}

/** Drop sidecar state for a feed the user removed. */
export async function dropFeed(feedUrl: string): Promise<void> {
  await loadSidecar();
  const hash = await hashUrl(feedUrl);
  if (feeds.delete(hash)) scheduleSave();
}

/** Used by io.ts to merge a recent-files update without losing the feeds map. */
export async function updatePersistedRest(patch: Partial<Omit<PersistedAppState, "feeds">>): Promise<void> {
  await loadSidecar();
  persistedRest = { ...persistedRest, ...patch };
  scheduleSave();
}

export async function getPersistedRest(): Promise<Omit<PersistedAppState, "feeds">> {
  await loadSidecar();
  return { ...persistedRest };
}

/** Snapshot of `${feedUrl}|${itemId}` keys that are currently flagged read. */
export function readKeysSnapshot(): Set<string> {
  const out = new Set<string>();
  for (const f of feeds.values()) {
    for (const [itemId, st] of Object.entries(f.items)) {
      if (st.read) out.add(`${f.url}|${itemId}`);
    }
  }
  return out;
}
