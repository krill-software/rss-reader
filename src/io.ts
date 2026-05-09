import { invoke } from "@tauri-apps/api/core";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import * as sidecar from "./sidecar";
import {
  addFeedToOpml,
  hydrateReadFromSidecar,
  removeFeedFromOpml,
  setDirty,
  setFeed,
  setFeedError,
  setOpml,
  setOpmlPath,
  setRefreshing,
  state,
} from "./state";
import type { FeedResult, FetchedFeed, OpmlDoc, OpmlFeed } from "./types";

interface FetchSpec {
  url: string;
  etag?: string;
  lastModified?: string;
}

async function specFor(url: string): Promise<FetchSpec> {
  const cond = await sidecar.getConditions(url);
  return { url, etag: cond.etag, lastModified: cond.lastModified };
}

export async function openOpmlPath(path: string): Promise<void> {
  await sidecar.loadSidecar();
  const doc = await invoke<OpmlDoc>("read_opml", { path });
  setOpml(doc);
  hydrateReadFromSidecar();
  void rememberLastFile(doc.path);
  await refreshAll();
}

async function rememberLastFile(path: string): Promise<void> {
  const prev = await sidecar.getPersistedRest();
  const recent = [path, ...(prev.recent ?? []).filter((p) => p !== path)].slice(0, 10);
  await sidecar.updatePersistedRest({ ...prev, recent });
}

export async function lastOpenedFile(): Promise<string | null> {
  const prev = await sidecar.getPersistedRest();
  return prev.recent?.[0] ?? null;
}

export async function openOpmlViaDialog(): Promise<void> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "OPML", extensions: ["opml", "xml"] }],
  });
  if (typeof selected === "string") {
    await openOpmlPath(selected).catch((e) => console.error("open failed:", e));
  }
}

export async function refreshAll(): Promise<void> {
  if (!state.opml) return;
  setRefreshing(true);
  try {
    const specs = await Promise.all(state.opml.feeds.map((f) => specFor(f.url)));
    const results = await invoke<FeedResult[]>("fetch_feeds", { specs });
    for (const r of results) await applyFeedResult(r);
  } finally {
    setRefreshing(false);
  }
}

export async function refreshOne(url: string): Promise<void> {
  try {
    const result = await invoke<FeedResult>("fetch_feed", { url });
    await applyFeedResult(result);
  } catch (e) {
    setFeedError(url, String(e));
  }
}

async function applyFeedResult(r: FeedResult): Promise<void> {
  if (r.kind === "ok") {
    const feed = r as FetchedFeed;
    setFeed(feed.url, feed);
    await sidecar.reconcileFetched(
      feed.url,
      feed.etag,
      feed.lastModified,
      feed.items.map((it) => it.id),
    );
  } else if (r.kind === "notmodified") {
    await sidecar.reconcileNotModified(r.url);
  } else {
    setFeedError(r.url, r.error);
  }
}

export async function addFeedByUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) return;
  if (state.opml?.feeds.some((f) => f.url === trimmed)) {
    throw new Error("Feed already in subscriptions");
  }
  const discovered = await invoke<OpmlFeed>("discover_feed", { url: trimmed });
  addFeedToOpml(discovered);
  await persistOpml();
  void refreshOne(discovered.url);
}

export async function removeFeed(url: string): Promise<void> {
  const feed = state.opml?.feeds.find((f) => f.url === url);
  const label = feed?.title || url;
  const ok = await ask(`Remove "${label}"?`, { title: "Remove feed", kind: "warning" });
  if (!ok) return;
  removeFeedFromOpml(url);
  await persistOpml();
}

/**
 * Write the current OPML to disk, picking the default path the first time
 * if the user hasn't named the file yet. Used for auto-save on add/remove.
 */
async function persistOpml(): Promise<void> {
  if (!state.opml) return;
  let path = state.opml.path;
  if (!path) {
    try {
      path = await invoke<string>("default_opml_path");
    } catch (e) {
      console.warn("default_opml_path failed:", e);
      return;
    }
  }
  try {
    const written = await invoke<string>("write_opml", {
      path,
      name: state.opml.name,
      feeds: state.opml.feeds,
    });
    setOpmlPath(written);
    setDirty(false);
    void rememberLastFile(written);
  } catch (e) {
    console.error("auto-save failed:", e);
  }
}

export async function saveOpml(): Promise<void> {
  if (!state.opml) return;
  if (!state.opml.path) {
    await saveOpmlAs();
    return;
  }
  const written = await invoke<string>("write_opml", {
    path: state.opml.path,
    name: state.opml.name,
    feeds: state.opml.feeds,
  });
  setOpmlPath(written);
  setDirty(false);
}

export async function saveOpmlAs(): Promise<void> {
  if (!state.opml) return;
  const selected = await saveDialog({
    defaultPath: state.opml.path || `${state.opml.name || "subscriptions"}.opml`,
    filters: [{ name: "OPML", extensions: ["opml"] }],
  });
  if (typeof selected !== "string") return;
  const written = await invoke<string>("write_opml", {
    path: selected,
    name: state.opml.name,
    feeds: state.opml.feeds,
  });
  setOpmlPath(written);
  setDirty(false);
}
