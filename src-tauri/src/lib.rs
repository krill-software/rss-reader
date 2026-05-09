use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use ammonia::Builder as AmmoniaBuilder;
use feed_rs::parser as feed_parser;
use opml::{Outline as OpmlOutline, OPML};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const USER_AGENT: &str = concat!(
    "krill-rss-reader/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/krill-software/rss-reader)"
);
const HTTP_TIMEOUT_SECS: u64 = 15;

// ---- Wire types -------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
struct OpmlFeed {
    title: String,
    url: String,
    #[serde(rename = "htmlUrl", skip_serializing_if = "Option::is_none")]
    html_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpmlDoc {
    path: String,
    name: String,
    feeds: Vec<OpmlFeed>,
}

#[derive(Debug, Serialize)]
struct FeedItem {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
}

#[derive(Debug, Serialize)]
struct FetchedFeed {
    url: String,
    #[serde(rename = "urlHash")]
    url_hash: String,
    title: String,
    items: Vec<FeedItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(rename = "lastModified", skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FetchSpec {
    url: String,
    #[serde(default)]
    etag: Option<String>,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum FeedResult {
    Ok(FetchedFeed),
    NotModified {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        etag: Option<String>,
        #[serde(rename = "lastModified", skip_serializing_if = "Option::is_none")]
        last_modified: Option<String>,
    },
    Err {
        url: String,
        error: String,
    },
}

// ---- Commands ---------------------------------------------------------------

#[tauri::command]
fn read_opml(path: String) -> Result<OpmlDoc, String> {
    let p = Path::new(&path);
    let xml = fs::read_to_string(p).map_err(|e| format!("{path}: {e}"))?;
    let opml_doc = OPML::from_str(&xml).map_err(|e| format!("{path}: {e}"))?;
    let name = opml_doc
        .head
        .as_ref()
        .and_then(|h| h.title.clone())
        .unwrap_or_else(|| basename_no_ext(&path));
    let mut feeds = Vec::new();
    collect_feeds(&opml_doc.body.outlines, &mut feeds);
    Ok(OpmlDoc {
        path: absolute_path(p),
        name,
        feeds,
    })
}

#[tauri::command]
fn write_opml(path: String, name: String, feeds: Vec<OpmlFeed>) -> Result<String, String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format_io_err(&path, e))?;
        }
    }
    let mut opml_doc = OPML::default();
    opml_doc.head = Some(opml::Head {
        title: Some(name),
        ..Default::default()
    });
    for feed in feeds {
        opml_doc.body.outlines.push(OpmlOutline {
            text: feed.title.clone(),
            title: Some(feed.title),
            xml_url: Some(feed.url),
            html_url: feed.html_url,
            r#type: Some("rss".to_string()),
            ..Default::default()
        });
    }
    let xml = opml_doc
        .to_string()
        .map_err(|e| format!("{path}: {e}"))?;
    fs::write(p, xml).map_err(|e| format_io_err(&path, e))?;
    Ok(absolute_path(p))
}

#[derive(Debug, Serialize)]
struct DiscoveredFeed {
    title: String,
    url: String,
    #[serde(rename = "htmlUrl", skip_serializing_if = "Option::is_none")]
    html_url: Option<String>,
}

#[tauri::command]
async fn discover_feed(url: String) -> Result<DiscoveredFeed, String> {
    let client = build_client().map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let final_url = resp.url().to_string();
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    let parsed = feed_parser::parse(&bytes[..]).map_err(|e| format!("parse: {e}"))?;
    let title = parsed
        .title
        .as_ref()
        .map(|t| t.content.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| hostname_of(&final_url));
    let html_url = parsed
        .links
        .iter()
        .find(|l| l.rel.as_deref() != Some("self"))
        .map(|l| l.href.clone());
    Ok(DiscoveredFeed {
        title,
        url: final_url,
        html_url,
    })
}

#[tauri::command]
async fn fetch_feed(url: String) -> Result<FeedResult, String> {
    let client = build_client().map_err(|e| e.to_string())?;
    Ok(fetch_one(
        &client,
        &FetchSpec {
            url,
            etag: None,
            last_modified: None,
        },
    )
    .await)
}

#[tauri::command]
async fn fetch_feeds(specs: Vec<FetchSpec>) -> Vec<FeedResult> {
    let client = match build_client() {
        Ok(c) => c,
        Err(e) => {
            let msg = e.to_string();
            return specs
                .into_iter()
                .map(|s| FeedResult::Err {
                    url: s.url,
                    error: msg.clone(),
                })
                .collect();
        }
    };
    let mut set = tokio::task::JoinSet::new();
    for spec in specs {
        let c = client.clone();
        set.spawn(async move { fetch_one(&c, &spec).await });
    }
    let mut out = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(r) => out.push(r),
            Err(e) => out.push(FeedResult::Err {
                url: "<task panic>".into(),
                error: e.to_string(),
            }),
        }
    }
    out
}

#[tauri::command]
fn sanitize_html(html: String) -> String {
    sanitize(&html)
}

// ---- Internals --------------------------------------------------------------

fn build_client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
}

async fn fetch_one(client: &Client, spec: &FetchSpec) -> FeedResult {
    let url = &spec.url;
    let mut req = client.get(url);
    if let Some(etag) = &spec.etag {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    if let Some(lm) = &spec.last_modified {
        req = req.header(reqwest::header::IF_MODIFIED_SINCE, lm);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return FeedResult::Err {
                url: url.clone(),
                error: format!("fetch: {e}"),
            }
        }
    };
    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return FeedResult::NotModified {
            url: url.clone(),
            etag: spec.etag.clone(),
            last_modified: spec.last_modified.clone(),
        };
    }
    if !resp.status().is_success() {
        return FeedResult::Err {
            url: url.clone(),
            error: format!("HTTP {}", resp.status()),
        };
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let last_modified = resp
        .headers()
        .get(reqwest::header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return FeedResult::Err {
                url: url.clone(),
                error: format!("read body: {e}"),
            }
        }
    };
    let parsed = match feed_parser::parse(&bytes[..]) {
        Ok(p) => p,
        Err(e) => {
            return FeedResult::Err {
                url: url.clone(),
                error: format!("parse: {e}"),
            }
        }
    };

    let title = parsed
        .title
        .as_ref()
        .map(|t| t.content.clone())
        .unwrap_or_default();
    let items: Vec<FeedItem> = parsed
        .entries
        .iter()
        .map(|e| FeedItem {
            id: e.id.clone(),
            title: e
                .title
                .as_ref()
                .map(|t| t.content.clone())
                .unwrap_or_default(),
            link: e.links.first().map(|l| l.href.clone()),
            published: e.published.or(e.updated).map(|d| d.to_rfc3339()),
            summary: e.summary.as_ref().map(|s| sanitize(&s.content)),
            content: e
                .content
                .as_ref()
                .and_then(|c| c.body.as_ref())
                .map(|b| sanitize(b)),
            author: e.authors.first().map(|a| a.name.clone()),
            images: extract_images(e),
        })
        .collect();

    FeedResult::Ok(FetchedFeed {
        url: url.to_string(),
        url_hash: hash_url(url),
        title,
        items,
        etag,
        last_modified,
    })
}

fn extract_images(entry: &feed_rs::model::Entry) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |s: String| {
        if !out.contains(&s) {
            out.push(s);
        }
    };
    for m in &entry.media {
        for c in &m.content {
            let is_image = c
                .content_type
                .as_ref()
                .map(|t| t.ty().as_str().eq_ignore_ascii_case("image"))
                .unwrap_or_else(|| {
                    c.url
                        .as_ref()
                        .map(|u| {
                            let p = u.path().to_ascii_lowercase();
                            p.ends_with(".jpg")
                                || p.ends_with(".jpeg")
                                || p.ends_with(".png")
                                || p.ends_with(".gif")
                                || p.ends_with(".webp")
                                || p.ends_with(".avif")
                        })
                        .unwrap_or(false)
                });
            if is_image {
                if let Some(url) = &c.url {
                    push(url.to_string());
                }
            }
        }
        for t in &m.thumbnails {
            push(t.image.uri.clone());
        }
    }
    out
}

fn collect_feeds(outlines: &[OpmlOutline], out: &mut Vec<OpmlFeed>) {
    for o in outlines {
        if let Some(url) = &o.xml_url {
            let title = if !o.text.is_empty() {
                o.text.clone()
            } else {
                o.title.clone().unwrap_or_default()
            };
            out.push(OpmlFeed {
                title,
                url: url.clone(),
                html_url: o.html_url.clone(),
            });
        }
        if !o.outlines.is_empty() {
            collect_feeds(&o.outlines, out);
        }
    }
}

fn sanitize(html: &str) -> String {
    AmmoniaBuilder::default()
        .add_tags(&["picture", "source", "figure", "figcaption", "video", "audio"])
        .add_tag_attributes("source", &["srcset", "src", "type", "media", "sizes"])
        .add_tag_attributes("img", &["srcset", "sizes", "loading"])
        .add_tag_attributes(
            "video",
            &["src", "controls", "poster", "preload", "width", "height", "muted", "playsinline"],
        )
        .add_tag_attributes("audio", &["src", "controls", "preload"])
        .clean(html)
        .to_string()
}

fn hostname_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_else(|| url.to_string())
}

fn hash_url(url: &str) -> String {
    let mut h = Sha256::new();
    h.update(url.as_bytes());
    format!("{:x}", h.finalize())
}

fn basename_no_ext(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "untitled".into())
}

fn absolute_path(p: &Path) -> String {
    fs::canonicalize(p)
        .map(|abs| abs.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

fn format_io_err(path: &str, e: io::Error) -> String {
    format!("{path}: {e}")
}

// ---- App state (window geometry + recent files) -----------------------------

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppState {
    window: Option<WindowState>,
    recent: Option<Vec<String>>,
    /// Per-feed sidecar (read-state + ETag/Last-Modified) keyed by SHA-256(url).
    feeds: Option<HashMap<String, FeedSidecar>>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct FeedSidecar {
    url: String,
    #[serde(rename = "lastFetched", skip_serializing_if = "Option::is_none")]
    last_fetched: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(rename = "lastModified", skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
    #[serde(default)]
    items: HashMap<String, ItemState>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct ItemState {
    #[serde(default, skip_serializing_if = "is_false")]
    read: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    starred: bool,
    #[serde(rename = "firstSeen", skip_serializing_if = "Option::is_none")]
    first_seen: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !b
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

fn state_path() -> Option<PathBuf> {
    let base = dirs::state_dir().or_else(dirs::data_local_dir)?;
    Some(base.join("krill-rss-reader").join("state.json"))
}

#[tauri::command]
fn load_state() -> Option<AppState> {
    let p = state_path()?;
    let raw = fs::read_to_string(p).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
fn save_state(state: AppState) -> Result<(), String> {
    let p = state_path().ok_or_else(|| "no state dir available".to_string())?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn default_opml_path() -> Result<String, String> {
    let base = dirs::config_dir().ok_or_else(|| "no config dir".to_string())?;
    let dir = base.join("krill-rss-reader");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("subscriptions.opml").to_string_lossy().into_owned())
}

#[tauri::command]
fn dev_test_file() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let manifest = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(manifest).parent()?.join("test.opml");
    path.exists().then(|| path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_opml,
            write_opml,
            fetch_feed,
            fetch_feeds,
            discover_feed,
            sanitize_html,
            load_state,
            save_state,
            default_opml_path,
            dev_test_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
