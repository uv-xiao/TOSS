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

const COMPAT_L3BACKEND_PDFMODE: &[u8] =
    include_bytes!("../resources/latex_compat/l3backend-pdfmode.def");
const COMPAT_L3BACKEND_XDVIPDFMX: &[u8] =
    include_bytes!("../resources/latex_compat/l3backend-xdvipdfmx.def");

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
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    (StatusCode::OK, headers, bytes)
}

fn compat_texlive_file(path: &str) -> Option<&'static [u8]> {
    let filename = FsPath::new(path).file_name().and_then(|v| v.to_str())?;
    match filename {
        "l3backend-pdfmode.def" => Some(COMPAT_L3BACKEND_PDFMODE),
        "l3backend-xdvipdfmx.def" => Some(COMPAT_L3BACKEND_XDVIPDFMX),
        _ => None,
    }
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
    by_stem: HashMap<String, Vec<TlpdbFileCandidate>>,
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

#[derive(Clone, Debug)]
struct TlpdbRequestKey {
    engine: String,
    format: i32,
    filename: String,
    is_pk: bool,
}

fn request_key_for_tlpdb(safe_path: &str) -> Option<TlpdbRequestKey> {
    fn normalize_name(raw: &str) -> String {
        raw.trim()
            .trim_matches('[')
            .trim_matches(']')
            .trim_matches('"')
            .trim_matches('\'')
            .to_string()
    }
    let parts: Vec<&str> = safe_path.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        [engine @ ("xetex" | "pdftex"), "pk", _, filename] => Some(TlpdbRequestKey {
            engine: (*engine).to_string(),
            format: 0,
            filename: normalize_name(filename),
            is_pk: true,
        }),
        [engine @ ("xetex" | "pdftex"), format, filename] => {
            let parsed_format = format.parse::<i32>().ok()?;
            Some(TlpdbRequestKey {
                engine: (*engine).to_string(),
                format: parsed_format,
                filename: normalize_name(filename),
                is_pk: false,
            })
        }
        _ => None,
    }
}

fn parse_tlpdb_index(text: &str) -> TlpdbIndex {
    let mut index = TlpdbIndex::default();
    let mut current_package: Option<String> = None;
    let mut in_file_list = false;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("name ") {
            current_package = Some(rest.trim().to_string());
            in_file_list = false;
            continue;
        }
        if line.starts_with("runfiles ")
            || line.starts_with("docfiles ")
            || line.starts_with("srcfiles ")
            || line.starts_with("binfiles ")
        {
            in_file_list = true;
            continue;
        }
        if line.starts_with("execute ")
            || line.starts_with("depend ")
            || line.starts_with("postaction ")
            || line.starts_with("tlpsetvar ")
        {
            in_file_list = false;
            continue;
        }
        if !line.starts_with(' ') || !in_file_list {
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
        if let Some(stem) = FsPath::new(base).file_stem().and_then(|value| value.to_str()) {
            index
                .by_stem
                .entry(stem.to_string())
                .or_default()
                .push(TlpdbFileCandidate {
                    package: package.clone(),
                    rel_path: rel.to_string(),
                });
        }
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
    engine: &str,
    format: i32,
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
    } else {
        let preferred_exts: &[&str] = match (engine, format) {
            ("pdftex", 10) | ("xetex", 10) => &["fmt"],
            ("xetex", 41) => &["tec"],
            ("xetex", 47) => &["otf", "ttf"],
            _ => &[],
        };
        if !preferred_exts.is_empty() {
            let ext_filtered: Vec<&TlpdbFileCandidate> = filtered
                .iter()
                .copied()
                .filter(|value| {
                    FsPath::new(&value.rel_path)
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| preferred_exts.iter().any(|expected| e.eq_ignore_ascii_case(expected)))
                        .unwrap_or(false)
                })
                .collect();
            if !ext_filtered.is_empty() {
                filtered = ext_filtered;
            }
        }
    }

    if engine == "xetex" && format == 47 {
        let path_filtered: Vec<&TlpdbFileCandidate> = filtered
            .iter()
            .copied()
            .filter(|value| {
                let lower = value.rel_path.to_ascii_lowercase();
                lower.contains("/fonts/opentype/") || lower.contains("/fonts/truetype/")
            })
            .collect();
        if !path_filtered.is_empty() {
            filtered = path_filtered;
        }
    }
    if engine == "pdftex" && format == 33 {
        let path_filtered: Vec<&TlpdbFileCandidate> = filtered
            .iter()
            .copied()
            .filter(|value| value.rel_path.to_ascii_lowercase().contains("/fonts/vf/"))
            .collect();
        if !path_filtered.is_empty() {
            filtered = path_filtered;
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

fn rewrite_alias_backend_bytes(requested_filename: &str, bytes: Vec<u8>) -> Vec<u8> {
    let (from_name, to_name) = match requested_filename {
        "l3backend-pdfmode.def" => ("l3backend-pdftex.def", "l3backend-pdfmode.def"),
        "l3backend-xdvipdfmx.def" => ("l3backend-dvipdfmx.def", "l3backend-xdvipdfmx.def"),
        _ => ("", ""),
    };

    let mut out = bytes;
    if !from_name.is_empty() {
        let text = String::from_utf8_lossy(&out);
        if text.contains(from_name) {
            out = text.replace(from_name, to_name).into_bytes();
        }
    }

    if requested_filename.eq_ignore_ascii_case("mathcolor.ltx") {
        let text = String::from_utf8_lossy(&out);
        if text.contains("\\DeclareDocumentCommand") {
            return br#"% typst mathcolor compatibility shim
\ProvidesFile{mathcolor.ltx}[2026/04/04 typst compatibility shim]
\providecommand\mathcolor[3][]{\begingroup\color{#2}#3\endgroup}
\endinput
"#
            .to_vec();
        }
    }

    out
}

fn texlive_filename_alias(
    requested_filename: &str,
    engine: Option<&str>,
) -> Option<&'static str> {
    match requested_filename {
        "dviout.def" => match engine.map(|value| value.to_ascii_lowercase()) {
            Some(value) if value == "xetex" => Some("xetex.def"),
            Some(value) if value == "pdftex" => Some("pdftex.def"),
            _ => None,
        },
        "l3backend-pdfmode.def" => Some("l3backend-pdftex.def"),
        "l3backend-xdvipdfmx.def" => Some("l3backend-dvipdfmx.def"),
        "pgfsys-dviout.def" => match engine.map(|value| value.to_ascii_lowercase()) {
            Some(value) if value == "xetex" => Some("pgfsys-xetex.def"),
            Some(value) if value == "pdftex" => Some("pgfsys-pdftex.def"),
            _ => Some("pgfsys-dvips.def"),
        },
        _ => None,
    }
}

fn swap_safe_path_filename(safe_path: &str, replacement_filename: &str) -> Option<String> {
    let mut parts: Vec<&str> = safe_path.split('/').filter(|segment| !segment.is_empty()).collect();
    if parts.len() < 3 {
        return None;
    }
    parts.pop();
    parts.push(replacement_filename);
    Some(parts.join("/"))
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
    let Some(req) = request_key_for_tlpdb(safe_path) else {
        return Ok(None);
    };
    let filename = req.filename.as_str();
    let index = load_tlpdb_index(base).await?;
    let alias = texlive_filename_alias(filename, Some(req.engine.as_str()));
    let preferred_lookup_name = if filename.eq_ignore_ascii_case("dviout.def") {
        alias.unwrap_or(filename)
    } else {
        filename
    };
    let requested_has_extension = FsPath::new(filename).extension().is_some();
    let candidates = if let Some(value) = index.by_basename.get(preferred_lookup_name) {
        value
    } else if let Some(alias_name) = alias {
        if let Some(value) = index.by_basename.get(alias_name) {
            value
        } else if requested_has_extension {
            return Ok(None);
        } else {
            let alias_stem = FsPath::new(alias_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(alias_name);
            let Some(value) = index.by_stem.get(alias_stem) else {
                return Ok(None);
            };
            value
        }
    } else if requested_has_extension {
        return Ok(None);
    } else {
        let stem = FsPath::new(&filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(&filename);
        let Some(value) = index.by_stem.get(stem) else {
            return Ok(None);
        };
        value
    };
    let Some(candidate) =
        choose_candidate_for_request(candidates, req.is_pk, &req.engine, req.format, filename)
    else {
        return Ok(None);
    };

    let normalized_rel_path = normalize_tlpdb_rel_path(&candidate.rel_path);
    let local_extracted = local_root(state)
        .join("ctan-files")
        .join(normalized_rel_path.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
    if local_extracted.exists() {
        return tokio::fs::read(local_extracted)
            .await
            .map(|bytes| Some(rewrite_alias_backend_bytes(filename, bytes)))
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
    Ok(Some(rewrite_alias_backend_bytes(filename, file_bytes)))
}

pub async fn latex_texlive_proxy(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    let Some(safe_path) = sanitize_texlive_path(&path) else {
        return (StatusCode::BAD_REQUEST, "invalid texlive path").into_response();
    };
    let request_key = request_key_for_tlpdb(&safe_path);

    ensure_bootstrap_files(&state).await;
    let root = local_root(&state);
    let _ = tokio::fs::create_dir_all(&root).await;

    if let Some(file) = bootstrap_target_file(&safe_path) {
        let full = root.join(file);
        if let Ok(bytes) = tokio::fs::read(full).await {
            return ok_bytes_response(&safe_path, bytes).into_response();
        }
    }
    if let Some(bytes) = compat_texlive_file(&safe_path) {
        return ok_bytes_response(&safe_path, bytes.to_vec()).into_response();
    }

    let cache_path = cache_file_path(&state, &safe_path);
    let marker_path = missing_marker_path(&cache_path);
    let base_url = texlive_base_url();
    if marker_path.exists() && base_url.is_none() {
        return StatusCode::MOVED_PERMANENTLY.into_response();
    }
    if cache_path.exists() {
        match tokio::fs::read(&cache_path).await {
            Ok(bytes) => {
                let invalid_cached_vf = request_key
                    .as_ref()
                    .map(|key| {
                        key.engine == "pdftex"
                            && key.format == 33
                            && key.filename.eq_ignore_ascii_case("cmr10.vf")
                            && bytes.first().copied() != Some(247)
                    })
                    .unwrap_or(false);
                let invalid_cached_pgf_dviout = request_key
                    .as_ref()
                    .map(|key| {
                        if key.format != 26 || !key.filename.eq_ignore_ascii_case("pgfsys-dviout.def") {
                            return false;
                        }
                        let expected = texlive_filename_alias(
                            "pgfsys-dviout.def",
                            Some(key.engine.as_str()),
                        );
                        match expected {
                            Some(name) => !String::from_utf8_lossy(&bytes).contains(name),
                            None => false,
                        }
                    })
                    .unwrap_or(false);
                let invalid_cached_dviout = request_key
                    .as_ref()
                    .map(|key| {
                        if !key.filename.eq_ignore_ascii_case("dviout.def") {
                            return false;
                        }
                        let expected =
                            texlive_filename_alias("dviout.def", Some(key.engine.as_str()));
                        match expected {
                            Some(name) => !String::from_utf8_lossy(&bytes).contains(name),
                            None => false,
                        }
                    })
                    .unwrap_or(false);
                if invalid_cached_vf {
                    warn!("ignoring incompatible cached vf for {}", safe_path);
                } else if invalid_cached_pgf_dviout {
                    warn!(
                        "ignoring stale cached pgfsys-dviout compatibility file for {}",
                        safe_path
                    );
                } else if invalid_cached_dviout {
                    warn!(
                        "ignoring stale cached dviout graphics driver for {}",
                        safe_path
                    );
                } else {
                let requested_name = FsPath::new(&safe_path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default();
                let rewritten = rewrite_alias_backend_bytes(requested_name, bytes);
                return ok_bytes_response(&safe_path, rewritten).into_response();
                }
            }
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
                if let Some(alias_name) = FsPath::new(&safe_path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .and_then(|name| {
                        texlive_filename_alias(
                            name,
                            request_key.as_ref().map(|key| key.engine.as_str()),
                        )
                    })
                {
                    if let Some(alias_safe_path) = swap_safe_path_filename(&safe_path, alias_name) {
                        match fetch_ctan_tlnet_bytes(&state, &base, &alias_safe_path).await {
                            Ok(Some(value)) => {
                                if let Some(parent) = cache_path.parent() {
                                    let _ = tokio::fs::create_dir_all(parent).await;
                                }
                                let _ = tokio::fs::write(&cache_path, &value).await;
                                let _ = tokio::fs::remove_file(&marker_path).await;
                                return ok_bytes_response(&safe_path, value).into_response();
                            }
                            Ok(None) => {}
                            Err(_) => {
                                return (StatusCode::BAD_GATEWAY, "texlive upstream unavailable").into_response();
                            }
                        }
                    }
                }
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
                if let Some(alias_name) = FsPath::new(&safe_path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .and_then(|name| {
                        texlive_filename_alias(
                            name,
                            request_key.as_ref().map(|key| key.engine.as_str()),
                        )
                    })
                {
                    if let Some(alias_safe_path) = swap_safe_path_filename(&safe_path, alias_name) {
                        let alias_upstream = format!("{}/{}", base, alias_safe_path.trim_start_matches('/'));
                        match fetch_upstream_bytes(&alias_upstream).await {
                            Ok(Some(value)) => {
                                if let Some(parent) = cache_path.parent() {
                                    let _ = tokio::fs::create_dir_all(parent).await;
                                }
                                let _ = tokio::fs::write(&cache_path, &value).await;
                                let _ = tokio::fs::remove_file(&marker_path).await;
                                return ok_bytes_response(&safe_path, value).into_response();
                            }
                            Ok(None) => {}
                            Err(_) => {
                                return (StatusCode::BAD_GATEWAY, "texlive upstream unavailable").into_response();
                            }
                        }
                    }
                }
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
