use crate::types::AppState;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use std::env;
use std::path::{Path as FsPath, PathBuf};

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
    path.replace('/', "_")
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
    (StatusCode::OK, headers, bytes)
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

    let upstream = format!(
        "{}/{}",
        texlive_base_url().trim_end_matches('/'),
        safe_path.trim_start_matches('/')
    );
    let response = match reqwest::get(upstream).await {
        Ok(value) => value,
        Err(_) => return (StatusCode::BAD_GATEWAY, "texlive upstream unavailable").into_response(),
    };
    if response.status() == StatusCode::NOT_FOUND
        || response.status() == StatusCode::MOVED_PERMANENTLY
    {
        if let Some(parent) = marker_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(&marker_path, b"missing").await;
        return StatusCode::MOVED_PERMANENTLY.into_response();
    }
    if !response.status().is_success() {
        return (StatusCode::BAD_GATEWAY, "texlive upstream error").into_response();
    }
    let bytes = match response.bytes().await {
        Ok(value) => value.to_vec(),
        Err(_) => return (StatusCode::BAD_GATEWAY, "texlive upstream read failed").into_response(),
    };
    if let Some(parent) = cache_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::write(&cache_path, &bytes).await;
    let _ = tokio::fs::remove_file(&marker_path).await;
    ok_bytes_response(&safe_path, bytes).into_response()
}
