use aws_sdk_s3::Client as S3Client;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub oidc: OidcSettings,
    pub storage: Option<ObjectStorage>,
}

#[derive(Clone)]
pub struct OidcSettings {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub groups_claim: String,
}

#[derive(Clone)]
pub struct ObjectStorage {
    pub client: S3Client,
    pub bucket: String,
    pub key_prefix: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProjectRole {
    Owner,
    Teacher,
    Student,
    TA,
}

impl ProjectRole {
    pub fn from_db(v: &str) -> Option<Self> {
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
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
}

#[derive(Serialize)]
pub struct Project {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct ProjectListResponse {
    pub projects: Vec<Project>,
}

#[derive(Deserialize)]
pub struct CreateProjectInput {
    pub organization_id: Uuid,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Serialize)]
pub struct ProjectRoleBinding {
    pub project_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub granted_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct UpsertRoleInput {
    pub user_id: Uuid,
    pub role: String,
}

#[derive(Serialize)]
pub struct ProjectGroupRoleBinding {
    pub project_id: Uuid,
    pub group_name: String,
    pub role: String,
    pub granted_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct UpsertProjectGroupRoleInput {
    pub group_name: String,
    pub role: String,
}

#[derive(Serialize)]
pub struct GitSyncState {
    pub project_id: Uuid,
    pub branch: String,
    pub last_pull_at: Option<DateTime<Utc>>,
    pub last_push_at: Option<DateTime<Utc>>,
    pub has_conflicts: bool,
    pub status: String,
}

#[derive(Deserialize)]
pub struct SyncRequest {
    pub actor_user_id: Option<Uuid>,
}

#[derive(Serialize)]
pub struct GitRemoteConfig {
    pub project_id: Uuid,
    pub remote_url: Option<String>,
    pub local_path: String,
    pub default_branch: String,
}

#[derive(Serialize)]
pub struct GitRepoLink {
    pub project_id: Uuid,
    pub repo_url: String,
}

#[derive(Deserialize)]
pub struct UpsertGitRemoteConfigInput {
    pub remote_url: Option<String>,
    pub default_branch: Option<String>,
}

#[derive(Serialize)]
pub struct AuthConfigResponse {
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub groups_claim: String,
}

#[derive(Deserialize)]
pub struct OidcCallbackQuery {
    pub code: String,
    pub state: Option<String>,
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub session_token: String,
    pub user_id: Uuid,
}

#[derive(Serialize)]
pub struct AuthMeResponse {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub session_expires_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct RealtimeAuthResponse {
    pub user_id: Uuid,
}

#[derive(Serialize)]
pub struct PersonalAccessTokenInfo {
    pub id: Uuid,
    pub label: String,
    pub token_prefix: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct PersonalAccessTokenListResponse {
    pub tokens: Vec<PersonalAccessTokenInfo>,
}

#[derive(Deserialize)]
pub struct CreatePatInput {
    pub label: String,
    pub expires_at: Option<String>,
}

#[derive(Serialize)]
pub struct CreatePatResponse {
    pub id: Uuid,
    pub label: String,
    pub token: String,
    pub token_prefix: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct Comment {
    pub id: Uuid,
    pub project_id: Uuid,
    pub actor_user_id: Option<Uuid>,
    pub body: String,
    pub anchor: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct CommentsResponse {
    pub comments: Vec<Comment>,
}

#[derive(Deserialize)]
pub struct CreateCommentInput {
    pub body: String,
    pub anchor: Option<String>,
}

#[derive(Serialize)]
pub struct Revision {
    pub id: Uuid,
    pub project_id: Uuid,
    pub actor_user_id: Option<Uuid>,
    pub summary: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct RevisionsResponse {
    pub revisions: Vec<Revision>,
}

#[derive(Deserialize)]
pub struct CreateRevisionInput {
    pub summary: String,
}

#[derive(Serialize)]
pub struct Document {
    pub id: Uuid,
    pub project_id: Uuid,
    pub path: String,
    pub content: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct DocumentsResponse {
    pub documents: Vec<Document>,
}

#[derive(Deserialize)]
pub struct CreateDocumentInput {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct UpdateDocumentInput {
    pub content: String,
}

#[derive(Serialize)]
pub struct ProjectSnapshot {
    pub id: Uuid,
    pub project_id: Uuid,
    pub object_key: String,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub document_count: i32,
    pub byte_size: i64,
}

#[derive(Serialize)]
pub struct ProjectSnapshotListResponse {
    pub snapshots: Vec<ProjectSnapshot>,
}

#[derive(Serialize)]
pub struct ProjectAsset {
    pub id: Uuid,
    pub project_id: Uuid,
    pub path: String,
    pub object_key: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub uploaded_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct ProjectAssetListResponse {
    pub assets: Vec<ProjectAsset>,
}

#[derive(Deserialize)]
pub struct UploadAssetInput {
    pub path: String,
    pub content_base64: String,
    pub content_type: Option<String>,
}

#[derive(Serialize)]
pub struct ProjectAssetContentResponse {
    pub asset: ProjectAsset,
    pub content_base64: String,
}

#[derive(Deserialize)]
pub struct UpsertDocumentByPathInput {
    pub content: String,
}

#[derive(Deserialize)]
pub struct ListDocumentsQuery {
    pub path: Option<String>,
}
