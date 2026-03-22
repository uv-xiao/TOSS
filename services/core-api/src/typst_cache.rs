use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use std::env;
use std::path::PathBuf;

fn typst_package_cache_root() -> PathBuf {
    env::var("TYPST_PACKAGE_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/typst-packages-cache"))
}

fn typst_package_base_url() -> String {
    env::var("TYPST_UNIVERSE_BASE_URL").unwrap_or_else(|_| "https://packages.typst.org".to_string())
}

fn sanitize_package_cache_path(raw: &str) -> Option<PathBuf> {
    let rel = std::path::Path::new(raw);
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
    Some(typst_package_cache_root().join(rel))
}

pub async fn typst_package_proxy(Path(path): Path<String>) -> impl IntoResponse {
    let Some(cache_path) = sanitize_package_cache_path(&path) else {
        return (StatusCode::BAD_REQUEST, "invalid package path").into_response();
    };
    if cache_path.exists() {
        match std::fs::read(&cache_path) {
            Ok(bytes) => {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "application/octet-stream")],
                    bytes,
                )
                    .into_response()
            }
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "cache read failed").into_response(),
        }
    }

    let upstream = format!(
        "{}/{}",
        typst_package_base_url().trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    let response = match reqwest::get(upstream).await {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_GATEWAY, "package upstream unavailable").into_response(),
    };
    if !response.status().is_success() {
        return (StatusCode::NOT_FOUND, "package not found").into_response();
    }
    let bytes = match response.bytes().await {
        Ok(b) => b.to_vec(),
        Err(_) => return (StatusCode::BAD_GATEWAY, "package upstream read failed").into_response(),
    };
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&cache_path, &bytes);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    )
        .into_response()
}
