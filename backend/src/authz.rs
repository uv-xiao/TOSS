use crate::types::ProjectRole;
use axum::http::{header, HeaderMap, StatusCode};
use axum_extra::extract::cookie::CookieJar;
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::env;
use uuid::Uuid;

const SITE_ADMINS_ORG_ID: &str = "00000000-0000-0000-0000-000000000001";

#[derive(Clone, Copy, Debug)]
pub enum AccessNeed {
    Read,
    Write,
    Manage,
    GitSync,
}

#[derive(Clone, Debug)]
pub struct ProjectAccessPrincipal {
    pub user_id: Option<Uuid>,
    pub guest_session_id: Option<Uuid>,
    pub guest_display_name: Option<String>,
    pub can_write: bool,
}

pub fn actor_user_id(headers: &HeaderMap) -> Option<Uuid> {
    let allow_dev_header = env::var("AUTH_DEV_HEADER_ENABLED")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !allow_dev_header {
        return None;
    }
    headers
        .get("x-user-id")
        .and_then(|h| h.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|v| v.trim().to_string())
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let p = part.trim();
        if let Some((k, v)) = p.split_once('=') {
            if k.trim() == name {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|h| h.to_str().ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn token_sha256(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let bytes = hasher.finalize();
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
}

fn anonymous_mode_normalized(value: Option<String>) -> String {
    value
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .filter(|v| matches!(v.as_str(), "off" | "read_only" | "read_write_named"))
        .unwrap_or_else(|| "off".to_string())
}

async fn load_anonymous_mode(db: &PgPool) -> Result<String, StatusCode> {
    let row = sqlx::query("select anonymous_mode from auth_settings where id = 1")
        .fetch_optional(db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mode = row
        .as_ref()
        .map(|r| r.get::<String, _>("anonymous_mode"))
        .map(Some)
        .map(anonymous_mode_normalized)
        .unwrap_or_else(|| "off".to_string());
    Ok(mode)
}

fn mode_allows_read(mode: &str) -> bool {
    mode == "read_only" || mode == "read_write_named"
}

fn mode_allows_guest_write(mode: &str) -> bool {
    mode == "read_write_named"
}

pub async fn session_user_id(db: &PgPool, token: &str) -> Option<Uuid> {
    let row = sqlx::query(
        "select user_id from auth_sessions where session_token = $1 and expires_at > now()",
    )
    .bind(token)
    .fetch_optional(db)
    .await
    .ok()??;
    Some(row.get("user_id"))
}

pub async fn request_user_id(db: &PgPool, headers: &HeaderMap) -> Option<Uuid> {
    if let Some(uid) = actor_user_id(headers) {
        return Some(uid);
    }
    if let Some(token) = bearer_token(headers) {
        if let Some(uid) = session_user_id(db, &token).await {
            return Some(uid);
        }
    }
    if let Some(token) = cookie_value(headers, "typst_session") {
        if let Some(uid) = session_user_id(db, &token).await {
            return Some(uid);
        }
    }
    None
}

async fn project_readable_via_share_token(
    db: &PgPool,
    project_id: Uuid,
    share_token: &str,
) -> Result<Option<String>, StatusCode> {
    let row = sqlx::query(
        "select permission
         from project_share_links
         where project_id = $1
           and (token_value = $2 or token_hash = $3)
           and revoked_at is null
           and (expires_at is null or expires_at > now())
         limit 1",
    )
    .bind(project_id)
    .bind(share_token)
    .bind(token_sha256(share_token))
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(row.map(|r| r.get::<String, _>("permission")))
}

async fn project_access_via_guest_session(
    db: &PgPool,
    project_id: Uuid,
    guest_session_token: &str,
) -> Result<Option<ProjectAccessPrincipal>, StatusCode> {
    let row = sqlx::query(
        "select s.id, s.display_name, s.permission, s.expires_at
         from anonymous_share_sessions s
         join project_share_links l on l.id = s.share_link_id
         where s.project_id = $1
           and s.session_token_hash = $2
           and l.revoked_at is null
           and (l.expires_at is null or l.expires_at > now())
         limit 1",
    )
    .bind(project_id)
    .bind(token_sha256(guest_session_token))
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let expires_at: Option<DateTime<Utc>> = row.get("expires_at");
    if expires_at.map(|v| v <= Utc::now()).unwrap_or(false) {
        return Ok(None);
    }
    let session_id: Uuid = row.get("id");
    let permission: String = row.get("permission");
    let display_name: String = row.get("display_name");
    let _ = sqlx::query(
        "update anonymous_share_sessions
         set last_used_at = $2
         where id = $1",
    )
    .bind(session_id)
    .bind(Utc::now())
    .execute(db)
    .await;
    Ok(Some(ProjectAccessPrincipal {
        user_id: None,
        guest_session_id: Some(session_id),
        guest_display_name: Some(display_name),
        can_write: permission == "write",
    }))
}

pub async fn ensure_project_access(
    db: &PgPool,
    headers: &HeaderMap,
    project_id: Uuid,
    need: AccessNeed,
) -> Result<ProjectAccessPrincipal, StatusCode> {
    if let Some(actor) = request_user_id(db, headers).await {
        ensure_project_role_for_user(db, actor, project_id, need).await?;
        let can_write = matches!(
            need,
            AccessNeed::Write | AccessNeed::Manage | AccessNeed::GitSync
        ) || ensure_project_role_for_user(db, actor, project_id, AccessNeed::Write)
            .await
            .is_ok();
        return Ok(ProjectAccessPrincipal {
            user_id: Some(actor),
            guest_session_id: None,
            guest_display_name: None,
            can_write,
        });
    }

    let mode = load_anonymous_mode(db).await?;
    if mode == "off" {
        return Err(StatusCode::UNAUTHORIZED);
    }

    if let Some(guest_session_token) = header_value(headers, "x-guest-session") {
        if let Some(principal) =
            project_access_via_guest_session(db, project_id, &guest_session_token).await?
        {
            if !mode_allows_read(&mode) {
                return Err(StatusCode::UNAUTHORIZED);
            }
            if matches!(need, AccessNeed::Write)
                && (!mode_allows_guest_write(&mode) || !principal.can_write)
            {
                return Err(StatusCode::FORBIDDEN);
            }
            if matches!(need, AccessNeed::Manage | AccessNeed::GitSync) {
                return Err(StatusCode::FORBIDDEN);
            }
            return Ok(principal);
        }
    }

    let share_token = header_value(headers, "x-share-token")
        .or_else(|| cookie_value(headers, "typst_share_token"));
    let Some(share_token) = share_token else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let permission = project_readable_via_share_token(db, project_id, &share_token)
        .await?
        .ok_or(StatusCode::FORBIDDEN)?;
    if !mode_allows_read(&mode) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if matches!(
        need,
        AccessNeed::Write | AccessNeed::Manage | AccessNeed::GitSync
    ) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(ProjectAccessPrincipal {
        user_id: None,
        guest_session_id: None,
        guest_display_name: None,
        can_write: permission == "write",
    })
}

pub async fn ensure_project_role(
    db: &PgPool,
    headers: &HeaderMap,
    project_id: Uuid,
    need: AccessNeed,
) -> Result<Uuid, StatusCode> {
    let Some(actor) = request_user_id(db, headers).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    ensure_project_role_for_user(db, actor, project_id, need).await?;
    Ok(actor)
}

pub async fn ensure_project_role_for_user(
    db: &PgPool,
    actor: Uuid,
    project_id: Uuid,
    need: AccessNeed,
) -> Result<(), StatusCode> {
    let row = sqlx::query("select role from project_roles where project_id = $1 and user_id = $2")
        .bind(project_id)
        .bind(actor)
        .fetch_optional(db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(row) = row {
        let role_str: String = row.get("role");
        let Some(role) = ProjectRole::from_db(&role_str) else {
            return Err(StatusCode::FORBIDDEN);
        };
        let allowed = match need {
            AccessNeed::Read => true,
            AccessNeed::Write => matches!(role, ProjectRole::Owner | ProjectRole::ReadWrite),
            AccessNeed::Manage => matches!(role, ProjectRole::Owner),
            AccessNeed::GitSync => matches!(role, ProjectRole::Owner),
        };
        return if allowed {
            Ok(())
        } else {
            Err(StatusCode::FORBIDDEN)
        };
    }

    let org_permission_row = sqlx::query(
        "select poa.permission
         from project_organization_access poa
         join (
            select organization_id from organization_memberships where user_id = $1
         ) uo on uo.organization_id = poa.organization_id
         where poa.project_id = $2
         order by case poa.permission when 'write' then 2 when 'read' then 1 else 0 end desc
         limit 1",
    )
    .bind(actor)
    .bind(project_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(permission_row) = org_permission_row else {
        return Err(StatusCode::FORBIDDEN);
    };
    let permission: String = permission_row.get("permission");
    let allowed = match need {
        AccessNeed::Read => permission == "read" || permission == "write",
        AccessNeed::Write => permission == "write",
        AccessNeed::Manage => false,
        AccessNeed::GitSync => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

pub async fn authenticated_user_id(
    db: &PgPool,
    headers: &HeaderMap,
    jar: &CookieJar,
) -> Result<Uuid, StatusCode> {
    if let Some(uid) = request_user_id(db, headers).await {
        return Ok(uid);
    }
    if let Some(token) = jar.get("typst_session").map(|c| c.value().to_string()) {
        if let Some(uid) = session_user_id(db, &token).await {
            return Ok(uid);
        }
    }
    Err(StatusCode::UNAUTHORIZED)
}

pub async fn is_site_admin(db: &PgPool, user_id: Uuid) -> Result<bool, StatusCode> {
    let site_org_id =
        Uuid::parse_str(SITE_ADMINS_ORG_ID).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query(
        "select 1
         from organization_memberships
         where organization_id = $1 and user_id = $2 and role = 'owner'
         limit 1",
    )
    .bind(site_org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(row.is_some())
}
