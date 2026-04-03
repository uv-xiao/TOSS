use crate::types::AppState;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use std::collections::HashMap;
use std::env;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

fn texlive_base_url() -> String {
    env::var("LATEX_TEXLIVE_BASE_URL")
        .unwrap_or_else(|_| "https://texlive2.swiftlatex.com".to_string())
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

fn cache_root(state: &AppState) -> PathBuf {
    if let Ok(raw) = env::var("LATEX_TEXLIVE_CACHE_DIR") {
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            return path;
        }
        return state.data_dir.join(path);
    }
    state.data_dir.join("texlive-cache")
}

fn cache_file_path(state: &AppState, safe_path: &str) -> PathBuf {
    cache_root(state).join(safe_path)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LocalMode {
    Off,
    Prefer,
    LocalOnly,
}

impl LocalMode {
    fn from_env() -> Self {
        match env::var("LATEX_TEXLIVE_LOCAL_MODE")
            .unwrap_or_else(|_| "off".to_string())
            .to_lowercase()
            .as_str()
        {
            "prefer" => Self::Prefer,
            "local_only" | "only" => Self::LocalOnly,
            _ => Self::Off,
        }
    }
}

fn local_dir() -> Option<PathBuf> {
    env::var("LATEX_TEXLIVE_LOCAL_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn sanitize_filename(raw: &str) -> Option<String> {
    if raw.contains('/') || raw.contains('\\') || raw.contains("..") || raw.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == ' ' || ch == '_' || ch == '-' || ch == '.' {
            out.push(ch);
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

#[derive(Debug)]
enum LocalTexliveRequest {
    XetexFile { format: String, filename: String },
    PdftexFile { format: String, filename: String },
    PdftexPk { dpi: String, filename: String },
}

fn parse_local_request(path: &str) -> Option<LocalTexliveRequest> {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        ["xetex", format, filename] => Some(LocalTexliveRequest::XetexFile {
            format: (*format).to_string(),
            filename: sanitize_filename(filename)?,
        }),
        ["pdftex", format, filename] => Some(LocalTexliveRequest::PdftexFile {
            format: (*format).to_string(),
            filename: sanitize_filename(filename)?,
        }),
        ["pdftex", "pk", dpi, filename] => Some(LocalTexliveRequest::PdftexPk {
            dpi: (*dpi).to_string(),
            filename: sanitize_filename(filename)?,
        }),
        _ => None,
    }
}

fn try_read_local_special_file(root: &FsPath, request: &LocalTexliveRequest) -> Option<PathBuf> {
    let relative = match request {
        LocalTexliveRequest::XetexFile { filename, .. } if filename == "swiftlatexxetex.fmt" => {
            Some("swiftlatexxetex.fmt")
        }
        LocalTexliveRequest::XetexFile { filename, .. } if filename == "xetexfontlist.txt" => {
            Some("xetexfontlist.txt")
        }
        LocalTexliveRequest::PdftexFile { filename, .. } if filename == "swiftlatexpdftex.fmt" => {
            Some("swiftlatexpdftex.fmt")
        }
        _ => None,
    }?;
    let path = root.join(relative);
    if path.is_file() { Some(path) } else { None }
}

#[derive(Default)]
struct LocalTexliveIndex {
    by_basename: HashMap<String, Vec<PathBuf>>,
}

static LOCAL_INDEX_CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<LocalTexliveIndex>>>> = OnceLock::new();

fn index_cache() -> &'static Mutex<HashMap<PathBuf, Arc<LocalTexliveIndex>>> {
    LOCAL_INDEX_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn build_local_index(root: &FsPath) -> Option<LocalTexliveIndex> {
    let mut index = LocalTexliveIndex::default();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            index
                .by_basename
                .entry(name.to_string())
                .or_default()
                .push(path);
        }
    }
    Some(index)
}

fn get_or_build_local_index(root: &FsPath) -> Option<Arc<LocalTexliveIndex>> {
    let key = root.to_path_buf();
    {
        let cache = index_cache().lock().ok()?;
        if let Some(found) = cache.get(&key) {
            return Some(found.clone());
        }
    }
    let built = Arc::new(build_local_index(root)?);
    let mut cache = index_cache().lock().ok()?;
    let entry = cache.entry(key).or_insert_with(|| built.clone());
    Some(entry.clone())
}

fn format_extension_hint(raw: &str) -> Option<&'static str> {
    let fmt = raw.parse::<i32>().ok()?;
    match fmt {
        10 => Some("fmt"),
        28 => Some("tfm"),
        30 => Some("pfb"),
        _ => None,
    }
}

fn pick_best_path(candidates: &[PathBuf], suffix: Option<&str>, contains: Option<&str>) -> Option<PathBuf> {
    let mut items: Vec<&PathBuf> = candidates.iter().collect();
    if let Some(value) = contains {
        let lowered = value.to_ascii_lowercase();
        let filtered: Vec<&PathBuf> = items
            .iter()
            .copied()
            .filter(|path| path.to_string_lossy().to_ascii_lowercase().contains(&lowered))
            .collect();
        if !filtered.is_empty() {
            items = filtered;
        }
    }
    if let Some(ext) = suffix {
        let filtered: Vec<&PathBuf> = items
            .iter()
            .copied()
            .filter(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.eq_ignore_ascii_case(ext))
                    .unwrap_or(false)
            })
            .collect();
        if !filtered.is_empty() {
            items = filtered;
        }
    }
    items
        .into_iter()
        .min_by_key(|path| path.to_string_lossy().len())
        .cloned()
}

fn resolve_local_from_index(root: &FsPath, request: &LocalTexliveRequest) -> Option<PathBuf> {
    let index = get_or_build_local_index(root)?;
    match request {
        LocalTexliveRequest::XetexFile { format, filename } => {
            let mut names = vec![filename.clone()];
            if !filename.contains('.') {
                if let Some(ext) = format_extension_hint(format) {
                    names.push(format!("{filename}.{ext}"));
                }
            }
            let mut candidates = Vec::new();
            for name in names {
                if let Some(found) = index.by_basename.get(&name) {
                    candidates.extend(found.iter().cloned());
                }
            }
            if candidates.is_empty() {
                return None;
            }
            pick_best_path(&candidates, None, Some("texmf"))
        }
        LocalTexliveRequest::PdftexFile { format, filename } => {
            let mut names = vec![filename.clone()];
            if !filename.contains('.') {
                if let Some(ext) = format_extension_hint(format) {
                    names.push(format!("{filename}.{ext}"));
                }
            }
            let mut candidates = Vec::new();
            for name in names {
                if let Some(found) = index.by_basename.get(&name) {
                    candidates.extend(found.iter().cloned());
                }
            }
            if candidates.is_empty() {
                return None;
            }
            pick_best_path(&candidates, None, Some("texmf"))
        }
        LocalTexliveRequest::PdftexPk { dpi, filename } => {
            let candidates = index.by_basename.get(filename)?;
            let contains = format!("/{dpi}/");
            let ext = filename
                .rsplit_once('.')
                .map(|(_, value)| value)
                .filter(|value| !value.is_empty());
            pick_best_path(candidates, ext, Some(&contains))
                .or_else(|| pick_best_path(candidates, ext, Some("pk")))
        }
    }
}

fn try_local_texlive_fetch(path: &str) -> Option<Vec<u8>> {
    let root = local_dir()?;
    let request = parse_local_request(path)?;
    let resolved = try_read_local_special_file(&root, &request)
        .or_else(|| resolve_local_from_index(&root, &request))?;
    std::fs::read(resolved).ok()
}

async fn fetch_upstream_bytes(safe_path: &str) -> Result<Option<Vec<u8>>, StatusCode> {
    let upstream = format!(
        "{}/{}",
        texlive_base_url().trim_end_matches('/'),
        safe_path.trim_start_matches('/')
    );
    let response = reqwest::get(upstream)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if response.status() == StatusCode::NOT_FOUND
        || response.status() == StatusCode::MOVED_PERMANENTLY
    {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    response
        .bytes()
        .await
        .map(|value| Some(value.to_vec()))
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

pub async fn latex_texlive_proxy(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    let Some(safe_path) = sanitize_texlive_path(&path) else {
        return (StatusCode::BAD_REQUEST, "invalid texlive path").into_response();
    };
    let cache_path = cache_file_path(&state, &safe_path);
    let marker_path = missing_marker_path(&cache_path);
    if marker_path.exists() {
        return StatusCode::MOVED_PERMANENTLY.into_response();
    }
    if cache_path.exists() {
        match tokio::fs::read(&cache_path).await {
            Ok(bytes) => return ok_bytes_response(&safe_path, bytes).into_response(),
            Err(_) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, "cache read failed").into_response()
            }
        }
    }

    let local_mode = LocalMode::from_env();
    let local_bytes = if local_mode == LocalMode::Off {
        None
    } else {
        try_local_texlive_fetch(&safe_path)
    };

    let bytes = if let Some(bytes) = local_bytes {
        bytes
    } else if local_mode == LocalMode::LocalOnly {
        if let Some(parent) = marker_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&marker_path, b"missing").await;
        return StatusCode::MOVED_PERMANENTLY.into_response();
    } else {
        let upstream = match fetch_upstream_bytes(&safe_path).await {
            Ok(value) => value,
            Err(StatusCode::BAD_GATEWAY) => {
                return (StatusCode::BAD_GATEWAY, "texlive upstream unavailable").into_response();
            }
            Err(_) => return (StatusCode::BAD_GATEWAY, "texlive upstream error").into_response(),
        };
        let Some(bytes) = upstream else {
            if let Some(parent) = marker_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = tokio::fs::write(&marker_path, b"missing").await;
            return StatusCode::MOVED_PERMANENTLY.into_response();
        };
        bytes
    };

    if let Some(parent) = cache_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::write(&cache_path, &bytes).await;
    let _ = tokio::fs::remove_file(&marker_path).await;
    ok_bytes_response(&safe_path, bytes).into_response()
}
