use super::*;

#[derive(Serialize)]
struct ApiErrorResponse {
    error: String,
}

pub(super) fn error_response(
    status: StatusCode,
    message: impl Into<String>,
) -> axum::response::Response {
    let payload = ApiErrorResponse {
        error: message.into(),
    };
    (status, Json(payload)).into_response()
}

pub(super) async fn get_or_create_git_project_lock(
    state: &AppState,
    project_id: Uuid,
) -> Arc<tokio::sync::Mutex<()>> {
    if let Some(lock) = state
        .git_project_locks
        .read()
        .await
        .get(&project_id)
        .cloned()
    {
        return lock;
    }
    let mut write = state.git_project_locks.write().await;
    if let Some(lock) = write.get(&project_id).cloned() {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    write.insert(project_id, lock.clone());
    lock
}

pub(super) async fn acquire_git_project_lock(
    state: &AppState,
    project_id: Uuid,
) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = get_or_create_git_project_lock(state, project_id).await;
    lock.lock_owned().await
}

pub(super) fn extract_groups_from_id_token(raw_id_token: String, claim_name: &str) -> Vec<String> {
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

pub(super) fn decode_jwt_claims(raw_token: &str) -> Option<serde_json::Value> {
    let mut parts = raw_token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let bytes = base64::Engine::decode(&URL_SAFE_NO_PAD, payload).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes).ok()
}

pub(super) async fn sync_user_oidc_groups(
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

pub(super) fn role_rank(role: &str) -> i32 {
    match role {
        "Owner" => 3,
        "ReadWrite" => 2,
        "ReadOnly" => 1,
        _ => 0,
    }
}

pub(super) fn access_type_from_role(role: &str) -> &'static str {
    match role {
        "ReadOnly" => "read",
        "ReadWrite" => "write",
        "Owner" => "manage",
        _ => "read",
    }
}

pub(super) fn role_from_org_permission(permission: &str) -> &'static str {
    match permission {
        "read" => "ReadOnly",
        "write" => "ReadWrite",
        _ => "ReadOnly",
    }
}

pub(super) fn merge_project_access_user(
    users: &mut HashMap<Uuid, ProjectAccessUser>,
    user_id: Uuid,
    email: String,
    display_name: String,
    role: String,
    source: String,
) {
    let access_type = access_type_from_role(&role).to_string();
    users
        .entry(user_id)
        .and_modify(|entry| {
            if role_rank(&role) > role_rank(&entry.role) {
                entry.role = role.clone();
                entry.access_type = access_type.clone();
            }
            if !entry.sources.contains(&source) {
                entry.sources.push(source.clone());
            }
        })
        .or_insert_with(|| ProjectAccessUser {
            user_id,
            email,
            display_name,
            role,
            access_type,
            sources: vec![source],
        });
}

pub(super) async fn apply_org_group_memberships(
    db: &PgPool,
    user_id: Uuid,
    groups: &[String],
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(
        "select m.organization_id, m.group_name, m.role
         from org_oidc_group_role_mappings m",
    )
    .fetch_all(db)
    .await?;
    let group_set: HashSet<String> = groups.iter().cloned().collect();
    let mut desired: HashMap<Uuid, String> = HashMap::new();
    for row in rows {
        let group_name: String = row.get("group_name");
        if !group_set.contains(&group_name) {
            continue;
        }
        let role: String = row.get("role");
        let org_id: Uuid = row.get("organization_id");
        let entry = desired.entry(org_id).or_insert_with(|| role.clone());
        if role == "owner" && entry != "owner" {
            *entry = role;
        }
    }

    let current_rows = sqlx::query(
        "select organization_id, role
         from organization_memberships
         where user_id = $1",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let mut current_roles: HashMap<Uuid, String> = HashMap::new();
    for row in current_rows {
        current_roles.insert(row.get("organization_id"), row.get("role"));
    }

    for (organization_id, mapped_role) in &desired {
        let should_write = match current_roles.get(organization_id) {
            Some(existing_role) => existing_role != mapped_role,
            None => true,
        };
        if should_write {
            sqlx::query(
                "insert into organization_memberships (organization_id, user_id, joined_at, role)
                 values ($1, $2, $3, $4)
                 on conflict (organization_id, user_id) do update
                 set role = excluded.role",
            )
            .bind(*organization_id)
            .bind(user_id)
            .bind(Utc::now())
            .bind(mapped_role)
            .execute(db)
            .await?;
        }
    }
    for (organization_id, existing_role) in current_roles {
        if existing_role == "owner" {
            continue;
        }
        if !groups.is_empty() && desired.contains_key(&organization_id) {
            continue;
        }
        let mapped = sqlx::query(
            "select 1 from org_oidc_group_role_mappings where organization_id = $1 limit 1",
        )
        .bind(organization_id)
        .fetch_optional(db)
        .await?;
        if mapped.is_some() {
            sqlx::query(
                "delete from organization_memberships
                 where organization_id = $1 and user_id = $2 and role != 'owner'",
            )
            .bind(organization_id)
            .bind(user_id)
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

pub(super) async fn write_audit(
    db: &PgPool,
    actor_user_id: Option<Uuid>,
    event_type: &str,
    payload: serde_json::Value,
) {
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

pub(super) struct LoadedGitConfig {
    pub(super) local_path: String,
    pub(super) default_branch: String,
}

pub(super) async fn load_git_config(
    db: &PgPool,
    project_id: Uuid,
) -> Result<LoadedGitConfig, StatusCode> {
    let row = sqlx::query(
        "select local_path, default_branch from git_repositories where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let Some(row) = row else {
        return Err(StatusCode::NOT_FOUND);
    };
    Ok(LoadedGitConfig {
        local_path: row.get("local_path"),
        default_branch: row.get("default_branch"),
    })
}

pub(super) async fn update_git_sync_state(
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

pub(super) async fn create_git_bundle_artifact(
    state: &AppState,
    project_id: Uuid,
    repo_path: &str,
    event_type: &str,
) -> Result<(), String> {
    let _ = (state, project_id, repo_path, event_type);
    Ok(())
}

pub(super) fn clear_repo_working_tree(repo_path: &str) -> Result<(), String> {
    let root = std::path::Path::new(repo_path);
    let entries = std::fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        if name == ".git" {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn is_document_text_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        ".typ", ".bib", ".txt", ".md", ".json", ".toml", ".yaml", ".yml", ".csv", ".xml", ".html",
        ".css", ".js", ".ts", ".tsx", ".jsx",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

pub(super) fn guess_content_type(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png".to_string()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".to_string()
    } else if lower.ends_with(".gif") {
        "image/gif".to_string()
    } else if lower.ends_with(".svg") {
        "image/svg+xml".to_string()
    } else if lower.ends_with(".pdf") {
        "application/pdf".to_string()
    } else if lower.ends_with(".ttf") {
        "font/ttf".to_string()
    } else if lower.ends_with(".otf") {
        "font/otf".to_string()
    } else if lower.ends_with(".woff") {
        "font/woff".to_string()
    } else if lower.ends_with(".woff2") {
        "font/woff2".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

pub(super) fn looks_like_text(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    std::str::from_utf8(bytes).is_ok()
}

pub(super) async fn normalize_non_text_documents_to_assets(
    state: &AppState,
    project_id: Uuid,
) -> Result<(), String> {
    let rows = sqlx::query(
        "select id, path, content
         from documents
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    for row in rows {
        let doc_id: Uuid = row.get("id");
        let path: String = row.get("path");
        if is_document_text_path(&path) {
            continue;
        }
        let bytes = row.get::<String, _>("content").into_bytes();
        let existing_asset = sqlx::query(
            "select id, object_key
             from project_assets
             where project_id = $1 and path = $2
             limit 1",
        )
        .bind(project_id)
        .bind(&path)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        let asset_id = existing_asset
            .as_ref()
            .map(|value| value.get::<Uuid, _>("id"))
            .unwrap_or_else(Uuid::new_v4);
        let default_object_key = format!("projects/{project_id}/assets/{asset_id}");
        let object_key = existing_asset
            .as_ref()
            .map(|value| value.get::<String, _>("object_key"))
            .filter(|value| !value.trim().is_empty() && !value.starts_with("inline://"))
            .unwrap_or(default_object_key);
        let content_type = guess_content_type(&path);
        let now = Utc::now();
        let (stored_object_key, inline_data) = if let Some(storage) = state.storage.clone() {
            put_object(&storage, &object_key, &content_type, bytes.clone())
                .await
                .map_err(|e| e.to_string())?;
            (object_key, None)
        } else {
            (format!("inline://{asset_id}"), Some(bytes.clone()))
        };
        sqlx::query(
            "insert into project_assets
             (id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at, inline_data)
             values ($1, $2, $3, $4, $5, $6, null, $7, $8)
             on conflict (project_id, path)
             do update set
               object_key = excluded.object_key,
               content_type = excluded.content_type,
               size_bytes = excluded.size_bytes,
               created_at = excluded.created_at,
               inline_data = excluded.inline_data",
        )
        .bind(asset_id)
        .bind(project_id)
        .bind(&path)
        .bind(stored_object_key)
        .bind(content_type)
        .bind(i64::try_from(bytes.len()).unwrap_or(i64::MAX))
        .bind(now)
        .bind(inline_data)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query("delete from documents where project_id = $1 and id = $2")
            .bind(project_id)
            .bind(doc_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub(super) async fn normalize_text_assets_to_documents(
    state: &AppState,
    project_id: Uuid,
) -> Result<(), String> {
    let rows = sqlx::query(
        "select id, path, object_key, inline_data
         from project_assets
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    for row in rows {
        let asset_id: Uuid = row.get("id");
        let path: String = row.get("path");
        if !is_document_text_path(&path) {
            continue;
        }
        let already_document = sqlx::query(
            "select 1
             from documents
             where project_id = $1 and path = $2
             limit 1",
        )
        .bind(project_id)
        .bind(&path)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .is_some();

        let object_key: String = row.get("object_key");
        let bytes = if let Some(inline) = row.get::<Option<Vec<u8>>, _>("inline_data") {
            inline
        } else if let Some(storage) = state.storage.clone() {
            get_object(&storage, &object_key)
                .await
                .map_err(|e| e.to_string())?
        } else {
            continue;
        };
        if !looks_like_text(&bytes) {
            continue;
        }
        let content = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        if !already_document {
            sqlx::query(
                "insert into documents (id, project_id, path, content, updated_at)
                 values ($1, $2, $3, $4, $5)
                 on conflict (project_id, path)
                 do update set content = excluded.content, updated_at = excluded.updated_at",
            )
            .bind(Uuid::new_v4())
            .bind(project_id)
            .bind(&path)
            .bind(content)
            .bind(Utc::now())
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        }
        if !object_key.starts_with("inline://") {
            if let Some(storage) = state.storage.clone() {
                let _ = delete_object(&storage, &object_key).await;
            }
        }
        sqlx::query("delete from project_assets where project_id = $1 and id = $2")
            .bind(project_id)
            .bind(asset_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub(super) async fn normalize_project_file_classification(
    state: &AppState,
    project_id: Uuid,
) -> Result<(), String> {
    normalize_non_text_documents_to_assets(state, project_id).await?;
    normalize_text_assets_to_documents(state, project_id).await?;
    Ok(())
}

pub(super) async fn sync_project_documents_to_repo(
    state: &AppState,
    project_id: Uuid,
    repo_path: &str,
) -> Result<(), String> {
    normalize_project_file_classification(state, project_id).await?;
    clear_repo_working_tree(repo_path)?;
    let doc_rows = sqlx::query("select path, content from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let asset_rows = sqlx::query(
        "select path, object_key, inline_data
         from project_assets
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let dir_rows = sqlx::query("select path from project_directories where project_id = $1")
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    for row in dir_rows {
        let dir_path: String = row.get("path");
        let target = sanitize_repo_relative_path(repo_path, &dir_path)?;
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    }

    for row in doc_rows {
        let doc_path: String = row.get("path");
        let content: String = row.get("content");
        let target = sanitize_repo_relative_path(repo_path, &doc_path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, content.as_bytes()).map_err(|e| e.to_string())?;
    }

    for row in asset_rows {
        let asset_path: String = row.get("path");
        let bytes = if let Some(inline) = row.get::<Option<Vec<u8>>, _>("inline_data") {
            inline
        } else {
            let object_key: String = row.get("object_key");
            let Some(storage) = state.storage.clone() else {
                return Err("object storage unavailable for asset sync".to_string());
            };
            get_object(&storage, &object_key)
                .await
                .map_err(|e| e.to_string())?
        };
        let target = sanitize_repo_relative_path(repo_path, &asset_path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) async fn sync_repo_documents_to_project(
    state: &AppState,
    project_id: Uuid,
    repo_path: &str,
) -> Result<(), String> {
    let repo_files = collect_repo_files(repo_path)?;
    let doc_rows = sqlx::query("select id, path from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let asset_rows = sqlx::query(
        "select id, path, object_key
         from project_assets
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let mut current_docs: HashMap<String, Uuid> = HashMap::new();
    for row in doc_rows {
        current_docs.insert(row.get("path"), row.get("id"));
    }
    let mut current_assets: HashMap<String, (Uuid, String)> = HashMap::new();
    for row in asset_rows {
        current_assets.insert(row.get("path"), (row.get("id"), row.get("object_key")));
    }

    let now = Utc::now();
    let mut repo_paths: HashSet<String> = HashSet::new();
    let mut repo_dirs: HashSet<String> = HashSet::new();

    for (path, bytes) in repo_files {
        repo_paths.insert(path.clone());
        let clean_path =
            sanitize_project_path(&path).map_err(|_| "invalid repo path".to_string())?;
        let parts = clean_path.split('/').collect::<Vec<_>>();
        let mut acc = String::new();
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            if acc.is_empty() {
                acc.push_str(part);
            } else {
                acc.push('/');
                acc.push_str(part);
            }
            repo_dirs.insert(acc.clone());
        }

        if is_document_text_path(&clean_path) && looks_like_text(&bytes) {
            let content = String::from_utf8(bytes).map_err(|e| e.to_string())?;
            sqlx::query(
                "insert into documents (id, project_id, path, content, updated_at)
                 values ($1, $2, $3, $4, $5)
                 on conflict (project_id, path)
                 do update set content = excluded.content, updated_at = excluded.updated_at",
            )
            .bind(Uuid::new_v4())
            .bind(project_id)
            .bind(&clean_path)
            .bind(content)
            .bind(now)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
            if let Some((asset_id, object_key)) = current_assets.get(&clean_path) {
                if !object_key.starts_with("inline://") {
                    if let Some(storage) = state.storage.clone() {
                        let _ = delete_object(&storage, object_key).await;
                    }
                }
                let _ = sqlx::query("delete from project_assets where project_id = $1 and id = $2")
                    .bind(project_id)
                    .bind(asset_id)
                    .execute(&state.db)
                    .await;
            }
            continue;
        }

        let existing = current_assets.get(&clean_path).cloned();
        let asset_id = existing
            .as_ref()
            .map(|value| value.0)
            .unwrap_or_else(Uuid::new_v4);
        let object_key = if let Some((_, key)) = existing.clone() {
            key
        } else {
            format!("projects/{project_id}/assets/{asset_id}")
        };
        let (stored_object_key, inline_data) = if let Some(storage) = state.storage.clone() {
            let content_type = guess_content_type(&clean_path);
            put_object(&storage, &object_key, &content_type, bytes.clone())
                .await
                .map_err(|e| e.to_string())?;
            (object_key, None)
        } else {
            (format!("inline://{asset_id}"), Some(bytes.clone()))
        };
        let content_type = guess_content_type(&clean_path);
        sqlx::query(
            "insert into project_assets
             (id, project_id, path, object_key, content_type, size_bytes, uploaded_by, created_at, inline_data)
             values ($1, $2, $3, $4, $5, $6, null, $7, $8)
             on conflict (project_id, path)
             do update set
               object_key = excluded.object_key,
               content_type = excluded.content_type,
               size_bytes = excluded.size_bytes,
               created_at = excluded.created_at,
               inline_data = excluded.inline_data",
        )
        .bind(asset_id)
        .bind(project_id)
        .bind(&clean_path)
        .bind(stored_object_key)
        .bind(content_type)
        .bind(bytes.len() as i64)
        .bind(now)
        .bind(inline_data)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        let _ = sqlx::query("delete from documents where project_id = $1 and path = $2")
            .bind(project_id)
            .bind(&clean_path)
            .execute(&state.db)
            .await;
    }

    for (path, doc_id) in current_docs {
        if !repo_paths.contains(&path) {
            sqlx::query("delete from documents where project_id = $1 and id = $2")
                .bind(project_id)
                .bind(doc_id)
                .execute(&state.db)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    for (path, (asset_id, object_key)) in current_assets {
        if repo_paths.contains(&path) {
            continue;
        }
        if !object_key.starts_with("inline://") {
            if let Some(storage) = state.storage.clone() {
                let _ = delete_object(&storage, &object_key).await;
            }
        }
        sqlx::query("delete from project_assets where project_id = $1 and id = $2")
            .bind(project_id)
            .bind(asset_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    }

    sqlx::query("delete from project_directories where project_id = $1")
        .bind(project_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    for dir_path in repo_dirs {
        sqlx::query(
            "insert into project_directories (project_id, path, created_at)
             values ($1, $2, $3)
             on conflict (project_id, path) do nothing",
        )
        .bind(project_id)
        .bind(dir_path)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub(super) async fn lookup_user_display_name(db: &PgPool, user_id: Uuid) -> Option<String> {
    let row = sqlx::query("select display_name from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()??;
    Some(row.get("display_name"))
}

pub(super) async fn lookup_user_email(db: &PgPool, user_id: Uuid) -> Option<String> {
    let row = sqlx::query("select email from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()??;
    Some(row.get("email"))
}

#[derive(Clone, Default)]
pub(super) struct RevisionStateData {
    pub(super) documents: HashMap<String, String>,
    pub(super) directories: HashSet<String>,
    pub(super) assets: HashMap<String, RevisionStoredAsset>,
}

#[derive(Clone)]
pub(super) struct RevisionStoredAsset {
    pub(super) object_key: String,
    pub(super) content_type: String,
    pub(super) inline_data: Option<Vec<u8>>,
}

pub(super) async fn load_project_state(
    db: &PgPool,
    project_id: Uuid,
) -> Result<RevisionStateData, sqlx::Error> {
    let doc_rows = sqlx::query("select path, content from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await?;
    let dir_rows = sqlx::query("select path from project_directories where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await?;
    let asset_rows = sqlx::query(
        "select path, object_key, content_type, size_bytes, inline_data
         from project_assets
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let mut state = RevisionStateData::default();
    for row in doc_rows {
        state
            .documents
            .insert(row.get("path"), row.get::<String, _>("content"));
    }
    for row in dir_rows {
        state.directories.insert(row.get("path"));
    }
    for row in asset_rows {
        state.assets.insert(
            row.get("path"),
            RevisionStoredAsset {
                object_key: row.get("object_key"),
                content_type: row.get("content_type"),
                inline_data: row.get("inline_data"),
            },
        );
    }
    Ok(state)
}

pub(super) async fn lookup_project_entry_file_path(db: &PgPool, project_id: Uuid) -> String {
    sqlx::query("select entry_file_path from project_settings where project_id = $1")
        .bind(project_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .map(|row| row.get::<String, _>("entry_file_path"))
        .unwrap_or_else(|| "main.typ".to_string())
}

pub(super) async fn mark_project_dirty(db: &PgPool, project_id: Uuid, actor_user_id: Option<Uuid>) {
    let now = Utc::now();
    let _ = sqlx::query(
        "insert into git_repositories (project_id, remote_url, local_path, default_branch, pending_sync, updated_at)
         values ($1, $2, $3, 'main', true, $4)
         on conflict (project_id) do update set pending_sync = true, updated_at = excluded.updated_at",
    )
    .bind(project_id)
    .bind(Option::<String>::None)
    .bind(project_git_repo_path(project_id).to_string_lossy().to_string())
    .bind(now)
    .execute(db)
    .await;
    let _ = sqlx::query(
        "insert into project_sync_queue
           (project_id, dirty_since, last_enqueued_at, last_attempt_at, attempt_count, last_error)
         values ($1, $2, $2, null, 0, null)
         on conflict (project_id) do update
         set last_enqueued_at = excluded.last_enqueued_at",
    )
    .bind(project_id)
    .bind(now)
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

pub(super) async fn mark_project_dirty_guest(db: &PgPool, project_id: Uuid, display_name: &str) {
    mark_project_dirty(db, project_id, None).await;
    let trimmed = display_name.trim();
    if trimmed.is_empty() {
        return;
    }
    let _ = sqlx::query(
        "insert into git_pending_guest_authors (project_id, display_name, touched_at)
         values ($1, $2, $3)
         on conflict (project_id, display_name) do update set touched_at = excluded.touched_at",
    )
    .bind(project_id)
    .bind(trimmed)
    .bind(Utc::now())
    .execute(db)
    .await;
}

pub(super) async fn flush_pending_server_commit(
    state: &AppState,
    project_id: Uuid,
    force_author: Option<Uuid>,
) -> Result<(), String> {
    let row = sqlx::query(
        "select local_path, default_branch, pending_sync from git_repositories where project_id = $1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(row) = row else {
        clear_project_sync_queue_item(&state.db, project_id).await;
        return Ok(());
    };
    let pending_sync: bool = row.get("pending_sync");
    if !pending_sync {
        clear_project_sync_queue_item(&state.db, project_id).await;
        return Ok(());
    }
    let local_path: String = row.get("local_path");
    let default_branch: String = row.get("default_branch");
    ensure_git_repo_initialized(&local_path, &default_branch)?;
    ensure_git_branch_checked_out(&local_path, &default_branch)?;
    sync_project_documents_to_repo(state, project_id, &local_path).await?;
    let clean = git_worktree_is_clean(&local_path)?;
    if clean {
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
        let _ = sqlx::query("delete from git_pending_guest_authors where project_id = $1")
            .bind(project_id)
            .execute(&state.db)
            .await;
        clear_project_sync_queue_item(&state.db, project_id).await;
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
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let mut trailers = Vec::new();
    for row in author_rows {
        let name: String = row.get("display_name");
        let email: String = row.get("email");
        trailers.push(format!("Co-authored-by: {} <{}>", name, email));
    }
    let guest_rows = sqlx::query(
        "select display_name
         from git_pending_guest_authors
         where project_id = $1
         order by touched_at asc",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    for row in guest_rows {
        let name: String = row.get("display_name");
        let guest_name = format!("{name} (Unverified)");
        let hash = token_sha256(&name);
        let guest_email = format!("guest+{}@typst-server.local", &hash[..12]);
        trailers.push(format!("Co-authored-by: {} <{}>", guest_name, guest_email));
    }
    if trailers.is_empty() {
        if let Some(user_id) = force_author {
            let u = sqlx::query("select display_name, email from users where id = $1")
                .bind(user_id)
                .fetch_optional(&state.db)
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
    let commit_author = if let Some(first) = trailers.first() {
        // first trailer format is guaranteed by builder above.
        let trimmed = first.trim_start_matches("Co-authored-by: ").trim();
        let start = trimmed.rfind('<');
        let end = trimmed.rfind('>');
        if let (Some(start), Some(end)) = (start, end) {
            let name = trimmed[..start].trim().to_string();
            let email = trimmed[start + 1..end].trim().to_string();
            (name, email)
        } else {
            (
                "Typst Server".to_string(),
                "noreply@typst-server.local".to_string(),
            )
        }
    } else {
        (
            "Typst Server".to_string(),
            "noreply@typst-server.local".to_string(),
        )
    };
    let message = if trailers.is_empty() {
        "Online updates".to_string()
    } else {
        format!("Online updates\n\n{}", trailers.join("\n"))
    };
    let _ =
        git_commit_staged_if_changed(&local_path, &message, &commit_author.0, &commit_author.1)?;
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
    let _ = sqlx::query("delete from git_pending_guest_authors where project_id = $1")
        .bind(project_id)
        .execute(&state.db)
        .await;
    clear_project_sync_queue_item(&state.db, project_id).await;
    Ok(())
}

pub(super) fn git_flush_worker_interval_seconds() -> u64 {
    env::var("GIT_FLUSH_WORKER_INTERVAL_SECONDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(3)
}

pub(super) fn git_autosave_interval_seconds() -> i64 {
    env::var("GIT_AUTOSAVE_INTERVAL_SECONDS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 60)
        .unwrap_or(600)
}

pub(super) fn git_flush_worker_batch_size() -> i64 {
    env::var("GIT_FLUSH_WORKER_BATCH_SIZE")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(64)
}

pub(super) async fn list_pending_sync_projects(
    db: &PgPool,
    limit: i64,
) -> Result<Vec<Uuid>, sqlx::Error> {
    let now = Utc::now();
    let due_before = now - chrono::Duration::seconds(git_autosave_interval_seconds());
    let rows = sqlx::query(
        "select project_id
         from project_sync_queue
         where dirty_since <= $2
         order by dirty_since asc
         limit $1",
    )
    .bind(limit)
    .bind(due_before)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.get::<Uuid, _>("project_id"))
        .collect())
}

pub(super) async fn mark_project_sync_attempt(db: &PgPool, project_id: Uuid) {
    let _ = sqlx::query(
        "update project_sync_queue
         set last_attempt_at = $2,
             attempt_count = attempt_count + 1
         where project_id = $1",
    )
    .bind(project_id)
    .bind(Utc::now())
    .execute(db)
    .await;
}

pub(super) async fn clear_project_sync_queue_item(db: &PgPool, project_id: Uuid) {
    let _ = sqlx::query("delete from project_sync_queue where project_id = $1")
        .bind(project_id)
        .execute(db)
        .await;
}

pub(super) async fn fail_project_sync_queue_item(
    db: &PgPool,
    project_id: Uuid,
    error_message: &str,
) {
    let _ = sqlx::query(
        "update project_sync_queue
         set last_error = $2
         where project_id = $1",
    )
    .bind(project_id)
    .bind(error_message)
    .execute(db)
    .await;
}

pub(super) fn spawn_git_flush_worker(state: AppState) {
    let interval = Duration::from_secs(git_flush_worker_interval_seconds());
    let batch_size = git_flush_worker_batch_size();
    tokio::spawn(async move {
        loop {
            match list_pending_sync_projects(&state.db, batch_size).await {
                Ok(projects) => {
                    for project_id in projects {
                        mark_project_sync_attempt(&state.db, project_id).await;
                        let _git_lock = acquire_git_project_lock(&state, project_id).await;
                        if let Err(err) =
                            flush_pending_server_commit(&state, project_id, None).await
                        {
                            error!(
                                "git flush worker failed for project {}: {}",
                                project_id, err
                            );
                            fail_project_sync_queue_item(&state.db, project_id, &err).await;
                        } else {
                            clear_project_sync_queue_item(&state.db, project_id).await;
                        }
                    }
                }
                Err(err) => {
                    error!("git flush worker could not load pending projects: {}", err);
                }
            }
            tokio::time::sleep(interval).await;
        }
    });
}

pub(super) fn parse_cgi_http_backend_output(
    raw: &[u8],
) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
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
            let code = rest.split_whitespace().next().unwrap_or("200");
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

pub(super) async fn git_http_user(db: &PgPool, headers: &HeaderMap) -> Option<Uuid> {
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
    let _ =
        sqlx::query("update personal_access_tokens set last_used_at = $2 where token_hash = $1")
            .bind(token_sha256(token))
            .bind(Utc::now())
            .execute(db)
            .await;
    Some(user_id)
}

pub(super) fn random_token(length: usize) -> String {
    Alphanumeric.sample_string(&mut rand::rng(), length)
}

pub(super) fn token_sha256(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let bytes = hasher.finalize();
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
}
