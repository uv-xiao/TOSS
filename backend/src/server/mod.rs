use crate::authz::*;
use crate::git_utils::*;
use crate::object_storage::*;
use crate::realtime::ws_handler as realtime_ws_handler;
use crate::types::*;
use crate::typst_cache::typst_package_proxy;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect};
use axum::routing::{any, delete, get, get_service, patch, post, put};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use git2::{
    Commit, IndexEntry, IndexTime, MergeFileOptions, Oid, Repository, Sort, TreeWalkMode,
    TreeWalkResult,
};
use openidconnect::core::{
    CoreAuthenticationFlow, CoreClient, CoreIdTokenClaims, CoreProviderMetadata,
};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce, RedirectUrl, Scope,
    TokenResponse,
};
use rand::distr::{Alphanumeric, SampleString};
use reqwest::redirect::Policy;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use uuid::Uuid;

mod auth;
mod documents;
mod git;
mod projects;
mod routes;
mod support;

use auth::*;
use documents::*;
use git::*;
use projects::*;
use support::*;

pub async fn run() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "core_api=info,tower_http=info".into()),
        )
        .init();

    let database_url = env::var("DATABASE_URL").expect("DATABASE_URL missing");
    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .expect("failed to connect postgres");

    run_migrations(&db).await;
    seed_default_data(&db).await;

    let oidc = OidcSettings {
        issuer: env::var("OIDC_ISSUER").unwrap_or_else(|_| "".to_string()),
        client_id: env::var("OIDC_CLIENT_ID").unwrap_or_else(|_| "".to_string()),
        client_secret: env::var("OIDC_CLIENT_SECRET").unwrap_or_else(|_| "".to_string()),
        redirect_uri: env::var("OIDC_REDIRECT_URI").unwrap_or_else(|_| "".to_string()),
        groups_claim: env::var("OIDC_GROUPS_CLAIM").unwrap_or_else(|_| "groups".to_string()),
    };

    let storage = init_object_storage_from_env().await;
    let data_dir = env::var("DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./tmp/data"));
    std::fs::create_dir_all(&data_dir).expect("failed to create DATA_DIR");
    std::fs::create_dir_all(data_dir.join("git")).expect("failed to create DATA_DIR/git");
    std::fs::create_dir_all(data_dir.join("thumbnails"))
        .expect("failed to create DATA_DIR/thumbnails");
    let max_request_body_bytes = env::var("MAX_REQUEST_BODY_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1024 * 1024)
        .unwrap_or(64 * 1024 * 1024);
    let state = AppState {
        db,
        oidc,
        data_dir,
        storage,
        realtime_channels: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
        git_project_locks: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
    };
    spawn_git_flush_worker(state.clone());
    let static_dir = env::var("WEB_STATIC_DIR").unwrap_or_else(|_| "./web-dist".to_string());
    let static_service = get_service(
        ServeDir::new(&static_dir)
            .append_index_html_on_directories(true)
            .fallback(ServeFile::new(format!("{static_dir}/index.html"))),
    );
    let app = routes::build_router()
        .layer(DefaultBodyLimit::max(max_request_body_bytes))
        .fallback_service(static_service)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = env::var("CORE_API_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("core-api listening on {}", addr);
    info!("max request body bytes: {}", max_request_body_bytes);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
