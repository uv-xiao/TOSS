use crate::types::ProjectRole;
use axum::http::{header, HeaderMap, StatusCode};
use axum_extra::extract::cookie::CookieJar;
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub enum AccessNeed {
    Read,
    Write,
    Manage,
    GitSync,
}

pub fn actor_user_id(headers: &HeaderMap) -> Option<Uuid> {
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

pub async fn session_user_id(db: &PgPool, token: &str) -> Option<Uuid> {
    let row = sqlx::query("select user_id from auth_sessions where session_token = $1 and expires_at > now()")
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
