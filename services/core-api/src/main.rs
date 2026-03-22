use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect};
use axum::routing::{any, delete, get, post, put};
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
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use uuid::Uuid;
mod types;
mod authz;
mod git_utils;
mod object_storage;
use authz::*;
use git_utils::*;
use object_storage::*;
use types::*;

#[tokio::main]
async fn main() {
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
    let state = AppState { db, oidc, storage };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/auth/config", get(auth_config))
        .route("/v1/auth/oidc/login", get(oidc_login))
        .route("/v1/auth/oidc/callback", get(oidc_callback))
        .route("/v1/auth/me", get(auth_me))
        .route("/v1/auth/logout", post(auth_logout))
        .route("/v1/realtime/auth/{project_id}", get(realtime_auth))
        .route("/v1/security/tokens", get(list_personal_access_tokens).post(create_personal_access_token))
        .route("/v1/security/tokens/{token_id}", delete(revoke_personal_access_token))
        .route("/v1/projects", get(list_projects).post(create_project))
        .route("/v1/projects/{project_id}/roles", get(list_roles).post(upsert_role))
        .route(
            "/v1/projects/{project_id}/group-roles",
            get(list_group_roles).post(upsert_group_role),
        )
        .route(
            "/v1/projects/{project_id}/group-roles/{group_name}",
            delete(delete_group_role),
        )
        .route("/v1/projects/{project_id}/comments", get(list_comments).post(create_comment))
        .route("/v1/projects/{project_id}/revisions", get(list_revisions).post(create_revision))
        .route("/v1/projects/{project_id}/documents", get(list_documents).post(create_document))
        .route(
            "/v1/projects/{project_id}/documents/by-path/{path}",
            put(upsert_document_by_path),
        )
        .route(
            "/v1/projects/{project_id}/documents/{document_id}",
            get(get_document).put(update_document).delete(delete_document),
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
        .route("/v1/git/status/{project_id}", get(git_status))
        .route("/v1/git/repo-link/{project_id}", get(git_repo_link))
        .route("/v1/git/config/{project_id}", get(get_git_config).put(upsert_git_config))
        .route("/v1/git/sync/pull/{project_id}", post(git_pull))
        .route("/v1/git/sync/push/{project_id}", post(git_push))
        .route("/v1/git/repo/{project_id}/{*rest}", any(git_http_backend))
        .layer(CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any))
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

async fn run_migrations(pool: &PgPool) {
    if let Err(err) = sqlx::migrate!("./migrations").run(pool).await {
        error!("migration failed: {}", err);
        panic!("migration failed");
    }
}

async fn seed_default_data(pool: &PgPool) {
    let org_id = Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
    let project_id = Uuid::parse_str("00000000-0000-0000-0000-000000000010").unwrap();
    let teacher_id = Uuid::parse_str("00000000-0000-0000-0000-000000000100").unwrap();
    let student_id = Uuid::parse_str("00000000-0000-0000-0000-000000000101").unwrap();
    let now = Utc::now();

    let _ = sqlx::query(
        "insert into organizations (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing",
    )
    .bind(org_id)
    .bind("Default School")
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query(
        "insert into users (id, email, display_name, created_at) values ($1, $2, $3, $4) on conflict (id) do nothing",
    )
    .bind(teacher_id)
    .bind("teacher@example.edu")
    .bind("Teacher")
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query(
        "insert into users (id, email, display_name, created_at) values ($1, $2, $3, $4) on conflict (id) do nothing",
    )
    .bind(student_id)
    .bind("student@example.edu")
    .bind("Student A")
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query("insert into projects (id, organization_id, name, description, created_at) values ($1, $2, $3, $4, $5) on conflict (id) do nothing")
        .bind(project_id)
        .bind(org_id)
        .bind("Demo Project")
        .bind(Some("Realtime Typst project"))
        .bind(now)
        .execute(pool)
        .await;

    let _ = sqlx::query("insert into project_roles (project_id, user_id, role, granted_at) values ($1, $2, $3, $4) on conflict (project_id, user_id) do update set role = excluded.role")
        .bind(project_id)
        .bind(teacher_id)
        .bind("Teacher")
        .bind(now)
        .execute(pool)
        .await;

    let _ = sqlx::query("insert into project_roles (project_id, user_id, role, granted_at) values ($1, $2, $3, $4) on conflict (project_id, user_id) do update set role = excluded.role")
        .bind(project_id)
        .bind(student_id)
        .bind("Student")
        .bind(now)
        .execute(pool)
        .await;

    let _ = sqlx::query("insert into git_sync_states (project_id, branch, has_conflicts, status) values ($1, $2, $3, $4) on conflict (project_id) do nothing")
        .bind(project_id)
        .bind("main")
        .bind(false)
        .bind("clean")
        .execute(pool)
        .await;

    let _ = sqlx::query(
        "insert into git_repositories (project_id, remote_url, local_path, default_branch, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id) do nothing",
    )
    .bind(project_id)
    .bind(Option::<String>::None)
    .bind(project_git_repo_path(project_id).to_string_lossy().to_string())
    .bind("main")
    .bind(now)
    .execute(pool)
    .await;

    let _ = sqlx::query("insert into documents (id, project_id, path, content, updated_at) values ($1, $2, $3, $4, $5) on conflict (project_id, path) do nothing")
        .bind(Uuid::parse_str("00000000-0000-0000-0000-000000000201").unwrap())
        .bind(project_id)
        .bind("main.typ")
        .bind("= Demo Document\n\nHello from Typst School.\n")
        .bind(now)
        .execute(pool)
        .await;
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "core-api",
    })
}

async fn auth_config(State(state): State<AppState>) -> Json<AuthConfigResponse> {
    Json(AuthConfigResponse {
        issuer: state.oidc.issuer,
        client_id: state.oidc.client_id,
        redirect_uri: state.oidc.redirect_uri,
        groups_claim: state.oidc.groups_claim,
    })
}

async fn oidc_login(State(state): State<AppState>) -> axum::response::Response {
    let issuer = match IssuerUrl::new(state.oidc.issuer.clone()) {
        Ok(i) => i,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid OIDC issuer").into_response(),
    };
    let http_client = match reqwest::Client::builder().redirect(Policy::none()).build() {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_GATEWAY, "OIDC HTTP client failure").into_response(),
    };
    let provider_metadata = match CoreProviderMetadata::discover_async(issuer, &http_client).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_GATEWAY, "OIDC discovery failed").into_response(),
    };
    let redirect_uri = match RedirectUrl::new(state.oidc.redirect_uri.clone()) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid redirect URI").into_response(),
    };
    let client = CoreClient::from_provider_metadata(
        provider_metadata,
        ClientId::new(state.oidc.client_id.clone()),
        Some(ClientSecret::new(state.oidc.client_secret.clone())),
    )
    .set_redirect_uri(redirect_uri);

    if state.oidc.client_id.is_empty() {
        return (StatusCode::BAD_GATEWAY, "OIDC discovery failed").into_response();
    }
    let state_token = random_token(32);
    let nonce_token = random_token(32);
    let now = Utc::now();
    let _ = sqlx::query(
        "insert into oidc_states (state, nonce, created_at) values ($1, $2, $3)
         on conflict (state) do update set nonce = excluded.nonce, created_at = excluded.created_at",
    )
    .bind(&state_token)
    .bind(&nonce_token)
    .bind(now)
    .execute(&state.db)
    .await;

    let (authorize_url, csrf, _nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            move || CsrfToken::new(state_token.clone()),
            move || Nonce::new(nonce_token.clone()),
        )
        .add_scope(Scope::new("openid".to_string()))
        .add_scope(Scope::new("profile".to_string()))
        .add_scope(Scope::new("email".to_string()))
        .url();
    let cookie = Cookie::build(("typst_oidc_state", csrf.secret().to_string()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .build();
    let mut jar = CookieJar::new();
    jar = jar.add(cookie);
    (jar, Redirect::to(authorize_url.as_ref())).into_response()
}

async fn oidc_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(query): Query<OidcCallbackQuery>,
) -> axum::response::Response {
    let callback_state = query.state.clone().unwrap_or_default();
    let cookie_state = jar
        .get("typst_oidc_state")
        .map(|c| c.value().to_string())
        .unwrap_or_default();
    if callback_state.is_empty() || callback_state != cookie_state {
        return (StatusCode::UNAUTHORIZED, "Invalid OIDC state").into_response();
    }

    let row = sqlx::query("select nonce from oidc_states where state = $1")
        .bind(&callback_state)
        .fetch_optional(&state.db)
        .await;
    let nonce = match row {
        Ok(Some(r)) => r.get::<String, _>("nonce"),
        _ => return (StatusCode::UNAUTHORIZED, "OIDC state not found").into_response(),
    };

    let issuer = match IssuerUrl::new(state.oidc.issuer.clone()) {
        Ok(i) => i,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid OIDC issuer").into_response(),
    };
    let http_client = match reqwest::Client::builder().redirect(Policy::none()).build() {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_GATEWAY, "OIDC HTTP client failure").into_response(),
    };
    let provider_metadata = match CoreProviderMetadata::discover_async(issuer, &http_client).await {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_GATEWAY, "OIDC provider unavailable").into_response(),
    };
    let redirect_uri = match RedirectUrl::new(state.oidc.redirect_uri.clone()) {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid redirect URI").into_response(),
    };
    let client = CoreClient::from_provider_metadata(
        provider_metadata,
        ClientId::new(state.oidc.client_id.clone()),
        Some(ClientSecret::new(state.oidc.client_secret.clone())),
    )
    .set_redirect_uri(redirect_uri);
    if state.oidc.client_id.is_empty() {
        return (StatusCode::BAD_GATEWAY, "OIDC provider unavailable").into_response();
    };
    let token_result = match client.exchange_code(AuthorizationCode::new(query.code.clone())) {
        Ok(token_request) => token_request.request_async(&http_client).await,
        Err(_) => return (StatusCode::UNAUTHORIZED, "Invalid authorization code").into_response(),
    };
    let tokens = match token_result {
        Ok(t) => t,
        Err(_) => return (StatusCode::UNAUTHORIZED, "OIDC token exchange failed").into_response(),
    };
    let id_token = match tokens.id_token() {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, "OIDC id_token missing").into_response(),
    };
    let id_token_verifier = client.id_token_verifier();
    let claims: CoreIdTokenClaims = match id_token.claims(&id_token_verifier, &Nonce::new(nonce)) {
        Ok(c) => c.clone(),
        Err(_) => return (StatusCode::UNAUTHORIZED, "OIDC id_token verification failed").into_response(),
    };
    let issuer = claims.issuer().url().to_string();
    let subject = claims.subject().as_str().to_string();
    let email = if let Some(e) = claims.email() {
        e.to_string()
    } else {
        format!("{}@oidc.local", subject)
    };
    let display_name = if let Some(username) = claims.preferred_username() {
        username.to_string()
    } else {
        "OIDC User".to_string()
    };
    let oidc_groups = extract_groups_from_id_token(id_token.to_string(), &state.oidc.groups_claim);

    let user_row = sqlx::query(
        "insert into users (id, email, display_name, created_at, oidc_subject, oidc_issuer)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (oidc_subject) do update set email = excluded.email, display_name = excluded.display_name, oidc_issuer = excluded.oidc_issuer
         returning id",
    )
    .bind(Uuid::new_v4())
    .bind(email.clone())
    .bind(display_name.clone())
    .bind(Utc::now())
    .bind(subject)
    .bind(issuer)
    .fetch_one(&state.db)
    .await;
    let user_id = match user_row {
        Ok(r) => r.get::<Uuid, _>("id"),
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to upsert user").into_response(),
    };
    let _ = sync_user_oidc_groups(&state.db, user_id, &oidc_groups).await;
    let _ = apply_project_group_roles(&state.db, user_id, &oidc_groups).await;

    let token = random_token(48);
    let issued_at = Utc::now();
    let expires_at = issued_at + chrono::Duration::hours(12);
    let _ = sqlx::query(
        "insert into auth_sessions (session_token, user_id, issued_at, expires_at, user_agent, ip_address)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&token)
    .bind(user_id)
    .bind(issued_at)
    .bind(expires_at)
    .bind(
        headers
            .get(header::USER_AGENT)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("unknown"),
    )
    .bind(
        headers
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("unknown"),
    )
    .execute(&state.db)
    .await;

    let _ = sqlx::query("delete from oidc_states where state = $1")
        .bind(&callback_state)
        .execute(&state.db)
        .await;

    let source = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("unknown");

    write_audit(
        &state.db,
        Some(user_id),
        "auth.oidc.callback",
        serde_json::json!({"state": query.state, "source": source, "email": email, "groups": oidc_groups}),
    )
    .await;

    let session_cookie = Cookie::build(("typst_session", token.clone()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .build();
    let mut jar = jar.remove(Cookie::from("typst_oidc_state"));
    jar = jar.add(session_cookie);
    (jar, Json(SessionResponse { session_token: token, user_id })).into_response()
}

async fn auth_me(State(state): State<AppState>, jar: CookieJar) -> impl IntoResponse {
    let Some(token) = jar.get("typst_session").map(|c| c.value().to_string()) else {
        return (StatusCode::UNAUTHORIZED, "No session").into_response();
    };
    let row = sqlx::query(
        "select u.id, u.email, u.display_name, s.expires_at
         from auth_sessions s
         join users u on u.id = s.user_id
         where s.session_token = $1 and s.expires_at > now()",
    )
    .bind(token)
    .fetch_optional(&state.db)
    .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::UNAUTHORIZED, "Session expired").into_response();
    };
    Json(AuthMeResponse {
        user_id: row.get("id"),
        email: row.get("email"),
        display_name: row.get("display_name"),
        session_expires_at: row.get("expires_at"),
    })
    .into_response()
}

async fn auth_logout(State(state): State<AppState>, jar: CookieJar) -> impl IntoResponse {
    if let Some(token) = jar.get("typst_session").map(|c| c.value().to_string()) {
        let _ = sqlx::query("delete from auth_sessions where session_token = $1")
            .bind(token)
            .execute(&state.db)
            .await;
    }
    let jar = jar.remove(Cookie::from("typst_session"));
    (jar, StatusCode::NO_CONTENT).into_response()
}

async fn realtime_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RealtimeAuthResponse>, StatusCode> {
    let user_id = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    Ok(Json(RealtimeAuthResponse { user_id }))
}

async fn list_personal_access_tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
) -> Result<Json<PersonalAccessTokenListResponse>, StatusCode> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let rows = sqlx::query(
        "select id, label, token_prefix, created_at, expires_at, last_used_at, revoked_at
         from personal_access_tokens
         where user_id = $1
         order by created_at desc",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let tokens = rows
        .into_iter()
        .map(|r| PersonalAccessTokenInfo {
            id: r.get("id"),
            label: r.get("label"),
            token_prefix: r.get("token_prefix"),
            created_at: r.get("created_at"),
            expires_at: r.get("expires_at"),
            last_used_at: r.get("last_used_at"),
            revoked_at: r.get("revoked_at"),
        })
        .collect();
    Ok(Json(PersonalAccessTokenListResponse { tokens }))
}

async fn create_personal_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(input): Json<CreatePatInput>,
) -> Result<Json<CreatePatResponse>, StatusCode> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let label = input.label.trim();
    if label.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let expires_at = if let Some(raw) = input.expires_at {
        Some(
            DateTime::parse_from_rfc3339(&raw)
                .map_err(|_| StatusCode::BAD_REQUEST)?
                .with_timezone(&Utc),
        )
    } else {
        None
    };
    let token_id = Uuid::new_v4();
    let created_at = Utc::now();
    let plain = format!("tpat_{}", random_token(40));
    let token_prefix = plain.chars().take(12).collect::<String>();
    let token_hash = token_sha256(&plain);
    sqlx::query(
        "insert into personal_access_tokens (id, user_id, label, token_prefix, token_hash, created_at, expires_at, last_used_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7, null, null)",
    )
    .bind(token_id)
    .bind(user_id)
    .bind(label)
    .bind(&token_prefix)
    .bind(token_hash)
    .bind(created_at)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(user_id),
        "security.token.create",
        serde_json::json!({"token_id": token_id, "label": label}),
    )
    .await;

    Ok(Json(CreatePatResponse {
        id: token_id,
        label: label.to_string(),
        token: plain,
        token_prefix,
        created_at,
        expires_at,
    }))
}

async fn revoke_personal_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Path(token_id): Path<Uuid>,
) -> Result<StatusCode, StatusCode> {
    let user_id = authenticated_user_id(&state.db, &headers, &jar).await?;
    let res = sqlx::query(
        "update personal_access_tokens
         set revoked_at = $3
         where id = $1 and user_id = $2 and revoked_at is null",
    )
    .bind(token_id)
    .bind(user_id)
    .bind(Utc::now())
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if res.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(user_id),
        "security.token.revoke",
        serde_json::json!({"token_id": token_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProjectListResponse>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let rows = sqlx::query(
        "select p.id, p.organization_id, p.name, p.description, p.created_at
         from projects p
         join project_roles pr on pr.project_id = p.id
         where pr.user_id = $1
         order by p.created_at desc",
    )
    .bind(actor)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let projects = rows
        .into_iter()
        .map(|r| Project {
            id: r.get("id"),
            organization_id: r.get("organization_id"),
            name: r.get("name"),
            description: r.get("description"),
            created_at: r.get("created_at"),
        })
        .collect();

    Ok(Json(ProjectListResponse { projects }))
}

async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateProjectInput>,
) -> Result<Json<Project>, StatusCode> {
    let Some(actor) = request_user_id(&state.db, &headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let id = Uuid::new_v4();
    let created_at = Utc::now();
    let row = sqlx::query(
        "insert into projects (id, organization_id, name, description, created_at) values ($1, $2, $3, $4, $5)
         returning id, organization_id, name, description, created_at",
    )
    .bind(id)
    .bind(input.organization_id)
    .bind(input.name)
    .bind(input.description)
    .bind(created_at)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let _ = sqlx::query(
        "insert into project_roles (project_id, user_id, role, granted_at) values ($1, $2, 'Owner', $3)
         on conflict (project_id, user_id) do update set role = excluded.role",
    )
    .bind(id)
    .bind(actor)
    .bind(created_at)
    .execute(&state.db)
    .await;

    let _ = sqlx::query(
        "insert into git_sync_states (project_id, branch, has_conflicts, status) values ($1, 'main', false, 'clean')
         on conflict (project_id) do nothing",
    )
    .bind(id)
    .execute(&state.db)
    .await;

    write_audit(
        &state.db,
        Some(actor),
        "project.create",
        serde_json::json!({"project_id": id, "name": row.get::<String, _>("name")}),
    )
    .await;

    Ok(Json(Project {
        id: row.get("id"),
        organization_id: row.get("organization_id"),
        name: row.get("name"),
        description: row.get("description"),
        created_at: row.get("created_at"),
    }))
}

async fn list_roles(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectRoleBinding>>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select project_id, user_id, role, granted_at from project_roles where project_id = $1 order by granted_at desc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let roles = rows
        .into_iter()
        .map(|r| ProjectRoleBinding {
            project_id: r.get("project_id"),
            user_id: r.get("user_id"),
            role: r.get("role"),
            granted_at: r.get("granted_at"),
        })
        .collect();
    Ok(Json(roles))
}

async fn upsert_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertRoleInput>,
) -> Result<Json<ProjectRoleBinding>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let granted_at = Utc::now();
    let row = sqlx::query(
        "insert into project_roles (project_id, user_id, role, granted_at) values ($1, $2, $3, $4)
         on conflict (project_id, user_id) do update set role = excluded.role, granted_at = excluded.granted_at
         returning project_id, user_id, role, granted_at",
    )
    .bind(project_id)
    .bind(input.user_id)
    .bind(input.role)
    .bind(granted_at)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "project.role.upsert",
        serde_json::json!({"project_id": project_id, "target_user_id": input.user_id, "role": row.get::<String, _>("role")}),
    )
    .await;

    Ok(Json(ProjectRoleBinding {
        project_id: row.get("project_id"),
        user_id: row.get("user_id"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    }))
}

async fn list_group_roles(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Vec<ProjectGroupRoleBinding>>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select project_id, group_name, role, granted_at
         from project_group_roles
         where project_id = $1
         order by group_name asc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let roles = rows
        .into_iter()
        .map(|r| ProjectGroupRoleBinding {
            project_id: r.get("project_id"),
            group_name: r.get("group_name"),
            role: r.get("role"),
            granted_at: r.get("granted_at"),
        })
        .collect();
    Ok(Json(roles))
}

async fn upsert_group_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertProjectGroupRoleInput>,
) -> Result<Json<ProjectGroupRoleBinding>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    if ProjectRole::from_db(&input.role).is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let group_name = input.group_name.trim().to_string();
    if group_name.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let granted_at = Utc::now();
    let row = sqlx::query(
        "insert into project_group_roles (project_id, group_name, role, granted_at)
         values ($1, $2, $3, $4)
         on conflict (project_id, group_name) do update
         set role = excluded.role, granted_at = excluded.granted_at
         returning project_id, group_name, role, granted_at",
    )
    .bind(project_id)
    .bind(&group_name)
    .bind(&input.role)
    .bind(granted_at)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    write_audit(
        &state.db,
        Some(actor),
        "project.group_role.upsert",
        serde_json::json!({"project_id": project_id, "group_name": group_name, "role": input.role}),
    )
    .await;
    Ok(Json(ProjectGroupRoleBinding {
        project_id: row.get("project_id"),
        group_name: row.get("group_name"),
        role: row.get("role"),
        granted_at: row.get("granted_at"),
    }))
}

async fn delete_group_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, group_name)): Path<(Uuid, String)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let result = sqlx::query(
        "delete from project_group_roles where project_id = $1 and group_name = $2",
    )
    .bind(project_id)
    .bind(group_name.clone())
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.group_role.delete",
        serde_json::json!({"project_id": project_id, "group_name": group_name}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_comments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<CommentsResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select id, project_id, actor_user_id, body, anchor, created_at
         from comments where project_id = $1 order by created_at desc limit 200",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let comments = rows
        .into_iter()
        .map(|r| Comment {
            id: r.get("id"),
            project_id: r.get("project_id"),
            actor_user_id: r.get("actor_user_id"),
            body: r.get("body"),
            anchor: r.get("anchor"),
            created_at: r.get("created_at"),
        })
        .collect();

    Ok(Json(CommentsResponse { comments }))
}

async fn create_comment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateCommentInput>,
) -> Result<Json<Comment>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let now = Utc::now();
    let id = Uuid::new_v4();
    let row = sqlx::query(
        "insert into comments (id, project_id, actor_user_id, body, anchor, created_at)
         values ($1, $2, $3, $4, $5, $6)
         returning id, project_id, actor_user_id, body, anchor, created_at",
    )
    .bind(id)
    .bind(project_id)
    .bind(actor)
    .bind(input.body)
    .bind(input.anchor)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "comment.create",
        serde_json::json!({"project_id": project_id, "comment_id": id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Comment {
        id: row.get("id"),
        project_id: row.get("project_id"),
        actor_user_id: row.get("actor_user_id"),
        body: row.get("body"),
        anchor: row.get("anchor"),
        created_at: row.get("created_at"),
    }))
}

async fn list_revisions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<RevisionsResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select id, project_id, actor_user_id, summary, created_at
         from revisions where project_id = $1 order by created_at desc limit 200",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let revisions = rows
        .into_iter()
        .map(|r| Revision {
            id: r.get("id"),
            project_id: r.get("project_id"),
            actor_user_id: r.get("actor_user_id"),
            summary: r.get("summary"),
            created_at: r.get("created_at"),
        })
        .collect();

    Ok(Json(RevisionsResponse { revisions }))
}

async fn create_revision(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateRevisionInput>,
) -> Result<Json<Revision>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let now = Utc::now();
    let id = Uuid::new_v4();
    let row = sqlx::query(
        "insert into revisions (id, project_id, actor_user_id, summary, created_at)
         values ($1, $2, $3, $4, $5)
         returning id, project_id, actor_user_id, summary, created_at",
    )
    .bind(id)
    .bind(project_id)
    .bind(actor)
    .bind(input.summary)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "revision.create",
        serde_json::json!({"project_id": project_id, "revision_id": id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Revision {
        id: row.get("id"),
        project_id: row.get("project_id"),
        actor_user_id: row.get("actor_user_id"),
        summary: row.get("summary"),
        created_at: row.get("created_at"),
    }))
}

async fn list_documents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ListDocumentsQuery>,
) -> Result<Json<DocumentsResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = if let Some(path) = query.path {
        sqlx::query(
            "select id, project_id, path, content, updated_at
             from documents where project_id = $1 and path = $2 order by updated_at desc",
        )
        .bind(project_id)
        .bind(path)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    } else {
        sqlx::query(
            "select id, project_id, path, content, updated_at
             from documents where project_id = $1 order by updated_at desc limit 500",
        )
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };

    let documents = rows
        .into_iter()
        .map(|r| Document {
            id: r.get("id"),
            project_id: r.get("project_id"),
            path: r.get("path"),
            content: r.get("content"),
            updated_at: r.get("updated_at"),
        })
        .collect();

    Ok(Json(DocumentsResponse { documents }))
}

async fn create_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateDocumentInput>,
) -> Result<Json<Document>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let now = Utc::now();
    let id = Uuid::new_v4();
    let row = sqlx::query(
        "insert into documents (id, project_id, path, content, updated_at)
         values ($1, $2, $3, $4, $5)
         returning id, project_id, path, content, updated_at",
    )
    .bind(id)
    .bind(project_id)
    .bind(input.path)
    .bind(input.content)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::CONFLICT)?;

    write_audit(
        &state.db,
        Some(actor),
        "document.create",
        serde_json::json!({"project_id": project_id, "document_id": id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Document {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        content: row.get("content"),
        updated_at: row.get("updated_at"),
    }))
}

async fn upsert_document_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, path)): Path<(Uuid, String)>,
    Json(input): Json<UpsertDocumentByPathInput>,
) -> Result<Json<Document>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let now = Utc::now();
    let doc_id = Uuid::new_v4();
    let row = sqlx::query(
        "insert into documents (id, project_id, path, content, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, path) do update set content = excluded.content, updated_at = excluded.updated_at
         returning id, project_id, path, content, updated_at",
    )
    .bind(doc_id)
    .bind(project_id)
    .bind(path)
    .bind(input.content)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "document.upsert_by_path",
        serde_json::json!({"project_id": project_id, "document_id": row.get::<Uuid, _>("id"), "path": row.get::<String, _>("path")}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Document {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        content: row.get("content"),
        updated_at: row.get("updated_at"),
    }))
}

async fn get_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Document>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let row = sqlx::query(
        "select id, project_id, path, content, updated_at from documents where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(document_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };

    Ok(Json(Document {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        content: row.get("content"),
        updated_at: row.get("updated_at"),
    }))
}

async fn update_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateDocumentInput>,
) -> Result<Json<Document>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let now = Utc::now();
    let row = sqlx::query(
        "update documents set content = $3, updated_at = $4 where project_id = $1 and id = $2
         returning id, project_id, path, content, updated_at",
    )
    .bind(project_id)
    .bind(document_id)
    .bind(input.content)
    .bind(now)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };

    write_audit(
        &state.db,
        Some(actor),
        "document.update",
        serde_json::json!({"project_id": project_id, "document_id": document_id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(Json(Document {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        content: row.get("content"),
        updated_at: row.get("updated_at"),
    }))
}

async fn delete_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, document_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let result = sqlx::query("delete from documents where project_id = $1 and id = $2")
        .bind(project_id)
        .bind(document_id)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }

    write_audit(
        &state.db,
        Some(actor),
        "document.delete",
        serde_json::json!({"project_id": project_id, "document_id": document_id}),
    )
    .await;
    mark_project_dirty(&state.db, project_id, Some(actor)).await;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, Deserialize)]
struct SnapshotDocumentPayload {
    path: String,
    content: String,
}

#[derive(Serialize, Deserialize)]
struct SnapshotPayload {
    project_id: Uuid,
    created_at: DateTime<Utc>,
    documents: Vec<SnapshotDocumentPayload>,
}

async fn list_project_snapshots(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectSnapshotListResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select id, project_id, object_key, created_by, created_at, document_count, byte_size
         from project_snapshots
         where project_id = $1
         order by created_at desc
         limit 200",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let snapshots = rows
        .into_iter()
        .map(|row| ProjectSnapshot {
            id: row.get("id"),
            project_id: row.get("project_id"),
            object_key: row.get("object_key"),
            created_by: row.get("created_by"),
            created_at: row.get("created_at"),
            document_count: row.get("document_count"),
            byte_size: row.get("byte_size"),
        })
        .collect();
    Ok(Json(ProjectSnapshotListResponse { snapshots }))
}

async fn create_project_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectSnapshot>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let Some(storage) = state.storage.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let rows = sqlx::query("select path, content from documents where project_id = $1 order by path asc")
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let documents = rows
        .iter()
        .map(|row| SnapshotDocumentPayload {
            path: row.get("path"),
            content: row.get("content"),
        })
        .collect::<Vec<_>>();
    let snapshot_payload = SnapshotPayload {
        project_id,
        created_at: Utc::now(),
        documents,
    };
    let bytes = serde_json::to_vec(&snapshot_payload).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let snapshot_id = Uuid::new_v4();
    let object_key = format!("projects/{project_id}/snapshots/{snapshot_id}.json");
    put_object(&storage, &object_key, "application/json", bytes.clone())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query(
        "insert into project_snapshots (id, project_id, object_key, created_by, created_at, document_count, byte_size)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, project_id, object_key, created_by, created_at, document_count, byte_size",
    )
    .bind(snapshot_id)
    .bind(project_id)
    .bind(object_key)
    .bind(actor)
    .bind(Utc::now())
    .bind(snapshot_payload.documents.len() as i32)
    .bind(bytes.len() as i64)
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    write_audit(
        &state.db,
        Some(actor),
        "project.snapshot.create",
        serde_json::json!({"project_id": project_id, "snapshot_id": snapshot_id}),
    )
    .await;

    Ok(Json(ProjectSnapshot {
        id: row.get("id"),
        project_id: row.get("project_id"),
        object_key: row.get("object_key"),
        created_by: row.get("created_by"),
        created_at: row.get("created_at"),
        document_count: row.get("document_count"),
        byte_size: row.get("byte_size"),
    }))
}

async fn restore_project_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, snapshot_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let Some(storage) = state.storage.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let row = sqlx::query(
        "select object_key from project_snapshots where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(snapshot_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let object_key: String = row.get("object_key");
    let bytes = get_object(&storage, &object_key)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let payload: SnapshotPayload =
        serde_json::from_slice(&bytes).map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
    if payload.project_id != project_id {
        return Err(StatusCode::CONFLICT);
    }

    let existing_rows = sqlx::query("select id, path from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut existing_map: HashMap<String, Uuid> = HashMap::new();
    for row in existing_rows {
        existing_map.insert(row.get("path"), row.get("id"));
    }
    let mut restored_paths = HashSet::new();
    for doc in payload.documents {
        restored_paths.insert(doc.path.clone());
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, $3, $4, $5)
             on conflict (project_id, path)
             do update set content = excluded.content, updated_at = excluded.updated_at",
        )
        .bind(Uuid::new_v4())
        .bind(project_id)
        .bind(doc.path)
        .bind(doc.content)
        .bind(Utc::now())
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    for (path, doc_id) in existing_map {
        if !restored_paths.contains(&path) {
            let _ = sqlx::query("delete from documents where project_id = $1 and id = $2")
                .bind(project_id)
                .bind(doc_id)
                .execute(&state.db)
                .await;
        }
    }
    mark_project_dirty(&state.db, project_id, Some(actor)).await;
    write_audit(
        &state.db,
        Some(actor),
        "project.snapshot.restore",
        serde_json::json!({"project_id": project_id, "snapshot_id": snapshot_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_project_assets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<ProjectAssetListResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let rows = sqlx::query(
        "select id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at
         from project_assets
         where project_id = $1
         order by created_at desc
         limit 500",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let assets = rows
        .into_iter()
        .map(|row| ProjectAsset {
            id: row.get("id"),
            project_id: row.get("project_id"),
            path: row.get("path"),
            object_key: row.get("object_key"),
            content_type: row.get("content_type"),
            size_bytes: row.get("size_bytes"),
            uploaded_by: row.get("uploaded_by"),
            created_at: row.get("created_at"),
        })
        .collect();
    Ok(Json(ProjectAssetListResponse { assets }))
}

async fn upload_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UploadAssetInput>,
) -> Result<Json<ProjectAsset>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let Some(storage) = state.storage.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let path = input.path.trim().to_string();
    if path.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, input.content_base64)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let content_type = input
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let asset_id = Uuid::new_v4();
    let object_key = format!("projects/{project_id}/assets/{asset_id}");
    put_object(&storage, &object_key, &content_type, bytes.clone())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query(
        "insert into project_assets (id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (project_id, path)
         do update set object_key = excluded.object_key, content_type = excluded.content_type, size_bytes = excluded.size_bytes, uploaded_by = excluded.uploaded_by, created_at = excluded.created_at
         returning id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at",
    )
    .bind(asset_id)
    .bind(project_id)
    .bind(path)
    .bind(object_key)
    .bind(content_type)
    .bind(bytes.len() as i64)
    .bind(actor)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    write_audit(
        &state.db,
        Some(actor),
        "project.asset.upload",
        serde_json::json!({"project_id": project_id, "asset_id": row.get::<Uuid, _>("id")}),
    )
    .await;
    Ok(Json(ProjectAsset {
        id: row.get("id"),
        project_id: row.get("project_id"),
        path: row.get("path"),
        object_key: row.get("object_key"),
        content_type: row.get("content_type"),
        size_bytes: row.get("size_bytes"),
        uploaded_by: row.get("uploaded_by"),
        created_at: row.get("created_at"),
    }))
}

async fn get_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, asset_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<ProjectAssetContentResponse>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let Some(storage) = state.storage.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let row = sqlx::query(
        "select id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at
         from project_assets
         where project_id = $1 and id = $2",
    )
    .bind(project_id)
    .bind(asset_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let object_key: String = row.get("object_key");
    let bytes = get_object(&storage, &object_key)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(ProjectAssetContentResponse {
        asset: ProjectAsset {
            id: row.get("id"),
            project_id: row.get("project_id"),
            path: row.get("path"),
            object_key: row.get("object_key"),
            content_type: row.get("content_type"),
            size_bytes: row.get("size_bytes"),
            uploaded_by: row.get("uploaded_by"),
            created_at: row.get("created_at"),
        },
        content_base64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            bytes,
        ),
    }))
}

async fn delete_project_asset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, asset_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Write).await?;
    let Some(storage) = state.storage.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let row = sqlx::query("select object_key from project_assets where project_id = $1 and id = $2")
        .bind(project_id)
        .bind(asset_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    let object_key: String = row.get("object_key");
    let _ = delete_object(&storage, &object_key).await;
    let result = sqlx::query("delete from project_assets where project_id = $1 and id = $2")
        .bind(project_id)
        .bind(asset_id)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if result.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    write_audit(
        &state.db,
        Some(actor),
        "project.asset.delete",
        serde_json::json!({"project_id": project_id, "asset_id": asset_id}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

async fn git_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitSyncState>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    git_status_by_project(&state.db, project_id).await
}

async fn get_git_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitRemoteConfig>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let row = sqlx::query(
        "select project_id, remote_url, local_path, default_branch from git_repositories where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };

    Ok(Json(GitRemoteConfig {
        project_id: row.get("project_id"),
        remote_url: row.get("remote_url"),
        local_path: row.get("local_path"),
        default_branch: row.get("default_branch"),
    }))
}

async fn git_repo_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
) -> Result<Json<GitRepoLink>, StatusCode> {
    ensure_project_role(&state.db, &headers, project_id, AccessNeed::Read).await?;
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1:8080");
    let scheme = if headers
        .get("x-forwarded-proto")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("http")
        == "https"
    {
        "https"
    } else {
        "http"
    };
    Ok(Json(GitRepoLink {
        project_id,
        repo_url: format!("{scheme}://{host}/v1/git/repo/{project_id}"),
    }))
}

async fn upsert_git_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpsertGitRemoteConfigInput>,
) -> Result<Json<GitRemoteConfig>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::Manage).await?;
    let default_branch = input.default_branch.unwrap_or_else(|| "main".to_string());
    let row = sqlx::query(
        "insert into git_repositories (project_id, remote_url, local_path, default_branch, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id) do update set remote_url = excluded.remote_url, default_branch = excluded.default_branch, updated_at = excluded.updated_at
         returning project_id, remote_url, local_path, default_branch",
    )
    .bind(project_id)
    .bind(input.remote_url)
    .bind(project_git_repo_path(project_id).to_string_lossy().to_string())
    .bind(default_branch)
    .bind(Utc::now())
    .fetch_one(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = sqlx::query("update git_sync_states set branch = $2 where project_id = $1")
        .bind(project_id)
        .bind(row.get::<String, _>("default_branch"))
        .execute(&state.db)
        .await;

    write_audit(
        &state.db,
        Some(actor),
        "git.config.upsert",
        serde_json::json!({"project_id": project_id}),
    )
    .await;

    Ok(Json(GitRemoteConfig {
        project_id: row.get("project_id"),
        remote_url: row.get("remote_url"),
        local_path: row.get("local_path"),
        default_branch: row.get("default_branch"),
    }))
}

async fn git_status_by_project(db: &PgPool, project_id: Uuid) -> Result<Json<GitSyncState>, StatusCode> {
    let row = sqlx::query(
        "select project_id, branch, last_pull_at, last_push_at, has_conflicts, status from git_sync_states where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    match row {
        Some(row) => Ok(Json(GitSyncState {
            project_id: row.get("project_id"),
            branch: row.get("branch"),
            last_pull_at: row.get("last_pull_at"),
            last_push_at: row.get("last_push_at"),
            has_conflicts: row.get("has_conflicts"),
            status: row.get("status"),
        })),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn git_pull(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<SyncRequest>,
) -> Result<Json<GitSyncState>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::GitSync).await?;
    let config = load_git_config(&state.db, project_id).await?;
    ensure_git_repo_initialized(&config.local_path, &config.default_branch)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(remote_url) = &config.remote_url {
        let _ = run_git(&config.local_path, &["remote", "remove", "origin"]);
        run_git(&config.local_path, &["remote", "add", "origin", remote_url])
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if let Err(err) = run_git(&config.local_path, &["fetch", "origin", &config.default_branch]) {
            update_git_sync_state(&state.db, project_id, "pull_failed", true, Some(Utc::now()), None)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            write_audit(
                &state.db,
                Some(actor),
                "git.pull.failed",
                serde_json::json!({"project_id": project_id, "error": err}),
            )
            .await;
            return Err(StatusCode::CONFLICT);
        }
        if let Err(err) = run_git(
            &config.local_path,
            &["pull", "--rebase", "origin", &config.default_branch],
        ) {
            update_git_sync_state(&state.db, project_id, "pull_conflict", true, Some(Utc::now()), None)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            write_audit(
                &state.db,
                Some(actor),
                "git.pull.conflict",
                serde_json::json!({"project_id": project_id, "error": err}),
            )
            .await;
            return Err(StatusCode::CONFLICT);
        }
        sync_repo_documents_to_project(&state.db, project_id, &config.local_path)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    } else {
        return Err(StatusCode::BAD_REQUEST);
    }

    update_git_sync_state(&state.db, project_id, "pulled", false, Some(Utc::now()), None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = create_git_bundle_artifact(&state, project_id, &config.local_path, "pull").await;

    write_audit(
        &state.db,
        input.actor_user_id.or(Some(actor)),
        "git.pull",
        serde_json::json!({ "project_id": project_id }),
    )
    .await;

    git_status_by_project(&state.db, project_id).await
}

async fn git_push(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<SyncRequest>,
) -> Result<Json<GitSyncState>, StatusCode> {
    let actor = ensure_project_role(&state.db, &headers, project_id, AccessNeed::GitSync).await?;
    let config = load_git_config(&state.db, project_id).await?;
    ensure_git_repo_initialized(&config.local_path, &config.default_branch)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sync_project_documents_to_repo(&state.db, project_id, &config.local_path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = run_git(&config.local_path, &["add", "."]);
    let _ = run_git(
        &config.local_path,
        &[
            "-c",
            "user.name=Typst School",
            "-c",
            "user.email=noreply@typst-school.local",
            "commit",
            "-m",
            "Sync from Typst collaboration workspace",
        ],
    );
    if let Some(remote_url) = &config.remote_url {
        let _ = run_git(&config.local_path, &["remote", "remove", "origin"]);
        run_git(&config.local_path, &["remote", "add", "origin", remote_url])
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if let Err(err) = run_git(
            &config.local_path,
            &["push", "origin", &format!("HEAD:{}", config.default_branch)],
        ) {
            update_git_sync_state(&state.db, project_id, "push_failed", true, None, Some(Utc::now()))
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            write_audit(
                &state.db,
                Some(actor),
                "git.push.failed",
                serde_json::json!({"project_id": project_id, "error": err}),
            )
            .await;
            return Err(StatusCode::CONFLICT);
        }
    } else {
        return Err(StatusCode::BAD_REQUEST);
    }

    update_git_sync_state(&state.db, project_id, "pushed", false, None, Some(Utc::now()))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = create_git_bundle_artifact(&state, project_id, &config.local_path, "push").await;

    write_audit(
        &state.db,
        input.actor_user_id.or(Some(actor)),
        "git.push",
        serde_json::json!({ "project_id": project_id }),
    )
    .await;

    git_status_by_project(&state.db, project_id).await
}

async fn git_http_backend(
    State(state): State<AppState>,
    headers: HeaderMap,
    method: Method,
    uri: Uri,
    Path((project_id, rest)): Path<(Uuid, String)>,
    body: Bytes,
) -> impl IntoResponse {
    let actor = match git_http_user(&state.db, &headers).await {
        Some(user_id) => user_id,
        None => {
            let mut resp = (StatusCode::UNAUTHORIZED, "Git auth required").into_response();
            resp.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                header::HeaderValue::from_static("Basic realm=\"Typst Git\""),
            );
            return resp;
        }
    };
    let can_push = rest.ends_with("git-receive-pack");
    let need = if can_push { AccessNeed::GitSync } else { AccessNeed::Read };
    if ensure_project_role_for_user(&state.db, actor, project_id, need)
        .await
        .is_err()
    {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    if flush_pending_server_commit(&state.db, project_id, None)
        .await
        .is_err()
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to flush server updates").into_response();
    }

    let Ok(config) = load_git_config(&state.db, project_id).await else {
        return (StatusCode::NOT_FOUND, "Git repository config missing").into_response();
    };
    if ensure_git_repo_initialized(&config.local_path, &config.default_branch).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to initialize repo").into_response();
    }

    let query = uri.query().unwrap_or_default();
    let path_info = if rest.is_empty() {
        format!("/{}/.git", project_id)
    } else {
        format!("/{}/.git/{}", project_id, rest)
    };
    let mut command = Command::new("git");
    command.arg("http-backend");
    command.env("GIT_PROJECT_ROOT", git_storage_root().to_string_lossy().to_string());
    command.env("GIT_HTTP_EXPORT_ALL", "1");
    command.env("REQUEST_METHOD", method.as_str());
    command.env("PATH_INFO", path_info);
    command.env("QUERY_STRING", query);
    command.env("CONTENT_TYPE", headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or(""));
    command.env("CONTENT_LENGTH", body.len().to_string());
    command.env("REMOTE_USER", actor.to_string());
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let Ok(mut child) = command.spawn() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to spawn git http-backend").into_response();
    };
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(&body);
    }
    let Ok(output) = child.wait_with_output() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "git http-backend failed").into_response();
    };

    let (status, response_headers, response_body) = parse_cgi_http_backend_output(&output.stdout);
    if can_push && status.is_success() {
        if sync_repo_documents_to_project(&state.db, project_id, &config.local_path)
            .await
            .is_ok()
        {
            let _ = sqlx::query(
                "update git_repositories set pending_sync = false, last_server_sync_at = $2 where project_id = $1",
            )
            .bind(project_id)
            .bind(Utc::now())
            .execute(&state.db)
            .await;
            let _ = sqlx::query("delete from git_pending_authors where project_id = $1")
                .bind(project_id)
                .execute(&state.db)
                .await;
            write_audit(
                &state.db,
                Some(actor),
                "git.receive_pack.accepted",
                serde_json::json!({"project_id": project_id}),
            )
            .await;
            let _ = create_git_bundle_artifact(&state, project_id, &config.local_path, "receive_pack").await;
        }
    }

    let mut builder = axum::http::Response::builder().status(status);
    for (k, v) in response_headers {
        builder = builder.header(k, v);
    }
    builder
        .body(Body::from(response_body))
        .unwrap_or_else(|_| axum::http::Response::new(Body::from("backend response error")))
}

fn extract_groups_from_id_token(raw_id_token: String, claim_name: &str) -> Vec<String> {
    let mut groups = Vec::new();
    let claims = decode_jwt_claims(&raw_id_token);
    let Some(claims) = claims else {
        return groups;
    };
    let claim_value = claims.get(claim_name);
    match claim_value {
        Some(serde_json::Value::Array(values)) => {
            for value in values {
                if let Some(group) = value.as_str() {
                    let g = group.trim();
                    if !g.is_empty() {
                        groups.push(g.to_string());
                    }
                }
            }
        }
        Some(serde_json::Value::String(group)) => {
            let g = group.trim();
            if !g.is_empty() {
                groups.push(g.to_string());
            }
        }
        _ => {}
    }
    groups.sort();
    groups.dedup();
    groups
}

fn decode_jwt_claims(raw_token: &str) -> Option<serde_json::Value> {
    let mut parts = raw_token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let bytes = base64::Engine::decode(&URL_SAFE_NO_PAD, payload).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()
}

async fn sync_user_oidc_groups(
    db: &PgPool,
    user_id: Uuid,
    groups: &[String],
) -> Result<(), sqlx::Error> {
    let now = Utc::now();
    sqlx::query("delete from user_oidc_groups where user_id = $1")
        .bind(user_id)
        .execute(db)
        .await?;
    for group_name in groups {
        sqlx::query(
            "insert into user_oidc_groups (user_id, group_name, synced_at)
             values ($1, $2, $3)",
        )
        .bind(user_id)
        .bind(group_name)
        .bind(now)
        .execute(db)
        .await?;
    }
    Ok(())
}

fn role_rank(role: &str) -> i32 {
    match role {
        "Owner" => 4,
        "Teacher" => 3,
        "TA" => 2,
        "Student" => 1,
        _ => 0,
    }
}

async fn apply_project_group_roles(
    db: &PgPool,
    user_id: Uuid,
    groups: &[String],
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query("select project_id, group_name, role from project_group_roles")
        .fetch_all(db)
        .await?;
    let group_set: HashSet<String> = groups.iter().cloned().collect();
    let mut mapped_projects: HashSet<Uuid> = HashSet::new();
    let mut desired: HashMap<Uuid, String> = HashMap::new();
    for row in rows {
        let group_name: String = row.get("group_name");
        let project_id: Uuid = row.get("project_id");
        mapped_projects.insert(project_id);
        if !group_set.contains(&group_name) {
            continue;
        }
        let role: String = row.get("role");
        let entry = desired.entry(project_id).or_insert_with(|| role.clone());
        if role_rank(&role) > role_rank(entry) {
            *entry = role;
        }
    }

    let current_rows = sqlx::query("select project_id, role from project_roles where user_id = $1")
        .bind(user_id)
        .fetch_all(db)
        .await?;
    let mut current_roles: HashMap<Uuid, String> = HashMap::new();
    for row in current_rows {
        current_roles.insert(row.get("project_id"), row.get("role"));
    }

    for project_id in mapped_projects {
        if let Some(mapped_role) = desired.get(&project_id) {
            let should_write = match current_roles.get(&project_id) {
                Some(existing_role) => existing_role != mapped_role,
                None => true,
            };
            if should_write {
                sqlx::query(
                    "insert into project_roles (project_id, user_id, role, granted_at)
                     values ($1, $2, $3, $4)
                     on conflict (project_id, user_id) do update
                     set role = excluded.role, granted_at = excluded.granted_at",
                )
                .bind(project_id)
                .bind(user_id)
                .bind(mapped_role)
                .bind(Utc::now())
                .execute(db)
                .await?;
            }
        } else {
            sqlx::query(
                "delete from project_roles
                 where project_id = $1 and user_id = $2",
            )
            .bind(project_id)
            .bind(user_id)
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

async fn write_audit(db: &PgPool, actor_user_id: Option<Uuid>, event_type: &str, payload: serde_json::Value) {
    let _ = sqlx::query(
        "insert into audit_events (id, actor_user_id, event_type, payload, created_at) values ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(actor_user_id)
    .bind(event_type)
    .bind(payload)
    .bind(Utc::now())
    .execute(db)
    .await;
}

struct LoadedGitConfig {
    remote_url: Option<String>,
    local_path: String,
    default_branch: String,
}

async fn load_git_config(db: &PgPool, project_id: Uuid) -> Result<LoadedGitConfig, StatusCode> {
    let row = sqlx::query("select remote_url, local_path, default_branch from git_repositories where project_id = $1")
        .bind(project_id)
        .fetch_optional(db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    Ok(LoadedGitConfig {
        remote_url: row.get("remote_url"),
        local_path: row.get("local_path"),
        default_branch: row.get("default_branch"),
    })
}

async fn update_git_sync_state(
    db: &PgPool,
    project_id: Uuid,
    status: &str,
    has_conflicts: bool,
    last_pull_at: Option<DateTime<Utc>>,
    last_push_at: Option<DateTime<Utc>>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update git_sync_states
         set status = $2,
             has_conflicts = $3,
             last_pull_at = coalesce($4, last_pull_at),
             last_push_at = coalesce($5, last_push_at)
         where project_id = $1",
    )
    .bind(project_id)
    .bind(status)
    .bind(has_conflicts)
    .bind(last_pull_at)
    .bind(last_push_at)
    .execute(db)
    .await?;
    Ok(())
}

async fn create_git_bundle_artifact(
    state: &AppState,
    project_id: Uuid,
    repo_path: &str,
    event_type: &str,
) -> Result<(), String> {
    let Some(storage) = state.storage.clone() else {
        return Ok(());
    };
    let temp = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let bundle_path = temp.path().to_string_lossy().to_string();
    run_git(repo_path, &["bundle", "create", &bundle_path, "--all"])?;
    let bytes = std::fs::read(&bundle_path).map_err(|e| e.to_string())?;
    let artifact_id = Uuid::new_v4();
    let object_key = format!("projects/{project_id}/git-bundles/{artifact_id}.bundle");
    put_object(&storage, &object_key, "application/x-git-bundle", bytes.clone()).await?;
    let _ = sqlx::query(
        "insert into git_bundle_artifacts (id, project_id, event_type, object_key, size_bytes, created_at)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(artifact_id)
    .bind(project_id)
    .bind(event_type)
    .bind(object_key)
    .bind(bytes.len() as i64)
    .bind(Utc::now())
    .execute(&state.db)
    .await;
    Ok(())
}

async fn sync_project_documents_to_repo(
    db: &PgPool,
    project_id: Uuid,
    repo_path: &str,
) -> Result<(), String> {
    let rows = sqlx::query("select path, content from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    for row in rows {
        let doc_path: String = row.get("path");
        let content: String = row.get("content");
        let target = sanitize_repo_relative_path(repo_path, &doc_path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn sync_repo_documents_to_project(
    db: &PgPool,
    project_id: Uuid,
    repo_path: &str,
) -> Result<(), String> {
    let repo_files = collect_repo_files(repo_path)?;
    let db_rows = sqlx::query("select id, path from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;

    let mut current: HashMap<String, Uuid> = HashMap::new();
    for row in db_rows {
        current.insert(row.get("path"), row.get("id"));
    }

    let now = Utc::now();
    let repo_paths: HashSet<String> = repo_files.keys().cloned().collect();
    for (path, content) in repo_files {
        sqlx::query(
            "insert into documents (id, project_id, path, content, updated_at)
             values ($1, $2, $3, $4, $5)
             on conflict (project_id, path) do update set content = excluded.content, updated_at = excluded.updated_at",
        )
        .bind(Uuid::new_v4())
        .bind(project_id)
        .bind(path)
        .bind(content)
        .bind(now)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    }

    for (path, doc_id) in current {
        if !repo_paths.contains(&path) {
            sqlx::query("delete from documents where project_id = $1 and id = $2")
                .bind(project_id)
                .bind(doc_id)
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn mark_project_dirty(db: &PgPool, project_id: Uuid, actor_user_id: Option<Uuid>) {
    let _ = sqlx::query(
        "insert into git_repositories (project_id, remote_url, local_path, default_branch, pending_sync, updated_at)
         values ($1, $2, $3, 'main', true, $4)
         on conflict (project_id) do update set pending_sync = true, updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(Option::<String>::None)
    .bind(project_git_repo_path(project_id).to_string_lossy().to_string())
    .bind(Utc::now())
    .execute(db)
    .await;
    if let Some(user_id) = actor_user_id {
        let _ = sqlx::query(
            "insert into git_pending_authors (project_id, user_id, touched_at)
             values ($1, $2, $3)
             on conflict (project_id, user_id) do update set touched_at = excluded.touched_at",
        )
        .bind(project_id)
        .bind(user_id)
        .bind(Utc::now())
        .execute(db)
        .await;
    }
}

async fn flush_pending_server_commit(
    db: &PgPool,
    project_id: Uuid,
    force_author: Option<Uuid>,
) -> Result<(), String> {
    let row = sqlx::query(
        "select local_path, default_branch, pending_sync from git_repositories where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(row) = row else {
        return Ok(());
    };
    let pending_sync: bool = row.get("pending_sync");
    if !pending_sync {
        return Ok(());
    }
    let local_path: String = row.get("local_path");
    let default_branch: String = row.get("default_branch");
    ensure_git_repo_initialized(&local_path, &default_branch)?;
    sync_project_documents_to_repo(db, project_id, &local_path).await?;
    let _ = run_git(&local_path, &["add", "."]);

    let clean = run_git(&local_path, &["status", "--porcelain"]).unwrap_or_default();
    if clean.trim().is_empty() {
        let _ = sqlx::query(
            "update git_repositories set pending_sync = false, last_server_sync_at = $2 where project_id = $1",
        )
        .bind(project_id)
        .bind(Utc::now())
        .execute(db)
        .await;
        let _ = sqlx::query("delete from git_pending_authors where project_id = $1")
            .bind(project_id)
            .execute(db)
            .await;
        return Ok(());
    }

    let author_rows = sqlx::query(
        "select u.display_name, u.email, u.id
         from git_pending_authors g
         join users u on u.id = g.user_id
         where g.project_id = $1
         order by g.touched_at asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;

    let mut trailers = Vec::new();
    for row in author_rows {
        let name: String = row.get("display_name");
        let email: String = row.get("email");
        trailers.push(format!("Co-authored-by: {} <{}>", name, email));
    }
    if trailers.is_empty() {
        if let Some(user_id) = force_author {
            let u = sqlx::query("select display_name, email from users where id = $1")
                .bind(user_id)
                .fetch_optional(db)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(row) = u {
                trailers.push(format!(
                    "Co-authored-by: {} <{}>",
                    row.get::<String, _>("display_name"),
                    row.get::<String, _>("email")
                ));
            }
        }
    }

    let message = if trailers.is_empty() {
        "Recent updates on Typst server".to_string()
    } else {
        format!(
            "Recent updates on Typst server\n\n{}",
            trailers.join("\n")
        )
    };
    let _ = run_git(
        &local_path,
        &[
            "-c",
            "user.name=Typst Server",
            "-c",
            "user.email=noreply@typst-server.local",
            "commit",
            "-m",
            &message,
        ],
    )?;
    let _ = sqlx::query(
        "update git_repositories set pending_sync = false, last_server_sync_at = $2 where project_id = $1",
    )
    .bind(project_id)
    .bind(Utc::now())
    .execute(db)
    .await;
    let _ = sqlx::query("delete from git_pending_authors where project_id = $1")
        .bind(project_id)
        .execute(db)
        .await;
    Ok(())
}

fn parse_cgi_http_backend_output(raw: &[u8]) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n"));
    let Some(idx) = split else {
        return (StatusCode::OK, vec![], raw.to_vec());
    };
    let (head, body) = if raw.get(idx..idx + 4) == Some(b"\r\n\r\n") {
        (&raw[..idx], raw[idx + 4..].to_vec())
    } else {
        (&raw[..idx], raw[idx + 2..].to_vec())
    };
    let mut status = StatusCode::OK;
    let mut headers = Vec::new();
    for line in String::from_utf8_lossy(head).lines() {
        if let Some(rest) = line.strip_prefix("Status:") {
            let code = rest.trim().split_whitespace().next().unwrap_or("200");
            if let Ok(c) = code.parse::<u16>() {
                status = StatusCode::from_u16(c).unwrap_or(StatusCode::OK);
            }
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    (status, headers, body)
}

async fn git_http_user(db: &PgPool, headers: &HeaderMap) -> Option<Uuid> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let basic = auth.strip_prefix("Basic ")?;
    let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, basic).ok()?;
    let creds = String::from_utf8(decoded).ok()?;
    let (_, token) = creds.split_once(':')?;
    let hash = token_sha256(token);
    let row = sqlx::query(
        "select user_id from personal_access_tokens
         where token_hash = $1
           and revoked_at is null
           and (expires_at is null or expires_at > now())",
    )
    .bind(hash)
    .fetch_optional(db)
    .await
    .ok()??;
    let user_id: Uuid = row.get("user_id");
    let _ = sqlx::query(
        "update personal_access_tokens set last_used_at = $2 where token_hash = $1",
    )
    .bind(token_sha256(token))
    .bind(Utc::now())
    .execute(db)
    .await;
    Some(user_id)
}

fn random_token(length: usize) -> String {
    Alphanumeric.sample_string(&mut rand::rng(), length)
}

fn token_sha256(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let bytes = hasher.finalize();
    bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>()
}
