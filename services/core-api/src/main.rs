use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::env;
use std::net::SocketAddr;
use std::path::{Component, Path as FsPath, PathBuf};
use std::process::Command;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{error, info};
use uuid::Uuid;

const DEFAULT_USER_ID: &str = "00000000-0000-0000-0000-000000000100";

#[derive(Clone)]
struct AppState {
    db: PgPool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
enum ProjectRole {
    Owner,
    Teacher,
    Student,
    TA,
}

impl ProjectRole {
    fn from_db(v: &str) -> Option<Self> {
        match v {
            "Owner" => Some(Self::Owner),
            "Teacher" => Some(Self::Teacher),
            "Student" => Some(Self::Student),
            "TA" => Some(Self::TA),
            _ => None,
        }
    }
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[derive(Serialize)]
struct Project {
    id: Uuid,
    organization_id: Uuid,
    name: String,
    description: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct ProjectListResponse {
    projects: Vec<Project>,
}

#[derive(Deserialize)]
struct CreateProjectInput {
    organization_id: Uuid,
    name: String,
    description: Option<String>,
}

#[derive(Serialize)]
struct ProjectRoleBinding {
    project_id: Uuid,
    user_id: Uuid,
    role: String,
    granted_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct UpsertRoleInput {
    user_id: Uuid,
    role: String,
}

#[derive(Serialize)]
struct GitSyncState {
    project_id: Uuid,
    branch: String,
    last_pull_at: Option<DateTime<Utc>>,
    last_push_at: Option<DateTime<Utc>>,
    has_conflicts: bool,
    status: String,
}

#[derive(Deserialize)]
struct SyncRequest {
    actor_user_id: Option<Uuid>,
}

#[derive(Serialize)]
struct GitRemoteConfig {
    project_id: Uuid,
    remote_url: Option<String>,
    local_path: String,
    default_branch: String,
}

#[derive(Deserialize)]
struct UpsertGitRemoteConfigInput {
    remote_url: Option<String>,
    default_branch: Option<String>,
}

#[derive(Serialize)]
struct AuthConfigResponse {
    issuer: String,
    client_id: String,
    redirect_uri: String,
    groups_claim: String,
}

#[derive(Deserialize)]
struct OidcCallbackQuery {
    code: String,
    state: Option<String>,
}

#[derive(Serialize)]
struct SessionResponse {
    session_token: String,
    user_id: Uuid,
}

#[derive(Serialize)]
struct Comment {
    id: Uuid,
    project_id: Uuid,
    actor_user_id: Option<Uuid>,
    body: String,
    anchor: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct CommentsResponse {
    comments: Vec<Comment>,
}

#[derive(Deserialize)]
struct CreateCommentInput {
    body: String,
    anchor: Option<String>,
}

#[derive(Serialize)]
struct Revision {
    id: Uuid,
    project_id: Uuid,
    actor_user_id: Option<Uuid>,
    summary: String,
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct RevisionsResponse {
    revisions: Vec<Revision>,
}

#[derive(Deserialize)]
struct CreateRevisionInput {
    summary: String,
}

#[derive(Serialize)]
struct Document {
    id: Uuid,
    project_id: Uuid,
    path: String,
    content: String,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
struct DocumentsResponse {
    documents: Vec<Document>,
}

#[derive(Deserialize)]
struct CreateDocumentInput {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct UpdateDocumentInput {
    content: String,
}

#[derive(Deserialize)]
struct UpsertDocumentByPathInput {
    content: String,
}

#[derive(Deserialize)]
struct ListDocumentsQuery {
    path: Option<String>,
}

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

    let state = AppState { db };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/auth/config", get(auth_config))
        .route("/v1/auth/oidc/callback", get(oidc_callback))
        .route("/v1/projects", get(list_projects).post(create_project))
        .route("/v1/projects/{project_id}/roles", get(list_roles).post(upsert_role))
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
        .route("/v1/git/status/{project_id}", get(git_status))
        .route("/v1/git/config/{project_id}", get(get_git_config).put(upsert_git_config))
        .route("/v1/git/sync/pull/{project_id}", post(git_pull))
        .route("/v1/git/sync/push/{project_id}", post(git_push))
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

async fn auth_config() -> Json<AuthConfigResponse> {
    Json(AuthConfigResponse {
        issuer: env::var("OIDC_ISSUER").unwrap_or_else(|_| "".to_string()),
        client_id: env::var("OIDC_CLIENT_ID").unwrap_or_else(|_| "".to_string()),
        redirect_uri: env::var("OIDC_REDIRECT_URI").unwrap_or_else(|_| "".to_string()),
        groups_claim: env::var("OIDC_GROUPS_CLAIM").unwrap_or_else(|_| "groups".to_string()),
    })
}

async fn oidc_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<OidcCallbackQuery>,
) -> impl IntoResponse {
    let user_id = Uuid::parse_str(DEFAULT_USER_ID).unwrap();
    let token = format!("dev-session-{}", query.code);
    let source = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("unknown");

    write_audit(
        &state.db,
        Some(user_id),
        "auth.oidc.callback",
        serde_json::json!({"state": query.state, "code_len": query.code.len(), "source": source}),
    )
    .await;

    (
        StatusCode::OK,
        Json(SessionResponse {
            session_token: token,
            user_id,
        }),
    )
}

async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProjectListResponse>, StatusCode> {
    let actor = actor_user_id(&headers).unwrap_or_else(|| Uuid::parse_str(DEFAULT_USER_ID).unwrap());
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
    let actor = actor_user_id(&headers).unwrap_or_else(|| Uuid::parse_str(DEFAULT_USER_ID).unwrap());
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
    } else {
        return Err(StatusCode::BAD_REQUEST);
    }

    update_git_sync_state(&state.db, project_id, "pulled", false, Some(Utc::now()), None)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

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

    write_audit(
        &state.db,
        input.actor_user_id.or(Some(actor)),
        "git.push",
        serde_json::json!({ "project_id": project_id }),
    )
    .await;

    git_status_by_project(&state.db, project_id).await
}

enum AccessNeed {
    Read,
    Write,
    Manage,
    GitSync,
}

async fn ensure_project_role(
    db: &PgPool,
    headers: &HeaderMap,
    project_id: Uuid,
    need: AccessNeed,
) -> Result<Uuid, StatusCode> {
    let actor = actor_user_id(headers).unwrap_or_else(|| Uuid::parse_str(DEFAULT_USER_ID).unwrap());
    let row = sqlx::query("select role from project_roles where project_id = $1 and user_id = $2")
        .bind(project_id)
        .bind(actor)
        .fetch_optional(db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some(row) = row else {
        return Err(StatusCode::FORBIDDEN);
    };
    let role_str: String = row.get("role");
    let Some(role) = ProjectRole::from_db(&role_str) else {
        return Err(StatusCode::FORBIDDEN);
    };

    let allowed = match need {
        AccessNeed::Read => true,
        AccessNeed::Write => matches!(
            role,
            ProjectRole::Owner | ProjectRole::Teacher | ProjectRole::TA | ProjectRole::Student
        ),
        AccessNeed::Manage => matches!(role, ProjectRole::Owner | ProjectRole::Teacher),
        AccessNeed::GitSync => matches!(role, ProjectRole::Owner | ProjectRole::Teacher | ProjectRole::TA),
    };

    if allowed {
        Ok(actor)
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

fn actor_user_id(headers: &HeaderMap) -> Option<Uuid> {
    headers
        .get("x-user-id")
        .and_then(|h| h.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
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

fn git_storage_root() -> PathBuf {
    env::var("GIT_STORAGE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./tmp/git"))
}

fn project_git_repo_path(project_id: Uuid) -> PathBuf {
    git_storage_root().join(project_id.to_string())
}

fn ensure_git_repo_initialized(repo_path: &str, default_branch: &str) -> Result<(), String> {
    let path = PathBuf::from(repo_path);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let git_dir = path.join(".git");
    if !git_dir.exists() {
        run_git(repo_path, &["init", "-b", default_branch])?;
    }
    Ok(())
}

fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
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

fn sanitize_repo_relative_path(repo_path: &str, relative: &str) -> Result<PathBuf, String> {
    let rel_path = FsPath::new(relative);
    if rel_path.is_absolute() {
        return Err("document path cannot be absolute".to_string());
    }
    if rel_path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("document path contains invalid traversal".to_string());
    }
    Ok(PathBuf::from(repo_path).join(rel_path))
}
