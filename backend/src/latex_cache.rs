use crate::types::AppState;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use reqwest::header as reqwest_header;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tracing::warn;

const BOOTSTRAP_FILES: [&str; 3] = [
    "swiftlatexxetex.fmt",
    "swiftlatexpdftex.fmt",
    "xetexfontlist.txt",
];

fn texlive_base_url() -> Option<String> {
    env::var("LATEX_TEXLIVE_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

fn bootstrap_base_url() -> String {
    env::var("LATEX_TEXLIVE_BOOTSTRAP_BASE_URL").unwrap_or_else(|_| {
        "https://github.com/SwiftLaTeX/Texlive-Ondemand/raw/refs/heads/master".to_string()
    })
}

fn is_ctan_tlnet_base(base: &str) -> bool {
    base.to_ascii_lowercase().contains("/tlnet")
}

fn sanitize_texlive_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let rel = FsPath::new(trimmed);
    if rel.is_absolute() {
        return None;
    }
    if rel.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(trimmed.to_string())
}

fn local_root(state: &AppState) -> PathBuf {
    state.data_dir.join("texlive")
}

fn cache_file_path(state: &AppState, safe_path: &str) -> PathBuf {
    local_root(state).join(safe_path)
}

fn missing_marker_path(path: &PathBuf) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("asset");
    path.with_file_name(format!("{file_name}.missing"))
}

fn response_header_name(path: &str) -> HeaderName {
    if path.starts_with("pdftex/pk/") {
        HeaderName::from_static("pkid")
    } else {
        HeaderName::from_static("fileid")
    }
}

fn response_header_value(path: &str) -> String {
    FsPath::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn ok_bytes_response(path: &str, bytes: Vec<u8>) -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let id_header = response_header_name(path);
    let id_value = response_header_value(path);
    if let Ok(value) = HeaderValue::from_str(&id_value) {
        headers.insert(id_header, value);
    }
    headers.insert(
        HeaderName::from_static("access-control-expose-headers"),
        HeaderValue::from_static("fileid, pkid"),
    );
    (StatusCode::OK, headers, bytes)
}

fn bootstrap_target_file(path: &str) -> Option<&'static str> {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        ["xetex", _, "swiftlatexxetex.fmt"] => Some("swiftlatexxetex.fmt"),
        ["pdftex", _, "swiftlatexpdftex.fmt"] => Some("swiftlatexpdftex.fmt"),
        ["xetex", _, "xetexfontlist.txt"] => Some("xetexfontlist.txt"),
        _ => None,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TlpdbFileCandidate {
    package: String,
    rel_path: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct TlpdbIndex {
    by_basename: HashMap<String, Vec<TlpdbFileCandidate>>,
}

static TLPDB_CACHE: OnceLock<Mutex<HashMap<String, Arc<TlpdbIndex>>>> = OnceLock::new();
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn tlpdb_cache() -> &'static Mutex<HashMap<String, Arc<TlpdbIndex>>> {
    TLPDB_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; TypstCollabTexliveFetcher/1.0)")
            .build()
            .expect("failed to build reqwest client")
    })
}

async fn fetch_upstream_bytes(url: &str) -> Result<Option<Vec<u8>>, StatusCode> {
    let response = http_client()
        .get(url)
        .header(reqwest_header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|err| {
        warn!("texlive upstream request failed: {} ({err})", url);
        StatusCode::BAD_GATEWAY
    })?;
    if response.status() == StatusCode::NOT_FOUND
        || response.status() == StatusCode::MOVED_PERMANENTLY
    {
        return Ok(None);
    }
    if !response.status().is_success() {
        warn!(
            "texlive upstream non-success status: {} status={}",
            url,
            response.status()
        );
        return Err(StatusCode::BAD_GATEWAY);
    }
    response
        .bytes()
        .await
        .map(|value| Some(value.to_vec()))
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

async fn ensure_bootstrap_files(state: &AppState) {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.get().is_some() {
        return;
    }
    let root = local_root(state);
    let _ = tokio::fs::create_dir_all(&root).await;
    let base = bootstrap_base_url();
    for file in BOOTSTRAP_FILES {
        let path = root.join(file);
        if path.is_file() {
            continue;
        }
        let url = format!("{}/{}", base.trim_end_matches('/'), file);
        if let Ok(Some(bytes)) = fetch_upstream_bytes(&url).await {
            let _ = tokio::fs::write(&path, bytes).await;
        }
    }
    let _ = ONCE.set(());
}

fn request_key_for_tlpdb(safe_path: &str) -> Option<(String, bool)> {
    let parts: Vec<&str> = safe_path.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        ["pdftex", "pk", _, filename] => Some(((*filename).to_string(), true)),
        ["xetex", _, filename] | ["pdftex", _, filename] => Some(((*filename).to_string(), false)),
        _ => None,
    }
}

fn parse_tlpdb_index(text: &str) -> TlpdbIndex {
    let mut index = TlpdbIndex::default();
    let mut current_package: Option<String> = None;
    let mut in_runfiles = false;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("name ") {
            current_package = Some(rest.trim().to_string());
            in_runfiles = false;
            continue;
        }
        if line.starts_with("runfiles ") {
            in_runfiles = true;
            continue;
        }
        if line.starts_with("docfiles ")
            || line.starts_with("srcfiles ")
            || line.starts_with("binfiles ")
            || line.starts_with("execute ")
            || line.starts_with("depend ")
            || line.starts_with("postaction ")
            || line.starts_with("tlpsetvar ")
        {
            in_runfiles = false;
            continue;
        }
        if !line.starts_with(' ') || !in_runfiles {
            continue;
        }
        let rel = line.trim();
        if rel.is_empty() {
            continue;
        }
        let Some(package) = current_package.as_ref() else {
            continue;
        };
        let Some(base) = FsPath::new(rel).file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        index
            .by_basename
            .entry(base.to_string())
            .or_default()
            .push(TlpdbFileCandidate {
                package: package.clone(),
                rel_path: rel.to_string(),
            });
    }

    index
}

async fn fetch_tlpdb_text(base: &str) -> Result<String, StatusCode> {
    let xz_url = format!("{base}/tlpkg/texlive.tlpdb.xz");
    if let Ok(Some(bytes)) = fetch_upstream_bytes(&xz_url).await {
        let parsed = tokio::task::spawn_blocking(move || {
            let mut decoder = xz2::read::XzDecoder::new(bytes.as_slice());
            let mut text = String::new();
            decoder.read_to_string(&mut text).ok()?;
            Some(text)
        })
        .await
        .ok()
        .flatten();
        if let Some(text) = parsed {
            return Ok(text);
        }
    }

    let plain_url = format!("{base}/tlpkg/texlive.tlpdb");
    let Some(bytes) = fetch_upstream_bytes(&plain_url).await? else {
        return Err(StatusCode::BAD_GATEWAY);
    };
    String::from_utf8(bytes).map_err(|_| StatusCode::BAD_GATEWAY)
}

async fn load_tlpdb_index(base: &str) -> Result<Arc<TlpdbIndex>, StatusCode> {
    {
        let cache = tlpdb_cache()
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if let Some(found) = cache.get(base) {
            return Ok(found.clone());
        }
    }

    let text = fetch_tlpdb_text(base).await?;
    let built = Arc::new(parse_tlpdb_index(&text));
    let mut cache = tlpdb_cache()
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let entry = cache
        .entry(base.to_string())
        .or_insert_with(|| built.clone());
    Ok(entry.clone())
}

fn choose_candidate_for_request(
    candidates: &[TlpdbFileCandidate],
    is_pk: bool,
    filename: &str,
) -> Option<TlpdbFileCandidate> {
    let mut filtered: Vec<&TlpdbFileCandidate> = if is_pk {
        candidates
            .iter()
            .filter(|value| value.rel_path.to_ascii_lowercase().contains("/fonts/pk/"))
            .collect()
    } else {
        candidates
            .iter()
            .filter(|value| !value.rel_path.to_ascii_lowercase().contains("/doc/"))
            .collect()
    };
    if filtered.is_empty() {
        filtered = candidates.iter().collect();
    }

    if let Some(ext) = filename.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()) {
        let ext_filtered: Vec<&TlpdbFileCandidate> = filtered
            .iter()
            .copied()
            .filter(|value| {
                FsPath::new(&value.rel_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case(&ext))
                    .unwrap_or(false)
            })
            .collect();
        if !ext_filtered.is_empty() {
            filtered = ext_filtered;
        }
    }

    filtered
        .into_iter()
        .min_by_key(|value| value.rel_path.len())
        .cloned()
}

fn normalize_tlpdb_rel_path(rel_path: &str) -> String {
    if let Some(rest) = rel_path.strip_prefix("RELOC/") {
        rest.to_string()
    } else {
        rel_path.to_string()
    }
}

async fn extract_from_archive(
    archive_bytes: Vec<u8>,
    rel_path: String,
) -> Result<Option<Vec<u8>>, StatusCode> {
    tokio::task::spawn_blocking(move || {
        let decoder = xz2::read::XzDecoder::new(archive_bytes.as_slice());
        let mut archive = tar::Archive::new(decoder);
        let normalized = rel_path.replace('\\', "/");
        let target_with_slash = format!("/{normalized}");

        for entry in archive.entries().ok()?.flatten() {
            let mut entry = entry;
            let path = entry.path().ok()?.to_string_lossy().replace('\\', "/");
            if path == normalized || path.ends_with(&target_with_slash) {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).ok()?;
                return Some(bytes);
            }
        }
        None
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn fetch_ctan_tlnet_bytes(
    state: &AppState,
    base: &str,
    safe_path: &str,
) -> Result<Option<Vec<u8>>, StatusCode> {
    let Some((filename, is_pk)) = request_key_for_tlpdb(safe_path) else {
        return Ok(None);
    };
    let index = load_tlpdb_index(base).await?;
    let Some(candidates) = index.by_basename.get(&filename) else {
        return Ok(None);
    };
    let Some(candidate) = choose_candidate_for_request(candidates, is_pk, &filename) else {
        return Ok(None);
    };

    let normalized_rel_path = normalize_tlpdb_rel_path(&candidate.rel_path);
    let local_extracted = local_root(state)
        .join("ctan-files")
        .join(normalized_rel_path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
    if local_extracted.exists() {
        return tokio::fs::read(local_extracted)
            .await
            .map(Some)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }

    let archive_url = format!("{base}/archive/{}.tar.xz", candidate.package);
    let Some(archive_bytes) = fetch_upstream_bytes(&archive_url).await? else {
        warn!("ctan archive not found for package {}", candidate.package);
        return Ok(None);
    };
    let Some(file_bytes) = extract_from_archive(archive_bytes, normalized_rel_path.clone()).await?
    else {
        return Ok(None);
    };

    if let Some(parent) = local_extracted.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::write(&local_extracted, &file_bytes).await;
    Ok(Some(file_bytes))
}

pub async fn latex_texlive_proxy(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    let Some(safe_path) = sanitize_texlive_path(&path) else {
        return (StatusCode::BAD_REQUEST, "invalid texlive path").into_response();
    };

    ensure_bootstrap_files(&state).await;
    let root = local_root(&state);
    let _ = tokio::fs::create_dir_all(&root).await;

    if let Some(file) = bootstrap_target_file(&safe_path) {
        let full = root.join(file);
        if let Ok(bytes) = tokio::fs::read(full).await {
            return ok_bytes_response(&safe_path, bytes).into_response();
        }
    }

    let cache_path = cache_file_path(&state, &safe_path);
    let marker_path = missing_marker_path(&cache_path);
    let base_url = texlive_base_url();
    if marker_path.exists() && base_url.is_none() {
        return StatusCode::MOVED_PERMANENTLY.into_response();
    }
    if cache_path.exists() {
        match tokio::fs::read(&cache_path).await {
            Ok(bytes) => return ok_bytes_response(&safe_path, bytes).into_response(),
            Err(_) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, "cache read failed").into_response();
            }
        }
    }

    let Some(base) = base_url else {
        if let Some(parent) = marker_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&marker_path, b"missing").await;
        return StatusCode::MOVED_PERMANENTLY.into_response();
    };

    let bytes = if is_ctan_tlnet_base(&base) {
        match fetch_ctan_tlnet_bytes(&state, &base, &safe_path).await {
            Ok(Some(value)) => value,
            Ok(None) => {
                if let Some(parent) = marker_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&marker_path, b"missing").await;
                return StatusCode::MOVED_PERMANENTLY.into_response();
            }
            Err(_) => {
                return (StatusCode::BAD_GATEWAY, "texlive upstream unavailable").into_response();
            }
        }
    } else {
        let upstream = format!("{}/{}", base, safe_path.trim_start_matches('/'));
        match fetch_upstream_bytes(&upstream).await {
            Ok(Some(value)) => value,
            Ok(None) => {
                if let Some(parent) = marker_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&marker_path, b"missing").await;
                return StatusCode::MOVED_PERMANENTLY.into_response();
            }
            Err(_) => {
                return (StatusCode::BAD_GATEWAY, "texlive upstream unavailable").into_response();
            }
        }
    };

    if let Some(parent) = cache_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::write(&cache_path, &bytes).await;
    let _ = tokio::fs::remove_file(&marker_path).await;
    ok_bytes_response(&safe_path, bytes).into_response()
}
