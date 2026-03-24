#[derive(Serialize)]
struct ApiErrorResponse {
    error: String,
}

fn error_response(status: StatusCode, message: impl Into<String>) -> axum::response::Response {
    let payload = ApiErrorResponse {
        error: message.into(),
    };
    (status, Json(payload)).into_response()
}

async fn get_or_create_git_project_lock(
    state: &AppState,
    project_id: Uuid,
) -> Arc<tokio::sync::Mutex<()>> {
    if let Some(lock) = state.git_project_locks.read().await.get(&project_id).cloned() {
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

async fn acquire_git_project_lock(
    state: &AppState,
    project_id: Uuid,
) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = get_or_create_git_project_lock(state, project_id).await;
    lock.lock_owned().await
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
        "Owner" => 5,
        "Teacher" => 4,
        "TA" => 3,
        "Student" => 2,
        "Viewer" => 1,
        _ => 0,
    }
}

fn access_type_from_role(role: &str) -> &'static str {
    match role {
        "Viewer" => "read",
        "Student" | "TA" | "Teacher" => "write",
        "Owner" => "manage",
        _ => "read",
    }
}

async fn apply_project_group_roles(
    db: &PgPool,
    user_id: Uuid,
    groups: &[String],
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(
        "select p.id as project_id, m.group_name, m.role
         from projects p
         join org_oidc_group_role_mappings m on m.organization_id = p.organization_id",
    )
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

async fn write_audit(
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

struct LoadedGitConfig {
    remote_url: Option<String>,
    local_path: String,
    default_branch: String,
}

async fn load_git_config(db: &PgPool, project_id: Uuid) -> Result<LoadedGitConfig, StatusCode> {
    let row = sqlx::query(
        "select remote_url, local_path, default_branch from git_repositories where project_id = $1",
    )
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
    let _ = (state, project_id, repo_path, event_type);
    Ok(())
}

fn clear_repo_working_tree(repo_path: &str) -> Result<(), String> {
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

fn looks_like_text(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_ok()
}

async fn sync_project_documents_to_repo(
    state: &AppState,
    project_id: Uuid,
    repo_path: &str,
) -> Result<(), String> {
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

async fn sync_repo_documents_to_project(
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
        let clean_path = sanitize_project_path(&path).map_err(|_| "invalid repo path".to_string())?;
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

        if looks_like_text(&bytes) {
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
            put_object(&storage, &object_key, "application/octet-stream", bytes.clone())
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
        .bind(&clean_path)
        .bind(stored_object_key)
        .bind("application/octet-stream")
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

async fn lookup_user_display_name(db: &PgPool, user_id: Uuid) -> Option<String> {
    let row = sqlx::query("select display_name from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()??;
    Some(row.get("display_name"))
}

async fn lookup_user_email(db: &PgPool, user_id: Uuid) -> Option<String> {
    let row = sqlx::query("select email from users where id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()??;
    Some(row.get("email"))
}

async fn load_revision_authors(
    db: &PgPool,
    revision_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<RevisionAuthor>>, sqlx::Error> {
    let mut out: HashMap<Uuid, Vec<RevisionAuthor>> = HashMap::new();
    if revision_ids.is_empty() {
        return Ok(out);
    }
    let rows = sqlx::query(
        "select ra.revision_id, u.id as user_id, u.display_name, u.email
         from revision_authors ra
         join users u on u.id = ra.user_id
         where ra.revision_id = any($1::uuid[])
         order by ra.revision_id, u.display_name asc",
    )
    .bind(revision_ids)
    .fetch_all(db)
    .await?;
    for row in rows {
        let revision_id: Uuid = row.get("revision_id");
        out.entry(revision_id).or_default().push(RevisionAuthor {
            user_id: row.get("user_id"),
            display_name: row.get("display_name"),
            email: row.get("email"),
        });
    }
    Ok(out)
}

async fn snapshot_revision_documents(
    db: &PgPool,
    project_id: Uuid,
    revision_id: Uuid,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query("select path, content from documents where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await?;
    for row in rows {
        sqlx::query(
            "insert into revision_documents (revision_id, path, content)
             values ($1, $2, $3)
             on conflict (revision_id, path) do update set content = excluded.content",
        )
        .bind(revision_id)
        .bind(row.get::<String, _>("path"))
        .bind(row.get::<String, _>("content"))
        .execute(db)
        .await?;
    }
    Ok(())
}

#[derive(Clone, Default)]
struct RevisionStateData {
    documents: HashMap<String, String>,
    directories: HashSet<String>,
    assets: HashMap<String, RevisionStoredAsset>,
}

#[derive(Clone)]
struct RevisionStoredAsset {
    object_key: String,
    content_type: String,
    size_bytes: i64,
    inline_data: Option<Vec<u8>>,
}

#[derive(Clone)]
struct RevisionStorageMeta {
    id: Uuid,
    parent_revision_id: Option<Uuid>,
    storage_kind: String,
}

struct CreatedRevisionRecord {
    id: Uuid,
    project_id: Uuid,
    actor_user_id: Option<Uuid>,
    summary: String,
    created_at: DateTime<Utc>,
}

async fn snapshot_revision_directories(
    db: &PgPool,
    project_id: Uuid,
    revision_id: Uuid,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query("select path from project_directories where project_id = $1")
        .bind(project_id)
        .fetch_all(db)
        .await?;
    for row in rows {
        sqlx::query(
            "insert into revision_directories (revision_id, path)
             values ($1, $2)
             on conflict (revision_id, path) do nothing",
        )
        .bind(revision_id)
        .bind(row.get::<String, _>("path"))
        .execute(db)
        .await?;
    }
    Ok(())
}

async fn snapshot_revision_assets(
    db: &PgPool,
    project_id: Uuid,
    revision_id: Uuid,
) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(
        "select path, object_key, content_type, size_bytes, inline_data
         from project_assets
         where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    for row in rows {
        sqlx::query(
            "insert into revision_assets
               (revision_id, path, object_key, content_type, size_bytes, inline_data)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (revision_id, path)
             do update set
               object_key = excluded.object_key,
               content_type = excluded.content_type,
               size_bytes = excluded.size_bytes,
               inline_data = excluded.inline_data",
        )
        .bind(revision_id)
        .bind(row.get::<String, _>("path"))
        .bind(row.get::<String, _>("object_key"))
        .bind(row.get::<String, _>("content_type"))
        .bind(row.get::<i64, _>("size_bytes"))
        .bind(row.get::<Option<Vec<u8>>, _>("inline_data"))
        .execute(db)
        .await?;
    }
    Ok(())
}

async fn snapshot_revision_state(
    db: &PgPool,
    project_id: Uuid,
    revision_id: Uuid,
) -> Result<(), sqlx::Error> {
    snapshot_revision_documents(db, project_id, revision_id).await?;
    snapshot_revision_directories(db, project_id, revision_id).await?;
    snapshot_revision_assets(db, project_id, revision_id).await?;
    Ok(())
}

async fn load_project_state(db: &PgPool, project_id: Uuid) -> Result<RevisionStateData, sqlx::Error> {
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
                size_bytes: row.get("size_bytes"),
                inline_data: row.get("inline_data"),
            },
        );
    }
    Ok(state)
}

async fn load_revision_full_snapshot(
    db: &PgPool,
    revision_id: Uuid,
) -> Result<RevisionStateData, sqlx::Error> {
    let doc_rows = sqlx::query(
        "select path, content
         from revision_documents
         where revision_id = $1",
    )
    .bind(revision_id)
    .fetch_all(db)
    .await?;
    let dir_rows = sqlx::query(
        "select path
         from revision_directories
         where revision_id = $1",
    )
    .bind(revision_id)
    .fetch_all(db)
    .await?;
    let asset_rows = sqlx::query(
        "select path, object_key, content_type, size_bytes, inline_data
         from revision_assets
         where revision_id = $1",
    )
    .bind(revision_id)
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
                size_bytes: row.get("size_bytes"),
                inline_data: row.get("inline_data"),
            },
        );
    }
    Ok(state)
}

async fn apply_revision_diff(
    db: &PgPool,
    revision_id: Uuid,
    state: &mut RevisionStateData,
) -> Result<(), sqlx::Error> {
    let doc_rows = sqlx::query(
        "select path, change_kind, content
         from revision_document_changes
         where revision_id = $1",
    )
    .bind(revision_id)
    .fetch_all(db)
    .await?;
    for row in doc_rows {
        let path: String = row.get("path");
        let kind: String = row.get("change_kind");
        if kind == "delete" {
            state.documents.remove(&path);
        } else if let Some(content) = row.get::<Option<String>, _>("content") {
            state.documents.insert(path, content);
        }
    }

    let dir_rows = sqlx::query(
        "select path, change_kind
         from revision_directory_changes
         where revision_id = $1",
    )
    .bind(revision_id)
    .fetch_all(db)
    .await?;
    for row in dir_rows {
        let path: String = row.get("path");
        let kind: String = row.get("change_kind");
        if kind == "delete" {
            state.directories.remove(&path);
        } else {
            state.directories.insert(path);
        }
    }

    let asset_rows = sqlx::query(
        "select path, change_kind, object_key, content_type, size_bytes, inline_data
         from revision_asset_changes
         where revision_id = $1",
    )
    .bind(revision_id)
    .fetch_all(db)
    .await?;
    for row in asset_rows {
        let path: String = row.get("path");
        let kind: String = row.get("change_kind");
        if kind == "delete" {
            state.assets.remove(&path);
            continue;
        }
        let object_key = row.get::<Option<String>, _>("object_key");
        let content_type = row.get::<Option<String>, _>("content_type");
        let size_bytes = row.get::<Option<i64>, _>("size_bytes");
        if let (Some(object_key), Some(content_type), Some(size_bytes)) =
            (object_key, content_type, size_bytes)
        {
            state.assets.insert(
                path,
                RevisionStoredAsset {
                    object_key,
                    content_type,
                    size_bytes,
                    inline_data: row.get("inline_data"),
                },
            );
        }
    }
    Ok(())
}

async fn load_revision_storage_meta(
    db: &PgPool,
    project_id: Uuid,
    revision_id: Uuid,
) -> Result<Option<RevisionStorageMeta>, sqlx::Error> {
    let row = sqlx::query(
        "select id, parent_revision_id, coalesce(storage_kind, 'full') as storage_kind
         from revisions
         where project_id = $1 and id = $2 and is_complete = true",
    )
    .bind(project_id)
    .bind(revision_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| RevisionStorageMeta {
        id: row.get("id"),
        parent_revision_id: row.get("parent_revision_id"),
        storage_kind: row.get("storage_kind"),
    }))
}

async fn load_materialized_revision_state(
    db: &PgPool,
    project_id: Uuid,
    revision_id: Uuid,
) -> Result<Option<RevisionStateData>, sqlx::Error> {
    let mut chain: Vec<RevisionStorageMeta> = Vec::new();
    let mut cursor = revision_id;
    let mut guard = 0usize;
    loop {
        guard += 1;
        if guard > 2048 {
            error!(
                "revision chain exceeded safety guard for project {} revision {}",
                project_id, revision_id
            );
            return Ok(None);
        }
        let Some(meta) = load_revision_storage_meta(db, project_id, cursor).await? else {
            return Ok(None);
        };
        let done = meta.storage_kind != "diff" || meta.parent_revision_id.is_none();
        cursor = meta.parent_revision_id.unwrap_or(meta.id);
        chain.push(meta);
        if done {
            break;
        }
    }

    chain.reverse();
    let mut state = RevisionStateData::default();
    for meta in chain {
        if meta.storage_kind == "diff" {
            apply_revision_diff(db, meta.id, &mut state).await?;
        } else {
            state = load_revision_full_snapshot(db, meta.id).await?;
        }
    }
    Ok(Some(state))
}

fn same_asset(a: &RevisionStoredAsset, b: &RevisionStoredAsset) -> bool {
    a.object_key == b.object_key
        && a.content_type == b.content_type
        && a.size_bytes == b.size_bytes
        && a.inline_data == b.inline_data
}

async fn snapshot_revision_diff(
    db: &PgPool,
    project_id: Uuid,
    parent_revision_id: Uuid,
    revision_id: Uuid,
) -> Result<(), sqlx::Error> {
    let current = load_project_state(db, project_id).await?;
    let baseline = load_materialized_revision_state(db, project_id, parent_revision_id)
        .await?
        .unwrap_or_default();

    for (path, content) in current.documents.iter() {
        let needs_upsert = baseline
            .documents
            .get(path)
            .map(|prev| prev != content)
            .unwrap_or(true);
        if needs_upsert {
            sqlx::query(
                "insert into revision_document_changes (revision_id, path, change_kind, content)
                 values ($1, $2, 'upsert', $3)
                 on conflict (revision_id, path)
                 do update set change_kind = excluded.change_kind, content = excluded.content",
            )
            .bind(revision_id)
            .bind(path)
            .bind(content)
            .execute(db)
            .await?;
        }
    }
    for path in baseline.documents.keys() {
        if current.documents.contains_key(path) {
            continue;
        }
        sqlx::query(
            "insert into revision_document_changes (revision_id, path, change_kind, content)
             values ($1, $2, 'delete', null)
             on conflict (revision_id, path)
             do update set change_kind = excluded.change_kind, content = null",
        )
        .bind(revision_id)
        .bind(path)
        .execute(db)
        .await?;
    }

    for path in current.directories.iter() {
        if baseline.directories.contains(path) {
            continue;
        }
        sqlx::query(
            "insert into revision_directory_changes (revision_id, path, change_kind)
             values ($1, $2, 'upsert')
             on conflict (revision_id, path)
             do update set change_kind = excluded.change_kind",
        )
        .bind(revision_id)
        .bind(path)
        .execute(db)
        .await?;
    }
    for path in baseline.directories.iter() {
        if current.directories.contains(path) {
            continue;
        }
        sqlx::query(
            "insert into revision_directory_changes (revision_id, path, change_kind)
             values ($1, $2, 'delete')
             on conflict (revision_id, path)
             do update set change_kind = excluded.change_kind",
        )
        .bind(revision_id)
        .bind(path)
        .execute(db)
        .await?;
    }

    for (path, asset) in current.assets.iter() {
        let needs_upsert = baseline
            .assets
            .get(path)
            .map(|prev| !same_asset(prev, asset))
            .unwrap_or(true);
        if needs_upsert {
            sqlx::query(
                "insert into revision_asset_changes
                   (revision_id, path, change_kind, object_key, content_type, size_bytes, inline_data)
                 values ($1, $2, 'upsert', $3, $4, $5, $6)
                 on conflict (revision_id, path)
                 do update set
                   change_kind = excluded.change_kind,
                   object_key = excluded.object_key,
                   content_type = excluded.content_type,
                   size_bytes = excluded.size_bytes,
                   inline_data = excluded.inline_data",
            )
            .bind(revision_id)
            .bind(path)
            .bind(&asset.object_key)
            .bind(&asset.content_type)
            .bind(asset.size_bytes)
            .bind(asset.inline_data.clone())
            .execute(db)
            .await?;
        }
    }
    for path in baseline.assets.keys() {
        if current.assets.contains_key(path) {
            continue;
        }
        sqlx::query(
            "insert into revision_asset_changes
               (revision_id, path, change_kind, object_key, content_type, size_bytes, inline_data)
             values ($1, $2, 'delete', null, null, null, null)
             on conflict (revision_id, path)
             do update set
               change_kind = excluded.change_kind,
               object_key = null,
               content_type = null,
               size_bytes = null,
               inline_data = null",
        )
        .bind(revision_id)
        .bind(path)
        .execute(db)
        .await?;
    }

    Ok(())
}

async fn latest_project_revision_id(db: &PgPool, project_id: Uuid) -> Result<Option<Uuid>, sqlx::Error> {
    let row = sqlx::query(
        "select id
         from revisions
         where project_id = $1 and is_complete = true
         order by created_at desc, id desc
         limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| r.get("id")))
}

fn revision_full_snapshot_interval() -> usize {
    env::var("REVISION_FULL_SNAPSHOT_INTERVAL")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(20)
}

async fn should_use_full_snapshot(
    db: &PgPool,
    project_id: Uuid,
    parent_revision_id: Option<Uuid>,
) -> Result<bool, sqlx::Error> {
    let Some(mut current) = parent_revision_id else {
        return Ok(true);
    };
    let interval = revision_full_snapshot_interval();
    if interval <= 1 {
        return Ok(true);
    }

    let mut diff_depth = 0usize;
    loop {
        let Some(meta) = load_revision_storage_meta(db, project_id, current).await? else {
            return Ok(true);
        };
        if meta.storage_kind != "diff" {
            break;
        }
        diff_depth += 1;
        if diff_depth >= interval.saturating_sub(1) {
            return Ok(true);
        }
        let Some(parent_id) = meta.parent_revision_id else {
            return Ok(true);
        };
        current = parent_id;
    }
    Ok(false)
}

async fn lookup_project_entry_file_path(db: &PgPool, project_id: Uuid) -> String {
    sqlx::query("select entry_file_path from project_settings where project_id = $1")
        .bind(project_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .map(|row| row.get::<String, _>("entry_file_path"))
        .unwrap_or_else(|| "main.typ".to_string())
}

async fn create_project_revision(
    db: &PgPool,
    project_id: Uuid,
    actor_user_id: Option<Uuid>,
    summary: &str,
    created_at: DateTime<Utc>,
) -> Result<CreatedRevisionRecord, sqlx::Error> {
    let revision_id = Uuid::new_v4();
    let parent_revision_id = latest_project_revision_id(db, project_id).await?;
    let entry_file_path = lookup_project_entry_file_path(db, project_id).await;
    let use_full = should_use_full_snapshot(db, project_id, parent_revision_id).await?;
    let storage_kind = if use_full { "full" } else { "diff" };

    let row = sqlx::query(
        "insert into revisions
           (id, project_id, actor_user_id, summary, created_at, entry_file_path, parent_revision_id, storage_kind, is_complete)
         values ($1, $2, $3, $4, $5, $6, $7, $8, false)
         returning id, project_id, actor_user_id, summary, created_at",
    )
    .bind(revision_id)
    .bind(project_id)
    .bind(actor_user_id)
    .bind(summary)
    .bind(created_at)
    .bind(entry_file_path)
    .bind(parent_revision_id)
    .bind(storage_kind)
    .fetch_one(db)
    .await?;

    let snapshot_result = if storage_kind == "full" {
        snapshot_revision_state(db, project_id, revision_id).await
    } else if let Some(parent_id) = parent_revision_id {
        snapshot_revision_diff(db, project_id, parent_id, revision_id).await
    } else {
        snapshot_revision_state(db, project_id, revision_id).await
    };
    if let Err(err) = snapshot_result {
        let _ = sqlx::query("delete from revisions where id = $1")
            .bind(revision_id)
            .execute(db)
            .await;
        return Err(err);
    }
    sqlx::query("update revisions set is_complete = true where id = $1")
        .bind(revision_id)
        .execute(db)
        .await?;

    Ok(CreatedRevisionRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        actor_user_id: row.get("actor_user_id"),
        summary: row.get("summary"),
        created_at: row.get("created_at"),
    })
}

async fn mark_project_dirty(db: &PgPool, project_id: Uuid, actor_user_id: Option<Uuid>) {
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

async fn flush_pending_server_commit(
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
            ("Typst Server".to_string(), "noreply@typst-server.local".to_string())
        }
    } else {
        ("Typst Server".to_string(), "noreply@typst-server.local".to_string())
    };
    let message = if trailers.is_empty() {
        "Online updates".to_string()
    } else {
        format!("Online updates\n\n{}", trailers.join("\n"))
    };
    let _ = git_commit_staged_if_changed(
        &local_path,
        &message,
        &commit_author.0,
        &commit_author.1,
    )?;
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
    clear_project_sync_queue_item(&state.db, project_id).await;
    Ok(())
}

fn git_flush_worker_interval_seconds() -> u64 {
    env::var("GIT_FLUSH_WORKER_INTERVAL_SECONDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(3)
}

fn git_autosave_interval_seconds() -> i64 {
    env::var("GIT_AUTOSAVE_INTERVAL_SECONDS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 60)
        .unwrap_or(600)
}

fn git_flush_worker_batch_size() -> i64 {
    env::var("GIT_FLUSH_WORKER_BATCH_SIZE")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 1)
        .unwrap_or(64)
}

async fn list_pending_sync_projects(db: &PgPool, limit: i64) -> Result<Vec<Uuid>, sqlx::Error> {
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

async fn mark_project_sync_attempt(db: &PgPool, project_id: Uuid) {
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

async fn clear_project_sync_queue_item(db: &PgPool, project_id: Uuid) {
    let _ = sqlx::query("delete from project_sync_queue where project_id = $1")
        .bind(project_id)
        .execute(db)
        .await;
}

async fn fail_project_sync_queue_item(db: &PgPool, project_id: Uuid, error_message: &str) {
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

fn spawn_git_flush_worker(state: AppState) {
    let interval = Duration::from_secs(git_flush_worker_interval_seconds());
    let batch_size = git_flush_worker_batch_size();
    tokio::spawn(async move {
        loop {
            match list_pending_sync_projects(&state.db, batch_size).await {
                Ok(projects) => {
                    for project_id in projects {
                        mark_project_sync_attempt(&state.db, project_id).await;
                        let _git_lock = acquire_git_project_lock(&state, project_id).await;
                        if let Err(err) = flush_pending_server_commit(&state, project_id, None).await
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
    let _ =
        sqlx::query("update personal_access_tokens set last_used_at = $2 where token_hash = $1")
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
    bytes
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>()
}
