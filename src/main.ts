import "@krill-software/desktop-ui/styles";
import "./styles.css";

import { mountChrome, showBootError } from "@krill-software/desktop-ui";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getMatches } from "@tauri-apps/plugin-cli";

import {
  addFeedByUrl,
  lastOpenedFile,
  openOpmlPath,
  openOpmlViaDialog,
  refreshAll,
  saveOpml,
  saveOpmlAs,
} from "./io";
import { renderBodyColumn, renderFeedsColumn, renderItemsColumn } from "./render";
import { loadSidecar } from "./sidecar";
import { state, subscribe } from "./state";

let titleEl: HTMLElement | null = null;

function initChrome() {
  const chrome = mountChrome({
    productName: "RSS Reader",
    actions: {
      "open":    openOpmlViaDialog,
      "save":    () => void saveOpml(),
      "save-as": () => void saveOpmlAs(),
    },
    customMenu: [
      {
        group: "file",
        items: [
          { label: "Add feed…", shortcut: "Ctrl+L", action: () => promptAddFeed() },
          { label: "Refresh",   shortcut: "Ctrl+R", action: () => void refreshAll() },
        ],
      },
    ],
    showStatusLine: true,
  });
  titleEl = chrome.title;
  chrome.viewport.innerHTML = `
    <section id="feeds-col" aria-label="Feeds">
      <header class="col-head">Feeds</header>
      <ul id="feeds-list"></ul>
      <footer class="col-foot">
        <button id="add-feed" class="rail-btn" type="button">+ Add feed</button>
      </footer>
    </section>
    <section id="items-col" aria-label="Items">
      <header class="col-head">
        <span id="items-title">No feed selected</span>
        <button id="mark-all-read" class="link-btn" type="button" hidden>Mark all read</button>
      </header>
      <ul id="items-list"></ul>
    </section>
    <section id="body-col" aria-label="Article">
      <article id="article">
        <p class="placeholder">Open an OPML file or add a feed to begin.</p>
      </article>
    </section>
  `;

  // Status line: refresh state in state (right). Filename rides the titlebar;
  // dirty marker rides body[data-dirty="true"] as the `•` titlebar prefix.
  const refreshSpan = document.createElement("span");
  refreshSpan.id = "status-refresh";
  chrome.statusState!.appendChild(refreshSpan);
}

function updateStatus() {
  const set = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  const fileName = state.opml
    ? (state.opml.path ? basename(state.opml.path) : `${state.opml.name} (unsaved)`)
    : "";
  if (titleEl) titleEl.textContent = fileName;
  set("status-refresh", state.refreshing
    ? "refreshing…"
    : state.lastRefresh
      ? `last refresh ${state.lastRefresh.toLocaleTimeString()}`
      : "");
  document.body.dataset.dirty = state.dirty ? "true" : "false";
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function promptAddFeed() {
  const foot = document.querySelector("#feeds-col .col-foot");
  const btn = document.getElementById("add-feed");
  if (!foot || !btn) return;
  if (foot.querySelector(".add-feed-form")) return;
  btn.setAttribute("hidden", "");

  const form = document.createElement("form");
  form.className = "add-feed-form";
  form.innerHTML = `
    <input type="url" name="url" placeholder="https://example.com/feed.xml" required autocomplete="off" spellcheck="false" />
    <div class="add-feed-row">
      <button type="submit" class="rail-btn">Add</button>
      <button type="button" class="rail-btn" data-cancel>Cancel</button>
    </div>
    <div class="add-feed-error" hidden></div>
  `;
  const close = () => { form.remove(); btn.removeAttribute("hidden"); };
  form.querySelector<HTMLButtonElement>("[data-cancel]")!.addEventListener("click", close);
  form.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>("input[name=url]")!;
    const errEl = form.querySelector<HTMLDivElement>(".add-feed-error")!;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    errEl.hidden = true;
    submit.disabled = true;
    submit.textContent = "Adding…";
    try {
      await addFeedByUrl(input.value);
      close();
    } catch (err) {
      errEl.textContent = String(err);
      errEl.hidden = false;
      submit.disabled = false;
      submit.textContent = "Add";
    }
  });
  foot.appendChild(form);
  form.querySelector<HTMLInputElement>("input")?.focus();
}

async function installFileDrop() {
  const wv = getCurrentWebview();
  await wv.onDragDropEvent(async (e) => {
    if (e.payload.type === "drop") {
      const path = e.payload.paths[0];
      if (path && path.toLowerCase().endsWith(".opml")) {
        await openOpmlPath(path).catch((err) => console.error("drop open failed:", err));
      }
    }
  });
}

async function boot() {
  initChrome();
  await installFileDrop();
  await loadSidecar();

  subscribe(() => {
    renderFeedsColumn();
    renderItemsColumn();
    renderBodyColumn();
    updateStatus();
  });

  // First paint
  renderFeedsColumn();
  renderItemsColumn();
  renderBodyColumn();
  updateStatus();

  document.getElementById("add-feed")?.addEventListener("click", () => promptAddFeed());

  // Open from CLI arg, or dev test file.
  let openedFromArg = false;
  try {
    const matches = await getMatches();
    const arg = matches.args.file?.value;
    if (typeof arg === "string" && arg.length > 0) {
      await openOpmlPath(arg);
      openedFromArg = true;
    }
  } catch { /* cli plugin unavailable */ }

  if (!openedFromArg) {
    const last = await lastOpenedFile();
    if (last) {
      try {
        await openOpmlPath(last);
        openedFromArg = true;
      } catch (e) {
        console.warn("auto-open last file failed:", e);
      }
    }
  }

  if (!openedFromArg && import.meta.env.DEV) {
    try {
      const dev = await invoke<string | null>("dev_test_file");
      if (dev) await openOpmlPath(dev);
    } catch { /* no test file */ }
  }
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
