use aws_sdk_s3::Client as S3Client;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub oidc: OidcSettings,
    pub data_dir: PathBuf,
    pub storage: Option<ObjectStorage>,
    pub realtime_channels: Arc<RwLock<HashMap<String, broadcast::Sender<CollabEvent>>>>,
    pub git_project_locks: Arc<RwLock<HashMap<Uuid, Arc<Mutex<()>>>>>,
}

#[derive(Clone)]
pub struct OidcSettings {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub groups_claim: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AuthSettings {
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub site_name: String,
    pub oidc_issuer: Option<String>,
    pub oidc_client_id: Option<String>,
    pub oidc_client_secret: Option<String>,
    pub oidc_redirect_uri: Option<String>,
    pub oidc_groups_claim: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct ObjectStorage {
    pub client: S3Client,
    pub bucket: String,
    pub key_prefix: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CollabEvent {
    pub doc_id: String,
    pub user_id: String,
    pub kind: String,
    pub payload: serde_json::Value,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProjectRole {
    Owner,
    Teacher,
    Student,
    TA,
    Viewer,
}

impl ProjectRole {
    pub fn from_db(v: &str) -> Option<Self> {
        match v {
            "Owner" => Some(Self::Owner),
            "Teacher" => Some(Self::Teacher),
            "Student" => Some(Self::Student),
            "TA" => Some(Self::TA),
            "Viewer" => Some(Self::Viewer),
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
    pub name: String,
    pub owner_user_id: Option<Uuid>,
    pub owner_display_name: String,
    pub my_role: String,
    pub can_read: bool,
    pub is_template: bool,
    pub has_thumbnail: bool,
    pub created_at: DateTime<Utc>,
    pub last_edited_at: DateTime<Utc>,
    pub archived: bool,
    pub archived_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct ProjectListResponse {
    pub projects: Vec<Project>,
}

#[derive(Serialize)]
pub struct OrganizationMembership {
    pub organization_id: Uuid,
    pub organization_name: String,
    pub is_admin: bool,
    pub joined_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct OrganizationMembershipListResponse {
    pub organizations: Vec<OrganizationMembership>,
}

#[derive(Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
}

#[derive(Deserialize)]
pub struct CreateProjectCopyInput {
    pub name: String,
}

#[derive(Deserialize)]
pub struct UpdateProjectNameInput {
    pub name: String,
}

#[derive(Deserialize)]
pub struct ListProjectsQuery {
    pub include_archived: Option<bool>,
    pub q: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateProjectArchivedInput {
    pub archived: bool,
}

#[derive(Serialize)]
pub struct ProjectTreeResponse {
    pub nodes: Vec<ProjectFileNode>,
    pub entry_file_path: String,
}

#[derive(Serialize)]
pub struct ProjectFileNode {
    pub path: String,
    pub kind: String,
}

#[derive(Deserialize)]
pub struct CreateProjectFileInput {
    pub path: String,
    pub kind: String,
    pub content: Option<String>,
}

#[derive(Deserialize)]
pub struct MoveProjectFileInput {
    pub from_path: String,
    pub to_path: String,
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
pub struct OrgGroupRoleMapping {
    pub organization_id: Uuid,
    pub group_name: String,
    pub role: String,
    pub granted_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct UpsertOrgGroupRoleMappingInput {
    pub group_name: String,
    pub role: String,
}

#[derive(Serialize)]
pub struct AdminAuthSettingsResponse {
    pub settings: AuthSettings,
}

#[derive(Deserialize)]
pub struct UpsertAdminAuthSettingsInput {
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub site_name: Option<String>,
    pub oidc_discovery_url: Option<String>,
    pub oidc_client_id: Option<String>,
    pub oidc_client_secret: Option<String>,
    pub oidc_redirect_uri: Option<String>,
    pub oidc_groups_claim: Option<String>,
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
    pub allow_local_login: bool,
    pub allow_local_registration: bool,
    pub allow_oidc: bool,
    pub site_name: String,
    pub issuer: Option<String>,
    pub client_id: Option<String>,
    pub redirect_uri: Option<String>,
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
    pub username: String,
    pub display_name: String,
    pub session_expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct LocalLoginInput {
    pub email: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct LocalRegisterInput {
    pub email: String,
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
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

#[derive(Deserialize)]
pub struct UpsertProjectSettingsInput {
    pub entry_file_path: String,
}

#[derive(Deserialize)]
pub struct UpdateProjectTemplateInput {
    pub is_template: bool,
}

#[derive(Serialize)]
pub struct ProjectTemplateResponse {
    pub project_id: Uuid,
    pub is_template: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct ProjectTemplateOrganizationAccess {
    pub project_id: Uuid,
    pub organization_id: Uuid,
    pub organization_name: String,
    pub granted_by: Option<Uuid>,
    pub granted_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct UploadProjectThumbnailInput {
    pub content_base64: String,
    pub content_type: Option<String>,
}

#[derive(Serialize)]
pub struct ProjectSettingsResponse {
    pub project_id: Uuid,
    pub entry_file_path: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct UploadPdfArtifactInput {
    pub entry_file_path: Option<String>,
    pub content_base64: String,
    pub content_type: Option<String>,
}

#[derive(Serialize)]
pub struct PdfArtifact {
    pub id: Uuid,
    pub project_id: Uuid,
    pub entry_file_path: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct Revision {
    pub id: String,
    pub project_id: Uuid,
    pub actor_user_id: Option<Uuid>,
    pub summary: String,
    pub created_at: DateTime<Utc>,
    pub authors: Vec<RevisionAuthor>,
}

#[derive(Serialize)]
pub struct RevisionsResponse {
    pub revisions: Vec<Revision>,
}

#[derive(Serialize, Clone)]
pub struct RevisionAuthor {
    pub user_id: Uuid,
    pub display_name: String,
    pub email: String,
}

#[derive(Serialize)]
pub struct RevisionDocumentsResponse {
    pub revision_id: String,
    pub entry_file_path: String,
    pub transfer_mode: String,
    pub base_anchor: String,
    pub base_revision_id: Option<String>,
    pub nodes: Vec<ProjectFileNode>,
    pub documents: Vec<RevisionDocument>,
    pub deleted_documents: Vec<String>,
    pub assets: Vec<RevisionAsset>,
    pub deleted_assets: Vec<String>,
}

#[derive(Serialize)]
pub struct RevisionDocument {
    pub path: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct RevisionAsset {
    pub path: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub content_base64: String,
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
    pub since_updated_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize, Default)]
pub struct ListRevisionsQuery {
    pub before: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Deserialize, Default)]
pub struct RevisionDocumentsQuery {
    pub current_revision_id: Option<String>,
    pub include_live_anchor: Option<bool>,
}

#[derive(Serialize)]
pub struct ProjectShareLink {
    pub id: Uuid,
    pub project_id: Uuid,
    pub token_prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_value: Option<String>,
    pub permission: String,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct CreateProjectShareLinkInput {
    pub permission: String,
    pub expires_at: Option<String>,
}

#[derive(Serialize)]
pub struct CreateProjectShareLinkResponse {
    pub link: ProjectShareLink,
    pub token: String,
}

#[derive(Serialize)]
pub struct JoinProjectShareLinkResponse {
    pub project_id: Uuid,
    pub role: String,
}

#[derive(Serialize)]
pub struct ProjectOrganizationAccess {
    pub project_id: Uuid,
    pub organization_id: Uuid,
    pub organization_name: String,
    pub permission: String,
    pub granted_by: Option<Uuid>,
    pub granted_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct UpsertProjectOrganizationAccessInput {
    pub permission: String,
}

#[derive(Serialize)]
pub struct ProjectAccessUser {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub access_type: String,
    pub sources: Vec<String>,
}

#[derive(Serialize)]
pub struct ProjectAccessUserListResponse {
    pub users: Vec<ProjectAccessUser>,
}
