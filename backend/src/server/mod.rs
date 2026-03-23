use crate::authz::*;
use crate::git_utils::*;
use crate::object_storage::*;
use crate::realtime::ws_handler as realtime_ws_handler;
use crate::types::*;
use crate::typst_cache::typst_package_proxy;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect};
use axum::routing::{any, delete, get, get_service, patch, post, put};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use openidconnect::core::{
    CoreAuthenticationFlow, CoreClient, CoreIdTokenClaims, CoreProviderMetadata,
};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce, RedirectUrl, Scope,
    TokenResponse,
};
use rand::distr::{Alphanumeric, SampleString};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
use std::env;
use std::net::SocketAddr;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use uuid::Uuid;

const DEFAULT_ORG_ID: &str = "00000000-0000-0000-0000-000000000001";

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
    let state = AppState {
        db,
        oidc,
        storage,
        realtime_channels: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
    };
    let static_dir = env::var("WEB_STATIC_DIR").unwrap_or_else(|_| "./web-dist".to_string());
    let static_service = get_service(
        ServeDir::new(&static_dir)
            .append_index_html_on_directories(true)
            .fallback(ServeFile::new(format!("{static_dir}/index.html"))),
    );
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/auth/config", get(auth_config))
        .route("/v1/auth/local/login", post(local_login))
        .route("/v1/auth/local/register", post(local_register))
        .route("/v1/auth/oidc/login", get(oidc_login))
        .route("/v1/auth/oidc/callback", get(oidc_callback))
        .route("/v1/auth/me", get(auth_me))
        .route("/v1/auth/logout", post(auth_logout))
        .route("/v1/realtime/auth/{project_id}", get(realtime_auth))
        .route("/v1/realtime/ws/{doc_id}", get(realtime_ws_handler))
        .route(
            "/v1/profile/security/tokens",
            get(list_personal_access_tokens).post(create_personal_access_token),
        )
        .route(
            "/v1/profile/security/tokens/{token_id}",
            delete(revoke_personal_access_token),
        )
        .route(
            "/v1/security/tokens",
            get(list_personal_access_tokens).post(create_personal_access_token),
        )
        .route(
            "/v1/security/tokens/{token_id}",
            delete(revoke_personal_access_token),
        )
        .route("/v1/organizations/mine", get(list_my_organizations))
        .route("/v1/projects", get(list_projects).post(create_project))
        .route("/v1/projects/{project_id}/tree", get(get_project_tree))
        .route("/v1/projects/{project_id}/files", post(create_project_file))
        .route(
            "/v1/projects/{project_id}/files/move",
            patch(move_project_file),
        )
        .route(
            "/v1/projects/{project_id}/files/{*path}",
            delete(delete_project_file),
        )
        .route(
            "/v1/projects/{project_id}/roles",
            get(list_roles).post(upsert_role),
        )
        .route(
            "/v1/projects/{project_id}/access-users",
            get(list_project_access_users),
        )
        .route(
            "/v1/projects/{project_id}/settings",
            get(get_project_settings).put(upsert_project_settings),
        )
        .route(
            "/v1/projects/{project_id}/organization-access",
            get(list_project_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/organization-access/{org_id}",
            put(upsert_project_organization_access).delete(delete_project_organization_access),
        )
        .route(
            "/v1/projects/{project_id}/share-links",
            get(list_project_share_links).post(create_project_share_link),
        )
        .route(
            "/v1/projects/{project_id}/share-links/{share_link_id}",
            delete(revoke_project_share_link),
        )
        .route(
            "/v1/projects/{project_id}/group-roles",
            get(list_group_roles).post(upsert_group_role),
        )
        .route(
            "/v1/projects/{project_id}/group-roles/{group_name}",
            delete(delete_group_role),
        )
        .route(
            "/v1/projects/{project_id}/revisions",
            get(list_revisions).post(create_revision),
        )
        .route(
            "/v1/projects/{project_id}/revisions/{revision_id}/documents",
            get(get_revision_documents),
        )
        .route(
            "/v1/projects/{project_id}/documents",
            get(list_documents).post(create_document),
        )
        .route(
            "/v1/projects/{project_id}/documents/by-path/{path}",
            put(upsert_document_by_path),
        )
        .route(
            "/v1/projects/{project_id}/documents/{document_id}",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        .route(
            "/v1/projects/{project_id}/snapshots",
            get(list_project_snapshots).post(create_project_snapshot),
        )
        .route(
            "/v1/projects/{project_id}/snapshots/{snapshot_id}/restore",
            post(restore_project_snapshot),
        )
        .route(
            "/v1/projects/{project_id}/assets",
            get(list_project_assets).post(upload_project_asset),
        )
        .route(
            "/v1/projects/{project_id}/assets/{asset_id}",
            get(get_project_asset).delete(delete_project_asset),
        )
        .route(
            "/v1/projects/{project_id}/assets/{asset_id}/raw",
            get(get_project_asset_raw),
        )
        .route(
            "/v1/projects/{project_id}/archive",
            get(download_project_archive).patch(update_project_archived),
        )
        .route(
            "/v1/projects/{project_id}/pdf-artifacts",
            post(upload_project_pdf_artifact),
        )
        .route(
            "/v1/projects/{project_id}/pdf-artifacts/latest",
            get(download_latest_project_pdf_artifact),
        )
        .route("/v1/typst/packages/{*path}", get(typst_package_proxy))
        .route("/v1/git/status/{project_id}", get(git_status))
        .route("/v1/git/repo-link/{project_id}", get(git_repo_link))
        .route(
            "/v1/git/config/{project_id}",
            get(get_git_config).put(upsert_git_config),
        )
        .route("/v1/git/sync/pull/{project_id}", post(git_pull))
        .route("/v1/git/sync/push/{project_id}", post(git_push))
        .route("/v1/git/repo/{project_id}/{*rest}", any(git_http_backend))
        .route("/v1/share/{token}/join", post(join_project_share_link))
        .route(
            "/v1/admin/orgs/{org_id}/oidc-group-role-mappings",
            get(list_org_group_role_mappings).post(upsert_org_group_role_mapping),
        )
        .route(
            "/v1/admin/orgs/{org_id}/oidc-group-role-mappings/{group_name}",
            delete(delete_org_group_role_mapping),
        )
        .route(
            "/v1/admin/settings/auth",
            get(get_admin_auth_settings).put(upsert_admin_auth_settings),
        )
        .fallback_service(static_service)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let port = env::var("CORE_API_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("core-api listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

include!("auth.rs");
include!("projects.rs");
include!("documents.rs");
include!("git.rs");
include!("support.rs");
