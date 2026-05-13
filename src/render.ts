// Rendering for the three columns. Stateful read-only views that re-render
// on any state change; mouse handlers dispatch to selectors / IO.

import { invoke } from "@tauri-apps/api/core";

import { refreshOne, removeFeed } from "./io";
import {
  findItem,
  isItemRead,
  markItemRead,
  selectFeed,
  selectItem,
  state,
  visibleItems,
} from "./state";
import type { FeedItem } from "./types";

export function renderFeedsColumn() {
  const root = document.getElementById("feeds-list")!;
  root.replaceChildren();

  if (!state.opml) {
    root.innerHTML = `<li class="empty">No subscriptions loaded.</li>`;
    return;
  }

  // "All" row
  const allUnread = totalUnread();
  root.appendChild(feedRow({
    label: "All",
    unread: allUnread,
    selected: state.selectedFeed === "all",
    failing: false,
    onSelect: () => selectFeed("all"),
  }));

  for (const f of state.opml.feeds) {
    const fetched = state.feeds.get(f.url);
    const failing = state.errors.has(f.url);
    root.appendChild(feedRow({
      label: f.title || hostnameOf(f.url),
      icon: faviconUrl(f.htmlUrl ?? f.url),
      unread: fetched ? unreadCount(f.url, fetched.items) : 0,
      selected: state.selectedFeed === f.url,
      failing,
      title: failing ? state.errors.get(f.url) : undefined,
      onSelect: () => selectFeed(f.url),
      onRefresh: () => void refreshOne(f.url),
      onRemove: () => void removeFeed(f.url),
    }));
  }
}

function faviconUrl(siteUrl: string): string | null {
  try {
    const u = new URL(siteUrl);
    return `${u.protocol}//${u.host}/favicon.ico`;
  } catch {
    return null;
  }
}

function unreadCount(feedUrl: string, items: FeedItem[]): number {
  let n = 0;
  for (const it of items) if (!isItemRead(feedUrl, it.id)) n++;
  return n;
}

function totalUnread(): number {
  let n = 0;
  for (const [url, f] of state.feeds) n += unreadCount(url, f.items);
  return n;
}

interface FeedRowSpec {
  label: string;
  icon?: string | null;
  unread: number;
  selected: boolean;
  failing: boolean;
  title?: string;
  onSelect: () => void;
  onRefresh?: () => void;
  onRemove?: () => void;
}

function feedRow(spec: FeedRowSpec): HTMLElement {
  const li = document.createElement("li");
  li.className = "feed-row";
  if (spec.selected) li.dataset.selected = "true";
  if (spec.failing) li.dataset.failing = "true";
  if (spec.title) li.title = spec.title;

  const lbl = document.createElement("button");
  lbl.type = "button";
  lbl.className = "feed-label";
  lbl.addEventListener("click", spec.onSelect);

  // Icon slot — always rendered. Falls back to a muted RSS glyph when the
  // feed has no favicon or its URL fails to load.
  const iconSlot = document.createElement("span");
  iconSlot.className = "feed-icon";
  iconSlot.innerHTML = ICON_RSS_FALLBACK;
  if (spec.icon) {
    const img = document.createElement("img");
    img.className = "feed-icon-img";
    img.alt = "";
    img.loading = "lazy";
    img.src = spec.icon;
    img.addEventListener("error", () => { img.remove(); });
    iconSlot.appendChild(img);
  }
  lbl.appendChild(iconSlot);

  const text = document.createElement("span");
  text.className = "feed-label-text";
  text.textContent = spec.label;
  lbl.appendChild(text);
  li.appendChild(lbl);

  const meta = document.createElement("span");
  meta.className = "feed-meta";
  meta.textContent = spec.unread > 0 ? String(spec.unread) : "";
  li.appendChild(meta);

  if (spec.onRefresh || spec.onRemove) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "feed-menu";
    btn.title = "More";
    btn.setAttribute("aria-label", "Feed actions");
    btn.textContent = "⋮";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFeedMenu(btn, spec);
    });
    li.appendChild(btn);
  }
  return li;
}

/** Lucide-style inline icons (refresh-cw + trash-2). currentColor strokes
 *  so each item's CSS color drives the rendered hue. */
const ICON_REFRESH = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const ICON_RSS_FALLBACK = `<svg class="feed-icon-fallback" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5"/></svg>`;

/** Single live popup at a time. Click anywhere outside, scroll, resize,
 *  or pick an item to close. */
let openMenu: { trigger: HTMLElement; popup: HTMLElement; cleanup: () => void } | null = null;

function closeFeedMenu() {
  if (!openMenu) return;
  openMenu.cleanup();
  openMenu.popup.remove();
  delete openMenu.trigger.dataset.open;
  openMenu = null;
}

function openFeedMenu(trigger: HTMLElement, spec: FeedRowSpec) {
  if (openMenu && openMenu.trigger === trigger) { closeFeedMenu(); return; }
  closeFeedMenu();

  const popup = document.createElement("div");
  popup.className = "feed-menu-popup";
  popup.setAttribute("role", "menu");

  const addItem = (label: string, iconSvg: string, action: () => void, danger = false) => {
    const it = document.createElement("button");
    it.type = "button";
    it.className = "feed-menu-item";
    if (danger) it.dataset.danger = "true";
    it.innerHTML = `<span class="feed-menu-icon" aria-hidden="true">${iconSvg}</span><span>${label}</span>`;
    it.addEventListener("click", (e) => { e.stopPropagation(); closeFeedMenu(); action(); });
    popup.appendChild(it);
  };
  if (spec.onRefresh) addItem("Refresh", ICON_REFRESH, spec.onRefresh);
  if (spec.onRemove)  addItem("Delete",  ICON_TRASH,   spec.onRemove, true);

  document.body.appendChild(popup);
  const rect = trigger.getBoundingClientRect();
  popup.style.top = `${Math.round(rect.bottom + 4)}px`;
  popup.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
  trigger.dataset.open = "true";

  const onDocDown = (e: MouseEvent) => {
    if (popup.contains(e.target as Node) || trigger.contains(e.target as Node)) return;
    closeFeedMenu();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeFeedMenu(); };
  const onScroll = () => closeFeedMenu();
  document.addEventListener("mousedown", onDocDown, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onScroll);
  window.addEventListener("scroll", onScroll, true);

  openMenu = {
    trigger,
    popup,
    cleanup: () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    },
  };
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

// ---- Items column -----------------------------------------------------------

export function renderItemsColumn() {
  const list = document.getElementById("items-list")!;
  const titleEl = document.getElementById("items-title")!;
  list.replaceChildren();

  if (!state.opml || !state.selectedFeed) {
    titleEl.textContent = "No feed selected";
    return;
  }
  if (state.selectedFeed === "all") {
    titleEl.textContent = "All feeds";
  } else {
    const f = state.opml.feeds.find((x) => x.url === state.selectedFeed);
    titleEl.textContent = f?.title ?? "Unknown";
  }

  const rows = visibleItems();
  if (rows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = state.refreshing ? "Loading…" : "No items.";
    list.appendChild(empty);
    return;
  }

  for (const { feedUrl, feedTitle, item } of rows) {
    list.appendChild(itemRow(item, feedUrl, feedTitle, state.selectedItem === item.id));
  }
}

function itemRow(item: FeedItem, feedUrl: string, feedTitle: string, selected: boolean): HTMLElement {
  const li = document.createElement("li");
  li.className = "item-row";
  if (selected) li.dataset.selected = "true";
  if (isItemRead(feedUrl, item.id)) li.dataset.read = "true";
  li.tabIndex = 0;

  const dot = document.createElement("span");
  dot.className = "item-dot";
  li.appendChild(dot);

  const body = document.createElement("div");
  body.className = "item-body";

  const t = document.createElement("div");
  t.className = "item-title";
  t.textContent = item.title || "(untitled)";
  body.appendChild(t);

  const m = document.createElement("div");
  m.className = "item-meta";
  m.textContent = `${formatDate(item.published)} · ${feedTitle}`;
  body.appendChild(m);

  li.appendChild(body);
  li.addEventListener("click", () => {
    selectItem(item.id);
    markItemRead(feedUrl, item.id, true);
  });
  return li;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

// ---- Body column ------------------------------------------------------------

export function renderBodyColumn() {
  const root = document.getElementById("article")!;
  root.replaceChildren();

  if (!state.selectedItem) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = state.opml
      ? "Select an item from the list to read."
      : "Open an OPML file or add a feed to begin.";
    root.appendChild(p);
    return;
  }

  const found = findItem(state.selectedItem);
  if (!found) return;
  const { item } = found;

  const h = document.createElement("h1");
  h.className = "article-title";
  h.textContent = item.title || "(untitled)";
  root.appendChild(h);

  const meta = document.createElement("div");
  meta.className = "article-meta";
  const parts: string[] = [];
  if (item.author) parts.push(item.author);
  if (item.published) parts.push(new Date(item.published).toLocaleString());
  if (parts.length) meta.append(document.createTextNode(parts.join(" · ")));
  if (item.link) {
    if (parts.length) meta.append(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = item.link;
    a.textContent = "open original";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void invoke("plugin:opener|open_url", { url: item.link });
    });
    meta.appendChild(a);
  }
  root.appendChild(meta);

  const body = document.createElement("div");
  body.className = "article-body";
  body.innerHTML = item.content || item.summary || "";
  // If the feed put images in <media:*> rather than inline HTML, prepend the
  // first one as a hero. Skip when the body already has its own images.
  if (item.images && item.images.length > 0 && !body.querySelector("img")) {
    const hero = document.createElement("img");
    hero.src = item.images[0];
    hero.alt = "";
    hero.loading = "lazy";
    hero.className = "article-hero";
    body.insertBefore(hero, body.firstChild);
  }
  // Intercept link clicks so they open in the system browser, not the webview.
  body.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
    if (!target || !target.href) return;
    e.preventDefault();
    void invoke("plugin:opener|open_url", { url: target.href });
  });
  root.appendChild(body);
}
