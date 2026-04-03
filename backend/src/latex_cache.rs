use crate::types::AppState;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use std::env;
use std::path::{Path as FsPath, PathBuf};
use std::sync::OnceLock;

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

async fn fetch_upstream_bytes(url: &str) -> Result<Option<Vec<u8>>, StatusCode> {
    let response = reqwest::get(url).await.map_err(|_| StatusCode::BAD_GATEWAY)?;
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
    if marker_path.exists() {
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

    let Some(base) = texlive_base_url() else {
        if let Some(parent) = marker_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&marker_path, b"missing").await;
        return StatusCode::MOVED_PERMANENTLY.into_response();
    };

    let upstream = format!("{}/{}", base, safe_path.trim_start_matches('/'));
    let bytes = match fetch_upstream_bytes(&upstream).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            if let Some(parent) = marker_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = tokio::fs::write(&marker_path, b"missing").await;
            return StatusCode::MOVED_PERMANENTLY.into_response();
        }
        Err(_) => return (StatusCode::BAD_GATEWAY, "texlive upstream unavailable").into_response(),
    };

    if let Some(parent) = cache_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::write(&cache_path, &bytes).await;
    let _ = tokio::fs::remove_file(&marker_path).await;
    ok_bytes_response(&safe_path, bytes).into_response()
}
